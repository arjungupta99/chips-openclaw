/**
 * The mapping, one row of the plan's table at a time, between two stand-ins that record what they
 * are asked. No OpenClaw and no Chips needed.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  Bridge,
  type ChipsPort,
  commandAsk,
  type ClawPort,
  type FilesPort,
  heardIn,
  spentIn,
  textOf,
  titleFrom,
  usageOf,
  withSpend,
  wordsOf,
} from "../src/bridge.ts";
import { type ChipsAgent, type ChipsEvent, ChipsRefusal, type Taken } from "../src/chips.ts";
import { SENDING_FILES } from "../src/room-files.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Automations, SPEAKING_LATER } from "../src/automations.ts";

/**
 * A turn's words as a room sends them: behind how a file reaches the room (Chips AW-19) and how to
 * speak in it later (Chips ADR 0157), and Chips's note ahead of those.
 */
const told = (words: string, note?: string): string =>
  [note, SENDING_FILES, SPEAKING_LATER, words].filter((part) => part !== undefined).join("\n\n");

const ME = "hrn_01K4ZQPX000000000000000004";
const ROOM = "spc_01K4ZQPX000000000000000002";
/** The room a harness's Main agent is in, which takes no other (Chips ADR 0087, rule 7). */
const MAIN_ROOM = "spc_01K4ZQPX0000000000000000M1";
const ARJUN = { participant_id: "usr_01K4ZQPX000000000000000003", kind: "person", display_name: "Arjun", role: "owner" };
/** Arjun as a line of the room names him. */
const ARJUN_FROM = { id: ARJUN.participant_id, name: "Arjun" };

let sent: ChipsEvent[] = [];
let claims: [string, string, string | undefined][] = [];
let calls: [string, Record<string, unknown>][] = [];
/** This harness's agents as Chips keeps them, one room each (ADR 0087), and what attaching did. */
let agents: ChipsAgent[] = [];
let attached: [string, string, string][] = [];
/** What the bridge registered with Chips, as it was sent, and the keys it opened rooms by. */
let registered: Record<string, unknown>[] = [];
let opened: string[] = [];
/** The rooms the bridge named this harness's home, as it named them. */
let homes: ChipsEvent[] = [];
/** A room's lines as Chips's pull route reads them (ADR 0088), and what the bridge asked of it. */
let roomLines: Record<string, unknown>[] = [];
let pulls: [string, number, number][] = [];
/** The files uploaded, by name and bytes; one called `big.mov` is refused, as an oversized one is. */
let uploads: [string, string][] = [];
/** What Chips answers each `message.post` with: held from the agents it named, or nothing to say. */
let holdPosts: Taken | undefined;
/** What Chips refuses a `message.post` with, if anything; and the signed URLs the bridge fetched. */
let refusePost: ((event: ChipsEvent) => ChipsRefusal | undefined) | undefined;
let fetched: string[] = [];
/** A session's history as OpenClaw's `chat.history` answers it, or a failure to read it. */
let history: unknown[] | Error = [];
/**
 * The gateway methods OpenClaw refuses, and the agents its `agents.list` names: an agent
 * `agents.create` makes is listed after `listLag` more lists, as the gateway takes it in a moment
 * after it answers.
 */
let refuseClaw = new Set<string>();
let clawAgents: { id: string; name?: string }[] = [];
let listLag = 0;
let bridge: Bridge;

/** One of our agents as Chips lists it, in one room or in none. */
function agentIn(agentId: string, key: string, room: string | null, name = "OpenClaw"): ChipsAgent {
  return { agent_id: agentId, key, name, lead: false, state: "active", spaces: room === null ? [] : [room], room };
}

const chips: ChipsPort = {
  forget: () => undefined,
  send: async (event) => {
    // A room named the harness's home, kept apart from what is said in rooms (Chips ADR 0069).
    if (event.type === "space.updated" && event["home"] === true) {
      homes.push(event);
      return undefined;
    }
    const refusal = event.type === "message.post" ? refusePost?.(event) : undefined;
    if (refusal !== undefined) throw refusal;
    sent.push(event);
    return event.type === "message.post" ? holdPosts : undefined;
  },
  // As Chips does since one room per agent: the claim key's own agent takes the harness's place.
  claim: async (spaceId, key, title) => {
    claims.push([spaceId, key, title]);
    agents = [...agents.filter((each) => each.key !== key), agentIn(`agt_${key}`, key, spaceId)];
  },
  fetchAttachment: async (url) => {
    fetched.push(url);
    return Buffer.from("png-bytes");
  },
  upload: async (filename, bytes) => {
    if (filename === "big.mov") throw new ChipsRefusal(413, "too_large", "The file is larger than this workspace takes.");
    uploads.push([filename, bytes.toString()]);
    return `att_01K4ZQPX00000000000000000${uploads.length}`;
  },
  agents: async () => agents.map((each) => ({ ...each, spaces: [...each.spaces] })),
  registerAgent: async (wanted) => {
    registered.push({ ...wanted });
    const { key, name } = wanted;
    const had = agents.find((each) => each.key === key);
    // As Chips answers a new agent registered for the room it was asked for (ADR 0108): put in it.
    const room = wanted.made_for !== undefined ? (wanted.space_id ?? null) : (had?.room ?? null);
    const agent: ChipsAgent =
      had === undefined
        ? { ...agentIn(`agt_${key}`, key, room, name), lead: wanted.lead === true }
        : { ...had, name, ...(wanted.lead === true ? { lead: true } : {}) };
    agents = [...agents.filter((each) => each.key !== key), agent];
    return { ...agent, ...(wanted.made_for === undefined ? {} : { attached: had === undefined }) };
  },
  // As Chips does for a room a harness opens by its key: the key's own agent is put in it.
  openSpace: async (key) => {
    opened.push(key);
    agents = agents.map((each) => (each.key === key ? { ...each, spaces: [MAIN_ROOM], room: MAIN_ROOM } : each));
    return MAIN_ROOM;
  },
  attach: async (agentId, spaceId, replacing) => {
    attached.push([agentId, spaceId, replacing]);
    agents = agents.map((each) =>
      each.agent_id === agentId
        ? { ...each, spaces: [spaceId], room: spaceId }
        : each.agent_id === replacing
          ? { ...each, spaces: [], room: null }
          : each,
    );
    return true;
  },
  roomContext: async (spaceId, before, limit) => {
    pulls.push([spaceId, before, limit]);
    const lines = roomLines.filter((line) => Number(line["seq"]) < before).slice(-limit);
    return { lines, since_seq: 0, truncated: false, before: Number(lines[0]?.["seq"] ?? before) };
  },
};
let pending: { agent: { id: string }; lists: number } | undefined;
function setLater(agent: { id: string }): void {
  pending = { agent, lists: listLag };
}

const claw: ClawPort = {
  request: async <T>(method: string, params: Record<string, unknown>) => {
    calls.push([method, params]);
    if (refuseClaw.has(method)) throw new Error(`${method} refused`);
    if (method === "agents.update") {
      const named = clawAgents.find((each) => each.id === params["agentId"]);
      if (named !== undefined) named.name = String(params["name"]);
    }
    if (method === "agents.create") {
      const made = { id: String(params["name"]) };
      if (listLag === 0) clawAgents.push(made);
      else setLater(made);
    }
    if (method === "agents.list") {
      if (pending !== undefined && --pending.lists <= 0) {
        clawAgents.push(pending.agent);
        pending = undefined;
      }
      return { agents: clawAgents } as T;
    }
    if (method === "chat.history") {
      if (history instanceof Error) throw history;
      return { sessionKey: params["sessionKey"], messages: history } as T;
    }
    return {} as T;
  },
};

beforeEach(() => {
  sent = [];
  claims = [];
  calls = [];
  agents = [];
  attached = [];
  registered = [];
  opened = [];
  homes = [];
  roomLines = [];
  pulls = [];
  uploads = [];
  holdPosts = undefined;
  refusePost = undefined;
  fetched = [];
  history = [];
  refuseClaw = new Set();
  clawAgents = [];
  listLag = 0;
  pending = undefined;
  bridge = new Bridge(chips, claw, { harnessId: ME, agent: "main" }, () => undefined);
});

function said(text: string, extra: Record<string, unknown> = {}): ChipsEvent {
  return { type: "message.new", space_id: ROOM, message_id: "msg_01K4ZQPX0000000000000000A1", from: ARJUN, text, ...extra };
}

const key = (): string => bridge.keyFor(ROOM);

describe("rooms and sessions", () => {
  it("names a room's session from the room, and finds the room again from it", () => {
    assert.equal(key(), "agent:main:chips-spc_01k4zqpx000000000000000002");
    assert.equal(bridge.spaceFor(key()), ROOM);
    assert.equal(bridge.spaceFor("agent:main:main"), undefined);
    // A claim's key is the room's session of the OpenClaw agent made for it, and so is a new agent's.
    assert.equal(bridge.claimKeyFor(ROOM), "agent:chips-01k4zqpx000000000000000002:chips-spc_01k4zqpx000000000000000002");
    assert.equal(bridge.spaceFor(bridge.claimKeyFor(ROOM)), ROOM);
    assert.equal(bridge.agentFor(bridge.claimKeyFor(ROOM)), "chips-01k4zqpx000000000000000002");
    assert.equal(
      bridge.madeKeyFor(ROOM, "evt_01K4ZQPX0000000000000000N1"),
      "agent:chips-01k4zqpx0000000000000000n1:chips-spc_01k4zqpx000000000000000002",
    );
    for (const whose of ["own", "default"]) assert.equal(bridge.spaceFor(`${key()}:${whose}`), ROOM);
    // A claim or a new agent on the primary agent, from before each had an agent of its own, is
    // not one of ours any more (no backward support, 7 October 2026).
    for (const whose of ["asked", "made-01k4zqpx0000000000000000n1", "somebody"]) {
      assert.equal(bridge.spaceFor(`${key()}:${whose}`), undefined);
    }
  });

  it("sends a person's words to the room's session, made once, keyed by the message", async () => {
    await bridge.onChips(said("What can you do?"));
    await bridge.onChips(said("And briefly?", { message_id: "msg_01K4ZQPX0000000000000000A2" }));
    assert.deepEqual(calls.map(([method]) => method), ["sessions.create", "chat.send", "chat.send"]);
    assert.equal(calls[0]?.[1]["key"], key());
    assert.deepEqual(calls[1]?.[1], { sessionKey: key(), message: told("What can you do?"), idempotencyKey: "msg_01K4ZQPX0000000000000000A1", queueMode: "steer" });
  });

  it("claims a room asked of it from the +, named from the first words, before answering", async () => {
    await bridge.onChips({ type: "space.created", space_id: ROOM, asked_of: ME, kind: "direct" });
    await bridge.onChips(said("Plan a weekend in Big Sur with two hikes and a good dinner spot"));
    assert.deepEqual(claims, [[ROOM, bridge.claimKeyFor(ROOM), "Plan a weekend in Big Sur with two hikes and a…"]]);
    await bridge.onChips(said("Make it three hikes", { message_id: "msg_01K4ZQPX0000000000000000A3" }));
    assert.equal(claims.length, 1);
  });

  it("from a Chips that does not say who a message is for, hears another harness only when named", async () => {
    const other = { participant_id: "hrn_01K4ZQPX000000000000000009", kind: "harness", display_name: "J", role: "member" };
    await bridge.onChips(said("I will take this one", { from: other }));
    assert.equal(calls.length, 0);
    await bridge.onChips(said("@OpenClaw your turn", { from: other, mentions: [ME] }));
    assert.deepEqual(calls.map(([method]) => method), ["sessions.create", "chat.send"]);
  });

  it("takes a harness's message Chips says is for it, says whose it is, and answers with no to (ADR 0081)", async () => {
    const other = { participant_id: "hrn_01K4ZQPX000000000000000009", kind: "harness", display_name: "J Bot", role: "member" };
    await bridge.onChips(said("Is main green?", { from: other, addressed_to: [ME] }));
    assert.deepEqual(calls.map(([method]) => method), ["sessions.create", "chat.send"]);
    assert.equal(
      calls[1]?.[1]["message"],
      told("J Bot (an agent in this room) said this to you. Everyone here reads your answer; J Bot acts on it only if you address it as @JBot:\nIs main green?"),
    );
    const r1 = "msg_01K4ZQPX0000000000000000A1";
    bridge.onClaw({
      event: "chat",
      payload: { runId: r1, sessionKey: key(), seq: 1, state: "final", message: { role: "assistant", content: "Yes." } },
    });
    await bridge.settled();
    // Sent back by itself, an answer kept two agents trading thanks until Chips's guard stopped
    // them (the live test); the words' @ decides.
    const reply = sent.find((event) => event.type === "message.post");
    assert.equal(reply?.["text"], "Yes.");
    assert.equal(reply?.["to"], undefined);
  });

  it("answers a person with no to", async () => {
    await bridge.onChips(said("Hi", { addressed_to: [ME] }));
    bridge.onClaw({
      event: "chat",
      payload: { runId: "msg_01K4ZQPX0000000000000000A1", sessionKey: key(), seq: 1, state: "final", message: { role: "assistant", content: "Hello." } },
    });
    await bridge.settled();
    assert.equal(sent.find((event) => event.type === "message.post")?.["to"], undefined);
  });

  it("takes no turn on what it overheard, and keeps none of it (ADR 0081, ADR 0088)", async () => {
    const other = { participant_id: "hrn_01K4ZQPX000000000000000009", kind: "harness", display_name: "Jacobian", role: "member" };
    await bridge.onChips({ ...said("@Jacobian draft the notes"), type: "message.overheard" });
    await bridge.onChips({ ...said("On it.", { from: other }), type: "message.overheard" });
    assert.equal(calls.length, 0);
    await bridge.onChips(said("@OpenClaw and the build?", { message_id: "msg_01K4ZQPX0000000000000000A2" }));
    assert.equal(calls.find(([method]) => method === "chat.send")?.[1]["message"], told("@OpenClaw and the build?"));
  });

  it("puts what Chips handed over ahead of the turn (Chips ADR 0088)", async () => {
    await bridge.onChips(
      said("@OpenClaw what did Jacobian say?", {
        message_id: "msg_01K4ZQPX0000000000000000A2",
        addressed_to: [ME],
        context: {
          lines: [
            { seq: 10, kind: "said", from: { id: ARJUN.participant_id, kind: "person", name: "Arjun" }, text: "@Jacobian the notes?", addressed_to: ["hrn_01K4ZQPX000000000000000009"] },
            { seq: 11, kind: "said", from: { id: "hrn_01K4ZQPX000000000000000009", kind: "harness", name: "Jacobian" }, text: "Drafted,\nin the doc.", addressed_to: [] },
            { seq: 12, kind: "said", from: { id: ARJUN.participant_id, kind: "person", name: "Arjun" }, text: "@OpenClaw first question", addressed_to: [ME] },
            { seq: 13, kind: "joined", from: { id: "usr_01K4ZQPX000000000000000008", kind: "person", name: "Dana" } },
          ],
          since_seq: 9,
          truncated: false,
          before: 10,
        },
      }),
    );
    const send = calls.find(([method]) => method === "chat.send")?.[1];
    assert.equal(
      send?.["message"],
      told("Said in this room since you last spoke:\nArjun: @Jacobian the notes?\nJacobian: Drafted, in the doc.\n(Dana joined the room)\n\n@OpenClaw what did Jacobian say?"),
    );
    // A turn Chips hands nothing with is told nothing, whatever was overheard before it.
    await bridge.onChips({ ...said("an overheard line"), type: "message.overheard" });
    await bridge.onChips(said("Thanks", { message_id: "msg_01K4ZQPX0000000000000000A3" }));
    assert.equal(calls.filter(([method]) => method === "chat.send").at(-1)?.[1]["message"], told("Thanks"));
  });

  it("reads Chips's context as lines, and nothing when it hands none over", () => {
    const own = (id: string): boolean => id === ME;
    assert.deepEqual(heardIn(undefined, own), []);
    assert.deepEqual(heardIn({ lines: [] }, own), []);
    assert.deepEqual(
      heardIn(
        {
          lines: [
            { kind: "said", from: { name: "Dana" }, text: "", transcript: "Book it.", addressed_to: [] },
            { kind: "said", from: { name: "Dana" }, text: "", files: ["map.png"], addressed_to: [] },
            { kind: "said", from: { name: "Arjun" }, text: "From before Chips said who" },
            { kind: "renamed", from: { name: "Arjun" }, title: "Kyoto" },
            { kind: "renamed", from: { name: "Dana K" }, name: "Dana K", previous: "Dana" },
            { kind: "archived", from: { name: "Arjun" } },
            { kind: "unarchived", from: { name: "Arjun" } },
            { kind: "left", from: { name: "Dana K" } },
          ],
        },
        own,
      ),
      [
        "Dana: Book it.",
        "Dana: (sent map.png)",
        '(Arjun renamed the room "Kyoto")',
        "(Dana is now called Dana K)",
        "(Arjun archived the room)",
        "(Arjun unarchived the room)",
        "(Dana K left the room)",
      ],
    );
  });

  it("sends a person's photo inline, as base64", async () => {
    await bridge.onChips(
      said("What is this?", { attachments: [{ url: "https://chips/a", mime_type: "image/png", filename: "cat.png" }] }),
    );
    const send = calls.find(([method]) => method === "chat.send")?.[1];
    assert.deepEqual(send?.["attachments"], [
      { type: "image", mimeType: "image/png", fileName: "cat.png", content: Buffer.from("png-bytes").toString("base64"), sizeBytes: 9 },
    ]);
  });

  it("sends an SVG as text the model reads, not as a picture it cannot open", async () => {
    // Live, 3 Oct 2026: sent as a `file` but typed `image/svg+xml`, OpenClaw still took it for a
    // picture, and OC1 and OC2 each asked the room to send it again.
    await bridge.onChips(
      said("A mock", { attachments: [{ url: "https://chips/a", mime_type: "image/svg+xml", filename: "preview.svg" }] }),
    );
    const send = calls.find(([method]) => method === "chat.send")?.[1];
    assert.deepEqual(send?.["attachments"], [
      { type: "file", mimeType: "text/plain", fileName: "preview.svg", content: Buffer.from("png-bytes").toString("base64"), sizeBytes: 9 },
    ]);
  });
});

describe("a turn as a run", () => {
  it("starts on the turn's first event, answers, reports usage, and completes, in order", async () => {
    await bridge.onChips(said("What can you do?"));
    // OpenClaw names the turn a message starts after the message's id, the chat.send key.
    const r1 = "msg_01K4ZQPX0000000000000000A1";
    bridge.onClaw({ event: "chat", payload: { runId: r1, sessionKey: key(), seq: 1, state: "status", phase: "starting_model" } });
    bridge.onClaw({
      event: "chat",
      payload: {
        runId: r1,
        sessionKey: key(),
        seq: 2,
        state: "final",
        message: { role: "assistant", content: [{ type: "text", text: "Quite a lot." }] },
        usage: { input: 1200, output: 40, model: "gpt-5.5" },
      },
    });
    await bridge.settled();
    assert.deepEqual(sent.map((event) => event.type), ["run.started", "message.post", "usage", "run.completed"]);
    const run = sent[0]?.["run_id"];
    assert.match(String(run), /^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    assert.equal(sent[0]?.["goal"], "What can you do?");
    // The goal is the message, already in the room: Chips does not say it twice (its goal_from).
    assert.equal(sent[0]?.["goal_from"], "chips");
    assert.equal(sent[0]?.["space_id"], ROOM);
    assert.deepEqual(sent[2], {
      type: "usage",
      run_id: run,
      scope: "run",
      model: "gpt-5.5",
      input_tokens: 1200,
      output_tokens: 40,
      idempotency_key: `openclaw-run:${r1}:usage`,
    });
    assert.ok(sent.every((event) => event["run_id"] === run));
  });

  it("names a follow-up turn OpenClaw starts on its own after the room's latest words", async () => {
    await bridge.onChips(said("Name a snack."));
    bridge.onClaw({ event: "chat", payload: { runId: "0c5f-follow-up", sessionKey: key(), seq: 1, state: "status" } });
    bridge.onClaw({ event: "chat", payload: { runId: "0c5f-follow-up", sessionKey: key(), seq: 2, state: "final", message: "" } });
    await bridge.settled();
    assert.equal(sent[0]?.["goal"], "Following up: Name a snack.");
    assert.equal(sent[0]?.["goal_from"], undefined);
    assert.equal(sent.at(-1)?.["summary"], "Ended without a reply.");
  });

  it("says a message's turn that ends empty had its words answered with others, in one reply", async () => {
    // Live, 3 Oct 2026: O2's words reached O1 while O1 answered the brief; OpenClaw took them into
    // that turn, and the turn for O2's message ended empty 8 ms after it began.
    await bridge.onChips(said("@O1 can add D–F"));
    const r1 = "msg_01K4ZQPX0000000000000000A1";
    bridge.onClaw({ event: "chat", payload: { runId: r1, sessionKey: key(), seq: 1, state: "status" } });
    bridge.onClaw({ event: "chat", payload: { runId: r1, sessionKey: key(), seq: 2, state: "final", message: "" } });
    await bridge.settled();
    assert.equal(sent[0]?.["goal_from"], "chips");
    assert.equal(sent.at(-1)?.["summary"], "Answered together with other words, in one reply.");
  });

  it("says NO_REPLY for a turn that answered it, which OpenClaw leaves out of its chat (Chips ADR 0105)", async () => {
    // Chips makes the post the turn's pass, which the room never shows.
    await bridge.onChips(said("@O2 then @O1 for P–T, once O2 is done"));
    const r1 = "msg_01K4ZQPX0000000000000000A1";
    const stream = { runId: r1, sessionKey: key(), stream: "assistant" };
    bridge.onClaw({ event: "agent", payload: { ...stream, seq: 1, data: { text: "Waiting", phase: "commentary" } } });
    bridge.onClaw({ event: "agent", payload: { ...stream, seq: 2, data: { text: "NO_REPLY", phase: "final_answer" } } });
    bridge.onClaw({ event: "chat", payload: { runId: r1, sessionKey: key(), seq: 3, state: "final", message: "" } });
    await bridge.settled();
    assert.deepEqual(sent.map((event) => event["type"]), ["run.started", "message.post", "run.completed"]);
    assert.equal(sent[1]?.["text"], "NO_REPLY");
    assert.equal(sent.at(-1)?.["summary"], "NO_REPLY");
  });

  it("starts no run for a message's turn whose only word is an empty end: OpenClaw answered it in another turn", async () => {
    // Live, 3 Oct 2026: four of these in the ASCII Art room, each a line of its own in the room.
    await bridge.onChips(said("@O1 can add D–F"));
    const r1 = "msg_01K4ZQPX0000000000000000A1";
    bridge.onClaw({ event: "chat", payload: { runId: r1, sessionKey: key(), seq: 1, state: "final" } });
    await bridge.settled();
    assert.deepEqual(sent, []);
    // A later turn of the room still starts as any does.
    bridge.onClaw({ event: "chat", payload: { runId: "r2", sessionKey: key(), seq: 1, state: "status" } });
    await bridge.settled();
    assert.deepEqual(sent.map((event) => event["type"]), ["run.started"]);
  });

  it("names the same run after a restart, so Chips takes the retry as a duplicate", async () => {
    bridge.onClaw({ event: "chat", payload: { runId: "r1", sessionKey: key(), seq: 1, state: "status" } });
    const again = new Bridge(chips, claw, { harnessId: ME, agent: "main" }, () => undefined);
    again.onClaw({ event: "chat", payload: { runId: "r1", sessionKey: key(), seq: 1, state: "status" } });
    await Promise.all([bridge.settled(), again.settled()]);
    assert.equal(sent[0]?.["run_id"], sent[1]?.["run_id"]);
    assert.equal(sent[0]?.["idempotency_key"], sent[1]?.["idempotency_key"]);
  });

  it("drops an event for a session that is not one of its rooms", async () => {
    bridge.onClaw({ event: "chat", payload: { runId: "r9", sessionKey: "agent:main:main", seq: 1, state: "final", message: "hi" } });
    await bridge.settled();
    assert.deepEqual(sent, []);
  });

  it("holds a tool's events until the turn's room is known, then logs them as steps", async () => {
    bridge.onClaw({ event: "agent", payload: { runId: "r2", seq: 1, stream: "tool", ts: 1, data: { phase: "start", name: "exec", toolCallId: "call_1" } } });
    bridge.onClaw({ event: "chat", payload: { runId: "r2", sessionKey: key(), seq: 2, state: "status" } });
    bridge.onClaw({ event: "agent", payload: { runId: "r2", seq: 3, stream: "tool", ts: 2, data: { phase: "result", name: "exec", toolCallId: "call_1" } } });
    await bridge.settled();
    assert.deepEqual(
      sent.map((event) => [event.type, event["status"]]),
      [["run.started", undefined], ["step.log", "started"], ["step.log", "done"]],
    );
    assert.equal(sent[1]?.["step_id"], "call_1");
    assert.equal(sent[1]?.["tool"], "exec");
  });

  it("fails the run on an error, and on a stop", async () => {
    bridge.onClaw({ event: "chat", payload: { runId: "r3", sessionKey: key(), seq: 1, state: "error", errorMessage: "rate limited" } });
    bridge.onClaw({ event: "chat", payload: { runId: "r4", sessionKey: key(), seq: 1, state: "aborted" } });
    await bridge.settled();
    assert.deepEqual(
      sent.filter((event) => event.type === "run.failed").map((event) => event["error"]),
      ["rate limited", "Stopped."],
    );
  });

  it("stops OpenClaw's turn when the person stops the run", async () => {
    bridge.onClaw({ event: "chat", payload: { runId: "r5", sessionKey: key(), seq: 1, state: "status" } });
    await bridge.settled();
    await bridge.onChips({ type: "run.cancel", run_id: sent[0]?.["run_id"], by: ARJUN.participant_id });
    assert.deepEqual(calls, [["chat.abort", { sessionKey: key(), runId: "r5" }]]);
  });
});

describe("a reply that was not right (Chips ADR 0200)", () => {
  const OTHER_ROOM = "spc_01K4ZQPX000000000000000077";
  const SCOUT = { id: "agt_scout", kind: "agent", name: "Scout" };
  const REPLY = "msg_01K4ZQPX0000000000000000B1";
  const NOTE = "Missed what I asked. Sunday is our flight home.";
  const LAST =
    "Look at it again and answer properly in its place. If it is not clear what was wrong, ask them in one short line. Say plainly what you changed.";

  /** Feedback on a message, as Chips hands it to the harness whose message it is. */
  function feedback(extra: Record<string, unknown>): ChipsEvent {
    return { type: "feedback", id: "evt_01K4ZQPX0000000000000000F1", seq: 9, space_id: ROOM, message_id: REPLY, from: ARJUN, ...extra };
  }

  beforeEach(async () => {
    agents = [agentIn("agt_fallback", ME, OTHER_ROOM), agentIn("agt_main", "main", ROOM), agentIn("agt_scout", "scout", ROOM, "Scout")];
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }, { id: "scout", name: "Scout" }] });
    roomLines = [
      { seq: 4, kind: "said", from: ARJUN_FROM, message_id: "msg_01K4ZQPX0000000000000000A1", text: "Plan Sunday for us" },
      { seq: 6, kind: "said", from: SCOUT, message_id: REPLY, text: "Sunday: a hike at dawn,\nthen brunch." },
    ];
    calls = [];
  });

  it("asks the agent who said it for a second look, in its session in the room, and posts its answer as a run", async () => {
    await bridge.onChips(feedback({ kind: "correction", text: NOTE }));
    assert.deepEqual(calls.filter(([method]) => method === "chat.send"), [
      [
        "chat.send",
        {
          sessionKey: bridge.keyFor(ROOM, "scout"),
          message: [
            "Arjun says your reply in this room wasn't right.",
            "Your reply:\n«Sunday: a hike at dawn,\nthen brunch.»",
            `What wasn't right: «${NOTE}»`,
            LAST,
          ].join("\n\n"),
          // Keyed by the feedback, apart from the turn on any message.
          idempotencyKey: "feedback:evt_01K4ZQPX0000000000000000F1",
          queueMode: "steer",
        },
      ],
    ]);
    // Who said it is read from the room's lines before the feedback.
    assert.deepEqual(pulls, [[ROOM, 9, 200]]);
    const turn = { runId: "feedback:evt_01K4ZQPX0000000000000000F1", sessionKey: bridge.keyFor(ROOM, "scout") };
    bridge.onClaw({ event: "chat", payload: { ...turn, seq: 1, state: "status" } });
    bridge.onClaw({ event: "chat", payload: { ...turn, seq: 2, state: "final", message: "Brunch near the airport instead: I moved the plan to fit your flight." } });
    await bridge.settled();
    assert.deepEqual(sent.map((event) => event.type), ["run.started", "message.post", "run.completed"]);
    assert.equal(sent[0]?.["goal"], `Looking again: ${NOTE}`);
    // Its goal is no message in the room, so Chips says it.
    assert.equal(sent[0]?.["goal_from"], undefined);
    assert.equal(sent[0]?.["space_id"], ROOM);
    assert.equal(sent[1]?.["text"], "Brunch near the airport instead: I moved the plan to fit your flight.");
    for (const event of sent) assert.deepEqual(event["actor"], { kind: "agent", id: "agt_scout" });
  });

  it("asks nothing for a 👍, another reaction, an empty note, or feedback from an agent", async () => {
    await bridge.onChips(feedback({ kind: "reaction", reaction: "👍" }));
    await bridge.onChips(feedback({ id: "evt_01K4ZQPX0000000000000000F2", kind: "reaction", reaction: "🎉" }));
    await bridge.onChips(feedback({ id: "evt_01K4ZQPX0000000000000000F3", kind: "correction", text: "   " }));
    await bridge.onChips(feedback({ id: "evt_01K4ZQPX0000000000000000F4", kind: "correction", text: NOTE, from: { ...ARJUN, kind: "agent" } }));
    await bridge.settled();
    assert.deepEqual(calls, []);
    assert.deepEqual(sent, []);
  });

  it("asks for a second look on a bare 👎 from an older device, saying the person did not say what", async () => {
    await bridge.onChips(feedback({ kind: "reaction", reaction: "👎" }));
    const send = calls.find(([method]) => method === "chat.send")?.[1];
    assert.equal(
      send?.["message"],
      [
        "Arjun says your reply in this room wasn't right.",
        "Your reply:\n«Sunday: a hike at dawn,\nthen brunch.»",
        "They didn't say what. Read your reply again and find what was wrong.",
        LAST,
      ].join("\n\n"),
    );
    bridge.onClaw({ event: "chat", payload: { runId: send?.["idempotencyKey"], sessionKey: send?.["sessionKey"], seq: 1, state: "status" } });
    await bridge.settled();
    assert.equal(sent[0]?.["goal"], "Looking again at its reply");
  });

  it("answers the same feedback once, handed again or not", async () => {
    await bridge.onChips(feedback({ kind: "correction", text: NOTE }));
    await bridge.onChips(feedback({ kind: "correction", text: NOTE }));
    assert.equal(calls.filter(([method]) => method === "chat.send").length, 1);
  });

  it("gives a message the room's lines no longer have to the room's agent, with no reply to quote", async () => {
    await bridge.onChips(feedback({ kind: "correction", text: NOTE, message_id: "msg_01K4ZQPX0000000000000000Z9" }));
    const sends = calls.filter(([method]) => method === "chat.send").map(([, params]) => params);
    assert.equal(sends.length, 1);
    // As a message for nobody in particular is: whichever of ours Chips has in the room.
    assert.equal(sends[0]?.["sessionKey"], bridge.keyFor(ROOM, "main"));
    assert.equal(sends[0]?.["message"], ["Arjun says your reply in this room wasn't right.", `What wasn't right: «${NOTE}»`, LAST].join("\n\n"));
  });

  it("cuts a long note's goal at 120 characters and a long reply at 1500, each with an ellipsis", async () => {
    roomLines = [{ seq: 6, kind: "said", from: SCOUT, message_id: REPLY, text: "x".repeat(2_000) }];
    await bridge.onChips(feedback({ kind: "correction", text: `${"y".repeat(200)}\nand more` }));
    const send = calls.find(([method]) => method === "chat.send")?.[1];
    assert.ok(String(send?.["message"]).includes(`«${"x".repeat(1_499)}…»`));
    bridge.onClaw({ event: "chat", payload: { runId: send?.["idempotencyKey"], sessionKey: send?.["sessionKey"], seq: 1, state: "status" } });
    await bridge.settled();
    assert.equal(sent[0]?.["goal"], `Looking again: ${"y".repeat(104)}…`);
  });
});

describe("an answer's files", () => {
  const WORKSPACE = "/home/node/.openclaw/workspace";
  /** OpenClaw's files as the bridge reads them: a web address is a link, `missing.html` is not there. */
  const files: FilesPort = {
    read: async (reference) => {
      if (reference.startsWith("https://")) return { kind: "link", url: reference };
      const name = reference.split("/").at(-1) ?? reference;
      if (name === "missing.html") return { kind: "refused", name, why: "it is not there" };
      return { kind: "file", filename: name, bytes: Buffer.from(`bytes of ${name}`) };
    },
  };
  const R1 = "msg_01K4ZQPX0000000000000000A1";

  beforeEach(() => {
    bridge = new Bridge(chips, claw, { harnessId: ME, agent: "main" }, () => undefined, files);
  });

  /** The final answer's stream event names its files, and the final `chat` carries its words only. */
  function answers(text: string, mediaUrls: string[], R1 = "msg_01K4ZQPX0000000000000000A1"): void {
    bridge.onClaw({ event: "chat", payload: { runId: R1, sessionKey: key(), seq: 1, state: "status" } });
    const stream = { runId: R1, sessionKey: key(), stream: "assistant" };
    bridge.onClaw({ event: "agent", payload: { ...stream, seq: 2, data: { text, delta: text, phase: "final_answer" } } });
    bridge.onClaw({ event: "agent", payload: { ...stream, seq: 3, data: { text, delta: "", mediaUrls, phase: "final_answer" } } });
    bridge.onClaw({
      event: "chat",
      payload: {
        runId: R1,
        sessionKey: key(),
        seq: 4,
        state: "final",
        // As OpenClaw's own web chat answers a page it cannot draw (the live run, 1 October 2026).
        message: {
          role: "assistant",
          content: [
            { type: "text", text },
            { type: "attachment_error", attachment: { code: "unsupported-format", kind: "document", label: "x" } },
          ],
        },
      },
    });
  }

  it("posts the files an answer names with its words, as one message", async () => {
    await bridge.onChips(said("Add F–J"));
    answers("@Hello, added F–J. Updated HTML attached.", [`${WORKSPACE}/ascii-alphabet.html`]);
    await bridge.settled();
    assert.deepEqual(sent.map((event) => event.type), ["run.started", "message.post", "run.completed"]);
    assert.deepEqual(uploads, [["ascii-alphabet.html", "bytes of ascii-alphabet.html"]]);
    const post = sent[1];
    assert.equal(post?.["text"], "@Hello, added F–J. Updated HTML attached.");
    assert.deepEqual(post?.["upload_ids"], ["att_01K4ZQPX000000000000000001"]);
    assert.equal(post?.["idempotency_key"], `openclaw-run:${R1}:reply`);
    assert.equal(sent[2]?.["summary"], "@Hello, added F–J. Updated HTML attached.");
  });

  it("takes a MEDIA: line the gateway left in the words as a file the answer names", async () => {
    // A turn run by OpenClaw's Codex harness keeps its `MEDIA:` line in the words and reports no
    // `mediaUrls` (the Tic Tac Toe runs, 17 October 2026): the room got the path and no file.
    await bridge.onChips(said("Build a game"));
    answers(`Ready. Open the attached file.\n\nMEDIA:${WORKSPACE}/tic-tac-toe.html`, []);
    await bridge.settled();
    assert.deepEqual(uploads, [["tic-tac-toe.html", "bytes of tic-tac-toe.html"]]);
    const post = sent.find((event) => event.type === "message.post");
    assert.equal(post?.["text"], "Ready. Open the attached file.");
    assert.deepEqual(post?.["upload_ids"], ["att_01K4ZQPX000000000000000001"]);
  });

  it("sends a file the turn sent with OpenClaw's message tool once it went, and not one it refused", async () => {
    // OpenClaw's `message` tool sends to its own web chat, not the room (the Tic Tac Toe runs,
    // 17 October 2026, TT-6): its allowlist refused the page, and the zip sent after never came.
    await bridge.onChips(said("Build a game"));
    bridge.onClaw({ event: "chat", payload: { runId: R1, sessionKey: key(), seq: 1, state: "status" } });
    const committed = (message: Record<string, unknown>): void =>
      bridge.onClaw({ event: "session.message", payload: { sessionKey: key(), message } });
    const sends = (id: string, name: string, isError: boolean): void => {
      const args = { action: "send", media: `/home/node/.openclaw/chips/a/${name}`, filename: name, message: "Open it." };
      committed({ role: "assistant", content: [{ type: "toolCall", id, name: "message", arguments: args }] });
      committed({ role: "toolResult", toolCallId: id, toolName: "message", isError, content: [{ type: "text", text: "…" }] });
    };
    sends("exec-1", "tic-tac-toe.html", true);
    sends("exec-2", "tic-tac-toe.zip", false);
    answers("Sent as tic-tac-toe.zip.", []);
    await bridge.settled();
    assert.deepEqual(uploads, [["tic-tac-toe.zip", "bytes of tic-tac-toe.zip"]]);
    const post = sent.find((event) => event.type === "message.post");
    assert.equal(post?.["text"], "Sent as tic-tac-toe.zip.");
    assert.deepEqual(post?.["upload_ids"], ["att_01K4ZQPX000000000000000001"]);
  });

  it("leaves a line that only mentions MEDIA: in the words", async () => {
    await bridge.onChips(said("How do you send a file?"));
    answers("I put a line like MEDIA:<path> on its own.", []);
    await bridge.settled();
    assert.deepEqual(uploads, []);
    assert.equal(sent.find((event) => event.type === "message.post")?.["text"], "I put a line like MEDIA:<path> on its own.");
  });

  it("uploads a file named twice in the turn's stream once", async () => {
    await bridge.onChips(said("Draw a cat"));
    bridge.onClaw({ event: "agent", payload: { runId: R1, sessionKey: key(), stream: "assistant", seq: 1, data: { mediaUrls: ["cat.png"] } } });
    answers("Here.", ["cat.png", `${WORKSPACE}/dog.png`]);
    await bridge.settled();
    assert.deepEqual(uploads.map(([name]) => name), ["cat.png", "dog.png"]);
    assert.equal((sent.find((event) => event.type === "message.post")?.["upload_ids"] as unknown[]).length, 2);
  });

  it("says in the message what could not go, and gives a web address back to the words", async () => {
    await bridge.onChips(said("Send the lot"));
    answers("Three files.", [`${WORKSPACE}/missing.html`, "https://example.com/cat.png", `${WORKSPACE}/big.mov`]);
    await bridge.settled();
    const post = sent.find((event) => event.type === "message.post");
    assert.equal(
      post?.["text"],
      [
        "Three files.",
        "(missing.html was not attached: it is not there.)",
        "https://example.com/cat.png",
        "(big.mov was not attached: Chips refused it: The file is larger than this workspace takes.)",
      ].join("\n\n"),
    );
    assert.equal(post?.["upload_ids"], undefined);
    // The summary is the message as posted, so Chips still draws one card.
    assert.equal(sent.at(-1)?.["summary"], post?.["text"]);
  });

  it("posts a file sent with no words, and says what was sent in the run's summary", async () => {
    await bridge.onChips(said("Just the file"));
    answers("", [`${WORKSPACE}/ascii-alphabet.html`]);
    await bridge.settled();
    const post = sent.find((event) => event.type === "message.post");
    assert.equal(post?.["text"], "");
    assert.deepEqual(post?.["upload_ids"], ["att_01K4ZQPX000000000000000001"]);
    assert.equal(sent.at(-1)?.["summary"], "Sent ascii-alphabet.html.");
  });

  it("posts the words alone when the answer names no file", async () => {
    await bridge.onChips(said("Hi"));
    answers("Hello.", []);
    await bridge.settled();
    assert.equal(uploads.length, 0);
    assert.equal(sent.find((event) => event.type === "message.post")?.["upload_ids"], undefined);
  });

  describe("the room's files (Chips ADR 0099)", () => {
    const OC3 = { id: "agt_01K4ZQPX00000000000000OC3", kind: "agent", name: "Oc3" };
    /** A file of the room at its current version, as Chips lists it with a message. */
    function roomFile(name: string, version: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        name,
        version,
        attachment_id: `att_${name.replace(/\W/g, "").toUpperCase().padEnd(24, "0").slice(0, 24)}V${version}`,
        sha256: "a".repeat(64),
        byte_size: 2048,
        mime_type: "text/html",
        at: "2026-10-02T18:00:00.000Z",
        url: `https://chips/files/${name}/v${version}`,
        url_expires_at: "2026-10-02T18:10:00.000Z",
        ...extra,
      };
    }
    const GALLERY = roomFile("ascii-alphabet.html", 2, { by: OC3 });
    const listing = (files: unknown[], lines: unknown[] = []): Record<string, unknown> => ({
      context: { lines, since_seq: 0, truncated: false, before: 1, files },
    });
    const sends = (): Record<string, unknown>[] => calls.filter(([method]) => method === "chat.send").map(([, params]) => params);
    const inline = (fileName: string) => ({
      type: "file",
      mimeType: "text/html",
      fileName,
      content: Buffer.from("png-bytes").toString("base64"),
      sizeBytes: 9,
    });
    const HANDED = `Files in this room, attached at their current version: ascii-alphabet.html (v2, by Oc3). To change one, send it back under the same name: Chips takes it as the next version.\n${SENDING_FILES}\n\n${SPEAKING_LATER}`;

    it("tells a turn in a room with no files yet how a file of its own reaches the room (Chips AW-19)", async () => {
      // Terra Fab, 10 October 2026: both agents' first answers named a path in their own folder.
      await bridge.onChips(said("Write the supply-chain section into terra-fab-report.html"));
      assert.equal(sends()[0]?.["message"], told("Write the supply-chain section into terra-fab-report.html"));
      assert.match(SENDING_FILES, /only when you send it, on a line of its own: MEDIA:<path>/);
      assert.match(SENDING_FILES, /A path alone reaches nobody/);
      assert.equal(sends()[0]?.["attachments"], undefined);
    });

    it("hands a turn the room's files its words name, at their current version, and says so", async () => {
      await bridge.onChips(said("Add F–J to ascii-alphabet.html", listing([GALLERY, roomFile("notes.md", 1)])));
      assert.deepEqual(fetched, ["https://chips/files/ascii-alphabet.html/v2"]);
      assert.deepEqual(sends()[0]?.["attachments"], [inline("ascii-alphabet.html")]);
      assert.equal(sends()[0]?.["message"], `${HANDED}\n\nAdd F–J to ascii-alphabet.html`);
    });

    it("takes a file a line of the room sent as named, and hands a session each version once", async () => {
      const line = { seq: 10, kind: "said", from: OC3, text: "Started it", files: ["ascii-alphabet.html"], addressed_to: [] };
      await bridge.onChips(said("@OpenClaw carry on", listing([GALLERY], [line])));
      assert.equal(
        sends()[0]?.["message"],
        `${HANDED}\n\nSaid in this room since you last spoke:\nOc3: Started it (sent ascii-alphabet.html)\n\n@OpenClaw carry on`,
      );
      await bridge.onChips(said("Still on ascii-alphabet.html?", { message_id: "msg_01K4ZQPX0000000000000000A2", ...listing([GALLERY]) }));
      assert.equal(sends()[1]?.["message"], told("Still on ascii-alphabet.html?"));
      assert.equal(sends()[1]?.["attachments"], undefined);
      const v3 = roomFile("ascii-alphabet.html", 3, { by: OC3 });
      await bridge.onChips(said("And now ascii-alphabet.html?", { message_id: "msg_01K4ZQPX0000000000000000A3", ...listing([v3]) }));
      assert.deepEqual(fetched, ["https://chips/files/ascii-alphabet.html/v2", "https://chips/files/ascii-alphabet.html/v3"]);
    });

    it("hands five files at most, none over five MB, and says which it left out and why", async () => {
      const names = ["big.mov", "a1.txt", "a2.txt", "a3.txt", "a4.txt", "a5.txt", "a6.txt"];
      const files = names.map((name) => roomFile(name, 1, name === "big.mov" ? { byte_size: 6 * 1024 * 1024 } : {}));
      await bridge.onChips(said(`Look at ${names.join(", ")}`, listing(files)));
      assert.equal((sends()[0]?.["attachments"] as unknown[]).length, 5);
      assert.equal(
        sends()[0]?.["message"],
        [
          "Files in this room, attached at their current version: a1.txt (v1), a2.txt (v1), a3.txt (v1), a4.txt (v1), a5.txt (v1). To change one, send it back under the same name: Chips takes it as the next version.",
          "Not attached: big.mov (v1), since it is larger than 5 MB.",
          "Not attached: a6.txt (v1), since a turn is handed 5 files at most.",
          SENDING_FILES,
          "",
          SPEAKING_LATER,
          "",
          `Look at ${names.join(", ")}`,
        ].join("\n"),
      );
    });

    it("names a file by its whole name, not one with it inside", async () => {
      await bridge.onChips(said("See myascii-alphabet.html and ascii-alphabet.html5", listing([GALLERY])));
      assert.deepEqual(fetched, []);
      await bridge.onChips(said("See /tmp/ascii-alphabet.html.", { message_id: "msg_01K4ZQPX0000000000000000A2", ...listing([GALLERY]) }));
      assert.equal(fetched.length, 1);
    });

    it("sends back a file under a room file's name as its next version, naming the version it was made from", async () => {
      await bridge.onChips(said("Add F–J to ascii-alphabet.html", listing([GALLERY])));
      answers("Added F–J.", [`${WORKSPACE}/ascii-alphabet.html`, `${WORKSPACE}/notes.md`]);
      await bridge.settled();
      const first = sent.find((event) => event.type === "message.post");
      assert.deepEqual(first?.["upload_ids"], ["att_01K4ZQPX000000000000000001", "att_01K4ZQPX000000000000000002"]);
      // Only the room's file it was handed: notes.md is new to it.
      assert.deepEqual(first?.["replaces"], { att_01K4ZQPX000000000000000001: GALLERY["attachment_id"] });
      // Its next edit is made from what it posted, which Chips now lists as current: nothing to fetch.
      const R2 = "msg_01K4ZQPX0000000000000000A2";
      const v3 = roomFile("ascii-alphabet.html", 3, { attachment_id: "att_01K4ZQPX000000000000000001", by: { name: "OpenClaw" } });
      await bridge.onChips(said("Now K–O in ascii-alphabet.html", { message_id: R2, ...listing([v3]) }));
      assert.equal(fetched.length, 1);
      answers("Added K–O.", [`${WORKSPACE}/ascii-alphabet.html`], R2);
      await bridge.settled();
      const second = sent.filter((event) => event.type === "message.post")[1];
      assert.deepEqual(second?.["replaces"], { att_01K4ZQPX000000000000000003: "att_01K4ZQPX000000000000000001" });
    });

    it("takes a room file on the message as the session's, without fetching it again", async () => {
      const own = { attachment_id: GALLERY["attachment_id"], url: "https://chips/a", filename: "ascii-alphabet.html", mime_type: "text/html" };
      await bridge.onChips(said("Here is ascii-alphabet.html v2", { attachments: [own], ...listing([GALLERY]) }));
      assert.deepEqual(fetched, ["https://chips/a"]);
      // Told as a file handed by name is, so it goes back under the same name (Chips ADR 0101).
      assert.equal(sends()[0]?.["message"], `${HANDED}\n\nHere is ascii-alphabet.html v2`);
      answers("Took it further.", [`${WORKSPACE}/ascii-alphabet.html`]);
      await bridge.settled();
      assert.deepEqual(sent.find((event) => event.type === "message.post")?.["replaces"], {
        att_01K4ZQPX000000000000000001: GALLERY["attachment_id"],
      });
    });

    it("takes the same bytes posted again under the name as the version they are, and says so", async () => {
      // ASCII Art attaching v2 again for O2, who had not been handed it: a new attachment, the same version.
      const again = { attachment_id: "att_01K4ZQPX0000000000000AGAIN", url: "https://chips/again", filename: "ascii-alphabet.html", mime_type: "text/html", sha256: GALLERY["sha256"] };
      await bridge.onChips(said("@OpenClaw here it is", { attachments: [again], ...listing([GALLERY]) }));
      assert.deepEqual(fetched, ["https://chips/again"]);
      assert.equal(sends()[0]?.["message"], `${HANDED}\n\n@OpenClaw here it is`);
      answers("Added K–O.", [`${WORKSPACE}/ascii-alphabet.html`]);
      await bridge.settled();
      assert.deepEqual(sent.find((event) => event.type === "message.post")?.["replaces"], {
        att_01K4ZQPX000000000000000001: GALLERY["attachment_id"],
      });
    });

    it("says nothing of a photo on the message, which a phone sends with every other message", async () => {
      const shot = roomFile("image.png", 9, { mime_type: "image/png" });
      const own = { attachment_id: shot["attachment_id"], url: "https://chips/shot", filename: "image.png", mime_type: "image/png" };
      await bridge.onChips(said("What is this?", { attachments: [own], ...listing([shot]) }));
      assert.equal(sends()[0]?.["message"], told("What is this?"));
    });

    it("posts the words again without a file Chips refused as stale, and tells the session's next turn, which is handed the new one", async () => {
      const why = "ascii-alphabet.html is now v3, by Oc2. Fetch it and redo.";
      refusePost = (event) => (event["replaces"] === undefined ? undefined : new ChipsRefusal(409, "stale_file", why));
      await bridge.onChips(said("Add F–J to ascii-alphabet.html", listing([GALLERY])));
      answers("Added F–J.", [`${WORKSPACE}/ascii-alphabet.html`, `${WORKSPACE}/notes.md`]);
      await bridge.settled();
      const post = sent.find((event) => event.type === "message.post");
      assert.equal(post?.["text"], `Added F–J.\n\n(ascii-alphabet.html was not posted: ${why})`);
      assert.deepEqual(post?.["upload_ids"], ["att_01K4ZQPX000000000000000002"]);
      assert.equal(post?.["replaces"], undefined);
      assert.equal(sent.at(-1)?.["summary"], post?.["text"]);
      // Nothing went to OpenClaw on the refusal; its next turn in the room is told, and handed v3.
      assert.equal(sends().length, 1);
      const v3 = roomFile("ascii-alphabet.html", 3, { by: { name: "Oc2" } });
      await bridge.onChips(said("How is it going?", { message_id: "msg_01K4ZQPX0000000000000000A2", ...listing([v3]) }));
      assert.equal(
        sends()[1]?.["message"],
        [
          `Chips: Your last answer here sent a file Chips did not take as its next version: ${why}`,
          `Files in this room, attached at their current version: ascii-alphabet.html (v3, by Oc2). To change one, send it back under the same name: Chips takes it as the next version.\n${SENDING_FILES}`,
          SPEAKING_LATER,
          "How is it going?",
        ].join("\n\n"),
      );
      assert.equal(fetched.at(-1), "https://chips/files/ascii-alphabet.html/v3");
    });

    it("from a Chips that lists no files, hands a turn none and sends back nothing as a version", async () => {
      await bridge.onChips(said("Add F–J to ascii-alphabet.html"));
      answers("Added.", [`${WORKSPACE}/ascii-alphabet.html`]);
      await bridge.settled();
      assert.deepEqual(fetched, []);
      assert.equal(sent.find((event) => event.type === "message.post")?.["replaces"], undefined);
    });
  });
});

describe("supervision", () => {
  function asked(): void {
    bridge.onClaw({ event: "chat", payload: { runId: "r6", sessionKey: key(), seq: 1, state: "status" } });
    bridge.onClaw({
      event: "exec.approval.requested",
      payload: {
        id: "ap-1",
        expiresAtMs: Date.now() + 120_000,
        request: { command: "ls -la", sessionKey: key(), runId: "r6", systemRunPlan: { commandText: "ls -la", cwd: "/workspace" } },
      },
    });
  }

  it("asks for an exec approval as an approval card with the command", async () => {
    asked();
    await bridge.settled();
    const card = sent.find((event) => event.type === "approval.request");
    assert.match(String(card?.["approval_id"]), /^apr_/);
    assert.deepEqual(card?.["action"], { kind: "shell.exec", input: { command: "ls -la", cwd: "/workspace" } });
    // The card asks the question, where it runs, and that a yes is for this command (Chips ADR 0142).
    assert.equal(card?.["question"], "Run `ls -la`?");
    assert.equal(card?.["effect"], "It runs in /workspace.");
    assert.equal(card?.["lasts"], "once");
    assert.deepEqual(card?.["preview"], { format: "markdown", title: "Run a command", body: "```sh\nls -la\n```" });
    assert.equal(card?.["fallback"], "deny");
    assert.ok(Number(card?.["expires_in"]) > 100 && Number(card?.["expires_in"]) <= 120);
  });

  it("passes a yes for always back as allow-always, and says it was passed on", async () => {
    asked();
    await bridge.settled();
    const card = sent.find((event) => event.type === "approval.request");
    await bridge.onChips({ type: "approval.resolved", approval_id: card?.["approval_id"], run_id: card?.["run_id"], decision: "approved", scope: "always" });
    await bridge.settled();
    assert.deepEqual(calls, [["exec.approval.resolve", { id: "ap-1", decision: "allow-always" }]]);
    assert.equal(sent.at(-1)?.type, "approval.executed");
  });

  it("takes a yes for always as a yes for once when OpenClaw offers only once", async () => {
    bridge.onClaw({ event: "chat", payload: { runId: "r8", sessionKey: key(), seq: 1, state: "status" } });
    bridge.onClaw({
      event: "exec.approval.requested",
      payload: {
        id: "ap-2",
        request: { command: "pwd", sessionKey: key(), runId: "r8", unavailableDecisions: ["allow-always"], allowedDecisions: ["allow-once", "deny"] },
      },
    });
    await bridge.settled();
    const card = sent.find((event) => event.type === "approval.request");
    await bridge.onChips({ type: "approval.resolved", approval_id: card?.["approval_id"], decision: "approved", scope: "always" });
    assert.deepEqual(calls, [["exec.approval.resolve", { id: "ap-2", decision: "allow-once" }]]);
  });

  it("passes a no, or an expiry, back as deny", async () => {
    asked();
    await bridge.settled();
    const card = sent.find((event) => event.type === "approval.request");
    await bridge.onChips({ type: "approval.resolved", approval_id: card?.["approval_id"], decision: "expired" });
    assert.deepEqual(calls, [["exec.approval.resolve", { id: "ap-1", decision: "deny" }]]);
  });

  it("asks for Codex's own command as a card, and answers it as a plugin approval", async () => {
    bridge.onClaw({ event: "chat", payload: { runId: "r9", sessionKey: key(), seq: 1, state: "status" } });
    bridge.onClaw({
      event: "plugin.approval.requested",
      payload: {
        approvalKind: "plugin",
        id: "plugin:ap-3",
        expiresAtMs: Date.now() + 120_000,
        request: {
          title: "Codex app-server command approval",
          description: "Allow Always requests a persistent allow rule for future sessions.\nCommand prefix: [\"ls\",\"-la\"]\nCommand: ls -la\nProposed exec policy: ls, -la",
          pluginId: "codex",
          toolName: "codex_command_approval",
          allowedDecisions: ["allow-once", "allow-always", "deny"],
          sessionKey: key(),
          runId: "r9",
        },
      },
    });
    await bridge.settled();
    const card = sent.find((event) => event.type === "approval.request");
    assert.deepEqual(card?.["action"], { kind: "shell.exec", input: { command: "ls -la" } });
    assert.equal(card?.["question"], "Run `ls -la`?");
    assert.equal(card?.["effect"], undefined);
    await bridge.onChips({ type: "approval.resolved", approval_id: card?.["approval_id"], decision: "approved", scope: "always" });
    assert.deepEqual(calls, [["plugin.approval.resolve", { id: "plugin:ap-3", decision: "allow-always" }]]);
  });

  it("says where Codex's own command runs, from the folder its tool call started in (AQ-2)", async () => {
    const codexAsk = (id: string, toolCallId: string) =>
      bridge.onClaw({
        event: "plugin.approval.requested",
        payload: {
          id,
          request: {
            title: "Codex app-server command approval",
            description: "Command: mkdir -p /tmp/t",
            toolName: "codex_command_approval",
            toolCallId,
            sessionKey: key(),
          },
        },
      });
    bridge.onClaw({ event: "chat", payload: { runId: "r11", sessionKey: key(), seq: 1, state: "status" } });
    bridge.onClaw({
      event: "agent",
      payload: {
        runId: "r11",
        sessionKey: key(),
        seq: 2,
        stream: "tool",
        data: { phase: "start", name: "bash", toolCallId: "exec-1", args: { command: "/bin/bash -lc 'mkdir -p /tmp/t'", cwd: "/home/node/.openclaw/chips/a" } },
      },
    });
    codexAsk("plugin:ap-5", "exec-1");
    await bridge.settled();
    const card = sent.find((event) => event.type === "approval.request");
    assert.equal(card?.["question"], "Run `mkdir -p /tmp/t`?");
    assert.equal(card?.["effect"], "It runs in /home/node/.openclaw/chips/a.");
    assert.deepEqual(card?.["action"], { kind: "shell.exec", input: { command: "mkdir -p /tmp/t", cwd: "/home/node/.openclaw/chips/a" } });
    // Once the tool has its result the folder is forgotten: an ask for that call again says none.
    bridge.onClaw({ event: "agent", payload: { runId: "r11", sessionKey: key(), seq: 3, stream: "tool", data: { phase: "result", name: "bash", toolCallId: "exec-1" } } });
    codexAsk("plugin:ap-6", "exec-1");
    await bridge.settled();
    const later = sent.filter((event) => event.type === "approval.request").at(-1);
    assert.equal(later?.["effect"], undefined);
  });

  it("tells Chips of an approval answered in OpenClaw, once, so the card cools", async () => {
    asked();
    await bridge.settled();
    const card = sent.find((event) => event.type === "approval.request");
    bridge.onClaw({ event: "exec.approval.resolved", payload: { id: "ap-1", decision: "allow-always", resolvedBy: "cli", ts: Date.now() } });
    await bridge.settled();
    const settled = sent.find((event) => event.type === "approval.resolved");
    assert.deepEqual(
      { ...settled, idempotency_key: undefined },
      {
        type: "approval.resolved",
        run_id: card?.["run_id"],
        approval_id: card?.["approval_id"],
        decision: "approved",
        scope: "once",
        reason: "Answered in OpenClaw.",
        idempotency_key: undefined,
      },
    );
    assert.deepEqual(calls, []);
    // A no in OpenClaw is a no on the card.
    bridge.onClaw({ event: "chat", payload: { runId: "r10", sessionKey: key(), seq: 1, state: "status" } });
    bridge.onClaw({ event: "plugin.approval.requested", payload: { id: "plugin:ap-4", request: { title: "Allow?", sessionKey: key(), runId: "r10" } } });
    bridge.onClaw({ event: "plugin.approval.resolved", payload: { id: "plugin:ap-4", decision: "deny" } });
    await bridge.settled();
    assert.equal(sent.filter((event) => event.type === "approval.resolved").at(-1)?.["decision"], "denied");
  });

  it("does not tell Chips of an answer Chips gave, nor pass its own back to OpenClaw", async () => {
    asked();
    await bridge.settled();
    const card = sent.find((event) => event.type === "approval.request");
    await bridge.onChips({ type: "approval.resolved", approval_id: card?.["approval_id"], run_id: card?.["run_id"], decision: "approved", scope: "once", resolved_by: ARJUN.participant_id });
    bridge.onClaw({ event: "exec.approval.resolved", payload: { id: "ap-1", decision: "allow-once" } });
    await bridge.settled();
    assert.equal(sent.filter((event) => event.type === "approval.resolved").length, 0);
    // Its own settle, delivered back by Chips, is not an answer for OpenClaw.
    calls = [];
    await bridge.onChips({ type: "approval.resolved", approval_id: card?.["approval_id"], decision: "approved", scope: "once", resolved_by: ME });
    assert.deepEqual(calls, []);
  });

  it("tells Chips of a question answered in OpenClaw, and not of one cancelled", async () => {
    bridge.onClaw({ event: "chat", payload: { runId: "r11", sessionKey: key(), seq: 1, state: "status" } });
    bridge.onClaw({
      event: "question.requested",
      payload: { id: "q-2", sessionKey: key(), runId: "r11", questions: [{ questionId: "day", question: "Which day?", options: [{ label: "Saturday" }, { label: "Sunday" }] }] },
    });
    bridge.onClaw({ event: "question.resolved", payload: { id: "q-2", status: "answered", answers: { answers: { day: ["Sunday"] } } } });
    await bridge.settled();
    const ask = sent.find((event) => event.type === "question.ask");
    const answer = sent.find((event) => event.type === "question.answered");
    assert.equal(answer?.["ask_id"], ask?.["ask_id"]);
    assert.equal(answer?.["run_id"], ask?.["run_id"]);
    assert.deepEqual(answer?.["answers"], [{ question_id: "day", values: ["Sunday"] }]);
    bridge.onClaw({ event: "question.resolved", payload: { id: "q-9", status: "cancelled" } });
    await bridge.settled();
    assert.equal(sent.filter((event) => event.type === "question.answered").length, 1);
  });

  it("asks OpenClaw's question as a question card, and sends the answer back", async () => {
    bridge.onClaw({ event: "chat", payload: { runId: "r7", sessionKey: key(), seq: 1, state: "status" } });
    bridge.onClaw({
      event: "question.requested",
      payload: {
        id: "q-1",
        sessionKey: key(),
        runId: "r7",
        status: "pending",
        questions: [{ questionId: "day", header: "Day", question: "Which day?", options: [{ label: "Saturday" }, { label: "Sunday", description: "Quieter" }] }],
      },
    });
    await bridge.settled();
    const ask = sent.find((event) => event.type === "question.ask");
    assert.deepEqual(ask?.["questions"], [
      {
        question_id: "day",
        prompt: "Which day?",
        options: [{ value: "Saturday", label: "Saturday" }, { value: "Sunday", label: "Sunday", description: "Quieter" }],
        multi_select: false,
        allow_free_text: false,
      },
    ]);
    await bridge.onChips({ type: "question.answered", ask_id: ask?.["ask_id"], answers: [{ question_id: "day", values: ["Sunday"] }] });
    assert.deepEqual(calls, [["question.resolve", { id: "q-1", answers: { answers: { day: ["Sunday"] } } }]]);
  });

  it("asks nothing for a turn that has ended: a stopped turn's late asks have no card to go on", async () => {
    bridge.onClaw({ event: "chat", payload: { runId: "r12", sessionKey: key(), seq: 1, state: "aborted" } });
    bridge.onClaw({ event: "exec.approval.requested", payload: { id: "ap-9", request: { command: "rm -rf build", sessionKey: key(), runId: "r12" } } });
    bridge.onClaw({ event: "plugin.approval.requested", payload: { id: "plugin:ap-9", request: { title: "Allow?", sessionKey: key(), runId: "r12" } } });
    bridge.onClaw({
      event: "question.requested",
      payload: { id: "q-9", sessionKey: key(), runId: "r12", questions: [{ questionId: "day", question: "Which day?", options: [] }] },
    });
    await bridge.settled();
    assert.deepEqual(sent.map((event) => event.type), ["run.started", "run.failed"]);
  });
});

describe("words", () => {
  it("asks about a command by name when it reads in one line, and as this command otherwise", () => {
    assert.deepEqual(commandAsk("date", "/home/node/.openclaw/workspace"), {
      question: "Run `date`?",
      effect: "It runs in /home/node/.openclaw/workspace.",
      lasts: "once",
    });
    assert.deepEqual(commandAsk("npm test", undefined), { question: "Run `npm test`?", lasts: "once" });
    assert.equal(commandAsk("echo `whoami`", undefined)["question"], "Run this command?");
    assert.equal(commandAsk("set -e\nnpm ci", undefined)["question"], "Run this command?");
    assert.equal(commandAsk("x".repeat(121), undefined)["question"], "Run this command?");
    assert.equal(commandAsk(undefined, undefined)["question"], "Run this command?");
  });

  it("takes the text of a message however OpenClaw shapes it", () => {
    assert.equal(textOf("plain"), "plain");
    assert.equal(textOf({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }), "ab");
    assert.equal(textOf(null), "");
  });

  it("names a room from the first line of its first words", () => {
    assert.equal(titleFrom("Short one\nsecond line"), "Short one");
  });

  it("names a message with no words from its transcript, or from what was sent", () => {
    assert.equal(wordsOf({ text: " Hi " }), "Hi");
    assert.equal(wordsOf({ text: "", attachments: [{ mime_type: "audio/mp4", transcript: "Testing of voice note" }] }), "Testing of voice note");
    assert.equal(wordsOf({ attachments: [{ mime_type: "audio/mp4" }] }), "A voice note");
    assert.equal(wordsOf({ attachments: [{ mime_type: "image/jpeg" }] }), "A photo");
  });

  it("reports usage with its tokens out, and its tokens in when it knows them", () => {
    assert.equal(usageOf({ input: 1 }, "m"), undefined);
    assert.deepEqual(usageOf({ output: 232 }, "m"), { scope: "run", model: "m", output_tokens: 232 });
    assert.deepEqual(usageOf({ inputTokens: 3, outputTokens: 4 }, "m"), { scope: "run", model: "m", input_tokens: 3, output_tokens: 4 });
  });
});

describe("what a turn cost (Chips ADRs 0117, 0118)", () => {
  /** An assistant message as OpenClaw's history keeps it: one model call, priced. */
  const call = (at: number, cost: number | undefined, input = 600, cacheRead = 16_000, output = 50) => ({
    role: "assistant",
    timestamp: at,
    content: [{ type: "text", text: "…" }],
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite: 0,
      ...(cost === undefined ? {} : { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } }),
    },
  });

  it("adds up the priced model calls since the turn began, and nothing before it or unpriced", () => {
    const messages = [
      call(900, 0.4),
      { role: "user", timestamp: 1_000, content: "In this room: …" },
      call(1_010, 0.053264, 3_855, 11_264, 69),
      { role: "toolResult", timestamp: 1_011, content: [] },
      call(1_020, 0.056176, 1_745, 14_976, 475),
      call(1_030, 0.02595, 661, 16_640, 54),
      call(1_040, undefined),
    ];
    assert.deepEqual(spentIn(messages, 1_000), {
      usd: 0.13539,
      input: 49_141,
      cacheRead: 42_880,
      cacheWrite: 0,
      output: 598,
    });
    assert.equal(spentIn(messages, 2_000), undefined);
    assert.equal(spentIn({}, 0), undefined);
  });

  it("puts the cost on the turn's usage, and its tokens in when its events never said them", () => {
    const spent = { usd: 0.135, input: 49_141, cacheRead: 42_880, cacheWrite: 0, output: 598 };
    assert.deepEqual(withSpend({ scope: "run", model: "m", output_tokens: 598 }, spent, "m"), {
      scope: "run",
      model: "m",
      output_tokens: 598,
      input_tokens: 49_141,
      cache_read_tokens: 42_880,
      cache_write_tokens: 0,
      cost: { usd: 0.135, estimated: true },
    });
    const own = { scope: "run", model: "m", input_tokens: 3, output_tokens: 4, cost: { usd: 1, estimated: true } };
    assert.deepEqual(withSpend(own, spent, "m"), own, "a cost of its own is kept");
    assert.deepEqual(withSpend(undefined, spent, "m"), {
      scope: "run",
      model: "m",
      input_tokens: 49_141,
      cache_read_tokens: 42_880,
      cache_write_tokens: 0,
      output_tokens: 598,
      cost: { usd: 0.135, estimated: true },
    });
    assert.equal(withSpend(undefined, undefined, "m"), undefined);
  });

  /** A turn on the room's message, its usage stream, and its end. */
  async function turn(): Promise<ChipsEvent | undefined> {
    await bridge.onChips(said("Redesign SPARK"));
    const r = "msg_01K4ZQPX0000000000000000A1";
    bridge.onClaw({ event: "chat", payload: { runId: r, sessionKey: key(), seq: 1, state: "status" } });
    bridge.onClaw({ event: "agent", payload: { runId: r, sessionKey: key(), stream: "usage", data: { outputTokens: 598 } } });
    bridge.onClaw({
      event: "chat",
      payload: {
        runId: r,
        sessionKey: key(),
        seq: 2,
        state: "final",
        message: { role: "assistant", content: [{ type: "text", text: "Done." }], usage: { input: 0, output: 0, totalTokens: 0 } },
      },
    });
    await bridge.settled();
    return sent.find((event) => event.type === "usage");
  }

  it("reports a turn's cost from OpenClaw's history of its session, read once it ends", async () => {
    const now = Date.now();
    history = [call(now - 60_000, 0.4), call(now + 5, 0.053264, 3_855, 11_264, 69), call(now + 10, 0.02595, 661, 16_640, 54)];
    const usage = await turn();
    assert.deepEqual(
      calls.filter(([method]) => method === "chat.history"),
      [["chat.history", { sessionKey: key(), limit: 50 }]],
    );
    assert.equal(usage?.["output_tokens"], 598);
    assert.equal(usage?.["input_tokens"], 32_420);
    assert.deepEqual(usage?.["cost"], { usd: 0.079214, estimated: true });
    assert.deepEqual(
      sent.map((event) => event.type),
      ["run.started", "message.post", "usage", "run.completed"],
      "in order, though the cost is read first",
    );
  });

  it("says what a turn has cost so far while it works: at a tool's end, at most every 15 s from its start, and only when it grew (LJ-6)", async () => {
    // Long jobs C, 5 October 2026: one of O3's checks took a $0.50 room's job from $0.27 to $0.95
    // in one report, at its end, so Chips drew no 80% line and held nobody until it was over.
    let clock = 1_000_000;
    bridge = new Bridge(chips, claw, { harnessId: ME, agent: "main" }, () => undefined, undefined, () => clock);
    await bridge.onChips(said("Check the tour's facts"));
    const r = "msg_01K4ZQPX0000000000000000B2";
    const tool = (seq: number, phase: string, id: string) =>
      bridge.onClaw({ event: "agent", payload: { runId: r, sessionKey: key(), seq, stream: "tool", data: { phase, name: "web_search", toolCallId: id } } });
    const usages = () =>
      sent
        .filter((event) => event.type === "usage")
        .map((event) => [event["idempotency_key"], (event["cost"] as { usd: number } | undefined)?.usd]);
    bridge.onClaw({ event: "chat", payload: { runId: r, sessionKey: key(), seq: 1, state: "status" } });

    // Within its first 15 s: nothing yet.
    history = [call(clock + 1_000, 0.2)];
    clock += 5_000;
    tool(2, "start", "call_1");
    tool(3, "end", "call_1");
    await bridge.settled();
    assert.deepEqual(usages(), []);

    clock += 15_000;
    tool(4, "start", "call_2");
    tool(5, "end", "call_2");
    await bridge.settled();
    assert.deepEqual(usages(), [[`openclaw-run:${r}:usage-so-far-1`, 0.2]]);

    // Five seconds on: not yet; and fifteen on, nothing more spent, nothing said.
    history = [...history, call(clock + 1_000, 0.25)];
    clock += 5_000;
    tool(6, "end", "call_3");
    await bridge.settled();
    assert.equal(usages().length, 1);
    clock += 15_000;
    tool(7, "end", "call_4");
    await bridge.settled();
    assert.deepEqual(usages().at(-1), [`openclaw-run:${r}:usage-so-far-2`, 0.45]);
    clock += 15_000;
    tool(8, "end", "call_5");
    await bridge.settled();
    assert.equal(usages().length, 2);

    history = [...history, call(clock + 1_000, 0.05)];
    bridge.onClaw({
      event: "chat",
      payload: { runId: r, sessionKey: key(), seq: 9, state: "final", message: { role: "assistant", content: [{ type: "text", text: "Checked." }] } },
    });
    await bridge.settled();
    assert.deepEqual(usages().at(-1), [`openclaw-run:${r}:usage`, 0.5], "the end's report is the total");
    assert.equal(sent.at(-1)?.type, "run.completed");
    assert.ok(usages().every(([key]) => String(key).startsWith(`openclaw-run:${r}:`)));
  });

  it("reports the tokens alone when the history says no cost, or cannot be read", async () => {
    history = new Error("chat.history is not allowed");
    const usage = await turn();
    assert.deepEqual(usage, {
      type: "usage",
      run_id: usage?.["run_id"],
      scope: "run",
      model: "openai",
      output_tokens: 598,
      idempotency_key: "openclaw-run:msg_01K4ZQPX0000000000000000A1:usage",
    });
  });

  it("says in its log that a room's job reached its ceiling, and does nothing else", async () => {
    const said: string[] = [];
    bridge = new Bridge(chips, claw, { harnessId: ME, agent: "main" }, (line) => said.push(line));
    const warning = (threshold: number, action: string, spent: number) => ({
      type: "budget.warning",
      space_id: ROOM,
      budget: { limit_usd: 3, spent_usd: spent },
      threshold,
      action,
      scope: "job",
      since_seq: 40,
    });
    await bridge.onChips(warning(80, "warn", 2.41));
    await bridge.onChips(warning(100, "pause", 3.02));
    await bridge.onChips({ type: "budget.warning", budget: { limit_usd: 25, spent_usd: 20.4 }, threshold: 80, action: "warn" });
    assert.deepEqual(said, [
      `the job in ${ROOM} has spent $2.41 of $3.00 it allows`,
      `chips paused the agents in ${ROOM}: its job has spent $3.02 of $3.00, all it allows; they wait for a person`,
      "chips says this harness has spent $20.40 of $25.00 of its budget (warn)",
    ]);
    assert.deepEqual(sent, []);
    assert.deepEqual(calls, []);
  });
});

describe("OpenClaw's agents as agents in Chips (Chips ADR 0087)", () => {
  const FALLBACK = agentIn("agt_fallback", ME, ROOM);
  const OTHER_ROOM = "spc_01K4ZQPX000000000000000077";

  beforeEach(() => {
    agents = [FALLBACK];
  });

  it("registers each agent the gateway lists, named as the harness when it has no name of its own, and moves none", async () => {
    await bridge.adoptAgents({
      defaultId: "main",
      agents: [{ id: "main" }, { id: "scout", identity: { name: "Scout" } }, { id: "ops", kind: "system" }],
    });
    assert.deepEqual(
      agents.filter((each) => each.key !== ME).map((each) => [each.key, each.name]),
      [["agent:main:chips-main", "OpenClaw"], ["scout", "Scout"]],
    );
    // An agent is in one room at a time: putting each in the default agent's rooms at start, as
    // the bridge did before, would have Chips refuse all but one. Each stays where Chips has it.
    assert.deepEqual(attached, []);
    assert.equal(agents.find((each) => each.key === ME)?.room, ROOM);
  });

  it("serves only OPENCLAW_AGENT when it is set, as its Main agent", async () => {
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }, { id: "scout" }] }, "scout");
    assert.equal(bridge.mainKey(), "agent:scout:chips-main");
    assert.deepEqual(agents.filter((each) => each.key !== ME).map((each) => [each.key, each.lead]), [["agent:scout:chips-main", true]]);
  });

  it("seats its primary agent as the Main agent, in a room opened by the agent's key and named the harness's home", async () => {
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main", identity: { name: "main" } }, { id: "scout" }] });
    const main = "agt_agent:main:chips-main";
    // The Main agent is the primary agent's one conversation in its Main room (Chips ADR 0087).
    assert.equal(bridge.mainKey(), "agent:main:chips-main");
    assert.deepEqual(registered[0], { key: bridge.mainKey(), name: "OpenClaw", lead: true });
    assert.equal(registered.some((each) => each["key"] === "main"), false);
    assert.deepEqual(opened, [bridge.mainKey()]);
    assert.equal(agents.find((each) => each.agent_id === main)?.room, MAIN_ROOM);
    // Its room is the harness's home, which nobody archives or deletes (Chips ADR 0069).
    assert.deepEqual(homes, [
      { type: "space.updated", space_id: MAIN_ROOM, home: true, actor: { kind: "agent", id: main }, idempotency_key: `home-${MAIN_ROOM}` },
    ]);
  });

  it("keeps the Main agent Chips has, in its room, and names its home again at each start", async () => {
    agents = [FALLBACK, { ...agentIn("agt_lead", bridge.mainKey(), MAIN_ROOM), lead: true }];
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    assert.deepEqual(registered, []);
    assert.deepEqual(opened, []);
    assert.deepEqual(homes.map((event) => [event["space_id"], event["actor"]]), [[MAIN_ROOM, { kind: "agent", id: "agt_lead" }]]);
  });

  it("answers in the Main room as the primary agent, in its Home, said as the Main agent", async () => {
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    const main = "agt_agent:main:chips-main";
    calls = [];
    await bridge.onChips(said("Which channels are set up?", { space_id: MAIN_ROOM, addressed_to: [main], for: [main] }));
    const send = calls.find(([method]) => method === "chat.send")?.[1];
    // Home: the primary agent's one conversation, the one OpenClaw's web app and channels use.
    assert.equal(bridge.homeKey(), "agent:main:main");
    assert.equal(send?.["sessionKey"], "agent:main:main");
    bridge.onClaw({
      event: "chat",
      payload: { runId: String(send?.["idempotencyKey"]), sessionKey: "agent:main:main", seq: 1, state: "final", message: "None yet." },
    });
    await bridge.settled();
    assert.deepEqual(sent.map((event) => event.type), ["run.started", "message.post", "run.completed"]);
    for (const event of sent) assert.deepEqual(event["actor"], { kind: "agent", id: main });
  });

  it("says what the primary agent says on its own in Home in the Main room, as the Main agent", async () => {
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    bridge.onClaw({ event: "chat", payload: { runId: "heartbeat-1", sessionKey: "agent:main:main", seq: 1, state: "final", message: "The build you asked about finished." } });
    await bridge.settled();
    assert.deepEqual(sent.map((event) => event.type), ["run.started", "message.post", "run.completed"]);
    assert.equal(sent[0]?.["space_id"], MAIN_ROOM);
    for (const event of sent) assert.deepEqual(event["actor"], { kind: "agent", id: "agt_agent:main:chips-main" });
  });

  describe("a harness that joined since Chips ADR 0183", () => {
    // Its join made the default agent, in the room it opened: that one is its Main, not a second.
    const joined = () => new Bridge(chips, claw, { harnessId: ME, agent: "main", home: ROOM }, () => undefined);

    it("seats the default agent as its Main, in the join's room, named the harness's home", async () => {
      const fresh = joined();
      await fresh.adoptAgents({ defaultId: "main", agents: [{ id: "main" }, { id: "scout", identity: { name: "Scout" } }] });
      assert.deepEqual(registered[0], { key: ME, name: "OpenClaw", lead: true });
      assert.equal(registered.some((each) => each["key"] === fresh.mainKey()), false);
      assert.deepEqual(opened, []);
      assert.deepEqual(homes.map((event) => [event["space_id"], event["actor"]]), [[ROOM, { kind: "agent", id: "agt_fallback" }]]);
      assert.deepEqual(
        agents.map((each) => [each.key, each.lead]),
        [[ME, true], ["scout", false]],
      );
    });

    it("answers in its own room as the primary agent, in Home, said as the default agent", async () => {
      const fresh = joined();
      await fresh.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
      calls = [];
      await fresh.onChips(said("Which channels are set up?", { addressed_to: ["agt_fallback"], for: ["agt_fallback"] }));
      const send = calls.find(([method]) => method === "chat.send")?.[1];
      assert.equal(send?.["sessionKey"], fresh.homeKey());
      fresh.onClaw({
        event: "chat",
        payload: { runId: String(send?.["idempotencyKey"]), sessionKey: fresh.homeKey(), seq: 1, state: "final", message: "None yet." },
      });
      await fresh.settled();
      assert.deepEqual(sent.map((event) => event.type), ["run.started", "message.post", "run.completed"]);
      for (const event of sent) assert.deepEqual(event["actor"], { kind: "agent", id: "agt_fallback" });
    });

    it("says what the primary agent says on its own in Home in its own room", async () => {
      const fresh = joined();
      await fresh.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
      fresh.onClaw({ event: "chat", payload: { runId: "heartbeat-1", sessionKey: fresh.homeKey(), seq: 1, state: "final", message: "The build finished." } });
      await fresh.settled();
      assert.equal(sent[0]?.["space_id"], ROOM);
      for (const event of sent) assert.deepEqual(event["actor"], { kind: "agent", id: "agt_fallback" });
    });

    it("keeps to the primary agent's own key when the default agent is not in the join's room", async () => {
      agents = [agentIn("agt_fallback", ME, OTHER_ROOM)];
      const fresh = joined();
      await fresh.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
      assert.deepEqual(registered[0], { key: fresh.mainKey(), name: "OpenClaw", lead: true });
      assert.deepEqual(opened, [fresh.mainKey()]);
    });
  });

  it("registers the other agents when Chips will not take a Main agent", async () => {
    const real = chips.registerAgent;
    chips.registerAgent = async (wanted) => {
      if (wanted.lead === true) throw new ChipsRefusal(400, "invalid_event", "This harness has a Main agent already.");
      return real(wanted);
    };
    try {
      await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }, { id: "scout", name: "Scout" }] });
    } finally {
      chips.registerAgent = real;
    }
    assert.deepEqual(registered.map((each) => each["key"]), ["scout"]);
    assert.deepEqual(opened, []);
    assert.deepEqual(homes, []);
  });

  it("takes a turn for each of its agents a message is for, each in its own session, said as it", async () => {
    agents = [agentIn("agt_fallback", ME, OTHER_ROOM), agentIn("agt_main", "main", ROOM), agentIn("agt_scout", "scout", ROOM, "Scout")];
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }, { id: "scout", name: "Scout" }] });
    calls = [];
    await bridge.onChips(said("@OpenClaw @Scout which?", { addressed_to: ["agt_main", "agt_scout"], for: ["agt_main", "agt_scout"] }));
    const sends = calls.filter(([method]) => method === "chat.send").map(([, params]) => [params["sessionKey"], params["idempotencyKey"]]);
    assert.deepEqual(sends, [
      [bridge.keyFor(ROOM, "main"), "msg_01K4ZQPX0000000000000000A1"],
      [bridge.keyFor(ROOM, "scout"), "msg_01K4ZQPX0000000000000000A1:scout"],
    ]);
    bridge.onClaw({
      event: "chat",
      payload: { runId: "msg_01K4ZQPX0000000000000000A1:scout", sessionKey: bridge.keyFor(ROOM, "scout"), seq: 1, state: "final", message: "This one." },
    });
    await bridge.settled();
    for (const event of sent) assert.deepEqual(event["actor"], { kind: "agent", id: "agt_scout" });
    assert.deepEqual(sent.map((event) => event.type), ["run.started", "message.post", "run.completed"]);
  });

  it("puts its primary agent in the default one's place, for a message to the default one, when it is in no room", async () => {
    const later = "spc_01K4ZQPX000000000000000088";
    agents = [agentIn("agt_fallback", ME, later), agentIn("agt_main", "main", null)];
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    await bridge.onChips(said("Hi", { space_id: later, for: ["agt_fallback"] }));
    assert.deepEqual(attached, [["agt_main", later, "agt_fallback"]]);
    assert.equal(calls.find(([method]) => method === "chat.send")?.[1]["sessionKey"], bridge.keyFor(later, "main"));
    bridge.onClaw({ event: "chat", payload: { runId: "msg_01K4ZQPX0000000000000000A1", sessionKey: bridge.keyFor(later, "main"), seq: 1, state: "final", message: "Hello." } });
    await bridge.settled();
    assert.deepEqual(sent.find((event) => event.type === "message.post")?.["actor"], { kind: "agent", id: "agt_main" });
  });

  it("answers as the default agent when its primary agent is in another room, and moves nobody", async () => {
    agents = [FALLBACK, agentIn("agt_main", "main", OTHER_ROOM)];
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    await bridge.onChips(said("Hi", { for: ["agt_fallback"], addressed_to: ["agt_fallback"] }));
    assert.deepEqual(attached, []);
    assert.equal(calls.find(([method]) => method === "chat.send")?.[1]["sessionKey"], key());
    bridge.onClaw({ event: "chat", payload: { runId: "msg_01K4ZQPX0000000000000000A1", sessionKey: key(), seq: 1, state: "final", message: "Hello." } });
    await bridge.settled();
    assert.deepEqual(sent.find((event) => event.type === "message.post")?.["actor"], { kind: "agent", id: "agt_fallback" });
  });

  it("makes a new agent a person asks for in a room, in a session of its own, and answers as it (ADR 0108)", async () => {
    agents = [agentIn("agt_fallback", ME, OTHER_ROOM), agentIn("agt_main", "main", ROOM)];
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    registered = [];
    calls = [];
    const ask = "evt_01K4ZQPX0000000000000000N1";
    const session = bridge.madeKeyFor(ROOM, ask);
    const asked = { type: "agent.asked", id: ask, ts: new Date().toISOString(), space_id: ROOM, harness_id: ME, name: "Reviewer", by: ARJUN.participant_id };
    await bridge.onChips(asked);
    assert.deepEqual(registered, [{ key: session, name: "Reviewer", made_for: ask, space_id: ROOM }]);
    // Heard again, a replay: the same key, which Chips answers as done.
    await bridge.onChips(asked);
    assert.deepEqual(registered.map((each) => each["key"]), [session, session]);
    const reviewer = `agt_${session}`;
    await bridge.onChips({ type: "agent.attached", space_id: ROOM, agent_id: reviewer });
    await bridge.onChips(said("@Reviewer check A–M", { addressed_to: [reviewer], for: [reviewer] }));
    // Its own conversation, of its own OpenClaw agent: not the main agent's session in the room.
    assert.equal(calls.find(([method]) => method === "chat.send")?.[1]["sessionKey"], session);
    bridge.onClaw({ event: "chat", payload: { runId: "msg_01K4ZQPX0000000000000000A1", sessionKey: session, seq: 1, state: "final", message: "On it." } });
    await bridge.settled();
    assert.deepEqual(sent.find((event) => event.type === "message.post")?.["actor"], { kind: "agent", id: reviewer });
  });

  it("makes no agent for another harness's ask, or one the room stopped waiting for", async () => {
    const asked = { type: "agent.asked", id: "evt_01K4ZQPX0000000000000000N2", space_id: ROOM, name: "Reviewer", by: ARJUN.participant_id };
    await bridge.onChips({ ...asked, ts: new Date().toISOString(), harness_id: "hrn_01K4ZQPX000000000000000009" });
    await bridge.onChips({ ...asked, ts: new Date(Date.now() - 61_000).toISOString(), harness_id: ME });
    assert.deepEqual(registered, []);
  });

  it("claims a room asked of it from the + and answers as the agent Chips makes for the claim's key", async () => {
    agents = [agentIn("agt_fallback", ME, OTHER_ROOM), agentIn("agt_main", "main", ROOM)];
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    calls = [];
    const asked = "spc_01K4ZQPX000000000000000099";
    const session = bridge.claimKeyFor(asked);
    await bridge.onChips({ type: "space.created", space_id: asked, asked_of: ME, kind: "direct" });
    await bridge.onChips(said("Plan a picnic", { space_id: asked, addressed_to: [ME], for: [ME] }));
    assert.deepEqual(claims.at(-1)?.slice(0, 2), [asked, session]);
    // Chips puts the key's own agent in the harness's place; the bridge attaches nobody.
    assert.deepEqual(attached, []);
    assert.equal(calls.find(([method]) => method === "chat.send")?.[1]["sessionKey"], session);
    bridge.onClaw({ event: "chat", payload: { runId: "msg_01K4ZQPX0000000000000000A1:main", sessionKey: session, seq: 1, state: "final", message: "Saturday?" } });
    await bridge.settled();
    const reply = sent.find((event) => event.type === "message.post");
    assert.deepEqual(reply?.["actor"], { kind: "agent", id: `agt_${session}` });
    assert.equal(sent[0]?.["space_id"], asked);
  });

  it("claims a room asked of it beside another harness (also_asked_of) as one asked of it", async () => {
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    const asked = "spc_01K4ZQPX000000000000000099";
    const created = { type: "space.created", space_id: asked, asked_of: "hrn_01K4ZQPX000000000000000009", also_asked_of: [ME], kind: "group" };
    assert.equal(bridge.asksMe(created), true);
    await bridge.onChips(created);
    await bridge.onChips(said("Plan a picnic", { space_id: asked, addressed_to: [ME], for: [ME] }));
    assert.deepEqual(claims, [[asked, bridge.claimKeyFor(asked), "Plan a picnic"]]);
    // Asked of somebody else alone, it is not this harness's to claim.
    await bridge.onChips({ ...created, space_id: OTHER_ROOM, also_asked_of: [] });
    await bridge.onChips(said("Hi", { space_id: OTHER_ROOM, message_id: "msg_01K4ZQPX0000000000000000A2", addressed_to: [ME], for: [ME] }));
    assert.equal(claims.length, 1);
  });

  it("takes a turn for an agent keyed by a session in that session, with its OpenClaw agent, wherever Chips moved it", async () => {
    const carried = "agent:scout:chips-spc_01k4zqpx000000000000000077";
    agents = [FALLBACK, agentIn("agt_carried", carried, OTHER_ROOM)];
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }, { id: "scout" }] });
    await bridge.onChips({ type: "agent.attached", agent_id: "agt_carried", space_id: ROOM, moved_from: OTHER_ROOM });
    calls = [];
    await bridge.onChips(said("Still there?", { addressed_to: ["agt_carried"], for: ["agt_carried"] }));
    assert.deepEqual(calls[0], ["sessions.create", { key: carried, agentId: "scout", displayName: "Still there?" }]);
    assert.deepEqual(calls[1]?.[1], { sessionKey: carried, message: told("Still there?"), idempotencyKey: "msg_01K4ZQPX0000000000000000A1:agt_carried", queueMode: "steer" });
    bridge.onClaw({ event: "chat", payload: { runId: "msg_01K4ZQPX0000000000000000A1:agt_carried", sessionKey: carried, seq: 1, state: "final", message: "Yes." } });
    await bridge.settled();
    // In the room it was asked in, not the one its session is named after.
    assert.equal(sent[0]?.["space_id"], ROOM);
    for (const event of sent) assert.deepEqual(event["actor"], { kind: "agent", id: "agt_carried" });
  });

  it("says a turn OpenClaw starts on its own as the agent keyed by the session, in the room Chips last put it in", async () => {
    const carried = "agent:main:chips-spc_01k4zqpx000000000000000077";
    agents = [FALLBACK, agentIn("agt_carried", carried, OTHER_ROOM)];
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    await bridge.onChips({ type: "agent.attached", agent_id: "agt_carried", space_id: ROOM, moved_from: OTHER_ROOM });
    bridge.onClaw({ event: "chat", payload: { runId: "cron-1", sessionKey: carried, seq: 1, state: "final", message: "Reminder: the table." } });
    await bridge.settled();
    assert.deepEqual(sent.map((event) => event.type), ["run.started", "message.post", "run.completed"]);
    assert.equal(sent[0]?.["space_id"], ROOM);
    for (const event of sent) assert.deepEqual(event["actor"], { kind: "agent", id: "agt_carried" });
  });

  it("forgets an agent a person deleted in Chips, and says nothing more as it (Chips ADR 0095)", async () => {
    agents = [agentIn("agt_fallback", ME, OTHER_ROOM), agentIn("agt_main", "main", ROOM)];
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    await bridge.onChips({ type: "agent.released", agent_id: "agt_main", space_id: ROOM, reason: "agent_deleted" });
    await bridge.onChips({ type: "agent.deleted", agent_id: "agt_main", harness_id: ME, key: "main", name: "OpenClaw", by: ARJUN.participant_id });
    assert.equal(bridge.isOwn("agt_main"), false);
    // What OpenClaw starts on its own in that agent's session is no longer said as it.
    const carried = "agent:main:chips-spc_01k4zqpx000000000000000077";
    bridge.onClaw({ event: "chat", payload: { runId: "cron-3", sessionKey: carried, seq: 1, state: "final", message: "Reminder." } });
    await bridge.settled();
    for (const event of sent) assert.notDeepEqual(event["actor"], { kind: "agent", id: "agt_main" });
  });

  it("forgets an agent's room when Chips releases it, and says what it starts then with no room, for Chips to hold", async () => {
    const carried = "agent:main:chips-spc_01k4zqpx000000000000000077";
    agents = [FALLBACK, agentIn("agt_carried", carried, ROOM)];
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    await bridge.onChips({ type: "agent.released", agent_id: "agt_carried", space_id: ROOM, reason: "archived" });
    bridge.onClaw({ event: "agent", payload: { runId: "cron-2", sessionKey: carried, seq: 1, stream: "tool", data: { phase: "start", name: "exec", toolCallId: "call_9" } } });
    bridge.onClaw({ event: "chat", payload: { runId: "cron-2", sessionKey: carried, seq: 2, state: "final", message: "Done while you were away." } });
    await bridge.settled();
    // No run, no steps, no usage: only its words, naming no room.
    assert.deepEqual(sent, [
      {
        type: "message.post",
        text: "Done while you were away.",
        idempotency_key: "openclaw-run:cron-2:reply",
        actor: { kind: "agent", id: "agt_carried" },
      },
    ]);
  });

  it("puts what Chips handed with an agent put in a room ahead of its next turn there, once", async () => {
    agents = [FALLBACK, agentIn("agt_main", "main", null)];
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    await bridge.onChips({
      type: "agent.attached",
      agent_id: "agt_main",
      space_id: OTHER_ROOM,
      by: ARJUN.participant_id,
      catch_up: {
        lines: [
          { seq: 20, kind: "said", from: { id: "usr_01K4ZQPX000000000000000008", kind: "person", name: "Dana" }, text: "Book the table", addressed_to: [] },
          { seq: 21, kind: "joined", from: { id: ARJUN.participant_id, kind: "person", name: "Arjun" } },
        ],
        since_seq: 0,
        truncated: false,
        before: 20,
      },
    });
    calls = [];
    const inOther = { space_id: OTHER_ROOM, for: ["agt_main"], addressed_to: ["agt_main"] };
    await bridge.onChips(
      said("@OpenClaw which one?", {
        ...inOther,
        seq: 30,
        context: { lines: [{ seq: 25, kind: "said", from: { name: "Arjun" }, text: "Hi all", addressed_to: [] }], since_seq: 21, truncated: false, before: 25 },
      }),
    );
    await bridge.onChips(said("Thanks", { ...inOther, seq: 40, message_id: "msg_01K4ZQPX0000000000000000A2" }));
    assert.deepEqual(
      calls.filter(([method]) => method === "chat.send").map(([, params]) => params["message"]),
      [told("Said in this room since you last spoke:\nDana: Book the table\n(Arjun joined the room)\nArjun: Hi all\n\n@OpenClaw which one?"), told("Thanks")],
    );
  });

  it("leaves out of a catch-up what the agent heard there already, as after its own claim", async () => {
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    const asked = "spc_01K4ZQPX000000000000000099";
    const session = bridge.claimKeyFor(asked);
    await bridge.onChips({ type: "space.created", space_id: asked, asked_of: ME, kind: "direct" });
    await bridge.onChips(said("Plan a picnic", { space_id: asked, seq: 40, for: [ME], addressed_to: [ME] }));
    // Chips says so once the claim has put the key's agent in: the room's lines before it joined.
    await bridge.onChips({
      type: "agent.attached",
      agent_id: `agt_${session}`,
      space_id: asked,
      catch_up: {
        lines: [
          { seq: 39, kind: "joined", from: { id: ARJUN.participant_id, kind: "person", name: "Arjun" } },
          { seq: 40, kind: "said", from: { id: ARJUN.participant_id, kind: "person", name: "Arjun" }, text: "Plan a picnic", addressed_to: [ME] },
        ],
        since_seq: 0,
        truncated: false,
        before: 39,
      },
    });
    calls = [];
    await bridge.onChips(said("And a blanket", { space_id: asked, seq: 50, message_id: "msg_01K4ZQPX0000000000000000A2", for: [`agt_${session}`] }));
    assert.equal(calls.find(([method]) => method === "chat.send")?.[1]["message"], told("And a blanket"));
  });

  it("puts Chips's room note first, and says the @ rule once (Chips ADR 0092)", async () => {
    // OpenClaw's main as an agent of its own, keyed by its id, as it was before the Main agent.
    agents = [...agents, agentIn("agt_main", "main", ROOM)];
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    calls = [];
    const hello = { participant_id: "agt_hello", kind: "agent", display_name: "Hello", role: "member" };
    const note =
      "In this room: Arjun (person, @Arjun), Hello (agent, @Hello), and you, OpenClaw (@OpenClaw). Everyone here reads what you write; only those you @-mention act on it.";
    await bridge.onChips(
      said("@OpenClaw F–J are yours.", {
        from: hello,
        seq: 12,
        addressed_to: ["agt_main"],
        for: ["agt_main"],
        context: {
          lines: [{ seq: 11, kind: "said", from: { id: ARJUN.participant_id, kind: "person", name: "Arjun" }, text: "Five letters each.", addressed_to: [] }],
          since_seq: 10,
          truncated: false,
          before: 12,
        },
        room: { members: [], notes: { agt_main: note, agt_other: "Not this one." } },
      }),
    );
    const message = String(calls.find(([method]) => method === "chat.send")?.[1]["message"]);
    assert.equal(
      message,
      told("Said in this room since you last spoke:\nArjun: Five letters each.\n\nHello (an agent in this room) said this to you:\n@OpenClaw F–J are yours.", note),
    );
  });

  it("gives each of our agents taking the turn its own note", async () => {
    // OpenClaw's main as an agent of its own, keyed by its id, as it was before the Main agent.
    agents = [...agents, agentIn("agt_main", "main", ROOM)];
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }, { id: "kit" }] });
    calls = [];
    await bridge.onChips(
      said("@all which of you?", {
        addressed_to: ["agt_main", "agt_kit"],
        for: ["agt_main", "agt_kit"],
        room: { members: [], notes: { agt_main: "Note for main.", agt_kit: "Note for kit." } },
      }),
    );
    const sends = calls.filter(([method]) => method === "chat.send").map(([, params]) => String(params["message"]));
    assert.deepEqual(sends.sort(), [told("@all which of you?", "Note for kit."), told("@all which of you?", "Note for main.")]);
  });

  it("gives the harness its own note where it takes the turn itself, as in a room it was asked for", async () => {
    await bridge.onChips({ type: "space.created", space_id: ROOM, asked_of: ME, kind: "direct" });
    await bridge.onChips(said("Plan a picnic", { for: [ME], addressed_to: [ME], room: { members: [], notes: { [ME]: "In this room: …" } } }));
    assert.equal(calls.find(([method]) => method === "chat.send")?.[1]["message"], told("Plan a picnic", "In this room: …"));
  });

  it("leads with Chips's word on the agents' talk, as Chips's, ahead of the room note and the words (the referee)", async () => {
    const word = "The agents here have sent each other 9 messages since Arjun last acted, 21 minutes ago.";
    // OpenClaw's main as an agent of its own, keyed by its id, as it was before the Main agent.
    agents = [...agents, agentIn("agt_main", "main", ROOM)];
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    calls = [];
    const hello = { participant_id: "agt_hello", kind: "agent", display_name: "Hello", role: "member" };
    await bridge.onChips(
      said("@OpenClaw send K–O", {
        from: hello,
        addressed_to: ["agt_main"],
        for: ["agt_main"],
        room: { members: [], notes: { agt_main: "In this room: …" } },
        exchange: { count: 9, stage: "nudge", note: ` ${word} ` },
      }),
    );
    assert.equal(
      calls.find(([method]) => method === "chat.send")?.[1]["message"],
      told("Hello (an agent in this room) said this to you:\n@OpenClaw send K–O", `Chips: ${word}\n\nIn this room: …`),
    );
  });

  it("says nothing of the agents' talk from a Chips that sends no word on it", async () => {
    await bridge.onChips(said("Plan a picnic", { exchange: { count: 3, stage: "quiet" } }));
    assert.equal(calls.find(([method]) => method === "chat.send")?.[1]["message"], told("Plan a picnic"));
  });

  it("steers every send: into the session's turn while one runs, a turn of its own when none does (the referee)", async () => {
    await bridge.onChips(said("Plan a picnic"));
    await bridge.onChips(said("and a blanket", { message_id: "msg_01K4ZQPX0000000000000000A2" }));
    const sends = calls.filter(([method]) => method === "chat.send");
    assert.equal(sends.length, 2);
    for (const [, params] of sends) assert.equal(params["queueMode"], "steer");
  });

  it("tells the session's next turn in the room that Chips held its answer, once, and starts no turn on it (the referee)", async () => {
    holdPosts = { held: true, exchange: { count: 48, allowance: 48 } };
    await bridge.onChips(said("@OpenClaw hand it to Hello"));
    const r1 = "msg_01K4ZQPX0000000000000000A1";
    bridge.onClaw({
      event: "chat",
      payload: { runId: r1, sessionKey: key(), seq: 1, state: "final", message: { role: "assistant", content: "@Hello over to you." } },
    });
    await bridge.settled();
    // Nothing went to OpenClaw on the hold.
    assert.equal(calls.filter(([method]) => method === "chat.send").length, 1);

    holdPosts = undefined;
    await bridge.onChips(said("Where are we?", { message_id: "msg_01K4ZQPX0000000000000000A2" }));
    await bridge.onChips(said("Thanks", { message_id: "msg_01K4ZQPX0000000000000000A3" }));
    const sends = calls.filter(([method]) => method === "chat.send").map(([, params]) => String(params["message"]));
    assert.equal(
      sends[1],
      `Chips: Your last message here was held, so the agents it named do not have it yet: messages between the agents in this room are held (they have sent each other 48 since a person last acted) until a person acts. Until then, tell the person what is done and what is blocked, rather than asking the agents again.\n\n${SENDING_FILES}\n\n${SPEAKING_LATER}\n\nWhere are we?`,
    );
    assert.equal(sends[2], told("Thanks"));
  });

  it("says nothing of an answer Chips handed over", async () => {
    await bridge.onChips(said("Hi"));
    bridge.onClaw({
      event: "chat",
      payload: { runId: "msg_01K4ZQPX0000000000000000A1", sessionKey: key(), seq: 1, state: "final", message: { role: "assistant", content: "Hello." } },
    });
    await bridge.settled();
    await bridge.onChips(said("Again", { message_id: "msg_01K4ZQPX0000000000000000A2" }));
    assert.equal(calls.filter(([method]) => method === "chat.send").at(-1)?.[1]["message"], told("Again"));
  });

  it("takes an agent's words when Chips names it kind agent, and never its own agents' words", async () => {
    // OpenClaw's main as an agent of its own, keyed by its id, as it was before the Main agent.
    agents = [...agents, agentIn("agt_main", "main", ROOM)];
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    calls = [];
    const hello = { participant_id: "agt_hello", kind: "agent", display_name: "Hello", role: "member" };
    await bridge.onChips(said("@OpenClaw what number?", { from: hello, addressed_to: ["agt_main"], for: ["agt_main"] }));
    assert.match(String(calls.find(([method]) => method === "chat.send")?.[1]["message"]), /\n\nHello \(an agent in this room\)/);
    calls = [];
    const mine = { participant_id: "agt_main", kind: "agent", display_name: "OpenClaw", role: "member" };
    await bridge.onChips(said("Ten.", { from: mine, addressed_to: ["agt_main"], for: ["agt_main"] }));
    assert.equal(calls.length, 0);
  });

  /**
   * O1 handing the page to O2 in the ASCII Art room, 3 October 2026: both ours, and the hand-off
   * was nobody's turn. Chips names the one it is for (Chips ADR 0101).
   */
  it("takes one of its agents' words for another of them as that one's turn, and never as the sayer's", async () => {
    agents = [agentIn("agt_fallback", ME, OTHER_ROOM), agentIn("agt_main", "main", ROOM), agentIn("agt_scout", "scout", ROOM, "Scout")];
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }, { id: "scout", name: "Scout" }] });
    calls = [];
    const scout = { participant_id: "agt_scout", kind: "agent", display_name: "Scout", role: "member" };
    await bridge.onChips(said("@OpenClaw add K–O.", { from: scout, addressed_to: ["agt_main", "agt_scout"], for: ["agt_main", "agt_scout"] }));
    const sends = calls.filter(([method]) => method === "chat.send").map(([, params]) => [params["sessionKey"], params["message"]]);
    assert.equal(sends.length, 1);
    assert.equal(sends[0]?.[0], bridge.keyFor(ROOM, "main"));
    assert.match(String(sends[0]?.[1]), /\n\nScout \(an agent in this room\) said this to you\b[^]*\n@OpenClaw add K–O\.$/);
    // Its own words to itself, and from a Chips that names nobody, are nobody's turn.
    calls = [];
    await bridge.onChips(said("Noted.", { from: scout, message_id: "msg_01K4ZQPX0000000000000000A2", addressed_to: ["agt_scout"], for: ["agt_scout"] }));
    await bridge.onChips(said("@OpenClaw again.", { from: scout, message_id: "msg_01K4ZQPX0000000000000000A3", addressed_to: ["agt_main"] }));
    assert.equal(calls.filter(([method]) => method === "chat.send").length, 0);
  });

  /**
   * Two of our agents in one room, as in Arjun's "Hey both…" room on 1 October 2026: OpenClaw's own
   * agent, added to a room claimed before claims had keys of their own. The claim had taken the
   * room's session, which is also the OpenClaw agent's own name there, so the two were one OpenClaw
   * conversation, and every message got one turn, as whichever came last.
   */
  it("gives two of its agents in one room a conversation each, though a claim took one's name", async () => {
    const claimed = bridge.keyFor(ROOM, "main");
    agents = [agentIn("agt_fallback", ME, OTHER_ROOM), agentIn("agt_main", "main", ROOM), agentIn("agt_claimed", claimed, ROOM)];
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    calls = [];
    await bridge.onChips(said("Hey both", { addressed_to: ["agt_claimed", "agt_main"], for: ["agt_claimed", "agt_main"] }));
    const sends = calls.filter(([method]) => method === "chat.send").map(([, params]) => [params["sessionKey"], params["idempotencyKey"]]);
    assert.deepEqual(sends, [
      [claimed, "msg_01K4ZQPX0000000000000000A1"],
      [`${claimed}:own`, "msg_01K4ZQPX0000000000000000A1:agt_main"],
    ]);
    for (const [session, runId, text] of [
      [claimed, "msg_01K4ZQPX0000000000000000A1", "I'll do A to J."],
      [`${claimed}:own`, "msg_01K4ZQPX0000000000000000A1:agt_main", "And I'll do 1 to 10."],
    ]) {
      bridge.onClaw({ event: "chat", payload: { runId, sessionKey: session, seq: 1, state: "final", message: text } });
    }
    await bridge.settled();
    const replies = sent.filter((event) => event.type === "message.post").map((event) => [event["text"], event["actor"]]);
    assert.deepEqual(replies, [
      ["I'll do A to J.", { kind: "agent", id: "agt_claimed" }],
      ["And I'll do 1 to 10.", { kind: "agent", id: "agt_main" }],
    ]);
    // A turn OpenClaw starts on its own in the OpenClaw agent's own session is said as it, there.
    sent = [];
    bridge.onClaw({ event: "chat", payload: { runId: "follow-1", sessionKey: `${claimed}:own`, seq: 1, state: "final", message: "Done." } });
    await bridge.settled();
    assert.equal(sent[0]?.["space_id"], ROOM);
    for (const event of sent) assert.deepEqual(event["actor"], { kind: "agent", id: "agt_main" });
  });

  it("claims a room under a key of the claim's own, so its OpenClaw agent, added later, is a conversation of its own", async () => {
    agents = [agentIn("agt_fallback", ME, OTHER_ROOM), agentIn("agt_main", "main", null)];
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    const asked = "spc_01K4ZQPX000000000000000099";
    await bridge.onChips({ type: "space.created", space_id: asked, asked_of: ME, kind: "direct" });
    await bridge.onChips(said("Collab one", { space_id: asked, addressed_to: [ME], for: [ME] }));
    assert.deepEqual(claims.map(([room, claimKey]) => [room, claimKey]), [[asked, bridge.claimKeyFor(asked)]]);
    await bridge.onChips({ type: "agent.attached", agent_id: "agt_main", space_id: asked, by: ARJUN.participant_id });
    calls = [];
    const claimAgent = `agt_${bridge.claimKeyFor(asked)}`;
    await bridge.onChips(
      said("Hey both", { space_id: asked, message_id: "msg_01K4ZQPX0000000000000000A2", addressed_to: [claimAgent, "agt_main"], for: [claimAgent, "agt_main"] }),
    );
    const sessions = calls.filter(([method]) => method === "chat.send").map(([, params]) => params["sessionKey"]);
    assert.deepEqual(sessions, [bridge.claimKeyFor(asked), bridge.keyFor(asked, "main")]);
    assert.equal(claims.length, 1);
  });

  it("answers the first words in a room asked of it when Chips names the harness only in addressed_to", async () => {
    // Chips before the agents review (its finding 31) left the harness out of `for`.
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    const asked = "spc_01K4ZQPX000000000000000099";
    await bridge.onChips({ type: "space.created", space_id: asked, asked_of: ME, kind: "direct" });
    calls = [];
    await bridge.onChips(said("Collab one", { space_id: asked, addressed_to: [ME], for: [] }));
    assert.deepEqual(claims.map(([room, claimKey]) => [room, claimKey]), [[asked, bridge.claimKeyFor(asked)]]);
    assert.equal(calls.find(([method]) => method === "chat.send")?.[1]["sessionKey"], bridge.claimKeyFor(asked));
  });

  it("leaves a room asked of it unclaimed when a message there is for its OpenClaw agent alone, and answers as that agent", async () => {
    agents = [agentIn("agt_fallback", ME, OTHER_ROOM), agentIn("agt_main", "main", null)];
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    const asked = "spc_01K4ZQPX000000000000000099";
    await bridge.onChips({ type: "space.created", space_id: asked, asked_of: ME, kind: "direct" });
    await bridge.onChips({ type: "agent.attached", agent_id: "agt_main", space_id: asked, by: ARJUN.participant_id });
    calls = [];
    await bridge.onChips(said("@OpenClaw hi", { space_id: asked, addressed_to: ["agt_main"], for: ["agt_main"] }));
    assert.equal(claims.length, 0);
    assert.equal(calls.find(([method]) => method === "chat.send")?.[1]["sessionKey"], bridge.keyFor(asked, "main"));
    bridge.onClaw({ event: "chat", payload: { runId: "msg_01K4ZQPX0000000000000000A1", sessionKey: bridge.keyFor(asked, "main"), seq: 1, state: "final", message: "Hi." } });
    await bridge.settled();
    assert.deepEqual(sent.find((event) => event.type === "message.post")?.["actor"], { kind: "agent", id: "agt_main" });
    // The harness itself, spoken to there next, claims it.
    await bridge.onChips(said("Plan it", { space_id: asked, message_id: "msg_01K4ZQPX0000000000000000A2", addressed_to: [ME], for: [ME] }));
    assert.deepEqual(claims.map(([room, claimKey]) => [room, claimKey]), [[asked, bridge.claimKeyFor(asked)]]);
  });

  it("says a turn OpenClaw starts on its own in a claim's session no agent has yet as the harness itself", async () => {
    agents = [agentIn("agt_fallback", ME, OTHER_ROOM), agentIn("agt_main", "main", ROOM)];
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    bridge.onClaw({ event: "chat", payload: { runId: "cron-3", sessionKey: bridge.claimKeyFor(ROOM), seq: 1, state: "final", message: "Still here." } });
    await bridge.settled();
    assert.equal(sent[0]?.["space_id"], ROOM);
    // Not as OpenClaw's own agent, which is in that room too: the session is not its.
    for (const event of sent) assert.equal(event["actor"], undefined);
  });

  it("gives the default agent a conversation of its own in a room its primary agent's own agent is in too", async () => {
    agents = [agentIn("agt_fallback", ME, ROOM), agentIn("agt_main", "main", ROOM)];
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    calls = [];
    await bridge.onChips(said("Both of you?", { addressed_to: ["agt_fallback", "agt_main"], for: ["agt_fallback", "agt_main"] }));
    const sessions = calls.filter(([method]) => method === "chat.send").map(([, params]) => params["sessionKey"]);
    assert.deepEqual(sessions, [`${key()}:default`, key()]);
    assert.deepEqual(attached, []);
    bridge.onClaw({ event: "chat", payload: { runId: "follow-2", sessionKey: `${key()}:default`, seq: 1, state: "final", message: "Here." } });
    await bridge.settled();
    for (const event of sent) assert.deepEqual(event["actor"], { kind: "agent", id: "agt_fallback" });
  });

  /** A line of the room, as Chips reads one. */
  function line(seq: number, from: { id: string; name: string; kind?: string }, text: string, addressed: string[] = []) {
    return { seq, kind: "said", from: { kind: "person", ...from }, text, addressed_to: addressed };
  }

  it("hands an agent's first turn in a room the room's recent lines, which its conversation may not have", async () => {
    // As for OpenClaw's own agent in Arjun's room after its conversation was named afresh: Chips's
    // context starts after its own last message there, and the conversation never saw what came
    // before it.
    agents = [agentIn("agt_fallback", ME, OTHER_ROOM), agentIn("agt_main", "main", ROOM), agentIn("agt_claimed", bridge.keyFor(ROOM), ROOM)];
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    roomLines = [
      line(3, ARJUN_FROM, "Hey both, build an ASCII gallery", ["agt_claimed", "agt_main"]),
      line(4, { id: "agt_claimed", name: "OpenClaw", kind: "agent" }, "I made A to J."),
      line(5, { id: "agt_main", name: "OpenClaw", kind: "agent" }, "No browser for a screenshot."),
    ];
    calls = [];
    await bridge.onChips(
      said("What did each of you do?", {
        seq: 7,
        addressed_to: ["agt_main"],
        for: ["agt_main"],
        context: { lines: [line(6, ARJUN_FROM, "Thanks both")], since_seq: 5, truncated: false, before: 6 },
      }),
    );
    assert.deepEqual(pulls, [[ROOM, 6, 20]]);
    assert.equal(
      calls.find(([method]) => method === "chat.send")?.[1]["message"],
      // Every line, the request it took no turn on in this conversation among them, and its own words as its own.
      told("Said in this room lately:\nArjun: Hey both, build an ASCII gallery\nOpenClaw: I made A to J.\nYou: No browser for a screenshot.\nArjun: Thanks both\n\nWhat did each of you do?"),
    );
    // Once: its next turn there is handed what Chips carries, and what it missed while it went.
    pulls = [];
    await bridge.onChips(
      said("And now?", { seq: 9, message_id: "msg_01K4ZQPX0000000000000000A2", addressed_to: ["agt_main"], for: ["agt_main"], context: { lines: [], since_seq: 7, truncated: false, before: 9 } }),
    );
    assert.deepEqual(pulls, []);
  });

  it("hands an agent next time what was said while its last turn was going: another agent's answer to the same message", async () => {
    agents = [agentIn("agt_fallback", ME, OTHER_ROOM), agentIn("agt_main", "main", ROOM), agentIn("agt_claimed", bridge.keyFor(ROOM), ROOM)];
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    const both = { addressed_to: ["agt_claimed", "agt_main"], for: ["agt_claimed", "agt_main"] };
    await bridge.onChips(said("Hey both", { seq: 10, ...both, context: { lines: [], since_seq: 9, truncated: false, before: 10 } }));
    // The two answer side by side; the room's own agent lands first.
    roomLines = [
      line(10, ARJUN_FROM, "Hey both", ["agt_claimed", "agt_main"]),
      line(11, { id: "agt_claimed", name: "OpenClaw", kind: "agent" }, "I'll do the letters."),
      line(12, { id: "agt_main", name: "OpenClaw", kind: "agent" }, "I'll do the numbers."),
    ];
    calls = [];
    pulls = [];
    // Chips's context for OpenClaw's own agent starts after its own answer, 12.
    await bridge.onChips(
      said("@OpenClaw go on", { seq: 13, message_id: "msg_01K4ZQPX0000000000000000A2", addressed_to: ["agt_main"], for: ["agt_main"], context: { lines: [], since_seq: 12, truncated: false, before: 13 } }),
    );
    assert.deepEqual(pulls, [[ROOM, 13, 20]]);
    // The other's answer, and not its own, which it said in this conversation.
    assert.equal(calls.find(([method]) => method === "chat.send")?.[1]["message"], told("Said in this room since you last spoke:\nOpenClaw: I'll do the letters.\n\n@OpenClaw go on"));
  });

  it("keeps a line meant for another of its agents in an agent's catch-up: that was a turn in another conversation", async () => {
    agents = [agentIn("agt_fallback", ME, OTHER_ROOM), agentIn("agt_main", "main", ROOM), agentIn("agt_claimed", bridge.keyFor(ROOM), ROOM)];
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    const context = { lines: [line(20, ARJUN_FROM, "@claimed only you", ["agt_claimed"])], since_seq: 19, truncated: false, before: 20 };
    await bridge.onChips(said("Over to you", { seq: 21, addressed_to: ["agt_main"], for: ["agt_main"], context }));
    assert.equal(
      calls.find(([method]) => method === "chat.send")?.[1]["message"],
      told("Said in this room since you last spoke:\nArjun: @claimed only you\n\nOver to you"),
    );
    calls = [];
    // The agent it was for had a turn on it, in its own conversation.
    await bridge.onChips(said("And you?", { seq: 22, message_id: "msg_01K4ZQPX0000000000000000A2", addressed_to: ["agt_claimed"], for: ["agt_claimed"], context }));
    assert.equal(calls.find(([method]) => method === "chat.send")?.[1]["message"], told("And you?"));
  });

  it("reads nothing more of the room when Chips's pull route will not answer", async () => {
    const failing = { ...chips, roomContext: async () => Promise.reject(new Error("no")) };
    const quiet = new Bridge(failing, claw, { harnessId: ME, agent: "main" }, () => undefined);
    await quiet.onChips(said("Hi", { addressed_to: [ME], context: { lines: [], since_seq: 4, truncated: false, before: 5 } }));
    assert.equal(calls.find(([method]) => method === "chat.send")?.[1]["message"], told("Hi"));
  });

  it("before the harness declares agents, answers in the room as the agent Chips has there", async () => {
    agents = [FALLBACK, agentIn("agt_main", "main", ROOM)];
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    await bridge.onChips(said("Hi", { addressed_to: [ME] }));
    bridge.onClaw({
      event: "chat",
      payload: { runId: "msg_01K4ZQPX0000000000000000A1", sessionKey: key(), seq: 1, state: "final", message: "Hello." },
    });
    await bridge.settled();
    assert.deepEqual(attached, []);
    assert.deepEqual(sent.find((event) => event.type === "message.post")?.["actor"], { kind: "agent", id: "agt_main" });
  });
});

describe("an OpenClaw agent of its own for each agent Chips asks for", () => {
  const ASKED = "spc_01K4ZQPX000000000000000099";
  const MADE = "chips-01k4zqpx000000000000000099";
  const OTHER_ROOM = "spc_01K4ZQPX000000000000000077";

  it("makes one for a room asked from the +, takes the turn in it, and names it as Chips named its agent", async () => {
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    calls = [];
    await bridge.onChips({ type: "space.created", space_id: ASKED, asked_of: ME, kind: "direct" });
    await bridge.onChips(said("Plan a picnic", { space_id: ASKED, addressed_to: [ME], for: [ME] }));
    const session = bridge.keyFor(ASKED, MADE);
    // Made, then listed; named, then listed by that name: each a config change the gateway takes
    // in before the agent is sent a turn.
    assert.deepEqual(calls.map(([method]) => method), ["agents.create", "agents.list", "sessions.create", "agents.update", "agents.list", "chat.send"]);
    assert.deepEqual(calls[0]?.[1], { name: MADE, workspace: `/home/node/.openclaw/chips/${MADE}` });
    assert.deepEqual(calls[2]?.[1], { key: session, agentId: MADE, displayName: "Plan a picnic" });
    assert.deepEqual(calls[3]?.[1], { agentId: MADE, name: "OpenClaw" });
    assert.equal(calls[5]?.[1]["sessionKey"], session);
    assert.deepEqual(claims.map(([room, claimKey]) => [room, claimKey]), [[ASKED, session]]);
  });

  it("asks for the made agent's session only once the gateway lists it", async () => {
    listLag = 3;
    await bridge.onChips({ type: "space.created", space_id: ASKED, asked_of: ME, kind: "direct" });
    await bridge.onChips(said("Plan a picnic", { space_id: ASKED, addressed_to: [ME], for: [ME] }));
    assert.deepEqual(calls.map(([method]) => method), ["agents.create", "agents.list", "agents.list", "agents.list", "sessions.create", "agents.update", "agents.list", "chat.send"]);
    assert.equal(calls.find(([method]) => method === "chat.send")?.[1]["sessionKey"], bridge.keyFor(ASKED, MADE));
  });

  it("claims nothing and takes no turn when OpenClaw will not make one, and tries again on the next words", async () => {
    refuseClaw = new Set(["agents.create"]);
    await bridge.onChips({ type: "space.created", space_id: ASKED, asked_of: ME, kind: "direct" });
    await bridge.onChips(said("Plan a picnic", { space_id: ASKED, addressed_to: [ME], for: [ME] }));
    // Never a conversation of the primary agent's in its place (ruling 15, 7 October 2026).
    assert.deepEqual(calls.map(([method]) => method), ["agents.create", "agents.list"]);
    assert.equal(claims.length, 0);
    refuseClaw = new Set();
    calls = [];
    await bridge.onChips(said("Still there?", { space_id: ASKED, message_id: "msg_01K4ZQPX0000000000000000A2", addressed_to: [ME], for: [ME] }));
    assert.deepEqual(claims.map(([room, claimKey]) => [room, claimKey]), [[ASKED, bridge.keyFor(ASKED, MADE)]]);
    assert.equal(calls.find(([method]) => method === "chat.send")?.[1]["sessionKey"], bridge.keyFor(ASKED, MADE));
  });

  it("asks Chips for no new agent when OpenClaw will not make one", async () => {
    refuseClaw = new Set(["agents.create"]);
    await bridge.onChips({ type: "agent.asked", id: "evt_01K4ZQPX0000000000000000N1", ts: new Date().toISOString(), space_id: ROOM, harness_id: ME, name: "Reviewer", by: ARJUN.participant_id });
    assert.deepEqual(calls.map(([method]) => method), ["agents.create", "agents.list"]);
    assert.deepEqual(registered, []);
  });

  it("takes one OpenClaw has already, made before a restart, as made", async () => {
    refuseClaw = new Set(["agents.create"]);
    clawAgents = [{ id: "main" }, { id: MADE }];
    await bridge.onChips({ type: "space.created", space_id: ASKED, asked_of: ME, kind: "direct" });
    await bridge.onChips(said("Plan a picnic", { space_id: ASKED, addressed_to: [ME], for: [ME] }));
    assert.equal(calls.find(([method]) => method === "chat.send")?.[1]["sessionKey"], bridge.keyFor(ASKED, MADE));
  });

  it("makes one for a new agent asked for in a room, named as Chips named the agent (ADR 0108)", async () => {
    const ask = "evt_01K4ZQPX0000000000000000N1";
    const made = "chips-01k4zqpx0000000000000000n1";
    await bridge.onChips({ type: "agent.asked", id: ask, ts: new Date().toISOString(), space_id: ROOM, harness_id: ME, name: "Reviewer", by: ARJUN.participant_id });
    assert.deepEqual(calls.map(([method]) => method), ["agents.create", "agents.list", "agents.update", "agents.list"]);
    assert.deepEqual(calls[2]?.[1], { agentId: made, name: "Reviewer" });
    assert.deepEqual(registered, [{ key: bridge.keyFor(ROOM, made), name: "Reviewer", made_for: ask, space_id: ROOM }]);
  });

  it("unmakes the OpenClaw agent of a new agent Chips refuses", async () => {
    const refusing: ChipsPort = {
      ...chips,
      registerAgent: async () => {
        throw new ChipsRefusal(409, "conflict", "That room has an agent of that name.");
      },
    };
    const quiet = new Bridge(refusing, claw, { harnessId: ME, agent: "main" }, () => undefined);
    await quiet.onChips({ type: "agent.asked", id: "evt_01K4ZQPX0000000000000000N1", ts: new Date().toISOString(), space_id: ROOM, harness_id: ME, name: "Reviewer", by: ARJUN.participant_id });
    assert.deepEqual(calls.map(([method]) => method), ["agents.create", "agents.list", "agents.delete"]);
    assert.deepEqual(calls[2]?.[1], { agentId: "chips-01k4zqpx0000000000000000n1", deleteFiles: true });
  });

  it("deletes the OpenClaw agent it made when its agent is deleted in Chips, and never one it did not make", async () => {
    agents = [agentIn("agt_main", "main", OTHER_ROOM), agentIn("agt_made", bridge.keyFor(ROOM, MADE), ROOM, "O3")];
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    calls = [];
    await bridge.onChips({ type: "agent.deleted", agent_id: "agt_made", harness_id: ME, key: bridge.keyFor(ROOM, MADE), name: "O3", by: ARJUN.participant_id });
    await bridge.onChips({ type: "agent.deleted", agent_id: "agt_main", harness_id: ME, key: "main", name: "OpenClaw", by: ARJUN.participant_id });
    assert.deepEqual(calls, [["agents.delete", { agentId: MADE, deleteFiles: true }]]);
    assert.equal(bridge.isOwn("agt_made"), false);
  });

  it("renames the OpenClaw agent it made when Chips renames its agent, and no other", async () => {
    agents = [agentIn("agt_main", "main", OTHER_ROOM), agentIn("agt_made", bridge.keyFor(ROOM, MADE), ROOM, "O3")];
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    calls = [];
    clawAgents = [{ id: "main" }, { id: MADE, name: "O3" }];
    await bridge.onChips({ type: "agent.updated", agent_id: "agt_made", name: "Scout" });
    await bridge.onChips({ type: "agent.updated", agent_id: "agt_main", name: "Main" });
    assert.deepEqual(calls, [["agents.update", { agentId: MADE, name: "Scout" }], ["agents.list", {}]]);
  });

  it("does not take the agents it made as OpenClaw agents of their own when it lists OpenClaw's", async () => {
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }, { id: MADE }, { id: "scout", name: "Scout" }] });
    assert.deepEqual(registered.map((each) => each["key"]), [bridge.mainKey(), "scout"]);
  });

  it("reads a file a made agent's answer names from its own folder", async () => {
    const asked: [string, string | undefined][] = [];
    const files: FilesPort = {
      read: async (reference, workspace) => {
        asked.push([reference, workspace]);
        return { kind: "file", filename: reference, bytes: Buffer.from("page") };
      },
    };
    const session = bridge.keyFor(ROOM, MADE);
    agents = [agentIn("agt_made", session, ROOM, "O3")];
    bridge = new Bridge(chips, claw, { harnessId: ME, agent: "main" }, () => undefined, files);
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    await bridge.onChips(said("@O3 make a page", { addressed_to: ["agt_made"], for: ["agt_made"] }));
    const R1 = `msg_01K4ZQPX0000000000000000A1:${MADE}`;
    const stream = { runId: R1, sessionKey: session, stream: "assistant" };
    bridge.onClaw({ event: "chat", payload: { runId: R1, sessionKey: session, seq: 1, state: "status" } });
    bridge.onClaw({ event: "agent", payload: { ...stream, seq: 2, data: { text: "Here.", delta: "", mediaUrls: ["page.html"], phase: "final_answer" } } });
    bridge.onClaw({ event: "chat", payload: { runId: R1, sessionKey: session, seq: 3, state: "final", message: "Here." } });
    await bridge.settled();
    assert.deepEqual(asked, [["page.html", `/home/node/.openclaw/chips/${MADE}`]]);
  });

  it("sends a turn again, once, as the same run, when OpenClaw refused it for a config change as it began", async () => {
    const R1 = "msg_01K4ZQPX0000000000000000A1";
    const replaced = "PreparedModelCatalogConfigReplacedError: prepared model catalog owner config was replaced during the read (/home/node/.openclaw/agents/main/agent)";
    await bridge.onChips(said("What can you do?"));
    bridge.onClaw({ event: "chat", payload: { runId: R1, sessionKey: key(), seq: 1, state: "error", errorMessage: replaced } });
    await bridge.settled();
    assert.deepEqual(sent.map((event) => event.type), ["run.started"]);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const sends = calls.filter(([method]) => method === "chat.send").map(([, params]) => params);
    assert.deepEqual(sends.map((params) => params["idempotencyKey"]), [R1, `${R1}:again`]);
    assert.equal(sends[1]?.["message"], sends[0]?.["message"]);
    bridge.onClaw({ event: "chat", payload: { runId: `${R1}:again`, sessionKey: key(), seq: 1, state: "final", message: "Plenty." } });
    await bridge.settled();
    assert.deepEqual(sent.map((event) => event.type), ["run.started", "message.post", "run.completed"]);
    // One run in Chips: the turn sent again goes on with the run its first sending started.
    assert.equal(sent[2]?.["run_id"], sent[0]?.["run_id"]);
  });

  it("sends a turn again, once, when its model timed out as OpenClaw took in a config change", async () => {
    // The Tic Tac Toe runs, 17 October 2026: a made agent's first turn began as the gateway took in
    // its name, and the Codex harness's model list timed out during the reload.
    const R1 = "msg_01K4ZQPX0000000000000000A1";
    await bridge.onChips(said("Build a game"));
    bridge.onClaw({ event: "chat", payload: { runId: R1, sessionKey: key(), seq: 1, state: "error", errorMessage: "Error: codex app-server request timed out" } });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const sends = calls.filter(([method]) => method === "chat.send").map(([, params]) => params);
    assert.deepEqual(sends.map((params) => params["idempotencyKey"]), [R1, `${R1}:again`]);
    bridge.onClaw({ event: "chat", payload: { runId: `${R1}:again`, sessionKey: key(), seq: 1, state: "final", message: "Done." } });
    await bridge.settled();
    assert.deepEqual(sent.map((event) => event.type), ["run.started", "message.post", "run.completed"]);
  });

  it("fails a turn refused for a config change a second time, and any other failure at once", async () => {
    const R1 = "msg_01K4ZQPX0000000000000000A1";
    const replaced = "PreparedModelCatalogConfigReplacedError: prepared model catalog owner config was replaced during the read (x)";
    await bridge.onChips(said("What can you do?"));
    bridge.onClaw({ event: "chat", payload: { runId: R1, sessionKey: key(), seq: 1, state: "error", errorMessage: replaced } });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    bridge.onClaw({ event: "chat", payload: { runId: `${R1}:again`, sessionKey: key(), seq: 1, state: "error", errorMessage: replaced } });
    await bridge.settled();
    assert.deepEqual(sent.map((event) => event.type), ["run.started", "run.failed"]);
    sent = [];
    await bridge.onChips(said("Again?", { message_id: "msg_01K4ZQPX0000000000000000A2" }));
    bridge.onClaw({ event: "chat", payload: { runId: "msg_01K4ZQPX0000000000000000A2", sessionKey: key(), seq: 1, state: "error", errorMessage: "rate limited" } });
    await bridge.settled();
    assert.deepEqual(sent.map((event) => event.type), ["run.started", "run.failed"]);
    assert.equal(calls.filter(([method]) => method === "chat.send").length, 3);
  });
});

describe("automations answer in the room they were asked in (Chips ADR 0157)", () => {
  /** An agent the bridge made for a room, keyed by its session there, as OpenClaw 3 was on scratch. */
  const MADE = "chips-01k4zqpx000000000000000002";
  const MADE_KEY = `agent:${MADE}:chips-spc_01k4zqpx000000000000000002`;
  const JOB = "3d340e0f-3477-4799-b510-9b598721a3a9";
  /** The job's run, a turn in a session of its own, as OpenClaw names it. */
  const RUN_KEY = `agent:${MADE}:cron:${JOB}:run:2911e849-3f56-4aa9-b06a-dcc1d5b01eb0`;
  const KIT = { participant_id: "usr_01K4ZQPX0000000000000000K1", kind: "person", display_name: "Kit Lee", role: "member" };
  /** Chips's note on the room (ADR 0092): who is here, with the @ that reaches each. */
  const members = (...people: (typeof ARJUN)[]) => ({
    members: [
      ...people.map((each) => ({ participant_id: each.participant_id, kind: "person", name: each.display_name, handle: `@${each.display_name.split(" ")[0]}` })),
      { participant_id: "agt_made", kind: "agent", name: "OpenClaw 3", handle: "@OpenClaw3" },
    ],
    notes: {},
  });
  /** OpenClaw's `cron` event, carrying the job as it does each time. */
  const cron = (action: string, job: Record<string, unknown> = {}) => ({
    event: "cron",
    payload: {
      jobId: JOB,
      action,
      job: { id: JOB, name: "Stretch reminder", owner: { agentId: MADE, sessionKey: MADE_KEY, accountId: "default" }, sessionKey: MADE_KEY, sessionTarget: "current", ...job },
    },
  });
  const answer = (text: string, runId = "649865b6-292c-4ae4-bbe0-6936b9204825") => ({
    event: "chat",
    payload: { runId, sessionKey: RUN_KEY, seq: 24, state: "final", message: { role: "assistant", content: [{ type: "text", text }] } },
  });
  /** What a `current` job commits to the conversation it was made in, as chat.history showed it on scratch. */
  const committed = (text: string, sessionKey = MADE_KEY) => ({
    event: "session.message",
    payload: {
      sessionKey,
      agentId: MADE,
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "openclaw-transcript",
        provider: "openclaw",
        model: "automation-result",
        idempotencyKey: `cron-current-completion:cron:${JOB}:1791885238801`,
        openclawAutomation: { kind: "cron", jobId: JOB, runId: `cron:${JOB}:1791885238801` },
      },
    },
  });

  async function asked(by = ARJUN, room = members(ARJUN)): Promise<void> {
    agents = [agentIn("agt_made", MADE_KEY, ROOM, "OpenClaw 3")];
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    await bridge.onChips(said("Remind me in 2 minutes to stretch.", { from: by, addressed_to: ["agt_made"], for: ["agt_made"], room }));
    sent = [];
  }

  it("says a job's run in the room whose turn made it, as its agent, for the person who asked", async () => {
    await asked(KIT, members(ARJUN, KIT));
    bridge.onClaw(cron("added"));
    bridge.onClaw(cron("started"));
    bridge.onClaw(answer("Reminder: stretch."));
    await bridge.settled();
    assert.deepEqual(sent.map((event) => event.type), ["run.started", "message.post", "run.completed"]);
    // A turn OpenClaw started on its own (no goal_from), named for the job.
    assert.equal(sent[0]?.["space_id"], ROOM);
    assert.equal(sent[0]?.["goal"], "Scheduled: Stretch reminder");
    assert.equal(sent[0]?.["goal_from"], undefined);
    // For Kit, who asked, though Arjun is in the room too.
    assert.equal(sent[1]?.["text"], "@Kit Reminder: stretch.");
    assert.equal(sent[2]?.["summary"], "@Kit Reminder: stretch.");
    for (const event of sent) assert.deepEqual(event["actor"], { kind: "agent", id: "agt_made" });
  });

  it("@s nobody more when the words @ somebody in the room already, and passes on NO_REPLY as it is", async () => {
    await asked();
    bridge.onClaw(cron("added"));
    bridge.onClaw(answer("@Arjun time to stretch.", "r1"));
    bridge.onClaw(answer("NO_REPLY", "r2"));
    await bridge.settled();
    assert.deepEqual(
      sent.filter((event) => event.type === "message.post").map((event) => event["text"]),
      ["@Arjun time to stretch.", "NO_REPLY"],
    );
  });

  it("@s the room's only person for a job it did not see made", async () => {
    await asked();
    // Learned from the job's start alone, as after a restart with nothing kept.
    bridge.onClaw(cron("started"));
    bridge.onClaw(answer("Reminder: stretch."));
    await bridge.settled();
    assert.equal(sent.find((event) => event.type === "message.post")?.["text"], "@Arjun Reminder: stretch.");
  });

  it("says nothing of a run whose job it has not heard of, or of a job made outside its rooms, and holds none of its events", async () => {
    await asked();
    // OpenClaw's own background work (Memory Dreaming), and a job made on another channel.
    bridge.onClaw(cron("added", { owner: { agentId: "main", sessionKey: "agent:main:telegram:direct:42" }, sessionKey: undefined }));
    bridge.onClaw({ event: "agent", payload: { runId: "dream", sessionKey: RUN_KEY, stream: "lifecycle", data: { phase: "model" } } });
    bridge.onClaw(answer("Promoted 3 memories.", "dream"));
    await bridge.settled();
    assert.deepEqual(sent, []);
    // What its events were held for until its end, with no room to say them in, is let go.
    assert.equal((bridge as unknown as { early: Map<string, unknown> }).early.size, 0);
  });

  it("posts what a current job commits to the room's conversation when its run went unseen, as the room's agent, once", async () => {
    await asked();
    bridge.onClaw(cron("added"));
    bridge.onClaw(committed("Reminder: stretch."));
    bridge.onClaw(committed("Reminder: stretch."));
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(sent[0], {
      type: "message.post",
      space_id: ROOM,
      text: "@Arjun Reminder: stretch.",
      actor: { kind: "agent", id: "agt_made" },
      idempotency_key: `openclaw-automation:${JOB}:1791885238801`,
    });
    // Heard twice, the same key: Chips takes it once.
    assert.equal(sent[1]?.["idempotency_key"], sent[0]?.["idempotency_key"]);
  });

  it("does not post the commit of a run whose answer it posted: those are the same words", async () => {
    await asked();
    bridge.onClaw(cron("added"));
    // On scratch the commit came half a second after the run's final.
    bridge.onClaw(answer("Reminder: stretch."));
    bridge.onClaw(committed("Reminder: stretch."));
    await bridge.settled();
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(sent.map((event) => event.type), ["run.started", "message.post", "run.completed"]);
  });

  it("posts nothing for a silent commit, one in none of its rooms, or a message no automation made", async () => {
    await asked();
    bridge.onClaw(committed("NO_REPLY"));
    bridge.onClaw(committed("Reminder: stretch.", "agent:ops:telegram:direct:42"));
    bridge.onClaw({ event: "session.message", payload: { sessionKey: MADE_KEY, message: { role: "assistant", content: [{ type: "text", text: "Hi." }] } } });
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(sent, []);
  });

  it("asks a job's run's approvals as cards in its room", async () => {
    await asked();
    bridge.onClaw(cron("started"));
    bridge.onClaw({
      event: "exec.approval.requested",
      payload: { id: "ap-9", request: { command: "curl wttr.in", sessionKey: RUN_KEY, runId: "r9", systemRunPlan: { commandText: "curl wttr.in" } } },
    });
    await bridge.settled();
    assert.deepEqual(sent.map((event) => event.type), ["run.started", "approval.request"]);
    assert.equal(sent[0]?.["space_id"], ROOM);
    assert.equal(sent[1]?.["run_id"], sent[0]?.["run_id"]);
  });

  it("keeps who a job is for across a restart, learns its room again from its next event, and forgets it once removed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "automations-"));
    const file = join(dir, "automations.json");
    try {
      bridge = new Bridge(chips, claw, { harnessId: ME, agent: "main" }, () => undefined, undefined, Date.now, undefined, undefined, undefined, undefined, undefined, new Automations(file));
      await asked(KIT, members(ARJUN, KIT));
      bridge.onClaw(cron("added"));
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { [JOB]: { id: KIT.participant_id, handle: "@Kit" } });
      // Restarted: no note heard yet, nothing in memory.
      bridge = new Bridge(chips, claw, { harnessId: ME, agent: "main" }, () => undefined, undefined, Date.now, undefined, undefined, undefined, undefined, undefined, new Automations(file));
      await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
      sent = [];
      bridge.onClaw(cron("started"));
      bridge.onClaw(answer("Reminder: stretch."));
      await bridge.settled();
      assert.equal(sent.find((event) => event.type === "message.post")?.["text"], "@Kit Reminder: stretch.");
      bridge.onClaw({ event: "cron", payload: { jobId: JOB, action: "removed" } });
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tells every turn to schedule in its conversation, with the offset Chips gives", async () => {
    await asked();
    const message = String(calls.findLast(([method]) => method === "chat.send")?.[1]["message"]);
    assert.ok(message.includes(SPEAKING_LATER));
    assert.match(SPEAKING_LATER, /sessionTarget "current"/);
    // An isolated job's announce has no route here: OpenClaw would keep it disabled after it ran.
    assert.match(SPEAKING_LATER, /"isolated" with delivery \{mode: "none"\}/);
    assert.match(SPEAKING_LATER, /without one is read as UTC/);
  });
});
