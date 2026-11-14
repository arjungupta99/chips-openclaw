/**
 * A stop while the bridge is still starting, as `kill` or the service that keeps it running sends
 * one. The bridge is run as it runs for real, `src/main.ts` as a process of its own, and is stopped
 * in the one wait between writing bridge.pid and making the bridge: while it looks for git, here a
 * `git` that never answers. It ends itself, and takes bridge.pid with it. A stop used to be heard
 * only once the bridge was made: one before then ended the process by the signal, and left
 * bridge.pid behind.
 *
 * Nothing of this machine's is read or written: its home and its state are in a folder made for
 * the test, and Chips and OpenClaw are addresses nothing answers at.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

const here = join(import.meta.dirname, "..");

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A port nothing listens on now. */
const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

it("ends itself, and takes bridge.pid with it, when it is stopped while it looks for git", async () => {
  const home = mkdtempSync(join(tmpdir(), "chips-openclaw-stop-"));
  const state = join(home, "rig", "bridge");
  mkdirSync(state, { recursive: true });
  // `git` on its PATH says which process it is, in `asked`, and never answers.
  const bin = join(home, "bin");
  const asked = join(home, "asked");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh\necho $$ > "${asked}"\nexec sleep 60\n`);
  chmodSync(join(bin, "git"), 0o755);
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: here,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: home,
      CHIPS_OPENCLAW_DIR: join(home, "rig"),
      OPENCLAW_GATEWAY_TOKEN: "gw",
      OPENCLAW_URL: `ws://127.0.0.1:${await freePort()}`,
      CHIPS_URL: `http://127.0.0.1:${await freePort()}`,
      CHIPS_HARNESS_ID: "hrn_stop",
      CHIPS_HARNESS_TOKEN: "chips_hrn_stop",
      CHIPS_CONFIG_HOME: join(home, "config"),
      CHIPS_NO_KEYCHAIN: "true",
      CHIPS_KEEP: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let said = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => (said += String(data)));
  let over = false;
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    child.once("exit", (code, signal) => {
      over = true;
      done({ code, signal });
    });
  });
  try {
    // It has written bridge.pid and asked for git: the wait a stop wasn't heard in.
    for (const by = Date.now() + 15_000; !existsSync(asked); await new Promise((done) => setTimeout(done, 10))) {
      assert.ok(!over && Date.now() < by, `it never looked for git:\n${said}`);
    }
    assert.equal(readFileSync(join(state, "bridge.pid"), "utf8"), String(child.pid));
    child.kill("SIGTERM");
    assert.deepEqual(await ended, { code: 0, signal: null }, said);
    assert.ok(!existsSync(join(state, "bridge.pid")), "bridge.pid went with it");
  } finally {
    if (!over) child.kill("SIGKILL");
    await ended;
    // The `git` that never answers, which the bridge doesn't wait for.
    const git = existsSync(asked) ? Number(readFileSync(asked, "utf8")) : 0;
    if (git > 0 && alive(git)) process.kill(git, "SIGKILL");
    rmSync(home, { recursive: true, force: true });
  }
});
