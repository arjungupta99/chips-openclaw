/**
 * The mapping. One Chips room is one OpenClaw session; one OpenClaw turn is one Chips run.
 *
 * - A room's session key is made from the room's id, so the bridge keeps no map of its own: any
 *   room it hears from has exactly one session, and a restart finds it again.
 * - A room a person asks for from the + is claimed under that key, named from the first words.
 * - A person's words go to the session with `chat.send`, keyed by the message's id.
 * - OpenClaw's `chat` events for a turn become a run: started on the first, answered and completed
 *   on `final`, failed on `error` or `aborted`. Its tool events become steps.
 * - An exec approval becomes an approval card, and the person's answer goes back as allow-once,
 *   allow-always or deny. An `ask_user` question becomes a question card.
 *
 * Every Chips id is derived from OpenClaw's, so everything written again after a restart is the
 * same event and Chips answers it as a duplicate.
 */

import { type ChipsEvent, ChipsRefusal } from "./chips.ts";
import { chipsId } from "./ids.ts";
import type { ClawEvent } from "./openclaw.ts";

/** What the bridge needs of Chips; the `Chips` client, or a stand-in in the tests. */
export interface ChipsPort {
  send(event: ChipsEvent): Promise<void>;
  claim(spaceId: string, key: string, title: string | undefined): Promise<void>;
  fetchAttachment(url: string): Promise<Buffer>;
}

/** What the bridge needs of OpenClaw. */
export interface ClawPort {
  request<T = Record<string, unknown>>(method: string, params: Record<string, unknown>): Promise<T>;
}

interface Run {
  readonly chipsRun: string;
  readonly spaceId: string;
  readonly sessionKey: string;
  /** Writes for one run go in order. */
  chain: Promise<void>;
  ended: boolean;
  /** From the turn's `lifecycle` model phase and its `usage` stream, reported when it ends. */
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  contextTokens?: number;
  contextWindow?: number;
}

type Payload = Record<string, unknown>;

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

/** A room's name from its first words: the first line, cut at a word near 48 characters. */
export function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  if (line.length <= 48) return line;
  const cut = line.slice(0, 48);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 24))}…`;
}

/** The text of an OpenClaw message, whether a string or content blocks. */
export function textOf(message: unknown): string {
  if (typeof message === "string") return message;
  if (message === null || typeof message !== "object") return "";
  const content = (message as Payload)["content"] ?? (message as Payload)["text"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is Payload => typeof block === "object" && block !== null)
    .filter((block) => block["type"] === "text" && typeof block["text"] === "string")
    .map((block) => String(block["text"]))
    .join("");
}

/** Tokens and a model from whatever usage shape a turn reports, or nothing when it has none. */
export function usageOf(usage: unknown, fallbackModel: string): Payload | undefined {
  if (usage === null || typeof usage !== "object") return undefined;
  const u = usage as Payload;
  const input = num(u["input"]) ?? num(u["inputTokens"]) ?? num(u["input_tokens"]) ?? num(u["promptTokens"]);
  const output = num(u["output"]) ?? num(u["outputTokens"]) ?? num(u["output_tokens"]) ?? num(u["completionTokens"]);
  if (input === undefined || output === undefined) return undefined;
  const cost = num((u["cost"] as Payload | undefined)?.["total"]) ?? num(u["costUsd"]);
  return {
    scope: "run",
    model: str(u["model"]) ?? fallbackModel,
    input_tokens: input,
    output_tokens: output,
    ...(cost === undefined || cost <= 0 ? {} : { cost: { usd: cost, estimated: true } }),
  };
}

export class Bridge {
  /** Rooms asked of this harness from the +, waiting for their first words to be claimed. */
  private readonly asked = new Set<string>();
  private readonly sessions = new Set<string>();
  private readonly runs = new Map<string, Run>();
  private readonly runByChips = new Map<string, Run>();
  /** A person's words, oldest first, waiting for the turn they start to name its run. */
  private readonly goals = new Map<string, string[]>();
  /** Tool events that came before the turn's first `chat` event said which room it is in. */
  private readonly early = new Map<string, Payload[]>();
  /** Chips's approval id → OpenClaw's, and whether OpenClaw takes allow-always for it. */
  private readonly approvals = new Map<string, { readonly id: string; readonly always: boolean }>();
  private readonly questions = new Map<string, string>();

  constructor(
    private readonly chips: ChipsPort,
    private readonly claw: ClawPort,
    private readonly self: { readonly harnessId: string; readonly agent: string },
    private readonly log: (message: string) => void,
  ) {}

  /** The session a room is: one per room, named from the room's id. */
  keyFor(spaceId: string): string {
    return `agent:${this.self.agent}:chips-${spaceId.toLowerCase()}`;
  }

  /** The room a session is, when it is one of this bridge's. */
  spaceFor(sessionKey: string): string | undefined {
    const prefix = `agent:${this.self.agent}:chips-`;
    if (!sessionKey.startsWith(prefix)) return undefined;
    const rest = sessionKey.slice(prefix.length);
    const at = rest.indexOf("_");
    return at < 0 ? undefined : `${rest.slice(0, at)}_${rest.slice(at + 1).toUpperCase()}`;
  }

  /** A room asked of this harness while the bridge was away (from `GET …/spaces`). */
  noteAsked(spaceId: string): void {
    this.asked.add(spaceId);
  }

  // ------------------------------------------------------------------ Chips → OpenClaw

  async onChips(event: ChipsEvent): Promise<void> {
    switch (event.type) {
      case "space.created":
        if (event["asked_of"] === this.self.harnessId) this.asked.add(String(event["space_id"]));
        return;
      case "message.new":
        return this.heard(event);
      case "run.cancel":
        return this.cancel(event);
      case "run.steer":
        return this.steer(event);
      case "approval.resolved":
        return this.decided(event);
      case "question.answered":
        return this.answered(event);
      default:
        return;
    }
  }

  private async heard(event: ChipsEvent): Promise<void> {
    const spaceId = str(event["space_id"]);
    const from = event["from"] as Payload | undefined;
    if (spaceId === undefined || from === undefined) return;
    if (from["participant_id"] === this.self.harnessId) return;
    // Another harness's words reach this one only when they name it (Chips ADR 0077's rule).
    const mentions = Array.isArray(event["mentions"]) ? (event["mentions"] as string[]) : [];
    if (from["kind"] === "harness" && !mentions.includes(this.self.harnessId)) return;
    const text = String(event["text"] ?? "");
    const key = this.keyFor(spaceId);
    await this.ensureSession(key, text);
    if (this.asked.delete(spaceId)) await this.chips.claim(spaceId, key, titleFrom(text));
    this.goals.set(key, [...(this.goals.get(key) ?? []), text]);
    await this.claw.request("chat.send", {
      sessionKey: key,
      message: text,
      idempotencyKey: String(event["message_id"] ?? event["id"]),
      ...(await this.attachments(event)),
    });
  }

  /**
   * The session for a room, made the first time. Making it again with the same key adopts it and
   * changes nothing, so the key is its identity; no idempotency key is sent, because OpenClaw
   * refuses one reused with other parameters (a later room's words as the name, after a restart).
   */
  private async ensureSession(key: string, firstWords: string): Promise<void> {
    if (this.sessions.has(key)) return;
    await this.claw.request("sessions.create", {
      key,
      agentId: this.self.agent,
      displayName: titleFrom(firstWords),
    });
    this.sessions.add(key);
  }

  /** A person's photos and files, fetched from their signed URLs and sent inline. */
  private async attachments(event: ChipsEvent): Promise<Payload> {
    const files = Array.isArray(event["attachments"]) ? (event["attachments"] as Payload[]) : [];
    if (files.length === 0) return {};
    const sent: Payload[] = [];
    for (const file of files) {
      const url = str(file["url"]);
      if (url === undefined) continue;
      const bytes = await this.chips.fetchAttachment(url);
      const mimeType = str(file["mime_type"]) ?? "application/octet-stream";
      sent.push({
        type: mimeType.startsWith("image/") ? "image" : "file",
        mimeType,
        fileName: str(file["filename"]) ?? "attachment",
        content: bytes.toString("base64"),
        sizeBytes: bytes.length,
      });
    }
    return sent.length === 0 ? {} : { attachments: sent };
  }

  private async cancel(event: ChipsEvent): Promise<void> {
    const run = this.runByChips.get(String(event["run_id"]));
    if (run === undefined) return;
    await this.claw.request("chat.abort", { sessionKey: run.sessionKey, runId: this.clawRunOf(run) });
  }

  private async steer(event: ChipsEvent): Promise<void> {
    const run = this.runByChips.get(String(event["run_id"]));
    if (run === undefined) return;
    const mode = str(event["mode"]) ?? "steer";
    await this.claw.request("chat.send", {
      sessionKey: run.sessionKey,
      message: String(event["text"] ?? ""),
      idempotencyKey: String(event["id"]),
      queueMode: mode === "followup" ? "followup" : mode === "interrupt" ? "interrupt" : "steer",
    });
  }

  private async decided(event: ChipsEvent): Promise<void> {
    const asked = this.approvals.get(String(event["approval_id"]));
    if (asked === undefined) return;
    const decision = str(event["decision"]);
    const allowed = decision === "approved" || decision === "edited";
    // Chips offers every scope; OpenClaw may take only allow-once for a command (a native Codex
    // command does). A yes for always is then a yes for this once, rather than a refusal that
    // leaves the turn waiting for an answer that never comes.
    const always = event["scope"] === "always" && asked.always;
    await this.claw.request("exec.approval.resolve", {
      id: asked.id,
      decision: !allowed ? "deny" : always ? "allow-always" : "allow-once",
    });
    const runId = str(event["run_id"]);
    const run = runId === undefined ? undefined : this.runByChips.get(runId);
    if (allowed && run !== undefined) {
      this.write(run, {
        type: "approval.executed",
        approval_id: event["approval_id"],
        outcome: "executed",
        detail: "Passed to OpenClaw to run.",
        idempotency_key: `${event["approval_id"]}-executed`,
      });
    }
  }

  private async answered(event: ChipsEvent): Promise<void> {
    const clawId = this.questions.get(String(event["ask_id"]));
    if (clawId === undefined) return;
    const answers = Array.isArray(event["answers"]) ? (event["answers"] as Payload[]) : [];
    await this.claw.request("question.resolve", {
      id: clawId,
      answers: {
        answers: Object.fromEntries(
          answers.map((each) => [String(each["question_id"]), Array.isArray(each["values"]) ? each["values"] : []]),
        ),
      },
    });
  }

  // ------------------------------------------------------------------ OpenClaw → Chips

  onClaw(event: ClawEvent): void {
    const p = event.payload;
    switch (event.event) {
      case "chat":
        return this.chat(p);
      case "agent":
        return this.agent(p);
      case "exec.approval.requested":
        return this.asksApproval(p);
      case "question.requested":
        return this.asksQuestion(p);
      default:
        return;
    }
  }

  /** The Chips run a turn is, started the first time the turn is heard from in one of our rooms. */
  private runFor(clawRun: string, sessionKey: string): Run | undefined {
    const known = this.runs.get(clawRun);
    if (known !== undefined) return known;
    const spaceId = this.spaceFor(sessionKey);
    if (spaceId === undefined) return undefined;
    const run: Run = {
      chipsRun: chipsId("run", `openclaw-run:${clawRun}`),
      spaceId,
      sessionKey,
      chain: Promise.resolve(),
      ended: false,
    };
    this.runs.set(clawRun, run);
    this.runByChips.set(run.chipsRun, run);
    const goal = this.goals.get(sessionKey)?.shift() ?? "Answer in the room.";
    this.write(run, {
      type: "run.started",
      run_id: run.chipsRun,
      space_id: spaceId,
      goal: goal.slice(0, 500),
      idempotency_key: `openclaw-run:${clawRun}:started`,
    });
    for (const early of this.early.get(clawRun) ?? []) this.stream(run, early);
    this.early.delete(clawRun);
    return run;
  }

  private clawRunOf(run: Run): string | undefined {
    for (const [clawRun, each] of this.runs) if (each === run) return clawRun;
    return undefined;
  }

  private chat(p: Payload): void {
    const clawRun = str(p["runId"]);
    const sessionKey = str(p["sessionKey"]);
    if (clawRun === undefined || sessionKey === undefined) return;
    const run = this.runFor(clawRun, sessionKey);
    if (run === undefined || run.ended) return;
    const state = str(p["state"]);
    if (state === "final") return this.finish(run, clawRun, p);
    if (state === "error" || state === "aborted") {
      run.ended = true;
      const error = state === "aborted" ? "Stopped." : (str(p["errorMessage"]) ?? "OpenClaw's turn failed.");
      this.write(run, { type: "run.failed", run_id: run.chipsRun, error, idempotency_key: `openclaw-run:${clawRun}:failed` });
    }
  }

  private finish(run: Run, clawRun: string, p: Payload): void {
    run.ended = true;
    const text = textOf(p["message"]).trim();
    if (text !== "") {
      this.write(run, { type: "message.post", run_id: run.chipsRun, text, idempotency_key: `openclaw-run:${clawRun}:reply` });
    }
    const model = run.model ?? str(p["model"]) ?? "openai";
    const usage =
      usageOf(p["usage"], model) ??
      usageOf({ inputTokens: run.inputTokens, outputTokens: run.outputTokens }, model);
    if (usage !== undefined) {
      this.write(run, { type: "usage", run_id: run.chipsRun, ...usage, idempotency_key: `openclaw-run:${clawRun}:usage` });
    }
    if (run.contextTokens !== undefined && run.contextWindow !== undefined && run.contextWindow > 0) {
      this.write(run, {
        type: "context.usage",
        run_id: run.chipsRun,
        used_tokens: run.contextTokens,
        limit_tokens: run.contextWindow,
        model,
        idempotency_key: `openclaw-run:${clawRun}:context`,
      });
    }
    // The whole reply, so Chips draws the answer and the summary as one card rather than two.
    this.write(run, {
      type: "run.completed",
      run_id: run.chipsRun,
      summary: text === "" ? "Done." : text.slice(0, 20_000),
      idempotency_key: `openclaw-run:${clawRun}:completed`,
    });
  }

  /**
   * The turn's own stream: which model it is, what it used, and its tools. Events that come
   * before the turn's room is known are held (a tool's start can precede the turn's first `chat`).
   */
  private agent(p: Payload): void {
    const clawRun = str(p["runId"]);
    if (clawRun === undefined) return;
    const sessionKey = str(p["sessionKey"]);
    const run = this.runs.get(clawRun) ?? (sessionKey === undefined ? undefined : this.runFor(clawRun, sessionKey));
    if (run === undefined) {
      this.early.set(clawRun, [...(this.early.get(clawRun) ?? []), p]);
      return;
    }
    this.stream(run, p);
  }

  private stream(run: Run, p: Payload): void {
    const data = (p["data"] ?? {}) as Payload;
    switch (p["stream"]) {
      case "lifecycle":
        if (data["phase"] === "model") run.model = str(data["model"]) ?? run.model;
        return;
      case "usage":
        run.inputTokens = num(data["inputTokens"]) ?? run.inputTokens;
        run.outputTokens = num(data["outputTokens"]) ?? run.outputTokens;
        run.contextTokens = num(data["activeContextTokens"]) ?? run.contextTokens;
        run.contextWindow = num(data["modelContextWindow"]) ?? run.contextWindow;
        return;
      case "tool":
        return this.tool(run, p);
      default:
        return;
    }
  }

  private tool(run: Run, p: Payload): void {
    if (run.ended) return;
    const data = (p["data"] ?? {}) as Payload;
    const phase = str(data["phase"]);
    const stepId = str(data["toolCallId"]) ?? str(data["id"]);
    if (stepId === undefined || (phase !== "start" && phase !== "result" && phase !== "end")) return;
    const failed = data["isError"] === true;
    const status = phase === "start" ? "started" : failed ? "failed" : "done";
    this.write(run, {
      type: "step.log",
      run_id: run.chipsRun,
      step_id: stepId,
      status,
      tool: str(data["name"]) ?? "tool",
      ...(str(data["title"]) === undefined ? {} : { summary: str(data["title"]) }),
      idempotency_key: `openclaw-step:${stepId}:${status}`,
    });
  }

  private asksApproval(p: Payload): void {
    const clawId = str(p["id"]);
    const request = (p["request"] ?? {}) as Payload;
    const plan = (request["systemRunPlan"] ?? {}) as Payload;
    const sessionKey = str(request["sessionKey"]) ?? str(plan["sessionKey"]);
    const clawRun = str(request["runId"]);
    if (clawId === undefined || sessionKey === undefined) return;
    const run = clawRun === undefined ? this.latestRun(sessionKey) : this.runFor(clawRun, sessionKey);
    if (run === undefined) return;
    const command = str(plan["commandText"]) ?? str(request["command"]) ?? "a command";
    const cwd = str(plan["cwd"]) ?? str(request["cwd"]);
    const approvalId = chipsId("apr", `openclaw-approval:${clawId}`);
    const unavailable = Array.isArray(request["unavailableDecisions"]) ? (request["unavailableDecisions"] as unknown[]) : [];
    const offered = Array.isArray(request["allowedDecisions"]) ? (request["allowedDecisions"] as unknown[]) : undefined;
    const always = !unavailable.includes("allow-always") && (offered === undefined || offered.includes("allow-always"));
    this.approvals.set(approvalId, { id: clawId, always });
    const expires = num(p["expiresAtMs"]);
    this.write(run, {
      type: "approval.request",
      run_id: run.chipsRun,
      approval_id: approvalId,
      action: { kind: "shell.exec", input: { command, ...(cwd === undefined ? {} : { cwd }) } },
      preview: { format: "markdown", title: "Run a command", body: `\`\`\`sh\n${command}\n\`\`\`${cwd === undefined ? "" : `\nin \`${cwd}\``}` },
      // A command in the sandboxed container fits none of Chips's closed risk classes.
      risk: [],
      expires_in: expires === undefined ? 900 : Math.max(30, Math.round((expires - Date.now()) / 1000)),
      fallback: "deny",
      idempotency_key: `openclaw-approval:${clawId}`,
    });
  }

  private asksQuestion(p: Payload): void {
    const clawId = str(p["id"]);
    const sessionKey = str(p["sessionKey"]);
    const clawRun = str(p["runId"]);
    if (clawId === undefined || sessionKey === undefined) return;
    const run = clawRun === undefined ? this.latestRun(sessionKey) : this.runFor(clawRun, sessionKey);
    if (run === undefined) return;
    const askId = chipsId("qst", `openclaw-question:${clawId}`);
    this.questions.set(askId, clawId);
    const questions = (Array.isArray(p["questions"]) ? (p["questions"] as Payload[]) : []).map((q) => ({
      question_id: String(q["questionId"]),
      prompt: String(q["question"] ?? q["header"] ?? ""),
      options: (Array.isArray(q["options"]) ? (q["options"] as Payload[]) : []).map((o) => ({
        value: String(o["label"]),
        label: String(o["label"]),
        ...(str(o["description"]) === undefined ? {} : { description: str(o["description"]) }),
      })),
      multi_select: q["multiSelect"] === true,
      allow_free_text: q["isOther"] === true,
    }));
    const expires = num(p["expiresAtMs"]);
    this.write(run, {
      type: "question.ask",
      run_id: run.chipsRun,
      ask_id: askId,
      questions,
      ...(expires === undefined ? {} : { timeout_seconds: Math.max(30, Math.round((expires - Date.now()) / 1000)) }),
      idempotency_key: `openclaw-question:${clawId}`,
    });
  }

  /** The newest run still going in a session, for an ask that does not name its turn. */
  private latestRun(sessionKey: string): Run | undefined {
    let latest: Run | undefined;
    for (const run of this.runs.values()) if (run.sessionKey === sessionKey && !run.ended) latest = run;
    return latest;
  }

  /** Write for a run, in order; a refusal is logged, never thrown into OpenClaw's event loop. */
  private write(run: Run, event: ChipsEvent): void {
    run.chain = run.chain.then(async () => {
      try {
        await this.chips.send(event);
      } catch (error) {
        const why = error instanceof ChipsRefusal ? `${error.status} ${error.code}: ${error.message}` : String(error);
        this.log(`chips refused ${event.type} for ${run.chipsRun}: ${why}`);
      }
    });
  }

  /** Every write queued so far, done; for the tests and for a clean stop. */
  async settled(): Promise<void> {
    await Promise.all([...this.runs.values()].map((run) => run.chain));
  }
}
