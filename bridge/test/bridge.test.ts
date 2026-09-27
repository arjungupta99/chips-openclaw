/**
 * The mapping, one row of the plan's table at a time, between two stand-ins that record what they
 * are asked. No OpenClaw and no Chips needed.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { Bridge, type ChipsPort, type ClawPort, textOf, titleFrom, usageOf } from "../src/bridge.ts";
import type { ChipsEvent } from "../src/chips.ts";

const ME = "hrn_01K4ZQPX000000000000000004";
const ROOM = "spc_01K4ZQPX000000000000000002";
const ARJUN = { participant_id: "usr_01K4ZQPX000000000000000003", kind: "person", display_name: "Arjun", role: "owner" };

let sent: ChipsEvent[] = [];
let claims: [string, string, string | undefined][] = [];
let calls: [string, Record<string, unknown>][] = [];
let bridge: Bridge;

const chips: ChipsPort = {
  send: async (event) => void sent.push(event),
  claim: async (spaceId, key, title) => void claims.push([spaceId, key, title]),
  fetchAttachment: async () => Buffer.from("png-bytes"),
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

  it("does not hear another harness unless it is named", async () => {
    const other = { participant_id: "hrn_01K4ZQPX000000000000000009", kind: "harness", display_name: "J", role: "member" };
    await bridge.onChips(said("I will take this one", { from: other }));
    assert.equal(calls.length, 0);
    await bridge.onChips(said("@OpenClaw your turn", { from: other, mentions: [ME] }));
    assert.deepEqual(calls.map(([method]) => method), ["sessions.create", "chat.send"]);
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

  it("reports usage only when it has both token counts", () => {
    assert.equal(usageOf({ input: 1 }, "m"), undefined);
    assert.deepEqual(usageOf({ inputTokens: 3, outputTokens: 4 }, "m"), { scope: "run", model: "m", input_tokens: 3, output_tokens: 4 });
  });
});
