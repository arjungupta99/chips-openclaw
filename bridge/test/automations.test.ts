/**
 * OpenClaw's automations as the bridge reads them (Chips ADR 0157): a job's run session, the job a
 * `cron` event carries, a `current` job's commit, and the @ for the person a job is for. Shapes as
 * seen on scratch, 13 October 2026.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Automations, committedOf, forPerson, jobOf, jobOfSession, mentionsAny } from "../src/automations.ts";

const JOB = "3d340e0f-3477-4799-b510-9b598721a3a9";
const ROOM_KEY = "agent:chips-01m4cm9dmhk0801md4c1g6zxrw:chips-spc_01m4cm9dmhk0801md4c1g6zxrw";
const ARJUN = { id: "usr_01K4ZQPX000000000000000003", handle: "@Arjun" };

describe("OpenClaw's automations, as the bridge reads them", () => {
  it("finds the job a run's session is of, and none in any other session", () => {
    assert.equal(jobOfSession(`agent:chips-01m4cm9dmhk0801md4c1g6zxrw:cron:${JOB}:run:2911e849-3f56-4aa9-b06a-dcc1d5b01eb0`), JOB);
    assert.equal(jobOfSession(`agent:main:cron:${JOB}`), JOB);
    assert.equal(jobOfSession(ROOM_KEY), undefined);
    assert.equal(jobOfSession("agent:main:main"), undefined);
  });

  it("reads the job a cron event carries by the session that made it, and nothing without one", () => {
    const owner = { agentId: "chips-01m4cm9dmhk0801md4c1g6zxrw", sessionKey: ROOM_KEY, accountId: "default" };
    // An isolated job keeps only its owner; a current one is bound to the conversation too.
    assert.deepEqual(jobOf({ id: JOB, name: "Isolated check", owner, sessionTarget: "isolated" }), { id: JOB, name: "Isolated check", sessionKey: ROOM_KEY });
    assert.deepEqual(jobOf({ id: JOB, sessionKey: ROOM_KEY, sessionTarget: "current" }), { id: JOB, name: undefined, sessionKey: ROOM_KEY });
    // OpenClaw's own heartbeat monitor has neither.
    assert.equal(jobOf({ id: "5ecdc04c", name: "heartbeat-main", sessionTarget: "main" }), undefined);
    assert.equal(jobOf(undefined), undefined);
  });

  it("reads a current job's commit from its provenance, and no other message", () => {
    const made = { kind: "cron", jobId: JOB, runId: `cron:${JOB}:1791885238801` };
    const text = [{ type: "text", text: "Reminder: stretch." }];
    assert.deepEqual(committedOf({ role: "assistant", content: text, model: "automation-result", openclawAutomation: made }), {
      jobId: JOB,
      runId: `cron:${JOB}:1791885238801`,
    });
    assert.equal(committedOf({ role: "assistant", content: text }), undefined);
    assert.equal(committedOf({ role: "user", content: text, openclawAutomation: made }), undefined);
    assert.equal(committedOf({ role: "assistant", content: text, openclawAutomation: { ...made, kind: "hook" } }), undefined);
  });

  it("@s the person first unless the words @ somebody in the room, by a whole handle", () => {
    assert.equal(forPerson("Reminder: stretch.", ARJUN, ["@Arjun", "@OpenClaw3"]), "@Arjun Reminder: stretch.");
    assert.equal(forPerson("@arjun time to stretch.", ARJUN, []), "@arjun time to stretch.");
    assert.equal(forPerson("Kit, @Kit, stretch.", ARJUN, ["@Arjun", "@Kit"]), "Kit, @Kit, stretch.");
    // A longer handle, or an address, is not an @ of Arjun.
    assert.equal(mentionsAny("@Arjuna stretch", ["@Arjun"]), false);
    assert.equal(mentionsAny("mail me at me@Arjun.dev", ["@Arjun"]), false);
    assert.equal(mentionsAny("(@Arjun) stretch", ["@Arjun"]), true);
    // Nobody to @: the words as they are.
    assert.equal(forPerson("Reminder: stretch.", undefined, ["@Arjun", "@Kit"]), "Reminder: stretch.");
  });

  it("keeps who each job is for in its state, once, and lets it go with the job", () => {
    const dir = mkdtempSync(join(tmpdir(), "automations-"));
    const file = join(dir, "automations.json");
    try {
      const kept = new Automations(file);
      kept.learn({ id: JOB, name: "Stretch reminder", sessionKey: ROOM_KEY }, ARJUN);
      // Heard again with somebody else's turn going: the job is still Arjun's.
      kept.learn({ id: JOB, name: "Stretch reminder", sessionKey: ROOM_KEY }, { id: "usr_kit", handle: "@Kit" });
      assert.deepEqual(new Automations(file).askerOf(JOB), ARJUN);
      kept.forget(JOB);
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {});
      assert.equal(kept.job(JOB), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts with nobody kept from a state it cannot read, and says so", () => {
    const dir = mkdtempSync(join(tmpdir(), "automations-"));
    const file = join(dir, "automations.json");
    const said: string[] = [];
    try {
      writeFileSync(file, "{not json");
      assert.equal(new Automations(file, (line) => said.push(line)).askerOf(JOB), undefined);
      assert.equal(said.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says a job's commit is its run's answer once, after the run said it", () => {
    const jobs = new Automations();
    assert.equal(jobs.takeSaid(JOB), false);
    jobs.said(JOB);
    assert.equal(jobs.takeSaid(JOB), true);
    assert.equal(jobs.takeSaid(JOB), false);
  });
});
