/**
 * The Main agent's heartbeat in Chips (Chips ADR 0143): the copy read from OpenClaw's config, the
 * patch a change is, and the check-in a check that told the person something posts, from OpenClaw's
 * `heartbeat` event and Home. A stand-in gateway keeps a config and a hash, as OpenClaw does.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { Settings } from "@chipschat/harness";
import type { ClawPort } from "../src/bridge.ts";
import { Bridge, type ChipsPort } from "../src/bridge.ts";
import type { ChipsAgent, ChipsEvent } from "../src/chips.ts";
import { settingsFor } from "./settings-rig.ts";
import {
  beatOf,
  CHOICES,
  type ClawAgents,
  checkInOf,
  checkInText,
  checkOf,
  choicesWith,
  copyOf,
  Heartbeats,
  minutesOf,
  patchOf,
  wordsIn,
} from "../src/heartbeats.ts";

describe("OpenClaw's heartbeat, as Chips is told it", () => {
  it("reads OpenClaw's durations in minutes", () => {
    assert.equal(minutesOf("30m"), 30);
    assert.equal(minutesOf("1h30m"), 90);
    assert.equal(minutesOf("2d"), 2880);
    assert.equal(minutesOf("90s"), 1.5);
    assert.equal(minutesOf("45"), 45);
    assert.equal(minutesOf(15), 15);
    assert.equal(minutesOf("0m"), 0);
    assert.equal(minutesOf("soon"), undefined);
    assert.equal(minutesOf(undefined), undefined);
  });

  it("is on only when the agent beats, at more than zero, keeping what it says for Chips", () => {
    // This install as it was: main named by the defaults, no interval, delivered nowhere ("no-route").
    assert.deepEqual(beatOf({ defaults: { heartbeat: { agentId: "main" } } }, "main"), { on: false, every: 30 });
    assert.deepEqual(beatOf({ entries: { main: { heartbeat: { every: "1h", target: "none" } } } }, "main"), { on: true, every: 60 });
    assert.deepEqual(beatOf({ entries: { main: { heartbeat: { every: "0m", target: "none" } } } }, "main"), { on: false, every: undefined });
    // Once any agent has a block of its own, only those beat.
    const another: ClawAgents = { defaults: { heartbeat: { agentId: "main", target: "none" } }, entries: { ops: { heartbeat: { every: "1h" } } } };
    assert.equal(beatOf(another, "main").on, false);
    // A defaults block naming nobody enrols every agent.
    assert.equal(beatOf({ defaults: { heartbeat: { every: "2h", target: "none" } } }, "main").on, true);
    assert.equal(beatOf({ defaults: { heartbeat: { agentId: "ops", target: "none" } } }, "main").on, false);
  });

  it("offers Chips's intervals, with the one it beats at among them, ascending", () => {
    assert.deepEqual(choicesWith(30), [...CHOICES]);
    assert.deepEqual(choicesWith(45), [15, 30, 45, 60, 120, 240, 720, 1440]);
    assert.deepEqual(copyOf({ entries: { main: { heartbeat: { every: "1h", target: "none" } } } }, "main"), {
      on: true,
      every: 60,
      choices: [...CHOICES],
      editable: true,
    });
    // Off at zero, it says the interval it beat at before, else OpenClaw's own.
    const off: ClawAgents = { entries: { main: { heartbeat: { every: "0m", target: "none" } } } };
    assert.equal(copyOf(off, "main", 120)["every"], 120);
    assert.equal(copyOf(off, "main")["every"], 30);
  });

  it("writes a change as the agent's own block, kept for Chips, and off as zero", () => {
    assert.deepEqual(JSON.parse(patchOf("main", { on: true, every: 60 })), {
      agents: { entries: { main: { heartbeat: { every: "60m", target: "none" } } } },
    });
    assert.deepEqual(JSON.parse(patchOf("main", { on: false, every: 60 })), {
      agents: { entries: { main: { heartbeat: { every: "0m", target: "none" } } } },
    });
  });

  it("takes a check-in from a heartbeat call that notifies, and nothing from a quiet one", () => {
    const call = (args: Record<string, unknown>) => ({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "heartbeat_respond", arguments: args }],
    });
    assert.deepEqual(checkInOf(call({ notify: true, outcome: "alert", notificationText: "  The build finished. ", summary: "x" })), {
      id: "call_1",
      text: "The build finished.",
    });
    assert.deepEqual(checkInOf(call({ notify: true, outcome: "alert", summary: "Rain at 3 PM." })), { id: "call_1", text: "Rain at 3 PM." });
    assert.equal(checkInOf(call({ notify: false, outcome: "no_change", summary: "Nothing new." })), undefined);
    assert.equal(checkInOf({ role: "toolResult", content: [] }), undefined);
    assert.equal(checkInOf({ role: "assistant", content: [{ type: "text", text: "Hello." }] }), undefined);
    assert.equal(checkInOf(undefined), undefined);
  });

  it("reads a check from OpenClaw's heartbeat event: quiet, told and delivered, or told with no channel", () => {
    assert.deepEqual(checkOf({ ts: 5, status: "ok-empty", reason: "interval", silent: true }), { at: 5, notify: false });
    assert.deepEqual(checkOf({ ts: 5, status: "ok-token", preview: "Nothing new." }), { at: 5, notify: false });
    assert.deepEqual(checkOf({ ts: 5, status: "sent", preview: "Rain at 3.", channel: "telegram" }), { at: 5, notify: true });
    assert.deepEqual(checkOf({ ts: 5, status: "skipped", reason: "target-none", preview: "Rain at 3." }), { at: 5, notify: true, words: "Rain at 3." });
    // Didn't run, failed, or said already: no check to speak of.
    assert.equal(checkOf({ ts: 5, status: "skipped", reason: "cron-in-progress" }), undefined);
    assert.equal(checkOf({ ts: 5, status: "skipped", reason: "duplicate", preview: "Rain at 3." }), undefined);
    assert.equal(checkOf({ ts: 5, status: "skipped", reason: "target-none" }), undefined);
    assert.equal(checkOf({ ts: 5, status: "failed", reason: "agent-runner-failure", preview: "x" }), undefined);
    assert.equal(checkOf({ status: "ok-empty" }), undefined);
  });

  it("finds a check's words whole in Home by how the event's cut of them begins", () => {
    const whole = `The deploy finished. ${"Every service answered its health check. ".repeat(8)}`;
    const home = [
      { role: "user", content: [{ type: "text", text: "Read HEARTBEAT.md if it exists." }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "Look at the deploy." }, { type: "text", text: whole }] },
      { role: "assistant", content: "Older words, not these." },
    ];
    assert.equal(wordsIn(home, whole.slice(0, 200)), whole);
    // By a tool call that notifies, on a runtime that makes one.
    const called = [{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "heartbeat_respond", arguments: { notify: true, notificationText: whole } }] }];
    assert.equal(wordsIn(called, whole.slice(0, 200)), whole.trim());
    assert.equal(wordsIn(home, "Something else entirely."), undefined);
    assert.equal(wordsIn(undefined, "x"), undefined);
    assert.equal(checkInText("HEARTBEAT_OK\nThe deploy finished. "), "The deploy finished.");
  });
});

describe("a person's change of the heartbeat", () => {
  let config: { agents: ClawAgents };
  let hash: number;
  let calls: [string, Record<string, unknown>][];
  let refusePatch: string | undefined;
  let puts: [string, Record<string, unknown>][];
  const claw: ClawPort = {
    request: async <T>(method: string, params: Record<string, unknown>) => {
      calls.push([method, params]);
      if (method === "config.get") return { config, hash: `h${hash}` } as T;
      if (method === "config.patch") {
        if (refusePatch !== undefined) throw new Error(refusePatch);
        assert.equal(params["baseHash"], `h${hash}`);
        const patch = JSON.parse(String(params["raw"])) as { agents: { entries: Record<string, { heartbeat: object }> } };
        const entries = { ...(config.agents.entries ?? {}) } as Record<string, { heartbeat?: object }>;
        for (const [id, entry] of Object.entries(patch.agents.entries)) entries[id] = { ...entries[id], heartbeat: { ...entries[id]?.heartbeat, ...entry.heartbeat } };
        config = { agents: { ...config.agents, entries } };
        hash += 1;
        return {} as T;
      }
      return {} as T;
    },
  };
  let beats: Heartbeats;
  let settings: Settings;
  /** A person's change from Chips, made by the module and answered by the SDK. */
  const change = async (frame: { change_id: string; agent_id: string; on: boolean; every: number }): Promise<void> => {
    await settings.hear({ frame: "heartbeat.change", ...frame });
  };

  beforeEach(() => {
    config = { agents: { defaults: { heartbeat: { agentId: "main" } } } };
    hash = 1;
    calls = [];
    refusePatch = undefined;
    puts = [];
    settings = settingsFor((agentId, body) => void puts.push([agentId, body]), {
      heartbeats: async (frame) => (await beats.change(frame, "main")) as never,
    });
    beats = new Heartbeats(claw, (agentId, copy) => settings.heartbeat(agentId, copy as never), () => undefined, async () => undefined);
  });

  it("turns it on every hour, and answers with the copy as it is now", async () => {
    await change({ change_id: "chg_01K4ZQPX0000000000000000C1", agent_id: "agt_01K4ZQPX0000000000000000MN", on: true, every: 60 });
    assert.deepEqual(config.agents.entries?.["main"]?.heartbeat, { every: "60m", target: "none" });
    assert.deepEqual(puts, [["agt_01K4ZQPX0000000000000000MN", { on: true, every: 60, choices: [...CHOICES], editable: true, answers: "chg_01K4ZQPX0000000000000000C1" }]]);
  });

  it("turns it off and remembers the interval it beat at for the copy", async () => {
    await change({ change_id: "chg_01K4ZQPX0000000000000000C1", agent_id: "agt_01K4ZQPX0000000000000000MN", on: true, every: 120 });
    await change({ change_id: "chg_01K4ZQPX0000000000000000C2", agent_id: "agt_01K4ZQPX0000000000000000MN", on: false, every: 120 });
    assert.deepEqual(config.agents.entries?.["main"]?.heartbeat, { every: "0m", target: "none" });
    assert.deepEqual(puts.at(-1), ["agt_01K4ZQPX0000000000000000MN", { on: false, every: 120, choices: [...CHOICES], editable: true, answers: "chg_01K4ZQPX0000000000000000C2" }]);
  });

  it("refuses with OpenClaw's words when it won't write, and says what holds", async () => {
    refusePatch = "rate limited";
    await change({ change_id: "chg_01K4ZQPX0000000000000000C1", agent_id: "agt_01K4ZQPX0000000000000000MN", on: true, every: 60 });
    assert.deepEqual(puts, [
      ["agt_01K4ZQPX0000000000000000MN", { on: false, every: 30, choices: [...CHOICES], editable: true, refuses: { change_id: "chg_01K4ZQPX0000000000000000C1", message: "rate limited" } }],
    ]);
  });

  it("sends a copy only when it moved, unless it answers a change", async () => {
    await beats.agent("agt_01K4ZQPX0000000000000000MN", "main");
    await beats.agent("agt_01K4ZQPX0000000000000000MN", "main");
    assert.equal(puts.length, 1);
  });
});

describe("the Main agent's heartbeat through the bridge", () => {
  const ME = "hrn_01K4ZQPX000000000000000004";
  const MAIN_ROOM = "spc_01K4ZQPX0000000000000000M1";
  const MAIN = "agt_01K4ZQPX00000000000000000M";
  let sent: ChipsEvent[];
  let puts: [string, Record<string, unknown>][];
  let calls: [string, Record<string, unknown>][];
  let agents: ChipsAgent[];
  let bridge: Bridge;
  let settings: Settings;

  const chips: ChipsPort = {
    send: async (event) => void sent.push(event),
    claim: async () => undefined,
    fetchAttachment: async () => Buffer.from(""),
    upload: async () => "att_01K4ZQPX000000000000000001",
    agents: async () => agents,
    registerAgent: async () => agents[0] as ChipsAgent,
    openSpace: async () => MAIN_ROOM,
    attach: async () => true,
    roomContext: async () => ({ lines: [] }),
    forget: (agentId) => settings.forget(agentId),
  };
  const claw: ClawPort = {
    request: async <T>(method: string, params: Record<string, unknown>) => {
      calls.push([method, params]);
      if (method === "config.get") return { config: { agents: { entries: { main: { heartbeat: { every: "1h", target: "none" } } } } }, hash: "h1" } as T;
      if (method === "chat.history") return { messages: home } as T;
      return {} as T;
    },
  };
  let home: unknown[];

  beforeEach(async () => {
    sent = [];
    home = [];
    puts = [];
    calls = [];
    agents = [
      { agent_id: MAIN, key: "agent:main:chips-main", name: "OpenClaw", lead: true, state: "active", spaces: [MAIN_ROOM], room: MAIN_ROOM },
      { agent_id: "agt_01K4ZQPX0000000000000000SC", key: "scout", name: "Scout", lead: false, state: "active", spaces: [], room: null },
    ];
    settings = settingsFor((agentId, body) => void puts.push([agentId, body]), {
      heartbeats: async (frame) => (await bridge.onHeartbeatChange({ ...frame })) as never,
    });
    const beats = new Heartbeats(claw, (agentId, copy) => settings.heartbeat(agentId, copy as never), () => undefined, async () => undefined);
    bridge = new Bridge(chips, claw, { harnessId: ME, agent: "main" }, () => undefined, undefined, Date.now, undefined, undefined, undefined, beats);
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }, { id: "scout" }] });
    sent = [];
  });

  // OpenClaw's word as a check ends; with no channel to take its words, it says so and keeps 200.
  const told = (ts: number, words: string) => ({
    event: "heartbeat",
    payload: { ts, status: "skipped", reason: "target-none", preview: words.slice(0, 200), durationMs: 9000 },
  });

  it("sends the Main agent's copy at start, and no other agent's", async () => {
    await bridge.sendHeartbeats();
    assert.deepEqual(puts, [[MAIN, { on: true, every: 60, choices: [...CHOICES], editable: true }]]);
  });

  it("posts a check-in in the Main room as the Main agent, marked, and once", async () => {
    bridge.onClaw(told(1_793_469_298_566, "The build finished."));
    bridge.onClaw(told(1_793_469_298_566, "The build finished."));
    await bridge.settled();
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0], {
      type: "message.post",
      space_id: MAIN_ROOM,
      text: "The build finished.",
      heartbeat: true,
      actor: { kind: "agent", id: MAIN },
      idempotency_key: "openclaw-heartbeat:1793469298566",
    });
    // Heard twice, the same key: Chips takes it once.
    assert.equal(sent[1]?.["idempotency_key"], sent[0]?.["idempotency_key"]);
  });

  it("@s the Main room's person in a check-in that @s nobody, as Chips's note names them (Chips ADR 0158)", async () => {
    const arjun = { participant_id: "usr_01K4ZQPX000000000000000003", kind: "person", display_name: "Arjun", role: "owner" };
    await bridge.onChips({
      type: "message.new",
      space_id: MAIN_ROOM,
      message_id: "msg_01K4ZQPX0000000000000000A1",
      from: arjun,
      text: "Keep an eye on the build.",
      addressed_to: [MAIN],
      for: [MAIN],
      room: {
        members: [
          { participant_id: arjun.participant_id, kind: "person", name: "Arjun", handle: "@Arjun" },
          { participant_id: MAIN, kind: "agent", name: "OpenClaw", handle: "@OpenClaw" },
        ],
        notes: {},
      },
    });
    sent = [];
    bridge.onClaw(told(1, "The build finished."));
    bridge.onClaw(told(2, "@arjun the build failed."));
    await bridge.settled();
    // Telling the person is an @, which pushes their phone; still a check-in. One @ is enough.
    assert.deepEqual(
      sent.map((event) => [event["text"], event["heartbeat"]]),
      [
        ["@Arjun The build finished.", true],
        ["@arjun the build failed.", true],
      ],
    );
  });

  it("posts a check's words whole from Home when the event cut them, and as cut when Home hasn't them", async () => {
    const whole = `The nightly backup failed: ${"the disk on the NAS is full again. ".repeat(10)}Want me to clear the old snapshots?`;
    home = [
      { role: "user", content: [{ type: "text", text: "Read HEARTBEAT.md if it exists." }] },
      { role: "assistant", content: [{ type: "text", text: whole }] },
    ];
    bridge.onClaw(told(1, whole));
    await bridge.settled();
    assert.deepEqual(calls.filter(([method]) => method === "chat.history"), [["chat.history", { sessionKey: "agent:main:main", limit: 20 }]]);
    home = [];
    bridge.onClaw(told(2, whole));
    await bridge.settled();
    assert.deepEqual(
      sent.map((event) => event["text"]),
      [whole, whole.slice(0, 200)],
    );
  });

  it("posts nothing for a quiet check, one that failed or was said already, or one a channel took", async () => {
    const check = (payload: Record<string, unknown>) => bridge.onClaw({ event: "heartbeat", payload: { ts: 1, ...payload } });
    check({ status: "ok-empty", reason: "interval", silent: true });
    check({ status: "ok-token", preview: "Nothing new." });
    check({ status: "failed", reason: "agent-runner-failure", preview: "The model is unavailable." });
    check({ status: "skipped", reason: "duplicate", preview: "The build finished." });
    check({ status: "sent", preview: "The build finished.", channel: "telegram" });
    // A heartbeat's turn in Home is the event's to tell, not a message's.
    bridge.onClaw({
      event: "session.message",
      payload: {
        sessionKey: "agent:main:main",
        message: { role: "assistant", content: [{ type: "toolCall", id: "c9", name: "heartbeat_respond", arguments: { notify: true, summary: "x" } }] },
      },
    });
    await bridge.settled();
    assert.deepEqual(sent, []);
  });

  it("changes the Main agent's heartbeat from Chips, and leaves another's unanswered", async () => {
    await settings.hear({ frame: "heartbeat.change", change_id: "chg_01K4ZQPX0000000000000000C1", agent_id: MAIN, on: true, every: 15 });
    await settings.hear({ frame: "heartbeat.change", change_id: "chg_01K4ZQPX0000000000000000C2", agent_id: "agt_01K4ZQPX0000000000000000SC", on: true, every: 15 });
    await bridge.settled();
    const patches = calls.filter(([method]) => method === "config.patch").map(([, params]) => JSON.parse(String(params["raw"])));
    assert.deepEqual(patches, [{ agents: { entries: { main: { heartbeat: { every: "15m", target: "none" } } } } }]);
    assert.deepEqual(puts.map(([agentId, body]) => [agentId, body["answers"]]), [[MAIN, "chg_01K4ZQPX0000000000000000C1"]]);
  });
});
