/**
 * What OpenClaw's own settings let through without asking (Chips ADR 0299), as a copy for the
 * harness's Permissions page in Chips: its exec policy (`tools.exec` in its config, then the host's
 * exec approvals and their allowlist) and, when the Codex plugin runs its turns, Codex's approval
 * policy. Read from the gateway (`config.get`, `exec.approvals.get`), never written. Chips decides
 * nothing from it, and only says it.
 *
 * OpenClaw's file tools have no approvals of their own, and neither does a command it is told to
 * run outside a room; this says only what its exec policy and Codex's say about commands.
 */

import type { ClawPort } from "./bridge.ts";

/** One thing the settings let through, ask about, or refuse, as Chips's `ownEntry` has it. */
export interface OwnEntry {
  readonly kind: "read" | "write" | "web" | "command" | "tool";
  readonly name: string;
  readonly words?: string[] | undefined;
  readonly raw?: string | undefined;
}

/** A mode a person may pick in Chips for its sessions, as Chips's `ownMode` has it (Chips ADR 0300). */
export interface OwnMode {
  readonly id: string;
  readonly name: string;
  readonly words?: string | undefined;
  readonly everything?: true | undefined;
}

/** The modes a person may pick, the one its sessions start in, and the one they run in. */
export interface OwnModes {
  readonly base: string;
  readonly running?: string | undefined;
  readonly offers: readonly OwnMode[];
}

/** The copy, as Chips's `ownRules` has it (SDK 1.0.11's `OwnRules`). */
export interface OwnRules {
  readonly read_from: string[];
  readonly note?: string | undefined;
  readonly mode?: string | undefined;
  readonly everything?: boolean | undefined;
  /** The modes a person may pick in Chips (Chips ADR 0300), as `modes.ts` writes them. */
  readonly modes?: OwnModes | undefined;
  readonly runs: OwnEntry[];
  readonly asks?: OwnEntry[] | undefined;
  readonly refuses?: OwnEntry[] | undefined;
}

type Payload = Readonly<Record<string, unknown>>;

/** What the gateway said: its config and its exec approvals, either missing where it wouldn't say. */
export interface ClawPolicy {
  readonly config?: Payload | undefined;
  readonly configPath?: string | undefined;
  readonly approvals?: { readonly path?: string | undefined; readonly file?: Payload | undefined } | undefined;
}

const MOST = 200;
const LONGEST_NAME = 120;
const LONGEST_RAW = 400;

const isRecord = (value: unknown): value is Payload => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const at = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((into, key) => (isRecord(into) ? into[key] : undefined), value);
const clip = (text: string, most: number) => (text.length > most ? text.slice(0, most) : text);

/**
 * How commands go, as one word: each runs, those on the allowlist run, each asks, OpenClaw's own
 * reviewer judges those off the allowlist (`auto`), or none runs.
 */
export type ExecWay = "full" | "allowlist" | "ask" | "auto" | "deny";

const EXEC_WAYS: readonly ExecWay[] = ["full", "allowlist", "ask", "auto", "deny"];
const isExecWay = (value: string | undefined): value is ExecWay => EXEC_WAYS.some((way) => way === value);

/**
 * How OpenClaw's exec tool treats a command: `tools.exec.mode` where its config says one; else its
 * `security` and `ask`, from the config, else the exec approvals' defaults. `ask: always` asks
 * whatever the allowlist says. `auto` runs what is on the allowlist and has OpenClaw's own reviewer
 * judge the rest, which asks a person only about one it can't clear.
 */
export function execWay(policy: ClawPolicy): ExecWay {
  const exec = at(policy.config, "tools", "exec");
  const defaults = at(policy.approvals?.file, "defaults");
  const mode = str(at(exec, "mode"));
  if (isExecWay(mode)) return mode;
  const security = str(at(exec, "security")) ?? str(at(defaults, "security")) ?? "allowlist";
  const ask = str(at(exec, "ask")) ?? str(at(defaults, "ask")) ?? "on-miss";
  if (security === "deny") return "deny";
  if (ask === "always") return "ask";
  return security === "full" ? "full" : "allowlist";
}

/** What a command nobody answers comes to: refused, unless the exec approvals say otherwise. */
function fallbackOf(policy: ClawPolicy): string {
  return str(at(policy.config, "tools", "exec", "askFallback")) ?? str(at(policy.approvals?.file, "defaults", "askFallback")) ?? "deny";
}

/** A program's own name from a pattern for its path: `git` for `/usr/bin/git`, `~/bin/deploy*` as it is. */
function programOf(pattern: string): string {
  const name = pattern.slice(pattern.lastIndexOf("/") + 1);
  return name === "" ? pattern : name;
}

/** The allowlist's entries, every agent's, each once: what runs without asking in `allowlist`. */
export function allowlisted(file: Payload | undefined): OwnEntry[] {
  const agents = at(file, "agents");
  if (!isRecord(agents)) return [];
  const seen = new Set<string>();
  const entries: OwnEntry[] = [];
  for (const agent of Object.values(agents)) {
    const list = at(agent, "allowlist");
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const pattern = str(at(item, "pattern"));
      if (pattern === undefined || seen.has(pattern)) continue;
      seen.add(pattern);
      const program = clip(programOf(pattern), LONGEST_NAME);
      const args = str(at(item, "argPattern"));
      const words = program.includes("*") ? undefined : [program];
      entries.push({
        kind: "command",
        name: "exec",
        ...(words === undefined ? {} : { words }),
        raw: clip(args === undefined ? pattern : `${pattern} ${args}`, LONGEST_RAW),
      });
    }
  }
  return entries.slice(0, MOST);
}

/** Codex's word for when it asks, where the Codex plugin is on: `on-request`, `never`. */
function codexPolicy(config: Payload | undefined): { readonly policy: string; readonly sandbox: string | undefined } | undefined {
  const codex = at(config, "plugins", "entries", "codex");
  if (at(codex, "enabled") !== true) return undefined;
  const server = at(codex, "config", "appServer");
  return { policy: str(at(server, "approvalPolicy")) ?? "on-request", sandbox: str(at(server, "sandbox")) };
}

const WAY_NAMES: Readonly<Record<ExecWay, string>> = { full: "Full", allowlist: "Allowlist", ask: "Ask", auto: "Auto", deny: "Deny" };

const SETTINGS_WORDS: Readonly<Record<ExecWay, string>> = {
  full: "Yours run every command without asking.",
  allowlist: "Yours run commands on its allowlist and ask before the rest.",
  ask: "Yours ask before every command.",
  auto: "Yours run commands on its allowlist, and OpenClaw asks about the rest only when one looks risky.",
  deny: "Yours run no commands.",
};

/**
 * What its settings say of commands, in a few words after "Runs as its settings say." on the Mode
 * picker's Default (Chips ADR 0300): "Yours ask before every command."
 */
export function settingsWords(policy: ClawPolicy): string {
  return SETTINGS_WORDS[execWay(policy)];
}

/** OpenClaw's copy, from what the gateway said of its config and its exec approvals. */
export function openclawOwnRules(policy: ClawPolicy): OwnRules {
  const way = execWay(policy);
  const codex = codexPolicy(policy.config);
  const read_from = [policy.configPath ?? "openclaw.json", ...(policy.approvals?.path === undefined ? [] : [policy.approvals.path])];
  const anyCommand: OwnEntry = { kind: "command", name: "exec", raw: `tools.exec: ${way}` };
  const codexRunsAll = codex !== undefined && (codex.policy === "never" || codex.policy === "on-failure");
  const notes = [
    way === "full"
      ? "Every command runs without asking."
      : way === "allowlist"
        ? "Commands on its allowlist run without asking; the rest ask."
        : way === "ask"
          ? "Every command asks."
          : way === "auto"
            ? "Commands on its allowlist run without asking; OpenClaw judges the rest and asks only about one it finds risky."
            : "It runs no commands.",
    way === "ask" || way === "allowlist" || way === "auto"
      ? fallbackOf(policy) === "deny"
        ? "One nobody answers is a no."
        : undefined
      : undefined,
    codex === undefined
      ? undefined
      : codexRunsAll
        ? "Codex runs its turns and never asks before a command."
        : `Codex runs its turns${codex.sandbox === "danger-full-access" ? " with full access inside the container" : ""}, and asks before each command.`,
  ].filter((note): note is string => note !== undefined);
  const mode = WAY_NAMES[way];
  if (way === "full" && (codex === undefined || codexRunsAll)) {
    return { read_from, note: notes.join(" "), mode, everything: true, runs: [] };
  }
  const runs =
    way === "full" || codexRunsAll ? [anyCommand] : way === "allowlist" || way === "auto" ? allowlisted(policy.approvals?.file) : [];
  return {
    read_from,
    note: notes.join(" "),
    mode,
    runs,
    ...(way === "deny" && !codexRunsAll ? { refuses: [anyCommand] } : {}),
  };
}

/** What the gateway says of its exec policy, each part missing where it won't say. */
export async function readPolicy(claw: ClawPort): Promise<ClawPolicy> {
  const [config, approvals] = await Promise.all([
    claw.request<{ config?: unknown; path?: unknown }>("config.get", {}).catch(() => undefined),
    claw.request<{ path?: unknown; file?: unknown }>("exec.approvals.get", {}).catch(() => undefined),
  ]);
  return {
    ...(isRecord(config?.config) ? { config: config.config } : {}),
    ...(str(config?.path) === undefined ? {} : { configPath: str(config?.path) }),
    ...(approvals === undefined
      ? {}
      : {
          approvals: {
            ...(str(approvals.path) === undefined ? {} : { path: str(approvals.path) }),
            ...(isRecord(approvals.file) ? { file: approvals.file } : {}),
          },
        }),
  };
}

/**
 * Send the copy where the connection takes it: SDK 1.0.10's `settings.ownRules`, which takes the
 * modes since 1.0.11. An older SDK has
 * no such method and an older Chips refuses it; either way nothing else changes.
 */
export async function sendOwnRules(settings: unknown, copy: OwnRules): Promise<boolean> {
  const send = (settings as { ownRules?: (copy: unknown) => Promise<unknown> } | undefined)?.ownRules;
  if (typeof send !== "function") return false;
  try {
    await send.call(settings, copy);
    return true;
  } catch {
    return false;
  }
}
