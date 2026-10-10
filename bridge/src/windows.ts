/**
 * An agent's context window in Chips (Chips ADR 0146): how full each of our agents' OpenClaw
 * session is, sent to Chips as a copy so a person sees it on the agent's page; a person's Compact
 * now, done with OpenClaw's own; and the limit the agent compacts itself at, which the bridge keeps.
 *
 * OpenClaw counts a session's tokens and knows its model's window (`sessions.describe`:
 * `totalTokens`, `contextTokens`), and compacts one on request (`sessions.compact`, synchronous,
 * refused while the session has a run going or work queued). It has no limit per agent: it compacts
 * a session on its own only near full (the window less a reserve, about 93% of 272K). So the limit
 * is the bridge's: after a turn that ends at or over it, the bridge compacts the session, and
 * OpenClaw's own stays underneath. "Only when asked" is OpenClaw's own alone, its default.
 *
 * The limits and each agent's last compaction are kept in the bridge's state, so a restart forgets
 * neither; OpenClaw keeps no record of either that the bridge can read back.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ClawPort } from "./bridge.ts";

type Payload = Record<string, unknown>;

/** The limits a person may pick, in percent of the window. */
export const LIMITS: readonly number[] = [50, 60, 70, 80, 90];
/** How long a compaction may take: OpenClaw gives its own three minutes (`timeoutSeconds`). */
export const COMPACT_TIMEOUT_MS = 200_000;
/** How long a Compact now waits behind OpenClaw's own work in a session, and how often it tries. */
export const BUSY_WAIT_MS = 5 * 60_000;
export const BUSY_EVERY_MS = 10_000;
/** How long the session waits after OpenClaw says it changed before it is read: changes come in bursts. */
export const SETTLE_MS = 3000;
/** OpenClaw refusing a compaction because the session is in use. */
const BUSY = /active run|queued work/i;
/** How long a refusal's words may be in Chips. */
const MESSAGE_MAX = 300;

/** One of our agents' OpenClaw session: its key, and the OpenClaw agent it belongs to. */
export interface Session {
  readonly key: string;
  readonly clawAgent: string;
}

/** How full a session is, as OpenClaw last said. */
export interface Fill {
  readonly used: number;
  readonly window: number;
  readonly model?: string | undefined;
  readonly asOf: string;
}

/** An agent's last compaction, as Chips takes it. */
export interface Last {
  readonly at: string;
  readonly from: number;
  readonly to: number;
  readonly by: "asked" | "itself";
}

/** The `context_window.compact` frame Chips sends down the socket (Chips ADR 0146). */
export interface CompactFrame {
  readonly change_id: string;
  readonly agent_id: string;
}

/** The `context_window.change` frame. */
export interface LimitFrame {
  readonly change_id: string;
  readonly agent_id: string;
  readonly at: number | null;
}

/** What a copy says of a person's ask: taken or made, or not and why. */
export type Answer =
  | { readonly answers: string }
  | { readonly refuses: { readonly change_id: string; readonly message?: string } };

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** A session row's fill: nothing when OpenClaw doesn't say both how much and of what. */
export function fillOf(row: Payload | undefined, now: number): Fill | undefined {
  const used = num(row?.["totalTokens"]);
  const window = num(row?.["contextTokens"]);
  if (used === undefined || window === undefined || window <= 0) return undefined;
  const updated = num(row?.["updatedAt"]);
  const model = typeof row?.["model"] === "string" ? (row["model"] as string) : undefined;
  return {
    used: Math.max(0, Math.round(used)),
    window: Math.round(window),
    ...(model === undefined ? {} : { model }),
    asOf: new Date(updated ?? now).toISOString(),
  };
}

/** Whether a session this full is at or over a limit. */
export function overLimit(fill: Fill, at: number | null | undefined): boolean {
  return at !== null && at !== undefined && (fill.used / fill.window) * 100 >= at;
}

const said = (error: unknown): string => String((error as Error)?.message ?? error).slice(0, MESSAGE_MAX);

/** What the bridge keeps across restarts. */
interface Kept {
  limits: Record<string, number | null>;
  lasts: Record<string, Last>;
}

/**
 * The copies Chips holds of our agents' context windows, kept current: each read from OpenClaw
 * and sent when it is not what was sent last, or when it answers an ask. One agent's reads and
 * sends go one after another, so a later copy never lands before an earlier one.
 */
export class Windows {
  private readonly sent = new Map<string, string>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly fills = new Map<string, Fill>();
  private readonly compacting = new Map<string, "queued" | "running">();
  /** A Compact now taken while one of the bridge's turns ran in the session: done when it ends. */
  private readonly waiting = new Map<string, Session>();
  private readonly settling = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Set<Promise<void>>();
  private readonly kept: Kept;

  constructor(
    private readonly claw: ClawPort,
    private readonly put: (agentId: string, body: Payload) => Promise<void>,
    private readonly log: (message: string) => void,
    /** Where the limits and last compactions are kept; none, and they last as long as the process. */
    private readonly stateFile?: string,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
  ) {
    this.kept = this.load();
  }

  /** The tokens an agent's session held when last read, for a compaction's "from". */
  usedOf(agentId: string): number | undefined {
    return this.fills.get(agentId)?.used;
  }

  /** An agent's copy as Chips takes it (`PUT /v1/agents/:id/context-window`), from what is known. */
  copyOf(agentId: string): Payload | undefined {
    const fill = this.fills.get(agentId);
    if (fill === undefined) return undefined;
    const doing = this.compacting.get(agentId);
    const last = this.kept.lasts[agentId];
    return {
      used: fill.used,
      window: fill.window,
      ...(fill.model === undefined ? {} : { model: fill.model }),
      as_of: fill.asOf,
      ...(doing === undefined ? {} : { compacting: doing }),
      ...(last === undefined ? {} : { last }),
      compacts: true,
      limit: { at: this.kept.limits[agentId] ?? null, choices: [...LIMITS], default: null, may_turn_off: true },
      editable: true,
    };
  }

  /** The session as OpenClaw has it now, remembered. Nothing for a session OpenClaw doesn't know yet. */
  async read(agentId: string, session: Session): Promise<Fill | undefined> {
    const answer = await this.claw.request<{ session?: Payload }>("sessions.describe", {
      key: session.key,
      agentId: session.clawAgent,
    });
    const fill = fillOf(answer.session, this.now());
    if (fill !== undefined) this.fills.set(agentId, fill);
    return fill ?? this.fills.get(agentId);
  }

  /** One of our agents' copy, read and sent if it moved since the last, or to answer an ask. */
  agent(agentId: string, session: Session, answer?: Answer): Promise<void> {
    return this.queue(agentId, async () => {
      await this.read(agentId, session).catch((error: unknown) => {
        this.log(`openclaw: ${session.key} not read for its context window: ${said(error)}`);
      });
      await this.send(agentId, answer);
    });
  }

  /**
   * One of the bridge's turns ended in the agent's session: its fill read and sent, and then, on
   * their own, a Compact now that waited for it, or the agent compacting itself past its limit.
   * `compactedFrom`: OpenClaw compacted the session on its own during the turn, from that many.
   */
  async turnEnded(agentId: string, session: Session, compactedFrom?: number): Promise<Fill | undefined> {
    let fill: Fill | undefined;
    await this.queue(agentId, async () => {
      fill = await this.read(agentId, session);
      if (compactedFrom !== undefined && fill !== undefined && compactedFrom > fill.used) {
        this.remember(agentId, { at: new Date(this.now()).toISOString(), from: compactedFrom, to: fill.used, by: "itself" });
      }
      await this.send(agentId);
    });
    this.track(this.afterTurn(agentId, session, fill));
    return fill;
  }

  /**
   * A person's Compact now from Chips. Taken at once and done now, or, while one of the bridge's
   * turns runs in the session, when the turn ends. OpenClaw's own work in the session (a heartbeat,
   * a channel's message) is waited out as it goes.
   */
  async compact(frame: CompactFrame, session: Session, busy: boolean): Promise<void> {
    const agentId = frame.agent_id;
    if (this.compacting.has(agentId)) {
      await this.agent(agentId, session, { refuses: { change_id: frame.change_id, message: "It is compacting already." } });
      return;
    }
    if (busy) {
      this.compacting.set(agentId, "queued");
      this.waiting.set(agentId, session);
      this.log(`openclaw: ${session.key} compacts when its turn ends, from Chips`);
      await this.agent(agentId, session, { answers: frame.change_id });
      return;
    }
    await this.run(agentId, session, "asked", frame.change_id);
  }

  /** A person's limit from Chips: kept, and answered by the copy that shows it. */
  async change(frame: LimitFrame, session: Session): Promise<void> {
    const agentId = frame.agent_id;
    if (frame.at !== null && !LIMITS.includes(frame.at)) {
      await this.agent(agentId, session, { refuses: { change_id: frame.change_id, message: "That limit isn't one OpenClaw's bridge offers." } });
      return;
    }
    this.kept.limits[agentId] = frame.at;
    this.save();
    this.log(`openclaw: ${session.key} compacts itself ${frame.at === null ? "only when asked" : `at ${frame.at}%`}, from Chips`);
    await this.agent(agentId, session, { answers: frame.change_id });
  }

  /**
   * OpenClaw said the session changed: read it once the burst is over, unless one of the bridge's
   * turns runs there, whose end reads it anyway. A compaction someone asked of OpenClaw itself (its
   * app, its command line) is remembered as one asked.
   */
  changed(agentId: string, session: Session, compacted: boolean): void {
    if (compacted && !this.compacting.has(agentId)) {
      const from = this.usedOf(agentId);
      this.queue(agentId, async () => {
        const fill = await this.read(agentId, session);
        if (from !== undefined && fill !== undefined && fill.used < from) {
          this.remember(agentId, { at: new Date(this.now()).toISOString(), from, to: fill.used, by: "asked" });
        }
        await this.send(agentId);
      });
      return;
    }
    clearTimeout(this.settling.get(agentId));
    const timer = setTimeout(() => {
      this.settling.delete(agentId);
      void this.agent(agentId, session);
    }, SETTLE_MS);
    timer.unref?.();
    this.settling.set(agentId, timer);
  }

  /** An agent deleted: nothing more is sent for it, and its limit and last compaction go. */
  forget(agentId: string): void {
    this.sent.delete(agentId);
    this.fills.delete(agentId);
    this.waiting.delete(agentId);
    clearTimeout(this.settling.get(agentId));
    if (agentId in this.kept.limits || agentId in this.kept.lasts) {
      delete this.kept.limits[agentId];
      delete this.kept.lasts[agentId];
      this.save();
    }
  }

  /** Every read, send and compaction asked for so far, done; for the tests and for a clean stop. */
  async settled(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
    await Promise.all(this.chains.values());
  }

  /** After a turn: the Compact now that waited for it, else the agent's own limit. */
  private async afterTurn(agentId: string, session: Session, fill: Fill | undefined): Promise<void> {
    const asked = this.waiting.get(agentId);
    if (asked !== undefined) {
      this.waiting.delete(agentId);
      await this.run(agentId, asked, "asked");
      return;
    }
    if (fill !== undefined && !this.compacting.has(agentId) && overLimit(fill, this.kept.limits[agentId])) {
      this.log(`openclaw: ${session.key} is past its limit, ${fill.used} of ${fill.window}: compacting`);
      await this.run(agentId, session, "itself");
    }
  }

  /**
   * Compact the session now: the copy says so first (answering the ask, when one is named), then
   * says what it came to, or refuses the ask with OpenClaw's words.
   */
  private async run(agentId: string, session: Session, by: Last["by"], changeId?: string): Promise<void> {
    this.compacting.set(agentId, "running");
    await this.agent(agentId, session, changeId === undefined ? undefined : { answers: changeId });
    const before = this.usedOf(agentId);
    try {
      const answer = await this.compactSession(session);
      this.compacting.delete(agentId);
      if (answer["compacted"] === false) {
        const reason = typeof answer["reason"] === "string" ? answer["reason"] : "OpenClaw found nothing to compact.";
        this.log(`openclaw: ${session.key} not compacted: ${reason}`);
        await this.agent(agentId, session, changeId === undefined ? undefined : { refuses: { change_id: changeId, message: reason.slice(0, MESSAGE_MAX) } });
        return;
      }
      const result = (answer["result"] ?? {}) as Payload;
      await this.queue(agentId, async () => {
        const fill = await this.read(agentId, session).catch(() => undefined);
        const from = num(result["tokensBefore"]) ?? before ?? fill?.used ?? 0;
        const to = num(result["tokensAfter"]) ?? fill?.used ?? 0;
        // OpenClaw counts a session's tokens at its next turn: until then, what the compaction left.
        const now = this.fills.get(agentId);
        if (now !== undefined) this.fills.set(agentId, { ...now, used: to, asOf: new Date(this.now()).toISOString() });
        this.remember(agentId, { at: new Date(this.now()).toISOString(), from, to, by });
        this.log(`openclaw: ${session.key} compacted (${by}), ${from} to ${to}`);
        await this.send(agentId);
      });
    } catch (error) {
      this.compacting.delete(agentId);
      this.log(`openclaw: ${session.key} not compacted: ${said(error)}`);
      await this.agent(agentId, session, changeId === undefined ? undefined : { refuses: { change_id: changeId, message: said(error) } });
    }
  }

  /** `sessions.compact`, given its time, and tried again while OpenClaw's own work holds the session. */
  private async compactSession(session: Session): Promise<Payload> {
    const until = this.now() + BUSY_WAIT_MS;
    for (;;) {
      try {
        return await this.claw.request<Payload>(
          "sessions.compact",
          { key: session.key, agentId: session.clawAgent },
          { timeoutMs: COMPACT_TIMEOUT_MS },
        );
      } catch (error) {
        if (!BUSY.test(said(error)) || this.now() >= until) throw error;
        await this.sleep(BUSY_EVERY_MS);
      }
    }
  }

  private remember(agentId: string, last: Last): void {
    this.kept.lasts[agentId] = last;
    this.save();
  }

  /** The copy put, when it moved since the last or answers an ask. */
  private async send(agentId: string, answer?: Answer): Promise<void> {
    const body = this.copyOf(agentId);
    if (body === undefined) return;
    const print = JSON.stringify(body);
    if (answer === undefined && this.sent.get(agentId) === print) return;
    this.sent.set(agentId, print);
    try {
      await this.put(agentId, { ...body, ...answer });
    } catch (error) {
      this.sent.delete(agentId);
      this.log(`chips: ${agentId}'s context window not sent: ${said(error)}`);
    }
  }

  private track(work: Promise<void>): void {
    const done = work.catch((error: unknown) => this.log(`openclaw: context window work failed: ${said(error)}`));
    this.running.add(done);
    void done.finally(() => this.running.delete(done));
  }

  private queue(id: string, work: () => Promise<void>): Promise<void> {
    const next = (this.chains.get(id) ?? Promise.resolve()).then(work).catch((error: unknown) => {
      this.log(`chips: ${id}'s context window not sent: ${said(error)}`);
    });
    this.chains.set(id, next);
    return next;
  }

  private load(): Kept {
    if (this.stateFile === undefined || !existsSync(this.stateFile)) return { limits: {}, lasts: {} };
    try {
      const read = JSON.parse(readFileSync(this.stateFile, "utf8")) as Partial<Kept>;
      return { limits: read.limits ?? {}, lasts: read.lasts ?? {} };
    } catch (error) {
      this.log(`bridge: ${this.stateFile} not read, starting without limits: ${said(error)}`);
      return { limits: {}, lasts: {} };
    }
  }

  private save(): void {
    if (this.stateFile === undefined) return;
    writeFileSync(this.stateFile, JSON.stringify(this.kept), { mode: 0o600 });
  }
}
