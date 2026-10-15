/**
 * Where the bridge's two sides are, and where it keeps what it keeps. Everything it writes is under
 * ~/chips-openclaw/bridge, which the uninstall deletes.
 *
 * Chips's side is one of two things. A link a person made in Chips's gallery (`connect <link>`, or
 * CHIPS_JOIN_LINK), taken up through the SDK's `join()` (Chips ADR 0122): the key it is handed is
 * kept where the SDK keeps keys, the login keychain here, and only the address is written down
 * (`joined.env`), so the next start finds the key again. Or the four lines `chips connect custom`
 * prints (CHIPS_URL, CHIPS_HARNESS_ID, CHIPS_HARNESS_TOKEN, CHIPS_SPACE_ID), from the environment or
 * from `chips.env` beside the bridge's state. OpenClaw's side is the gateway on loopback and the
 * token `scripts/up.sh` made.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Joined, type JoinOptions, join as joinChips } from "@chips/harness";

export interface Config {
  readonly chipsUrl: string;
  readonly harnessId: string;
  readonly harnessToken: string;
  /** The direct room Chips opened when the harness was added, if it opened one. */
  readonly spaceId: string | undefined;
  readonly gatewayUrl: string;
  readonly gatewayToken: string;
  /**
   * The one OpenClaw agent to serve, when set (`OPENCLAW_AGENT`); unset, every agent the gateway
   * lists is one of this harness's agents in Chips, all on the one token.
   */
  readonly agent: string | undefined;
  /** Everything OpenClaw and the bridge keep (`$CHIPS_OPENCLAW_DIR`): OpenClaw's state is under it. */
  readonly sandbox: string;
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

/** What the bridge is called in Chips when it joins, unless CHIPS_HARNESS_NAME says otherwise. */
export const JOIN_NAME = "OpenClaw";

/** Where the address of the Chips it joined is written: never its key, which the SDK keeps. */
export const JOINED_FILE = "joined.env";

type ChipsSide = Pick<Config, "chipsUrl" | "harnessId" | "harnessToken" | "spaceId">;

export interface LoadOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** `connect <link>`: a link a person made in Chips, which wins over everything kept. */
  readonly link?: string | undefined;
  /** The SDK's `join()`, unless a test plays it. */
  readonly join?: (options: JoinOptions) => Promise<Joined>;
  readonly log?: (message: string) => void;
}

function given(values: Record<string, string | undefined>): ChipsSide {
  return {
    chipsUrl: required(values, "CHIPS_URL").replace(/\/$/, ""),
    harnessId: required(values, "CHIPS_HARNESS_ID"),
    harnessToken: required(values, "CHIPS_HARNESS_TOKEN"),
    spaceId: values["CHIPS_SPACE_ID"] || undefined,
  };
}

/**
 * Chips's side: a link first; then a token the environment was given (`bridge.sh start live`);
 * then the Chips this bridge joined before, whose key `join()` finds again (and asks for with a
 * code when it is gone); then `chips.env`'s four lines.
 */
async function chipsSide(
  files: Record<string, string>,
  env: NodeJS.ProcessEnv,
  stateDir: string,
  options: LoadOptions,
): Promise<ChipsSide> {
  const values = { ...files, ...env };
  const link = options.link ?? (env["CHIPS_JOIN_LINK"] || undefined);
  const joined = readEnvFile(join(stateDir, JOINED_FILE))["CHIPS_URL"];
  if (link === undefined && (env["CHIPS_HARNESS_TOKEN"] || joined === undefined)) {
    if (values["CHIPS_HARNESS_TOKEN"] === undefined && values["CHIPS_URL"] === undefined) {
      throw new Error(
        "Chips is not set: run `npm run connect -- <link>` with a link from Chips (Add an agent → OpenClaw), or put chips connect custom's four lines in chips.env beside the bridge's state.",
      );
    }
    return given(values);
  }
  const answer = await (options.join ?? joinChips)({
    ...(link === undefined ? { url: joined } : { link }),
    name: values["CHIPS_HARNESS_NAME"] || JOIN_NAME,
    software: "OpenClaw",
    env: values,
  });
  writeFileSync(join(stateDir, JOINED_FILE), `CHIPS_URL=${answer.url}\n`, { mode: 0o600 });
  if (link !== undefined) options.log?.(`chips: joined ${answer.url} as harness ${answer.harnessId}`);
  return { chipsUrl: answer.url, harnessId: answer.harnessId, harnessToken: answer.token, spaceId: answer.spaceId };
}

export async function loadConfig(options: LoadOptions = {}): Promise<Config> {
  const env = options.env ?? process.env;
  const sandbox = env["CHIPS_OPENCLAW_DIR"] ?? join(homedir(), "chips-openclaw");
  const stateDir = join(sandbox, "bridge");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const files = { ...readEnvFile(join(sandbox, ".env")), ...readEnvFile(join(stateDir, "chips.env")) };
  const values = { ...files, ...env };
  return {
    ...(await chipsSide(files, env, stateDir, options)),
    gatewayUrl: values["OPENCLAW_URL"] ?? "ws://127.0.0.1:18789",
    gatewayToken: required(values, "OPENCLAW_GATEWAY_TOKEN"),
    agent: values["OPENCLAW_AGENT"] || undefined,
    sandbox,
    stateDir,
  };
}
