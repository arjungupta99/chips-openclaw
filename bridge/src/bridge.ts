/**
 * The mapping. Each OpenClaw agent is an agent in Chips; one agent in one Chips room is one
 * OpenClaw session; one OpenClaw turn is one Chips run.
 *
 * - Every agent the gateway lists (`agents.list`) is registered in Chips as one of this harness's
 *   agents, keyed by its OpenClaw id, all on the one token (Chips ADR 0087). `OPENCLAW_AGENT`
 *   keeps it to one. An agent with no name of its own is called what the harness is, so the
 *   rooms go on saying OpenClaw. Each takes the harness's default agent's place in the rooms the
 *   bridge serves, and in any room the default agent is added to later.
 * - A room's session key is made from the agent and the room's id, so the bridge keeps no map of
 *   its own: an agent has exactly one session in any room it hears from, and a restart finds it.
 * - A message says which of our agents it is for (`for`), once the harness declares `agents`;
 *   each takes a turn in its own session. Before that, it is the room's agent's.
 * - A room a person asks for from the + is claimed under that key, named from the first words.
 * - A person's words go to the session with `chat.send`, keyed by the message's id.
 * - OpenClaw's `chat` events for a turn become a run: started on the first, answered and completed
 *   on `final`, failed on `error` or `aborted`. Its tool events become steps.
 * - An exec approval becomes an approval card, and the person's answer goes back as allow-once,
 *   allow-always or deny. An `ask_user` question becomes a question card. An ask answered in
 *   OpenClaw's own tools instead is settled in Chips, once, so its card cools (Chips ADR 0079).
 *
 * Every Chips id is derived from OpenClaw's, so everything written again after a restart is the
 * same event and Chips answers it as a duplicate.
 */

import { type ChipsAgent, type ChipsEvent, ChipsRefusal, type OwnSpaces } from "./chips.ts";
import { chipsId } from "./ids.ts";
import type { ClawEvent } from "./openclaw.ts";

/** What the bridge needs of Chips; the `Chips` client, or a stand-in in the tests. */
export interface ChipsPort {
  send(event: ChipsEvent): Promise<void>;
  claim(spaceId: string, key: string, title: string | undefined): Promise<void>;
  fetchAttachment(url: string): Promise<Buffer>;
  agents(): Promise<ChipsAgent[]>;
  registerAgent(agent: { key: string; name: string }): Promise<ChipsAgent>;
  attach(agentId: string, spaceId: string, replacing: string): Promise<boolean>;
  ownSpaces(): Promise<OwnSpaces>;
}

/** One agent as the gateway lists it (`agents.list`). */
export interface ClawAgent {
  readonly id: string;
  readonly name?: string;
  readonly identity?: { readonly name?: string };
  readonly kind?: string;
}

/** What the bridge needs of OpenClaw. */
export interface ClawPort {
  request<T = Record<string, unknown>>(method: string, params: Record<string, unknown>): Promise<T>;
}

interface Run {
  readonly chipsRun: string;
  readonly spaceId: string;
  readonly sessionKey: string;
  /** The Chips agent the turn is by, whose name every write on it carries (Chips ADR 0087). */
  readonly agentId: string | undefined;
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

/**
 * What a person's message says, for naming its run and its room: its words, else a voice note's
 * transcript, else what was sent. A photo or a voice note alone has no words, and Chips refuses a
 * run whose goal is empty.
 */
export function wordsOf(event: Record<string, unknown>): string {
  const text = String(event["text"] ?? "").trim();
  if (text !== "") return text;
  const files = Array.isArray(event["attachments"]) ? (event["attachments"] as Record<string, unknown>[]) : [];
  const heard = files.map((file) => str(file["transcript"])?.trim()).filter((words) => words !== undefined && words !== "");
  if (heard.length > 0) return heard.join(" ");
  const mime = str(files[0]?.["mime_type"]) ?? "";
  if (mime.startsWith("image/")) return "A photo";
  if (mime.startsWith("audio/")) return "A voice note";
  if (mime.startsWith("video/")) return "A video";
  return files.length > 0 ? "A file" : "A message";
}

/** One of the room's lines Chips handed over with a message (Chips ADR 0088), as OpenClaw is told it. */
function contextLineOf(line: Payload): string | undefined {
  const name = str((line["from"] as Payload | undefined)?.["name"]) ?? "Someone";
  const flat = (words: unknown): string => (str(words) ?? "").replace(/\s*\n\s*/g, " ").trim();
  switch (line["kind"]) {
    case "said": {
      const files = Array.isArray(line["files"]) ? (line["files"] as unknown[]).filter((each) => typeof each === "string") : [];
      const words = flat(line["text"]) || flat(line["transcript"]) || (files.length > 0 ? `(sent ${files.join(", ")})` : "");
      return words === "" ? undefined : `${name}: ${words}`;
    }
    case "joined":
      return `(${name} joined the room)`;
    case "left":
      return `(${name} left the room)`;
    case "renamed": {
      const title = str(line["title"]);
      return title !== undefined
        ? `(${name} renamed the room "${title}")`
        : `(${str(line["previous"]) ?? name} is now called ${str(line["name"]) ?? name})`;
    }
    case "archived":
      return `(${name} archived the room)`;
    case "unarchived":
      return `(${name} unarchived the room)`;
    default:
      return undefined;
  }
}

/**
 * What Chips handed over with a message (Chips ADR 0088): the room's lines since this harness last
 * spoke there, read from Chips's log, so a restart of the bridge loses none. A message that was
 * this harness's to answer — its own, or any of its agents' — is left out: it had a turn of its
 * own. Nothing when the message carries no context.
 */
export function heardIn(context: unknown, own: (participantId: string) => boolean): string[] {
  const lines = (context as Payload | null | undefined)?.["lines"];
  if (!Array.isArray(lines)) return [];
  return lines.flatMap((each) => {
    if (typeof each !== "object" || each === null) return [];
    const line = each as Payload;
    const addressed = line["addressed_to"];
    const hadTurn =
      line["kind"] === "said" && (!Array.isArray(addressed) || (addressed as unknown[]).some((id) => typeof id === "string" && own(id)));
    const told = hadTurn ? undefined : contextLineOf(line);
    return told === undefined ? [] : [told];
  });
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
  // Codex's runtime often knows only the tokens out, and Chips takes those alone (finding 11).
  if (output === undefined) return undefined;
  const cost = num((u["cost"] as Payload | undefined)?.["total"]) ?? num(u["costUsd"]);
  return {
    scope: "run",
    model: str(u["model"]) ?? fallbackModel,
    ...(input === undefined ? {} : { input_tokens: input }),
    output_tokens: output,
    ...(cost === undefined || cost <= 0 ? {} : { cost: { usd: cost, estimated: true } }),
  };
}

/** A session key the bridge made: the OpenClaw agent, and the room it is that agent's session in. */
const SESSION = /^agent:([^:]+):chips-(.+)$/;

/** What Chips calls a sender that is an agent: `harness` before a harness declares `agents`, `agent` after. */
const isAgentKind = (kind: unknown): boolean => kind === "harness" || kind === "agent";

/**
 * Another harness's words, as OpenClaw is given them: whose they are, and that it acts on the
 * answer only when OpenClaw addresses it by the handle Chips answers it to (Chips ADR 0081).
 */
function fromAgent(from: Payload, text: string): string {
  const name = str(from["display_name"]) ?? "Another agent";
  const handle = `@${name.replace(/\s+/g, "")}`;
  return `${name} (an agent in this room) said this to you. Everyone here reads your answer; ${name} acts on it only if you address it as ${handle}:\n${text}`;
}

export class Bridge {
  /** Rooms asked of this harness from the +, waiting for their first words to be claimed. */
  private readonly asked = new Set<string>();
  private readonly sessions = new Set<string>();
  private readonly runs = new Map<string, Run>();
  private readonly runByChips = new Map<string, Run>();
  /**
   * A person's words by their message id, which OpenClaw uses as the id of the turn they start;
   * and the latest words in each room, for a follow-up turn OpenClaw starts on its own.
   */
  private readonly goals = new Map<string, string>();
  private readonly latest = new Map<string, string>();
  /** Tool events that came before the turn's first `chat` event said which room it is in. */
  private readonly early = new Map<string, Payload[]>();
  /** Chips's approval id → OpenClaw's, and whether OpenClaw takes allow-always for it. */
  /**
   * Chips's approval id to OpenClaw's, the method that answers it (an exec approval and a plugin
   * approval are resolved apart) and whether OpenClaw takes a yes for always.
   */
  private readonly approvals = new Map<
    string,
    {
      readonly id: string;
      readonly always: boolean;
      readonly method: "exec.approval.resolve" | "plugin.approval.resolve";
      readonly run: Run;
    }
  >();
  /** Chips's question id to OpenClaw's, and the run that asked it. */
  private readonly questions = new Map<string, { readonly id: string; readonly run: Run }>();

  /** OpenClaw's agents as Chips's (ADR 0087): OpenClaw's id → Chips's, and back. */
  private readonly chipsAgentOf = new Map<string, string>();
  private readonly clawAgentOf = new Map<string, string>();
  /** The rooms each of our Chips agents is in, as Chips last said. */
  private readonly roomsOf = new Map<string, Set<string>>();
  /** The harness's default agent in Chips, whose place OpenClaw's agents take. */
  private fallback: string | undefined;
  /** Rooms the agents were read again for, once, when the bridge did not know who of ours is there. */
  private readonly looked = new Set<string>();
  /** The OpenClaw agent a room with no other gets: `OPENCLAW_AGENT`, else the gateway's default. */
  private primary: string;

  constructor(
    private readonly chips: ChipsPort,
    private readonly claw: ClawPort,
    private readonly self: { readonly harnessId: string; readonly agent: string },
    private readonly log: (message: string) => void,
  ) {
    this.primary = self.agent;
  }

  /** The session an agent has in a room: one per agent and room, named from both. */
  keyFor(spaceId: string, agent: string = this.primary): string {
    return `agent:${agent}:chips-${spaceId.toLowerCase()}`;
  }

  /** The room a session is, when it is one of this bridge's. */
  spaceFor(sessionKey: string): string | undefined {
    const rest = SESSION.exec(sessionKey)?.[2];
    if (rest === undefined) return undefined;
    const at = rest.indexOf("_");
    return at < 0 ? undefined : `${rest.slice(0, at)}_${rest.slice(at + 1).toUpperCase()}`;
  }

  /** The OpenClaw agent a session is, when it is one of this bridge's. */
  agentFor(sessionKey: string): string | undefined {
    return SESSION.exec(sessionKey)?.[1];
  }

  /** Whether somebody in Chips is this harness: itself, or one of its agents. */
  isOwn(participantId: string): boolean {
    return participantId === this.self.harnessId || this.clawAgentOf.has(participantId) || participantId === this.fallback;
  }

  // ------------------------------------------------------------------ OpenClaw's agents in Chips

  /**
   * OpenClaw's agents as this harness's agents in Chips (ADR 0087): each the gateway lists, or
   * only `only`, registered by its OpenClaw id and named as the gateway names it — or, with no
   * name of its own, as the harness is. Then each room the harness's default agent is in goes to
   * the agent its session is for, else the primary one, in the default agent's place. A refusal
   * is logged; a room left as it was goes on as the default agent's.
   */
  async adoptAgents(listed: { defaultId?: string; agents?: readonly ClawAgent[] }, only?: string): Promise<void> {
    const agents = (listed.agents ?? []).filter((each) => each.kind !== "system" && (only === undefined || each.id === only));
    this.primary = only ?? listed.defaultId ?? this.primary;
    if (!agents.some((each) => each.id === this.primary)) agents.unshift({ id: this.primary });
    const known = await this.chips.agents();
    this.learn(known);
    const harnessName = known.find((each) => each.key === this.self.harnessId)?.name ?? "OpenClaw";
    for (const agent of agents) {
      const named = agent.identity?.name ?? agent.name;
      const name = named === undefined || named === agent.id || named.trim() === "" ? harnessName : named.trim();
      try {
        this.learn([await this.chips.registerAgent({ key: agent.id, name })]);
      } catch (error) {
        this.log(`chips refused agent ${agent.id}: ${String(error)}`);
      }
    }
    const fallback = this.fallback;
    if (fallback === undefined) return;
    const keyed = new Map((await this.chips.ownSpaces()).spaces.map((each) => [String(each["space_id"]), String(each["key"] ?? "")]));
    for (const room of [...(this.roomsOf.get(fallback) ?? [])]) {
      await this.attachIn(room, this.agentFor(keyed.get(room) ?? "") ?? this.primary);
    }
  }

  /**
   * The Chips agent an OpenClaw agent's turn is said as in a room: its own, once Chips has it
   * there. Nothing otherwise, and Chips reads the harness as its one agent in the room.
   */
  private speakerIn(room: string, clawAgent: string | undefined): string | undefined {
    const agentId = clawAgent === undefined ? undefined : this.chipsAgentOf.get(clawAgent);
    return agentId !== undefined && this.roomsOf.get(agentId)?.has(room) === true ? agentId : undefined;
  }

  /**
   * Who of ours came into a room, left one, or took another's place there, as Chips says once
   * the harness declares `agents`.
   */
  private moved(event: ChipsEvent): void {
    const room = str(event["space_id"]);
    if (room === undefined) return;
    const move = (id: unknown, into: boolean): void => {
      if (typeof id !== "string" || !this.roomsOf.has(id)) return;
      const rooms = this.roomsOf.get(id) ?? new Set<string>();
      if (into) rooms.add(room);
      else rooms.delete(room);
    };
    if (event.type === "membership.replaced") {
      move(event["from"], false);
      move(event["to"], true);
      return;
    }
    move(event["participant_id"], event.type === "membership.added");
  }

  /** What Chips says our agents are: ids both ways, and their rooms. */
  private learn(agents: readonly ChipsAgent[]): void {
    for (const agent of agents) {
      this.roomsOf.set(agent.agent_id, new Set(agent.spaces));
      if (agent.key === this.self.harnessId) {
        this.fallback = agent.agent_id;
        continue;
      }
      this.chipsAgentOf.set(agent.key, agent.agent_id);
      this.clawAgentOf.set(agent.agent_id, agent.key);
    }
  }

  /**
   * An OpenClaw agent's Chips agent in a room, in the default agent's place when it is there.
   * Its Chips id, or nothing when it has none; a room it cannot be put in is left as it is.
   */
  private async attachIn(room: string, clawAgent: string): Promise<string | undefined> {
    const agentId = this.chipsAgentOf.get(clawAgent);
    if (agentId === undefined || this.roomsOf.get(agentId)?.has(room) === true) return agentId;
    const there = (id: string | undefined): boolean => id !== undefined && this.roomsOf.get(id)?.has(room) === true;
    // A room the default agent joined while the bridge was not told — before it declares
    // `agents`, Chips shows it none of that — is read for, once.
    if (!there(this.fallback) && !this.looked.has(room)) {
      this.looked.add(room);
      this.learn(await this.chips.agents());
      if (this.roomsOf.get(agentId)?.has(room) === true) return agentId;
    }
    const fallback = this.fallback;
    if (fallback === undefined || !there(fallback)) return agentId;
    try {
      if (await this.chips.attach(agentId, room, fallback)) this.log(`chips: ${clawAgent} is in ${room} now`);
      this.roomsOf.get(fallback)?.delete(room);
      this.roomsOf.set(agentId, new Set([...(this.roomsOf.get(agentId) ?? []), room]));
    } catch (error) {
      this.log(`chips refused ${clawAgent} in ${room}: ${String(error)}`);
    }
    return agentId;
  }

  /**
   * Which OpenClaw agents a message is for. `for`, from a Chips that knows our agents: each of
   * ours it names — the default agent is the primary one, which takes its place. Without it, the
   * room's own: whichever of ours Chips last had in the room, else the primary one.
   */
  private async turnTakers(event: ChipsEvent, spaceId: string): Promise<string[]> {
    const named = event["for"];
    if (!Array.isArray(named)) {
      const inRoom = [...this.roomsOf].find(([agentId, rooms]) => rooms.has(spaceId) && this.clawAgentOf.has(agentId));
      return [inRoom === undefined ? this.primary : (this.clawAgentOf.get(inRoom[0]) ?? this.primary)];
    }
    const ids = (named as unknown[]).filter((each): each is string => typeof each === "string");
    const ours = (id: string): boolean => id === this.self.harnessId || id === this.fallback || this.clawAgentOf.has(id);
    if (!ids.every(ours)) this.learn(await this.chips.agents());
    const takers = ids.flatMap((id) => {
      // The harness itself: a room asked of it from the +, which its claim gives to an agent.
      if (id === this.self.harnessId) return [this.primary];
      if (id === this.fallback) {
        // Chips says it is for the default agent, so the default agent is in the room.
        this.roomsOf.set(id, new Set([...(this.roomsOf.get(id) ?? []), spaceId]));
        return [this.primary];
      }
      const claw = this.clawAgentOf.get(id);
      return claw === undefined ? [] : [claw];
    });
    return [...new Set(takers)];
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
      case "membership.added":
      case "membership.removed":
      case "membership.replaced":
        return this.moved(event);
      // Said for somebody else (Chips ADR 0081): never a turn, and not kept. Its words come back
      // with the next message for OpenClaw in that room (ADR 0088).
      case "message.overheard":
        return;
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
    // Its own words, as the harness or as any of its agents, are never a turn.
    if (this.isOwn(String(from["participant_id"]))) return;
    // Chips says who a message is for (ADR 0081), and a `message.new` that says is this
    // harness's. A Chips from before then says nothing, and hands every harness everything:
    // there another harness's words are this one's only when they name it (ADR 0077's rule).
    const mentions = Array.isArray(event["mentions"]) ? (event["mentions"] as string[]) : [];
    const said = Array.isArray(event["addressed_to"]);
    const agentSaid = isAgentKind(from["kind"]);
    if (agentSaid && !said && !mentions.some((id) => this.isOwn(id))) return;
    const text = String(event["text"] ?? "");
    const words = wordsOf(event);
    const messageId = String(event["message_id"] ?? event["id"]);
    const takers = await this.turnTakers(event, spaceId);
    const attachments = takers.length === 0 ? {} : await this.attachments(event);
    for (const agent of takers) {
      const key = this.keyFor(spaceId, agent);
      await this.ensureSession(key, words, agent);
      if (this.asked.delete(spaceId)) await this.chips.claim(spaceId, key, titleFrom(words));
      await this.attachIn(spaceId, agent);
      // OpenClaw names a turn by its idempotency key: one message, one turn per agent.
      const turn = agent === this.primary ? messageId : `${messageId}:${agent}`;
      this.goals.set(turn, words);
      this.latest.set(key, words);
      await this.claw.request("chat.send", {
        sessionKey: key,
        message: this.withOverheard(agentSaid ? fromAgent(from, text) : text, event["context"]),
        idempotencyKey: turn,
        ...attachments,
      });
    }
  }

  /**
   * A turn's words, with what was said in the room since OpenClaw last spoke there ahead of them,
   * as Chips handed it over (ADR 0088).
   */
  private withOverheard(text: string, context: unknown): string {
    const lines = heardIn(context, (id) => this.isOwn(id));
    if (lines.length === 0) return text;
    return `Said in this room since you last spoke:\n${lines.join("\n")}\n\n${text}`;
  }

  /**
   * The session for a room, made the first time. Making it again with the same key adopts it and
   * changes nothing, so the key is its identity; no idempotency key is sent, because OpenClaw
   * refuses one reused with other parameters (a later room's words as the name, after a restart).
   */
  private async ensureSession(key: string, firstWords: string, agent: string): Promise<void> {
    if (this.sessions.has(key)) return;
    await this.claw.request("sessions.create", {
      key,
      agentId: agent,
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
    // Its own settle, delivered back, was OpenClaw's answer already.
    if (this.isOwn(String(event["resolved_by"]))) return;
    const asked = this.approvals.get(String(event["approval_id"]));
    if (asked === undefined) return;
    // Forgotten before OpenClaw is told, so its `resolved` event is not taken for an answer there.
    this.approvals.delete(String(event["approval_id"]));
    const decision = str(event["decision"]);
    const allowed = decision === "approved" || decision === "edited";
    // Chips offers every scope; OpenClaw may take only allow-once for a command (a native Codex
    // command does). A yes for always is then a yes for this once, rather than a refusal that
    // leaves the turn waiting for an answer that never comes.
    const always = event["scope"] === "always" && asked.always;
    await this.claw.request(asked.method, {
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
    if (this.isOwn(String(event["answered_by"]))) return;
    const clawId = this.questions.get(String(event["ask_id"]))?.id;
    if (clawId === undefined) return;
    this.questions.delete(String(event["ask_id"]));
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
      case "plugin.approval.requested":
        return this.asksPluginApproval(p);
      case "question.requested":
        return this.asksQuestion(p);
      case "exec.approval.resolved":
      case "plugin.approval.resolved":
        return this.settlesApproval(p);
      case "question.resolved":
        return this.settlesQuestion(p);
      default:
        return;
    }
  }

  /**
   * An approval answered in OpenClaw's own tools (its command line, its TUI), so the Chips card
   * cools rather than waiting out its expiry (ADR 0079). Once: This session and Always are a
   * person's to give in Chips. An ask Chips answered was forgotten when OpenClaw was told.
   */
  private settlesApproval(p: Payload): void {
    const clawId = str(p["id"]);
    const entry = [...this.approvals].find(([, asked]) => asked.id === clawId);
    if (entry === undefined) return;
    const [approvalId, asked] = entry;
    const decision = str(p["decision"]);
    if (decision !== "allow-once" && decision !== "allow-always" && decision !== "deny") return;
    this.approvals.delete(approvalId);
    this.write(asked.run, {
      type: "approval.resolved",
      run_id: asked.run.chipsRun,
      approval_id: approvalId,
      decision: decision === "deny" ? "denied" : "approved",
      scope: "once",
      reason: "Answered in OpenClaw.",
      idempotency_key: `openclaw-approval:${clawId}:settled`,
    });
  }

  /** A question answered in OpenClaw's own tools; a cancelled or expired one is Chips's to time out. */
  private settlesQuestion(p: Payload): void {
    const clawId = str(p["id"]);
    const entry = [...this.questions].find(([, asked]) => asked.id === clawId);
    if (entry === undefined || p["status"] !== "answered") return;
    const [askId, asked] = entry;
    this.questions.delete(askId);
    const given = ((p["answers"] ?? {}) as Payload)["answers"];
    const answers = Object.entries((given ?? {}) as Record<string, unknown>).map(([questionId, values]) => ({
      question_id: questionId,
      values: Array.isArray(values) ? values.map(String) : [],
    }));
    if (answers.length === 0) return;
    this.write(asked.run, {
      type: "question.answered",
      run_id: asked.run.chipsRun,
      ask_id: askId,
      answers,
      idempotency_key: `openclaw-question:${clawId}:settled`,
    });
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
      agentId: this.speakerIn(spaceId, this.agentFor(sessionKey)),
      chain: Promise.resolve(),
      ended: false,
    };
    this.runs.set(clawRun, run);
    this.runByChips.set(run.chipsRun, run);
    const own = this.goals.get(clawRun);
    this.goals.delete(clawRun);
    const latest = this.latest.get(sessionKey);
    const goal = own ?? (latest === undefined ? "Answer in the room." : `Following up: ${latest}`);
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
    // No `to`, even for an answer to another harness: it acts on the words only when they @ it.
    // Sending it back by itself kept Jacobian and OpenClaw trading thanks until Chips's guard
    // held the fifth (the live test, 27 September 2026).
    if (text !== "") {
      this.write(run, {
        type: "message.post",
        run_id: run.chipsRun,
        text,
        idempotency_key: `openclaw-run:${clawRun}:reply`,
      });
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
      // A queued message's own turn can end empty, its answer given in a follow-up turn.
      summary: text === "" ? "No reply of its own; answered in the next turn." : text.slice(0, 20_000),
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
      ...(summaryOf(data) === undefined ? {} : { summary: summaryOf(data) }),
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
    this.approvals.set(approvalId, { id: clawId, always, method: "exec.approval.resolve", run });
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

  /**
   * A plugin's ask. Codex's own shell asks this way ("Codex app-server command approval") when the
   * model runs a command natively rather than through OpenClaw's exec tool; the command is on the
   * description's `Command:` line.
   */
  private asksPluginApproval(p: Payload): void {
    const clawId = str(p["id"]);
    const request = (p["request"] ?? {}) as Payload;
    const sessionKey = str(request["sessionKey"]);
    const clawRun = str(request["runId"]);
    if (clawId === undefined || sessionKey === undefined) return;
    const run = clawRun === undefined ? this.latestRun(sessionKey) : this.runFor(clawRun, sessionKey);
    if (run === undefined) return;
    const title = str(request["title"]) ?? "Allow this?";
    const description = str(request["description"]) ?? "";
    const command = /^Command: (.+)$/m.exec(description)?.[1];
    const approvalId = chipsId("apr", `openclaw-approval:${clawId}`);
    const offered = Array.isArray(request["allowedDecisions"]) ? (request["allowedDecisions"] as unknown[]) : undefined;
    const always = offered === undefined || offered.includes("allow-always");
    this.approvals.set(approvalId, { id: clawId, always, method: "plugin.approval.resolve", run });
    const expires = num(p["expiresAtMs"]);
    this.write(run, {
      type: "approval.request",
      run_id: run.chipsRun,
      approval_id: approvalId,
      action:
        command === undefined
          ? { kind: "tool.call", input: { tool: str(request["toolName"]) ?? "a tool", title } }
          : { kind: "shell.exec", input: { command } },
      preview: {
        format: "markdown",
        title: command === undefined ? title.slice(0, 120) : "Run a command",
        body: command === undefined ? description || title : `\`\`\`sh\n${command}\n\`\`\``,
      },
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
    this.questions.set(askId, { id: clawId, run });
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
    // Said as the agent the turn is by (Chips ADR 0087).
    const said = run.agentId === undefined ? event : { ...event, actor: { kind: "agent", id: run.agentId } };
    run.chain = run.chain.then(async () => {
      try {
        await this.chips.send(said);
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

/** A step's line for the receipt: what OpenClaw says the call is for, cut to one short line. */
function summaryOf(data: Payload): string | undefined {
  const line = str(data["meta"]) ?? str(data["title"]);
  if (line === undefined || line.trim() === "") return undefined;
  const one = line.trim().split("\n")[0] ?? "";
  return one.length <= 200 ? one : `${one.slice(0, 199)}…`;
}
