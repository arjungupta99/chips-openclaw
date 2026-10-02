/**
 * OpenClaw's files, for the room. An OpenClaw agent sends a file by giving it a line of its own in
 * its answer, `MEDIA:<path or URL>`, as OpenClaw's system prompt tells it to. The gateway takes the
 * line out of the words it shows and reports what it named on the turn's `assistant` stream, as
 * `mediaUrls`. Its own web chat then refuses what it cannot draw (an HTML page answers
 * `attachment_error: unsupported-format`), so the bridge reads the file itself.
 *
 * The paths are the gateway's, inside its container. Its state is mounted from this Mac
 * (compose.yaml: `$CHIPS_OPENCLAW_DIR/state` is the container's `/home/node/.openclaw`, its
 * workspace included), so a file under it is read from there. Nothing outside that folder is read,
 * however the path is spelled: a link or `..` that leads out of it is refused.
 */

import { readFile, realpath, stat } from "node:fs/promises";
import { join, posix, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** What one `MEDIA:` reference turned out to be. */
export type Media =
  | { readonly kind: "file"; readonly filename: string; readonly bytes: Buffer }
  /** A web address, which the bridge does not fetch: it goes back into the words it was taken from. */
  | { readonly kind: "link"; readonly url: string }
  | { readonly kind: "refused"; readonly name: string; readonly why: string };

/** The bridge holds a file whole while it sends it; Chips judges the size again by what the file is. */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

export interface MediaRoots {
  /** OpenClaw's state as the gateway sees it (compose.yaml's `OPENCLAW_STATE_DIR`). */
  readonly gatewayStateDir: string;
  /** Where a relative path starts: the agent's workspace, as the gateway sees it. */
  readonly gatewayWorkspaceDir: string;
  /** The same state, on this Mac. */
  readonly stateDir: string;
}

/** The roots for the container `scripts/up.sh` runs, its state under `sandbox` (`$CHIPS_OPENCLAW_DIR`). */
export function rootsFor(sandbox: string): MediaRoots {
  return {
    gatewayStateDir: "/home/node/.openclaw",
    gatewayWorkspaceDir: "/home/node/.openclaw/workspace",
    stateDir: join(sandbox, "state"),
  };
}

export async function readMedia(reference: string, roots: MediaRoots): Promise<Media> {
  const said = reference.trim();
  if (/^https?:\/\//i.test(said)) return { kind: "link", url: said };
  let path = said;
  if (/^file:/i.test(path)) {
    try {
      path = fileURLToPath(path);
    } catch {
      return { kind: "refused", name: said, why: "its address is not a file's" };
    }
  }
  // The gateway's home is where its state is kept.
  if (path.startsWith("~/")) path = posix.join(posix.dirname(roots.gatewayStateDir), path.slice(2));
  const name = posix.basename(path) || said;
  const inGateway = posix.resolve(roots.gatewayWorkspaceDir, path);
  const underState = posix.relative(roots.gatewayStateDir, inGateway);
  if (underState === "" || underState.startsWith("..") || posix.isAbsolute(underState)) {
    return { kind: "refused", name, why: "it is outside OpenClaw's folder" };
  }
  try {
    const root = await realpath(roots.stateDir);
    const real = await realpath(join(root, ...underState.split("/")));
    if (!real.startsWith(root + sep)) return { kind: "refused", name, why: "it is outside OpenClaw's folder" };
    const info = await stat(real);
    if (!info.isFile()) return { kind: "refused", name, why: "it is not a file" };
    if (info.size === 0) return { kind: "refused", name, why: "it is empty" };
    if (info.size > MAX_FILE_BYTES) {
      return { kind: "refused", name, why: `it is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB` };
    }
    return { kind: "file", filename: name, bytes: await readFile(real) };
  } catch {
    return { kind: "refused", name, why: "it is not there" };
  }
}
