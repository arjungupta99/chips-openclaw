/**
 * An agent's heartbeat in Chips (Chips ADR 0143): whether OpenClaw wakes the Main agent every so
 * often to look over what it is doing, and how often, sent to Chips as a copy so a person sees it on
 * the agent's page, and a person's change there written into the agent's entry in OpenClaw's config.
 *
 * OpenClaw keeps a heartbeat per agent (`agents.entries.<id>.heartbeat`), over its defaults
 * (`agents.defaults.heartbeat`). `every` is a duration (`30m`, `1h30m`, a bare number of minutes),
 * `0m` stops it and keeps the block. Once any entry has a block, only agents with one beat;
 * otherwise `defaults.heartbeat.agentId` names the one that does. A heartbeat delivers to a chat
 * channel by default and is skipped when there is none ("no-route"), which is this install: with
 * `target: "none"` it runs, and what it says stays in the agent's Home for the bridge to read. So
 * the heartbeat is on, for Chips, when the agent is enrolled, beats at more than zero, and keeps
 * what it says (`target: "none"`).
 *
 * A change is one `config.patch` of the agent's block with the hash of the config it was read from:
 * hot, no restart (`agents.entries` reloads in place). Never `isolatedSession`, which would beat in a
 * conversation of its own rather than Home.
 *
 * A check-in is what a check had to say to the person. OpenClaw sends no `chat` events for a
 * heartbeat's turn, and hides its messages from `session.message`; what it sends is a `heartbeat`
 * event as each check ends. One with words for the person and no channel to take them (`skipped`,
 * `target-none`) carries their first 200 characters (`preview`); longer, the bridge reads them whole
 * from Home, where they stay: the model's reply, or the `heartbeat_respond` call that notifies, by
 * the model's own runtime.
 */

import { Refuse } from "@chipschat/harness";
import type { ClawPort } from "./bridge.ts";

type Payload = Record<string, unknown>;

/** The intervals a person may pick, in minutes (Chips takes twelve at most, `HEARTBEAT_CHOICES_MAX`). */
export const CHOICES: readonly number[] = [15, 30, 60, 120, 240, 720, 1440];
const CHOICES_MAX = 12;
/** OpenClaw's own interval when nothing sets one. */
export const OPENCLAW_EVERY = 30;
/** The longest interval Chips takes: a week (`HEARTBEAT_EVERY_MAX`). */
const EVERY_MAX = 10_080;
/** How long a refusal's words may be in Chips. */
const MESSAGE_MAX = 300;
/** How long a check-in may be in Chips. */
const TEXT_MAX = 64_000;
/** How much of a check's words OpenClaw keeps on its `heartbeat` event. */
export const PREVIEW_MAX = 200;
/** What a check that told the person something says when no channel took its words. */
const UNDELIVERED = new Set(["target-none", "no-target", "no-route"]);
/** OpenClaw's word for "nothing to say", which it strips from a check's words. */
const QUIET_TOKEN = /^\s*HEARTBEAT_OK\b|\bHEARTBEAT_OK\s*$/g;

/** A heartbeat block as OpenClaw's config has it. */
export interface ClawHeartbeat {
  readonly every?: string | number;
  readonly target?: string;
  readonly agentId?: string;
}

/** OpenClaw's agents config, as far as heartbeats go. */
export interface ClawAgents {
  readonly defaults?: { readonly heartbeat?: ClawHeartbeat };
  readonly entries?: Readonly<Record<string, { readonly heartbeat?: ClawHeartbeat }>>;
}

/** What a copy says of a person's change: made, or not and why. */

/** The `heartbeat.change` frame Chips sends down the socket (Chips ADR 0143). */
export interface ChangeFrame {
  readonly change_id: string;
  readonly agent_id: string;
  readonly on: boolean;
  readonly every: number;
}

const UNIT_MINUTES: Readonly<Record<string, number>> = { ms: 1 / 60_000, s: 1 / 60, m: 1, h: 60, d: 1440 };

/**
 * A duration as OpenClaw writes one, in minutes: `30m`, `1h30m`, `45s`, `2d`, or a bare number of
 * minutes. Nothing for what it can't read.
 */
export function minutesOf(every: string | number | undefined): number | undefined {
  if (every === undefined) return undefined;
  if (typeof every === "number") return Number.isFinite(every) && every >= 0 ? every : undefined;
  const words = every.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(words)) return Number(words);
  let total = 0;
  let rest = words;
  for (;;) {
    const part = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)/.exec(rest);
    if (part === null) break;
    total += Number(part[1]) * (UNIT_MINUTES[part[2] as string] ?? 0);
    rest = rest.slice(part[0].length);
  }
  return rest === "" && words !== "" ? total : undefined;
}

/**
 * An agent's heartbeat as OpenClaw's config sets it: whether it beats and keeps what it says for
 * Chips, and how often, in whole minutes (nothing when it beats at zero).
 */
export function beatOf(agents: ClawAgents | undefined, clawAgent: string): { readonly on: boolean; readonly every: number | undefined } {
  const own = agents?.entries?.[clawAgent]?.heartbeat;
  const defaults = agents?.defaults?.heartbeat;
  const anyOwn = Object.values(agents?.entries ?? {}).some((entry) => entry.heartbeat !== undefined);
  const enrolled =
    own !== undefined || (!anyOwn && defaults !== undefined && (defaults.agentId === undefined || defaults.agentId === clawAgent));
  const minutes = minutesOf(own?.every ?? defaults?.every) ?? OPENCLAW_EVERY;
  const every = minutes >= 1 ? Math.min(EVERY_MAX, Math.round(minutes)) : undefined;
  const target = own?.target ?? defaults?.target;
  return { on: enrolled && every !== undefined && target === "none", every };
}

/** The intervals offered: Chips's choices, with the one it beats at among them, ascending. */
export function choicesWith(every: number): number[] {
  const all = [...new Set([...CHOICES, every])].sort((a, b) => a - b);
  if (all.length <= CHOICES_MAX) return all;
  return all.filter((each) => each === every || CHOICES.includes(each)).slice(0, CHOICES_MAX);
}

/**
 * One agent's copy, whole, as Chips takes it (`PUT /v1/agents/:id/heartbeat`): whether it is on,
 * how often it beats, and what a person may pick. Off at zero, it says the interval it beat at
 * before, as the bridge last saw it, else OpenClaw's own.
 */
export function copyOf(agents: ClawAgents | undefined, clawAgent: string, remembered?: number): Payload {
  const beat = beatOf(agents, clawAgent);
  const every = beat.every ?? remembered ?? OPENCLAW_EVERY;
  return { on: beat.on, every, choices: choicesWith(every), editable: true };
}

/**
 * The patch a change is: the agent's own block, beating at `every` or at zero, and keeping what it
 * says for Chips. Off keeps the block, since once any agent has one only those beat.
 */
export function patchOf(clawAgent: string, change: Pick<ChangeFrame, "on" | "every">): string {
  const every = change.on ? `${change.every}m` : "0m";
  return JSON.stringify({ agents: { entries: { [clawAgent]: { heartbeat: { every, target: "none" } } } } });
}

/** Whether a copy shows a change made. */
export function shows(body: Payload, change: Pick<ChangeFrame, "on" | "every">): boolean {
  return body["on"] === change.on && (!change.on || body["every"] === change.every);
}

/**
 * What a heartbeat's turn said for the person, from one of Home's messages: the words of a
 * `heartbeat_respond` call that notifies, as OpenClaw would deliver them
 * (`notificationText`, else its `summary`), and the call's id. Nothing for a quiet check, or for any
 * other message.
 */
export function checkInOf(message: unknown): { readonly id: string; readonly text: string } | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const { role, content } = message as Payload;
  if (role !== "assistant" || !Array.isArray(content)) return undefined;
  for (const part of content as Payload[]) {
    if (part?.["type"] !== "toolCall" || part["name"] !== "heartbeat_respond") continue;
    const args = (part["arguments"] ?? {}) as Payload;
    if (args["notify"] !== true) return undefined;
    const said = [args["notificationText"], args["notification_text"], args["summary"]].find(
      (each): each is string => typeof each === "string" && each.trim() !== "",
    );
    const id = typeof part["id"] === "string" ? part["id"] : undefined;
    if (said === undefined || id === undefined) return undefined;
    return { id, text: said.trim().slice(0, TEXT_MAX) };
  }
  return undefined;
}

/** One check of a heartbeat, as OpenClaw's `heartbeat` event says it ended. */
export interface Check {
  /** When it ended. */
  readonly at: number;
  /** Whether it told the person something. */
  readonly notify: boolean;
  /** Its words for the person, as far as the event keeps them, when no channel took them. */
  readonly words?: string;
}

/**
 * A check, from one `heartbeat` event: quiet when it answered nothing (`ok-token`, `ok-empty`), and
 * telling the person something when a channel took its words (`sent`) or there was none to
 * (`skipped` for want of a target, with the words). Nothing for a check that didn't run, failed, or
 * held back words it had said already (`duplicate`).
 */
export function checkOf(p: Payload): Check | undefined {
  const at = typeof p["ts"] === "number" ? p["ts"] : undefined;
  if (at === undefined) return undefined;
  const status = p["status"];
  if (status === "ok-token" || status === "ok-empty") return { at, notify: false };
  if (status === "sent") return { at, notify: true };
  const words = typeof p["preview"] === "string" ? p["preview"] : "";
  if (status !== "skipped" || !UNDELIVERED.has(String(p["reason"])) || words.trim() === "") return undefined;
  return { at, notify: true, words };
}

/** What an assistant message says in words: its text, or a `heartbeat_respond` call's that notifies. */
function wordsOf(message: Payload): string | undefined {
  const call = checkInOf(message);
  if (call !== undefined) return call.text;
  const { role, content } = message;
  if (role !== "assistant") return undefined;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = (content as Payload[])
    .filter((part) => part?.["type"] === "text" && typeof part["text"] === "string")
    .map((part) => part["text"] as string)
    .join("");
  return text === "" ? undefined : text;
}

const squash = (words: string): string => words.replace(/\s+/g, " ").trim();

/**
 * A check's words whole, from Home's latest messages (`chat.history`): the last of the model's that
 * begins as the event's cut of them does. Nothing when none does.
 */
export function wordsIn(messages: unknown, cut: string): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  const begins = squash(cut).slice(0, PREVIEW_MAX / 2);
  for (const message of [...(messages as Payload[])].reverse()) {
    if (typeof message !== "object" || message === null) continue;
    const words = wordsOf(message);
    if (words !== undefined && squash(words).includes(begins)) return words;
  }
  return undefined;
}

/** A check-in as Chips takes it: OpenClaw's quiet word stripped, cut to what Chips holds. */
export const checkInText = (words: string): string => words.replace(QUIET_TOKEN, "").trim().slice(0, TEXT_MAX);

/** OpenClaw refusing a write because the config moved since it was read: read it again and retry. */
const MOVED = /config changed since last load/;
const WRITE_TRIES = 3;
/** How long, and how often, a copy answering a change is read again until it shows the change. */
const APPLIED_TRIES = 10;
const APPLIED_EVERY_MS = 200;

/**
 * The copies Chips holds of our agents' heartbeats, kept current: each read from OpenClaw and handed
 * to the SDK, which sends it when it is not what Chips took last. One agent's reads and sends go one
 * after another, so a later copy never lands before an earlier one.
 */
export class Heartbeats {
  private readonly chains = new Map<string, Promise<void>>();
  /** The interval each agent beat at before it was turned off, as this bridge last saw or set it. */
  private readonly before = new Map<string, number>();

  constructor(
    private readonly claw: ClawPort,
    private readonly put: (agentId: string, copy: Payload) => Promise<unknown>,
    private readonly log: (message: string) => void,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
  ) {}

  /** An agent's copy as OpenClaw's config has it now. */
  async read(clawAgent: string): Promise<Payload> {
    const config = await this.claw.request<{ config?: { agents?: ClawAgents } }>("config.get", {});
    const agents = config.config?.agents;
    const every = beatOf(agents, clawAgent).every;
    if (every !== undefined) this.before.set(clawAgent, every);
    return copyOf(agents, clawAgent, this.before.get(clawAgent));
  }

  /** One of our agents' copy, read and sent. */
  agent(agentId: string, clawAgent: string): Promise<void> {
    return this.queue(agentId, async () => {
      await this.put(agentId, await this.read(clawAgent));
    });
  }

  /**
   * A person's change from Chips: written into the agent's block, and answered by the copy as it is
   * now, once it shows the change or after a few reads. A write OpenClaw refuses is refused with its
   * words; the copy beside it says what holds.
   */
  async change(frame: ChangeFrame, clawAgent: string): Promise<Payload> {
    try {
      await this.write(clawAgent, frame);
    } catch (error) {
      const message = String((error as Error)?.message ?? error).slice(0, MESSAGE_MAX);
      this.log(`openclaw: ${clawAgent}'s heartbeat not changed from Chips: ${message}`);
      throw new Refuse(message, await this.read(clawAgent).catch(() => undefined));
    }
    if (frame.on) this.before.set(clawAgent, frame.every);
    this.log(`openclaw: ${clawAgent}'s heartbeat ${frame.on ? `every ${frame.every} min` : "off"}, from Chips`);
    return this.inLine(frame.agent_id, async () => {
      let body = await this.read(clawAgent);
      for (let tries = 1; !shows(body, frame) && tries < APPLIED_TRIES; tries += 1) {
        await this.sleep(APPLIED_EVERY_MS);
        body = await this.read(clawAgent);
      }
      return body;
    });
  }

  /** Every read and send asked for so far, done; for the tests and for a clean stop. */
  async settled(): Promise<void> {
    await Promise.all(this.chains.values());
  }

  /** The agent's block patched from the config as it is now, read again if it moved meanwhile. */
  private async write(clawAgent: string, frame: ChangeFrame): Promise<void> {
    const raw = patchOf(clawAgent, frame);
    for (let attempt = 1; ; attempt += 1) {
      const { hash } = await this.claw.request<{ hash?: string }>("config.get", {});
      try {
        await this.claw.request("config.patch", { raw, ...(hash === undefined ? {} : { baseHash: hash }) });
        return;
      } catch (error) {
        if (attempt >= WRITE_TRIES || !MOVED.test(String((error as Error)?.message ?? error))) throw error;
      }
    }
  }

  private queue(id: string, work: () => Promise<void>): Promise<void> {
    return this.inLine(id, work).catch((error: unknown) => {
      this.log(`chips: ${id}'s heartbeat not sent: ${String(error)}`);
    });
  }

  /** Work for one agent, after what was asked for it before; its own result or failure. */
  private inLine<T>(id: string, work: () => Promise<T>): Promise<T> {
    const done = (this.chains.get(id) ?? Promise.resolve()).then(work);
    this.chains.set(
      id,
      done.then(
        () => undefined,
        () => undefined,
      ),
    );
    return done;
  }
}
