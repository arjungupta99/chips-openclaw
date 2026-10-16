/**
 * An agent's model and effort in Chips (Chips ADR 0140): the copy each agent's page shows, and a
 * person's change written into OpenClaw's config, against a stand-in gateway that keeps the config
 * as OpenClaw does: entries and defaults, a hash that moves with every write, a merge patch where
 * `null` takes a key away, and `agents.list` working out what each agent runs on. Its models are
 * the live gateway's `models.list` with `view: "configured"` of 8 October 2026, less two.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { Settings } from "@chipschat/harness";
import { Bridge, type ChipsPort, type ClawPort } from "../src/bridge.ts";
import type { ChipsAgent } from "../src/chips.ts";
import {
  type ChangeFrame,
  type ClawModel,
  type ClawSetting,
  copyOf,
  DEFAULT_LABEL,
  levelWords,
  MODEL_CHOICES_MAX,
  Models,
  patchOf,
  READ_ONLY_WHY,
  shows,
  type Whose,
} from "../src/models.ts";
import { settingsFor } from "./settings-rig.ts";

const ME = "hrn_01K4ZQPX000000000000000004";
const ROOM = "spc_01K4ZQPX000000000000000002";
const MAIN_ROOM = "spc_01K4ZQPX0000000000000000M1";
const ARJUN = "usr_01K4ZQPX000000000000000003";
const MADE = "chips-01k4zqpx000000000000000099";
const CHANGE = "chg_01K4ZQPX00000000000000000C";

const level = (id: string) => ({ id, label: id });
const SIX = ["low", "medium", "high", "xhigh", "max", "ultra"].map(level);
const FIVE = SIX.slice(0, 5);
const MODELS: ClawModel[] = [
  { id: "gpt-6-astra", name: "GPT-6-Astra", provider: "openai", available: true, thinkingLevels: SIX, thinkingDefault: "medium" },
  { id: "gpt-6-sol", name: "GPT-6-Sol", provider: "openai", available: true, thinkingLevels: SIX, thinkingDefault: "medium" },
  { id: "gpt-6-luna", name: "GPT-6-Luna", provider: "openai", available: true, thinkingLevels: FIVE, thinkingDefault: "medium" },
  { id: "gpt-5.6-terra", name: "GPT-5.6-Terra", provider: "openai", available: true, thinkingLevels: SIX, thinkingDefault: "medium" },
];

type Entry = { model?: string | { primary?: string }; thinkingDefault?: string; name?: string };

let defaults: ClawSetting;
let entries: Record<string, Entry>;
let revision: number;
let calls: [string, Record<string, unknown>][];
let puts: [string, Record<string, unknown>][];
let logs: string[];
/** OpenClaw refuses a patch with these words when set; moves the config once before a patch when `race`. */
let refuse: string | undefined;
let race: number;
/** `agents.list` says the old model this many more times after a write, as if OpenClaw were slow. */
let lag: number;
let stale: Record<string, Entry> | undefined;
let offered: ClawModel[];

const primaryOf = (model: Entry["model"]): string | undefined => (typeof model === "string" ? model : model?.primary);
const modelNamed = (ref: string | undefined): ClawModel | undefined => MODELS.find((model) => `${model.provider}/${model.id}` === ref);

/** What an agent runs on now, worked out as OpenClaw's `agents.list` does. */
function listed(id: string, entry: Entry): Record<string, unknown> {
  const ref = primaryOf(entry.model) ?? primaryOf(defaults.model);
  const model = modelNamed(ref);
  return {
    id,
    name: entry.name ?? id,
    model: { primary: ref },
    thinkingLevels: model?.thinkingLevels ?? [],
    thinkingDefault: entry.thinkingDefault ?? defaults.thinkingDefault ?? model?.thinkingDefault,
  };
}

/** RFC 7386: an object merges, `null` takes the key away, anything else replaces. */
function merge(into: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...into };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else if (typeof value === "object" && !Array.isArray(value)) {
      out[key] = merge((out[key] ?? {}) as Record<string, unknown>, value as Record<string, unknown>);
    } else out[key] = value;
  }
  return out;
}

const hash = (): string => `h${revision}`;

const claw: ClawPort = {
  request: async <T>(method: string, params: Record<string, unknown>) => {
    calls.push([method, params]);
    switch (method) {
      case "agents.list": {
        const seen = lag > 0 && stale !== undefined ? stale : entries;
        if (lag > 0) lag -= 1;
        return { defaultId: "main", agents: Object.entries(seen).map(([id, entry]) => listed(id, entry)) } as T;
      }
      case "config.get":
        return { hash: hash(), config: { agents: { defaults, entries } } } as T;
      case "models.list":
        assert.equal(params["view"], "configured");
        return { models: offered } as T;
      case "config.patch": {
        if (race > 0) {
          race -= 1;
          revision += 1;
        }
        if (params["baseHash"] !== hash()) throw new Error("config changed since last load; re-run config.get and retry");
        if (refuse !== undefined) throw new Error(refuse);
        const patch = JSON.parse(String(params["raw"])) as { agents: { entries: Record<string, Entry> } };
        stale = structuredClone(entries);
        entries = merge(entries, patch.agents.entries) as Record<string, Entry>;
        revision += 1;
        return { ok: true } as T;
      }
      case "agents.create":
        entries = { ...entries, [String(params["name"])]: {} };
        revision += 1;
        return {} as T;
      case "agents.update":
        entries = { ...entries, [String(params["agentId"])]: { ...entries[String(params["agentId"])], name: String(params["name"]) } };
        revision += 1;
        return {} as T;
      default:
        return {} as T;
    }
  },
};

let models: Models;
let settings: Settings;
/** Who a change is for, and what makes it: the module, or the bridge in front of it. */
let whose: Whose;
let handle: (change: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** A person's change from Chips for `of`, made by the module and answered by the SDK. */
async function change(frame: { change_id: string; agent_id: string; model: string | null; effort: string | null }, of: Whose): Promise<void> {
  whose = of;
  await settings.hear({ frame: "model.change", ...frame });
}

beforeEach(() => {
  defaults = { model: { primary: "openai/gpt-6-astra" } };
  entries = { main: { name: "main" }, [MADE]: { name: "Scout" } };
  revision = 1;
  calls = [];
  puts = [];
  logs = [];
  refuse = undefined;
  race = 0;
  lag = 0;
  stale = undefined;
  offered = MODELS;
  whose = { clawAgent: MADE, changeable: true };
  handle = (frame) => models.change(frame as unknown as ChangeFrame, whose);
  settings = settingsFor((agentId, body) => void puts.push([agentId, body]), {
    models: async (frame) => (await handle({ ...frame })) as never,
  });
  models = new Models(claw, (agentId, copy) => settings.model(agentId, copy as never), (line) => logs.push(line), async () => undefined);
});

const choicesOf = (body: Record<string, unknown> | undefined): unknown[] =>
  ((body?.["choices"] ?? []) as Record<string, unknown>[]).map((each) => [
    each["id"],
    each["label"],
    (each["efforts"] as { id: string }[]).length,
    each["effort_default"],
  ]);

describe("an agent's model as Chips shows it", () => {
  it("is what a made agent runs on, OpenClaw's default for it, and the models it may run on", async () => {
    await models.agent("agt_scout", { clawAgent: MADE, changeable: true });
    const [agentId, body] = puts[0] ?? [];
    assert.equal(agentId, "agt_scout");
    assert.equal(body?.["model"], "openai/gpt-6-astra");
    assert.equal(body?.["effort"], "medium");
    assert.equal(body?.["own"], false);
    assert.deepEqual(body?.["default"], { label: DEFAULT_LABEL, model: "openai/gpt-6-astra", effort: "medium" });
    assert.equal(body?.["editable"], true);
    assert.equal(body?.["why_read_only"], undefined);
    assert.deepEqual(choicesOf(body), [
      ["openai/gpt-6-astra", "GPT-6-Astra", 6, "medium"],
      ["openai/gpt-6-sol", "GPT-6-Sol", 6, "medium"],
      ["openai/gpt-6-luna", "GPT-6-Luna", 5, "medium"],
      ["openai/gpt-5.6-terra", "GPT-5.6-Terra", 6, "medium"],
    ]);
    const astra = (body?.["choices"] as Record<string, unknown>[])[0];
    assert.deepEqual(
      (astra?.["efforts"] as { label: string }[]).map((each) => each.label),
      ["Low", "Medium", "High", "Extra high", "Max", "Ultra"],
    );
  });

  it("is read only for an agent the bridge found in OpenClaw, in its words", async () => {
    entries["found"] = { name: "Found" };
    await models.agent("agt_found", { clawAgent: "found", changeable: false });
    const body = puts[0]?.[1];
    assert.equal(body?.["editable"], false);
    assert.equal(body?.["why_read_only"], READ_ONLY_WHY);
    assert.equal(body?.["model"], "openai/gpt-6-astra");
  });

  it("says a model and level are its own when its entry sets either", async () => {
    entries[MADE] = { model: "openai/gpt-6-sol" };
    await models.agent("agt_scout", { clawAgent: MADE, changeable: true });
    assert.equal(puts[0]?.[1]["own"], true);
    assert.equal(puts[0]?.[1]["model"], "openai/gpt-6-sol");
    entries[MADE] = { thinkingDefault: "high" };
    await models.agent("agt_scout", { clawAgent: MADE, changeable: true });
    assert.equal(puts[1]?.[1]["own"], true);
    assert.equal(puts[1]?.[1]["effort"], "high");
  });

  it("takes the defaults' level for the default when they set one", async () => {
    defaults = { model: "openai/gpt-6-sol", thinkingDefault: "xhigh" };
    await models.agent("agt_scout", { clawAgent: MADE, changeable: true });
    assert.deepEqual(puts[0]?.[1]["default"], { label: DEFAULT_LABEL, model: "openai/gpt-6-sol", effort: "xhigh" });
    assert.equal(puts[0]?.[1]["effort"], "xhigh");
  });

  it("is sent again only when it moved", async () => {
    await models.agent("agt_scout", { clawAgent: MADE, changeable: true });
    await models.agent("agt_scout", { clawAgent: MADE, changeable: true });
    assert.equal(puts.length, 1);
    entries[MADE] = { model: "openai/gpt-6-luna" };
    await models.agent("agt_scout", { clawAgent: MADE, changeable: true });
    assert.equal(puts.length, 2);
    settings.forget("agt_scout");
    await models.agent("agt_scout", { clawAgent: MADE, changeable: true });
    assert.equal(puts.length, 3);
  });

  it("sends nothing for an agent OpenClaw doesn't list", async () => {
    await models.agent("agt_gone", { clawAgent: "chips-gone", changeable: true });
    assert.deepEqual(puts, []);
    assert.match(logs.at(-1) ?? "", /doesn't list chips-gone/);
  });
});

describe("the copy's rules", () => {
  const agent = { id: MADE, model: { primary: "openai/gpt-6-astra" }, thinkingLevels: SIX, thinkingDefault: "medium" };

  it("leaves out a model OpenClaw says it can't run, but never the one the agent runs on", () => {
    const body = copyOf({
      agent: { ...agent, model: { primary: "openai/gpt-5.5" }, thinkingLevels: [], thinkingDefault: undefined },
      own: { model: "openai/gpt-5.5" },
      defaults,
      models: [...MODELS, { id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: false }],
      editable: true,
    });
    assert.deepEqual(choicesOf(body).at(-1), ["openai/gpt-5.5", "gpt-5.5", 0, undefined]);
    assert.equal(body?.["effort"], undefined);
  });

  it("keeps forty, the agent's and the default's among them", () => {
    const many = Array.from({ length: 50 }, (_, at) => ({ id: `m-${at}`, name: `M ${at}`, provider: "openai" }));
    const body = copyOf({ agent: { ...agent, model: { primary: "openai/m-49" } }, own: undefined, defaults, models: many, editable: true });
    const ids = choicesOf(body).map((each) => (each as string[])[0]);
    assert.equal(ids.length, MODEL_CHOICES_MAX);
    assert.ok(ids.includes("openai/m-49"));
    assert.ok(ids.includes("openai/gpt-6-astra"));
  });

  it("keeps a model's highest eight levels, each named once", () => {
    const ten = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "turbo", "low"].map(level);
    const body = copyOf({
      agent,
      own: undefined,
      defaults,
      models: [{ id: "gpt-6-astra", name: "GPT-6-Astra", provider: "openai", thinkingLevels: ten }],
      editable: true,
    });
    const efforts = ((body?.["choices"] as Record<string, unknown>[])[0]?.["efforts"] ?? []) as { id: string }[];
    assert.deepEqual(efforts.map((each) => each.id), ["minimal", "low", "medium", "high", "xhigh", "max", "ultra", "turbo"]);
    assert.equal(levelWords({ id: "turbo", label: "turbo" }), "Turbo");
  });

  it("sends no copy for an agent with no model and no default", () => {
    assert.equal(copyOf({ agent: { id: MADE }, own: undefined, defaults: undefined, models: MODELS, editable: true }), undefined);
  });

  it("writes a change as one patch of the agent's entry", () => {
    assert.deepEqual(JSON.parse(patchOf(MADE, { model: "openai/gpt-6-sol", effort: "high" })), {
      agents: { entries: { [MADE]: { model: "openai/gpt-6-sol", thinkingDefault: "high" } } },
    });
    assert.deepEqual(JSON.parse(patchOf(MADE, { model: null, effort: null })), {
      agents: { entries: { [MADE]: { model: null, thinkingDefault: null } } },
    });
    assert.ok(shows({ own: true, model: "openai/gpt-6-sol", effort: "high" }, { model: "openai/gpt-6-sol", effort: "high" }));
    assert.ok(!shows({ own: true, model: "openai/gpt-6-astra", effort: "high" }, { model: "openai/gpt-6-sol", effort: "high" }));
    assert.ok(shows({ own: false }, { model: null, effort: null }));
  });
});

describe("a person's change from Chips", () => {
  const ask = (model: string | null, effort: string | null) => ({ change_id: CHANGE, agent_id: "agt_scout", model, effort });

  it("is written into the agent's entry from the config it was read from, and the copy answers it", async () => {
    await change(ask("openai/gpt-6-sol", "high"), { clawAgent: MADE, changeable: true });
    const patch = calls.find(([method]) => method === "config.patch")?.[1];
    assert.equal(patch?.["baseHash"], "h1");
    assert.deepEqual(entries[MADE], { name: "Scout", model: "openai/gpt-6-sol", thinkingDefault: "high" });
    const [agentId, body] = puts.at(-1) ?? [];
    assert.equal(agentId, "agt_scout");
    assert.equal(body?.["answers"], CHANGE);
    assert.equal(body?.["model"], "openai/gpt-6-sol");
    assert.equal(body?.["effort"], "high");
    assert.equal(body?.["own"], true);
  });

  it("takes both away for Same, and the agent runs on OpenClaw's default", async () => {
    entries[MADE] = { name: "Scout", model: "openai/gpt-6-luna", thinkingDefault: "max" };
    await change(ask(null, null), { clawAgent: MADE, changeable: true });
    assert.deepEqual(entries[MADE], { name: "Scout" });
    const body = puts.at(-1)?.[1];
    assert.equal(body?.["answers"], CHANGE);
    assert.equal(body?.["own"], false);
    assert.equal(body?.["model"], "openai/gpt-6-astra");
    assert.equal(body?.["effort"], "medium");
  });

  it("is refused with OpenClaw's words, and the copy says what the agent still runs on", async () => {
    refuse = `invalid config: agents.entries.${MADE}.model: unknown model "openai/gpt-6-sol"${" and more".repeat(60)}`;
    await change(ask("openai/gpt-6-sol", "high"), { clawAgent: MADE, changeable: true });
    const body = puts.at(-1)?.[1];
    const refusal = body?.["refuses"] as { change_id: string; message: string };
    assert.equal(refusal.change_id, CHANGE);
    assert.match(refusal.message, /^invalid config: .*unknown model/);
    assert.equal(refusal.message.length, 300);
    assert.equal(body?.["answers"], undefined);
    assert.equal(body?.["model"], "openai/gpt-6-astra");
    assert.equal(entries[MADE]?.model, undefined);
  });

  it("is refused for an agent the bridge found in OpenClaw, which is changed in OpenClaw", async () => {
    entries["found"] = { name: "Found" };
    await change({ ...ask("openai/gpt-6-sol", "high"), agent_id: "agt_found" }, { clawAgent: "found", changeable: false });
    assert.ok(!calls.some(([method]) => method === "config.patch"));
    assert.deepEqual(puts.at(-1)?.[1]["refuses"], { change_id: CHANGE, message: READ_ONLY_WHY });
  });

  it("reads the config again when it moved before the write, and writes it then", async () => {
    race = 1;
    await change(ask("openai/gpt-6-sol", "low"), { clawAgent: MADE, changeable: true });
    assert.equal(calls.filter(([method]) => method === "config.patch").length, 2);
    assert.equal(puts.at(-1)?.[1]["answers"], CHANGE);
    assert.equal(entries[MADE]?.thinkingDefault, "low");
  });

  it("answers once OpenClaw lists the agent as changed", async () => {
    lag = 2;
    await change(ask("openai/gpt-6-sol", "high"), { clawAgent: MADE, changeable: true });
    assert.equal(puts.length, 1);
    assert.equal(puts[0]?.[1]["model"], "openai/gpt-6-sol");
    assert.equal(calls.filter(([method]) => method === "agents.list").length, 3);
  });
});

describe("the bridge keeps the models current", () => {
  let agents: ChipsAgent[];
  const agentIn = (agentId: string, key: string, room: string | null, name: string, lead = false): ChipsAgent => ({
    agent_id: agentId,
    key,
    name,
    lead,
    state: "active",
    spaces: room === null ? [] : [room],
    room,
  });
  const chips: ChipsPort = {
    send: async () => undefined,
    claim: async () => undefined,
    fetchAttachment: async () => Buffer.from(""),
    upload: async () => "att_01K4ZQPX000000000000000001",
    agents: async () => agents,
    registerAgent: async (wanted) => {
      const had = agents.find((each) => each.key === wanted.key);
      if (had !== undefined) return { ...had, attached: true };
      const agent = agentIn(`agt_${agents.length + 1}`, wanted.key, wanted.space_id ?? null, wanted.name, wanted.lead === true);
      agents = [...agents, agent];
      return { ...agent, attached: true };
    },
    openSpace: async () => MAIN_ROOM,
    attach: async () => true,
    roomContext: async () => ({ lines: [] }),
    forget: (agentId) => settings.forget(agentId),
  };
  const session = `agent:${MADE}:chips-${ROOM.toLowerCase()}`;
  let bridge: Bridge;

  beforeEach(() => {
    agents = [
      agentIn("agt_scout", session, ROOM, "Scout"),
      agentIn("agt_main", "agent:main:chips-main", MAIN_ROOM, "OpenClaw", true),
      agentIn("agt_found", "found", null, "Found"),
    ];
    entries["found"] = { name: "Found", model: "openai/gpt-6-luna" };
    bridge = new Bridge(chips, claw, { harnessId: ME, agent: "main" }, () => undefined, undefined, Date.now, undefined, undefined, models);
    handle = (frame) => bridge.onModelChange(frame);
  });

  it("sends each agent's at start: the made one's and the Main agent's to change, a found one's read only", async () => {
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }, { id: "found" }] });
    await bridge.sendModels();
    const byAgent = new Map(puts.map(([agentId, body]) => [agentId, body]));
    assert.deepEqual([...byAgent.keys()].sort(), ["agt_found", "agt_main", "agt_scout"]);
    assert.equal(byAgent.get("agt_scout")?.["editable"], true);
    assert.equal(byAgent.get("agt_main")?.["editable"], true);
    assert.equal(byAgent.get("agt_main")?.["why_read_only"], undefined);
    assert.equal(byAgent.get("agt_found")?.["editable"], false);
    assert.equal(byAgent.get("agt_found")?.["model"], "openai/gpt-6-luna");
    assert.equal(byAgent.get("agt_found")?.["own"], true);
  });

  it("writes a change for the agent it made and for the Main agent, and refuses one for a found agent", async () => {
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }, { id: "found" }] });
    await settings.hear({ frame: "model.change", change_id: CHANGE, harness_id: ME, agent_id: "agt_scout", model: "openai/gpt-6-sol", effort: "max", asked_by: ARJUN, asked_at: "2026-10-08T23:30:00.000Z" });
    assert.equal(entries[MADE]?.model, "openai/gpt-6-sol");
    assert.equal(puts.at(-1)?.[1]["answers"], CHANGE);
    // The Main agent is OpenClaw's primary agent: its entry takes the change, beside what it had.
    await settings.hear({ frame: "model.change", change_id: CHANGE, harness_id: ME, agent_id: "agt_main", model: "openai/gpt-6-sol", effort: "max", asked_by: ARJUN, asked_at: "2026-10-08T23:30:00.000Z" });
    assert.deepEqual(entries["main"], { name: "main", model: "openai/gpt-6-sol", thinkingDefault: "max" });
    const [agentId, body] = puts.at(-1) ?? [];
    assert.equal(agentId, "agt_main");
    assert.deepEqual([body?.["answers"], body?.["model"], body?.["effort"], body?.["own"]], [CHANGE, "openai/gpt-6-sol", "max", true]);
    // And back to OpenClaw's default, which leaves its entry as it was.
    await settings.hear({ frame: "model.change", change_id: CHANGE, harness_id: ME, agent_id: "agt_main", model: null, effort: null, asked_by: ARJUN, asked_at: "2026-10-08T23:30:00.000Z" });
    assert.deepEqual(entries["main"], { name: "main" });
    assert.equal(puts.at(-1)?.[1]["own"], false);
    await settings.hear({ frame: "model.change", change_id: CHANGE, harness_id: ME, agent_id: "agt_found", model: "openai/gpt-6-sol", effort: "max", asked_by: ARJUN, asked_at: "2026-10-08T23:30:00.000Z" });
    assert.equal(entries["found"]?.model, "openai/gpt-6-luna");
    assert.deepEqual(puts.at(-1)?.[1]["refuses"], { change_id: CHANGE, message: READ_ONLY_WHY });
    // One for an agent the bridge doesn't know is not answered; Chips says it was missed.
    puts = [];
    await settings.hear({ frame: "model.change", change_id: CHANGE, harness_id: ME, agent_id: "agt_nobody", model: null, effort: null, asked_by: ARJUN, asked_at: "2026-10-08T23:30:00.000Z" });
    assert.deepEqual(puts, []);
  });

  it("sends a copy after a turn that finds the model moved in OpenClaw, and none after one that did not", async () => {
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    await bridge.sendModels();
    puts = [];
    const turn = async (id: string, change?: () => void): Promise<void> => {
      await bridge.onChips({ type: "message.new", space_id: ROOM, message_id: id, from: { participant_id: ARJUN, kind: "person" }, text: "Go on", addressed_to: ["agt_scout"], for: ["agt_scout"] });
      const runId = `${id}:${MADE}`;
      bridge.onClaw({ event: "chat", payload: { runId, sessionKey: session, seq: 1, state: "status" } });
      change?.();
      bridge.onClaw({ event: "chat", payload: { runId, sessionKey: session, seq: 2, state: "final", message: "Done." } });
      await bridge.settled();
    };
    await turn("msg_01K4ZQPX0000000000000000A1");
    assert.equal(puts.length, 0);
    await turn("msg_01K4ZQPX0000000000000000A2", () => {
      entries[MADE] = { name: "Scout", thinkingDefault: "ultra" };
    });
    assert.deepEqual(puts.map(([agentId, body]) => [agentId, body["effort"], body["own"]]), [["agt_scout", "ultra", true]]);
  });

  it("sends a made agent's once Chips has it", async () => {
    await bridge.onChips({ type: "agent.asked", id: "evt_01K4ZQPX0000000000000000N1", ts: new Date().toISOString(), space_id: ROOM, harness_id: ME, name: "Reviewer", by: ARJUN });
    await bridge.settled();
    const [agentId, body] = puts.at(-1) ?? [];
    assert.equal(agentId, `agt_${agents.length}`);
    assert.equal(body?.["editable"], true);
  });
});
