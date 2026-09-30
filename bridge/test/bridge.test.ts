/**
 * The mapping, one row of the plan's table at a time, between two stand-ins that record what they
 * are asked. No OpenClaw and no Chips needed.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { Bridge, type ChipsPort, type ClawPort, heardIn, textOf, titleFrom, usageOf, wordsOf } from "../src/bridge.ts";
import type { ChipsAgent, ChipsEvent } from "../src/chips.ts";

const ME = "hrn_01K4ZQPX000000000000000004";
const ROOM = "spc_01K4ZQPX000000000000000002";
const ARJUN = { participant_id: "usr_01K4ZQPX000000000000000003", kind: "person", display_name: "Arjun", role: "owner" };

let sent: ChipsEvent[] = [];
let claims: [string, string, string | undefined][] = [];
let calls: [string, Record<string, unknown>][] = [];
/** This harness's agents as Chips keeps them, and what attaching did. */
let agents: ChipsAgent[] = [];
let attached: [string, string, string][] = [];
let keyed: Record<string, unknown>[] = [];
let bridge: Bridge;

const chips: ChipsPort = {
  send: async (event) => void sent.push(event),
  claim: async (spaceId, key, title) => void claims.push([spaceId, key, title]),
  fetchAttachment: async () => Buffer.from("png-bytes"),
  agents: async () => agents.map((each) => ({ ...each, spaces: [...each.spaces] })),
  registerAgent: async ({ key, name }) => {
    const had = agents.find((each) => each.key === key);
    const agent: ChipsAgent = had === undefined
      ? { agent_id: `agt_${key}`, key, name, lead: false, state: "active", spaces: [] }
      : { ...had, name };
    agents = [...agents.filter((each) => each.key !== key), agent];
    return agent;
  },
  attach: async (agentId, spaceId, replacing) => {
    attached.push([agentId, spaceId, replacing]);
    agents = agents.map((each) =>
      each.agent_id === agentId
        ? { ...each, spaces: [...each.spaces, spaceId] }
        : each.agent_id === replacing
          ? { ...each, spaces: each.spaces.filter((room) => room !== spaceId) }
          : each,
    );
    return true;
  },
  ownSpaces: async () => ({ spaces: keyed, asked: [] }),
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
  keyed = [];
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
  });

  it("sends a person's words to the room's session, made once, keyed by the message", async () => {
    await bridge.onChips(said("What can you do?"));
    await bridge.onChips(said("And briefly?", { message_id: "msg_01K4ZQPX0000000000000000A2" }));
    assert.deepEqual(calls.map(([method]) => method), ["sessions.create", "chat.send", "chat.send"]);
    assert.equal(calls[0]?.[1]["key"], key());
    assert.deepEqual(calls[1]?.[1], { sessionKey: key(), message: "What can you do?", idempotencyKey: "msg_01K4ZQPX0000000000000000A1" });
  });

  it("claims a room asked of it from the +, named from the first words, before answering", async () => {
    await bridge.onChips({ type: "space.created", space_id: ROOM, asked_of: ME, kind: "direct" });
    await bridge.onChips(said("Plan a weekend in Big Sur with two hikes and a good dinner spot"));
    assert.deepEqual(claims, [[ROOM, key(), "Plan a weekend in Big Sur with two hikes and a…"]]);
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
  const FALLBACK: ChipsAgent = { agent_id: "agt_fallback", key: ME, name: "OpenClaw", lead: false, state: "active", spaces: [] };
  const OTHER_ROOM = "spc_01K4ZQPX000000000000000077";

  beforeEach(() => {
    agents = [{ ...FALLBACK, spaces: [ROOM, OTHER_ROOM] }];
    keyed = [{ space_id: OTHER_ROOM, key: "agent:scout:chips-spc_01k4zqpx000000000000000077" }];
  });

  it("registers each agent the gateway lists, named as the harness when it has no name of its own", async () => {
    await bridge.adoptAgents({
      defaultId: "main",
      agents: [{ id: "main" }, { id: "scout", identity: { name: "Scout" } }, { id: "ops", kind: "system" }],
    });
    assert.deepEqual(
      agents.filter((each) => each.key !== ME).map((each) => [each.key, each.name]),
      [["main", "OpenClaw"], ["scout", "Scout"]],
    );
    // Each takes the default agent's place in the rooms the bridge serves: its session's room, and
    // the primary one everywhere else.
    assert.deepEqual(attached, [
      ["agt_main", ROOM, "agt_fallback"],
      ["agt_scout", OTHER_ROOM, "agt_fallback"],
    ]);
    assert.deepEqual(agents.find((each) => each.key === ME)?.spaces, []);
    // Again, and nothing moves.
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }, { id: "scout" }] });
    assert.equal(attached.length, 2);
  });

  it("serves only OPENCLAW_AGENT when it is set", async () => {
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }, { id: "scout" }] }, "main");
    assert.deepEqual(agents.filter((each) => each.key !== ME).map((each) => each.key), ["main"]);
  });

  it("takes a turn for each of its agents a message is for, each in its own session, said as it", async () => {
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }, { id: "scout", name: "Scout" }] });
    agents = agents.map((each) => (each.key === "scout" ? { ...each, spaces: [...each.spaces, ROOM] } : each));
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

  it("puts its primary agent in the default one's place in a room it is added to later", async () => {
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    const later = "spc_01K4ZQPX000000000000000088";
    agents = agents.map((each) => (each.key === ME ? { ...each, spaces: [later] } : each));
    await bridge.onChips(said("Hi", { space_id: later, for: ["agt_fallback"] }));
    assert.deepEqual(attached.at(-1), ["agt_main", later, "agt_fallback"]);
    assert.equal(calls.find(([method]) => method === "chat.send")?.[1]["sessionKey"], bridge.keyFor(later, "main"));
  });

  it("serves a room asked of it from the + when Chips says the message is for the harness itself", async () => {
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    calls = [];
    const asked = "spc_01K4ZQPX000000000000000099";
    await bridge.onChips({ type: "space.created", space_id: asked, asked_of: ME, kind: "direct" });
    // The claim puts the default agent in the harness's place; the primary one then takes its.
    agents = agents.map((each) => (each.key === ME ? { ...each, spaces: [asked] } : each));
    await bridge.onChips(said("Plan a picnic", { space_id: asked, addressed_to: [ME], for: [ME] }));
    assert.deepEqual(claims.at(-1)?.slice(0, 2), [asked, bridge.keyFor(asked, "main")]);
    assert.deepEqual(attached.at(-1), ["agt_main", asked, "agt_fallback"]);
    assert.equal(calls.find(([method]) => method === "chat.send")?.[1]["sessionKey"], bridge.keyFor(asked, "main"));
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

  it("before the harness declares agents, answers in the room as the agent Chips has there", async () => {
    await bridge.adoptAgents({ defaultId: "main", agents: [{ id: "main" }] });
    await bridge.onChips(said("Hi", { addressed_to: [ME] }));
    bridge.onClaw({
      event: "chat",
      payload: { runId: "msg_01K4ZQPX0000000000000000A1", sessionKey: key(), seq: 1, state: "final", message: "Hello." },
    });
    await bridge.settled();
    assert.deepEqual(sent.find((event) => event.type === "message.post")?.["actor"], { kind: "agent", id: "agt_main" });
  });
});
