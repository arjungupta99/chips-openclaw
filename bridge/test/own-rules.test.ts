/**
 * What OpenClaw's own settings let through, as the copy for the harness's Permissions page in Chips
 * (Chips ADR 0299): its exec policy and Codex's approval policy, read from the gateway, never written.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ClawPort } from "../src/bridge.ts";
import { allowlisted, execWay, openclawOwnRules, readPolicy, sendOwnRules, settingsWords } from "../src/own-rules.ts";

/** The rig's config, as `scripts/up.sh` writes it on a first run. */
const RIG = {
  tools: { exec: { host: "gateway", mode: "ask" } },
  plugins: {
    entries: {
      codex: { enabled: true, config: { appServer: { approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "danger-full-access" } } },
    },
  },
};

describe("OpenClaw's exec policy", () => {
  it("reads how commands go from the mode, else security and ask, else the exec approvals' defaults", () => {
    assert.equal(execWay({ config: RIG }), "ask");
    assert.equal(execWay({ config: { tools: { exec: { security: "full", ask: "off" } } } }), "full");
    assert.equal(execWay({ config: { tools: { exec: { security: "allowlist", ask: "always" } } } }), "ask");
    assert.equal(execWay({ config: {}, approvals: { file: { version: 1, defaults: { security: "deny" } } } }), "deny");
    assert.equal(execWay({}), "allowlist");
  });

  it("reads tools.exec.mode auto as OpenClaw's own reviewer, not as the allowlist its security says", () => {
    assert.equal(execWay({ config: { tools: { exec: { mode: "auto" } } }, approvals: { file: { version: 1, defaults: { security: "allowlist" } } } }), "auto");
    // A mode it doesn't know is read from its security and ask, as before.
    assert.equal(execWay({ config: { tools: { exec: { mode: "later", security: "full", ask: "off" } } } }), "full");
  });

  it("says in a few words what its settings let commands do, for the Mode picker's Default", () => {
    assert.equal(settingsWords({ config: RIG }), "Yours ask before every command.");
    assert.equal(settingsWords({ config: { tools: { exec: { mode: "full" } } } }), "Yours run every command without asking.");
    assert.equal(settingsWords({ config: { tools: { exec: { mode: "deny" } } } }), "Yours run no commands.");
    assert.equal(settingsWords({}), "Yours run commands on its allowlist and ask before the rest.");
    assert.equal(
      settingsWords({ config: { tools: { exec: { mode: "auto" } } } }),
      "Yours run commands on its allowlist, and OpenClaw asks about the rest only when one looks risky.",
    );
  });

  it("names each program on any agent's allowlist once", () => {
    const file = {
      version: 1,
      agents: {
        main: { allowlist: [{ pattern: "/usr/bin/git" }, { pattern: "/opt/homebrew/bin/rg", argPattern: "--files" }] },
        nova: { allowlist: [{ pattern: "/usr/bin/git" }, { pattern: "~/bin/deploy*" }] },
      },
    };
    assert.deepEqual(allowlisted(file), [
      { kind: "command", name: "exec", words: ["git"], raw: "/usr/bin/git" },
      { kind: "command", name: "exec", words: ["rg"], raw: "/opt/homebrew/bin/rg --files" },
      { kind: "command", name: "exec", raw: "~/bin/deploy*" },
    ]);
  });
});

describe("OpenClaw's copy", () => {
  it("says the rig's: every command asks, no answer is a no, and Codex asks before each command", () => {
    const copy = openclawOwnRules({ config: RIG, configPath: "/home/node/.openclaw/openclaw.json" });
    assert.deepEqual(copy.read_from, ["/home/node/.openclaw/openclaw.json"]);
    assert.equal(copy.mode, "Ask");
    assert.deepEqual(copy.runs, []);
    assert.equal(
      copy.note,
      "Every command asks. One nobody answers is a no. Codex runs its turns with full access inside the container, and asks before each command.",
    );
    assert.equal(copy.everything, undefined);
  });

  it("says the allowlist runs, everything runs when nothing asks, and nothing runs when it is denied", () => {
    const allowlist = openclawOwnRules({
      config: { tools: { exec: { security: "allowlist", ask: "on-miss" } } },
      approvals: { path: "/home/node/.openclaw/exec-approvals.json", file: { version: 1, agents: { main: { allowlist: [{ pattern: "/usr/bin/ls" }] } } } },
    });
    assert.deepEqual(allowlist.read_from, ["openclaw.json", "/home/node/.openclaw/exec-approvals.json"]);
    assert.deepEqual(allowlist.runs.map((entry) => entry.words), [["ls"]]);
    assert.equal(openclawOwnRules({ config: { tools: { exec: { mode: "full" } } } }).everything, true);
    // Full exec, but Codex still asks before its own commands: any command, and not everything.
    const full = openclawOwnRules({ config: { ...RIG, tools: { exec: { mode: "full" } } } });
    assert.equal(full.everything, undefined);
    assert.deepEqual(full.runs.map((entry) => entry.raw), ["tools.exec: full"]);
    const denied = openclawOwnRules({ config: { tools: { exec: { mode: "deny" } } } });
    assert.deepEqual(denied.refuses?.map((entry) => entry.kind), ["command"]);
    const never = openclawOwnRules({
      config: { ...RIG, plugins: { entries: { codex: { enabled: true, config: { appServer: { approvalPolicy: "never" } } } } } },
    });
    assert.deepEqual(never.runs.map((entry) => entry.words), [undefined]);
  });

  it("says auto runs the allowlist and OpenClaw judges the rest", () => {
    const auto = openclawOwnRules({
      config: { tools: { exec: { mode: "auto" } } },
      approvals: { file: { version: 1, agents: { main: { allowlist: [{ pattern: "/usr/bin/git" }] } } } },
    });
    assert.equal(auto.mode, "Auto");
    assert.deepEqual(auto.runs.map((entry) => entry.words), [["git"]]);
    assert.equal(
      auto.note,
      "Commands on its allowlist run without asking; OpenClaw judges the rest and asks only about one it finds risky. One nobody answers is a no.",
    );
  });
});

describe("reading it from the gateway", () => {
  it("asks for the config and the exec approvals, and leaves out what it won't say", async () => {
    const asked: string[] = [];
    const claw: ClawPort = {
      request: async <T>(method: string) => {
        asked.push(method);
        if (method === "config.get") return { config: RIG, hash: "h1", path: "/home/node/.openclaw/openclaw.json" } as T;
        throw new Error("unknown method");
      },
    };
    const policy = await readPolicy(claw);
    assert.deepEqual(asked.sort(), ["config.get", "exec.approvals.get"]);
    assert.deepEqual(policy, { config: RIG, configPath: "/home/node/.openclaw/openclaw.json" });
  });

  it("sends where the connection takes it, and does nothing on an older SDK or a refusal", async () => {
    const copy = openclawOwnRules({ config: RIG });
    const sent: unknown[] = [];
    assert.equal(await sendOwnRules({ ownRules: (body: unknown) => Promise.resolve(sent.push(body)) }, copy), true);
    assert.deepEqual(sent, [copy]);
    assert.equal(await sendOwnRules({}, copy), false);
    assert.equal(await sendOwnRules({ ownRules: () => Promise.reject(new Error("refused")) }, copy), false);
  });
});
