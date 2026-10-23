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
import { join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** What one `MEDIA:` reference turned out to be. */
export type Media =
  | { readonly kind: "file"; readonly filename: string; readonly bytes: Buffer }
  /** A web address, which the bridge does not fetch: it goes back into the words it was taken from. */
  | { readonly kind: "link"; readonly url: string }
  | { readonly kind: "refused"; readonly name: string; readonly why: string };

/**
 * The `MEDIA:` lines still in an answer's words, taken out of them. The gateway takes them out and
 * reports them itself, but a turn its Codex harness runs keeps them in the words and reports none
 * (the Tic Tac Toe runs, 17 October 2026), and the room got a path and no file.
 */
export function mediaLinesIn(text: string): { readonly words: string; readonly named: readonly string[] } {
  const named: string[] = [];
  const kept = text.split("\n").filter((line) => {
    const media = /^\s*MEDIA:\s*(\S.*?)\s*$/.exec(line);
    if (media?.[1] === undefined) return true;
    named.push(media[1]);
    return false;
  });
  return { words: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), named };
}

/**
 * The files a turn sent with OpenClaw's `message` tool, by tool call: its `send` with `media`, as the
 * session commits the call. OpenClaw sends them to its own web chat, not the room, and an agent told
 * of `MEDIA:` lines may still reach for the tool (the Tic Tac Toe runs, 17 October 2026: a zip the
 * room never got, finding TT-6).
 */
export function sentWithTool(message: unknown): { readonly id: string; readonly media: readonly string[] }[] {
  const content = (message as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((item: unknown) => {
    const call = (item ?? {}) as Record<string, unknown>;
    const args = (call["arguments"] ?? {}) as Record<string, unknown>;
    if (call["type"] !== "toolCall" || call["name"] !== "message" || typeof call["id"] !== "string") return [];
    if (args["action"] !== undefined && args["action"] !== "send") return [];
    const named = Array.isArray(args["media"]) ? (args["media"] as unknown[]) : [args["media"]];
    const media = named.filter((each): each is string => typeof each === "string" && each.trim() !== "").map((each) => each.trim());
    return media.length === 0 ? [] : [{ id: call["id"], media }];
  });
}

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

/** A path under OpenClaw's state as the gateway sees it, on this Mac. */
export function macPathOf(roots: MediaRoots, path: string): string {
  return join(roots.stateDir, ...posix.relative(roots.gatewayStateDir, path).split("/"));
}

/** A path under OpenClaw's state on this Mac, as the gateway sees it. */
export function gatewayPathOf(roots: MediaRoots, path: string): string {
  return posix.join(roots.gatewayStateDir, ...relative(roots.stateDir, path).split(sep));
}

/**
 * A file a turn named, read on this Mac. A relative path starts in the workspace of the agent whose
 * turn it was (`workspace`, as the gateway sees it), else in the primary agent's.
 */
export async function readMedia(reference: string, roots: MediaRoots, workspace?: string): Promise<Media> {
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
  const inGateway = posix.resolve(workspace ?? roots.gatewayWorkspaceDir, path);
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
