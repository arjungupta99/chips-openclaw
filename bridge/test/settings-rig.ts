/**
 * What the bridge's process does with a person's change from Chips, for the tests: the SDK's
 * `Settings` hears the frame, the bridge (or one of its modules) makes the change and hands back the
 * copy, and the SDK sends the answer, or the refusal. Each `PUT` it makes is kept as `[whose, body]`.
 */

import { Settings, type SettingsHandlers } from "@chips/harness";

/** Whose a `PUT` is: the agent's id, or `harness` for the harness's own set of files. */
export function whoseOf(path: string): string {
  const [, , kind, id] = path.split("/");
  return kind === "harnesses" ? "harness" : decodeURIComponent(id ?? "");
}

/** The SDK's settings over a `PUT` that keeps each body, for the harness `harnessId`. */
export function settingsFor(
  keep: (whose: string, body: Record<string, unknown>) => void,
  handlers: SettingsHandlers,
  harnessId = "hrn_01K4ZQPX000000000000000004",
): Settings {
  return new Settings(
    async (path, body) => {
      keep(whoseOf(path), { ...body });
      return {};
    },
    () => harnessId,
    handlers,
  );
}
