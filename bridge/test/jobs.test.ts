/**
 * OpenClaw's own jobs in Chips (Chips ADR 0252): the copy read from its config and its scheduled
 * jobs, the patch each switch is, each run as Chips takes it, and what a run cost. A stand-in
 * gateway keeps a config with its hash, the jobs OpenClaw declared from it, their runs, Home's cost
 * by quarter hour and a skill review's session, as OpenClaw does.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClawPort } from "../src/bridge.ts";
import {
  type ClawConfig,
  type CronJob,
  type CronRun,
  copyOf,
  DREAMING,
  everyOfCron,
  errorWords,
  HEARTBEAT,
  heartbeatCost,
  historyCost,
  Jobs,
  type Ours,
  ownOf,
  patchFor,
  quartersOf,
  runOf,
  SKILLS,
  waitedIn,
} from "../src/jobs.ts";

type Payload = Record<string, unknown>;

/** Saturday 31 October 2026, 15:54 UTC: a heartbeat's minute. */
const BEAT_AT = Date.UTC(2026, 9, 31, 15, 54, 47);
const MAIN = "agt_01M3MAIN0000000000000000AA";
const FEN = "agt_01M5FEN00000000000000000AA";

const ours: Ours = {
  primary: "main",
  home: "agent:main:main",
  agentOf: (claw) => ({ main: MAIN, "chips-01m5fen": FEN })[claw],
};

const heartbeatJob: CronJob = {
  id: "5ecdc04c",
  declarationKey: "heartbeat:main",
  agentId: "main",
  enabled: true,
  schedule: { kind: "every", everyMs: 3_600_000 },
  nextRunAtMs: BEAT_AT + 3_600_000,
};
const dreamingJob: CronJob = {
  id: "96e44ef3",
  declarationKey: "memory-core:memory-dreaming-promotion",
  agentId: null,
  enabled: true,
  schedule: { kind: "cron", expr: "0 3 * * *" },
  nextRunAtMs: Date.UTC(2026, 10, 1, 10),
};
const review = (id: string, agent: string, next: number): CronJob => ({
  id,
  declarationKey: `skill-collection-review:${agent}`,
  agentId: agent,
  enabled: true,
  schedule: { kind: "every", everyMs: 604_800_000 },
  nextRunAtMs: next,
});
/** A job one of the agents made in a room (ADR 0157): not OpenClaw's own. */
const automation: CronJob = { id: "a1", agentId: "main", enabled: true, schedule: { kind: "cron", expr: "0 9 * * 1" } };

const LIVE: ClawConfig = {
  agents: { entries: { main: { heartbeat: { every: "60m", target: "none" } } } },
  plugins: { entries: { "memory-core": { config: {} } } },
};
const CRON = [
  heartbeatJob,
  dreamingJob,
  review("28e992c3", "main", Date.UTC(2026, 10, 1, 1)),
  review("d9d49888", "chips-01m5fen", Date.UTC(2026, 10, 5, 3)),
  automation,
];

describe("OpenClaw's own jobs, as Chips is told them", () => {
  it("are the jobs OpenClaw declared itself, and none an agent made", () => {
    assert.equal(ownOf(heartbeatJob, "main"), HEARTBEAT);
    assert.equal(ownOf(dreamingJob, "main"), DREAMING);
    assert.equal(ownOf(review("x", "main", 0), "main"), SKILLS);
    assert.equal(ownOf(automation, "main"), undefined);
    // Another agent's heartbeat is not the Main agent's.
    assert.equal(ownOf({ declarationKey: "heartbeat:ops" }, "main"), undefined);
  });

  it("say how often a cron expression runs, for the shapes Chips says in words", () => {
    assert.equal(everyOfCron("0 3 * * *"), 1440);
    assert.equal(everyOfCron("1 20 * * 4"), 10_080);
    assert.equal(everyOfCron("15 * * * *"), 60);
    assert.equal(everyOfCron("*/5 * * * *"), undefined);
    assert.equal(everyOfCron("0 3 1 * *"), undefined);
  });

  it("are the heartbeat, Dreaming and one skill review for every agent, each with its next run", () => {
    assert.deepEqual(copyOf(LIVE, CRON, ours, new Map(), BEAT_AT), {
      jobs: [
        {
          job_id: "heartbeat",
          name: "Heartbeat",
          about:
            "OpenClaw wakes the Main agent to look over its work. It writes in the Main room only when something needs you.",
          kind: "heartbeat",
          every: 60,
          choices: [15, 30, 60, 120, 240, 720, 1440],
          for_agents: [MAIN],
          on: true,
          editable: true,
          next_at: new Date(BEAT_AT + 3_600_000).toISOString(),
        },
        {
          job_id: "dreaming",
          name: "Dreaming",
          about: "Each night OpenClaw goes over its agents' day and keeps what matters in their memory.",
          kind: "memory",
          every: 1440,
          on: true,
          editable: true,
          next_at: "2026-11-01T10:00:00.000Z",
        },
        {
          job_id: "skill-review",
          name: "Skill review",
          about:
            "Once a week OpenClaw has each agent go over the skills it has written down, merging what repeats and dropping what's stale.",
          kind: "skills",
          when: "Every week",
          for_agents: [MAIN, FEN],
          on: true,
          editable: true,
          next_at: "2026-11-01T01:00:00.000Z",
        },
      ],
    });
  });

  it("never say a next run gone by, which is a run still going, and a single review's day", () => {
    const running = review("93fb78ff", "main", BEAT_AT - 60_000);
    const jobs = copyOf(LIVE, [heartbeatJob, running], ours, new Map(), BEAT_AT)["jobs"] as Payload[];
    const skills = jobs.find((job) => job["job_id"] === "skill-review");
    assert.deepEqual([skills?.["every"], skills?.["when"], skills?.["next_at"]], [10_080, undefined, undefined]);
  });

  it("are off, with no next run, as the config keeps them off, each with how often it ran before", () => {
    const off: ClawConfig = {
      agents: { entries: { main: { heartbeat: { every: "0m", target: "none" } } } },
      plugins: { entries: { "memory-core": { config: { dreaming: { enabled: false } } } } },
      skills: { workshop: { autonomous: { mode: "off" } } },
    };
    const before = new Map([
      [HEARTBEAT, 60],
      [DREAMING, 1440],
      [SKILLS, 10_080],
    ] as const);
    const jobs = copyOf(off, [automation], ours, before)["jobs"] as Payload[];
    assert.deepEqual(
      jobs.map((job) => [job["job_id"], job["on"], job["every"], job["next_at"]]),
      [
        ["heartbeat", false, 60, undefined],
        ["dreaming", false, 1440, undefined],
        ["skill-review", false, 10_080, undefined],
      ],
    );
  });

  it("leave out Dreaming and skill reviews on an OpenClaw that runs neither", () => {
    const jobs = copyOf({ agents: LIVE.agents }, [heartbeatJob], ours)["jobs"] as Payload[];
    assert.deepEqual(
      jobs.map((job) => job["job_id"]),
      ["heartbeat"],
    );
  });

  it("switch each in the config that declares it", () => {
    assert.deepEqual(JSON.parse(patchFor({ job_id: HEARTBEAT, on: false }, "main", 60)), {
      agents: { entries: { main: { heartbeat: { every: "0m", target: "none" } } } },
    });
    assert.deepEqual(JSON.parse(patchFor({ job_id: HEARTBEAT, on: true, every: 240 }, "main", 60)), {
      agents: { entries: { main: { heartbeat: { every: "240m", target: "none" } } } },
    });
    assert.deepEqual(JSON.parse(patchFor({ job_id: DREAMING, on: false }, "main", 60)), {
      plugins: { entries: { "memory-core": { config: { dreaming: { enabled: false } } } } },
    });
    assert.deepEqual(JSON.parse(patchFor({ job_id: SKILLS, on: true }, "main", 60)), {
      skills: { workshop: { autonomous: { mode: "auto" } } },
    });
    assert.throws(() => patchFor({ job_id: "cleanup", on: false }, "main", 60), /no job "cleanup"/);
  });
});

describe("a run of one of them", () => {
  const finished = (more: Partial<CronRun>): CronRun => ({
    jobId: "96e44ef3",
    action: "finished",
    status: "ok",
    summary: "NO_REPLY",
    runAtMs: Date.UTC(2026, 9, 31, 10, 0, 0, 20),
    durationMs: 5774,
    model: "claude-opus-5-5",
    ...more,
  });

  it("is done, and quiet when it answered nothing", () => {
    assert.deepEqual(runOf(finished({}), DREAMING), {
      job_id: "dreaming",
      run_id: `96e44ef3:${Date.UTC(2026, 9, 31, 10, 0, 0, 20)}`,
      started_at: "2026-10-31T10:00:00.020Z",
      ended_at: "2026-10-31T10:00:05.794Z",
      outcome: "done",
      quiet: true,
      model: "claude-opus-5-5",
    });
    const said = runOf(finished({ summary: "Kept three things.", usage: { total_tokens: 43_344 } }), DREAMING);
    assert.equal(said?.["quiet"], undefined);
    assert.equal(said?.["tokens"], 43_344);
  });

  it("is stopped by a restart, failed otherwise, in plain words, and nothing when skipped", () => {
    const restarted = runOf(finished({ status: "error", error: "cron: job interrupted by gateway restart" }), SKILLS, FEN);
    assert.deepEqual([restarted?.["outcome"], restarted?.["error"], restarted?.["agent_id"]], ["stopped", "OpenClaw restarted", FEN]);
    const failed = runOf(finished({ status: "error", error: "cron: model overloaded" }), DREAMING);
    assert.deepEqual([failed?.["outcome"], failed?.["error"]], ["failed", "Model overloaded"]);
    assert.equal(runOf(finished({ status: "skipped" }), DREAMING), undefined);
    assert.equal(runOf(finished({ action: "started" }), DREAMING), undefined);
    assert.equal(errorWords(`cron: ${"x".repeat(400)}`).length, 200);
  });

  it("costs a heartbeat's quarter hour of Home, when it began the only turn there", () => {
    const answer = {
      sessions: [
        {
          usage: {
            utcQuarterHourTokenUsage: [
              { date: "2026-10-31", quarterIndex: 63, totalCost: 0.342151 },
              { date: "2026-10-31", quarterIndex: 59, totalCost: 1.2 },
            ],
            utcQuarterHourMessageCounts: [
              { date: "2026-10-31", quarterIndex: 63, user: 1 },
              { date: "2026-10-31", quarterIndex: 59, user: 2 },
            ],
          },
        },
      ],
    };
    const quarters = quartersOf(answer);
    assert.ok(quarters !== undefined);
    assert.equal(heartbeatCost(quarters, BEAT_AT, BEAT_AT + 14_507), 0.342151);
    // A person wrote in Home in the same quarter: the heartbeat's share isn't known.
    assert.equal(heartbeatCost(quarters, Date.UTC(2026, 9, 31, 14, 54), Date.UTC(2026, 9, 31, 14, 54, 15)), undefined);
    // A quarter Home's usage hasn't counted yet.
    assert.equal(heartbeatCost(quarters, Date.UTC(2026, 9, 31, 16, 54), Date.UTC(2026, 9, 31, 16, 54, 6)), undefined);
    // Still reading its files.
    assert.equal(quartersOf({ sessions: [{ usage: null }] }), undefined);
  });

  it("costs a skill review its session's priced calls, and says when a command waited for an approval", () => {
    const messages = [
      { role: "assistant", timestamp: 100, content: "Review this agent's Skill Workshop…" },
      { role: "assistant", timestamp: 101, usage: { cost: { total: 0.053416 } } },
      { role: "custom", timestamp: 102, content: [{ type: "toolResult", text: "Exec denied (gateway id=e3, approval-timeout)" }] },
      { role: "assistant", timestamp: 103, usage: { cost: { total: 0.0081096 } } },
    ];
    assert.equal(historyCost(messages, 100), 0.061526);
    assert.equal(historyCost(messages, 104), undefined);
    assert.equal(waitedIn(messages), true);
    assert.equal(waitedIn(messages.slice(0, 2)), false);
  });
});

/** A stand-in gateway: a config with a hash, jobs declared from it, runs, Home's usage, a session. */
function gateway(config: Payload = structuredClone(LIVE) as Payload) {
  let hash = 1;
  const patches: Payload[] = [];
  let refuse: string | undefined;
  /** How many reads of Home's usage come back before it has counted the latest check. */
  let uncounted = 0;
  const runs = new Map<string, CronRun[]>();
  const merge = (into: Payload, patch: Payload): void => {
    for (const [key, value] of Object.entries(patch)) {
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        into[key] = (typeof into[key] === "object" && into[key] !== null ? into[key] : {}) as Payload;
        merge(into[key] as Payload, value as Payload);
      } else into[key] = value;
    }
  };
  /** The jobs OpenClaw declares from its config, as it would. */
  const declared = (): CronJob[] => {
    const c = config as ClawConfig;
    return [
      ...(c.agents?.entries?.["main"]?.heartbeat?.every === "0m" ? [] : [heartbeatJob]),
      ...(c.plugins?.entries?.["memory-core"]?.config?.dreaming?.enabled === false ? [] : [dreamingJob]),
      ...(c.skills?.workshop?.autonomous?.mode === "off" ? [] : CRON.filter((job) => ownOf(job, "main") === SKILLS)),
      automation,
    ];
  };
  const claw: ClawPort = {
    request: async <T>(method: string, params: Payload): Promise<T> => {
      switch (method) {
        case "config.get":
          return { config: structuredClone(config), hash: `h${hash}` } as T;
        case "config.patch": {
          if (refuse !== undefined) throw new Error(refuse);
          if (params["baseHash"] !== `h${hash}`) throw new Error("config changed since last load");
          patches.push(JSON.parse(String(params["raw"])) as Payload);
          merge(config, JSON.parse(String(params["raw"])) as Payload);
          hash += 1;
          return {} as T;
        }
        case "cron.list":
          return { jobs: declared() } as T;
        case "cron.runs":
          return { entries: runs.get(String(params["id"])) ?? [], hasMore: false } as T;
        case "sessions.usage":
          if (uncounted > 0) {
            uncounted -= 1;
            return { sessions: [{ usage: { utcQuarterHourTokenUsage: [], utcQuarterHourMessageCounts: [] } }] } as T;
          }
          return {
            sessions: [
              {
                usage: {
                  utcQuarterHourTokenUsage: [{ date: "2026-10-31", quarterIndex: 63, totalCost: 0.342151 }],
                  utcQuarterHourMessageCounts: [{ date: "2026-10-31", quarterIndex: 63, user: 1 }],
                },
              },
            ],
          } as T;
        case "chat.history":
          return {
            sessionId: "57f9c026",
            messages: [
              { role: "assistant", timestamp: Date.UTC(2026, 9, 31, 1, 1), usage: { cost: { total: 0.121152 } } },
              { role: "custom", content: [{ type: "toolResult", text: "Exec denied (approval-timeout)" }] },
            ],
          } as T;
        default:
          throw new Error(`no ${method} here`);
      }
    },
  };
  return {
    claw,
    patches,
    runs,
    refuse: (words: string) => {
      refuse = words;
    },
    uncount: (reads: number) => {
      uncounted = reads;
    },
  };
}

function rig(g = gateway()) {
  const copies: Payload[] = [];
  const posted: Payload[] = [];
  const jobs = new Jobs(
    g.claw,
    {
      put: async (copy) => copies.push(copy),
      runs: async (runs) => posted.push(...runs),
    },
    () => ours,
    () => undefined,
    async () => undefined,
    () => BEAT_AT,
  );
  return { jobs, copies, posted, ...g };
}

const jobOf = (copy: Payload | undefined, id: string) => (copy?.["jobs"] as Payload[]).find((job) => job["job_id"] === id);

describe("the jobs kept in Chips", () => {
  it("send the copy and the week's runs at start, a heartbeat priced and a skill review's latest too", async () => {
    const r = rig();
    r.runs.set("5ecdc04c", [
      { jobId: "5ecdc04c", action: "finished", status: "ok", summary: "heartbeat completed", runAtMs: BEAT_AT, durationMs: 14_507 },
      { jobId: "5ecdc04c", action: "finished", status: "skipped", runAtMs: BEAT_AT - 3_600_000, durationMs: 0 },
    ]);
    r.runs.set("d9d49888", [
      {
        jobId: "d9d49888",
        action: "finished",
        status: "ok",
        summary: "NO_REPLY",
        runAtMs: Date.UTC(2026, 9, 31, 1, 0),
        durationMs: 1_812_800,
        sessionId: "57f9c026",
      },
    ]);
    await r.jobs.catchUp();
    assert.equal(r.copies.length, 1);
    assert.deepEqual(
      r.posted.map((run) => [run["job_id"], run["cost_usd"], run["quiet"], run["waited"], run["agent_id"]]),
      [
        ["heartbeat", 0.342151, undefined, undefined, undefined],
        ["skill-review", 0.121152, true, true, FEN],
      ],
    );
  });

  it("send a heartbeat as it finishes, quiet as its reply was, then the copy with its next run", async () => {
    const r = rig();
    await r.jobs.send();
    r.jobs.replied(BEAT_AT + 9000, false);
    r.jobs.cronEvent({ jobId: "5ecdc04c", action: "finished", status: "ok", runAtMs: BEAT_AT, durationMs: 14_507 });
    await new Promise((done) => setTimeout(done, 10));
    await r.jobs.settled();
    assert.deepEqual(r.posted.map((run) => [run["job_id"], run["quiet"], run["cost_usd"]]), [["heartbeat", true, 0.342151]]);
    assert.equal(r.copies.length, 2);
  });

  it("price a heartbeat again a little later when Home's usage hadn't counted it yet", async () => {
    const r = rig();
    await r.jobs.send();
    r.uncount(1);
    r.jobs.cronEvent({ jobId: "5ecdc04c", action: "finished", status: "ok", runAtMs: BEAT_AT, durationMs: 14_507 });
    await new Promise((done) => setTimeout(done, 10));
    await r.jobs.settled();
    assert.deepEqual(
      r.posted.map((run) => [run["run_id"], run["cost_usd"]]),
      [
        [`5ecdc04c:${BEAT_AT}`, undefined],
        [`5ecdc04c:${BEAT_AT}`, 0.342151],
      ],
    );
  });

  it("send a heartbeat without a cost when Home's usage never counts it", async () => {
    const r = rig();
    await r.jobs.send();
    // A check in a quarter the stand-in's usage hasn't counted: no cost the first time or the second.
    const late = BEAT_AT + 3_600_000;
    r.jobs.cronEvent({ jobId: "5ecdc04c", action: "finished", status: "ok", runAtMs: late, durationMs: 6000 });
    await new Promise((done) => setTimeout(done, 10));
    await r.jobs.settled();
    assert.deepEqual(
      r.posted.map((run) => [run["started_at"], run["cost_usd"]]),
      [[new Date(late).toISOString(), undefined]],
    );
  });

  it("let an agent's automation go by", async () => {
    const r = rig();
    await r.jobs.send();
    r.jobs.cronEvent({ jobId: "a1", action: "finished", status: "ok", runAtMs: BEAT_AT, durationMs: 1000 });
    await r.jobs.settled();
    assert.deepEqual(r.posted, []);
    assert.equal(r.copies.length, 1);
  });

  it("turn Dreaming off in memory-core's config, answered by the copy that shows it", async () => {
    const r = rig();
    const copy = await r.jobs.change({ change_id: "chg_1", job_id: DREAMING, on: false });
    assert.deepEqual(r.patches, [{ plugins: { entries: { "memory-core": { config: { dreaming: { enabled: false } } } } } }]);
    assert.deepEqual(
      [jobOf(copy, DREAMING)?.["on"], jobOf(copy, DREAMING)?.["every"], jobOf(copy, DREAMING)?.["next_at"]],
      [false, 1440, undefined],
    );
  });

  it("change how often the heartbeat runs, and turn the skill reviews off for every agent", async () => {
    const r = rig();
    await r.jobs.send();
    const faster = await r.jobs.change({ change_id: "chg_1", job_id: HEARTBEAT, on: true, every: 30 });
    assert.equal(jobOf(faster, HEARTBEAT)?.["every"], 30);
    const quiet = await r.jobs.change({ change_id: "chg_2", job_id: SKILLS, on: false });
    assert.deepEqual(r.patches.at(-1), { skills: { workshop: { autonomous: { mode: "off" } } } });
    assert.deepEqual([jobOf(quiet, SKILLS)?.["on"], jobOf(quiet, SKILLS)?.["for_agents"]], [false, undefined]);
    // Off, the heartbeat keeps the interval it ran at.
    const off = await r.jobs.change({ change_id: "chg_3", job_id: HEARTBEAT, on: false });
    assert.deepEqual([jobOf(off, HEARTBEAT)?.["on"], jobOf(off, HEARTBEAT)?.["every"]], [false, 30]);
  });

  it("refuse a change OpenClaw won't write, with its words and the copy as it is", async () => {
    const r = rig();
    r.refuse("config is read-only");
    await assert.rejects(r.jobs.change({ change_id: "chg_1", job_id: DREAMING, on: false }), (error: Error & { copy?: Payload }) => {
      assert.equal(error.message, "config is read-only");
      assert.equal(jobOf(error.copy, DREAMING)?.["on"], true);
      return true;
    });
  });
});
