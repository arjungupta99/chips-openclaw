/**
 * The room's files (Chips ADR 0099). A file posted in a room is the room's: the newest file of a
 * name is its current version, and posting one under the same name is the next. Chips lists the
 * current version of each with a message (`context.files`), with a URL the bridge can fetch, so an
 * OpenClaw agent is handed the room's file rather than a path on another machine — the ASCII Art
 * room's agents were handed `/Users/…/ascii-alphabet.html`, which their container does not have.
 *
 * A turn is handed the files its words name, at most five of five MB each, and is told so. What it
 * sends back under one of those names is the next version, and says which version it was made from
 * (`replaces`), so Chips can refuse one made from a version that is no longer current: two agents
 * editing at once lose nothing silently, and the one that loses fetches and redoes.
 *
 * Nothing here from a Chips that lists no files, and a Chips that does not know `replaces` leaves it
 * out of what it keeps.
 *
 * Every turn in a room is also told how a file reaches it (Chips AW-19, 10 October 2026): on their
 * first turns in the Terra Fab room, before it had a file, both of our agents named a path in their
 * own folder instead of sending the file, and nobody else could open it.
 */

/** One file of a room, at its current version, as Chips lists it with a message. */
export interface RoomFile {
  readonly name: string;
  readonly version: number | undefined;
  readonly attachmentId: string;
  readonly sha256: string | undefined;
  readonly byteSize: number | undefined;
  readonly mimeType: string;
  /** Who posted this version, by name. */
  readonly by: string | undefined;
  readonly url: string;
}

/**
 * How a file reaches a room, said with every turn there: a path in an agent's folder does not. A
 * turn that works on the room's project hears that only a file outside it needs sending: told that
 * a file "reaches this room only when you send it", agents sent the project's files too, even after
 * the project's note said not to (Chips AP-9).
 */
export function sendingFiles(project = false): string {
  const which = project ? "A file that isn't in the room's project" : "A file";
  return (
    `${which} reaches this room only when you send it, on a line of its own: MEDIA:<path>. ` +
    "A path alone reaches nobody: the people and agents here cannot open your folder. " +
    "A MEDIA: line sends any file in your folder; the message tool refuses some, a web page among them."
  );
}

/** How a file reaches a room that has no project to work on. */
export const SENDING_FILES = sendingFiles();

/** As many of a room's files as one turn is handed, and the most bytes each may have. */
export const ROOM_FILES = { most: 5, bytes: 5 * 1024 * 1024 } as const;

/** The code Chips refuses a post with when a file in it was made from a version that is no longer current. */
export const STALE_FILE = "stale_file";

type Payload = Record<string, unknown>;

const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

/** Who posted a version: a name, or a participant as Chips writes one. */
function byOf(by: unknown): string | undefined {
  if (typeof by === "string") return str(by);
  if (typeof by !== "object" || by === null) return undefined;
  const who = by as Payload;
  return str(who["name"]) ?? str(who["display_name"]) ?? str(who["id"]);
}

/** The room's files a message's context lists, or none from a Chips that lists none. */
export function roomFilesIn(context: unknown): RoomFile[] {
  const files = (context as Payload | null | undefined)?.["files"];
  if (!Array.isArray(files)) return [];
  const read: RoomFile[] = [];
  for (const each of files) {
    if (typeof each !== "object" || each === null) continue;
    const file = each as Payload;
    const name = str(file["name"]);
    const attachmentId = str(file["attachment_id"]);
    const url = str(file["url"]);
    if (name === undefined || attachmentId === undefined || url === undefined) continue;
    read.push({
      name,
      version: num(file["version"]),
      attachmentId,
      sha256: str(file["sha256"]),
      byteSize: num(file["byte_size"]),
      mimeType: str(file["mime_type"]) ?? "application/octet-stream",
      by: byOf(file["by"]),
      url,
    });
  }
  return read;
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The files a turn's words name, in the order Chips lists them. A name counts as a whole name: a
 * path ending in it does, a longer name with it inside does not (`page.html` is not named by
 * `mypage.html`), and a full stop after it ends a sentence.
 */
export function namedIn(files: readonly RoomFile[], words: string): RoomFile[] {
  return files.filter((file) => names(words, file.name));
}

/** Whether words name a file, as a whole name. */
function names(words: string, name: string): boolean {
  return new RegExp(`(?<![\\w-])${escaped(name)}(?![\\w-]|\\.\\w)`, "i").test(words);
}

/** `ascii-alphabet.html (v3, by Oc2)`. */
function described(file: RoomFile): string {
  const about = [file.version === undefined ? undefined : `v${file.version}`, file.by === undefined ? undefined : `by ${file.by}`]
    .filter((part) => part !== undefined)
    .join(", ");
  return about === "" ? file.name : `${file.name} (${about})`;
}

/**
 * What a turn is told of the room's files it was handed, of those it named and was not, and how a
 * file of its own reaches the room: with the room's project, a file that isn't in it.
 */
export function filesLine(
  handed: readonly RoomFile[],
  left: readonly { readonly file: RoomFile; readonly why: string }[],
  project = false,
): string {
  const lines: string[] = [];
  if (handed.length > 0) {
    lines.push(
      `Files in this room, attached at their current version: ${handed.map(described).join(", ")}. ` +
        "To change one, send it back under the same name: Chips takes it as the next version.",
    );
  }
  for (const { file, why } of left) lines.push(`Not attached: ${described(file)}, ${why}.`);
  lines.push(sendingFiles(project));
  return lines.join("\n");
}

/**
 * The files a refused post named as stale, among those it sent as new versions: the ones whose name
 * the refusal says, or, when it says none of them, every one.
 */
export function staleIn(message: string, versions: readonly { readonly id: string; readonly name: string }[]): string[] {
  const said = versions.filter((each) => names(message, each.name));
  return (said.length > 0 ? said : versions).map((each) => each.id);
}
