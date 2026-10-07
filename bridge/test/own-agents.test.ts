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
});
