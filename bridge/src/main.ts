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

/**
 * OpenClaw down for this long is trouble Chips shows people (Chips ADR 0083): its face marked,
 * and why, under a message it has not picked up. A blip shorter than this is not.
 */
const DOWN_FOR_MS = 10_000;
let down: ReturnType<typeof setTimeout> | undefined;
let troubled = false;
const say = (trouble: string | undefined): void => {
  void chips.status(trouble).catch((error) => log(`chips: could not say how OpenClaw is: ${String(error)}`));
};
const clawUp = (): void => {
  if (down !== undefined) clearTimeout(down);
  down = undefined;
  if (!troubled) return;
  troubled = false;
  log("bridge: OpenClaw is back; telling Chips");
  say(undefined);
};
const clawDown = (): void => {
  if (down !== undefined || troubled) return;
  down = setTimeout(() => {
    down = undefined;
    troubled = true;
    log("bridge: OpenClaw's gateway has been unreachable for 10 s; telling Chips");
    say("Can't reach its gateway");
  }, DOWN_FOR_MS);
  down.unref();
};
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
  onUp: clawUp,
  onDown: clawDown,
});
bridge = new Bridge(chips, claw, { harnessId: config.harnessId, agent: config.agent ?? "main" }, log);

/**
 * Rooms asked of this harness while the bridge was away: their first words are already in the log,
 * as `message.post`, so they are read back and handed over as the words would have arrived live —
 * as `message.new` when they were for this harness, or say nothing of who they were for (from a
 * Chips before ADR 0081), and as `message.overheard`, no turn, when they were not.
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
      const addressed = event["addressed_to"];
      const forMe = !Array.isArray(addressed) || (addressed as unknown[]).some((id) => active.isOwn(String(id)));
      // What was for somebody else is the room's context; the room waits for words that are ours.
      if (forMe) waiting.delete(spaceId);
      // DOCS: the log holds `message.post`; a harness hears `message.new`. The message id is the
      // event's ULID with `msg_` (connect/websocket), and `from` is rebuilt from the actor.
      const heard: ChipsEvent = {
        ...event,
        type: forMe ? "message.new" : "message.overheard",
        message_id: `msg_${String(event["id"]).replace(/^evt_/, "")}`,
        from: { participant_id: actor.id, kind: "person" },
      };
      await active.onChips(heard);
    }
    if (page.events.length === 0 || page.next_cursor <= since) break;
    since = page.next_cursor;
  }
}

/**
 * OpenClaw's agents as this harness's agents in Chips (ADR 0087), from the gateway's own list. A
 * gateway that will not list them leaves the one agent the bridge served before.
 */
async function adopt(active: Bridge): Promise<void> {
  let listed: { defaultId?: string; agents?: { id: string }[] } = {};
  try {
    listed = await claw.request("agents.list", {});
  } catch (error) {
    log(`openclaw: would not list its agents, so only "${config.agent ?? "main"}" is served: ${String(error)}`);
  }
  try {
    await active.adoptAgents(listed, config.agent);
  } catch (error) {
    log(`chips: could not take OpenClaw's agents as its own: ${String(error)}`);
  }
}

async function main(): Promise<void> {
  if (bridge === undefined) return;
  const active = bridge;
  log(
    `bridge: harness ${config.harnessId} is ${config.agent === undefined ? "every OpenClaw agent" : `OpenClaw agent "${config.agent}"`}`,
  );
  await claw.start();
  await claw.request("sessions.subscribe", {});
  await adopt(active);
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
