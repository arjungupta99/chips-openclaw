/** Chips's side of the bridge: a link from Chips's gallery taken up once (Chips ADR 0122), or the four lines. */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Joined, JoinOptions } from "@chips/harness";
import { JOIN_NAME, JOINED_FILE, loadConfig } from "../src/config.ts";

const LINK = "http://192.168.1.20:4431/j/sec_abc";
const JOINED: Joined = {
  url: "http://192.168.1.20:4431",
  harnessId: "hrn_joined",
  token: "chips_hrn_secret",
  spaceId: "spc_room",
  capabilities: ["autonomy"],
};

function sandbox(chipsEnv?: string): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), "bridge-config-"));
  mkdirSync(join(dir, "bridge"));
  if (chipsEnv !== undefined) writeFileSync(join(dir, "bridge", "chips.env"), chipsEnv);
  return { dir, env: { CHIPS_OPENCLAW_DIR: dir, OPENCLAW_GATEWAY_TOKEN: "gw", CHIPS_NO_KEYCHAIN: "true" } };
}

function player(answer: Joined = JOINED) {
  const asked: JoinOptions[] = [];
  return {
    asked,
    join: async (options: JoinOptions) => {
      asked.push(options);
      return answer;
    },
  };
}

describe("the bridge's Chips side", () => {
  it("takes up a link through join(), as OpenClaw, and writes down the address and never the key", async () => {
    const { dir, env } = sandbox();
    const played = player();
    const config = await loadConfig({ env, link: LINK, join: played.join });
    assert.equal(played.asked.length, 1);
    assert.equal(played.asked[0]?.link, LINK);
    assert.equal(played.asked[0]?.name, JOIN_NAME);
    assert.deepEqual(
      [config.chipsUrl, config.harnessId, config.harnessToken, config.spaceId],
      [JOINED.url, JOINED.harnessId, JOINED.token, JOINED.spaceId],
    );
    const written = readFileSync(join(dir, "bridge", JOINED_FILE), "utf8");
    assert.equal(written, `CHIPS_URL=${JOINED.url}\n`);
    assert.equal(statSync(join(dir, "bridge", JOINED_FILE)).mode & 0o777, 0o600);
  });

  it("starts again at the Chips it joined, the key found by join() with no link", async () => {
    const { env } = sandbox();
    await loadConfig({ env, link: LINK, join: player().join });
    const again = player();
    const config = await loadConfig({ env, join: again.join });
    assert.equal(again.asked[0]?.link, undefined);
    assert.equal(again.asked[0]?.url, JOINED.url);
    assert.equal(config.harnessToken, JOINED.token);
  });

  it("reads CHIPS_JOIN_LINK as the gallery's command sets it, and a link wins over chips.env's lines", async () => {
    const { env } = sandbox("CHIPS_URL=http://127.0.0.1:4436\nCHIPS_HARNESS_ID=hrn_scratch\nCHIPS_HARNESS_TOKEN=old\n");
    const played = player();
    const config = await loadConfig({ env: { ...env, CHIPS_JOIN_LINK: LINK }, join: played.join });
    assert.equal(played.asked[0]?.link, LINK);
    assert.equal(config.harnessId, JOINED.harnessId);
  });

  it("keeps the four lines as they were, and a token in the environment over a Chips joined before", async () => {
    const { dir, env } = sandbox("CHIPS_URL=http://127.0.0.1:4436/\nCHIPS_HARNESS_ID=hrn_scratch\nCHIPS_HARNESS_TOKEN=tok\n");
    const played = player();
    const scratch = await loadConfig({ env, join: played.join });
    assert.deepEqual([scratch.chipsUrl, scratch.harnessId, scratch.harnessToken], ["http://127.0.0.1:4436", "hrn_scratch", "tok"]);
    assert.equal(existsSync(join(dir, "bridge", JOINED_FILE)), false);

    // `bridge.sh start live` puts the token in the environment: that is the harness, whatever was joined.
    writeFileSync(join(dir, "bridge", JOINED_FILE), `CHIPS_URL=${JOINED.url}\n`);
    const live = await loadConfig({
      env: { ...env, CHIPS_URL: "http://127.0.0.1:4431", CHIPS_HARNESS_ID: "hrn_live", CHIPS_HARNESS_TOKEN: "live" },
      join: played.join,
    });
    assert.equal(live.harnessId, "hrn_live");
    assert.equal(played.asked.length, 0);
  });

  it("says how to connect when it was told nothing", async () => {
    const { env } = sandbox();
    await assert.rejects(loadConfig({ env, join: player().join }), /npm run connect -- <link>/);
  });
});
