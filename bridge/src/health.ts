/**
 * How OpenClaw is, as Chips is told it (Chips ADR 0083): the gateway unreachable for long enough
 * is trouble people see — OpenClaw's face marked, and why — and back is fine again. A blip shorter
 * than the wait is not trouble.
 *
 * The first time the gateway answers, this process says fine whatever it said before, because
 * Chips may still hold what an earlier process said: a bridge restarted inside Chips's grace for a
 * reconnect keeps its predecessor's trouble until something says otherwise (30 September 2026,
 * OpenClaw marked "Can't reach its gateway" for as long as 4431 ran after the gateway came back).
 */

/** OpenClaw down for this long is trouble. */
export const DOWN_FOR_MS = 10_000;

export interface Health {
  /** The gateway said hello. */
  readonly up: () => void;
  /** The gateway's socket closed, or a connect failed. */
  readonly down: () => void;
  /**
   * Hold what it would tell Chips, while a restart asked from Chips runs (Chips ADR 0094): Chips
   * shows "Restarting" until the bridge's next word, and the restart says that word itself. It
   * keeps watching meanwhile, so what it says after is about the gateway as it is then.
   */
  readonly hold: (held: boolean) => void;
}

export function health(
  say: (trouble: string | undefined) => void,
  log: (message: string) => void,
  wait: number = DOWN_FOR_MS,
): Health {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let troubled = false;
  let told = false;
  let held = false;
  const tell = (trouble: string | undefined, words: string): void => {
    log(held ? `${words.replace(/; telling Chips$/, "")} (a restart is running, so Chips is not told)` : words);
    if (!held) say(trouble);
  };
  return {
    up: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (told && !troubled) return;
      const words = troubled ? "bridge: OpenClaw is back; telling Chips" : "bridge: OpenClaw is up; telling Chips";
      troubled = false;
      told = true;
      tell(undefined, words);
    },
    down: () => {
      if (timer !== undefined || troubled) return;
      timer = setTimeout(() => {
        timer = undefined;
        troubled = true;
        told = true;
        tell("Can't reach its gateway", `bridge: OpenClaw's gateway has been unreachable for ${wait / 1000} s; telling Chips`);
      }, wait);
      timer.unref?.();
    },
    hold: (on) => {
      held = on;
    },
  };
}
