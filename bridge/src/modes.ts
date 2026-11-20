/**
 * The mode a person picks in Chips for OpenClaw's sessions (Chips ADR 0300, addendum "Hermes,
 * OpenClaw and OpenCode get the Mode picker too"). OpenClaw keeps a mode on each session,
 * `permissionMode`: `read-only`, `guarded`, `workspace` or `full`, set with `sessions.patch` or
 * `sessions.create`, and none (`null`) for what its settings say. The SDK hands the pick over as
 * `chips.mode` while it holds, and says each change with a `mode` event, its end included (SDK
 * 1.0.11). Each of the bridge's own sessions goes into it: those it knows of when the pick changes,
 * and each one it opens. Which sessions are its own is the bridge's to say; Home, where the Main
 * agent speaks, is the person's own conversation on every channel, and is never one of them.
 *
 * What each mode does is from OpenClaw's docs: its gateway's code ships only in its Docker image. A
 * change applies to the session's next tool call, asks still open are cancelled (the bridge ends
 * their cards), Full access needs `operator.admin`, and an active CLI-backed run refuses the change.
 * A session that refused keeps its mode until it is tried again, at its next turn or the next
 * change, and the copy says the mode it runs in.
 */

import type { ClawPort } from "./bridge.ts";
import {
  allowlisted,
  type ClawPolicy,
  type OwnEntry,
  type OwnMode,
  type OwnRules,
  openclawOwnRules,
  readPolicy,
  settingsWords,
} from "./own-rules.ts";

/** A mode OpenClaw keeps on a session; `null` is none, and the session runs as its settings say. */
export type ClawMode = "read-only" | "guarded" | "workspace" | "full";

/** The mode its sessions start in, and go back to: what its settings say. */
export const BASE = "default";

/** The modes a person may pick besides Default, in OpenClaw's order, each sent as its id. */
const PICKED: readonly (OwnMode & { readonly id: ClawMode; readonly words: string })[] = [
  { id: "read-only", name: "Read only", words: "Reads its folder. Changes nothing and runs no commands." },
  { id: "guarded", name: "Ask me", words: "Edits in its folder. Commands not on its allowlist ask first." },
  { id: "workspace", name: "Auto-review", words: "OpenClaw judges each step and asks only when one looks risky." },
  { id: "full", name: "Full access", words: "Never asks. Any file, any command, the network.", everything: true },
];

const DEFAULT_NAME = "Default";

/** What the copy says of Home whenever it offers modes. */
export const HOME_NOTE = "The Main agent keeps its own mode in Home, your own conversation on every channel.";

/**
 * The modes a person may pick, Default first, its line saying what its settings say where they
 * were read: "Runs as its settings say. Yours ask before every command."
 */
export function offers(policy: ClawPolicy | undefined): OwnMode[] {
  const settings = policy?.config === undefined && policy?.approvals === undefined ? undefined : settingsWords(policy);
  const words = ["Runs as its settings say.", settings].filter((part) => part !== undefined).join(" ");
  return [{ id: BASE, name: DEFAULT_NAME, words }, ...PICKED];
}

/** The OpenClaw mode for a mode's id: none for Default, and for an id that isn't one of its. */
export function clawModeOf(id: string | undefined): ClawMode | null {
  return PICKED.find((each) => each.id === id)?.id ?? null;
}

/** A mode's id in Chips: Default for none. */
export const modeIdOf = (mode: ClawMode | null): string => mode ?? BASE;

/** A mode's name, as the picker says it. */
export const modeNameOf = (mode: ClawMode | null): string => PICKED.find((each) => each.id === mode)?.name ?? DEFAULT_NAME;

/**
 * The copy of what it runs on its own, for the mode its sessions run in: in Default, what its
 * settings let through (`openclawOwnRules`); in another, what that mode lets through, with the
 * allowlist where the mode reads it. Each says what Home keeps, and the modes a person may pick.
 * Nothing where the gateway said nothing of its settings.
 */
export function modedOwnRules(policy: ClawPolicy, running: ClawMode | null): OwnRules | undefined {
  if (policy.config === undefined && policy.approvals === undefined) return undefined;
  const modes = { base: BASE, running: modeIdOf(running), offers: offers(policy) };
  const name = modeNameOf(running);
  if (running === null) {
    const settings = openclawOwnRules(policy);
    const note = [settings.note, HOME_NOTE].filter((each) => each !== undefined && each !== "").join(" ");
    return { ...settings, note, mode: name, modes };
  }
  const raw = `permissionMode: ${running}`;
  const read_from = [
    "the mode Chips puts its OpenClaw sessions in",
    ...(running === "guarded" && policy.approvals?.path !== undefined ? [policy.approvals.path] : []),
  ];
  const note = `${PICKED.find((each) => each.id === running)?.words ?? ""} ${HOME_NOTE}`.trim();
  const write: OwnEntry = { kind: "write", name: "write", raw };
  const command: OwnEntry = { kind: "command", name: "exec", raw };
  switch (running) {
    case "read-only":
      return { read_from, note, mode: name, modes, runs: [], refuses: [write, command] };
    case "guarded":
      return { read_from, note, mode: name, modes, runs: [write, ...allowlisted(policy.approvals?.file)] };
    case "workspace":
      return { read_from, note, mode: name, modes, runs: [] };
    case "full":
      return { read_from, note, mode: name, modes, everything: true, runs: [] };
  }
}

/** What the bridge needs of Chips for the modes: the pick while it holds, and where the copy goes. */
export interface ModesChips {
  /** The pick while it holds (SDK 1.0.11's `chips.mode`); nothing while none holds. */
  readonly mode: { readonly id: string; readonly until?: string | undefined } | undefined;
  putOwnRules(copy: OwnRules): Promise<boolean>;
}

/** How a session's put went: moved from the mode it was in, set from one not known, already in it, or kept. */
export type Put = "moved" | "set" | "same" | "kept";

type Payload = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Payload => typeof value === "object" && value !== null && !Array.isArray(value);

/** A session's mode as OpenClaw says it on a row or an entry: none where it says none. */
function rowMode(row: Payload): ClawMode | null {
  const mode = row["permissionMode"];
  return typeof mode === "string" ? clawModeOf(mode) : null;
}

/**
 * The bridge's own sessions and the mode each is in, as far as it knows: from OpenClaw's list at
 * start, each one it opened, and each change it made. One at a time, so a change and a turn's
 * session never patch the same session at once.
 */
export class Modes {
  private policy: ClawPolicy = {};
  private readonly modeOf = new Map<string, ClawMode | null>();
  /** Why each session that refused the mode in force kept its own, while it does. */
  private readonly kept = new Map<string, string>();
  /** A pick that isn't one of OpenClaw's, said once. */
  private unknownSaid: string | undefined;
  private work: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly claw: ClawPort,
    private readonly chips: ModesChips,
    private readonly log: (message: string) => void,
  ) {}

  /** The pick while it holds, as Chips says it. */
  get picked(): ModesChips["mode"] {
    return this.chips.mode;
  }

  /** The mode in force: the pick while it holds, where it is one of OpenClaw's; else its settings'. */
  inForce(): ClawMode | null {
    const id = this.chips.mode?.id;
    const mode = clawModeOf(id);
    if (id !== undefined && id !== BASE && mode === null && this.unknownSaid !== id) {
      this.unknownSaid = id;
      this.log(`openclaw: the mode picked in Chips, ${id}, isn't one of OpenClaw's, so its sessions run as its settings say`);
    }
    return mode;
  }

  /** What a session of its own is opened with: the mode in force, where there is one. */
  opening(): { readonly permissionMode?: ClawMode } {
    const mode = this.inForce();
    return mode === null ? {} : { permissionMode: mode };
  }

  /**
   * A session of its own opened (`sessions.create`), sent `sent`: in the mode OpenClaw's answer
   * says where it says one (a session it had already is adopted as it was), else in `sent`.
   */
  opened(key: string, answer: unknown, sent: ClawMode | null): void {
    const entry = isRecord(answer) ? answer["entry"] : undefined;
    this.modeOf.set(key, isRecord(entry) && "permissionMode" in entry ? rowMode(entry) : sent);
  }

  /** Its own sessions OpenClaw keeps, each in the mode it says (`sessions.list`): at start. */
  async readSessions(own: (key: string) => boolean): Promise<void> {
    let listed: unknown;
    try {
      listed = await this.claw.request("sessions.list", {});
    } catch (error) {
      this.log(`openclaw: its sessions not listed, so each goes into its mode as it is next used: ${String(error)}`);
      return;
    }
    const rows = isRecord(listed) && Array.isArray(listed["sessions"]) ? (listed["sessions"] as unknown[]) : [];
    for (const row of rows) {
      const key = isRecord(row) ? row["key"] : undefined;
      if (typeof key === "string" && isRecord(row) && own(key)) this.modeOf.set(key, rowMode(row));
    }
  }

  /** The sessions it knows the mode of. */
  known(): string[] {
    return [...this.modeOf.keys()];
  }

  /** An OpenClaw agent deleted: its sessions with it. */
  forgetAgent(agent: string): void {
    for (const key of [...this.modeOf.keys()]) {
      if (!key.startsWith(`agent:${agent}:`)) continue;
      this.modeOf.delete(key);
      this.kept.delete(key);
    }
  }

  /**
   * A session of its own into the mode in force, where it is in another or in one not known. One
   * OpenClaw refuses keeps its mode, and why is logged, once for each reason.
   */
  put(key: string): Promise<Put> {
    const done = this.work.then(() => this.putNow(key));
    this.work = done.catch(() => undefined);
    return done;
  }

  private async putNow(key: string): Promise<Put> {
    const target = this.inForce();
    const known = this.modeOf.has(key);
    const had = this.modeOf.get(key) ?? null;
    if (known && had === target) {
      this.kept.delete(key);
      return "same";
    }
    try {
      await this.claw.request("sessions.patch", { key, permissionMode: target });
    } catch (error) {
      const why = String(error);
      if (this.kept.get(key) !== why) {
        this.log(`openclaw: ${key} keeps ${known ? modeNameOf(had) : "its mode"}, not ${modeNameOf(target)}: ${why}`);
      }
      this.kept.set(key, why);
      return "kept";
    }
    this.modeOf.set(key, target);
    this.kept.delete(key);
    return known ? "moved" : "set";
  }

  /** Whether a session refused the mode in force, and keeps its own until it is tried again. */
  keeps(key: string): boolean {
    return this.kept.has(key);
  }

  /** The mode its sessions run in: the one in force, unless one of them kept another. */
  running(): ClawMode | null {
    for (const key of this.kept.keys()) if (this.modeOf.has(key)) return this.modeOf.get(key) ?? null;
    return this.inForce();
  }

  /** What its settings say, read from the gateway (`config.get`, `exec.approvals.get`). */
  async readPolicy(): Promise<void> {
    this.policy = await readPolicy(this.claw);
  }

  /** The copy for the mode its sessions run in; nothing where the gateway said nothing of its settings. */
  copy(): OwnRules | undefined {
    return modedOwnRules(this.policy, this.running());
  }

  /** The copy sent to Chips; one the same as the last is not sent again (the SDK's). */
  async send(): Promise<void> {
    const copy = this.copy();
    if (copy !== undefined) await this.chips.putOwnRules(copy);
  }
}
