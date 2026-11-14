/**
 * OpenClaw's own jobs in Chips (Chips ADR 0252): what the gateway runs by itself, outside any room,
 * sent as one copy for the harness's page, each run with what it cost as it finishes, and a
 * person's switch there written into OpenClaw's config.
 *
 * OpenClaw lists them among its scheduled jobs (`cron.list`). One it declared itself carries a
 * `declarationKey` (`heartbeat:main`, `memory-core:memory-dreaming-promotion`,
 * `skill-collection-review:<agent>`), which a job an agent made (ADR 0157's automations) doesn't.
 * Three are ours to show: the Main agent's heartbeat (the same as on its page, ADR 0143), Dreaming,
 * and the weekly skill reviews, one job in Chips for all agents, since OpenClaw has one switch for
 * them all.
 *
 * `cron.update` refuses a declared job, and memory-core turns Dreaming back on within the minute,
 * so each switch is the config that declares it, and each reloads hot: the heartbeat's `every`,
 * memory-core's `dreaming.enabled` (on unless set false), and the skill workshop's
 * `autonomous.mode` (`auto`, else off).
 *
 * Runs come from the gateway's `cron` events as each finishes, and on each start from `cron.runs`,
 * which keeps a week. OpenClaw prices none of them there. A heartbeat runs in Home, whose history
 * drops a quiet check; `sessions.usage` keeps Home's cost by quarter hour, so a heartbeat's is its
 * quarter's when it began the only turn there. A skill review's is its job's session's, which
 * holds its latest run. Dreaming's model calls are in no session, so its runs go without a cost.
 * Chips keeps what a run said before when it is posted again with less, so a start's catch-up,
 * which can price fewer, takes nothing away.
 */

import { Refuse } from "@chipschat/harness";
import type { ClawPort } from "./bridge.ts";
import { beatOf, type ClawAgents, choicesWith, OPENCLAW_EVERY, patchOf } from "./heartbeats.ts";

type Payload = Record<string, unknown>;

/** Our jobs' ids in Chips. */
export const HEARTBEAT = "heartbeat";
export const DREAMING = "dreaming";
export const SKILLS = "skill-review";
export type Own = typeof HEARTBEAT | typeof DREAMING | typeof SKILLS;

const DAY_MS = 86_400_000;
const QUARTER_MS = 900_000;
/** A week of runs: what `cron.runs` keeps. */
const RUNS_PAGE = 200;
const RUNS_PAGES = 5;
/** How long a refusal's words, and a run's, may be in Chips. */
const MESSAGE_MAX = 300;
const ERROR_MAX = 200;
/** OpenClaw refusing a write because the config moved since it was read. */
const MOVED = /config changed since last load/;
const WRITE_TRIES = 3;
/** How long, and how often, the copy answering a change is read again until it shows it. */
const APPLIED_TRIES = 10;
const APPLIED_EVERY_MS = 200;
/** `sessions.usage` reads its files again when asked: how often, and how long apart, to ask. */
const USAGE_TRIES = 6;
const USAGE_EVERY_MS = 5000;
/** How long after a heartbeat priced too soon to price it again, and again. */
const PRICE_AGAIN_MS: readonly number[] = [120_000, 480_000];
/** How long after a heartbeat's run ends its check may still be heard ending. */
const HEARD_SLACK_MS = 5000;
/**
 * How long a run heard starting is said to be going when nothing says it finished: a gateway that
 * restarts mid-run never does. As long as Chips itself believes a job that says it is running.
 */
const RUNNING_FOR_MS = 6 * 3_600_000;

/** One of OpenClaw's scheduled jobs, as `cron.list` and its events say it. */
export interface CronJob {
  readonly id: string;
  readonly declarationKey?: string | null;
  readonly agentId?: string | null;
  readonly enabled?: boolean;
  readonly schedule?: { readonly kind?: string; readonly everyMs?: number; readonly expr?: string };
  readonly nextRunAtMs?: number | null;
}

/** One run of a job, as `cron.runs` and the `cron` event that says it finished have it. */
export interface CronRun {
  readonly jobId: string;
  readonly action?: string;
  readonly status?: string;
  readonly error?: string;
  readonly summary?: string;
  readonly runAtMs?: number;
  readonly durationMs?: number;
  readonly sessionId?: string;
  readonly model?: string;
  readonly usage?: { readonly total_tokens?: number };
}

/** OpenClaw's config, as far as its own jobs go. */
export interface ClawConfig {
  readonly agents?: ClawAgents;
  readonly plugins?: {
    readonly entries?: Readonly<
      Record<string, { readonly config?: { readonly dreaming?: { readonly enabled?: boolean } } }>
    >;
  };
  readonly skills?: { readonly workshop?: { readonly autonomous?: { readonly mode?: string } } };
}

/** Who our agents are, from the bridge: the primary OpenClaw agent, the Main agent, and the rest. */
export interface Ours {
  readonly primary: string;
  /** Home: the primary agent's own conversation, where its heartbeat runs. */
  readonly home: string;
  /** The Chips agent an OpenClaw agent speaks as, when there is one. */
  readonly agentOf: (clawAgent: string) => string | undefined;
}

/** A `job.change` frame from Chips. */
export interface JobChange {
  readonly change_id: string;
  readonly job_id: string;
  readonly on: boolean;
  readonly every?: number;
}

/** Which of ours an OpenClaw job is, by the key it was declared under; nothing for any other. */
export function ownOf(job: Pick<CronJob, "declarationKey">, primary: string): Own | undefined {
  const key = job.declarationKey ?? "";
  if (key === `heartbeat:${primary}`) return HEARTBEAT;
  if (key.startsWith("memory-core:") && key.includes("dreaming")) return DREAMING;
  if (key.startsWith("skill-collection-review:")) return SKILLS;
  return undefined;
}

/** How often a cron expression runs, in minutes, for the three shapes Chips says in words. */
export function everyOfCron(expr: string | undefined): number | undefined {
  const fields = expr?.trim().split(/\s+/);
  if (fields?.length !== 5) return undefined;
  const [minute, hour, day, month, weekday] = fields;
  const fixed = (field: string | undefined) => /^\d+$/.test(field ?? "");
  if (!fixed(minute) || day !== "*" || month !== "*") return undefined;
  if (hour === "*" && weekday === "*") return 60;
  if (!fixed(hour)) return undefined;
  if (weekday === "*") return 1440;
  return fixed(weekday) ? 10_080 : undefined;
}

const isoOf = (ms: number | null | undefined): string | undefined =>
  typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;

const minutesOfJob = (job: CronJob | undefined): number | undefined => {
  const everyMs = job?.schedule?.everyMs;
  if (typeof everyMs === "number" && everyMs >= 60_000) return Math.round(everyMs / 60_000);
  return everyOfCron(job?.schedule?.expr);
};

/**
 * When a job runs next, while it is on and OpenClaw has it: the soonest of its jobs, and never a
 * time gone by, which is a run still going.
 */
function nextOf(on: boolean, jobs: readonly CronJob[], now: number): Payload {
  const next = jobs
    .filter((job) => job.enabled !== false)
    .map((job) => job.nextRunAtMs)
    .filter((ms): ms is number => typeof ms === "number" && ms > now)
    .sort((a, b) => a - b)[0];
  const at = on ? isoOf(next) : undefined;
  return at === undefined ? {} : { next_at: at };
}

/** How often in minutes, or in OpenClaw's words when it isn't an interval Chips says. */
function howOften(job: CronJob | undefined, before: number | undefined, otherwise: number): Payload {
  const every = minutesOfJob(job) ?? before;
  if (every !== undefined) return { every };
  const expr = job?.schedule?.expr;
  return expr === undefined ? { every: otherwise } : { when: `On its schedule (${expr})`.slice(0, 60) };
}

/**
 * The copy Chips takes (`PUT /v1/harnesses/:id/jobs`): the heartbeat, always; Dreaming and the skill
 * reviews while OpenClaw runs them, or keeps them off by its config. `before` is how often each ran
 * as the bridge last saw it, for the interval a job off still says.
 */
export function copyOf(
  config: ClawConfig,
  cron: readonly CronJob[],
  ours: Ours,
  before: ReadonlyMap<Own, number> = new Map(),
  now: number = Date.now(),
): Payload {
  const of = (own: Own) => cron.filter((job) => ownOf(job, ours.primary) === own);
  const jobs: Payload[] = [];

  const beat = beatOf(config.agents, ours.primary);
  const every = beat.every ?? before.get(HEARTBEAT) ?? OPENCLAW_EVERY;
  const main = ours.agentOf(ours.primary);
  jobs.push({
    job_id: HEARTBEAT,
    name: "Heartbeat",
    about:
      "OpenClaw wakes the Main agent to look over its work. It writes in the Main room only when something needs you.",
    kind: "heartbeat",
    every,
    choices: choicesWith(every),
    ...(main === undefined ? {} : { for_agents: [main] }),
    on: beat.on,
    editable: true,
    ...nextOf(beat.on, of(HEARTBEAT), now),
  });

  const dreaming = of(DREAMING);
  const dreams = config.plugins?.entries?.["memory-core"]?.config?.dreaming?.enabled;
  if (dreaming.length > 0 || dreams === false) {
    const on = dreams !== false;
    jobs.push({
      job_id: DREAMING,
      name: "Dreaming",
      about: "Each night OpenClaw goes over its agents' day and keeps what matters in their memory.",
      kind: "memory",
      ...howOften(dreaming[0], before.get(DREAMING), 1440),
      on,
      editable: true,
      ...nextOf(on, dreaming, now),
    });
  }

  const reviews = of(SKILLS);
  const mode = config.skills?.workshop?.autonomous?.mode ?? "auto";
  if (reviews.length > 0 || mode !== "auto") {
    const on = mode === "auto";
    const agents = [
      ...new Set(
        reviews.map((job) => (job.agentId ? ours.agentOf(job.agentId) : undefined)).filter((id) => id !== undefined),
      ),
    ];
    jobs.push({
      job_id: SKILLS,
      name: "Skill review",
      about:
        "Once a week OpenClaw has each agent go over the skills it has written down, merging what repeats and dropping what's stale.",
      kind: "skills",
      // Each agent's review has a day of its own: the next one's isn't theirs all.
      ...(reviews.length > 1 && reviews.every((job) => minutesOfJob(job) === 10_080)
        ? { when: "Every week" }
        : howOften(reviews[0], before.get(SKILLS), 10_080)),
      ...(agents.length === 0 ? {} : { for_agents: agents.slice(0, 200) }),
      on,
      editable: true,
      ...nextOf(on, reviews, now),
    });
  }
  return { jobs };
}

/** The config patch a change is: the switch that declares the job, as OpenClaw reads it. */
export function patchFor(change: Pick<JobChange, "job_id" | "on" | "every">, primary: string, every: number): string {
  switch (change.job_id) {
    case HEARTBEAT:
      return patchOf(primary, { on: change.on, every: change.every ?? every });
    case DREAMING:
      return JSON.stringify({ plugins: { entries: { "memory-core": { config: { dreaming: { enabled: change.on } } } } } });
    case SKILLS:
      return JSON.stringify({ skills: { workshop: { autonomous: { mode: change.on ? "auto" : "off" } } } });
    default:
      throw new Refuse(`OpenClaw has no job "${change.job_id}" for Chips to change.`);
  }
}

/** Whether a copy shows a change made. */
export function shows(copy: Payload, change: Pick<JobChange, "job_id" | "on" | "every">): boolean {
  const job = (copy["jobs"] as Payload[]).find((each) => each["job_id"] === change.job_id);
  return job?.["on"] === change.on && (!change.on || change.every === undefined || job["every"] === change.every);
}

/** An error as a person reads it: OpenClaw's restart said plainly, its `cron: ` dropped. */
export function errorWords(error: string): string {
  const words = error.trim().replace(/^cron:\s*/i, "");
  if (/interrupted by gateway restart/i.test(words)) return "OpenClaw restarted";
  return (words.charAt(0).toUpperCase() + words.slice(1)).slice(0, ERROR_MAX);
}

/** How a person would read what a run said: `NO_REPLY` alone, as a model writes it. */
const NOTHING = /^[\s`*_"'“”]*NO_REPLY[\s`*_"'“”.!]*$/;

/**
 * A finished run as Chips takes it (`POST /v1/harnesses/:id/jobs/runs`), without its cost: done,
 * failed, or stopped by a restart, and quiet when it answered nothing. Nothing for a run that was
 * skipped, which didn't run.
 */
export function runOf(run: CronRun, own: Own, agentId?: string): Payload | undefined {
  if (run.action !== undefined && run.action !== "finished") return undefined;
  if (typeof run.runAtMs !== "number" || run.status === "skipped") return undefined;
  const error = run.error?.trim() ? errorWords(run.error) : undefined;
  const outcome = run.status === "ok" ? "done" : /restart|interrupted|aborted/i.test(run.error ?? "") ? "stopped" : "failed";
  const quiet = own !== HEARTBEAT && outcome === "done" && NOTHING.test(run.summary ?? "");
  const tokens = run.usage?.total_tokens;
  return {
    job_id: own,
    run_id: `${run.jobId}:${run.runAtMs}`,
    started_at: new Date(run.runAtMs).toISOString(),
    ended_at: new Date(run.runAtMs + Math.max(0, run.durationMs ?? 0)).toISOString(),
    outcome,
    ...(quiet ? { quiet: true } : {}),
    ...(outcome === "done" || error === undefined ? {} : { error }),
    ...(agentId === undefined ? {} : { agent_id: agentId }),
    ...(typeof tokens === "number" && tokens > 0 ? { tokens: Math.round(tokens) } : {}),
    ...(run.model ? { model: run.model.slice(0, 80) } : {}),
  };
}

/** Home's cost by quarter hour (UTC), and how many turns began in each. */
export interface Quarters {
  readonly usd: ReadonlyMap<string, number>;
  readonly turns: ReadonlyMap<string, number>;
}

const quarterOf = (ms: number): string => `${new Date(ms).toISOString().slice(0, 10)}:${Math.floor((ms % DAY_MS) / QUARTER_MS)}`;

/** Quarters from what `sessions.usage` says of one session; nothing while it is still reading. */
export function quartersOf(answer: unknown): Quarters | undefined {
  const usage = ((answer as Payload | undefined)?.["sessions"] as Payload[] | undefined)?.[0]?.["usage"] as Payload | undefined;
  if (usage === undefined || usage === null) return undefined;
  const usd = new Map<string, number>();
  const turns = new Map<string, number>();
  for (const each of (usage["utcQuarterHourTokenUsage"] ?? []) as Payload[]) {
    if (typeof each["totalCost"] === "number") usd.set(`${String(each["date"])}:${String(each["quarterIndex"])}`, each["totalCost"]);
  }
  for (const each of (usage["utcQuarterHourMessageCounts"] ?? []) as Payload[]) {
    if (typeof each["user"] === "number") turns.set(`${String(each["date"])}:${String(each["quarterIndex"])}`, each["user"]);
  }
  return { usd, turns };
}

/**
 * What a heartbeat that ran from `start` to `end` cost: Home's quarters it ran in, when it began
 * the only turn in them. Nothing when another turn shared one, or Home's usage hasn't counted it.
 */
export function heartbeatCost(quarters: Quarters, start: number, end: number): number | undefined {
  let usd = 0;
  let began = 0;
  for (let at = start - (start % QUARTER_MS); at <= end; at += QUARTER_MS) {
    const key = quarterOf(at);
    began += quarters.turns.get(key) ?? 0;
    usd += quarters.usd.get(key) ?? 0;
  }
  return began === 1 ? Math.round(usd * 1e6) / 1e6 : undefined;
}

/** What a session's history since `since` cost, each assistant message as OpenClaw priced it. */
export function historyCost(messages: unknown, since: number): number | undefined {
  if (!Array.isArray(messages)) return undefined;
  let usd = 0;
  let priced = false;
  for (const message of messages as Payload[]) {
    if (message?.["role"] !== "assistant" || !(Number(message["timestamp"]) >= since)) continue;
    const total = ((message["usage"] as Payload | undefined)?.["cost"] as Payload | undefined)?.["total"];
    if (typeof total !== "number") continue;
    priced = true;
    usd += total;
  }
  return priced ? Math.round(usd * 1e6) / 1e6 : undefined;
}

/** Whether a run's history shows a command that waited for an approval until it ran out. */
export const waitedIn = (messages: unknown): boolean => JSON.stringify(messages ?? []).includes("approval-timeout");

/**
 * The copy Chips holds of OpenClaw's own jobs, kept current, and their runs as they finish. Reads
 * and sends go one after another, so a later copy never lands before an earlier one.
 */
export class Jobs {
  private chain: Promise<unknown> = Promise.resolve();
  /** Ours among OpenClaw's jobs, by its id, as last listed. */
  private readonly cron = new Map<string, { readonly own: Own; readonly job: CronJob }>();
  /** How often each ran when last seen, for a job turned off. */
  private readonly before = new Map<Own, number>();
  /** Heartbeats sent before Home's usage counted them, by run id, to price when it has. */
  private readonly unpriced = new Map<string, { readonly run: CronRun; readonly sent: Payload }>();
  /** The heartbeat's checks heard ending (its `heartbeat` events): when, and whether each told the person something. */
  private heard: { readonly at: number; readonly notify: boolean }[] = [];
  /** Runs of ours heard starting and not yet finishing, by OpenClaw's job: whose, and since when. */
  private readonly going = new Map<string, { readonly own: Own; readonly at: number }>();

  constructor(
    private readonly claw: ClawPort,
    private readonly chips: {
      readonly put: (copy: Payload) => Promise<unknown>;
      readonly runs: (runs: readonly Payload[]) => Promise<unknown>;
    },
    private readonly ours: () => Ours,
    private readonly log: (message: string) => void,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
    private readonly now: () => number = Date.now,
  ) {}

  /** The copy as OpenClaw has it now. */
  async read(): Promise<Payload> {
    const ours = this.ours();
    const [{ config }, listed] = await Promise.all([
      this.claw.request<{ config?: ClawConfig }>("config.get", {}),
      this.claw.request<{ jobs?: CronJob[] }>("cron.list", { includeDisabled: true }),
    ]);
    const cron = listed.jobs ?? [];
    this.cron.clear();
    for (const job of cron) {
      const own = ownOf(job, ours.primary);
      if (own === undefined) continue;
      this.cron.set(job.id, { own, job });
      const every = minutesOfJob(job);
      if (every !== undefined && job.enabled !== false) this.before.set(own, every);
    }
    const beat = beatOf(config?.agents, ours.primary).every;
    if (beat !== undefined) this.before.set(HEARTBEAT, beat);
    return this.withRunning(copyOf(config ?? {}, cron, ours, this.before, this.now()));
  }

  /**
   * The copy with `running_since` on each job a run of which is going now, the earliest where
   * several are (each agent's skill review is a run of its own). Chips starts neither this bridge
   * nor itself again on a new release while a job says so: a check that ends while the bridge is
   * away never reaches its room.
   */
  private withRunning(copy: Payload): Payload {
    const now = this.now();
    const since = new Map<Own, number>();
    for (const [jobId, run] of this.going) {
      if (now - run.at >= RUNNING_FOR_MS) this.going.delete(jobId);
      else since.set(run.own, Math.min(since.get(run.own) ?? run.at, run.at));
    }
    if (since.size === 0) return copy;
    const jobs = (copy["jobs"] as Payload[]).map((job) => {
      const at = since.get(job["job_id"] as Own);
      return at === undefined ? job : { ...job, running_since: new Date(at).toISOString() };
    });
    return { ...copy, jobs };
  }

  /** The copy read and sent; the SDK sends it only when it isn't what Chips took last. */
  send(): Promise<void> {
    return this.inLine(async () => {
      await this.chips.put(await this.read());
    }).catch((error: unknown) => this.log(`chips: OpenClaw's own jobs not sent: ${String(error)}`));
  }

  /**
   * On a start: the copy, then every run `cron.runs` still keeps, priced where it can be, so a run
   * that finished while the bridge was away is in Chips too.
   */
  async catchUp(): Promise<void> {
    await this.send();
    const runs: Payload[] = [];
    const home = await this.homeQuarters();
    for (const [jobId, { own, job }] of this.cron) {
      for (const run of await this.runsOf(jobId)) {
        const agentId = own === SKILLS && job.agentId ? this.ours().agentOf(job.agentId) : undefined;
        const made = runOf(run, own, agentId);
        if (made === undefined) continue;
        const sent = { ...made, ...(await this.priced(run, own, job, home)) };
        // A check of the last day Home's usage hasn't counted yet is priced at the next one.
        const recent = this.now() - (run.runAtMs ?? 0) < DAY_MS;
        if (own === HEARTBEAT && sent["cost_usd"] === undefined && recent) this.unpriced.set(String(sent["run_id"]), { run, sent });
        runs.push(sent);
      }
    }
    if (runs.length === 0) return;
    await this.chips.runs(runs).catch((error: unknown) => this.log(`chips: OpenClaw's jobs' runs not sent: ${String(error)}`));
    this.log(`chips: ${runs.length} runs of OpenClaw's own jobs sent`);
  }

  /**
   * A `cron` event: a run of ours that finished is priced and sent, then the copy, whose next run
   * has moved; one of ours added, changed or removed sends the copy, and so does a run starting,
   * which the copy then says is going.
   */
  cronEvent(p: Payload): void {
    const jobId = typeof p["jobId"] === "string" ? p["jobId"] : undefined;
    const job = p["job"] as CronJob | undefined;
    const own = jobId === undefined ? undefined : (this.cron.get(jobId)?.own ?? (job ? ownOf(job, this.ours().primary) : undefined));
    if (jobId === undefined || own === undefined) return;
    const action = p["action"];
    if (action === "started") {
      this.going.set(jobId, { own, at: typeof p["runAtMs"] === "number" ? p["runAtMs"] : this.now() });
    } else if (action === "finished" || action === "removed") {
      this.going.delete(jobId);
    }
    if (action !== "finished") {
      void this.send();
      return;
    }
    void this.finished(p as unknown as CronRun, own);
  }

  /** A check of the heartbeat heard ending, and whether it told the person something. */
  replied(at: number, notify: boolean): void {
    this.heard = [...this.heard.filter((each) => at - each.at < DAY_MS), { at, notify }];
  }

  /**
   * A person's switch from Chips: written into OpenClaw's config, and answered by the copy as it is
   * now, once it shows the change or after a few reads. A write OpenClaw refuses is refused with its
   * words, and the copy beside it says what holds.
   */
  async change(frame: JobChange): Promise<Payload> {
    const ours = this.ours();
    try {
      const raw = patchFor(frame, ours.primary, this.before.get(HEARTBEAT) ?? OPENCLAW_EVERY);
      await this.write(raw);
    } catch (error) {
      if (error instanceof Refuse) throw error;
      const message = String((error as Error)?.message ?? error).slice(0, MESSAGE_MAX);
      this.log(`openclaw: ${frame.job_id} not switched from Chips: ${message}`);
      throw new Refuse(message, await this.read().catch(() => undefined));
    }
    this.log(`openclaw: ${frame.job_id} ${frame.on ? `on${frame.every === undefined ? "" : `, every ${frame.every} min`}` : "off"}, from Chips`);
    return this.inLine(async () => {
      let copy = await this.read();
      for (let tries = 1; !shows(copy, frame) && tries < APPLIED_TRIES; tries += 1) {
        await this.sleep(APPLIED_EVERY_MS);
        copy = await this.read();
      }
      return copy;
    });
  }

  /** Every read and send asked for so far, done; for the tests and for a clean stop. */
  async settled(): Promise<void> {
    await this.chain.catch(() => undefined);
  }

  /** A run of ours that finished, priced, sent, then the copy; a heartbeat not priced yet, later. */
  private async finished(run: CronRun, own: Own): Promise<void> {
    const job = this.cron.get(run.jobId)?.job ?? { id: run.jobId };
    const agentId = own === SKILLS && job.agentId ? this.ours().agentOf(job.agentId) : undefined;
    const made = runOf(run, own, agentId);
    if (made === undefined) return;
    const home = own === HEARTBEAT ? await this.homeQuarters() : undefined;
    const sent = { ...made, ...this.quietOf(run, own), ...(await this.priced(run, own, job, home)) };
    await this.chips.runs([sent]).catch((error: unknown) => this.log(`chips: a run of ${own} not sent: ${String(error)}`));
    // Its next run has moved.
    void this.send();
    if (own !== HEARTBEAT) return;
    // Home's usage counts a check some minutes after it ends: one it hadn't is priced again later,
    // and at each check after, and sent again with its cost, which Chips lays over what it has.
    if (sent["cost_usd"] === undefined) this.unpriced.set(String(sent["run_id"]), { run, sent });
    if (home !== undefined) await this.priceUnpriced(home);
    for (const wait of PRICE_AGAIN_MS) {
      if (!this.unpriced.has(String(sent["run_id"]))) return;
      await this.sleep(wait);
      await this.priceUnpriced(await this.homeQuarters());
    }
  }

  /** The heartbeats Home's usage hadn't counted, priced now where it has; a day old, given up. */
  private async priceUnpriced(home: Quarters | undefined): Promise<void> {
    const priced: Payload[] = [];
    for (const [id, { run, sent }] of this.unpriced) {
      const start = run.runAtMs ?? 0;
      const usd = home === undefined ? undefined : heartbeatCost(home, start, start + (run.durationMs ?? 0));
      if (usd !== undefined) priced.push({ ...sent, cost_usd: usd });
      if (usd !== undefined || this.now() - start > DAY_MS) this.unpriced.delete(id);
    }
    if (priced.length === 0) return;
    await this.chips.runs(priced).catch((error: unknown) => this.log(`chips: heartbeats' costs not sent: ${String(error)}`));
  }

  /** Whether a heartbeat had nothing to say, by the check heard ending as it ran. */
  private quietOf(run: CronRun, own: Own): Payload {
    if (own !== HEARTBEAT || run.runAtMs === undefined) return {};
    const end = run.runAtMs + (run.durationMs ?? 0) + HEARD_SLACK_MS;
    const reply = this.heard.find((each) => each.at >= run.runAtMs! && each.at <= end);
    return reply === undefined ? {} : { quiet: !reply.notify };
  }

  /** What a run cost, and whether it waited for an approval, where OpenClaw keeps that. */
  private async priced(run: CronRun, own: Own, job: CronJob, home: Quarters | undefined): Promise<Payload> {
    if (run.runAtMs === undefined) return {};
    if (own === HEARTBEAT) {
      const usd = home === undefined ? undefined : heartbeatCost(home, run.runAtMs, run.runAtMs + (run.durationMs ?? 0));
      return usd === undefined ? {} : { cost_usd: usd };
    }
    if (own !== SKILLS || !job.agentId || run.sessionId === undefined) return {};
    try {
      const history = await this.claw.request<{ sessionId?: string; messages?: unknown }>("chat.history", {
        sessionKey: `agent:${job.agentId}:cron:${job.id}`,
        limit: 200,
      });
      // The job's session holds its latest run alone.
      if (history.sessionId !== run.sessionId) return {};
      const usd = historyCost(history.messages, run.runAtMs);
      return { ...(usd === undefined ? {} : { cost_usd: usd }), ...(waitedIn(history.messages) ? { waited: true } : {}) };
    } catch (error) {
      this.log(`openclaw: could not read what a skill review cost: ${String(error)}`);
      return {};
    }
  }

  /**
   * Home's cost by quarter hour. A read sets OpenClaw counting what changed since and answers with
   * what it had, "refreshing", so it is asked again until it says it is done; what it last had, if
   * it never does.
   */
  private async homeQuarters(): Promise<Quarters | undefined> {
    let last: Quarters | undefined;
    for (let tries = 1; tries <= USAGE_TRIES; tries += 1) {
      try {
        const answer = await this.claw.request<Payload>("sessions.usage", { key: this.ours().home });
        last = quartersOf(answer) ?? last;
        const refreshing = (answer["cacheStatus"] as Payload | undefined)?.["status"] === "refreshing";
        if (last !== undefined && !refreshing) return last;
      } catch (error) {
        this.log(`openclaw: could not read what Home cost: ${String(error)}`);
        return last;
      }
      if (tries < USAGE_TRIES) await this.sleep(USAGE_EVERY_MS);
    }
    return last;
  }

  /** The runs `cron.runs` keeps of one job, newest first, as far as a week. */
  private async runsOf(jobId: string): Promise<CronRun[]> {
    const runs: CronRun[] = [];
    try {
      for (let page = 0, offset = 0; page < RUNS_PAGES; page += 1) {
        const answer = await this.claw.request<{ entries?: CronRun[]; hasMore?: boolean; nextOffset?: number | null }>(
          "cron.runs",
          { id: jobId, limit: RUNS_PAGE, offset },
        );
        runs.push(...(answer.entries ?? []));
        if (answer.hasMore !== true || typeof answer.nextOffset !== "number") break;
        offset = answer.nextOffset;
      }
    } catch (error) {
      this.log(`openclaw: could not read the runs of ${jobId}: ${String(error)}`);
    }
    return runs;
  }

  /** The config patched as it is now, read again if it moved meanwhile. */
  private async write(raw: string): Promise<void> {
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

  /** Work after what was asked before; its own result or failure. */
  private inLine<T>(work: () => Promise<T>): Promise<T> {
    const done = this.chain.then(work, work);
    this.chain = done.catch(() => undefined);
    return done;
  }
}
