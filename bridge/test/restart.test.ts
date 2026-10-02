/** OpenClaw restarted from Chips (Chips ADR 0094): the script, then a word, and only one at a time. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { health } from "../src/health.ts";
import { failedWords, restarter } from "../src/restart.ts";

const ASK = { askedBy: "usr_arjun", askedAt: "2026-10-02T15:31:00.000Z" };

function fakes(over: { code?: number | null; tail?: string; up?: boolean; throws?: boolean } = {}) {
  const said: (string | undefined)[] = [];
  const holds: boolean[] = [];
  let runs = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const restart = restarter({
    run: async () => {
      runs += 1;
      await gate;
      if (over.throws) throw new Error("bash: not found");
      return { code: over.code === undefined ? 0 : over.code, tail: over.tail ?? "" };
    },
    up: async () => over.up ?? true,
    say: async (trouble) => {
      said.push(trouble);
    },
    hold: (held) => holds.push(held),
    log: () => undefined,
  });
  return { restart, said, holds, runs: () => runs, release };
}

describe("a restart asked from Chips", () => {
  it("runs the script once, holds the health watch meanwhile, and says fine once the gateway is up", async () => {
    const f = fakes();
    const first = f.restart.restart(ASK);
    // Asked again while it runs: the same restart.
    await f.restart.restart(ASK);
    assert.equal(f.restart.running(), true);
    assert.deepEqual(f.said, []);
    f.release();
    await first;
    assert.equal(f.runs(), 1);
    assert.deepEqual(f.holds, [true, false]);
    assert.deepEqual(f.said, [undefined]);
    assert.equal(f.restart.running(), false);
  });

  it("says what went wrong: the script's last line, a gateway that never answers, a script that cannot run", async () => {
    const failed = fakes({ code: 1, tail: "  starting colima\nFATA[0042] error starting vm: timeout\n" });
    failed.release();
    await failed.restart.restart(ASK);
    assert.deepEqual(failed.said, ["Restart failed: FATA[0042] error starting vm: timeout"]);

    const silent = fakes({ up: false });
    silent.release();
    await silent.restart.restart(ASK);
    assert.deepEqual(silent.said, ["Restarted, but can't reach its gateway"]);

    const broken = fakes({ throws: true });
    broken.release();
    await broken.restart.restart(ASK);
    assert.deepEqual(broken.said, ["Restart failed: bash: not found"]);
    assert.deepEqual(broken.holds, [true, false]);
  });

  it("keeps a failure to one line Chips takes", () => {
    assert.equal(failedWords(null, ""), "Restart failed: it was stopped");
    assert.equal(failedWords(2, "\n\n"), "Restart failed: it exited 2");
    assert.equal(failedWords(1, "x".repeat(400)).length, 200);
  });
});

describe("the health watch during a restart", () => {
  it("keeps watching but tells Chips nothing while held, then speaks for itself again", async () => {
    const said: (string | undefined)[] = [];
    const openClaw = health((trouble) => said.push(trouble), () => undefined, 10);
    openClaw.up();
    openClaw.hold(true);
    openClaw.down();
    await new Promise((resolve) => setTimeout(resolve, 30));
    openClaw.up();
    assert.deepEqual(said, [undefined]);
    openClaw.hold(false);
    openClaw.down();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(said, [undefined, "Can't reach its gateway"]);
  });
});
