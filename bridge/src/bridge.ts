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
 *   OpenClaw agent is in no room. The agents the bridge made itself are not listed again.
 * - Each agent Chips asks for, from the + or for a room, is an OpenClaw agent the bridge makes
 *   for it, with its own folder, memory and conversations (`own-agents.ts`), named in OpenClaw as
 *   it is in Chips; deleted in Chips, it is deleted in OpenClaw. One OpenClaw cannot make is not
 *   made in Chips either, and the room says so after its minute, as for any harness that never
 *   answers.
 * - Each agent the bridge made has its context in Chips (Chips ADR 0134, `context.ts`): a copy of
 *   the files OpenClaw builds it from, sent when it is made or claimed, renamed, at start, and
 *   after a turn of its that changed one; and a person's edit there is saved into its folder.
 * - Each of our agents in Chips is one OpenClaw session, and no two share one. A session key is
 *   made from the OpenClaw agent and a room's id, so the bridge keeps no map of its own. A room
 *   asked from the + is claimed under its made agent's session there, and Chips puts that key's
 *   own agent in it: the session is the agent's wherever it is moved, so it keeps its
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
 * - What an agent schedules with OpenClaw's automations is said, when it fires, in the room whose
 *   turn made it, as that room's agent, with an @ for the person who asked (Chips ADR 0157,
 *   `automations.ts`): a job's run as a turn OpenClaw started on its own, its answer with the @, and
 *   a `current` job's answer as OpenClaw commits it to the room's conversation when the bridge did
 *   not see its run.
 *
 * Every Chips id is derived from OpenClaw's, so everything written again after a restart is the
 * same event and Chips answers it as a duplicate.
 */

import { Refuse } from "@chipschat/harness";
import { type ChipsAgent, type ChipsEvent, ChipsRefusal, type NewAgent, type Placed, type Taken } from "./chips.ts";
import { chipsId } from "./ids.ts";
import { type Media, mediaLinesIn } from "./media.ts";
import type { ClawEvent } from "./openclaw.ts";
import { Contexts, type EditFrame } from "./context.ts";
import type { ChangeFrame, Models, Whose as ModelOwner } from "./models.ts";
import { type ChangeFrame as BeatChange, checkInOf, type Heartbeats } from "./heartbeats.ts";
import type { CompactFrame, LimitFrame, Session, Windows } from "./windows.ts";
import { isMadeAgent, madeAgentId, type Workspaces } from "./own-agents.ts";
import { filesLine, namedIn, ROOM_FILES, type RoomFile, roomFilesIn, STALE_FILE, staleIn } from "./room-files.ts";
import { Automations, committedOf, forPerson, jobOf, jobOfSession, type Person, SPEAKING_LATER } from "./automations.ts";

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
  /** A room of this harness's own by its key: opened, or found again. Its id. */
  openSpace(key: string): Promise<string>;
  attach(agentId: string, spaceId: string, replacing: string): Promise<boolean>;
  roomContext(spaceId: string, before: number, limit: number): Promise<unknown>;
  /** An agent deleted: nothing more is remembered of the copies sent for it. */
  forget(agentId: string): void;
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
  /** `timeoutMs`: for a method that takes longer than the client waits by default, a compaction's. */
  request<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown>,
    options?: { readonly timeoutMs?: number },
  ): Promise<T>;
}

/** The files an OpenClaw turn names with `MEDIA:` lines, read where the gateway keeps them (`media.ts`). */
export interface FilesPort {
  /** A relative path starts in `workspace`, the turn's agent's, when it has one of its own. */
  read(reference: string, workspace?: string): Promise<Media>;
}

const NO_FILES: FilesPort = {
  read: async (reference) => ({ kind: "refused", name: reference, why: "the bridge reads no files" }),
};

/** Folders named as the gateway's would be, and none written: for a bridge that is not the Mac's. */
const NO_WORKSPACES: Workspaces = {
  of: (agent) => `/home/node/.openclaw/chips/${agent}`,
  seed: async () => undefined,
  settle: async () => undefined,
  clear: async () => undefined,
};

/** As many files as one Chips post takes. */
const MAX_FILES = 20;

/** How often, at most, a turn says what it has cost so far while it works (LJ-6). */
const COST_EVERY_MS = 15_000;

/**
 * How long a made OpenClaw agent may take to be one the gateway knows, and how often the bridge
 * asks. `agents.create` answers once the config is written, and the gateway takes it in a moment
 * later: a session asked of it 5 ms after was refused, "Unknown agent id" (7 October 2026).
 */
const AGENT_KNOWN_WAIT_MS = 20_000;
const AGENT_KNOWN_EVERY_MS = 200;

/**
 * A turn that began while the gateway took in a config change (an agent made, renamed or deleted)
 * is refused before it does anything (the scratch run, 7 October 2026: a made agent's first turn,
 * sent as its rename was applied). It is sent again once, this long after, as the same run.
 */
const CONFIG_REPLACED = /PreparedModelCatalogConfigReplacedError|model catalog owner config was replaced/;
const AGAIN_AFTER_MS = 1_000;

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
  /** The automation this turn is a run of (`automations.ts`), whose answer is for the person who asked for it. */
  readonly job: string | undefined;
  /** Writes for one run go in order. */
  chain: Promise<void>;
  ended: boolean;
  /** What the turn's answer named to send (`MEDIA:` lines), as its `assistant` stream reported them. */
  readonly media: string[];
  /** The files its answer uploaded, by upload id: each one's name. */
  readonly uploaded: Map<string, string>;
  /**
   * Where each of its tools runs, by tool call, from the tool's start until its result: a plugin's
   * ask names no folder, so its card says the one its tool started in (AQ-2).
   */
  readonly cwds: Map<string, string>;
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
  /**
   * When the turn last said its cost so far, from when it began, and what it said, how many times
   * (LJ-6): so a turn shorter than that says it once, at its end, as ever.
   */
  costAt: number;
  costUsd: number;
  costCount: number;
  /** From the turn's `lifecycle` model phase and its `usage` stream, reported when it ends. */
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  contextTokens?: number;
  contextWindow?: number;
  /**
   * OpenClaw compacted the session on its own during the turn (its `compaction` stream), from about
   * this many tokens: the turn's end reads what it came to, and Chips's line says so (ADR 0146).
   */
  compactedFrom?: number;
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

/**
 * What a command's card asks (Chips ADR 0142): the command itself when it reads in one line, where
 * it runs, and that a yes is for this command alone. A long or many-lined command, or one with a
 * backtick in it, is asked about as "this command", and the card's preview shows it in full.
 */
export function commandAsk(command: string | undefined, cwd: string | undefined): Payload {
  const readable = command !== undefined && command.length <= 120 && !/[`\n]/.test(command);
  return {
    question: readable ? `Run \`${command}\`?` : "Run this command?",
    ...(cwd === undefined ? {} : { effect: `It runs in ${cwd}.` }),
    lasts: "once",
  };
}

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
 * plain name would be another of our agents' session, whose it is: `own` for the OpenClaw agent's
 * own, `default` for the harness's default agent.
 */
const SESSION = /^agent:([^:]+):chips-([^:]+)(?::(own|default))?$/;

/** Whose a session is, where its name says (`SESSION`'s last part). */
type Whose = "own" | "default";

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

/** A room's people, each by the @ that reaches them, and the handles of everybody in it. */
interface RoomPeople {
  readonly people: readonly Person[];
  readonly handles: readonly string[];
}

/** Who is in a room, from Chips's note on a message (ADR 0092); nothing from a Chips that sends none. */
function peopleOf(event: ChipsEvent): RoomPeople | undefined {
  const members = (event["room"] as Payload | undefined)?.["members"];
  if (!Array.isArray(members)) return undefined;
  const people: Person[] = [];
  const handles: string[] = [];
  for (const each of members as Payload[]) {
    const id = str(each?.["participant_id"]);
    const handle = str(each?.["handle"]);
    if (id === undefined || handle === undefined || handle === "") continue;
    handles.push(handle);
    if (each["kind"] === "person") people.push({ id, handle });
  }
  return { people, handles };
}

/**
 * The person who said a message, by the @ Chips's note gives them, else by their name as Chips makes
 * a handle of it; nobody for an agent's words.
 */
function personOf(from: Payload, room: RoomPeople | undefined): Person | undefined {
  const id = str(from["participant_id"]);
  if (from["kind"] !== "person" || id === undefined) return undefined;
  const noted = room?.people.find((each) => each.id === id);
  if (noted !== undefined) return noted;
  const name = (str(from["display_name"]) ?? "").replace(/\s+/g, "");
  return name === "" ? undefined : { id, handle: `@${name}` };
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
  /** What each turn the bridge asked for was sent with, until it ends: to send it again once. */
  private readonly sends = new Map<string, Payload>();
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
  /**
   * The person whose words each session's turn last answered, for whom what it schedules then is
   * (ADR 0157); and each room's people and the handles of everybody in it, as Chips's note last said.
   */
  private readonly askers = new Map<string, Person>();
  private readonly people = new Map<string, RoomPeople>();
  /** The OpenClaw agent a room with no other gets: `OPENCLAW_AGENT`, else the gateway's default. */
  private primary: string;
  /** The key the Main agent is registered under in Chips, once it is seated (`seatMain`). */
  private seatedKey: string | undefined;

  constructor(
    private readonly chips: ChipsPort,
    private readonly claw: ClawPort,
    private readonly self: {
      readonly harnessId: string;
      readonly agent: string;
      /** The room the join opened, its own direct room, when it joined by a link or a code. */
      readonly home?: string | undefined;
    },
    private readonly log: (message: string) => void,
    private readonly files: FilesPort = NO_FILES,
    private readonly now: () => number = Date.now,
    private readonly workspaces: Workspaces = NO_WORKSPACES,
    /** Our agents' context in Chips (ADR 0134); none, and nothing is sent or edited. */
    private readonly contexts?: Contexts,
    /** Our agents' models in Chips (ADR 0140); none, and nothing is sent or changed. */
    private readonly models?: Models,
    /** The Main agent's heartbeat in Chips (ADR 0143); none, and nothing is sent, changed or posted. */
    private readonly heartbeats?: Heartbeats,
    /** Our agents' context windows in Chips (ADR 0146); none, and nothing is sent or compacted. */
    private readonly windows?: Windows,
    /** What our agents schedule, and who each job is for (ADR 0157); kept in memory alone by default. */
    private readonly automations: Automations = new Automations(),
  ) {
    this.primary = self.agent;
  }

  /** The session an agent has in a room: one per agent and room, named from both. */
  keyFor(spaceId: string, agent: string = this.primary): string {
    return `agent:${agent}:chips-${spaceId.toLowerCase()}`;
  }

  /**
   * The key a room asked of this harness from the + is claimed under, and so the session of the
   * agent Chips makes for it: the session in that room of the OpenClaw agent made for the claim,
   * which is nobody else's.
   */
  claimKeyFor(spaceId: string): string {
    return this.keyFor(spaceId, madeAgentId(spaceId));
  }

  /**
   * The key a new agent a person asked for in a room is registered under (Chips ADR 0108), and so
   * its session, wherever Chips moves it, as a + room's claim is: the session in that room of the
   * OpenClaw agent made for the ask.
   */
  madeKeyFor(spaceId: string, askId: string): string {
    return this.keyFor(spaceId, madeAgentId(askId));
  }

  /**
   * The key the Main agent is registered under and its Main room opened by (Chips ADR 0087), named
   * as a session of the primary agent's in a room called `main`, which no Chips room is. Its turns
   * are in Home (`homeKey`), not in a session of that name: the key stays, as Chips keeps it. One
   * that joined since Chips ADR 0183 has its default agent as its Main instead, keyed by the
   * harness's own id (`mainAgentKey`).
   */
  mainKey(): string {
    return `agent:${this.primary}:chips-main`;
  }

  /** The key the Main agent is registered under in Chips: the one it was seated by, else `mainKey`. */
  private mainAgentKey(): string {
    return this.seatedKey ?? this.mainKey();
  }

  /** Whether a key of ours in Chips is the Main agent's. */
  private isMain(key: string | undefined): boolean {
    return key !== undefined && key === this.mainAgentKey();
  }

  /**
   * The primary agent's own conversation, OpenClaw's Home (`agent:<id>:main`): every direct
   * message from any of OpenClaw's channels lands there, its web app opens on it, its heartbeat
   * wakes it and its background work reports to it. The Main agent speaks there, so the Main room
   * is that one conversation, and a turn OpenClaw starts there is said in the Main room.
   */
  homeKey(): string {
    return `agent:${this.primary}:main`;
  }

  /** The session one of ours speaks in, by its key: the key's own, and Home for the Main agent. */
  private sessionOfKey(key: string): string {
    return this.isMain(key) ? this.homeKey() : key;
  }

  /** Which of ours a session is: the one keyed by it, and the Main agent for Home. */
  private agentOfSession(sessionKey: string): string | undefined {
    return this.agentByKey.get(sessionKey === this.homeKey() ? this.mainAgentKey() : sessionKey);
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
    return SESSION.exec(sessionKey)?.[3] as Whose | undefined;
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
   * OpenClaw's agents as this harness's agents in Chips (ADR 0087). The primary agent — the
   * gateway's default, its system agent, or `only` — is the Main agent, in its Main room
   * (`seatMain`). Each other agent the gateway lists, unless `only` is set, is registered by its
   * OpenClaw id. Each is named as the gateway names it, or, with no name of its own, as the
   * harness is. Nobody is moved: an agent is in one room at a time, so putting each in the default
   * agent's rooms would have Chips refuse all but one. Each stays where Chips has it, read again
   * once all are registered. One the bridge made for one of ours is that agent's already, under
   * its session's key, and is not registered again.
   */
  async adoptAgents(listed: { defaultId?: string; agents?: readonly ClawAgent[] }, only?: string): Promise<void> {
    this.primary = only ?? listed.defaultId ?? this.primary;
    const listedAgents = listed.agents ?? [];
    const agents = listedAgents.filter(
      (each) => each.kind !== "system" && !isMadeAgent(each.id) && each.id !== this.primary && only === undefined,
    );
    const known = await this.chips.agents();
    const harnessName = known.find((each) => each.key === this.self.harnessId)?.name ?? "OpenClaw";
    const nameOf = (agent: ClawAgent): string => {
      const named = agent.identity?.name ?? agent.name;
      return named === undefined || named === agent.id || named.trim() === "" ? harnessName : named.trim();
    };
    await this.seatMain(known, nameOf(listedAgents.find((each) => each.id === this.primary) ?? { id: this.primary }));
    for (const agent of agents) {
      try {
        await this.chips.registerAgent({ key: agent.id, name: nameOf(agent) });
      } catch (error) {
        this.log(`chips refused agent ${agent.id}: ${String(error)}`);
      }
    }
    this.learn(await this.chips.agents());
  }

  /**
   * The primary agent as this harness's Main agent (Chips ADR 0087, rule 7), as Jacobian's J is,
   * in a room named the harness's home (ADR 0069), which nobody archives or deletes. A harness that
   * joined since Chips ADR 0183 has it as the default agent Chips made at the join, in the room the
   * join opened, so it is called what the harness is and has no second beside it. Otherwise it is
   * registered under `mainKey` as the lead, in a room opened by the same key, which Chips puts it
   * in. A Main agent Chips has already is kept, under whatever key, in its room; one with no room
   * is given its room again. Each step is the same asked twice, so a start does them all again.
   */
  private async seatMain(known: readonly ChipsAgent[], name: string): Promise<void> {
    try {
      const had = known.find((each) => each.lead);
      const made = known.find((each) => each.key === this.self.harnessId);
      const joined = this.self.home !== undefined && made?.room === this.self.home;
      const key = joined ? this.self.harnessId : this.mainKey();
      const main = had ?? (await this.chips.registerAgent({ key, name, lead: true }));
      this.seatedKey = main.key;
      const room = main.room ?? main.spaces[0] ?? (await this.chips.openSpace(main.key));
      await this.chips.send({
        type: "space.updated",
        space_id: room,
        home: true,
        actor: { kind: "agent", id: main.agent_id },
        idempotency_key: `home-${room}`,
      });
      if (had === undefined) this.log(`chips: ${main.name} is this harness's Main agent, in ${room}`);
    } catch (error) {
      this.log(`chips: no Main agent in its Main room: ${String(error)}`);
    }
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
   * A person asked Chips for a new agent of this harness's in a room (Chips ADR 0108): an OpenClaw
   * agent made for it, and one more Chips agent keyed by that agent's session (`madeKeyFor`),
   * called what the ask says, and registered `made_for` the ask with the room, which Chips puts it
   * in while the room waits. Only Chips's people who may ask can, so the bridge asks nothing more
   * of who it was; an ask of another harness, or one a replay hands over after the minute, makes
   * nothing. The same ask heard again makes the same agent and registers the same key, which Chips
   * answers as done. One Chips refuses is unmade in OpenClaw too; one OpenClaw cannot make is not
   * asked of Chips, and the room says so when its minute is up.
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
    const clawAgent = madeAgentId(askId);
    if (!(await this.makeClawAgent(clawAgent))) return;
    const key = this.madeKeyFor(room, askId);
    try {
      const made = await this.chips.registerAgent({ key, name, made_for: askId, space_id: room });
      this.learn([made]);
      await this.nameClawAgent(clawAgent, made.name);
      void this.contexts?.agent(made.agent_id, clawAgent);
      void this.models?.agent(made.agent_id, { clawAgent, changeable: true });
      const placed = made.attached === false && made.why !== undefined ? `, not in it: ${made.why}` : "";
      this.log(`chips: made ${made.name} for ${room}${placed}`);
    } catch (error) {
      this.log(`chips refused the new agent ${name}: ${String(error)}`);
      await this.removeClawAgent(clawAgent);
    }
  }

  // ------------------------------------------------------------------ OpenClaw agents of our own

  /**
   * An OpenClaw agent of its own for one of ours (`own-agents.ts`): its folder begun with the
   * primary agent's persona, then made with `agents.create`, which takes effect with no restart,
   * and its first-run ritual taken out; ready once the gateway lists it. Made again, by a replay
   * or a restart between the make and the claim, it is there already. False when it could not be
   * made: no agent, in OpenClaw or in Chips.
   */
  private async makeClawAgent(agent: string): Promise<boolean> {
    let made = false;
    try {
      await this.workspaces.seed(agent);
      await this.claw.request("agents.create", { name: agent, workspace: this.workspaces.of(agent) });
      await this.workspaces.settle(agent);
      made = true;
    } catch (error) {
      if (!(await this.listsAgent(agent))) {
        this.log(`openclaw: could not make agent ${agent}: ${String(error)}`);
        return false;
      }
    }
    for (let waited = 0; waited < AGENT_KNOWN_WAIT_MS; waited += AGENT_KNOWN_EVERY_MS) {
      if (await this.listsAgent(agent)) {
        if (made) this.log(`openclaw: made agent ${agent}`);
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, AGENT_KNOWN_EVERY_MS));
    }
    this.log(`openclaw: agent ${agent} was made but the gateway never listed it`);
    return false;
  }

  /**
   * Whether the gateway lists an agent, by that name when one is given, as it does once it has
   * taken in the config that made or named it.
   */
  private async listsAgent(agent: string, name?: string): Promise<boolean> {
    try {
      const listed = await this.claw.request<{ agents?: ClawAgent[] }>("agents.list", {});
      return listed.agents?.some((each) => each.id === agent && (name === undefined || each.name === name)) === true;
    } catch {
      return false;
    }
  }

  /**
   * An OpenClaw agent of ours called what its agent in Chips is: what it is told it is
   * (`IDENTITY.md`). A config change, so the bridge waits for the gateway to list the name before
   * it sends the agent a turn.
   */
  private async nameClawAgent(agent: string, name: string): Promise<void> {
    try {
      await this.claw.request("agents.update", { agentId: agent, name });
    } catch (error) {
      this.log(`openclaw: could not name agent ${agent} ${name}: ${String(error)}`);
      return;
    }
    for (let waited = 0; waited < AGENT_KNOWN_WAIT_MS; waited += AGENT_KNOWN_EVERY_MS) {
      if (await this.listsAgent(agent, name)) return;
      await new Promise((resolve) => setTimeout(resolve, AGENT_KNOWN_EVERY_MS));
    }
    this.log(`openclaw: agent ${agent} was named ${name} but the gateway never listed the name`);
  }

  /**
   * An OpenClaw agent of ours deleted, folder, memory and conversations, as deleting one of
   * Jacobian's agents deletes its Space (Chips ADR 0095). OpenClaw moves the files to its trash,
   * which is inside its container, about a megabyte an agent; the empty folders it leaves go.
   */
  private async removeClawAgent(agent: string): Promise<void> {
    try {
      await this.claw.request("agents.delete", { agentId: agent, deleteFiles: true });
      await this.workspaces.clear(agent);
      this.log(`openclaw: deleted agent ${agent}`);
    } catch (error) {
      this.log(`openclaw: could not delete agent ${agent}: ${String(error)}`);
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
   * and is told no. An OpenClaw agent the bridge made for it goes with it. A session of an agent
   * the bridge did not make stays: OpenClaw keeps its own copy of what was said.
   */
  private async deleted(event: ChipsEvent): Promise<void> {
    const agentId = str(event["agent_id"]);
    const key = agentId === undefined ? undefined : this.keyOf.get(agentId);
    if (agentId === undefined || key === undefined) return;
    this.keyOf.delete(agentId);
    if (this.agentByKey.get(key) === agentId) this.agentByKey.delete(key);
    this.roomOf.delete(agentId);
    this.caughtUp.delete(agentId);
    this.lastHeard.delete(agentId);
    this.log(`chips: ${key} was deleted`);
    this.chips.forget(agentId);
    this.windows?.forget(agentId);
    const clawAgent = this.agentFor(key);
    if (clawAgent !== undefined && isMadeAgent(clawAgent)) await this.removeClawAgent(clawAgent);
  }

  /**
   * One of ours renamed in Chips (ADR 0091): an OpenClaw agent the bridge made for it is renamed
   * too, which rewrites its `IDENTITY.md`, so its context is sent again.
   */
  private async updated(event: ChipsEvent): Promise<void> {
    const agentId = str(event["agent_id"]);
    const name = str(event["name"]);
    const clawAgent = agentId === undefined ? undefined : this.madeClawAgentOf(agentId);
    if (agentId === undefined || name === undefined || clawAgent === undefined) return;
    await this.nameClawAgent(clawAgent, name);
    void this.contexts?.agent(agentId, clawAgent);
  }

  /**
   * The OpenClaw agent whose files one of ours is built from, as its page in Chips shows them
   * (ADR 0134): the one the bridge made for it, or the primary agent for the Main agent.
   */
  private filesClawAgentOf(agentId: string): string | undefined {
    return this.isMain(this.keyOf.get(agentId)) ? this.primary : this.madeClawAgentOf(agentId);
  }

  /** The OpenClaw agent the bridge made for one of our agents in Chips, if it made one. */
  private madeClawAgentOf(agentId: string): string | undefined {
    const key = this.keyOf.get(agentId);
    const clawAgent = key === undefined ? undefined : this.agentFor(key);
    return clawAgent !== undefined && isMadeAgent(clawAgent) ? clawAgent : undefined;
  }

  /**
   * The OpenClaw agent whose model one of ours runs on (ADR 0140), and whether Chips may change it:
   * the one made for it, which it may; the primary agent for the Main agent and for the harness
   * itself, which it may too, as it sets the Main agent's heartbeat (ADR 0143); otherwise the agent
   * its key names, a session's or one the bridge found in OpenClaw, which is OpenClaw's.
   */
  private modelOwnerOf(agentId: string): ModelOwner | undefined {
    const key = this.keyOf.get(agentId);
    if (key === undefined) return undefined;
    const made = this.madeClawAgentOf(agentId);
    if (made !== undefined) return { clawAgent: made, changeable: true };
    if (this.isMain(key) || key === this.self.harnessId) return { clawAgent: this.primary, changeable: true };
    return { clawAgent: this.agentFor(key) ?? key, changeable: false };
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
    // The Main agent speaks in Home, whichever key it was seated by (Chips ADR 0183).
    if (this.isMain(key)) return { agentId, clawAgent: this.primary, sessionKey: this.homeKey() };
    const clawAgent = key === undefined ? undefined : this.agentFor(key);
    if (key !== undefined && clawAgent !== undefined) return { agentId, clawAgent, sessionKey: this.sessionOfKey(key) };
    if (agentId === undefined && this.asked.has(room)) {
      const claimKey = this.claimKeyFor(room);
      return { agentId, clawAgent: this.agentFor(claimKey) ?? this.primary, sessionKey: claimKey };
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
    const agents = await this.chips.agents();
    this.learn(agents);
    const agentId = this.agentByKey.get(key);
    // The OpenClaw agent made for the claim is called what Chips called the agent it made.
    const name = agents.find((each) => each.key === key)?.name;
    const clawAgent = this.agentFor(key);
    if (name !== undefined && clawAgent !== undefined && isMadeAgent(clawAgent)) await this.nameClawAgent(clawAgent, name);
    if (agentId !== undefined && clawAgent !== undefined && isMadeAgent(clawAgent)) {
      void this.contexts?.agent(agentId, clawAgent);
      void this.models?.agent(agentId, { clawAgent, changeable: true });
    }
    return agentId !== undefined && this.roomOf.get(agentId) === spaceId ? agentId : undefined;
  }

  /**
   * The taker that claims a room asked from the +: the OpenClaw agent made for the claim, made
   * now. One that could not be made claims nothing and takes no turn; the room stays asked, for
   * the next words to try again, and says nobody answered when its minute is up.
   */
  private async claimer(spaceId: string, taker: Taker): Promise<Taker | undefined> {
    if (isMadeAgent(taker.clawAgent) && (await this.makeClawAgent(taker.clawAgent))) return taker;
    this.asked.add(spaceId);
    return undefined;
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

  /**
   * Our agents' context, and the harness's own, sent to Chips at start (ADR 0134): each agent the
   * bridge made, as its folder is now, and the Main agent, as the primary agent's is. A copy that has not moved since is sent again once, at
   * start, since the bridge keeps no record of what it sent before.
   */
  async sendContexts(): Promise<void> {
    if (this.contexts === undefined) return;
    const sends = [this.contexts.harness(this.primary)];
    for (const agentId of this.keyOf.keys()) {
      const clawAgent = this.filesClawAgentOf(agentId);
      if (clawAgent !== undefined) sends.push(this.contexts.agent(agentId, clawAgent));
    }
    await Promise.all(sends);
  }

  /**
   * A person's edit of a context file from Chips (ADR 0134): one of an agent's the bridge made, in
   * its folder, or of the harness's own set or the Main agent's, in the primary agent's; answered
   * by the copy as it is now. One for any other agent was sent no copy, so it goes unanswered, and
   * Chips tells the person it was missed.
   */
  async onContextEdit(frame: Payload): Promise<Payload> {
    if (this.contexts === undefined) throw new Refuse("This bridge keeps no context files.");
    const edit = frame as unknown as EditFrame;
    if (edit.agent_id === undefined) return this.contexts.edit(edit, this.primary);
    if (!this.keyOf.has(edit.agent_id)) this.learn(await this.chips.agents());
    const clawAgent = this.filesClawAgentOf(edit.agent_id);
    if (clawAgent === undefined) {
      this.log(`chips: an edit of ${edit.name} for ${edit.agent_id}, which has no OpenClaw agent of its own`);
      throw new Refuse(`${edit.agent_id} has no OpenClaw agent of its own.`);
    }
    return this.contexts.edit(edit, clawAgent);
  }

  /**
   * Each of our agents' model, sent to Chips at start (ADR 0140): every agent OpenClaw lists that
   * one of ours runs as, read only unless the bridge made it or it is the primary agent. Each is
   * sent once at start, since the bridge keeps no record of what it sent before.
   */
  async sendModels(): Promise<void> {
    if (this.models === undefined) return;
    const sends: Promise<void>[] = [];
    for (const agentId of this.keyOf.keys()) {
      const whose = this.modelOwnerOf(agentId);
      if (whose !== undefined) sends.push(this.models.agent(agentId, whose));
    }
    await Promise.all(sends);
  }

  /**
   * A person's change of an agent's model or effort from Chips (ADR 0140): written into the OpenClaw
   * agent the bridge made for it, or the primary agent for the Main agent, and refused for any other
   * with OpenClaw's own words for why. One for an agent the bridge doesn't know was sent no copy,
   * so it goes unanswered, and Chips tells the person it was missed.
   */
  async onModelChange(frame: Payload): Promise<Payload> {
    if (this.models === undefined) throw new Refuse("This bridge keeps no models.");
    const change = frame as unknown as ChangeFrame;
    if (!this.keyOf.has(change.agent_id)) this.learn(await this.chips.agents());
    const whose = this.modelOwnerOf(change.agent_id);
    if (whose === undefined) {
      this.log(`chips: a model change for ${change.agent_id}, which is none of this bridge's agents`);
      throw new Refuse(`${change.agent_id} is none of this bridge's agents.`);
    }
    return this.models.change(change, whose);
  }

  /**
   * The Main agent, the one of ours whose heartbeat Chips shows (ADR 0143): it beats in Home, so what
   * it says reaches the Main room. Agents in other rooms beat in a Home of their own, which no room
   * shows, so they are sent no copy.
   */
  private beatingAgent(): string | undefined {
    return this.agentByKey.get(this.mainAgentKey());
  }

  /** The Main agent's heartbeat, sent to Chips at start (ADR 0143). */
  async sendHeartbeats(): Promise<void> {
    const main = this.beatingAgent();
    if (this.heartbeats === undefined || main === undefined) return;
    await this.heartbeats.agent(main, this.primary);
  }

  /**
   * A person's change of an agent's heartbeat from Chips (ADR 0143): written into the primary
   * agent's block for the Main agent. One for any other agent, which was sent no copy, goes
   * unanswered, and Chips tells the person it was missed.
   */
  async onHeartbeatChange(frame: Payload): Promise<Payload> {
    if (this.heartbeats === undefined) throw new Refuse("This bridge keeps no heartbeats.");
    const change = frame as unknown as BeatChange;
    if (!this.keyOf.has(change.agent_id)) this.learn(await this.chips.agents());
    if (change.agent_id !== this.beatingAgent()) {
      this.log(`chips: a heartbeat change for ${change.agent_id}, which is not the Main agent`);
      throw new Refuse(`${change.agent_id} is not the Main agent.`);
    }
    return this.heartbeats.change(change, this.primary);
  }

  /**
   * The OpenClaw session one of ours speaks in, whose context window Chips shows (ADR 0146): its own
   * wherever Chips moves it, Home for the Main agent, and for an agent keyed by an OpenClaw agent,
   * its session in the room it is in. Nothing for one of those in no room, or for none of ours.
   */
  private windowSessionOf(agentId: string): Session | undefined {
    const key = this.keyOf.get(agentId);
    if (key === undefined) return undefined;
    const clawAgent = this.agentFor(key);
    if (clawAgent !== undefined) return { key: this.sessionOfKey(key), clawAgent };
    if (this.isMain(key)) return { key: this.homeKey(), clawAgent: this.primary };
    const room = this.roomOf.get(agentId);
    if (room === undefined || room === null) return undefined;
    const taker = this.takerFor(agentId, room);
    return { key: taker.sessionKey, clawAgent: taker.clawAgent };
  }

  /** Whether one of the bridge's own turns runs in a session now. */
  private turnIn(sessionKey: string): boolean {
    for (const run of this.runs.values()) if (!run.ended && run.sessionKey === sessionKey) return true;
    return false;
  }

  /** Each of our agents' context window, sent to Chips at start (ADR 0146): every one with a session. */
  async sendWindows(): Promise<void> {
    if (this.windows === undefined) return;
    const sends: Promise<void>[] = [];
    for (const agentId of this.keyOf.keys()) {
      const session = this.windowSessionOf(agentId);
      if (session !== undefined) sends.push(this.windows.agent(agentId, session));
    }
    await Promise.all(sends);
  }

  /**
   * The session a Compact now or a limit from Chips is for: one of ours, learnt again if need be. One
   * for an agent with no session of ours was sent no copy, so it goes unanswered, and Chips tells
   * the person it was missed.
   */
  private async windowFor(agentId: string, what: string): Promise<Session> {
    if (!this.keyOf.has(agentId)) this.learn(await this.chips.agents());
    const session = this.windowSessionOf(agentId);
    if (session === undefined) {
      this.log(`chips: ${what} for ${agentId}, which has no OpenClaw session of ours now`);
      throw new Refuse(`${agentId} has no OpenClaw session of this bridge's now.`);
    }
    return session;
  }

  /**
   * A person's Compact now from Chips (ADR 0146): taken at once, and done in the agent's session
   * now, or when the bridge's turn there ends.
   */
  async onWindowCompact(frame: Payload): Promise<Payload> {
    if (this.windows === undefined) throw new Refuse("This bridge keeps no context windows.");
    const ask = frame as unknown as CompactFrame;
    const session = await this.windowFor(ask.agent_id, "a Compact now");
    return this.windows.compact(ask, session, this.turnIn(session.key));
  }

  /** A person's change of the limit an agent compacts itself at, from Chips (ADR 0146). */
  async onWindowChange(frame: Payload): Promise<Payload> {
    if (this.windows === undefined) throw new Refuse("This bridge keeps no context windows.");
    const change = frame as unknown as LimitFrame;
    const session = await this.windowFor(change.agent_id, "a context window limit");
    return this.windows.change(change, session);
  }

  /**
   * OpenClaw said a session changed (ADR 0146): one of ours is read again once the change settles,
   * unless one of the bridge's turns runs there, whose end reads it anyway; a compaction done in
   * OpenClaw itself is remembered.
   */
  private sessionChanged(p: Payload): void {
    const sessionKey = str(p["sessionKey"]) ?? str(p["key"]);
    if (this.windows === undefined || sessionKey === undefined || this.turnIn(sessionKey)) return;
    const agentId = this.agentOfSession(sessionKey);
    const session = agentId === undefined ? undefined : this.windowSessionOf(agentId);
    if (agentId === undefined || session?.key !== sessionKey) return;
    const compacted = p["reason"] === "compact" && p["compacted"] !== false;
    this.windows.changed(agentId, session, compacted);
  }

  /**
   * What the primary agent's heartbeat said for the person (ADR 0143): a `heartbeat_respond` call
   * that notifies, in a message of its Home, posted in the Main room as the Main agent and marked
   * as a check-in. A quiet check posts nothing, and one heard again posts nothing more.
   *
   * Notifying is telling the person, and an @ is what pushes their phone (Chips ADR 0158): words
   * that @ nobody in the room @ the Main room's person, by the handle Chips's note gave them. With
   * no handle known (no note heard yet, or more than one person there), the words go as they are.
   */
  private heartbeatSaid(p: Payload): void {
    if (this.heartbeats === undefined || str(p["sessionKey"]) !== this.homeKey()) return;
    const checkIn = checkInOf(p["message"]);
    if (checkIn === undefined) return;
    const where = this.whereSaid(this.homeKey());
    if (where?.spaceId === undefined || where.agentId === undefined) {
      this.log(`chips: a heartbeat check-in with no Main room to say it in: ${checkIn.text.slice(0, 80)}`);
      return;
    }
    void this.chips
      .send({
        type: "message.post",
        space_id: where.spaceId,
        text: this.forAsker(checkIn.text, where.spaceId, undefined),
        heartbeat: true,
        actor: { kind: "agent", id: where.agentId },
        idempotency_key: `openclaw-heartbeat:${checkIn.id}`,
      })
      .catch((error: unknown) => this.log(`chips: a heartbeat check-in not posted: ${String(error)}`));
  }

  /**
   * Words a job says, for the person it is for (ADR 0157): the one who asked for it, else the room's
   * only person; with their @ first unless the words @ somebody in the room already.
   */
  private forAsker(text: string, spaceId: string | undefined, asker: Person | undefined): string {
    const room = spaceId === undefined ? undefined : this.people.get(spaceId);
    const only = room?.people.length === 1 ? room.people[0] : undefined;
    return forPerson(text, asker ?? only, room?.handles ?? []);
  }

  /**
   * OpenClaw's word on an automation (its `cron` event, ADR 0157): a job made in a turn of one of our
   * sessions is that session's room's, and, new, for the person whose words the turn answered, or,
   * made in another job's run, for whom that job was. A job removed is forgotten.
   */
  private automation(p: Payload): void {
    const jobId = str(p["jobId"]);
    if (p["action"] === "removed") {
      if (jobId !== undefined) this.automations.forget(jobId);
      return;
    }
    const job = jobOf(p["job"]);
    if (job === undefined || this.whereSaid(job.sessionKey) === undefined) return;
    const known = this.automations.job(job.id) !== undefined;
    const asker = this.askers.get(job.sessionKey) ?? this.automations.askerOf(jobOfSession(job.sessionKey));
    this.automations.learn(job, p["action"] === "added" ? asker : undefined);
    if (!known) this.log(`openclaw: automation ${job.id} (${job.name ?? "unnamed"}) answers in ${this.whereSaid(job.sessionKey)?.spaceId ?? "no room"}`);
  }

  /**
   * What a `current` automation committed to the conversation it was made in (ADR 0157): posted in
   * that conversation's room as its agent, for the person the job is for. Not when its run's answer
   * was posted already, which is these words: on scratch (13 October 2026) the commit came half a
   * second after the run's `chat` final, then the job's `finished` and, a one-shot, `removed`. A
   * silent run commits nothing. OpenClaw's run id is `cron:<job>:<started at>`.
   */
  private committed(p: Payload): void {
    const sessionKey = str(p["sessionKey"]);
    const made = committedOf(p["message"]);
    if (sessionKey === undefined || made === undefined || this.automations.takeSaid(made.jobId)) return;
    const text = textOf(p["message"]).trim();
    const where = this.whereSaid(sessionKey);
    if (text === "" || isNoReply(text) || where === undefined) return;
    void this.chips
      .send({
        type: "message.post",
        ...(where.spaceId === undefined ? {} : { space_id: where.spaceId }),
        text: this.forAsker(text, where.spaceId, this.automations.askerOf(made.jobId)),
        ...(where.agentId === undefined ? {} : { actor: { kind: "agent", id: where.agentId } }),
        idempotency_key: `openclaw-automation:${made.jobId}:${made.runId.replace(`cron:${made.jobId}:`, "")}`,
      })
      .catch((error: unknown) => this.log(`chips: automation ${made.jobId}'s answer not posted: ${String(error)}`));
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
      // One of ours deleted by a person (Chips ADR 0095): forgotten here, and unmade in OpenClaw.
      case "agent.deleted":
        return this.deleted(event);
      case "agent.updated":
        return this.updated(event);
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
    // Who is here, and who asked: what a turn schedules is for them (ADR 0157).
    const room = peopleOf(event);
    if (room !== undefined) this.people.set(spaceId, room);
    const asker = personOf(from, room ?? this.people.get(spaceId));
    for (const each of takers) {
      // The harness itself claims the room it was asked for, as the OpenClaw agent made for it; one
      // of our agents a message there is for answers as itself, in its own session, and claims nothing.
      const claiming = each.agentId === undefined && this.asked.has(spaceId);
      if (claiming) this.asked.delete(spaceId);
      const taker = claiming ? await this.claimer(spaceId, each) : each;
      if (taker === undefined) continue;
      await this.ensureSession(taker.sessionKey, words, taker.clawAgent);
      if (asker !== undefined) this.askers.set(taker.sessionKey, asker);
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
      const send: Payload = {
        sessionKey: taker.sessionKey,
        // How a file reaches the room, and how to speak in it later (ADR 0157), with every turn.
        message: [...chips, note, files.line, SPEAKING_LATER, message].filter((part) => part !== undefined).join("\n\n"),
        idempotencyKey: turn,
        queueMode: "steer",
        ...(sent.length === 0 ? {} : { attachments: sent }),
      };
      this.sends.set(turn, send);
      await this.claw.request("chat.send", send);
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
  ): Promise<{ sent: Payload[]; line: string; took: () => void }> {
    const files = roomFilesIn(event["context"]);
    if (files.length === 0) return { sent: [], line: filesLine([], []), took: () => undefined };
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
      case "session.message":
        this.heartbeatSaid(p);
        return this.committed(p);
      // An automation added, started, finished or removed (ADR 0157).
      case "cron":
        return this.automation(p);
      case "sessions.changed":
        return this.sessionChanged(p);
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
    // An automation's run (ADR 0157), said where its job was made: its goal is the job's name.
    const jobId = asked === undefined ? jobOfSession(sessionKey) : undefined;
    const job = jobId === undefined ? undefined : this.automations.job(jobId);
    const run: Run = {
      chipsRun: chipsId("run", `openclaw-run:${clawRun}`),
      spaceId: where.spaceId,
      sessionKey,
      agentId: where.agentId,
      asked: asked !== undefined,
      job: jobId,
      chain: Promise.resolve(),
      ended: false,
      media: [],
      uploaded: new Map(),
      cwds: new Map(),
      startedAt: this.now(),
      costAt: this.now(),
      costUsd: 0,
      costCount: 0,
    };
    this.runs.set(clawRun, run);
    this.runByChips.set(run.chipsRun, run);
    this.asks.delete(clawRun);
    const latest = this.latest.get(sessionKey);
    const goal =
      asked?.words ??
      (jobId !== undefined
        ? `Scheduled: ${job?.name ?? "an automation"}`
        : latest === undefined
          ? "Answer in the room."
          : `Following up: ${latest}`);
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
   * Chips holds its words until it joins one. Home is the Main agent's, in its Main room: what the
   * primary agent says there on its own (a heartbeat's alert, a background job's report, an answer
   * to words said to it in OpenClaw's web app) is said there. Any other session of ours is an OpenClaw agent's in
   * one room, named from both: its own agent's there, or the default agent's where its name says.
   *
   * An automation's run is said where the turn that made its job was (ADR 0157).
   */
  private whereSaid(sessionKey: string): { spaceId: string | undefined; agentId: string | undefined } | undefined {
    const jobId = jobOfSession(sessionKey);
    if (jobId !== undefined) {
      const job = this.automations.job(jobId);
      return job === undefined || jobOfSession(job.sessionKey) === jobId ? undefined : this.whereSaid(job.sessionKey);
    }
    const agentId = this.agentOfSession(sessionKey);
    if (agentId !== undefined) return { spaceId: this.roomOf.get(agentId) ?? undefined, agentId };
    const spaceId = this.spaceFor(sessionKey);
    if (spaceId === undefined) return undefined;
    const whose = this.whoseFor(sessionKey);
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
    const state = str(p["state"]);
    // A turn in none of our rooms (OpenClaw's own work, an automation made elsewhere) holds nothing past its end.
    if (run === undefined && (state === "final" || state === "error" || state === "aborted")) this.early.delete(clawRun);
    if (run === undefined || run.ended) return;
    if (state === "error" && this.againAfterReload(run, clawRun, p)) return;
    if (state === "final" || state === "error" || state === "aborted") this.sends.delete(clawRun);
    if (state === "final") return this.finish(run, clawRun, p);
    if (state === "error" || state === "aborted") {
      run.ended = true;
      const error = state === "aborted" ? "Stopped." : (str(p["errorMessage"]) ?? "OpenClaw's turn failed.");
      this.write(run, { type: "run.failed", run_id: run.chipsRun, error, idempotency_key: `openclaw-run:${clawRun}:failed` });
    }
  }

  /**
   * A turn the gateway refused as it began because its config was changing (`CONFIG_REPLACED`):
   * sent again once, a moment later, under another key, and the same run in Chips goes on with
   * it. False for any other failure, or a turn sent again already, which fails as ever.
   */
  private againAfterReload(run: Run, clawRun: string, p: Payload): boolean {
    const sent = this.sends.get(clawRun);
    if (sent === undefined || !CONFIG_REPLACED.test(str(p["errorMessage"]) ?? "")) return false;
    this.sends.delete(clawRun);
    const again = `${clawRun}:again`;
    this.runs.delete(clawRun);
    this.runs.set(again, run);
    this.log(`openclaw: ${clawRun} began as OpenClaw took in a config change; sent again as ${again}`);
    setTimeout(() => {
      this.claw.request("chat.send", { ...sent, idempotencyKey: again }).catch((error: unknown) => {
        run.ended = true;
        this.write(run, { type: "run.failed", run_id: run.chipsRun, error: String(error), idempotency_key: `openclaw-run:${again}:failed` });
      });
    }, AGAIN_AFTER_MS);
    return true;
  }

  private finish(run: Run, clawRun: string, p: Payload): void {
    run.ended = true;
    // A turn may have changed the files its agent is built from (its memory, its soul): the copy
    // in Chips is read again, and sent if it moved (Chips ADR 0134).
    const agentId = this.agentOfSession(run.sessionKey);
    const clawAgent = agentId === undefined ? undefined : this.filesClawAgentOf(agentId);
    if (agentId !== undefined && clawAgent !== undefined) void this.contexts?.agent(agentId, clawAgent);
    // Its model may have been changed in OpenClaw meanwhile: read again, and sent if it moved (ADR 0140).
    const owner = agentId === undefined ? undefined : this.modelOwnerOf(agentId);
    if (agentId !== undefined && owner !== undefined) void this.models?.agent(agentId, owner);
    // So may the Main agent's heartbeat, which a person may change in OpenClaw too (ADR 0143).
    if (agentId !== undefined && agentId === this.beatingAgent()) void this.heartbeats?.agent(agentId, this.primary);
    // How full its session is now, and whether it compacts itself or as a person asked (ADR 0146).
    const session = agentId === undefined ? undefined : this.windowSessionOf(agentId);
    const filled =
      agentId === undefined || session === undefined || this.windows === undefined
        ? undefined
        : this.windows.turnEnded(agentId, session, run.compactedFrom);
    // A turn that answered `NO_REPLY` passed (Chips ADR 0105): OpenClaw leaves the word out of its
    // chat, so the bridge says it, and Chips makes the post the turn's pass, which the room never
    // shows. Without it the run ended on "Answered together with other words, in one reply."
    const answer = mediaLinesIn(textOf(p["message"]));
    for (const reference of answer.named) if (!run.media.includes(reference)) run.media.push(reference);
    const said = answer.words;
    const passed = said === "" && run.media.length === 0 && isNoReply(run.said ?? "") ? NO_REPLY : said;
    // An automation's answer is for the person who asked for it (ADR 0157), and is these words when
    // OpenClaw commits them to the room's conversation after.
    const job = run.job;
    const forJob = job !== undefined && passed !== "" && !isNoReply(passed);
    if (forJob) this.automations.said(job);
    const text = forJob ? this.forAsker(passed, run.spaceId, this.automations.askerOf(job)) : passed;
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
    // How full the session is: from Codex's own counts where it ran the turn, else from OpenClaw's
    // session as the turn left it, for the room's context ring (Chips ADR 0146).
    this.write(run, async () => {
      const fill = await filled?.catch(() => undefined);
      const used = run.contextTokens ?? fill?.used;
      const limit = run.contextWindow ?? fill?.window;
      if (used === undefined || limit === undefined || limit <= 0) return undefined;
      return {
        type: "context.usage",
        run_id: run.chipsRun,
        used_tokens: used,
        limit_tokens: limit,
        model,
        ...(run.compactedFrom === undefined ? {} : { compacted: true }),
        idempotency_key: `openclaw-run:${clawRun}:context`,
      };
    });
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
    // The agent whose turn it was: an automation's run is in a session of its own (ADR 0157).
    const clawAgent = this.agentFor(run.sessionKey) ?? /^agent:([^:]+):/.exec(run.sessionKey)?.[1];
    const workspace = isMadeAgent(clawAgent) && clawAgent !== undefined ? this.workspaces.of(clawAgent) : undefined;
    for (const reference of run.media) {
      const media = await this.files.read(reference, workspace);
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
      // Held only while the event names no session. A turn in a session that is none of ours
      // (OpenClaw's own background work, a job made elsewhere) never becomes a run, and its events,
      // held, were never let go (ADR 0157).
      if (sessionKey === undefined) this.early.set(clawRun, [...(this.early.get(clawRun) ?? []), p]);
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
      case "compaction":
        // OpenClaw compacting the session on its own, near full (ADR 0146): from about what it held.
        if (data["phase"] === "start" && run.compactedFrom === undefined) {
          const agentId = this.agentOfSession(run.sessionKey);
          run.compactedFrom = run.contextTokens ?? (agentId === undefined ? undefined : this.windows?.usedOf(agentId)) ?? 0;
        }
        return;
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
    const cwd = str(((data["args"] ?? {}) as Payload)["cwd"]);
    if (phase === "start" && cwd !== undefined) run.cwds.set(stepId, cwd);
    if (phase !== "start") run.cwds.delete(stepId);
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
    const clawRun = str(p["runId"]);
    if (phase !== "start" && clawRun !== undefined) this.costSoFar(run, clawRun);
  }

  /**
   * What the turn has cost so far, every so often while it works (LJ-6): read from OpenClaw's
   * history of the session, which prices each model call as it returns, at a tool's end, at most
   * every 15 s from the turn's start, and said only when it grew. Chips weighs the room's job after
   * each `usage` (its ADR 0118), so it warns at 80% and holds the agents at the ceiling while the
   * turn works. Until 5 October 2026 a turn said its cost once, at its end, and one of O3's checks
   * took a $0.50 room's job from $0.27 to $0.95 in one report (long jobs C). Each report is the
   * run's total so far, under a key of its own; the end's is still the total.
   */
  private costSoFar(run: Run, clawRun: string): void {
    const at = this.now();
    if (run.spaceId === undefined || at - run.costAt < COST_EVERY_MS) return;
    run.costAt = at;
    this.write(run, async () => {
      const spent = await this.spentBy(run);
      if (spent === undefined || spent.usd <= run.costUsd) return undefined;
      run.costUsd = spent.usd;
      run.costCount += 1;
      const usage = withSpend(undefined, spent, run.model ?? "openai");
      return usage === undefined
        ? undefined
        : { type: "usage", run_id: run.chipsRun, ...usage, idempotency_key: `openclaw-run:${clawRun}:usage-so-far-${run.costCount}` };
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
    const given = str(plan["commandText"]) ?? str(request["command"]);
    const command = given ?? "a command";
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
      // Where it runs is the effect's to say, so the preview is the command alone.
      ...commandAsk(given, cwd),
      preview: { format: "markdown", title: "Run a command", body: `\`\`\`sh\n${command}\n\`\`\`` },
      // A command in the sandboxed container fits none of Chips's closed risk classes.
      risk: [],
      expires_in: expires === undefined ? 900 : Math.max(30, Math.round((expires - Date.now()) / 1000)),
      fallback: "deny",
      idempotency_key: `openclaw-approval:${clawId}`,
    });
  }

  /**
   * A plugin's ask. Codex's own shell asks this way ("Codex app-server command approval") when the
   * model runs a command natively rather than through OpenClaw's exec tool, and with
   * `approvalPolicy: on-request` every command does (10 October 2026); the command is on the
   * description's `Command:` line. The ask names no folder, so where it runs is where the tool
   * call it shares an id with started (AQ-2): the card said so through exec approvals, which carry it.
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
    const toolCallId = str(request["toolCallId"]);
    const cwd = command === undefined || toolCallId === undefined ? undefined : run.cwds.get(toolCallId);
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
          : { kind: "shell.exec", input: { command, ...(cwd === undefined ? {} : { cwd }) } },
      // A plugin's own title is a question only when it reads as one; otherwise the card is
      // headed by it as the preview's title, which is what it is.
      ...(command !== undefined
        ? commandAsk(command, cwd)
        : title.trim().endsWith("?")
          ? { question: title.trim().slice(0, 200), lasts: "once" }
          : { lasts: "once" }),
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
    await this.contexts?.settled();
    await this.models?.settled();
    await this.heartbeats?.settled();
    await this.windows?.settled();
  }
}

/** A step's line for the receipt: what OpenClaw says the call is for, cut to one short line. */
function summaryOf(data: Payload): string | undefined {
  const line = str(data["meta"]) ?? str(data["title"]);
  if (line === undefined || line.trim() === "") return undefined;
  const one = line.trim().split("\n")[0] ?? "";
  return one.length <= 200 ? one : `${one.slice(0, 199)}…`;
}
