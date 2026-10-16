/**
 * Our agents' context windows in Chips (Chips ADR 0146): the copy read from OpenClaw's session, a
 * person's Compact now done with `sessions.compact` (now, or when the bridge's turn ends), the limit
 * the bridge keeps and compacts at after a turn, and what a restart remembers. A stand-in gateway
 * keeps sessions' tokens, as OpenClaw does.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import type { Settings } from "@chipschat/harness";
import { Bridge, type ChipsPort, type ClawPort } from "../src/bridge.ts";
import type { ChipsAgent, ChipsEvent } from "../src/chips.ts";
import { fillOf, LIMITS, overLimit, type Session, Windows, type WindowsPort } from "../src/windows.ts";
import { settingsFor } from "./settings-rig.ts";

/** The SDK's settings as the windows send copies through them. */
const portOf = (settings: Settings): WindowsPort => ({
  put: (agentId, copy) => settings.contextWindow(agentId, copy as never),
  failed: (agentId, changeId, message, copy) => settings.contextWindowFailed(agentId, changeId, message, copy as never),
});

const NOW = Date.parse("2026-10-09T18:30:00.000Z");
const HOME: Session = { key: "agent:main:main", clawAgent: "main" };

describe("a session's fill, as Chips is told it", () => {
  it("reads OpenClaw's tokens and window, and nothing when either is missing", () => {
    assert.deepEqual(fillOf({ totalTokens: 23197, contextTokens: 272000, model: "gpt-6-astra", updatedAt: NOW }, 0), {
      used: 23197,
      window: 272000,
      model: "gpt-6-astra",
      asOf: "2026-10-09T18:30:00.000Z",
    });
    assert.equal(fillOf({ totalTokens: 5 }, NOW), undefined);
    assert.equal(fillOf({ contextTokens: 272000 }, NOW), undefined);
    assert.equal(fillOf({ totalTokens: 5, contextTokens: 0 }, NOW), undefined);
    assert.equal(fillOf(undefined, NOW), undefined);
  });

  it("is over a limit at or past it, and never when there is none", () => {
    const fill = { used: 218_000, window: 272_000, asOf: "" };
    assert.equal(overLimit(fill, 80), true);
    assert.equal(overLimit(fill, 90), false);
    assert.equal(overLimit(fill, null), false);
    assert.equal(overLimit(fill, undefined), false);
  });
});

describe("an agent's context window", () => {
  let rows: Map<string, Record<string, unknown>>;
  let calls: [string, Record<string, unknown>, { timeoutMs?: number } | undefined][];
  let busyFor: number;
  let compactAnswer: Record<string, unknown> | Error;
  let puts: [string, Record<string, unknown>][];
  let state: string;
  const claw: ClawPort = {
    request: async <T>(method: string, params: Record<string, unknown>, options?: { timeoutMs?: number }) => {
      calls.push([method, params, options]);
      if (method === "sessions.describe") return { session: rows.get(String(params["key"])) } as T;
      if (method === "sessions.compact") {
        if (busyFor > 0) {
          busyFor -= 1;
          throw new Error(`session ${String(params["key"])} has an active run; retry after it finishes`);
        }
        if (compactAnswer instanceof Error) throw compactAnswer;
        const after = Number((compactAnswer["result"] as Record<string, unknown> | undefined)?.["tokensAfter"] ?? 0);
        const row = rows.get(String(params["key"]));
        if (row !== undefined && compactAnswer["compacted"] !== false) row["totalTokens"] = after;
        return compactAnswer as T;
      }
      return {} as T;
    },
  };
  let settings: Settings;
  let busy = false;
  /** A restart: the bridge's windows and the SDK's settings, both new, with the state file kept. */
  const windows = (file = state) => {
    settings = settingsFor((agentId, body) => void puts.push([agentId, body]), {
      contextWindows: {
        compact: async (frame) => (await win.compact(frame, HOME, busy)) as never,
        change: async (frame) => (await win.change(frame, HOME)) as never,
      },
    });
    return new Windows(claw, portOf(settings), () => undefined, file, () => NOW, async () => undefined);
  };
  let win: Windows;
  /** A person's Compact now from Chips, while the bridge's turn runs in the session or not. */
  const compact = async (changeId: string, during: boolean): Promise<void> => {
    busy = during;
    await settings.hear({ frame: "context_window.compact", change_id: changeId, agent_id: "agt_main" });
  };
  /** A person's limit from Chips. */
  const change = async (changeId: string, at: number | null): Promise<void> => {
    await settings.hear({ frame: "context_window.change", change_id: changeId, agent_id: "agt_main", at });
  };

  beforeEach(() => {
    rows = new Map([[HOME.key, { totalTokens: 172_000, contextTokens: 272_000, model: "gpt-6-astra", updatedAt: NOW }]]);
    calls = [];
    busyFor = 0;
    compactAnswer = { ok: true, compacted: true, result: { tokensBefore: 172_000, tokensAfter: 21_000 } };
    puts = [];
    state = join(mkdtempSync(join(tmpdir(), "windows-")), "context-windows.json");
    win = windows();
  });

  const limit = (at: number | null) => ({ at, choices: [...LIMITS], default: null, may_turn_off: true });
  const copy = (extra: Record<string, unknown> = {}) => ({
    used: 172_000,
    window: 272_000,
    model: "gpt-6-astra",
    as_of: "2026-10-09T18:30:00.000Z",
    compacts: true,
    limit: limit(null),
    editable: true,
    ...extra,
  });

  it("sends the copy as OpenClaw has the session, only when it moved", async () => {
    await win.agent("agt_main", HOME);
    await win.agent("agt_main", HOME);
    assert.deepEqual(puts, [["agt_main", copy()]]);
    assert.deepEqual(calls[0]?.slice(0, 2), ["sessions.describe", { key: "agent:main:main", agentId: "main" }]);
  });

  it("sends nothing for a session OpenClaw doesn't know yet", async () => {
    await win.agent("agt_new", { key: "agent:chips-x:chips-spc_1", clawAgent: "chips-x" });
    assert.deepEqual(puts, []);
  });

  it("compacts now: taken and running, then what it came to, with the time OpenClaw takes", async () => {
    await win.agent("agt_main", HOME);
    await compact("chg_1", false);
    await win.settled();
    const asked = calls.find(([method]) => method === "sessions.compact");
    assert.deepEqual(asked?.[1], { key: "agent:main:main", agentId: "main" });
    assert.equal(asked?.[2]?.timeoutMs, 200_000);
    assert.deepEqual(puts.slice(1), [
      ["agt_main", copy({ compacting: "running", answers: "chg_1" })],
      [
        "agt_main",
        copy({ used: 21_000, last: { at: "2026-10-09T18:30:00.000Z", from: 172_000, to: 21_000, by: "asked" } }),
      ],
    ]);
  });

  it("waits for the bridge's turn in the session to end, then compacts", async () => {
    await compact("chg_1", true);
    assert.deepEqual(puts, [["agt_main", copy({ compacting: "queued", answers: "chg_1" })]]);
    assert.equal(calls.some(([method]) => method === "sessions.compact"), false);
    rows.set(HOME.key, { totalTokens: 190_000, contextTokens: 272_000, model: "gpt-6-astra", updatedAt: NOW });
    await win.turnEnded("agt_main", HOME);
    await win.settled();
    assert.equal(calls.filter(([method]) => method === "sessions.compact").length, 1);
    const last = puts.at(-1)?.[1];
    assert.equal(last?.["compacting"], undefined);
    assert.equal(last?.["answers"], undefined);
    assert.deepEqual(last?.["last"], { at: "2026-10-09T18:30:00.000Z", from: 172_000, to: 21_000, by: "asked" });
  });

  it("waits out OpenClaw's own work in the session, a try every ten seconds", async () => {
    busyFor = 2;
    await compact("chg_1", false);
    await win.settled();
    assert.equal(calls.filter(([method]) => method === "sessions.compact").length, 3);
    assert.equal(puts.at(-1)?.[1]?.["used"], 21_000);
  });

  it("refuses with OpenClaw's words when it compacts nothing, or fails", async () => {
    compactAnswer = { ok: true, compacted: false, reason: "Too little to compact." };
    await compact("chg_1", false);
    await win.settled();
    assert.deepEqual(puts.at(-1), ["agt_main", copy({ refuses: { change_id: "chg_1", message: "Too little to compact." } })]);

    compactAnswer = new Error("the model is unavailable");
    await compact("chg_2", false);
    await win.settled();
    assert.deepEqual(puts.at(-1), ["agt_main", copy({ refuses: { change_id: "chg_2", message: "the model is unavailable" } })]);
  });

  it("keeps a limit, answers it, and refuses one it doesn't offer", async () => {
    await change("chg_1", 70);
    assert.deepEqual(puts.at(-1), ["agt_main", copy({ limit: limit(70), answers: "chg_1" })]);
    await change("chg_2", 75);
    assert.deepEqual(puts.at(-1)?.[1]?.["refuses"], { change_id: "chg_2", message: "That limit isn't one OpenClaw's bridge offers." });
    assert.deepEqual(JSON.parse(readFileSync(state, "utf8")).limits, { agt_main: 70 });
  });

  it("compacts itself after a turn that ends past its limit, and not before", async () => {
    await change("chg_1", 70);
    await win.turnEnded("agt_main", HOME);
    await win.settled();
    assert.equal(calls.some(([method]) => method === "sessions.compact"), false);

    rows.set(HOME.key, { totalTokens: 200_000, contextTokens: 272_000, model: "gpt-6-astra", updatedAt: NOW });
    compactAnswer = { ok: true, compacted: true, result: { tokensBefore: 200_000, tokensAfter: 19_000 } };
    await win.turnEnded("agt_main", HOME);
    await win.settled();
    assert.equal(calls.filter(([method]) => method === "sessions.compact").length, 1);
    assert.deepEqual(puts.at(-1)?.[1]?.["last"], { at: "2026-10-09T18:30:00.000Z", from: 200_000, to: 19_000, by: "itself" });
  });

  it("remembers OpenClaw compacting on its own during a turn", async () => {
    await win.agent("agt_main", HOME);
    rows.set(HOME.key, { totalTokens: 30_000, contextTokens: 272_000, model: "gpt-6-astra", updatedAt: NOW });
    const fill = await win.turnEnded("agt_main", HOME, 250_000);
    await win.settled();
    assert.equal(fill?.used, 30_000);
    assert.deepEqual(puts.at(-1)?.[1]?.["last"], { at: "2026-10-09T18:30:00.000Z", from: 250_000, to: 30_000, by: "itself" });
  });

  it("remembers a compaction asked of OpenClaw itself", async () => {
    await win.agent("agt_main", HOME);
    rows.set(HOME.key, { totalTokens: 15_000, contextTokens: 272_000, model: "gpt-6-astra", updatedAt: NOW });
    win.changed("agt_main", HOME, true);
    await win.settled();
    assert.deepEqual(puts.at(-1)?.[1]?.["last"], { at: "2026-10-09T18:30:00.000Z", from: 172_000, to: 15_000, by: "asked" });
  });

  it("keeps its limits and last compactions across a restart, and forgets a deleted agent's", async () => {
    await change("chg_1", 80);
    await compact("chg_2", false);
    await win.settled();
    puts = [];
    const again = windows();
    await again.agent("agt_main", HOME);
    assert.deepEqual(puts[0]?.[1]?.["limit"], limit(80));
    assert.equal((puts[0]?.[1]?.["last"] as Record<string, unknown>)?.["to"], 21_000);
    again.forget("agt_main");
    assert.deepEqual(JSON.parse(readFileSync(state, "utf8")), { limits: {}, lasts: {} });
  });
});

describe("context windows through the bridge", () => {
  const ME = "hrn_01K4ZQPX000000000000000004";
  const MAIN_ROOM = "spc_01K4ZQPX0000000000000000M1";
  const MAIN = "agt_main_agent";
  let puts: [string, Record<string, unknown>][];
  let calls: [string, Record<string, unknown>][];
  let agents: ChipsAgent[];
  let bridge: Bridge;
  let settings: Settings;

  const chips: ChipsPort = {
    send: async (_event: ChipsEvent) => undefined,
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
      if (method === "sessions.describe") {
        return { session: { totalTokens: 23_197, contextTokens: 272_000, model: "gpt-6-astra", updatedAt: NOW } } as T;
      }
      if (method === "sessions.compact") return { ok: true, compacted: true, result: { tokensBefore: 23_197, tokensAfter: 9_000 } } as T;
      return {} as T;
    },
  };

  beforeEach(async () => {
    puts = [];
    calls = [];
    agents = [
      { agent_id: MAIN, key: "agent:main:chips-main", name: "OpenClaw", lead: true, state: "active", spaces: [MAIN_ROOM], room: MAIN_ROOM },
      { agent_id: "agt_scout", key: "scout", name: "Scout", lead: false, state: "active", spaces: [], room: null },
    ];
    settings = settingsFor((agentId, body) => void puts.push([agentId, body]), {
      contextWindows: {
        compact: async (frame) => (await bridge.onWindowCompact({ ...frame })) as never,
        change: async (frame) => (await bridge.onWindowChange({ ...frame })) as never,
      },
    });
    const windows = new Windows(claw, portOf(settings), () => undefined, undefined, () => NOW, async () => undefined);
    bridge = new Bridge(chips, claw, { harnessId: ME, agent: "main" }, () => undefined, undefined, Date.now, undefined, undefined, undefined, undefined, windows);
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }, { id: "scout" }] });
  });

  it("sends the Main agent's copy from Home at start, and none for an agent in no room", async () => {
    await bridge.sendWindows();
    const described = calls.filter(([method]) => method === "sessions.describe").map(([, params]) => params);
    assert.deepEqual(described, [{ key: "agent:main:main", agentId: "main" }]);
    assert.deepEqual(puts.map(([agentId, body]) => [agentId, body["used"], body["window"]]), [[MAIN, 23_197, 272_000]]);
  });

  it("compacts the Main agent's Home from Chips, and leaves an agent with no session unanswered", async () => {
    await settings.hear({ frame: "context_window.compact", change_id: "chg_1", agent_id: MAIN });
    await settings.hear({ frame: "context_window.compact", change_id: "chg_2", agent_id: "agt_scout" });
    await bridge.settled();
    const compacts = calls.filter(([method]) => method === "sessions.compact").map(([, params]) => params);
    assert.deepEqual(compacts, [{ key: "agent:main:main", agentId: "main" }]);
    assert.deepEqual(puts.filter(([, body]) => body["answers"] !== undefined).map(([agentId, body]) => [agentId, body["answers"]]), [[MAIN, "chg_1"]]);
    assert.equal(puts.at(-1)?.[1]?.["used"], 9_000);
  });

  it("takes a limit from Chips for the Main agent", async () => {
    await settings.hear({ frame: "context_window.change", change_id: "chg_1", agent_id: MAIN, at: 60 });
    await bridge.settled();
    assert.deepEqual(puts.at(-1)?.[1]?.["limit"], { at: 60, choices: [...LIMITS], default: null, may_turn_off: true });
    assert.equal(puts.at(-1)?.[1]?.["answers"], "chg_1");
  });
});
