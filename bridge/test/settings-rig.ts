/**
 * What the bridge's process does with a person's change from Chips, for the tests: the SDK's
 * `Settings` hears the frame, the bridge (or one of its modules) makes the change and hands back the
 * copy, and the SDK sends the answer, or the refusal. Each `PUT` it makes is kept as `[whose, body]`.
 */

import { Settings, type SettingsHandlers } from "@chipschat/harness";

/** Whose a `PUT` is: the agent's id, or `harness` for the harness's own set of files. */
export function whoseOf(path: string): string {
  const [, , kind, id] = path.split("/");
  return kind === "harnesses" ? "harness" : decodeURIComponent(id ?? "");
}

/** Who asks for a change in these tests, and when. */
const ASKED = { asked_by: "usr_01K4ZQPX000000000000000003", asked_at: "2026-10-07T20:00:00.000Z" };

/**
 * The SDK's settings over a `PUT` that keeps each body, for the harness `harnessId`. A frame a test
 * hears is filled in as Chips sends it, with the harness it is for and who asked when, since the SDK
 * reads each frame by its schema and acts on none that isn't whole (Chips SEC-14).
 */
export function settingsFor(
  keep: (whose: string, body: Record<string, unknown>) => void,
  handlers: SettingsHandlers,
  harnessId = "hrn_01K4ZQPX000000000000000004",
): Settings {
  const settings = new Settings(
    async (path, body) => {
      keep(whoseOf(path), { ...body });
      return {};
    },
    () => harnessId,
    handlers,
  );
  const hear = settings.hear.bind(settings);
  settings.hear = (frame) => hear({ harness_id: harnessId, ...ASKED, ...frame });
  return settings;
}
