/**
 * Where the bridge's two sides are, and where it keeps what it keeps. Everything it writes is under
 * ~/chips-openclaw/bridge, which the uninstall deletes.
 *
 * Chips's side is the four lines `chips connect custom` prints (CHIPS_URL, CHIPS_HARNESS_ID,
 * CHIPS_HARNESS_TOKEN, CHIPS_SPACE_ID), from the environment or from `chips.env` beside the bridge's
 * state. OpenClaw's side is the gateway on loopback and the token `scripts/up.sh` made.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  readonly chipsUrl: string;
  readonly harnessId: string;
  readonly harnessToken: string;
  /** The direct room Chips opened when the harness was added, if it opened one. */
  readonly spaceId: string | undefined;
  readonly gatewayUrl: string;
  readonly gatewayToken: string;
  /** The OpenClaw agent this Chips harness is. One agent, one harness (the plan's Phase 4). */
  readonly agent: string;
  readonly stateDir: string;
}

/** `KEY=value` lines, as `.env` files and `chips connect` write them. */
function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const entries = readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()] as const;
    });
  return Object.fromEntries(entries);
}

function required(values: Record<string, string | undefined>, name: string): string {
  const value = values[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set: put it in the environment or in chips.env beside the bridge's state.`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const sandbox = env["CHIPS_OPENCLAW_DIR"] ?? join(homedir(), "chips-openclaw");
  const stateDir = join(sandbox, "bridge");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const values = { ...readEnvFile(join(sandbox, ".env")), ...readEnvFile(join(stateDir, "chips.env")), ...env };
  return {
    chipsUrl: required(values, "CHIPS_URL").replace(/\/$/, ""),
    harnessId: required(values, "CHIPS_HARNESS_ID"),
    harnessToken: required(values, "CHIPS_HARNESS_TOKEN"),
    spaceId: values["CHIPS_SPACE_ID"] || undefined,
    gatewayUrl: values["OPENCLAW_URL"] ?? "ws://127.0.0.1:18789",
    gatewayToken: required(values, "OPENCLAW_GATEWAY_TOKEN"),
    agent: values["OPENCLAW_AGENT"] ?? "main",
    stateDir,
  };
}
