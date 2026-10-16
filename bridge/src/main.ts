/**
 * The bridge's process: OpenClaw's gateway on one side, Chips on the other, the mapping between.
 * Run by hand (`npm start`, or `npm run connect -- <link>` the first time), stopped by the PID it
 * leaves in ~/chips-openclaw/bridge/bridge.pid.
 */

import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentContextCopy, AgentContextWindowCopy, AgentHeartbeatCopy, AgentModelCopy } from "@chipschat/harness";
import { Automations } from "./automations.ts";
import { Bridge } from "./bridge.ts";
import { Chips, type ChipsEvent } from "./chips.ts";
import { loadConfig, SetupError } from "./config.ts";
import { Contexts } from "./context.ts";
import { Heartbeats } from "./heartbeats.ts";
import { Windows } from "./windows.ts";
import { Models } from "./models.ts";
import { health } from "./health.ts";
import { readMedia, rootsFor } from "./media.ts";
import { workspacesIn } from "./own-agents.ts";
import { OpenClaw } from "./openclaw.ts";
import { type Restarter, restarter } from "./restart.ts";

const log = (message: string): void => console.log(`${new Date().toISOString()} ${message}`);

// `connect <link>`: a link a person made in Chips, taken up before anything else starts.
// What OpenClaw's side needs is checked first, and stops it with what to do: a link works once.
const config = await loadConfig({ link: process.argv[2] === "connect" ? process.argv[3] : undefined, log }).catch(
  (error: unknown) => {
    if (!(error instanceof SetupError)) throw error;
    console.error(error.message);
    process.exit(1);
  },
);
const pidFile = join(config.stateDir, "bridge.pid");
writeFileSync(pidFile, String(process.pid));

let restart: Restarter | undefined;
let bridge: Bridge | undefined;
/** The bridge, for a person's change from Chips: one that comes before it is made is refused. */
const active = (): Bridge => {
  if (bridge === undefined) throw new Error("The bridge is still starting.");
  return bridge;
};
// What a person changes from an agent's page is made in OpenClaw and answered with the copy as it
// is now; the SDK sends the answer, or the refusal when one of these throws.
const chips = new Chips({
  url: config.chipsUrl,
  harnessId: config.harnessId,
  token: config.harnessToken,
  stateDir: config.stateDir,
  log,
  onRestart: (ask) => void restart?.restart(ask),
  settings: {
    context: async (edit) => (await active().onContextEdit({ ...edit })) as unknown as AgentContextCopy,
    models: async (change) => (await active().onModelChange({ ...change })) as unknown as AgentModelCopy,
    heartbeats: async (change) => (await active().onHeartbeatChange({ ...change })) as unknown as AgentHeartbeatCopy,
    contextWindows: {
      compact: async (ask) => (await active().onWindowCompact({ ...ask })) as unknown as AgentContextWindowCopy,
      change: async (ask) => (await active().onWindowChange({ ...ask })) as unknown as AgentContextWindowCopy,
    },
  },
});

/** Whoever waits for the gateway's next hello: a restart, to say it is up. */
const upWaiters: (() => void)[] = [];

/** How OpenClaw is, as Chips is told it (Chips ADR 0083): fine at the first hello, then as it goes. */
const openClaw = health(
  (trouble) => {
    void chips.status(trouble).catch((error) => log(`chips: could not say how OpenClaw is: ${String(error)}`));
  },
  log,
);
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
  onUp: () => {
    openClaw.up();
    for (const wake of upWaiters.splice(0)) wake();
  },
  onDown: openClaw.down,
});
/** The script Restart runs, beside this repo's others; at most six minutes, Colima's start included. */
const RESTART_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../../scripts/restart.sh");
const RESTART_LIMIT_MS = 6 * 60_000;

/** Run scripts/restart.sh, its output into the bridge's log, keeping the last of it for a failure. */
function runRestartScript(): Promise<{ code: number | null; tail: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", [RESTART_SCRIPT], { stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const keep = (data: Buffer): void => {
      const text = String(data);
      for (const each of text.split("\n")) if (each.trim() !== "") log(`restart.sh: ${each}`);
      tail = (tail + text).slice(-2000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const limit = setTimeout(() => {
      log("bridge: restart.sh ran past six minutes; stopping it");
      child.kill("SIGTERM");
    }, RESTART_LIMIT_MS);
    child.on("error", (error) => {
      clearTimeout(limit);
      resolve({ code: 1, tail: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(limit);
      resolve({ code, tail });
    });
  });
}

restart = restarter({
  run: runRestartScript,
  up: (withinMs) =>
    claw.up
      ? Promise.resolve(true)
      : new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), withinMs);
          upWaiters.push(() => {
            clearTimeout(timer);
            resolve(true);
          });
        }),
  say: (trouble) => chips.status(trouble),
  hold: openClaw.hold,
  log,
});

const roots = rootsFor(config.sandbox);
bridge = new Bridge(
  chips,
  claw,
  { harnessId: config.harnessId, agent: config.agent ?? "main" },
  log,
  { read: (reference, workspace) => readMedia(reference, roots, workspace) },
  Date.now,
  workspacesIn(roots),
  new Contexts(claw, (owner, body) => chips.putContext(owner, body), log),
  new Models(claw, (agentId, body) => chips.putModel(agentId, body), log),
  new Heartbeats(claw, (agentId, body) => chips.putHeartbeat(agentId, body), log),
  new Windows(
    claw,
    {
      put: (agentId, copy) => chips.putWindow(agentId, copy),
      failed: (agentId, changeId, message, copy) => chips.compactFailed(agentId, changeId, message, copy),
    },
    log,
    join(config.stateDir, "context-windows.json"),
  ),
  // Who each automation our agents schedule is for, kept across restarts (Chips ADR 0157).
  new Automations(join(config.stateDir, "automations.json"), log),
);

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
  await chips.open();
  await claw.start();
  await claw.request("sessions.subscribe", {});
  await adopt(active);
  // What each agent the bridge made is built from, as Chips shows it (Chips ADR 0134).
  await active.sendContexts();
  // What each of them runs on, and how hard it thinks (Chips ADR 0140).
  await active.sendModels();
  // Whether the Main agent checks in on its own, and how often (Chips ADR 0143).
  await active.sendHeartbeats();
  // How full each of them is, and the limit it compacts itself at (Chips ADR 0146).
  await active.sendWindows();
  await catchUp(active);
  chips.stream((event) => active.onChips(event));
  // Its first words in the room it joined, once: the card that followed its link waits for them.
  await config
    .hello?.((spaceId) =>
      chips.send({
        type: "message.post",
        space_id: spaceId,
        text: "Hi, OpenClaw here, connected to Chips. Ask me anything.",
        idempotency_key: `openclaw-hello:${spaceId}`,
      }),
    )
    .catch((error: unknown) => log(`chips: hello not said: ${String(error)}`));
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
