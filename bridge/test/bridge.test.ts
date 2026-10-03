/**
 * The mapping, one row of the plan's table at a time, between two stand-ins that record what they
 * are asked. No OpenClaw and no Chips needed.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  Bridge,
  type ChipsPort,
  type ClawPort,
  type FilesPort,
  heardIn,
  textOf,
  titleFrom,
  usageOf,
  wordsOf,
} from "../src/bridge.ts";
import { type ChipsAgent, type ChipsEvent, ChipsRefusal, type Taken } from "../src/chips.ts";

const ME = "hrn_01K4ZQPX000000000000000004";
const ROOM = "spc_01K4ZQPX000000000000000002";
const ARJUN = { participant_id: "usr_01K4ZQPX000000000000000003", kind: "person", display_name: "Arjun", role: "owner" };
/** Arjun as a line of the room names him. */
const ARJUN_FROM = { id: ARJUN.participant_id, name: "Arjun" };

let sent: ChipsEvent[] = [];
let claims: [string, string, string | undefined][] = [];
let calls: [string, Record<string, unknown>][] = [];
/** This harness's agents as Chips keeps them, one room each (ADR 0087), and what attaching did. */
let agents: ChipsAgent[] = [];
let attached: [string, string, string][] = [];
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
let bridge: Bridge;

/** One of our agents as Chips lists it, in one room or in none. */
function agentIn(agentId: string, key: string, room: string | null, name = "OpenClaw"): ChipsAgent {
  return { agent_id: agentId, key, name, lead: false, state: "active", spaces: room === null ? [] : [room], room };
}

const chips: ChipsPort = {
  send: async (event) => {
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
  registerAgent: async ({ key, name }) => {
    const had = agents.find((each) => each.key === key);
    const agent: ChipsAgent = had === undefined ? agentIn(`agt_${key}`, key, null, name) : { ...had, name };
    agents = [...agents.filter((each) => each.key !== key), agent];
    return agent;
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
const claw: ClawPort = {
  request: async <T>(method: string, params: Record<string, unknown>) => {
    calls.push([method, params]);
    return {} as T;
  },
};

beforeEach(() => {
  sent = [];
  claims = [];
  calls = [];
  agents = [];
  attached = [];
  roomLines = [];
  pulls = [];
  uploads = [];
  holdPosts = undefined;
  refusePost = undefined;
  fetched = [];
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
    // A claim's key has a shape of its own, and so do sessions named for whose they are.
    assert.equal(bridge.claimKeyFor(ROOM), "agent:main:chips-spc_01k4zqpx000000000000000002:asked");
    for (const whose of ["asked", "own", "default"]) assert.equal(bridge.spaceFor(`${key()}:${whose}`), ROOM);
    assert.equal(bridge.spaceFor(`${key()}:somebody`), undefined);
  });

  it("sends a person's words to the room's session, made once, keyed by the message", async () => {
    await bridge.onChips(said("What can you do?"));
    await bridge.onChips(said("And briefly?", { message_id: "msg_01K4ZQPX0000000000000000A2" }));
    assert.deepEqual(calls.map(([method]) => method), ["sessions.create", "chat.send", "chat.send"]);
    assert.equal(calls[0]?.[1]["key"], key());
    assert.deepEqual(calls[1]?.[1], { sessionKey: key(), message: "What can you do?", idempotencyKey: "msg_01K4ZQPX0000000000000000A1", queueMode: "steer" });
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
      "J Bot (an agent in this room) said this to you. Everyone here reads your answer; J Bot acts on it only if you address it as @JBot:\nIs main green?",
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
    assert.equal(calls.find(([method]) => method === "chat.send")?.[1]["message"], "@OpenClaw and the build?");
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
      "Said in this room since you last spoke:\nArjun: @Jacobian the notes?\nJacobian: Drafted, in the doc.\n(Dana joined the room)\n\n@OpenClaw what did Jacobian say?",
    );
    // A turn Chips hands nothing with is told nothing, whatever was overheard before it.
    await bridge.onChips({ ...said("an overheard line"), type: "message.overheard" });
    await bridge.onChips(said("Thanks", { message_id: "msg_01K4ZQPX0000000000000000A3" }));
    assert.equal(calls.filter(([method]) => method === "chat.send").at(-1)?.[1]["message"], "Thanks");
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
    assert.equal(sent.at(-1)?.["summary"], "No reply of its own; answered in the next turn.");
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
    const HANDED =
      "Files in this room, attached at their current version: ascii-alphabet.html (v2, by Oc3). To change one, send it back under the same name: Chips takes it as the next version.";

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
      assert.equal(sends()[1]?.["message"], "Still on ascii-alphabet.html?");
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
      assert.equal(sends()[0]?.["message"], "Here is ascii-alphabet.html v2");
      answers("Took it further.", [`${WORKSPACE}/ascii-alphabet.html`]);
      await bridge.settled();
      assert.deepEqual(sent.find((event) => event.type === "message.post")?.["replaces"], {
        att_01K4ZQPX000000000000000001: GALLERY["attachment_id"],
      });
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
          "Files in this room, attached at their current version: ascii-alphabet.html (v3, by Oc2). To change one, send it back under the same name: Chips takes it as the next version.",
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
    await bridge.onChips({ type: "approval.resolved", approval_id: card?.["approval_id"], decision: "approved", scope: "always" });
    assert.deepEqual(calls, [["plugin.approval.resolve", { id: "plugin:ap-3", decision: "allow-always" }]]);
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
      [["main", "OpenClaw"], ["scout", "Scout"]],
    );
    // An agent is in one room at a time: putting each in the default agent's rooms at start, as
    // the bridge did before, would have Chips refuse all but one. Each stays where Chips has it.
    assert.deepEqual(attached, []);
    assert.equal(agents.find((each) => each.key === ME)?.room, ROOM);
  });

  it("serves only OPENCLAW_AGENT when it is set", async () => {
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }, { id: "scout" }] }, "main");
    assert.deepEqual(agents.filter((each) => each.key !== ME).map((each) => each.key), ["main"]);
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
    agents = [agentIn("agt_fallback", ME, later)];
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
    assert.deepEqual(calls[1]?.[1], { sessionKey: carried, message: "Still there?", idempotencyKey: "msg_01K4ZQPX0000000000000000A1:agt_carried", queueMode: "steer" });
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
      ["Said in this room since you last spoke:\nDana: Book the table\n(Arjun joined the room)\nArjun: Hi all\n\n@OpenClaw which one?", "Thanks"],
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
    assert.equal(calls.find(([method]) => method === "chat.send")?.[1]["message"], "And a blanket");
  });

  it("puts Chips's room note first, and says the @ rule once (Chips ADR 0092)", async () => {
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
      `${note}\n\nSaid in this room since you last spoke:\nArjun: Five letters each.\n\nHello (an agent in this room) said this to you:\n@OpenClaw F–J are yours.`,
    );
  });

  it("gives each of our agents taking the turn its own note", async () => {
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
    assert.deepEqual(sends.sort(), ["Note for kit.\n\n@all which of you?", "Note for main.\n\n@all which of you?"]);
  });

  it("gives the harness its own note where it takes the turn itself, as in a room it was asked for", async () => {
    await bridge.onChips({ type: "space.created", space_id: ROOM, asked_of: ME, kind: "direct" });
    await bridge.onChips(said("Plan a picnic", { for: [ME], addressed_to: [ME], room: { members: [], notes: { [ME]: "In this room: …" } } }));
    assert.equal(calls.find(([method]) => method === "chat.send")?.[1]["message"], "In this room: …\n\nPlan a picnic");
  });

  it("leads with Chips's word on the agents' talk, as Chips's, ahead of the room note and the words (the referee)", async () => {
    const word = "The agents here have sent each other 9 messages since Arjun last acted, 21 minutes ago.";
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
      `Chips: ${word}\n\nIn this room: …\n\nHello (an agent in this room) said this to you:\n@OpenClaw send K–O`,
    );
  });

  it("says nothing of the agents' talk from a Chips that sends no word on it", async () => {
    await bridge.onChips(said("Plan a picnic", { exchange: { count: 3, stage: "quiet" } }));
    assert.equal(calls.find(([method]) => method === "chat.send")?.[1]["message"], "Plan a picnic");
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
      "Chips: Your last message here was held, so the agents it named do not have it yet: messages between the agents in this room are held (they have sent each other 48 since a person last acted) until a person acts. Until then, tell the person what is done and what is blocked, rather than asking the agents again.\n\nWhere are we?",
    );
    assert.equal(sends[2], "Thanks");
  });

  it("says nothing of an answer Chips handed over", async () => {
    await bridge.onChips(said("Hi"));
    bridge.onClaw({
      event: "chat",
      payload: { runId: "msg_01K4ZQPX0000000000000000A1", sessionKey: key(), seq: 1, state: "final", message: { role: "assistant", content: "Hello." } },
    });
    await bridge.settled();
    await bridge.onChips(said("Again", { message_id: "msg_01K4ZQPX0000000000000000A2" }));
    assert.equal(calls.filter(([method]) => method === "chat.send").at(-1)?.[1]["message"], "Again");
  });

  it("takes an agent's words when Chips names it kind agent, and never its own agents' words", async () => {
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    calls = [];
    const hello = { participant_id: "agt_hello", kind: "agent", display_name: "Hello", role: "member" };
    await bridge.onChips(said("@OpenClaw what number?", { from: hello, addressed_to: ["agt_main"], for: ["agt_main"] }));
    assert.match(String(calls.find(([method]) => method === "chat.send")?.[1]["message"]), /^Hello \(an agent in this room\)/);
    calls = [];
    const mine = { participant_id: "agt_main", kind: "agent", display_name: "OpenClaw", role: "member" };
    await bridge.onChips(said("Ten.", { from: mine, addressed_to: ["agt_main"], for: ["agt_main"] }));
    assert.equal(calls.length, 0);
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
      "Said in this room lately:\nArjun: Hey both, build an ASCII gallery\nOpenClaw: I made A to J.\nYou: No browser for a screenshot.\nArjun: Thanks both\n\nWhat did each of you do?",
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
    assert.equal(calls.find(([method]) => method === "chat.send")?.[1]["message"], "Said in this room since you last spoke:\nOpenClaw: I'll do the letters.\n\n@OpenClaw go on");
  });

  it("keeps a line meant for another of its agents in an agent's catch-up: that was a turn in another conversation", async () => {
    agents = [agentIn("agt_fallback", ME, OTHER_ROOM), agentIn("agt_main", "main", ROOM), agentIn("agt_claimed", bridge.keyFor(ROOM), ROOM)];
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    const context = { lines: [line(20, ARJUN_FROM, "@claimed only you", ["agt_claimed"])], since_seq: 19, truncated: false, before: 20 };
    await bridge.onChips(said("Over to you", { seq: 21, addressed_to: ["agt_main"], for: ["agt_main"], context }));
    assert.equal(
      calls.find(([method]) => method === "chat.send")?.[1]["message"],
      "Said in this room since you last spoke:\nArjun: @claimed only you\n\nOver to you",
    );
    calls = [];
    // The agent it was for had a turn on it, in its own conversation.
    await bridge.onChips(said("And you?", { seq: 22, message_id: "msg_01K4ZQPX0000000000000000A2", addressed_to: ["agt_claimed"], for: ["agt_claimed"], context }));
    assert.equal(calls.find(([method]) => method === "chat.send")?.[1]["message"], "And you?");
  });

  it("reads nothing more of the room when Chips's pull route will not answer", async () => {
    const failing = { ...chips, roomContext: async () => Promise.reject(new Error("no")) };
    const quiet = new Bridge(failing, claw, { harnessId: ME, agent: "main" }, () => undefined);
    await quiet.onChips(said("Hi", { addressed_to: [ME], context: { lines: [], since_seq: 4, truncated: false, before: 5 } }));
    assert.equal(calls.find(([method]) => method === "chat.send")?.[1]["message"], "Hi");
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
