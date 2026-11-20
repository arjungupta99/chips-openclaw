/**
 * The mode a person picks in Chips for OpenClaw's sessions (Chips ADR 0300, addendum "Hermes,
 * OpenClaw and OpenCode get the Mode picker too"): the modes offered and their lines, the copy for
 * the mode its sessions run in, and each session put in the mode in force, against a stand-in
 * gateway that records what it is asked.
 */

import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";
import type { ClawPort } from "../src/bridge.ts";
import { clawModeOf, HOME_NOTE, Modes, modedOwnRules, offers } from "../src/modes.ts";
import type { OwnRules } from "../src/own-rules.ts";

/** The rig's config, as `scripts/up.sh` writes it: every command asks. */
const RIG = { tools: { exec: { host: "gateway", mode: "ask" } } };
const ROOM_SESSION = "agent:chips-01k4zqpx000000000000000002:chips-spc_01k4zqpx000000000000000002";
const OTHER_SESSION = "agent:main:chips-spc_01k4zqpx000000000000000003";

describe("the modes OpenClaw offers", () => {
  it("offers its five, in its order, with the lines Chips ADR 0300 gives them, and Full access never asks", () => {
    assert.deepEqual(offers({ config: RIG }), [
      { id: "default", name: "Default", words: "Runs as its settings say. Yours ask before every command." },
      { id: "read-only", name: "Read only", words: "Reads its folder. Changes nothing and runs no commands." },
      { id: "guarded", name: "Ask me", words: "Edits in its folder. Commands not on its allowlist ask first." },
      { id: "workspace", name: "Auto-review", words: "OpenClaw judges each step and asks only when one looks risky." },
      { id: "full", name: "Full access", words: "Never asks. Any file, any command, the network.", everything: true },
    ]);
  });

  it("says Default runs as its settings say, and what they say only where the gateway said", () => {
    assert.equal(offers({ config: { tools: { exec: { mode: "full" } } } })[0]?.words, "Runs as its settings say. Yours run every command without asking.");
    assert.equal(offers(undefined)[0]?.words, "Runs as its settings say.");
  });

  it("sends each mode as itself, and Default, or a mode that isn't OpenClaw's, as none", () => {
    for (const mode of ["read-only", "guarded", "workspace", "full"]) assert.equal(clawModeOf(mode), mode);
    for (const id of ["default", "bypassPermissions", undefined]) assert.equal(clawModeOf(id), null);
  });
});

describe("the copy for the mode its sessions run in", () => {
  it("in Default, says what its settings let through, that Home keeps its own mode, and the modes", () => {
    const copy = modedOwnRules({ config: RIG, configPath: "/home/node/.openclaw/openclaw.json" }, null);
    assert.equal(copy?.mode, "Default");
    assert.deepEqual(copy?.read_from, ["/home/node/.openclaw/openclaw.json"]);
    assert.equal(copy?.note, `Every command asks. One nobody answers is a no. ${HOME_NOTE}`);
    assert.equal(HOME_NOTE, "The Main agent keeps its own mode in Home, your own conversation on every channel.");
    assert.equal(copy?.modes?.base, "default");
    assert.equal(copy?.modes?.running, "default");
    assert.deepEqual(copy?.modes?.offers.map((offer) => offer.id), ["default", "read-only", "guarded", "workspace", "full"]);
    assert.equal(copy?.everything, undefined);
  });

  it("in another mode, says what that mode lets through, and in Full access that nothing asks", () => {
    const approvals = { path: "/home/node/.openclaw/exec-approvals.json", file: { version: 1, agents: { main: { allowlist: [{ pattern: "/usr/bin/git" }] } } } };
    const readOnly = modedOwnRules({ config: RIG, approvals }, "read-only");
    assert.equal(readOnly?.mode, "Read only");
    assert.equal(readOnly?.modes?.running, "read-only");
    assert.deepEqual(readOnly?.runs, []);
    assert.deepEqual(readOnly?.refuses?.map((entry) => entry.kind), ["write", "command"]);
    assert.equal(readOnly?.note, `Reads its folder. Changes nothing and runs no commands. ${HOME_NOTE}`);
    const guarded = modedOwnRules({ config: RIG, approvals }, "guarded");
    assert.deepEqual(guarded?.runs.map((entry) => entry.words ?? entry.kind), ["write", ["git"]]);
    assert.deepEqual(guarded?.read_from, ["the mode Chips puts its OpenClaw sessions in", "/home/node/.openclaw/exec-approvals.json"]);
    const full = modedOwnRules({ config: RIG }, "full");
    assert.equal(full?.mode, "Full access");
    assert.equal(full?.everything, true);
    assert.deepEqual(full?.runs, []);
  });

  it("sends nothing where the gateway said nothing of its settings", () => {
    assert.equal(modedOwnRules({}, null), undefined);
  });
});

let asked: [string, Record<string, unknown>][] = [];
let refuse: ((method: string, params: Record<string, unknown>) => Error | undefined) | undefined;
let rows: Record<string, unknown>[] = [];
let picked: { id: string; until?: string } | undefined;
let sent: OwnRules[] = [];
let logged: string[] = [];

const claw: ClawPort = {
  request: async <T>(method: string, params: Record<string, unknown>) => {
    asked.push([method, params]);
    const refused = refuse?.(method, params);
    if (refused !== undefined) throw refused;
    if (method === "sessions.list") return { sessions: rows } as T;
    if (method === "config.get") return { config: RIG, path: "/home/node/.openclaw/openclaw.json" } as T;
    return {} as T;
  },
};

const chips = {
  get mode() {
    return picked;
  },
  putOwnRules: async (copy: OwnRules) => {
    sent.push(copy);
    return true;
  },
};

let modes: Modes;

beforeEach(() => {
  asked = [];
  refuse = undefined;
  rows = [];
  picked = undefined;
  sent = [];
  logged = [];
  modes = new Modes(claw, chips, (line) => logged.push(line));
});

const patches = () => asked.filter(([method]) => method === "sessions.patch").map(([, params]) => params);

describe("each session in the mode in force", () => {
  it("opens a session in the pick while it holds, and in none otherwise", () => {
    assert.deepEqual(modes.opening(), {});
    picked = { id: "full", until: "2026-11-19T18:41:00.000Z" };
    assert.deepEqual(modes.opening(), { permissionMode: "full" });
    picked = { id: "default" };
    assert.deepEqual(modes.opening(), {});
  });

  it("patches a session only where it is in another mode, and Default as none", async () => {
    modes.opened(ROOM_SESSION, { ok: true, key: ROOM_SESSION }, null);
    assert.equal(await modes.put(ROOM_SESSION), "same");
    picked = { id: "guarded" };
    assert.equal(await modes.put(ROOM_SESSION), "moved");
    assert.equal(await modes.put(ROOM_SESSION), "same");
    picked = undefined;
    assert.equal(await modes.put(ROOM_SESSION), "moved");
    assert.deepEqual(patches(), [
      { key: ROOM_SESSION, permissionMode: "guarded" },
      { key: ROOM_SESSION, permissionMode: null },
    ]);
  });

  it("takes the mode a session OpenClaw had already is in from its answer, and one it never said as one to set", async () => {
    picked = { id: "workspace" };
    modes.opened(ROOM_SESSION, { ok: true, key: ROOM_SESSION, entry: { permissionMode: "full" } }, "workspace");
    assert.equal(await modes.put(ROOM_SESSION), "moved");
    assert.equal(await modes.put(OTHER_SESSION), "set");
    assert.deepEqual(patches().map((each) => each["key"]), [ROOM_SESSION, OTHER_SESSION]);
  });

  it("lists its own sessions OpenClaw keeps at start, each in the mode it says, and leaves the rest", async () => {
    rows = [
      { key: ROOM_SESSION, kind: "direct", permissionMode: "full" },
      { key: OTHER_SESSION, kind: "direct" },
      { key: "agent:main:main", kind: "direct", permissionMode: "guarded" },
    ];
    await modes.readSessions((key) => key !== "agent:main:main");
    assert.deepEqual(modes.known(), [ROOM_SESSION, OTHER_SESSION]);
    // Back as its settings say: the one a pick left in Full access goes back, the other is in it.
    assert.equal(await modes.put(ROOM_SESSION), "moved");
    assert.equal(await modes.put(OTHER_SESSION), "same");
    assert.deepEqual(patches(), [{ key: ROOM_SESSION, permissionMode: null }]);
  });

  it("goes on without the list when OpenClaw won't give it, and says so", async () => {
    refuse = (method) => (method === "sessions.list" ? new Error("sessions.list refused") : undefined);
    await modes.readSessions(() => true);
    assert.deepEqual(modes.known(), []);
    assert.match(logged.join("\n"), /its sessions not listed, so each goes into its mode as it is next used: Error: sessions.list refused/);
  });

  it("keeps the mode of a session whose run refuses the change, logs why once, and says it runs in it", async () => {
    modes.opened(ROOM_SESSION, {}, null);
    modes.opened(OTHER_SESSION, {}, null);
    picked = { id: "full" };
    refuse = (method, params) =>
      method === "sessions.patch" && params["key"] === OTHER_SESSION ? new Error("active CLI-backed run does not support live permission changes") : undefined;
    assert.equal(await modes.put(ROOM_SESSION), "moved");
    assert.equal(await modes.put(OTHER_SESSION), "kept");
    assert.equal(await modes.put(OTHER_SESSION), "kept");
    assert.equal(modes.keeps(OTHER_SESSION), true);
    assert.equal(modes.running(), null);
    assert.deepEqual(logged, [
      `openclaw: ${OTHER_SESSION} keeps Default, not Full access: Error: active CLI-backed run does not support live permission changes`,
    ]);
    // Its run ended, it takes the change, and its sessions all run in the pick.
    refuse = undefined;
    assert.equal(await modes.put(OTHER_SESSION), "moved");
    assert.equal(modes.keeps(OTHER_SESSION), false);
    assert.equal(modes.running(), "full");
  });

  it("says a pick that isn't one of OpenClaw's once, and runs as its settings say", () => {
    picked = { id: "bypassPermissions" };
    assert.equal(modes.inForce(), null);
    assert.equal(modes.inForce(), null);
    assert.deepEqual(logged, ["openclaw: the mode picked in Chips, bypassPermissions, isn't one of OpenClaw's, so its sessions run as its settings say"]);
  });

  it("forgets a deleted agent's sessions", async () => {
    modes.opened(ROOM_SESSION, {}, null);
    modes.opened(OTHER_SESSION, {}, null);
    modes.forgetAgent("chips-01k4zqpx000000000000000002");
    assert.deepEqual(modes.known(), [OTHER_SESSION]);
  });

  it("sends the copy for the mode its sessions run in, once its settings are read", async () => {
    await modes.send();
    assert.equal(sent.length, 0);
    await modes.readPolicy();
    picked = { id: "read-only" };
    await modes.send();
    assert.equal(sent[0]?.mode, "Read only");
    assert.equal(sent[0]?.modes?.running, "read-only");
  });
});
