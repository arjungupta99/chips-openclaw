/**
 * OpenClaw restarted from Chips (Chips ADR 0094). A person presses Restart on OpenClaw's page in
 * Chips, Chips sends `restart` down this bridge's socket — which stays up when OpenClaw does not —
 * and the bridge runs `scripts/restart.sh`: Colima's VM started again when it is dead, then the
 * gateway's container.
 *
 * Chips shows OpenClaw "Restarting" until the bridge's next word, so the bridge says nothing until
 * it knows how it went: the health watch's own words are held meanwhile (a gateway down for ten
 * seconds mid-restart is the restart, not news). Then it says fine, once the gateway has said
 * hello, or in a line what went wrong. A second ask while one runs is the same restart.
 */

/** How long the gateway has, after the script, to say hello before the restart counts as failed. */
export const UP_WITHIN_MS = 90_000;

export interface RestartAsk {
  readonly askedBy: string;
  readonly askedAt: string;
}

export interface RestartDeps {
  /** Run the restart script: its exit code, and the last of what it said. */
  readonly run: () => Promise<{ readonly code: number | null; readonly tail: string }>;
  /** Whether the gateway has said hello within the wait, now or later. */
  readonly up: (withinMs: number) => Promise<boolean>;
  /** Tell Chips how OpenClaw is: fine, or a line of trouble. */
  readonly say: (trouble: string | undefined) => Promise<void>;
  /** Hold the health watch's words while the restart runs, and let them go after. */
  readonly hold: (held: boolean) => void;
  readonly log: (message: string) => void;
}

export interface Restarter {
  readonly restart: (ask: RestartAsk) => Promise<void>;
  readonly running: () => boolean;
}

/** One line, as Chips takes it: up to 200 characters. */
function line(words: string): string {
  const one = words.replace(/\s+/g, " ").trim();
  return one.length <= 200 ? one : `${one.slice(0, 199)}…`;
}

/** Why the script failed, from the last thing it said. */
export function failedWords(code: number | null, tail: string): string {
  const last = tail
    .split("\n")
    .map((each) => each.trim())
    .filter((each) => each !== "")
    .at(-1);
  const why = last ?? (code === null ? "it was stopped" : `it exited ${code}`);
  return line(`Restart failed: ${why}`);
}

export function restarter(deps: RestartDeps): Restarter {
  let running = false;
  return {
    running: () => running,
    async restart(ask) {
      if (running) {
        deps.log(`bridge: restart asked by ${ask.askedBy} while one runs; it is the same restart`);
        return;
      }
      running = true;
      deps.hold(true);
      deps.log(`bridge: restart asked by ${ask.askedBy}; running scripts/restart.sh`);
      let trouble: string | undefined;
      try {
        const { code, tail } = await deps.run();
        if (code !== 0) trouble = failedWords(code, tail);
        else if (!(await deps.up(UP_WITHIN_MS))) trouble = "Restarted, but can't reach its gateway";
      } catch (error) {
        trouble = line(`Restart failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        running = false;
        deps.hold(false);
      }
      deps.log(trouble === undefined ? "bridge: restarted, and OpenClaw is up" : `bridge: ${trouble}`);
      try {
        await deps.say(trouble);
      } catch (error) {
        deps.log(`chips: could not say how the restart went: ${String(error)}`);
      }
    },
  };
}
