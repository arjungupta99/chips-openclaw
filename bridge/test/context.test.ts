/**
 * An agent's context in Chips (Chips ADR 0134): the files OpenClaw builds each agent from, sent as
 * a copy and edited from Chips, against a stand-in gateway that keeps each agent's folder as
 * OpenClaw does: the same names, SHA-256 hashes, and `agent_file_conflict` on a stale write.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import type { Settings } from "@chipschat/harness";
import { Bridge, type ChipsPort, type ClawPort } from "../src/bridge.ts";
import type { ChipsAgent } from "../src/chips.ts";
import { type ClawFile, Contexts, type EditFrame, identityLine, type Owner, ownSetOf, setOf } from "../src/context.ts";
import { settingsFor } from "./settings-rig.ts";

const ME = "hrn_01K4ZQPX000000000000000004";
const ROOM = "spc_01K4ZQPX000000000000000002";
/** The Main agent's room (Chips ADR 0087). */
const MAIN_ROOM = "spc_01K4ZQPX0000000000000000M1";
const ARJUN = "usr_01K4ZQPX000000000000000003";
const MADE = "chips-01k4zqpx000000000000000099";
const EDIT = "edt_01K4ZQPX00000000000000000E";

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const file = (name: string, content: string): ClawFile => ({ name, content, hash: sha(content) });

/** The files OpenClaw reads, in its own order; `agents.files.list` names all but the identity. */
const OPENCLAW_FILES = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "BOOTSTRAP.md", "MEMORY.md"];
const IDENTITY = (name: string): string =>
  `# IDENTITY.md - Who Am I?\n\n_Fill this in during your first conversation. Make it yours._\n\n- Name: ${name}\n  _(pick something you like)_\n`;

/** Each agent's folder, by OpenClaw agent and file name. */
let folders: Map<string, Map<string, string>>;
let calls: [string, Record<string, unknown>][];
let puts: [Owner, Record<string, unknown>][];
let failWrites: boolean;
let logs: string[];

function folder(agent: string): Map<string, string> {
  let found = folders.get(agent);
  if (found === undefined) {
    found = new Map();
    folders.set(agent, found);
  }
  return found;
}

/** The gateway, as far as the files and the agents the bridge makes go. */
const claw: ClawPort = {
  request: async <T>(method: string, params: Record<string, unknown>) => {
    calls.push([method, params]);
    const agent = String(params["agentId"] ?? params["name"]);
    const name = String(params["name"]);
    switch (method) {
      case "agents.files.list":
        return {
          agentId: agent,
          files: OPENCLAW_FILES.filter((each) => each !== "IDENTITY.md").map((each) => ({
            name: each,
            missing: !folder(agent).has(each),
          })),
        } as T;
      case "agents.files.get": {
        if (!OPENCLAW_FILES.includes(name)) throw new Error(`unsupported file "${name}"`);
        const content = folder(agent).get(name);
        return {
          agentId: agent,
          file: content === undefined ? { name, missing: true } : { name, missing: false, content, hash: sha(content) },
        } as T;
      }
      case "agents.files.set": {
        if (failWrites) throw new Error("EACCES: permission denied");
        const now = folder(agent).get(name);
        const expected = params["expectedHash"];
        if (typeof expected === "string" && (now === undefined || sha(now) !== expected)) {
          throw Object.assign(new Error(`agent file "${name}" changed since it was read`), {
            details: { type: "agent_file_conflict", name, ...(now === undefined ? {} : { currentHash: sha(now) }) },
          });
        }
        folder(agent).set(name, String(params["content"]));
        return { ok: true } as T;
      }
      case "agents.create":
        folder(agent).set("SOUL.md", folder("main").get("SOUL.md") ?? "");
        return {} as T;
      case "agents.list":
        return { agents: [{ id: "main" }, ...[...folders.keys()].filter((id) => id !== "main").map((id) => ({ id, name: names.get(id) }))] } as T;
      case "agents.update": {
        // OpenClaw writes the new name into the agent's identity.
        names.set(agent, name);
        folder(agent).set("IDENTITY.md", IDENTITY(name));
        return {} as T;
      }
      default:
        return {} as T;
    }
  },
};
let names: Map<string, string>;

let contexts: Contexts;
let settings: Settings;
/** What makes a person's edit: the module, for one OpenClaw agent, or the bridge in front of it. */
let handle: (frame: Record<string, unknown>) => Promise<Record<string, unknown>>;
let editing = MADE;

/** A person's edit from Chips of `clawAgent`'s files, made by the module and answered by the SDK. */
async function edit(frame: Omit<EditFrame, "agent_id"> & { agent_id?: string }, clawAgent: string): Promise<void> {
  editing = clawAgent;
  await settings.hear({ frame: "context.edit", ...frame });
}

beforeEach(() => {
  folders = new Map();
  names = new Map();
  calls = [];
  puts = [];
  failWrites = false;
  logs = [];
  handle = (frame) => contexts.edit(frame as unknown as EditFrame, editing);
  settings = settingsFor((whose, body) => void puts.push([whose === "harness" ? "harness" : { agentId: whose }, body]), {
    context: async (frame) => (await handle({ ...frame })) as never,
  });
  contexts = new Contexts(
    claw,
    (owner, copy) => (owner === "harness" ? settings.harnessContext(copy as never) : settings.context(owner.agentId, copy as never)),
    (message) => logs.push(message),
  );
  for (const [name, text] of [
    ["SOUL.md", "# SOUL.md - Who You Are\n\n_You're not a chatbot._"],
    ["AGENTS.md", "# AGENTS.md\n\nRead SOUL.md first."],
    ["USER.md", "# USER.md\n\n- Name: Arjun"],
    ["IDENTITY.md", IDENTITY("main")],
  ] as const) {
    folder("main").set(name, text);
  }
});

const shown = (body: Record<string, unknown> | undefined, key = "files"): unknown[] =>
  ((body?.[key] ?? []) as Record<string, unknown>[]).map((each) => [each["name"], each["title"], each["role"]]);

describe("an agent's files as Chips shows them", () => {
  it("puts them in the order a person reads them, with OpenClaw's titles, and the rest by their own names", () => {
    const set = setOf([
      file("MEMORY.md", "remembered"),
      file("USER.md", "you"),
      file("NOTES.md", "notes"),
      file("IDENTITY.md", IDENTITY("Scout")),
      file("AGENTS.md", "how"),
      file("SOUL.md", "who"),
    ]);
    assert.deepEqual(shown(set), [
      ["SOUL.md", "Who it is", "identity"],
      ["AGENTS.md", "How it works", "instructions"],
      ["USER.md", "About you", "about_you"],
      ["IDENTITY.md", "Identity", "identity"],
      ["MEMORY.md", "Memory", "memory"],
      ["NOTES.md", "NOTES.md", "other"],
    ]);
    assert.equal(set.files[3]?.["about"], "Name: Scout");
    assert.equal(set.files[0]?.["about"], undefined);
    assert.equal(set.files[0]?.["hash"], sha("who"));
    assert.ok(set.files.every((each) => each["editable"] === true));
    assert.deepEqual(set.not_shown, []);
  });

  it("says no name for an identity not filled in", () => {
    assert.equal(identityLine("- **Name:**\n  _(pick something you like)_"), undefined);
    assert.equal(identityLine("- **Name:** Juniper"), "Name: Juniper");
  });

  it("shows eight, and names the rest apart, and a file over 64 KB as too large", () => {
    const many = Array.from({ length: 10 }, (_, index) => file(`NOTE-${index}.md`, `note ${index}`));
    const set = setOf([...many, file("SOUL.md", "x".repeat(70 * 1024))]);
    assert.equal(set.files.length, 8);
    assert.deepEqual(set.not_shown, [
      { name: "SOUL.md", title: "Who it is", reason: "too_large" },
      { name: "NOTE-8.md", reason: "count" },
      { name: "NOTE-9.md", reason: "count" },
    ]);
  });
});

describe("the copy Chips holds", () => {
  it("reads what the agent has, its identity too, and never the first-run ritual", async () => {
    folder(MADE).set("SOUL.md", "who");
    folder(MADE).set("IDENTITY.md", IDENTITY("Scout"));
    folder(MADE).set("BOOTSTRAP.md", "who am I?");
    await contexts.agent("agt_scout", MADE);
    assert.deepEqual(puts.map(([owner]) => owner), [{ agentId: "agt_scout" }]);
    assert.deepEqual(shown(puts[0]?.[1]), [
      ["SOUL.md", "Who it is", "identity"],
      ["IDENTITY.md", "Identity", "identity"],
    ]);
  });

  it("sends a copy again only when a file moved", async () => {
    folder(MADE).set("SOUL.md", "who");
    await contexts.agent("agt_scout", MADE);
    await contexts.agent("agt_scout", MADE);
    assert.equal(puts.length, 1);
    folder(MADE).set("MEMORY.md", "Arjun likes short answers.");
    await contexts.agent("agt_scout", MADE);
    assert.equal(puts.length, 2);
    assert.deepEqual(shown(puts[1]?.[1]).at(-1), ["MEMORY.md", "Memory", "memory"]);
  });

  it("sends the harness's own: what a new agent starts with, which no agent reads after", async () => {
    await contexts.harness("main");
    const [owner, body] = puts[0] ?? [];
    assert.equal(owner, "harness");
    assert.deepEqual(shown(body, "shared"), [
      ["SOUL.md", "Who it is", "identity"],
      ["AGENTS.md", "How it works", "instructions"],
      ["USER.md", "About you", "about_you"],
    ]);
    const shared = (body?.["shared"] ?? []) as Record<string, unknown>[];
    assert.deepEqual(
      shared.map((each) => [each["id"], each["used_by"], each["for_new_agents"], each["editable"]]),
      [
        ["soul", undefined, true, true],
        ["agents", undefined, true, true],
        ["user", undefined, true, true],
      ],
    );
    assert.equal(typeof body?.["new_agents_note"], "string");
    // Only the three: main's identity is its own.
    assert.ok(!calls.some(([method, params]) => method === "agents.files.get" && params["name"] === "IDENTITY.md"));
    assert.deepEqual(ownSetOf([]).shared, []);
  });
});

describe("a person's edit from Chips", () => {
  const ask = (more: Record<string, unknown> = {}) => ({
    edit_id: EDIT,
    agent_id: "agt_scout",
    name: "SOUL.md",
    text: "Plain and careful.",
    base_hash: sha("who"),
    ...more,
  });

  beforeEach(() => folder(MADE).set("SOUL.md", "who"));

  it("is saved in the agent's folder from the version it was made from, and the copy answers it", async () => {
    await edit(ask(), MADE);
    assert.deepEqual(calls.find(([method]) => method === "agents.files.set")?.[1], {
      agentId: MADE,
      name: "SOUL.md",
      content: "Plain and careful.",
      expectedHash: sha("who"),
    });
    assert.equal(folder(MADE).get("SOUL.md"), "Plain and careful.");
    const [owner, body] = puts.at(-1) ?? [];
    assert.deepEqual(owner, { agentId: "agt_scout" });
    assert.equal(body?.["answers"], EDIT);
    assert.equal((body?.["files"] as Record<string, unknown>[])[0]?.["hash"], sha("Plain and careful."));
  });

  it("is refused as changed when the file moved since, and the copy says what is there now", async () => {
    folder(MADE).set("SOUL.md", "changed by hand");
    await edit(ask(), MADE);
    assert.equal(folder(MADE).get("SOUL.md"), "changed by hand");
    const body = puts.at(-1)?.[1];
    assert.deepEqual(body?.["refuses"], { edit_id: EDIT, reason: "changed" });
    assert.equal((body?.["files"] as Record<string, unknown>[])[0]?.["text"], "changed by hand");
  });

  it("is refused as failed, with OpenClaw's words, when the write fails otherwise", async () => {
    failWrites = true;
    await edit(ask(), MADE);
    assert.deepEqual(puts.at(-1)?.[1]?.["refuses"], {
      edit_id: EDIT,
      reason: "failed",
      message: "EACCES: permission denied",
    });
  });

  it("saves one of the harness's own in the primary agent's folder, and refuses a file new agents do not start with", async () => {
    await edit({ edit_id: EDIT, name: "USER.md", text: "- Name: Arjun G", base_hash: sha("# USER.md\n\n- Name: Arjun") }, "main");
    assert.equal(folder("main").get("USER.md"), "- Name: Arjun G");
    assert.deepEqual(puts.at(-1)?.[0], "harness");
    assert.equal(puts.at(-1)?.[1]?.["answers"], EDIT);
    await edit({ edit_id: EDIT, name: "IDENTITY.md", text: "- Name: me", base_hash: sha(IDENTITY("main")) }, "main");
    assert.equal(folder("main").get("IDENTITY.md"), IDENTITY("main"));
    assert.equal((puts.at(-1)?.[1]?.["refuses"] as Record<string, unknown>)["reason"], "failed");
  });
});

describe("the bridge keeps the copies current", () => {
  let agents: ChipsAgent[];
  let registered: Record<string, unknown>[];
  const agentIn = (agentId: string, key: string, room: string | null, name: string): ChipsAgent => ({
    agent_id: agentId,
    key,
    name,
    lead: false,
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
      registered.push({ ...wanted });
      const agent = { ...agentIn(`agt_${registered.length}`, wanted.key, wanted.space_id ?? null, wanted.name), lead: wanted.lead === true };
      agents = [...agents, agent];
      return { ...agent, attached: true };
    },
    openSpace: async (key) => {
      agents = agents.map((each) => (each.key === key ? { ...each, spaces: [MAIN_ROOM], room: MAIN_ROOM } : each));
      return MAIN_ROOM;
    },
    attach: async () => true,
    roomContext: async () => ({ lines: [] }),
    forget: (agentId) => settings.forget(agentId),
  };
  let bridge: Bridge;
  const session = `agent:${MADE}:chips-${ROOM.toLowerCase()}`;

  beforeEach(() => {
    agents = [agentIn("agt_scout", session, ROOM, "Scout"), agentIn("agt_main", "main", null, "OpenClaw")];
    registered = [];
    bridge = new Bridge(chips, claw, { harnessId: ME, agent: "main" }, () => undefined, undefined, Date.now, undefined, contexts);
    handle = (frame) => bridge.onContextEdit(frame);
    folder(MADE).set("SOUL.md", "who");
  });

  it("sends the harness's own, each agent it made and the Main agent at start, and none other", async () => {
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    await bridge.sendContexts();
    assert.deepEqual(puts.map(([owner]) => owner), ["harness", { agentId: "agt_scout" }, { agentId: "agt_1" }]);
    // The Main agent's files are the primary agent's.
    const soul = (puts[2]?.[1]["files"] as Record<string, unknown>[]).find((each) => each["name"] === "SOUL.md");
    assert.equal(soul?.["text"], folder("main").get("SOUL.md"));
  });

  it("sends a made agent's copy once Chips has it, named", async () => {
    await bridge.onChips({ type: "agent.asked", id: "evt_01K4ZQPX0000000000000000N1", ts: new Date().toISOString(), space_id: ROOM, harness_id: ME, name: "Reviewer", by: ARJUN });
    await bridge.settled();
    const [owner, body] = puts.at(-1) ?? [];
    assert.deepEqual(owner, { agentId: "agt_1" });
    const identity = (body?.["files"] as Record<string, unknown>[]).find((each) => each["name"] === "IDENTITY.md");
    assert.equal(identity?.["about"], "Name: Reviewer");
  });

  it("sends it again after a rename, which rewrote its identity", async () => {
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    await bridge.sendContexts();
    puts = [];
    await bridge.onChips({ type: "agent.updated", agent_id: "agt_scout", name: "Juniper" });
    await bridge.settled();
    assert.equal(puts.length, 1);
    const identity = (puts[0]?.[1]["files"] as Record<string, unknown>[]).find((each) => each["name"] === "IDENTITY.md");
    assert.equal(identity?.["about"], "Name: Juniper");
  });

  it("sends a copy after a turn that changed a file, and none after one that did not", async () => {
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    await bridge.sendContexts();
    puts = [];
    const turn = async (id: string, change?: () => void): Promise<void> => {
      await bridge.onChips({ type: "message.new", space_id: ROOM, message_id: id, from: { participant_id: ARJUN, kind: "person" }, text: "Remember this", addressed_to: ["agt_scout"], for: ["agt_scout"] });
      const runId = `${id}:${MADE}`;
      bridge.onClaw({ event: "chat", payload: { runId, sessionKey: session, seq: 1, state: "status" } });
      change?.();
      bridge.onClaw({ event: "chat", payload: { runId, sessionKey: session, seq: 2, state: "final", message: "Done." } });
      await bridge.settled();
    };
    await turn("msg_01K4ZQPX0000000000000000A1");
    assert.equal(puts.length, 0);
    await turn("msg_01K4ZQPX0000000000000000A2", () => folder(MADE).set("MEMORY.md", "Short answers."));
    assert.deepEqual(puts.map(([owner]) => owner), [{ agentId: "agt_scout" }]);
  });

  it("saves an edit in the folder of the agent it is for, and the harness's in the primary agent's", async () => {
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    await settings.hear({ frame: "context.edit", edit_id: EDIT, harness_id: ME, agent_id: "agt_scout", name: "SOUL.md", text: "Careful.", base_hash: sha("who"), asked_by: ARJUN, asked_at: "2026-10-07T20:00:00.000Z" });
    assert.equal(folder(MADE).get("SOUL.md"), "Careful.");
    await settings.hear({ frame: "context.edit", edit_id: EDIT, harness_id: ME, name: "SOUL.md", text: "Main's.", base_hash: sha("# SOUL.md - Who You Are\n\n_You're not a chatbot._"), asked_by: ARJUN, asked_at: "2026-10-07T20:00:00.000Z" });
    assert.equal(folder("main").get("SOUL.md"), "Main's.");
    // The Main agent's are the primary agent's too.
    await settings.hear({ frame: "context.edit", edit_id: EDIT, harness_id: ME, agent_id: "agt_1", name: "SOUL.md", text: "The Main agent's.", base_hash: sha("Main's."), asked_by: ARJUN, asked_at: "2026-10-07T20:00:00.000Z" });
    assert.equal(folder("main").get("SOUL.md"), "The Main agent's.");
    // An agent with no OpenClaw agent of its own is not answered; Chips says the edit was missed.
    puts = [];
    await settings.hear({ frame: "context.edit", edit_id: EDIT, harness_id: ME, agent_id: "agt_main", name: "SOUL.md", text: "x", base_hash: sha("x"), asked_by: ARJUN, asked_at: "2026-10-07T20:00:00.000Z" });
    assert.deepEqual(puts, []);
  });
});
