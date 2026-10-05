/**
 * The mapping. Each OpenClaw agent is an agent in Chips; one agent in one Chips room is one
 * OpenClaw session; one OpenClaw turn is one Chips run.
 *
 * - Every agent the gateway lists (`agents.list`) is registered in Chips as one of this harness's
 *   agents, keyed by its OpenClaw id, all on the one token (Chips ADR 0087). `OPENCLAW_AGENT`
 *   keeps it to one. An agent with no name of its own is called what the harness is, so the
 *   rooms go on saying OpenClaw. An agent is in one room at a time, and Chips says where
 *   (`agent.attached`, `agent.released`), so the bridge moves nobody at start. One takes the
 *   default agent's place in a room only when a message there is for the default agent and the
 *   OpenClaw agent is in no room.
 * - Each of our agents in Chips is one OpenClaw session, and no two share one. A session key is
 *   made from the OpenClaw agent and a room's id, so the bridge keeps no map of its own. A room
 *   asked from the + is claimed under a key of the claim's own (`…:asked`), and Chips puts that
 *   key's own agent in it: the session is the agent's wherever it is moved, so it keeps its
 *   conversation. An OpenClaw agent, or the harness's default agent, has one session per room
 *   instead, named from both, and named for whose it is (`…:own`, `…:default`) where that name
 *   is another of our agents' already.
 * - A message says which of our agents it is for (`for`), once the harness declares `agents`;
 *   each takes a turn in its own session. Before that, it is the room's agent's. One of our
 *   agents' words for another of them is that one's turn, never the sayer's (Chips ADR 0101).
 * - A room a person asks for from the +, of this harness or of it beside another, is claimed on
 *   the first message for the harness itself, named from its words. A message for one of our
 *   agents there is that agent's, and claims nothing.
 * - A person's words go to the session with `chat.send`, keyed by the message's id, with what the
 *   turn's conversation has not been told of the room ahead of them: what Chips carries with the
 *   message (since the agent last spoke), the catch-up it handed on joining, and what the
 *   conversation missed, read from Chips's pull route — the room's recent lines the first time
 *   the bridge hands the agent a turn there, the lines said while its last turn there went. Ahead
 *   of all of it, Chips's note on the room for the agent taking the turn (Chips ADR 0092): who is
 *   there, with the @ that reaches each, and that only those @-mentioned act. And ahead of that,
 *   Chips's own word to the agent (the referee): that it held what the agent last said there, and
 *   how the agents' talk in the room stands. Every send steers (`queueMode: "steer"`): words that
 *   arrive while the session's turn runs join it, and words between turns start one.
 * - OpenClaw's `chat` events for a turn become a run: started on the first, answered and completed
 *   on `final`, failed on `error` or `aborted`. Its tool events become steps.
 * - A file the answer sends (a `MEDIA:` line of its own, which the gateway takes out of the words
 *   and reports on the turn's `assistant` stream) is read where OpenClaw keeps it, uploaded, and
 *   posted with the answer's words as one message (`media.ts`). One that cannot go is said in the
 *   message instead.
 * - The room's files (Chips ADR 0099): a turn is handed, inline, the current version of each file
 *   of the room its words name, where Chips lists the room's files with the message, and is told
 *   of a room's file the message carries as of one it was handed; and a file its
 *   answer sends back under one of those names is posted as the next version, naming the version
 *   it was made from (`room-files.ts`). One Chips refuses as made from a stale version is left out
 *   of the post, which says why, and the session's next turn there is told.
 * - An exec approval becomes an approval card, and the person's answer goes back as allow-once,
 *   allow-always or deny. An `ask_user` question becomes a question card. An ask answered in
 *   OpenClaw's own tools instead is settled in Chips, once, so its card cools (Chips ADR 0079).
 *
 * Every Chips id is derived from OpenClaw's, so everything written again after a restart is the
 * same event and Chips answers it as a duplicate.
 */

import { type ChipsAgent, type ChipsEvent, ChipsRefusal, type NewAgent, type Placed, type Taken } from "./chips.ts";
import { chipsId } from "./ids.ts";
import type { Media } from "./media.ts";
import type { ClawEvent } from "./openclaw.ts";
import { filesLine, namedIn, ROOM_FILES, type RoomFile, roomFilesIn, STALE_FILE, staleIn } from "./room-files.ts";

/** What the bridge needs of Chips; the `Chips` client, or a stand-in in the tests. */
export interface ChipsPort {
  /** One event; Chips's answer, when it gives one the bridge reads (a held message). */
  send(event: ChipsEvent): Promise<Taken | undefined>;
  claim(spaceId: string, key: string, title: string | undefined): Promise<void>;
  fetchAttachment(url: string): Promise<Buffer>;
  /** A file's bytes, uploaded; the upload's id, for a post's `upload_ids`. */
  upload(filename: string, bytes: Buffer): Promise<string>;
  agents(): Promise<ChipsAgent[]>;
  registerAgent(agent: NewAgent): Promise<ChipsAgent & Placed>;
  attach(agentId: string, spaceId: string, replacing: string): Promise<boolean>;
  roomContext(spaceId: string, before: number, limit: number): Promise<unknown>;
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

/** The files an OpenClaw turn names with `MEDIA:` lines, read where the gateway keeps them (`media.ts`). */
export interface FilesPort {
  read(reference: string): Promise<Media>;
}

const NO_FILES: FilesPort = {
  read: async (reference) => ({ kind: "refused", name: reference, why: "the bridge reads no files" }),
};

/** As many files as one Chips post takes. */
const MAX_FILES = 20;

interface Run {
  readonly chipsRun: string;
  /**
   * The room the turn is said in; none for a turn OpenClaw started for an agent in no room, which
   * has no run in Chips: only its words go, and Chips holds them until the agent joins a room.
   */
  readonly spaceId: string | undefined;
  readonly sessionKey: string;
  /** The Chips agent the turn is by, whose name every write on it carries (Chips ADR 0087). */
  readonly agentId: string | undefined;
  /** Whether a message in the room asked for this turn, or OpenClaw started it on its own. */
  readonly asked: boolean;
  /** Writes for one run go in order. */
  chain: Promise<void>;
  ended: boolean;
  /** What the turn's answer named to send (`MEDIA:` lines), as its `assistant` stream reported them. */
  readonly media: string[];
  /** The files its answer uploaded, by upload id: each one's name. */
  readonly uploaded: Map<string, string>;
  /** The answer as it was posted, files' notes and links included, for the run's summary. */
  reply?: string;
  /**
   * The answer's words as the model wrote them, from its `assistant` stream. OpenClaw leaves a
   * `NO_REPLY` out of the chat it sends, so the turn ends with no words; this says it passed.
   */
  said?: string;
  /** The names of the files the answer carried. */
  sent?: string[];
  /** When the bridge first heard of the turn: its model calls in OpenClaw's history are after it. */
  readonly startedAt: number;
  /** From the turn's `lifecycle` model phase and its `usage` stream, reported when it ends. */
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  contextTokens?: number;
  contextWindow?: number;
}

type Payload = Record<string, unknown>;

/** Who takes a turn on a message: one of our Chips agents, and the OpenClaw agent and session it speaks with. */
interface Taker {
  /** The Chips agent the message is for; none for the harness itself, or from a Chips that does not say. */
  readonly agentId: string | undefined;
  readonly clawAgent: string;
  readonly sessionKey: string;
}

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

/**
 * How much of a room a catch-up the bridge reads for itself carries: what Chips hands with a
 * message by default (ADR 0088), lines and characters.
 */
const CATCH_UP = { lines: 20, chars: 4000 } as const;

/** One of the room's lines Chips handed over with a message (Chips ADR 0088), as OpenClaw is told it. */
function contextLineOf(line: Payload, self?: string): string | undefined {
  const from = line["from"] as Payload | undefined;
  // Its own words are its own: two of our agents in one room may go by one name.
  const name = self !== undefined && str(from?.["id"]) === self ? "You" : (str(from?.["name"]) ?? "Someone");
  const flat = (words: unknown): string => (str(words) ?? "").replace(/\s*\n\s*/g, " ").trim();
  switch (line["kind"]) {
    case "said": {
      // What it sent, by name, after its words: a file the room keeps is fetched by the name a line says (Chips ADR 0099).
      const files = Array.isArray(line["files"]) ? (line["files"] as unknown[]).filter((each) => typeof each === "string") : [];
      const sent = files.length > 0 ? `(sent ${files.join(", ")})` : "";
      const words = [flat(line["text"]) || flat(line["transcript"]), sent].filter((part) => part !== "").join(" ");
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
 * spoke there, read from Chips's log, so a restart of the bridge loses none. A message the turn's
 * conversation had a turn of its own on is left out: `own` says which those were. Lines `self`
 * said read as its own. Nothing when the message carries no context.
 */
export function heardIn(context: unknown, own: (participantId: string) => boolean, self?: string): string[] {
  const lines = (context as Payload | null | undefined)?.["lines"];
  if (!Array.isArray(lines)) return [];
  return lines.flatMap((each) => {
    if (typeof each !== "object" || each === null) return [];
    const told = tookTurn(each, own) ? undefined : contextLineOf(each as Payload, self);
    return told === undefined ? [] : [told];
  });
}

/**
 * Whether a line is a message a conversation had a turn of its own on: one for somebody `own` says
 * is it, or one from before Chips said who a message was for, which every harness took.
 */
function tookTurn(each: unknown, own: (participantId: string) => boolean): boolean {
  if (typeof each !== "object" || each === null) return false;
  const line = each as Payload;
  const addressed = line["addressed_to"];
  return (
    line["kind"] === "said" &&
    (!Array.isArray(addressed) || (addressed as unknown[]).some((id) => typeof id === "string" && own(id)))
  );
}

/** A context's lines, or none. */
function linesIn(context: unknown): unknown[] {
  const lines = (context as Payload | null | undefined)?.["lines"];
  return Array.isArray(lines) ? lines : [];
}

/** Lines from more than one read of a room, each once, oldest first. */
function mergedLines(lines: readonly unknown[]): Payload[] {
  const seen = new Set<number>();
  const kept: Payload[] = [];
  for (const each of lines) {
    if (typeof each !== "object" || each === null) continue;
    const line = each as Payload;
    const at = num(line["seq"]);
    if (at !== undefined) {
      if (seen.has(at)) continue;
      seen.add(at);
    }
    kept.push(line);
  }
  return kept.every((line) => num(line["seq"]) !== undefined)
    ? kept.sort((a, b) => Number(a["seq"]) - Number(b["seq"]))
    : kept;
}

/** The newest lines whose words fit in `chars`, oldest first; the newest always. */
function newestWithin(lines: readonly Payload[], chars: number): Payload[] {
  const kept: Payload[] = [];
  let used = 0;
  for (const line of [...lines].reverse()) {
    used += (str(line["text"])?.length ?? 0) + (str(line["transcript"])?.length ?? 0) + 40;
    if (used > chars && kept.length > 0) break;
    kept.unshift(line);
  }
  return kept;
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

/** What a turn's model calls cost in all, and the tokens they took in and gave out. */
export interface Spent {
  readonly usd: number;
  readonly input: number;
  readonly output: number;
}

/**
 * What the model calls in a session's history since `since` (ms) cost: each assistant message
 * OpenClaw priced, `usage.cost.total`, its tokens in (fresh, cached and written to the cache) and
 * out. Nothing when none since was priced.
 */
export function spentIn(messages: unknown, since: number): Spent | undefined {
  if (!Array.isArray(messages)) return undefined;
  let usd = 0;
  let input = 0;
  let output = 0;
  let priced = false;
  for (const message of messages) {
    if (message === null || typeof message !== "object") continue;
    const m = message as Payload;
    if (m["role"] !== "assistant" || !((num(m["timestamp"]) ?? -1) >= since)) continue;
    const usage = (m["usage"] ?? {}) as Payload;
    const total = num((usage["cost"] as Payload | undefined)?.["total"]);
    if (total === undefined || total <= 0) continue;
    priced = true;
    usd += total;
    input += (num(usage["input"]) ?? 0) + (num(usage["cacheRead"]) ?? 0) + (num(usage["cacheWrite"]) ?? 0);
    output += num(usage["output"]) ?? 0;
  }
  return priced ? { usd: Math.round(usd * 1e6) / 1e6, input, output } : undefined;
}

/**
 * The turn's usage with what its history says it cost: the cost, and its tokens in when its
 * events never said them. A cost the turn's own events carried is kept. With no tokens from its
 * events, the history's alone.
 */
export function withSpend(usage: Payload | undefined, spent: Spent | undefined, model: string): Payload | undefined {
  if (spent === undefined) return usage;
  const base = usage ?? usageOf({ input: spent.input, output: spent.output }, model);
  if (base === undefined) return undefined;
  return {
    ...base,
    ...(base["input_tokens"] === undefined && spent.input > 0 ? { input_tokens: spent.input } : {}),
    ...(base["cost"] === undefined ? { cost: { usd: spent.usd, estimated: true } } : {}),
  };
}

/**
 * A session key the bridge made: the OpenClaw agent, the room it is a session in, and, where the
 * plain name would be another of our agents' session, whose it is: `asked` for a room's claim,
 * `own` for the OpenClaw agent's own, `default` for the harness's default agent.
 */
const SESSION = /^agent:([^:]+):chips-([^:]+)(?::(asked|own|default|made-[0-9a-z]+))?$/;

/** Whose a session is, where its name says (`SESSION`'s last part): `made` for a new agent's. */
type Whose = "asked" | "own" | "default" | "made";

/** How long a room in Chips waits for a new agent asked for (Chips ADR 0108): a minute. */
const NEW_AGENT_WAIT_MS = 60_000;

/** What Chips calls a sender that is an agent: `harness` before a harness declares `agents`, `agent` after. */
const isAgentKind = (kind: unknown): boolean => kind === "harness" || kind === "agent";

/**
 * Another harness's words, as OpenClaw is given them: whose they are, and, from a Chips that sends
 * no room note, that it acts on the answer only when OpenClaw addresses it by the handle Chips
 * answers it to (Chips ADR 0081). With the note, the note says so for everybody in the room (Chips
 * ADR 0092), and saying it twice is saying two things.
 */
function fromAgent(from: Payload, text: string, noted: boolean): string {
  const name = str(from["display_name"]) ?? "Another agent";
  if (noted) return `${name} (an agent in this room) said this to you:\n${text}`;
  const handle = `@${name.replace(/\s+/g, "")}`;
  return `${name} (an agent in this room) said this to you. Everyone here reads your answer; ${name} acts on it only if you address it as ${handle}:\n${text}`;
}

/**
 * What Chips tells one who takes the turn of the room (Chips ADR 0092): who is in it, with the @
 * that reaches each, and that only those @-mentioned act. Keyed by the id `for` names it by: one of
 * our agents, or the harness itself where it takes the turn. Nothing from a Chips that sends none.
 */
function noteFor(event: ChipsEvent, takerId: string): string | undefined {
  const room = event["room"] as Payload | undefined;
  const notes = room?.["notes"] as Payload | undefined;
  const note = str(notes?.[takerId])?.trim();
  return note === undefined || note === "" ? undefined : note;
}

/**
 * What Chips says of the agents' talk in a room, once it is worth a word (the referee): how many
 * messages they have sent each other since a person last acted, what was made and what repeats,
 * and, when the talk is going nowhere, the way out. Chips writes it; nothing from a Chips that
 * sends none.
 */
function exchangeNoteOf(event: ChipsEvent): string | undefined {
  const exchange = event["exchange"] as Payload | undefined;
  const note = str(exchange?.["note"])?.trim();
  return note === undefined || note === "" ? undefined : note;
}

/**
 * What an agent is told when Chips held what it said rather than hand it to the agents it named:
 * that they do not have it, why, and what to do instead, so it neither waits on them nor reports
 * a hand-over that did not happen. Nothing when Chips held nothing. The same words as Jacobian's.
 */
export function heldNoteOf(taken: Taken | undefined): string | undefined {
  if (taken?.held !== true) return undefined;
  const count = taken.exchange?.count;
  const since = typeof count === "number" && count > 0 ? ` (they have sent each other ${count} since a person last acted)` : "";
  return (
    `Your last message here was held, so the agents it named do not have it yet: messages between the agents in this room are held${since} until a person acts. ` +
    "Until then, tell the person what is done and what is blocked, rather than asking the agents again."
  );
}

/** The files a message carries, as Chips describes them. */
function attachmentsOf(event: ChipsEvent): Payload[] {
  return Array.isArray(event["attachments"]) ? (event["attachments"] as Payload[]) : [];
}

/**
 * Whether a message carries a room's file at its current version: that version's attachment, or
 * the same name and bytes posted again, which is the same version.
 */
function carries(onMessage: readonly Payload[], file: RoomFile): boolean {
  return onMessage.some(
    (each) =>
      str(each["attachment_id"]) === file.attachmentId ||
      (file.sha256 !== undefined && str(each["filename"]) === file.name && str(each["sha256"]) === file.sha256),
  );
}

/**
 * Whether a file is one a turn is told about when it comes on a message: not a photo, a video or a
 * voice note, which come with nearly every message a person sends from a phone, where a line
 * saying `image.png (v9)` would be noise. A turn that names one is still told.
 */
function isDocument(file: RoomFile): boolean {
  return !/^(image|video|audio)\//.test(file.mimeType);
}

/** How an agent says it has nothing to say (Chips ADR 0105); Chips makes a post of only it a pass. */
const NO_REPLY = "NO_REPLY";

/** `NO_REPLY` alone, as a model writes it: in backticks, bold or quotes, or with a full stop. */
function isNoReply(text: string): boolean {
  return /^[\s`*_"'“”]*NO_REPLY[\s`*_"'“”.!]*$/.test(text);
}

/**
 * A file as OpenClaw takes one with a message: inline, as base64. A picture goes as an image for
 * the model to look at. An SVG goes as text, which the model reads: no model takes one as a
 * picture. ASCII Art's design preview reached O2 as an image, and O2 said it had not loaded
 * (3 October 2026). Sent as a `file` it still did, since OpenClaw tells what a file is from its
 * type alone and looks at anything `image/` as a picture: so its type says text, and its name
 * still says SVG.
 */
function inlined(fileName: string, mimeType: string, bytes: Buffer): Payload {
  const svg = mimeType === "image/svg+xml";
  return {
    type: mimeType.startsWith("image/") && !svg ? "image" : "file",
    mimeType: svg ? "text/plain" : mimeType,
    fileName,
    content: bytes.toString("base64"),
    sizeBytes: bytes.length,
  };
}

export class Bridge {
  /** Rooms asked of this harness from the +, waiting for their first words to be claimed. */
  private readonly asked = new Set<string>();
  private readonly sessions = new Set<string>();
  private readonly runs = new Map<string, Run>();
  private readonly runByChips = new Map<string, Run>();
  /**
   * The turns the bridge asked for, by the idempotency key OpenClaw names each turn after: the
   * words, the room and the agent it is said as, since a session that came with an agent from
   * another room names the wrong one. And the latest words in each session, for a follow-up turn
   * OpenClaw starts on its own.
   */
  private readonly asks = new Map<string, { readonly words: string; readonly spaceId: string; readonly agentId: string | undefined }>();
  private readonly latest = new Map<string, string>();
  /**
   * What a session's next turn in a room is to be told, by session and room: that Chips held what
   * its last turn there said (`heldNoteOf`), or would not take a file it sent as made from a
   * version that is no longer current (Chips ADR 0099).
   */
  private readonly told = new Map<string, string[]>();
  /**
   * The version of each of a room's files a session has, by session and room, then by name: the one
   * it was handed, or the one its answer posted. What it sends back under that name replaces it.
   */
  private readonly versions = new Map<string, Map<string, string>>();
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

  /**
   * Our agents in Chips (ADR 0087), by Chips's id: our key for each — an OpenClaw agent, a
   * session, or the harness's own id for its default agent — and back.
   */
  private readonly keyOf = new Map<string, string>();
  private readonly agentByKey = new Map<string, string>();
  /** The one room each of our agents is in, as Chips last said; null when it is in none. */
  private readonly roomOf = new Map<string, string | null>();
  /**
   * What Chips handed with an agent put in a room (`agent.attached`'s `catch_up`), for its next
   * turn there; and where each last took a turn, so a catch-up leaves out what it heard already.
   */
  private readonly caughtUp = new Map<string, { readonly room: string; readonly lines: readonly unknown[] }>();
  private readonly lastHeard = new Map<string, { readonly room: string; readonly seq: number }>();
  /** The OpenClaw agent a room with no other gets: `OPENCLAW_AGENT`, else the gateway's default. */
  private primary: string;

  constructor(
    private readonly chips: ChipsPort,
    private readonly claw: ClawPort,
    private readonly self: { readonly harnessId: string; readonly agent: string },
    private readonly log: (message: string) => void,
    private readonly files: FilesPort = NO_FILES,
  ) {
    this.primary = self.agent;
  }

  /** The session an agent has in a room: one per agent and room, named from both. */
  keyFor(spaceId: string, agent: string = this.primary): string {
    return `agent:${agent}:chips-${spaceId.toLowerCase()}`;
  }

  /**
   * The key a room asked of this harness from the + is claimed under, and so the session of the
   * agent Chips makes for it. Its own shape, so that it is never an OpenClaw agent's session in a
   * room: a claim used to take the room's session, and the OpenClaw agent's own agent, added to
   * that room, was then the same OpenClaw conversation as the claim's. Every message there got
   * one turn, as whichever of the two came last.
   */
  claimKeyFor(spaceId: string): string {
    return `${this.keyFor(spaceId)}:asked`;
  }

  /**
   * The key a new agent a person asked for in a room is registered under (Chips ADR 0108), and so
   * its session: a conversation of its own on the primary agent, named for the ask, wherever
   * Chips moves it, as a + room's claim is.
   */
  madeKeyFor(spaceId: string, askId: string): string {
    return `${this.keyFor(spaceId)}:made-${askId.replace(/^evt_/, "").toLowerCase()}`;
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

  /** Whose a session is, when its name says. */
  private whoseFor(sessionKey: string): Whose | undefined {
    const whose = SESSION.exec(sessionKey)?.[3];
    return whose?.startsWith("made-") === true ? "made" : (whose as Whose | undefined);
  }

  /** Whether somebody in Chips is this harness: itself, or one of its agents. */
  isOwn(participantId: string): boolean {
    return participantId === this.self.harnessId || this.keyOf.has(participantId);
  }

  /** The harness's default agent in Chips, keyed by the harness's own id. */
  private get fallback(): string | undefined {
    return this.agentByKey.get(this.self.harnessId);
  }

  /**
   * Whether a room asks this harness from the +: first (`asked_of`), or beside another
   * (`also_asked_of`, Chips ADR 0087's addendum of 30 September). Either way it is claimed on its
   * first words, and Chips puts the claim key's own agent in the harness's place.
   */
  asksMe(event: Payload): boolean {
    const also = event["also_asked_of"];
    return event["asked_of"] === this.self.harnessId || (Array.isArray(also) && also.includes(this.self.harnessId));
  }

  // ------------------------------------------------------------------ OpenClaw's agents in Chips

  /**
   * OpenClaw's agents as this harness's agents in Chips (ADR 0087): each the gateway lists, or
   * only `only`, registered by its OpenClaw id and named as the gateway names it — or, with no
   * name of its own, as the harness is. Nobody is moved: an agent is in one room at a time, so
   * putting each in the default agent's rooms would have Chips refuse all but one. Each stays
   * where Chips has it, read again once all are registered.
   */
  async adoptAgents(listed: { defaultId?: string; agents?: readonly ClawAgent[] }, only?: string): Promise<void> {
    const agents = (listed.agents ?? []).filter((each) => each.kind !== "system" && (only === undefined || each.id === only));
    this.primary = only ?? listed.defaultId ?? this.primary;
    if (!agents.some((each) => each.id === this.primary)) agents.unshift({ id: this.primary });
    const known = await this.chips.agents();
    const harnessName = known.find((each) => each.key === this.self.harnessId)?.name ?? "OpenClaw";
    for (const agent of agents) {
      const named = agent.identity?.name ?? agent.name;
      const name = named === undefined || named === agent.id || named.trim() === "" ? harnessName : named.trim();
      try {
        await this.chips.registerAgent({ key: agent.id, name });
      } catch (error) {
        this.log(`chips refused agent ${agent.id}: ${String(error)}`);
      }
    }
    this.learn(await this.chips.agents());
  }

  /**
   * The Chips agent an OpenClaw agent's turn is said as in a room: its own, once Chips has it
   * there. Nothing otherwise, and Chips reads the harness as its one agent in the room.
   */
  private speakerIn(room: string, clawAgent: string | undefined): string | undefined {
    const agentId = clawAgent === undefined ? undefined : this.agentByKey.get(clawAgent);
    return agentId !== undefined && this.roomOf.get(agentId) === room ? agentId : undefined;
  }

  /** What Chips says our agents are: ids and keys both ways, and each one's room. */
  private learn(agents: readonly ChipsAgent[]): void {
    for (const agent of agents) {
      this.keyOf.set(agent.agent_id, agent.key);
      this.agentByKey.set(agent.key, agent.agent_id);
      this.roomOf.set(agent.agent_id, agent.room !== undefined ? agent.room : (agent.spaces[0] ?? null));
    }
  }

  /**
   * A person asked Chips for a new agent of this harness's in a room (Chips ADR 0108): one more
   * Chips agent on the primary OpenClaw agent, keyed by a session of its own (`madeKeyFor`), called
   * what the ask says, and registered `made_for` the ask with the room, which Chips puts it in
   * while the room waits. Only Chips's people who may ask can, so the bridge asks nothing more of
   * who it was; an ask of another harness, or one a replay hands over after the minute, makes
   * nothing. The same ask heard again registers the same key, which Chips answers as done.
   */
  private async makeAgent(event: ChipsEvent): Promise<void> {
    if (str(event["harness_id"]) !== this.self.harnessId) return;
    const room = str(event["space_id"]);
    const askId = str(event["id"]);
    const name = str(event["name"]);
    if (room === undefined || askId === undefined || name === undefined) return;
    if (!(Date.now() - Date.parse(str(event["ts"]) ?? "") < NEW_AGENT_WAIT_MS)) {
      this.log(`chips: not making ${name} for ${room}: the room stopped waiting for it`);
      return;
    }
    const key = this.madeKeyFor(room, askId);
    try {
      const made = await this.chips.registerAgent({ key, name, made_for: askId, space_id: room });
      this.learn([made]);
      const placed = made.attached === false && made.why !== undefined ? `, not in it: ${made.why}` : "";
      this.log(`chips: made ${made.name} for ${room}${placed}`);
    } catch (error) {
      this.log(`chips refused the new agent ${name}: ${String(error)}`);
    }
  }

  /**
   * One of ours put in a room (ADR 0087): its room now, and the room's last lines before it
   * joined (ADR 0088), for its next turn there — less what it heard there already, which is all
   * of them when the bridge's own claim or attach put it there in the middle of a turn.
   */
  private async attached(event: ChipsEvent): Promise<void> {
    const agentId = str(event["agent_id"]);
    const room = str(event["space_id"]);
    if (agentId === undefined || room === undefined) return;
    // One Chips made for a claim, or registered from somewhere else, is read for.
    if (!this.keyOf.has(agentId)) this.learn(await this.chips.agents());
    if (!this.keyOf.has(agentId)) return;
    this.roomOf.set(agentId, room);
    const from = str(event["moved_from"]);
    this.log(`chips: ${this.keyOf.get(agentId)} is in ${room}${from === undefined ? "" : `, moved from ${from}`}`);
    const heard = this.lastHeard.get(agentId);
    const lines = ((event["catch_up"] as Payload | undefined)?.["lines"] ?? []) as unknown[];
    const fresh = (Array.isArray(lines) ? lines : []).filter((line) => {
      const seq = num((line as Payload | null)?.["seq"]);
      return heard?.room !== room || seq === undefined || seq > heard.seq;
    });
    if (fresh.length > 0) this.caughtUp.set(agentId, { room, lines: fresh });
    else this.caughtUp.delete(agentId);
  }

  /**
   * One of ours deleted by a person in Chips (Chips ADR 0095): forgotten, so nothing more is said
   * as it, and Chips refuses its key from here — a restart's `agents.list` asks for `main` again,
   * and is told no. Its OpenClaw sessions stay: OpenClaw keeps its own copy of what was said.
   */
  private deleted(event: ChipsEvent): void {
    const agentId = str(event["agent_id"]);
    const key = agentId === undefined ? undefined : this.keyOf.get(agentId);
    if (agentId === undefined || key === undefined) return;
    this.keyOf.delete(agentId);
    if (this.agentByKey.get(key) === agentId) this.agentByKey.delete(key);
    this.roomOf.delete(agentId);
    this.caughtUp.delete(agentId);
    this.lastHeard.delete(agentId);
    this.log(`chips: ${key} was deleted`);
  }

  /** One of ours taken out of its room: free, until Chips puts it in another. Its OpenClaw sessions stay. */
  private released(event: ChipsEvent): void {
    const agentId = str(event["agent_id"]);
    if (agentId === undefined || !this.keyOf.has(agentId)) return;
    this.roomOf.set(agentId, null);
    const to = str(event["moved_to"]);
    this.log(`chips: ${this.keyOf.get(agentId)} left ${str(event["space_id"])} (${str(event["reason"]) ?? "removed"}${to === undefined ? "" : `, to ${to}`})`);
  }

  /**
   * One of ours gave its place in a room to another. Chips says `agent.attached` for the one that
   * came in, and nothing for the one that went, which is in no room now.
   */
  private replaced(event: ChipsEvent): void {
    const from = str(event["from"]);
    if (from !== undefined && this.roomOf.get(from) === str(event["space_id"])) this.roomOf.set(from, null);
  }

  /**
   * The OpenClaw agent and session one of our Chips agents speaks with in a room. An agent keyed
   * by a session (a room asked from the +) has that session wherever Chips moves it, so it keeps
   * its conversation. The harness itself, in a room asked of it, speaks in the session it claims
   * the room under, so the agent the claim makes goes on with the conversation it began. An agent
   * keyed by an OpenClaw agent has that agent's session in each room; the default agent, and the
   * harness itself in a room it is in from before agents, the primary agent's.
   */
  private takerFor(agentId: string | undefined, room: string): Taker {
    const key = agentId === undefined ? undefined : this.keyOf.get(agentId);
    const clawAgent = key === undefined ? undefined : this.agentFor(key);
    if (key !== undefined && clawAgent !== undefined) return { agentId, clawAgent, sessionKey: key };
    if (agentId === undefined && this.asked.has(room)) {
      return { agentId, clawAgent: this.primary, sessionKey: this.claimKeyFor(room) };
    }
    const fallback = key === undefined || key === this.self.harnessId;
    const agent = fallback ? this.primary : key;
    return { agentId, clawAgent: agent, sessionKey: this.sessionIn(room, agent, fallback ? "default" : "own", agentId) };
  }

  /**
   * The session an OpenClaw agent, or the default agent, has in a room: named from both, unless
   * that name is another of our agents' session — a room claimed before claims had keys of their
   * own was claimed under it — or, for the default agent, unless the primary agent's own agent is
   * in the room too, whose session it is then. Named for whose it is instead, so that no two of
   * our agents in Chips are one OpenClaw conversation.
   */
  private sessionIn(room: string, agent: string, whose: Whose, agentId: string | undefined): string {
    const plain = this.keyFor(room, agent);
    const holder = this.agentByKey.get(plain);
    const taken = holder !== undefined && holder !== agentId;
    const beside = whose === "default" && this.speakerIn(room, agent) !== undefined;
    return taken || beside ? `${plain}:${whose}` : plain;
  }

  /**
   * Who of ours takes a turn on a message. `for`, from a Chips that knows our agents: each of ours
   * it names, the harness itself as the primary agent (a room asked of it from the +, which its
   * claim gives to an agent). Chips named the harness itself in `addressed_to` alone before the
   * agents review (its finding 31), with `for` empty, and the first words in a room asked from the
   * + went unanswered: it is read from there too. Without `for`, the room's own: the harness in a
   * room asked of it, else whichever of ours Chips has there, else the primary agent. One turn per
   * session, and no two of our agents share one.
   */
  private async turnTakers(event: ChipsEvent, spaceId: string): Promise<Taker[]> {
    const named = event["for"];
    if (!Array.isArray(named)) {
      if (this.asked.has(spaceId)) return [this.takerFor(undefined, spaceId)];
      const here = [...this.roomOf].filter(([, room]) => room === spaceId).map(([agentId]) => agentId);
      return [this.takerFor(here.find((agentId) => agentId !== this.fallback) ?? here[0], spaceId)];
    }
    const ids = (named as unknown[]).filter((each): each is string => typeof each === "string");
    const addressed = Array.isArray(event["addressed_to"]) ? (event["addressed_to"] as unknown[]) : [];
    if (addressed.includes(this.self.harnessId) && !ids.includes(this.self.harnessId)) ids.unshift(this.self.harnessId);
    const ours = (id: string): boolean => id === this.self.harnessId || this.keyOf.has(id);
    if (!ids.every(ours)) this.learn(await this.chips.agents());
    const takers = ids.flatMap((id) => {
      if (id === this.self.harnessId) return [this.takerFor(undefined, spaceId)];
      return this.keyOf.has(id) ? [this.takerFor(id, spaceId)] : [];
    });
    return [...new Map(takers.map((taker) => [taker.sessionKey, taker])).values()];
  }

  /** The takers that are not the one of ours who said it, nor its conversation in the room. */
  private othersThan(sayer: string, room: string, takers: readonly Taker[]): Taker[] {
    const its = this.takerFor(sayer === this.self.harnessId ? undefined : sayer, room).sessionKey;
    return takers.filter((taker) => taker.agentId !== sayer && taker.sessionKey !== its);
  }

  /**
   * The Chips agent a turn is said as: the one it is for. For the default agent, the OpenClaw
   * agent's own takes its place when it is in no room; one in a room already stays there (an
   * agent is in one room at a time), and the default agent answers here.
   */
  private async speakerFor(room: string, taker: Taker): Promise<string | undefined> {
    const fallback = this.fallback;
    if (fallback === undefined || taker.agentId !== fallback) return taker.agentId;
    const own = this.agentByKey.get(taker.clawAgent);
    if (own === undefined || this.roomOf.get(own) !== null) return fallback;
    try {
      if (await this.chips.attach(own, room, fallback)) this.log(`chips: ${taker.clawAgent} is in ${room} now`);
      this.roomOf.set(fallback, null);
      this.roomOf.set(own, room);
      return own;
    } catch (error) {
      this.log(`chips refused ${taker.clawAgent} in ${room}: ${String(error)}`);
      return fallback;
    }
  }

  /**
   * Claim a room asked of this harness under the claim's key, which is the harness's session there.
   * Chips puts that key's own agent in the harness's place (ADR 0087), which is read for, and the
   * turn is said as it.
   */
  private async claim(spaceId: string, key: string, words: string): Promise<string | undefined> {
    await this.chips.claim(spaceId, key, titleFrom(words));
    this.learn(await this.chips.agents());
    const agentId = this.agentByKey.get(key);
    return agentId !== undefined && this.roomOf.get(agentId) === spaceId ? agentId : undefined;
  }

  /**
   * OpenClaw names a turn by its idempotency key: one message, one turn per session. The primary
   * agent's session in the room keeps the message's id; another OpenClaw agent's adds the agent,
   * and a session that came with its agent from another room adds that agent.
   */
  private turnOf(messageId: string, spaceId: string, taker: Taker): string {
    if (taker.sessionKey === this.keyFor(spaceId)) return messageId;
    if (taker.sessionKey === this.keyFor(spaceId, taker.clawAgent)) return `${messageId}:${taker.clawAgent}`;
    return `${messageId}:${taker.agentId ?? taker.clawAgent}`;
  }

  /** A room asked of this harness while the bridge was away (from `GET …/spaces`). */
  noteAsked(spaceId: string): void {
    this.asked.add(spaceId);
  }

  // ------------------------------------------------------------------ Chips → OpenClaw

  async onChips(event: ChipsEvent): Promise<void> {
    switch (event.type) {
      case "space.created":
        if (this.asksMe(event)) this.asked.add(String(event["space_id"]));
        return;
      case "message.new":
        return this.heard(event);
      // Where our agents are, as Chips says it (ADR 0087): one room each, or none.
      case "agent.attached":
        return this.attached(event);
      // A new agent a person asked for in a room (Chips ADR 0108).
      case "agent.asked":
        return this.makeAgent(event);
      case "agent.released":
        return this.released(event);
      // One of ours deleted by a person (Chips ADR 0095): forgotten here.
      case "agent.deleted":
        return this.deleted(event);
      case "membership.replaced":
        return this.replaced(event);
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
      // A room's job at 80% of its spend ceiling, or at it (Chips ADR 0118). OpenClaw runs a turn
      // per message and chains none of its own, so there is nothing to stop: Chips holds what our
      // agents say to each other there, and a person's next word is a new job. Said in the log.
      case "budget.warning":
        return this.budgeted(event);
      default:
        return;
    }
  }

  private budgeted(event: ChipsEvent): void {
    const budget = (event["budget"] ?? {}) as Payload;
    const figures = `$${(num(budget["spent_usd"]) ?? 0).toFixed(2)} of $${(num(budget["limit_usd"]) ?? 0).toFixed(2)}`;
    if (event["scope"] !== "job") {
      this.log(`chips says this harness has spent ${figures} of its budget (${String(event["action"])})`);
      return;
    }
    const room = str(event["space_id"]) ?? "a room";
    this.log(
      event["action"] === "pause"
        ? `chips paused the agents in ${room}: its job has spent ${figures}, all it allows; they wait for a person`
        : `the job in ${room} has spent ${figures} it allows`,
    );
  }

  /**
   * What a turn cost, as OpenClaw's history of the session prices each of its model calls: the
   * assistant messages since the turn began, each with `usage.cost.total`. Nothing when the
   * history says no cost, or cannot be read; the turn's tokens are still reported.
   */
  private async spentBy(run: Run): Promise<Spent | undefined> {
    try {
      const history = await this.claw.request<{ messages?: unknown }>("chat.history", {
        sessionKey: run.sessionKey,
        limit: 50,
      });
      return spentIn(history.messages, run.startedAt);
    } catch (error) {
      this.log(`could not read what ${run.chipsRun} cost from OpenClaw's history: ${String(error)}`);
      return undefined;
    }
  }

  private async heard(event: ChipsEvent): Promise<void> {
    const spaceId = str(event["space_id"]);
    const from = event["from"] as Payload | undefined;
    if (spaceId === undefined || from === undefined) return;
    // Its own words are never a turn for the one who said them. One of its agents' words for
    // another of them are that one's turn, and Chips names it in `for` (Chips ADR 0101); a Chips
    // that names nobody hands no turn on them.
    const sayer = String(from["participant_id"]);
    const own = this.isOwn(sayer);
    if (own && !Array.isArray(event["for"])) return;
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
    const seq = num(event["seq"]);
    const takers = own ? this.othersThan(sayer, spaceId, await this.turnTakers(event, spaceId)) : await this.turnTakers(event, spaceId);
    const attachments = takers.length === 0 ? [] : await this.attachments(event);
    for (const taker of takers) {
      await this.ensureSession(taker.sessionKey, words, taker.clawAgent);
      // The harness itself claims the room it was asked for; one of our agents a message there is
      // for answers as itself, in its own session, and claims nothing.
      const claiming = taker.agentId === undefined && this.asked.has(spaceId);
      if (claiming) this.asked.delete(spaceId);
      const agentId = claiming ? await this.claim(spaceId, taker.sessionKey, words) : await this.speakerFor(spaceId, taker);
      const turn = this.turnOf(messageId, spaceId, taker);
      this.asks.set(turn, { words, spaceId, agentId });
      this.latest.set(taker.sessionKey, words);
      const caughtUp = agentId === undefined ? undefined : this.caughtUpIn(agentId, spaceId);
      const heard = agentId === undefined ? undefined : this.lastHeard.get(agentId);
      const missed = await this.missedIn(spaceId, event["context"], heard, agentId);
      const fresh = heard?.room !== spaceId;
      if (agentId !== undefined && seq !== undefined) this.lastHeard.set(agentId, { room: spaceId, seq });
      // Chips's note on the room comes first, ahead of what was said and the words (ADR 0092), and
      // Chips's own word to the agent ahead of that (the referee).
      const note = noteFor(event, taker.agentId ?? this.self.harnessId);
      const message = this.withOverheard(agentSaid ? fromAgent(from, text, note !== undefined) : text, event["context"], {
        caughtUp,
        missed,
        fresh,
        speaker: agentId,
        harnessTurns: this.keyOf.get(taker.agentId ?? "") !== taker.clawAgent,
      });
      const chips = [...this.takeTold(taker.sessionKey, spaceId), exchangeNoteOf(event)]
        .filter((line): line is string => line !== undefined)
        .map((line) => `Chips: ${line}`);
      // The room's files the turn's words name, at their current version (Chips ADR 0099).
      const files = await this.roomFiles(taker.sessionKey, spaceId, event, [...chips, message].join("\n"));
      const sent = [...attachments, ...files.sent];
      // Steered: into the session's turn while one runs, a turn of its own when none does. Said, not
      // left to OpenClaw's stored queue mode, which could make it wait for a turn after.
      await this.claw.request("chat.send", {
        sessionKey: taker.sessionKey,
        message: [...chips, note, files.line, message].filter((part) => part !== undefined).join("\n\n"),
        idempotencyKey: turn,
        queueMode: "steer",
        ...(sent.length === 0 ? {} : { attachments: sent }),
      });
      files.took();
    }
  }

  /**
   * The room's files a turn's words name, fetched at their current version for its session (Chips
   * ADR 0099): those the session does not have already, five at most, of five MB each; the line
   * that tells it what it was handed and what not. A room file on the message itself is the
   * session's with it. What it is handed is its version once the send is made (`took`), and what
   * it sends back under that name replaces it.
   */
  private async roomFiles(
    sessionKey: string,
    spaceId: string,
    event: ChipsEvent,
    words: string,
  ): Promise<{ sent: Payload[]; line: string | undefined; took: () => void }> {
    const files = roomFilesIn(event["context"]);
    if (files.length === 0) return { sent: [], line: undefined, took: () => undefined };
    const has = this.versionsOf(sessionKey, spaceId);
    const onMessage = attachmentsOf(event);
    const carried = files.filter((file) => carries(onMessage, file));
    const wanted = namedIn(files, words).filter(
      (file) => !carried.includes(file) && has.get(file.name) !== file.attachmentId,
    );
    const sent: Payload[] = [];
    const handed: RoomFile[] = [];
    const left: { file: RoomFile; why: string }[] = [];
    for (const file of wanted) {
      const why =
        handed.length >= ROOM_FILES.most
          ? `since a turn is handed ${ROOM_FILES.most} files at most`
          : (file.byteSize ?? 0) > ROOM_FILES.bytes
            ? `since it is larger than ${ROOM_FILES.bytes / 1024 / 1024} MB`
            : undefined;
      if (why !== undefined) {
        left.push({ file, why });
        continue;
      }
      try {
        sent.push(inlined(file.name, file.mimeType, await this.chips.fetchAttachment(file.url)));
        handed.push(file);
      } catch (error) {
        this.log(`chips: could not fetch ${file.name} for ${sessionKey}: ${String(error)}`);
        left.push({ file, why: "since it could not be fetched" });
      }
    }
    // A room file attached to the message is told as one handed by name is, so what goes back
    // under its name is its next version (Chips ADR 0101): O2 had K–O posted as a new file.
    return {
      sent,
      line: filesLine([...carried.filter(isDocument), ...handed], left),
      took: () => {
        for (const file of [...carried, ...handed]) has.set(file.name, file.attachmentId);
      },
    };
  }

  /** The version of each of a room's files a session has there, by name. */
  private versionsOf(sessionKey: string, spaceId: string): Map<string, string> {
    const key = `${sessionKey} ${spaceId}`;
    const has = this.versions.get(key) ?? new Map<string, string>();
    this.versions.set(key, has);
    return has;
  }

  /** What Chips handed with an agent when it was put in this room, once: for its first turn there. */
  private caughtUpIn(agentId: string, room: string): unknown {
    const kept = this.caughtUp.get(agentId);
    if (kept?.room !== room) return undefined;
    this.caughtUp.delete(agentId);
    return { lines: kept.lines };
  }

  /**
   * A turn's words, with what was said in the room that its conversation has not been told ahead of
   * them (ADR 0088): for an agent new to the room, the room's last lines before it joined; the
   * lines its conversation missed (`missedIn`); and what Chips handed over with the message. Each
   * line once, oldest first, as the SDK's `renderContext` writes them.
   *
   * A line is left out when this conversation had a turn of its own on it: one for the agent the
   * turn is said as, and one for the harness itself where the conversation goes on from the
   * harness's — a claim's, the default agent's — but not one for another of our agents, which was a
   * turn in a conversation of its own. A first turn's catch-up keeps every line: whether this
   * conversation had a turn on one is what it cannot know. The speaker's own words read as its own.
   */
  private withOverheard(
    text: string,
    context: unknown,
    with_: {
      caughtUp?: unknown;
      missed?: readonly Payload[];
      /** Whether `missed` is a first turn's catch-up rather than what went by during the last turn. */
      fresh?: boolean;
      speaker?: string | undefined;
      harnessTurns: boolean;
    },
  ): string {
    const own = (id: string): boolean =>
      id === with_.speaker || (with_.harnessTurns && id === this.self.harnessId);
    const told = (lines: readonly unknown[]): unknown[] => lines.filter((each) => !tookTurn(each, own));
    const missed = with_.missed ?? [];
    const recent = with_.fresh === true && missed.length > 0;
    const all = mergedLines([
      ...told(linesIn(with_.caughtUp)),
      ...(recent ? missed : told(missed)),
      ...told(linesIn(context)),
    ]);
    const lines = heardIn({ lines: all }, () => false, with_.speaker);
    if (lines.length === 0) return text;
    const heading = recent ? "Said in this room lately:" : "Said in this room since you last spoke:";
    return `${heading}\n${lines.join("\n")}\n\n${text}`;
  }

  /**
   * The room's lines a turn's conversation has not had, which the message does not carry. Chips's
   * context starts after the agent's own last message in the room (`since_seq`), and a
   * conversation can be behind that:
   *
   * - The first time this bridge hands an agent a turn in a room, its conversation may be new — a
   *   session named afresh, or one OpenClaw does not have — or the catch-up it was handed on joining
   *   may have gone with a restart. It is given the room's recent lines up to that point; a
   *   conversation that had them is told them again, which ADR 0088 allows.
   * - After that, the lines said while its last turn there was going: another agent's answer to
   *   the same message lands before its own, and Chips's next context starts after its own.
   *
   * Read from Chips's pull route, within what Chips hands with a message.
   */
  private async missedIn(
    spaceId: string,
    context: unknown,
    heard: { readonly room: string; readonly seq: number } | undefined,
    speaker: string | undefined,
  ): Promise<Payload[]> {
    const since = num((context as Payload | null | undefined)?.["since_seq"]);
    if (since === undefined) return [];
    const from = heard?.room === spaceId ? heard.seq : 0;
    if (from >= since) return [];
    let page: unknown;
    try {
      page = await this.chips.roomContext(spaceId, since + 1, CATCH_UP.lines);
    } catch (error) {
      this.log(`chips: could not read ${spaceId}'s lines: ${String(error)}`);
      return [];
    }
    const missed = linesIn(page).filter((each): each is Payload => {
      if (typeof each !== "object" || each === null) return false;
      const line = each as Payload;
      const at = num(line["seq"]);
      // Its own words in the conversation it said them in are its already.
      const mine = from > 0 && str((line["from"] as Payload | undefined)?.["id"]) === speaker;
      return at !== undefined && at > from && at <= since && !mine;
    });
    return newestWithin(missed, CATCH_UP.chars);
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

  /** A message's photos and files, fetched from their signed URLs and sent inline. */
  private async attachments(event: ChipsEvent): Promise<Payload[]> {
    const sent: Payload[] = [];
    for (const file of attachmentsOf(event)) {
      const url = str(file["url"]);
      if (url === undefined) continue;
      const bytes = await this.chips.fetchAttachment(url);
      sent.push(inlined(str(file["filename"]) ?? "attachment", str(file["mime_type"]) ?? "application/octet-stream", bytes));
    }
    return sent;
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

  /**
   * The Chips run a turn is, started the first time the turn is heard from: in the room and as
   * the agent the bridge asked it in, or, for a turn OpenClaw started on its own, where its
   * session says.
   */
  private runFor(clawRun: string, sessionKey: string): Run | undefined {
    const known = this.runs.get(clawRun);
    if (known !== undefined) return known;
    const asked = this.asks.get(clawRun);
    const where = asked ?? this.whereSaid(sessionKey);
    if (where === undefined) return undefined;
    const run: Run = {
      chipsRun: chipsId("run", `openclaw-run:${clawRun}`),
      spaceId: where.spaceId,
      sessionKey,
      agentId: where.agentId,
      asked: asked !== undefined,
      chain: Promise.resolve(),
      ended: false,
      media: [],
      uploaded: new Map(),
      startedAt: Date.now(),
    };
    this.runs.set(clawRun, run);
    this.runByChips.set(run.chipsRun, run);
    this.asks.delete(clawRun);
    const latest = this.latest.get(sessionKey);
    const goal = asked?.words ?? (latest === undefined ? "Answer in the room." : `Following up: ${latest}`);
    this.write(run, {
      type: "run.started",
      run_id: run.chipsRun,
      space_id: where.spaceId,
      goal: goal.slice(0, 500),
      // A turn asked by a message is that message, already in the room, so Chips does not say it
      // again beside it; a turn OpenClaw started on its own has a goal nobody typed.
      ...(asked === undefined ? {} : { goal_from: "chips" }),
      idempotency_key: `openclaw-run:${clawRun}:started`,
    });
    for (const early of this.early.get(clawRun) ?? []) this.stream(run, early);
    this.early.delete(clawRun);
    return run;
  }

  /**
   * Where a turn OpenClaw started on its own is said, and as whom (ADR 0087). A session one of our
   * agents is keyed by is that agent's: in the room Chips last said it is in, or in none, and
   * Chips holds its words until it joins one. Any other session of ours is an OpenClaw agent's in
   * one room, named from both: its own agent's there, or the default agent's where its name says.
   * A claim's session that no agent is keyed by yet is the harness's own, in the room it was
   * asked for.
   */
  private whereSaid(sessionKey: string): { spaceId: string | undefined; agentId: string | undefined } | undefined {
    const agentId = this.agentByKey.get(sessionKey);
    if (agentId !== undefined) return { spaceId: this.roomOf.get(agentId) ?? undefined, agentId };
    const spaceId = this.spaceFor(sessionKey);
    if (spaceId === undefined) return undefined;
    const whose = this.whoseFor(sessionKey);
    if (whose === "asked") return { spaceId, agentId: undefined };
    const fallback = this.fallback;
    if (whose === "default" && fallback !== undefined && this.roomOf.get(fallback) === spaceId) {
      return { spaceId, agentId: fallback };
    }
    return { spaceId, agentId: this.speakerIn(spaceId, this.agentFor(sessionKey)) };
  }

  private clawRunOf(run: Run): string | undefined {
    for (const [clawRun, each] of this.runs) if (each === run) return clawRun;
    return undefined;
  }

  private chat(p: Payload): void {
    const clawRun = str(p["runId"]);
    const sessionKey = str(p["sessionKey"]);
    if (clawRun === undefined || sessionKey === undefined) return;
    // A turn whose first word is its end, with nothing in it, did nothing. OpenClaw took its
    // message into another turn of the session's and answered it there, so it starts no run,
    // which would end on a line of its own. The ASCII Art room had four of them on 3 October 2026,
    // each "Answered together with other words, in one reply.", and Arjun asked for them gone.
    if (!this.runs.has(clawRun) && !this.early.has(clawRun) && p["state"] === "final" && textOf(p["message"]).trim() === "") {
      this.asks.delete(clawRun);
      return;
    }
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
    // A turn that answered `NO_REPLY` passed (Chips ADR 0105): OpenClaw leaves the word out of its
    // chat, so the bridge says it, and Chips makes the post the turn's pass, which the room never
    // shows. Without it the run ended on "Answered together with other words, in one reply."
    const said = textOf(p["message"]).trim();
    const text = said === "" && run.media.length === 0 && isNoReply(run.said ?? "") ? NO_REPLY : said;
    // No `to`, even for an answer to another harness: it acts on the words only when they @ it.
    // Sending it back by itself kept Jacobian and OpenClaw trading thanks until Chips's guard
    // held the fifth (the live test, 27 September 2026).
    // The files the answer named go with its words, as one post, once they are uploaded.
    if (text !== "" || run.media.length > 0) {
      this.write(run, async () => {
        const files = await this.upload(run);
        run.reply = [text, ...files.notes].filter((part) => part !== "").join("\n\n");
        run.sent = files.names;
        if (run.reply === "" && files.ids.length === 0) return undefined;
        return {
          type: "message.post",
          run_id: run.chipsRun,
          text: run.reply,
          ...(files.ids.length === 0 ? {} : { upload_ids: files.ids }),
          // Each file sent back under the name of a room file the session has: the version it was made from.
          ...(Object.keys(files.replaces).length === 0 ? {} : { replaces: files.replaces }),
          idempotency_key: `openclaw-run:${clawRun}:reply`,
        };
      });
    }
    const model = run.model ?? str(p["model"]) ?? "openai";
    const streamed =
      usageOf(p["usage"], model) ??
      usageOf({ inputTokens: run.inputTokens, outputTokens: run.outputTokens }, model);
    // What the turn cost, from OpenClaw's own history of it: its events carry tokens and no cost,
    // and a room's job is counted from what its runs cost (Chips ADRs 0117, 0118).
    this.write(run, async () => {
      const usage = withSpend(streamed, await this.spentBy(run), model);
      return usage === undefined
        ? undefined
        : { type: "usage", run_id: run.chipsRun, ...usage, idempotency_key: `openclaw-run:${clawRun}:usage` };
    });
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
    // The whole reply as it was posted, so Chips draws the answer and the summary as one card
    // rather than two.
    this.write(run, () => {
      const reply = run.reply ?? text;
      const sent = run.sent ?? [];
      return {
        type: "run.completed",
        run_id: run.chipsRun,
        // A message's own turn ends empty when OpenClaw takes its words into another turn of the
        // session's, the one going or a follow-up, and answers them there with the rest; a turn
        // OpenClaw started on its own can simply end with nothing to say.
        summary:
          reply !== ""
            ? reply.slice(0, 20_000)
            : sent.length > 0
              ? `Sent ${sent.join(", ")}.`
              : run.asked
                ? "Answered together with other words, in one reply."
                : "Ended without a reply.",
        idempotency_key: `openclaw-run:${clawRun}:completed`,
      };
    });
  }

  /**
   * The files an answer named, uploaded for its post, as many as a post takes. What could not go
   * is said in the post instead, so the room knows it was meant to; a web address goes back into
   * the words it was taken from, since the bridge fetches nothing from the web. A file under the
   * name of a room file the session has is the next version of it, made from the one it has
   * (`replaces`, Chips ADR 0099).
   */
  private async upload(
    run: Run,
  ): Promise<{ ids: string[]; names: string[]; notes: string[]; replaces: Record<string, string> }> {
    const ids: string[] = [];
    const names: string[] = [];
    const notes: string[] = [];
    const replaces: Record<string, string> = {};
    const has = run.spaceId === undefined ? undefined : this.versions.get(`${run.sessionKey} ${run.spaceId}`);
    for (const reference of run.media) {
      const media = await this.files.read(reference);
      if (media.kind === "link") {
        notes.push(media.url);
        continue;
      }
      if (media.kind === "refused") {
        this.log(`bridge: ${reference} not attached for ${run.chipsRun}: ${media.why}`);
        notes.push(`(${media.name} was not attached: ${media.why}.)`);
        continue;
      }
      if (ids.length >= MAX_FILES) {
        notes.push(`(${media.filename} was not attached: a message takes ${MAX_FILES} files.)`);
        continue;
      }
      try {
        const id = await this.chips.upload(media.filename, media.bytes);
        ids.push(id);
        names.push(media.filename);
        run.uploaded.set(id, media.filename);
        const made = has?.get(media.filename);
        if (made !== undefined) replaces[id] = made;
      } catch (error) {
        const why = error instanceof ChipsRefusal ? error.message : String(error);
        this.log(`chips refused the upload of ${media.filename} for ${run.chipsRun}: ${why}`);
        notes.push(`(${media.filename} was not attached: Chips refused it: ${why})`);
      }
    }
    return { ids, names, notes, replaces };
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
      case "assistant":
        if (data["phase"] !== "commentary") run.said = str(data["text"]) ?? run.said;
        return this.named(run, data);
      default:
        return;
    }
  }

  /**
   * The files the answer names. OpenClaw takes each `MEDIA:` line out of the words and reports
   * the lot on the `assistant` stream, the last time with the final answer.
   */
  private named(run: Run, data: Payload): void {
    const urls = Array.isArray(data["mediaUrls"]) ? (data["mediaUrls"] as unknown[]) : [data["mediaUrl"]];
    for (const url of urls) {
      if (typeof url === "string" && url.trim() !== "" && !run.media.includes(url.trim())) run.media.push(url.trim());
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
    // A turn stopped or ended already has no card to ask on: Chips refuses one on a closed run.
    if (run === undefined || run.ended) return;
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
    // A turn stopped or ended already has no card to ask on: Chips refuses one on a closed run.
    if (run === undefined || run.ended) return;
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
    // A turn stopped or ended already has no card to ask on: Chips refuses one on a closed run.
    if (run === undefined || run.ended) return;
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

  /**
   * Write for a run, in order; a refusal is logged, never thrown into OpenClaw's event loop. A
   * write that is made when its turn comes (a post that waits for its files) is given as a function.
   */
  private write(run: Run, next: ChipsEvent | (() => ChipsEvent | undefined | Promise<ChipsEvent | undefined>)): void {
    run.chain = run.chain.then(async () => {
      let type = typeof next === "function" ? "a write" : next.type;
      try {
        const event = typeof next === "function" ? await next() : next;
        if (event === undefined) return;
        type = event.type;
        const words = run.spaceId === undefined ? this.roomless(event) : event;
        if (words === undefined) return;
        // Said as the agent the turn is by (Chips ADR 0087).
        const said = run.agentId === undefined ? words : { ...words, actor: { kind: "agent", id: run.agentId } };
        await this.say(run, said);
      } catch (error) {
        const why = error instanceof ChipsRefusal ? `${error.status} ${error.code}: ${error.message}` : String(error);
        this.log(`chips refused ${type} for ${run.chipsRun}: ${why}`);
      }
    });
  }

  /**
   * One event said. A post Chips refused because a file in it was made from a version of the room's
   * file that is no longer current (Chips ADR 0099) is said again without that file, saying why in
   * its words, so the answer is not lost; and the session's next turn in the room is told, so it
   * fetches the current version and redoes. Never a turn of its own for it, as for a hold.
   */
  private async say(run: Run, said: ChipsEvent): Promise<void> {
    let post = said;
    let taken: Taken | undefined;
    try {
      taken = await this.chips.send(said);
    } catch (error) {
      const again =
        error instanceof ChipsRefusal && error.code === STALE_FILE ? this.withoutStale(run, said, error.message) : undefined;
      if (again === undefined) throw error;
      this.log(`chips refused a stale file in ${run.chipsRun}'s answer: ${error instanceof Error ? error.message : ""}`);
      post = again;
      taken = await this.chips.send(again);
    }
    if (post.type === "message.post") this.posted(run, post, taken);
  }

  /** A refused post again, without the files it sent as new versions of stale ones, saying so. */
  private withoutStale(run: Run, said: ChipsEvent, why: string): ChipsEvent | undefined {
    const replaces = (said["replaces"] ?? {}) as Record<string, string>;
    const ids = Array.isArray(said["upload_ids"]) ? (said["upload_ids"] as string[]) : [];
    const versions = ids.filter((id) => replaces[id] !== undefined).map((id) => ({ id, name: run.uploaded.get(id) ?? id }));
    if (said.type !== "message.post" || versions.length === 0) return undefined;
    const stale = new Set(staleIn(why, versions));
    const kept = ids.filter((id) => !stale.has(id));
    const still = Object.fromEntries(Object.entries(replaces).filter(([id]) => !stale.has(id)));
    const notes = versions.filter((each) => stale.has(each.id)).map((each) => `(${each.name} was not posted: ${why})`);
    const { upload_ids: _ids, replaces: _replaces, ...words } = said;
    const text = [str(said["text"]) ?? "", ...notes].filter((part) => part !== "").join("\n\n");
    run.reply = text;
    run.sent = kept.map((id) => run.uploaded.get(id) ?? id);
    if (run.spaceId !== undefined) {
      this.tell(run.sessionKey, run.spaceId, `Your last answer here sent a file Chips did not take as its next version: ${why}`);
    }
    return {
      ...words,
      type: "message.post",
      text,
      ...(kept.length === 0 ? {} : { upload_ids: kept }),
      ...(Object.keys(still).length === 0 ? {} : { replaces: still }),
    };
  }

  /**
   * What Chips said of a turn's post: whether it held it, and the files it took, each now the
   * session's version of its name in the room.
   */
  private posted(run: Run, post: ChipsEvent, taken: Taken | undefined): void {
    this.onHeld(run, taken);
    if (run.spaceId === undefined) return;
    const has = this.versionsOf(run.sessionKey, run.spaceId);
    for (const id of Array.isArray(post["upload_ids"]) ? (post["upload_ids"] as string[]) : []) {
      const name = run.uploaded.get(id);
      if (name !== undefined) has.set(name, id);
    }
  }

  /**
   * What Chips held of a turn's answer, rather than hand it to the agents it named (the referee's
   * ceiling, or a person pausing the agents): the session's next turn in the room is told. Not the
   * turn that said it, which is over once its answer is posted, and never a turn of its own — a
   * steer to an idle session starts one, and what a turn on a hold said could be held again.
   */
  private onHeld(run: Run, taken: Taken | undefined): void {
    const note = heldNoteOf(taken);
    if (note === undefined || run.spaceId === undefined) return;
    this.tell(run.sessionKey, run.spaceId, note);
    this.log(`chips held ${run.chipsRun}'s answer; the session's next turn in ${run.spaceId} is told`);
  }

  /** Something for a session's next turn in a room to be told, first, as Chips's. */
  private tell(sessionKey: string, spaceId: string, note: string): void {
    const key = `${sessionKey} ${spaceId}`;
    this.told.set(key, [...(this.told.get(key) ?? []), note]);
  }

  /** What a session's turn in a room is to be told, once. */
  private takeTold(sessionKey: string, spaceId: string): string[] {
    const key = `${sessionKey} ${spaceId}`;
    const notes = this.told.get(key) ?? [];
    this.told.delete(key);
    return notes;
  }

  /**
   * What goes of a turn by an agent in no room: it has no run in Chips, so only its words, as a
   * post naming no room, which Chips holds and says in the next room the agent joins (ADR 0087).
   */
  private roomless(event: ChipsEvent): ChipsEvent | undefined {
    if (event.type === "message.post") {
      const { run_id: _run, ...words } = event;
      return words as ChipsEvent;
    }
    if (event.type === "approval.request" || event.type === "question.ask") {
      this.log(`chips: ${event.type} not asked: its agent is in no room`);
    }
    return undefined;
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
