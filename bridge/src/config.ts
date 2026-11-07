/**
 * Where the bridge's two sides are, and where it keeps what it keeps: under `~/Chips/.bridges` (Chips
 * ADR 0283), in `openclaw-rig/bridge` for the test rig, which the uninstall deletes, and in `openclaw`
 * beside a person's own OpenClaw.
 *
 * Chips's side is one of two things. A link a person made in Chips's gallery (`connect <link>`, or
 * CHIPS_JOIN_LINK), taken up through the SDK's `join()` (Chips ADR 0122): the key it is handed is
 * kept where the SDK keeps keys, the login keychain here, and only the address is written down
 * (`joined.env`), so the next start finds the key again. Or the four lines `chips connect custom`
 * prints (CHIPS_URL, CHIPS_HARNESS_ID, CHIPS_HARNESS_TOKEN, CHIPS_SPACE_ID), from the environment or
 * from `chips.env` beside the bridge's state.
 *
 * OpenClaw's side is one of two too. The test rig: OpenClaw in the container `scripts/up.sh` runs,
 * its token in `~/Chips/.bridges/openclaw-rig/.env`, its paths the container's. Or a person's own
 * OpenClaw on this machine (Chips's setup audit HS-7): its gateway's port and token read from its own
 * `~/.openclaw/openclaw.json` (a token there, or named as an environment variable, found in the
 * environment or OpenClaw's own `.env`), its paths this machine's, and the bridge's state in
 * `~/Chips/.bridges/openclaw`. The rig is the one when `CHIPS_OPENCLAW_DIR` is set or its `.env` is there.
 *
 * Until 1.0.10 the rig was `~/chips-openclaw` and the bridge's own state `~/.chips-openclaw`. A rig
 * still there is used there until its scripts move it; the state is moved the first time 1.0.10 starts.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { connect as tcp } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { filledIn, helloOnce, type Joined, type JoinOptions, join as joinChips, reportStep, type StopWords } from "@chipschat/harness";
import { type MediaRoots, rootsFor } from "./media.ts";

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
  /** The test rig's folder (`$CHIPS_OPENCLAW_DIR`), OpenClaw's state under it; none for a person's own. */
  readonly sandbox: string | undefined;
  /** Where the bridge keeps what it keeps. */
  readonly stateDir: string;
  /** OpenClaw's files, as the gateway names them and on this machine. */
  readonly roots: MediaRoots;
  /** A person's own OpenClaw on this machine, not the test rig's container. */
  readonly own: boolean;
  /**
   * Its first words in the room it joined, once (the SDK's `helloOnce`), when it came in by
   * `join()`: the card that followed its link waits for them. A bridge started on a token has none.
   */
  readonly hello: ((say: (spaceId: string) => Promise<unknown>) => Promise<boolean>) | undefined;
}

/**
 * Something to put right before the bridge starts, said so a person can: the message in a terminal,
 * `words` on Chips for Mac's sheet (Chips ADR 0218, phase 5).
 */
export class SetupError extends Error {
  override readonly name = "SetupError";
  constructor(
    message: string,
    readonly words: StopWords = {},
  ) {
    super(message);
  }
}

/** The port in a gateway's address, as a person reads it. */
const portOf = (url: string): string => {
  try {
    return new URL(url).port || "80";
  } catch {
    return url;
  }
};

export const STILL_GOOD = "The link is still good: run the same command again once that's done.";

/** `KEY=value` lines, as `.env` files and `chips connect` write them. */
function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const entries = readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const at = line.indexOf("=");
      // A value may be quoted, as `.env` files allow.
      return [line.slice(0, at).trim().replace(/^export\s+/, ""), line.slice(at + 1).trim().replace(/^(["'])(.*)\1$/, "$2")] as const;
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

/**
 * What the bridge asks Chips to let it do when it joins with a code: what Chips's OpenClaw card
 * grants, and a copy of one of its agents for a person's Fork (`forks`, Chips ADR 0087). A link
 * carries what the person chose instead.
 */
export const WANTS = [
  "agents",
  "new_spaces",
  "new_agents",
  "forks",
  "restarts",
  "context_files",
  "models",
  "heartbeats",
  "context_windows",
  "jobs",
] as const;

/** Where the address of the Chips it joined is written: never its key, which the SDK keeps. */
export const JOINED_FILE = "joined.env";

type ChipsSide = Pick<Config, "chipsUrl" | "harnessId" | "harnessToken" | "spaceId" | "hello">;

export interface LoadOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** `connect <link>`: a link a person made in Chips, which wins over everything kept. */
  readonly link?: string | undefined;
  /** The SDK's `join()`, unless a test plays it. */
  readonly join?: (options: JoinOptions) => Promise<Joined>;
  /** Whether OpenClaw's gateway answers at its address, unless a test says. */
  readonly reach?: (url: string) => Promise<boolean>;
  readonly log?: (message: string) => void;
}

/** Whether something answers at a `ws:` or `http:` address: a connection, and nothing sent. */
export function reachable(url: string, ms = 1500): Promise<boolean> {
  const parsed = new URL(url.replace(/^ws/, "http"));
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  return new Promise((resolve) => {
    const socket = tcp({ host: parsed.hostname, port });
    const done = (answered: boolean) => {
      socket.destroy();
      resolve(answered);
    };
    socket.setTimeout(ms, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function given(values: Record<string, string | undefined>): ChipsSide {
  return {
    chipsUrl: required(values, "CHIPS_URL").replace(/\/$/, ""),
    harnessId: required(values, "CHIPS_HARNESS_ID"),
    harnessToken: required(values, "CHIPS_HARNESS_TOKEN"),
    spaceId: values["CHIPS_SPACE_ID"] || undefined,
    hello: undefined,
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
  const name = values["CHIPS_HARNESS_NAME"] || JOIN_NAME;
  const answer = await (options.join ?? joinChips)({
    ...(link === undefined ? { url: joined } : { link }),
    name,
    software: "OpenClaw",
    wants: WANTS,
    env: values,
  });
  writeFileSync(join(stateDir, JOINED_FILE), `CHIPS_URL=${answer.url}\n`, { mode: 0o600 });
  if (link !== undefined) options.log?.(`chips: joined ${answer.url} as harness ${answer.harnessId}`);
  return {
    chipsUrl: answer.url,
    harnessId: answer.harnessId,
    harnessToken: answer.token,
    spaceId: answer.spaceId,
    hello: (say) => helloOnce(answer, { name, env: values, say }),
  };
}

/** JSON, with the comments and trailing commas a person may leave in a hand-edited file. */
export function parseLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    let out = "";
    let quote: string | undefined;
    for (let at = 0; at < text.length; at += 1) {
      const char = text[at] ?? "";
      if (quote !== undefined) {
        out += char;
        if (char === "\\") out += text[++at] ?? "";
        else if (char === quote) quote = undefined;
      } else if (char === '"' || char === "'") {
        quote = char;
        out += char;
      } else if (char === "/" && text[at + 1] === "/") {
        while (at < text.length && text[at] !== "\n") at += 1;
      } else if (char === "/" && text[at + 1] === "*") {
        at = text.indexOf("*/", at + 2);
        if (at < 0) break;
        at += 1;
      } else out += char;
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
  }
}

const tildeIn = (home: string) => (path: string) => (path.startsWith("~/") ? join(home, path.slice(2)) : path);

/** A person's own OpenClaw: where its config says its gateway is, and its token. */
function ownGateway(
  values: Record<string, string | undefined>,
  userHome: string,
  still: string,
): { url: string; token: string; roots: MediaRoots } {
  const tilde = tildeIn(userHome);
  const home = tilde(values["OPENCLAW_STATE_DIR"] || join(userHome, ".openclaw"));
  const path = tilde(values["OPENCLAW_CONFIG_PATH"] || join(home, "openclaw.json"));
  if (!existsSync(path)) {
    throw new SetupError(
      `OpenClaw isn't set up on this machine: there is no ${path}. Install OpenClaw (openclaw.ai) and run \`openclaw onboard\`.${still}`,
      {
        detail: "OpenClaw isn't set up here",
        says: "OpenClaw isn't set up on this Mac.",
        doing: "Install OpenClaw (openclaw.ai), run this in a terminal, then try again.",
        copy: "openclaw onboard",
      },
    );
  }
  let config: Record<string, unknown>;
  try {
    config = parseLoose(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new SetupError(
      `${path} couldn't be read (${(error as Error).message}): set OPENCLAW_GATEWAY_TOKEN, and OPENCLAW_URL if its gateway isn't on 18789.${still}`,
      {
        detail: "Its config couldn't be read",
        says: `${path} couldn't be read.`,
        doing: "Set OPENCLAW_GATEWAY_TOKEN, and OPENCLAW_URL if its gateway isn't on 18789.",
      },
    );
  }
  const gateway = (config["gateway"] ?? {}) as Record<string, unknown>;
  const auth = (gateway["auth"] ?? {}) as Record<string, unknown>;
  const port = typeof gateway["port"] === "number" ? gateway["port"] : 18789;
  // A token in the config, or the name of the environment variable it is in, as OpenClaw allows.
  const said = auth["token"];
  const named = typeof said === "object" && said !== null ? (said as Record<string, unknown>) : undefined;
  const fromEnv = named?.["source"] === "env" && typeof named["id"] === "string" ? named["id"] : undefined;
  const token =
    values["OPENCLAW_GATEWAY_TOKEN"] ??
    (typeof said === "string" ? said : fromEnv === undefined ? undefined : (values[fromEnv] ?? readEnvFile(join(home, ".env"))[fromEnv]));
  if (!filledIn(token)) {
    throw new SetupError(
      `OpenClaw's gateway token isn't in ${path} (gateway.auth.token)${fromEnv === undefined ? "" : ` or $${fromEnv}`}: run \`openclaw onboard\`, or set OPENCLAW_GATEWAY_TOKEN.${still}`,
      {
        detail: "No gateway token",
        says: "OpenClaw's gateway has no token here.",
        doing: "Run this in a terminal, then try again.",
        copy: "openclaw onboard",
      },
    );
  }
  const agents = (config["agents"] ?? {}) as Record<string, unknown>;
  const defaults = (agents["defaults"] ?? {}) as Record<string, unknown>;
  const workspace = typeof defaults["workspace"] === "string" ? tilde(defaults["workspace"]) : join(home, "workspace");
  return {
    url: values["OPENCLAW_URL"] ?? `ws://127.0.0.1:${port}`,
    token,
    // The gateway runs on this machine: its paths are this machine's.
    roots: { gatewayStateDir: home, gatewayWorkspaceDir: workspace, stateDir: home },
  };
}

/** Where the bridge keeps things (Chips ADR 0283), and where it kept them until 1.0.10. */
export function placesOf(home: string) {
  return {
    state: join(home, "Chips", ".bridges", "openclaw"),
    rig: join(home, "Chips", ".bridges", "openclaw-rig"),
    oldState: join(home, ".chips-openclaw"),
    oldRig: join(home, "chips-openclaw"),
  };
}

/**
 * The bridge's own state, beside a person's own OpenClaw: `~/Chips/.bridges/openclaw`, moved there
 * from `~/.chips-openclaw` the first time, by a rename. Where both are there, or the rename fails,
 * the old one is left, said, and used.
 */
function ownState(places: ReturnType<typeof placesOf>, log?: (message: string) => void): string {
  if (!existsSync(places.oldState)) return places.state;
  if (existsSync(places.state)) {
    log?.(`~/.chips-openclaw was left where it is: ~/Chips/.bridges/openclaw is there already`);
    return places.state;
  }
  try {
    mkdirSync(dirname(dirname(places.state)), { recursive: true });
    mkdirSync(dirname(places.state), { recursive: true, mode: 0o700 });
    renameSync(places.oldState, places.state);
    log?.("moved ~/.chips-openclaw to ~/Chips/.bridges/openclaw");
    return places.state;
  } catch (error) {
    log?.(`~/.chips-openclaw couldn't be moved to ~/Chips/.bridges/openclaw, so it is used where it is: ${(error as Error).message}`);
    return places.oldState;
  }
}

export async function loadConfig(options: LoadOptions = {}): Promise<Config> {
  const env = options.env ?? process.env;
  const userHome = env["HOME"] || homedir();
  const places = placesOf(userHome);
  // The rig where it is named, else in ~/Chips, or where it was until its scripts move it.
  const rigDir =
    env["CHIPS_OPENCLAW_DIR"] ??
    (existsSync(join(places.oldRig, ".env")) && !existsSync(join(places.rig, ".env")) ? places.oldRig : places.rig);
  // The test rig when it is named or its `.env` is there; else a person's own OpenClaw.
  const own = env["CHIPS_OPENCLAW_DIR"] === undefined && !existsSync(join(rigDir, ".env"));
  const sandbox = own ? undefined : rigDir;
  const stateDir = own ? ownState(places, options.log) : join(rigDir, "bridge");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const files = { ...(own ? {} : readEnvFile(join(rigDir, ".env"))), ...readEnvFile(join(stateDir, "chips.env")) };
  const values = { ...files, ...env };
  // OpenClaw's side, checked before Chips's: a link works once, and is spent by the join.
  const link = options.link ?? (env["CHIPS_JOIN_LINK"] || undefined);
  const still = link === undefined ? "" : ` ${STILL_GOOD}`;
  if (link !== undefined) reportStep("checking", { detail: "Looking for its gateway" }, env);
  let gatewayUrl: string;
  let gatewayToken: string | undefined;
  let roots: MediaRoots;
  if (own) {
    ({ url: gatewayUrl, token: gatewayToken, roots } = ownGateway(values, userHome, still));
  } else {
    gatewayUrl = values["OPENCLAW_URL"] ?? "ws://127.0.0.1:18789";
    gatewayToken = values["OPENCLAW_GATEWAY_TOKEN"];
    roots = rootsFor(rigDir);
    if (!filledIn(gatewayToken)) {
      throw new SetupError(
        `OPENCLAW_GATEWAY_TOKEN isn't set: scripts/up.sh makes it, in ${join(rigDir, ".env")}, when it first starts OpenClaw.${still}`,
      );
    }
  }
  if (link !== undefined && !(await (options.reach ?? reachable)(gatewayUrl))) {
    throw new SetupError(
      `OpenClaw's gateway isn't answering at ${gatewayUrl}: ${own ? "start it (`openclaw gateway`)" : "start OpenClaw with scripts/up.sh"}.${still}`,
      {
        detail: `Nothing answers on port ${portOf(gatewayUrl)}`,
        says: "OpenClaw's gateway isn't running.",
        ...(own
          ? { doing: "Start it in a terminal, then try again.", copy: "openclaw gateway" }
          : { doing: "Start OpenClaw with scripts/up.sh, then try again." }),
      },
    );
  }
  if (link !== undefined) reportStep("checked", { detail: `Its gateway answers on port ${portOf(gatewayUrl)}` }, env);
  return {
    ...(await chipsSide(files, env, stateDir, options)),
    gatewayUrl,
    gatewayToken: gatewayToken as string,
    agent: values["OPENCLAW_AGENT"] || undefined,
    sandbox,
    stateDir,
    roots,
    own,
  };
}
