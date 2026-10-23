/**
 * An OpenClaw agent of its own for each agent Chips asks this harness for, as each of Jacobian's
 * agents is a Space of its own: its own workspace, memory and conversations. Before this, every
 * one of them was a session of the primary agent, and so wrote in one folder: on 6 October 2026
 * `main`'s workspace held `ascii-alphabet.html`, `ascii-alphabet-A-O.html`, `ascii-art.html` and
 * `ascii-gallery.html`, from different rooms, side by side.
 *
 * The gateway makes one with `agents.create`, which takes effect with no restart. It is named for
 * the Chips id it was made for (`chips-…`, a room asked from the + or an ask for a new agent), so a
 * replay makes the same one, and works in a folder of its own under OpenClaw's state, `chips/`. The
 * folder is begun with the primary agent's persona: how to work (`AGENTS.md`), who it is
 * (`SOUL.md`) and who you are (`USER.md`). Its name is its own (`IDENTITY.md`, from its name in
 * Chips), and its memory starts empty. On 7 October 2026 `main`'s three were still OpenClaw's own,
 * as installed, and OpenClaw takes a folder of its own files as one not set up yet: it writes a
 * `BOOTSTRAP.md`, a first-run ritual for the agent's first turn. The bridge takes it out once the
 * agent is made, and OpenClaw then counts the folder as set up.
 *
 * A copy a person asks for with Fork (Chips ADR 0087) is made the same way, but its folder begins
 * as a copy of its original's: what it remembers doing names the original's files, and they are
 * then its own to read and change.
 *
 * A folder is where an agent starts, not a wall: an agent can still write outside it.
 */

import { constants } from "node:fs";
import { copyFile, cp, mkdir, rm, rmdir } from "node:fs/promises";
import { join, posix } from "node:path";
import { type MediaRoots, macPathOf } from "./media.ts";

/** What every OpenClaw agent the bridge makes is called first, and nothing else is. */
export const MADE_PREFIX = "chips-";

/** The primary agent's files each made agent begins with. */
export const PERSONA_FILES = ["AGENTS.md", "SOUL.md", "USER.md"] as const;

/** The OpenClaw agent made for a Chips id: a room asked from the +, or an ask for a new agent. */
export function madeAgentId(chipsId: string): string {
  return `${MADE_PREFIX}${chipsId.replace(/^[a-z]+_/i, "").toLowerCase()}`;
}

/** Whether an OpenClaw agent is one the bridge made, and so one it may delete. */
export function isMadeAgent(clawAgent: string | undefined): boolean {
  return clawAgent?.startsWith(MADE_PREFIX) === true;
}

/** The folders the agents the bridge makes work in. */
export interface Workspaces {
  /** An agent's folder, as the gateway sees it. */
  of(agent: string): string;
  /** An agent's folder, begun with the primary agent's persona. A file there already is kept. */
  seed(agent: string): Promise<void>;
  /**
   * An agent's folder begun as a copy of another agent's (`from`, as the gateway sees it), for a
   * person's Fork (Chips ADR 0087): everything in it, its persona and name, its memory and the files
   * it made, so what the copy remembers doing there is there for it to read. OpenClaw's own state
   * for the agent is not in it (`agents/<agent>/`): the session's fork carries what it said. A file
   * there already is replaced. False when `from` is not there to copy.
   */
  copy(from: string, agent: string): Promise<boolean>;
  /** A made agent's folder, without the first-run ritual OpenClaw puts in a new one. */
  settle(agent: string): Promise<void>;
  /**
   * What a deleted agent left: OpenClaw moves its files to a trash inside its container and leaves
   * the empty folders they were in (`agents/<agent>`, `chips/<agent>`). Only an empty one goes.
   */
  clear(agent: string): Promise<void>;
}

/** Folders under OpenClaw's state, which is mounted from this Mac (`media.ts`). */
export function workspacesIn(roots: MediaRoots): Workspaces {
  const onMac = (path: string): string => macPathOf(roots, path);
  const of = (agent: string): string => posix.join(roots.gatewayStateDir, "chips", agent);
  return {
    of,
    seed: async (agent) => {
      const from = onMac(roots.gatewayWorkspaceDir);
      const to = onMac(of(agent));
      await mkdir(to, { recursive: true });
      for (const name of PERSONA_FILES) {
        try {
          await copyFile(join(from, name), join(to, name), constants.COPYFILE_EXCL);
        } catch (error) {
          // There already (made again), or the primary agent has none: OpenClaw's own goes in.
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "EEXIST" && code !== "ENOENT") throw error;
        }
      }
    },
    copy: async (from, agent) => {
      try {
        await cp(onMac(from), onMac(of(agent)), { recursive: true, force: true });
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
    settle: async (agent) => {
      await rm(join(onMac(of(agent)), "BOOTSTRAP.md"), { force: true });
    },
    clear: async (agent) => {
      for (const folder of [onMac(of(agent)), join(roots.stateDir, "agents", agent)]) {
        try {
          await rmdir(folder);
        } catch {
          // Not there, or not empty: kept.
        }
      }
    },
  };
}
