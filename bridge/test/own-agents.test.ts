/**
 * The folders of the OpenClaw agents the bridge makes, laid out as the container's state is
 * mounted on the Mac: begun with the primary agent's persona, and nothing of a made one's lost.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { rootsFor } from "../src/media.ts";
import { isMadeAgent, madeAgentId, workspacesIn } from "../src/own-agents.ts";

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "bridge-own-"));
  mkdirSync(join(sandbox, "state", "workspace"), { recursive: true });
  for (const name of ["AGENTS.md", "SOUL.md", "USER.md", "IDENTITY.md", "MEMORY.md"]) {
    writeFileSync(join(sandbox, "state", "workspace", name), `main's ${name}`);
  }
});

afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

describe("the OpenClaw agents the bridge makes", () => {
  it("names each for the Chips id it was made for, and knows its own by the name", () => {
    assert.equal(madeAgentId("spc_01K4ZQPX000000000000000099"), "chips-01k4zqpx000000000000000099");
    assert.equal(madeAgentId("evt_01K4ZQPX0000000000000000N1"), "chips-01k4zqpx0000000000000000n1");
    assert.equal(isMadeAgent("chips-01k4zqpx000000000000000099"), true);
    assert.equal(isMadeAgent("main"), false);
    assert.equal(isMadeAgent(undefined), false);
  });

  it("begins a folder with the primary agent's persona, not its name or its memory", async () => {
    const workspaces = workspacesIn(rootsFor(sandbox));
    assert.equal(workspaces.of("chips-01k4"), "/home/node/.openclaw/chips/chips-01k4");
    await workspaces.seed("chips-01k4");
    const folder = join(sandbox, "state", "chips", "chips-01k4");
    for (const name of ["AGENTS.md", "SOUL.md", "USER.md"]) {
      assert.equal(readFileSync(join(folder, name), "utf8"), `main's ${name}`);
    }
    assert.equal(existsSync(join(folder, "IDENTITY.md")), false);
    assert.equal(existsSync(join(folder, "MEMORY.md")), false);
  });

  it("keeps what a made agent's folder has when it is begun again", async () => {
    const workspaces = workspacesIn(rootsFor(sandbox));
    const folder = join(sandbox, "state", "chips", "chips-01k4");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "SOUL.md"), "its own soul");
    await workspaces.seed("chips-01k4");
    assert.equal(readFileSync(join(folder, "SOUL.md"), "utf8"), "its own soul");
    assert.equal(readFileSync(join(folder, "USER.md"), "utf8"), "main's USER.md");
  });

  it("begins a folder with what there is when the primary agent lacks a file", async () => {
    rmSync(join(sandbox, "state", "workspace", "USER.md"));
    await workspacesIn(rootsFor(sandbox)).seed("chips-01k4");
    assert.equal(existsSync(join(sandbox, "state", "chips", "chips-01k4", "USER.md")), false);
  });

  it("begins a copy's folder as a copy of its original's, everything in it, over what is there (Chips ADR 0087)", async () => {
    const workspaces = workspacesIn(rootsFor(sandbox));
    const original = join(sandbox, "state", "chips", "chips-01k4");
    const copy = join(sandbox, "state", "chips", "chips-01k5");
    mkdirSync(join(original, "memory"), { recursive: true });
    writeFileSync(join(original, "MEMORY.md"), "heron");
    writeFileSync(join(original, "memory", "2026-10-22.md"), "made a game");
    writeFileSync(join(original, "game.html"), "<p>game</p>");
    mkdirSync(copy, { recursive: true });
    writeFileSync(join(copy, "MEMORY.md"), "half a copy");
    assert.equal(await workspaces.copy(workspaces.of("chips-01k4"), "chips-01k5"), true);
    assert.equal(readFileSync(join(copy, "MEMORY.md"), "utf8"), "heron");
    assert.equal(readFileSync(join(copy, "memory", "2026-10-22.md"), "utf8"), "made a game");
    assert.equal(readFileSync(join(copy, "game.html"), "utf8"), "<p>game</p>");
    // A folder OpenClaw names that is not there is nothing to copy.
    assert.equal(await workspaces.copy("/home/node/.openclaw/workspace-gone", "chips-01k6"), false);
    assert.equal(existsSync(join(sandbox, "state", "chips", "chips-01k6")), false);
  });

  it("takes the first-run ritual out of a made agent's folder, and leaves the rest", async () => {
    const workspaces = workspacesIn(rootsFor(sandbox));
    await workspaces.seed("chips-01k4");
    const folder = join(sandbox, "state", "chips", "chips-01k4");
    writeFileSync(join(folder, "BOOTSTRAP.md"), "who am I?");
    await workspaces.settle("chips-01k4");
    assert.equal(existsSync(join(folder, "BOOTSTRAP.md")), false);
    assert.equal(existsSync(join(folder, "SOUL.md")), true);
    await workspaces.settle("chips-01k4");
  });

  it("clears the empty folders a deleted agent leaves, and keeps one with anything in it", async () => {
    const workspaces = workspacesIn(rootsFor(sandbox));
    const folder = join(sandbox, "state", "chips", "chips-01k4");
    const state = join(sandbox, "state", "agents", "chips-01k4");
    mkdirSync(folder, { recursive: true });
    mkdirSync(state, { recursive: true });
    await workspaces.clear("chips-01k4");
    assert.equal(existsSync(folder), false);
    assert.equal(existsSync(state), false);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "kept.md"), "not OpenClaw's to lose");
    await workspaces.clear("chips-01k4");
    assert.equal(existsSync(join(folder, "kept.md")), true);
    await workspaces.clear("chips-01k9");
  });
});
