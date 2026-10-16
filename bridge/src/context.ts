/**
 * An agent's context in Chips (Chips ADR 0134): the files OpenClaw builds each of our agents from
 * at every turn, sent to Chips as a copy so a person sees them on the agent's page, and a person's
 * edit there saved back into the agent's folder.
 *
 * OpenClaw reads an agent's workspace files in a fixed list (`WORKSPACE_BOOTSTRAP_FILENAMES` in its
 * gateway): `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `BOOTSTRAP.md` and `MEMORY.md`.
 * `agents.files.list` names them less `IDENTITY.md` (and less `BOOTSTRAP.md` once the folder is set
 * up), with sizes and no hashes; `agents.files.get` reads any of them with its SHA-256; and
 * `agents.files.set` writes one, refusing with `agent_file_conflict` when `expectedHash` is not the
 * file's hash any more. The bridge sends what the agent has of them, `BOOTSTRAP.md` aside (the
 * first-run ritual it takes out of every agent it makes), in the order a person reads them: who it
 * is, how it works, about you, its name, its memory.
 *
 * Chips holds no file names of anybody's: each file's row says what this module calls it.
 *
 * The harness's own set is what a new agent starts with: the primary agent's persona, copied into
 * each agent the bridge makes (`own-agents.ts`). No agent reads it after that, so it says no
 * `used_by`: Chips takes a shared file with no count as one only copied into new agents (Chips ADR
 * 0134's addendum), and a count, 0 included, as one agents read.
 */

import { Refuse } from "@chipschat/harness";
import type { ClawPort } from "./bridge.ts";
import { PERSONA_FILES } from "./own-agents.ts";

type Payload = Record<string, unknown>;

/** What Chips shows at most of a set, and of one file's text (Chips's `CONTEXT_FILES_SHOWN`, `CONTEXT_FILE_BYTES`). */
export const FILES_SHOWN = 8;
export const FILE_BYTES = 65_536;

/** OpenClaw's files, in the order an agent's page shows them, each with what its row says. */
export const CONTEXT_FILES: Readonly<Record<string, { readonly title: string; readonly role: string }>> = {
  "SOUL.md": { title: "Who it is", role: "identity" },
  "AGENTS.md": { title: "How it works", role: "instructions" },
  "USER.md": { title: "About you", role: "about_you" },
  "IDENTITY.md": { title: "Identity", role: "identity" },
  "MEMORY.md": { title: "Memory", role: "memory" },
};
const ORDER = Object.keys(CONTEXT_FILES);

/** The file OpenClaw lists apart, and the one it writes into a new folder for a first run. */
const IDENTITY = "IDENTITY.md";
const BOOTSTRAP = "BOOTSTRAP.md";

/** A file as the gateway reads it (`agents.files.get`). */
export interface ClawFile {
  readonly name: string;
  readonly content: string;
  readonly hash: string;
}

/** Whose set: one of our agents in Chips, or the harness's own. */
export type Owner = { readonly agentId: string } | "harness";


/** The `context.edit` frame Chips sends down the socket (Chips ADR 0134). */
export interface EditFrame {
  readonly edit_id: string;
  readonly agent_id?: string;
  readonly name: string;
  readonly text: string;
  readonly base_hash: string | null;
}

/** Files by the order a page shows them: OpenClaw's own first, as `ORDER` has them, then by name. */
function byOrder(a: string, b: string): number {
  const at = (name: string): number => (ORDER.includes(name) ? ORDER.indexOf(name) : ORDER.length);
  return at(a) - at(b) || a.localeCompare(b);
}

/** The line an identity's row says: its name, as `IDENTITY.md` gives it. */
export function identityLine(content: string): string | undefined {
  const name = /^\s*-\s*\**Name:?\**:?\s*(.+)$/im.exec(content)?.[1]?.trim();
  return name === undefined || name === "" || name.startsWith("_") ? undefined : `Name: ${name}`;
}

/** One file as Chips shows it. */
function fileOf(file: ClawFile): Payload {
  const known = CONTEXT_FILES[file.name];
  const about = file.name === IDENTITY ? identityLine(file.content) : undefined;
  return {
    name: file.name,
    title: known?.title ?? file.name,
    role: known?.role ?? "other",
    ...(about === undefined ? {} : { about }),
    text: file.content,
    hash: file.hash,
    editable: true,
  };
}

/** A set as Chips takes it: eight at most, in order; the rest, and any over 64 KB, named apart. */
export function setOf(files: readonly ClawFile[]): { files: Payload[]; not_shown: Payload[] } {
  const shown: Payload[] = [];
  const notShown: Payload[] = [];
  for (const file of [...files].sort((a, b) => byOrder(a.name, b.name))) {
    const title = CONTEXT_FILES[file.name]?.title;
    const named = { name: file.name, ...(title === undefined ? {} : { title }) };
    if (Buffer.byteLength(file.content, "utf8") > FILE_BYTES) notShown.push({ ...named, reason: "too_large" });
    else if (shown.length >= FILES_SHOWN) notShown.push({ ...named, reason: "count" });
    else shown.push(fileOf(file));
  }
  return { files: shown, not_shown: notShown };
}

/** The harness's own set: what a new agent starts with, which no agent reads after. */
export function ownSetOf(files: readonly ClawFile[]): Payload {
  const { files: shown, not_shown } = setOf(files);
  return {
    shared: shown.map((file) => ({
      ...file,
      id: String(file["name"]).replace(/\.md$/i, "").toLowerCase(),
      for_new_agents: true,
    })),
    not_shown,
    new_agents_note: "and an Identity with its name in Chips, and a Memory of its own",
  };
}

/** Whether the gateway refused a write because the file changed since it was read. */
function conflicted(error: unknown): boolean {
  return (error as { details?: { type?: unknown } } | undefined)?.details?.type === "agent_file_conflict";
}

/**
 * The copies Chips holds of our agents' context, kept current: each read from OpenClaw and handed to
 * the SDK, which sends it when it is not what Chips took last. One owner's reads and sends go one
 * after another, so a later copy never lands before an earlier one.
 */
export class Contexts {
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly claw: ClawPort,
    private readonly put: (owner: Owner, copy: Payload) => Promise<unknown>,
    private readonly log: (message: string) => void,
  ) {}

  /** An agent's files, as the gateway has them: what it lists, and its identity, which it lists apart. */
  async read(clawAgent: string, only?: readonly string[]): Promise<ClawFile[]> {
    let names: string[];
    if (only !== undefined) names = [...only];
    else {
      const listed = await this.claw.request<{ files?: { name: string; missing?: boolean }[] }>("agents.files.list", {
        agentId: clawAgent,
      });
      names = [...(listed.files ?? []).filter((file) => file.missing !== true).map((file) => file.name), IDENTITY];
    }
    const files: ClawFile[] = [];
    for (const name of new Set(names)) {
      if (name === BOOTSTRAP) continue;
      const got = await this.claw.request<{ file?: { missing?: boolean; content?: string; hash?: string } }>(
        "agents.files.get",
        { agentId: clawAgent, name },
      );
      const file = got.file;
      if (file === undefined || file.missing === true || file.content === undefined || file.hash === undefined) continue;
      files.push({ name, content: file.content, hash: file.hash });
    }
    return files;
  }

  /** One of our agents' set, read and sent. */
  agent(agentId: string, clawAgent: string): Promise<void> {
    return this.queue(agentId, async () => {
      await this.put({ agentId }, await this.copy({ agentId }, clawAgent));
    });
  }

  /** The harness's own set: the primary agent's persona, which each agent made begins with. */
  harness(primary: string): Promise<void> {
    return this.queue("harness", async () => {
      await this.put("harness", await this.copy("harness", primary));
    });
  }

  /**
   * A person's edit from Chips: written to the agent's folder only if the file is still the version
   * they changed, and answered by the copy as it is now. A write OpenClaw refuses as changed since
   * is refused so, and any other failure as failed, the copy beside it saying what is there.
   */
  async edit(frame: EditFrame, clawAgent: string): Promise<Payload> {
    const owner: Owner = frame.agent_id === undefined ? "harness" : { agentId: frame.agent_id };
    const now = () => this.inLine(owner === "harness" ? "harness" : owner.agentId, () => this.copy(owner, clawAgent));
    if (owner === "harness" && !(PERSONA_FILES as readonly string[]).includes(frame.name)) {
      throw new Refuse(`${frame.name} is not one a new agent starts with.`, await now().catch(() => undefined), "failed");
    }
    try {
      await this.claw.request("agents.files.set", {
        agentId: clawAgent,
        name: frame.name,
        content: frame.text,
        ...(frame.base_hash === null ? {} : { expectedHash: frame.base_hash }),
      });
    } catch (error) {
      const changed = conflicted(error);
      this.log(`openclaw: ${clawAgent}'s ${frame.name} not saved from Chips: ${String(error)}`);
      const message = changed ? "" : String((error as Error)?.message ?? error).slice(0, 300);
      throw new Refuse(message, await now().catch(() => undefined), changed ? "changed" : "failed");
    }
    this.log(`openclaw: ${clawAgent}'s ${frame.name} saved from Chips`);
    return now();
  }

  /** Every read and send asked for so far, done; for the tests and for a clean stop. */
  async settled(): Promise<void> {
    await Promise.all(this.chains.values());
  }

  /** An owner's copy as OpenClaw has it now: an agent's files, or the primary agent's persona. */
  private async copy(owner: Owner, clawAgent: string): Promise<Payload> {
    return owner === "harness" ? ownSetOf(await this.read(clawAgent, PERSONA_FILES)) : setOf(await this.read(clawAgent));
  }

  private queue(id: string, work: () => Promise<void>): Promise<void> {
    return this.inLine(id, work).catch((error: unknown) => {
      this.log(`chips: ${id === "harness" ? "the harness's" : `${id}'s`} context not sent: ${String(error)}`);
    });
  }

  /** Work for one owner, after what was asked for it before; its own result or failure. */
  private inLine<T>(id: string, work: () => Promise<T>): Promise<T> {
    const done = (this.chains.get(id) ?? Promise.resolve()).then(work);
    this.chains.set(
      id,
      done.then(
        () => undefined,
        () => undefined,
      ),
    );
    return done;
  }
}
