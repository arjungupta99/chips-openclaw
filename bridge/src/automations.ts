/**
 * OpenClaw's automations, answering in the room they were asked in (Chips ADR 0157). An agent in a
 * Chips room schedules with OpenClaw's own `automations` tool (once `cron`): OpenClaw keeps the clock
 * and runs the job, and the bridge says what the job says in the room whose turn made it, as that
 * room's agent, with an @ for the person who asked.
 *
 * - A job keeps the session whose turn made it (`owner.sessionKey`; a `current` job is also bound to
 *   that conversation, `sessionKey`), and OpenClaw's `cron` event carries the whole job each time it
 *   is added, started or finished. So a job made in a room's turn is that room's, and a restarted
 *   bridge learns it again from the job's next event.
 * - A job's run is a turn in a session of its own, `agent:<agent>:cron:<job>:run:<id>`, however the
 *   job was made: said in the job's room as a turn OpenClaw started on its own, with its steps and
 *   its approvals, and its answer @s the person.
 * - A `current` job also commits its answer to the room's own conversation: a `session.message`
 *   whose message carries `openclawAutomation: { kind: "cron", jobId, runId }`. Posted there only
 *   when the bridge did not post its run's answer already (a restart between the two), never twice.
 * - Who a job is for is not OpenClaw's to know. The bridge keeps the person whose words the turn that
 *   made it answered, by job, in its state, so a restart keeps it; otherwise the room's only person.
 * - A `main` job, a system event that wakes an agent's Home, is the default agent's alone: OpenClaw
 *   refuses one from any other ("sessionTarget \"main\" is only valid for the default agent", seen on
 *   scratch, 13 October 2026), and the default agent's Home is the Main room already. So every turn
 *   is told to schedule with `current` (`SPEAKING_LATER`).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

type Payload = Record<string, unknown>;

const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/**
 * What every turn in a room is told of speaking later (ADR 0157): OpenClaw reads an `at` with no
 * offset as UTC, and the room's people live in the zone Chips's note gives. An isolated job's
 * default delivery (`announce`) has no route here, so OpenClaw counts its run failed and keeps a
 * one-shot disabled after it (scratch, 13 October 2026), though the bridge posts its answer. A
 * reminder is said to be set, and said when it fires, with ⏰ (Arjun, 14 October 2026).
 */
export const SPEAKING_LATER =
  'To remind someone or to do something later, use automations with sessionTarget "current", or "isolated" with delivery {mode: "none"}: what it says then is posted in this space either way. ' +
  "Write a time with the UTC offset Chips's note gives; an `at` without one is read as UTC. " +
  "When you set one, say so in one line that begins with ⏰ and gives the time it fires, in the person's time, and have what it says when it fires begin with ⏰ too.";

/** A job's run, a turn in a session of its own: the OpenClaw agent, and the job. */
const CRON_SESSION = /^agent:([^:]+):cron:([^:]+)(?::run:.+)?$/;

/** The job a session is a run of, when it is one. */
export function jobOfSession(sessionKey: string): string | undefined {
  return CRON_SESSION.exec(sessionKey)?.[2];
}

/** A person, by the @ that reaches them in Chips (`@Arjun`). */
export interface Person {
  readonly id: string;
  readonly handle: string;
}

/** A job made in a turn of one of our sessions. */
export interface Job {
  readonly id: string;
  readonly name: string | undefined;
  /** The session whose turn made it: a room's, or Home. */
  readonly sessionKey: string;
}

/** The job a `cron` event carries, when it says the session that made it. */
export function jobOf(job: unknown): Job | undefined {
  if (typeof job !== "object" || job === null) return undefined;
  const j = job as Payload;
  const id = str(j["id"]);
  const sessionKey = str((j["owner"] as Payload | undefined)?.["sessionKey"]) ?? str(j["sessionKey"]);
  if (id === undefined || sessionKey === undefined) return undefined;
  return { id, name: str(j["name"]), sessionKey };
}

/** What a `current` job committed to a conversation: its job and run, as the message's provenance says. */
export function committedOf(message: unknown): { readonly jobId: string; readonly runId: string } | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const m = message as Payload;
  const made = m["openclawAutomation"] as Payload | undefined;
  const jobId = str(made?.["jobId"]);
  const runId = str(made?.["runId"]);
  if (m["role"] !== "assistant" || made?.["kind"] !== "cron" || jobId === undefined || runId === undefined) return undefined;
  return { jobId, runId };
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether words @ any of these handles, as a whole handle (`@Arjun`, not `@Arjuna`). */
export function mentionsAny(text: string, handles: readonly string[]): boolean {
  return handles.some((handle) => new RegExp(`(?<![\\w@])${escaped(handle)}(?![\\w])`, "i").test(text));
}

/**
 * Words for the person a job is for: their @ first, unless the words @ somebody in the room already.
 * As they are when nobody is known.
 */
export function forPerson(text: string, person: Person | undefined, handles: readonly string[]): string {
  if (person === undefined || mentionsAny(text, [...handles, person.handle])) return text;
  return `${person.handle} ${text}`;
}

/**
 * The jobs made in our rooms, and who each is for. Who it is for is kept in the bridge's state, as
 * OpenClaw keeps nothing of it; the rest OpenClaw says again with each event.
 */
export class Automations {
  private readonly jobs = new Map<string, Job>();
  private readonly askers: Record<string, Person>;
  /** Jobs whose run's answer the bridge posted, until their commit to the room's conversation comes. */
  private readonly answered = new Set<string>();

  constructor(
    private readonly stateFile?: string,
    private readonly log: (message: string) => void = () => undefined,
  ) {
    this.askers = this.load();
  }

  /** A job as OpenClaw's event carries it; when it is new, who it is for. */
  learn(job: Job, asker: Person | undefined): void {
    this.jobs.set(job.id, job);
    if (asker === undefined || this.askers[job.id] !== undefined) return;
    this.askers[job.id] = asker;
    this.save();
  }

  /** A job removed in OpenClaw: a one-shot after its run, or one a person or its agent took away. */
  forget(jobId: string): void {
    this.jobs.delete(jobId);
    this.answered.delete(jobId);
    if (this.askers[jobId] === undefined) return;
    delete this.askers[jobId];
    this.save();
  }

  job(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  /** The person a job is for, when the bridge saw it made. */
  askerOf(jobId: string | undefined): Person | undefined {
    return jobId === undefined ? undefined : this.askers[jobId];
  }

  /** A run of the job said its answer in the room. */
  said(jobId: string): void {
    this.answered.add(jobId);
  }

  /** Whether the job's commit is said already, by its run's answer; once. */
  takeSaid(jobId: string): boolean {
    return this.answered.delete(jobId);
  }

  private load(): Record<string, Person> {
    if (this.stateFile === undefined || !existsSync(this.stateFile)) return {};
    try {
      return JSON.parse(readFileSync(this.stateFile, "utf8")) as Record<string, Person>;
    } catch (error) {
      this.log(`bridge: ${this.stateFile} not read, starting without who automations are for: ${String(error)}`);
      return {};
    }
  }

  private save(): void {
    if (this.stateFile === undefined) return;
    try {
      writeFileSync(this.stateFile, JSON.stringify(this.askers), { mode: 0o600 });
    } catch (error) {
      this.log(`bridge: ${this.stateFile} not written: ${String(error)}`);
    }
  }
}
