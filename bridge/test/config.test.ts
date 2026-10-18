/** Chips's side of the bridge: a link from Chips's gallery taken up once (Chips ADR 0122), or the four lines. */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Joined, JoinOptions } from "@chipschat/harness";
import { createServer } from "node:net";
import { JOIN_NAME, JOINED_FILE, loadConfig, reachable, SetupError, STILL_GOOD } from "../src/config.ts";

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

/** OpenClaw's gateway answering, as a test says. */
const up = async () => true;

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
    const config = await loadConfig({ env, link: LINK, join: played.join, reach: up });
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
    await loadConfig({ env, link: LINK, join: player().join, reach: up });
    const again = player();
    const config = await loadConfig({ env, join: again.join, reach: up });
    assert.equal(again.asked[0]?.link, undefined);
    assert.equal(again.asked[0]?.url, JOINED.url);
    assert.equal(config.harnessToken, JOINED.token);
  });

  it("reads CHIPS_JOIN_LINK as the gallery's command sets it, and a link wins over chips.env's lines", async () => {
    const { env } = sandbox("CHIPS_URL=http://127.0.0.1:4436\nCHIPS_HARNESS_ID=hrn_scratch\nCHIPS_HARNESS_TOKEN=old\n");
    const played = player();
    const config = await loadConfig({ env: { ...env, CHIPS_JOIN_LINK: LINK }, join: played.join, reach: up });
    assert.equal(played.asked[0]?.link, LINK);
    assert.equal(config.harnessId, JOINED.harnessId);
  });

  it("keeps the four lines as they were, and a token in the environment over a Chips joined before", async () => {
    const { dir, env } = sandbox("CHIPS_URL=http://127.0.0.1:4436/\nCHIPS_HARNESS_ID=hrn_scratch\nCHIPS_HARNESS_TOKEN=tok\n");
    const played = player();
    const scratch = await loadConfig({ env, join: played.join, reach: up });
    assert.deepEqual([scratch.chipsUrl, scratch.harnessId, scratch.harnessToken], ["http://127.0.0.1:4436", "hrn_scratch", "tok"]);
    assert.equal(existsSync(join(dir, "bridge", JOINED_FILE)), false);

    // `bridge.sh start live` puts the token in the environment: that is the harness, whatever was joined.
    writeFileSync(join(dir, "bridge", JOINED_FILE), `CHIPS_URL=${JOINED.url}\n`);
    const live = await loadConfig({
      env: { ...env, CHIPS_URL: "http://127.0.0.1:4431", CHIPS_HARNESS_ID: "hrn_live", CHIPS_HARNESS_TOKEN: "live" },
      join: played.join,
      reach: up,
    });
    assert.equal(live.harnessId, "hrn_live");
    assert.equal(played.asked.length, 0);
  });

  it("says how to connect when it was told nothing", async () => {
    const { env } = sandbox();
    await assert.rejects(loadConfig({ env, join: player().join, reach: up }), /npm run connect -- <link>/);
  });

  it("checks OpenClaw's side before it takes up a link: the gateway's token, and the gateway answering", async () => {
    const { env } = sandbox();
    const played = player();
    const tokenless = { ...env, OPENCLAW_GATEWAY_TOKEN: "…" };
    await assert.rejects(
      loadConfig({ env: tokenless, link: LINK, join: played.join, reach: up }),
      (error: unknown) => error instanceof SetupError && /OPENCLAW_GATEWAY_TOKEN isn't set/.test(error.message) && error.message.includes(STILL_GOOD),
    );
    await assert.rejects(
      loadConfig({ env, link: LINK, join: played.join, reach: async () => false }),
      (error: unknown) => error instanceof SetupError && /gateway isn't answering at ws:\/\/127\.0\.0\.1:18789/.test(error.message),
    );
    // Neither took the link up.
    assert.equal(played.asked.length, 0);
  });

  it("has a hello to say only when it came in by join(), not on a token", async () => {
    const { env } = sandbox();
    const joined = await loadConfig({ env, link: LINK, join: player().join, reach: up });
    assert.equal(typeof joined.hello, "function");
    const live = await loadConfig({
      env: { ...env, CHIPS_URL: "http://127.0.0.1:4431", CHIPS_HARNESS_ID: "hrn_live", CHIPS_HARNESS_TOKEN: "live" },
      join: player().join,
      reach: up,
    });
    assert.equal(live.hello, undefined);
  });

  it("knows whether something answers at the gateway's address", async () => {
    const server = createServer().listen(0, "127.0.0.1");
    await new Promise((done) => server.once("listening", done));
    const { port } = server.address() as { port: number };
    assert.equal(await reachable(`ws://127.0.0.1:${port}`), true);
    await new Promise((done) => server.close(done));
    assert.equal(await reachable(`ws://127.0.0.1:${port}`), false);
  });
});

// Chips's setup audit HS-7: OpenClaw installed on this machine, with no container and no up.sh.
describe("a person's own OpenClaw", () => {
  /** A home with OpenClaw's own config in it, and no test rig. */
  function own(openclaw?: unknown, dotEnv?: string): { home: string; env: NodeJS.ProcessEnv } {
    const home = mkdtempSync(join(tmpdir(), "bridge-own-"));
    if (openclaw !== undefined) {
      mkdirSync(join(home, ".openclaw"));
      writeFileSync(join(home, ".openclaw", "openclaw.json"), typeof openclaw === "string" ? openclaw : JSON.stringify(openclaw));
      if (dotEnv !== undefined) writeFileSync(join(home, ".openclaw", ".env"), dotEnv);
    }
    return { home, env: { HOME: home, CHIPS_NO_KEYCHAIN: "true" } };
  }

  it("finds its gateway's port and token in its own config, its files at their own paths, and keeps its state apart", async () => {
    const { home, env } = own({ gateway: { port: 19001, auth: { mode: "token", token: "tok-own" } } });
    const config = await loadConfig({ env, link: LINK, join: player().join, reach: up });
    assert.equal(config.own, true);
    assert.equal(config.gatewayUrl, "ws://127.0.0.1:19001");
    assert.equal(config.gatewayToken, "tok-own");
    assert.equal(config.sandbox, undefined);
    assert.equal(config.stateDir, join(home, ".chips-openclaw"));
    assert.deepEqual(config.roots, {
      gatewayStateDir: join(home, ".openclaw"),
      gatewayWorkspaceDir: join(home, ".openclaw", "workspace"),
      stateDir: join(home, ".openclaw"),
    });
  });

  it("reads a token named as an environment variable from the environment, else OpenClaw's .env, in a file with comments", async () => {
    const ref = `{
      // as \`openclaw onboard\` may leave it
      "gateway": { "auth": { "token": { "source": "env", "provider": "default", "id": "MY_GW_TOKEN" } }, },
      "agents": { "defaults": { "workspace": "~/claw-work" } },
    }`;
    const fromFile = own(ref, 'MY_GW_TOKEN="tok-file"\n');
    const config = await loadConfig({ env: fromFile.env, link: LINK, join: player().join, reach: up });
    assert.equal(config.gatewayToken, "tok-file");
    assert.equal(config.gatewayUrl, "ws://127.0.0.1:18789");
    assert.equal(config.roots.gatewayWorkspaceDir, join(fromFile.home, "claw-work"));
    const fromEnv = own(ref, "MY_GW_TOKEN=tok-file\n");
    const again = await loadConfig({ env: { ...fromEnv.env, MY_GW_TOKEN: "tok-env" }, link: LINK, join: player().join, reach: up });
    assert.equal(again.gatewayToken, "tok-env");
  });

  it("says what to do, and keeps the link good, when OpenClaw isn't set up, has no token, or its gateway isn't answering", async () => {
    const played = player();
    const fails = async (env: NodeJS.ProcessEnv, says: RegExp, reach = up) =>
      assert.rejects(
        loadConfig({ env, link: LINK, join: played.join, reach }),
        (error: unknown) => error instanceof SetupError && says.test(error.message) && error.message.includes(STILL_GOOD),
      );
    await fails(own().env, /OpenClaw isn't set up on this machine: there is no .*openclaw\.json\. Install OpenClaw \(openclaw\.ai\) and run `openclaw onboard`/);
    await fails(own({ gateway: { auth: { token: { source: "env", id: "NOPE" } } } }).env, /gateway token isn't in .*openclaw\.json \(gateway\.auth\.token\) or \$NOPE: run `openclaw onboard`/);
    await fails(own({ gateway: { auth: { token: "t" } } }).env, /gateway isn't answering at ws:\/\/127\.0\.0\.1:18789: start it \(`openclaw gateway`\)/, async () => false);
    assert.equal(played.asked.length, 0, "no link taken up");
  });

  it("is the test rig instead when its .env is there", async () => {
    const { home, env } = own({ gateway: { auth: { token: "own" } } });
    mkdirSync(join(home, "chips-openclaw"));
    writeFileSync(join(home, "chips-openclaw", ".env"), "OPENCLAW_GATEWAY_TOKEN=rig\n");
    const config = await loadConfig({ env, link: LINK, join: player().join, reach: up });
    assert.deepEqual([config.own, config.gatewayToken, config.sandbox], [false, "rig", join(home, "chips-openclaw")]);
  });
});
