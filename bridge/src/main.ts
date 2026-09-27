/**
 * The bridge's process: OpenClaw's gateway on one side, Chips on the other, the mapping between.
 * Run by hand (`npm start`), stopped by the PID it leaves in ~/chips-openclaw/bridge/bridge.pid.
 */

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bridge } from "./bridge.ts";
import { Chips, type ChipsEvent } from "./chips.ts";
import { loadConfig } from "./config.ts";
import { OpenClaw } from "./openclaw.ts";

const log = (message: string): void => console.log(`${new Date().toISOString()} ${message}`);

const config = loadConfig();
const pidFile = join(config.stateDir, "bridge.pid");
writeFileSync(pidFile, String(process.pid));

const chips = new Chips({
  url: config.chipsUrl,
  harnessId: config.harnessId,
  token: config.harnessToken,
  stateDir: config.stateDir,
  log,
});
let bridge: Bridge | undefined;
/** BRIDGE_TRACE=1: each OpenClaw event's name and the start of its payload, to check the mapping. */
const trace = process.env["BRIDGE_TRACE"] === "1";
const claw = new OpenClaw({
  url: config.gatewayUrl,
  token: config.gatewayToken,
  stateDir: config.stateDir,
  log,
  onEvent: (event) => {
    if (trace && event.event !== "tick" && event.event !== "health") {
      log(`trace ${event.event} ${JSON.stringify(event.payload).slice(0, 600)}`);
    }
    bridge?.onClaw(event);
  },
});
bridge = new Bridge(chips, claw, { harnessId: config.harnessId, agent: config.agent }, log);

/**
 * Rooms asked of this harness while the bridge was away: their first words are already in the log,
 * as `message.post`, so they are read back and handed over as the words would have arrived live.
 */
async function catchUp(active: Bridge): Promise<void> {
  const { asked } = await chips.ownSpaces();
  if (asked.length === 0) return;
  const waiting = new Set(asked.map((room) => room.space_id));
  for (const id of waiting) active.noteAsked(id);
  for (let since = 0; waiting.size > 0; ) {
    const page = await chips.history(since);
    for (const event of page.events) {
      const spaceId = String(event["space_id"]);
      const actor = event["actor"] as { kind?: string; id?: string } | undefined;
      if (event.type !== "message.post" || !waiting.has(spaceId) || actor?.kind !== "person") continue;
      waiting.delete(spaceId);
      // DOCS: the log holds `message.post`; a harness hears `message.new`. The message id is the
      // event's ULID with `msg_` (connect/websocket), and `from` is rebuilt from the actor.
      const heard: ChipsEvent = {
        ...event,
        type: "message.new",
        message_id: `msg_${String(event["id"]).replace(/^evt_/, "")}`,
        from: { participant_id: actor.id, kind: "person" },
      };
      await active.onChips(heard);
    }
    if (page.events.length === 0 || page.next_cursor <= since) break;
    since = page.next_cursor;
  }
}

async function main(): Promise<void> {
  if (bridge === undefined) return;
  const active = bridge;
  log(`bridge: harness ${config.harnessId} is OpenClaw agent "${config.agent}"`);
  await claw.start();
  await claw.request("sessions.subscribe", {});
  await catchUp(active);
  chips.stream((event) => active.onChips(event));
}

function stop(): void {
  log("bridge: stopping");
  chips.close();
  claw.stop();
  rmSync(pidFile, { force: true });
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

main().catch((error: unknown) => {
  log(`bridge: failed to start: ${error instanceof Error ? error.message : String(error)}`);
  rmSync(pidFile, { force: true });
  process.exit(1);
});
