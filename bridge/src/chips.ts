/**
 * Chips, through `@chipschat/harness`: the socket (hello, subscribe, pings, reconnects), every event
 * written over it with its idempotency key and answered by an ack, uploads in pieces, signed
 * downloads, the trouble said again after a reconnect, a person's Restart, and the changes a
 * person makes from an agent's page, each answered for the bridge. What is left here is the
 * bridge's own: events handed over one at a time, in order, each finished before the next, and the
 * cursor kept once an event is handled, so one a crash cut short is heard again.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentContextCopy,
  type AgentContextWindowCopy,
  type AgentHeartbeatCopy,
  type AgentModelCopy,
  type Chips as Connection,
  connect,
  type HarnessContextCopy,
  type HarnessJobsCopy,
  RefusedError,
  type SettingsHandlers,
} from "@chipschat/harness";
import type { JobRun } from "@chipschat/protocol";
import { VERSION } from "./version.js";

export type ChipsEvent = Record<string, unknown> & { readonly type: string };

/** What Chips answers an event it took with, as far as the bridge reads it. */
export interface Taken {
  /**
   * A message Chips took but handed to none of the agents it named: the agents in the room have
   * sent each other too many since a person last acted, or a person paused them (Chips ADR 0097).
   */
  readonly held?: boolean;
  /** How the agents' talk in the room stands, with a held message. */
  readonly exchange?: { readonly count?: number; readonly allowance?: number };
}

export interface ChipsOptions {
  readonly url: string;
  readonly harnessId: string;
  readonly token: string;
  readonly stateDir: string;
  readonly log: (message: string) => void;
  /** A person asked OpenClaw to restart, from its page in Chips (Chips ADR 0094). */
  readonly onRestart?: (ask: { readonly askedBy: string; readonly askedAt: string }) => void;
  /**
   * A person's changes from an agent's page (Chips ADRs 0134, 0140, 0143, 0146): each made in
   * OpenClaw, and answered with the copy as it is now, or refused by throwing.
   */
  readonly settings?: SettingsHandlers;
}

/** What a refused write said, so the bridge can tell a stale file or a closed run from a fault. */
export class ChipsRefusal extends Error {
  constructor(
    /** The HTTP status, for a refusal over HTTP; 0 for one over the socket. */
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * One of our agents to register: its key and name; for a new agent a person asked for in a room
 * (Chips ADR 0108) the ask it answers, and for a copy a person's Fork asked for (Chips ADR 0087)
 * the agent it copies; and for either the room, which Chips puts it in while it waits.
 */
export interface NewAgent {
  readonly key: string;
  readonly name: string;
  /** The harness's Main agent (Chips ADR 0087): one at most, only ever in its Main room. */
  readonly lead?: boolean;
  readonly made_for?: string;
  readonly forked_from?: string;
  readonly space_id?: string;
}

/** For an agent registered for a room: whether Chips put it there, and why not when it didn't. */
export interface Placed {
  readonly attached?: boolean;
  readonly why?: string;
}

/** One of this harness's agents in Chips (`connect/websocket#agents`): the key is ours for it. */
export interface ChipsAgent {
  readonly agent_id: string;
  readonly key: string;
  readonly name: string;
  readonly lead: boolean;
  readonly state: "active" | "archived";
  /** The rooms it is in. */
  readonly spaces: readonly string[];
  /** The one open room it is in, or null when it is free (ADR 0087: one room at a time). */
  readonly room?: string | null;
  /** How many of its words Chips holds, said while it was in no room. */
  readonly held?: number;
}

export interface OwnSpaces {
  readonly spaces: readonly Record<string, unknown>[];
  readonly asked: readonly { space_id: string; asked_by?: string; title?: string | null }[];
}

type Payload = Record<string, unknown>;

export class Chips {
  private connection: Connection | undefined;
  private handler: ((event: ChipsEvent) => Promise<void>) | undefined;
  private release: () => void = () => undefined;
  /** Events wait here until the bridge is ready for them, then go one at a time. */
  private chain: Promise<void>;
  private cursor: number | undefined;
  private readonly cursorFile: string;

  constructor(private readonly options: ChipsOptions) {
    // One cursor per harness: the scratch server's place in its log means nothing on 4431's.
    this.cursorFile = join(options.stateDir, `chips-cursor-${options.harnessId}.json`);
    if (existsSync(this.cursorFile)) {
      this.cursor = (JSON.parse(readFileSync(this.cursorFile, "utf8")) as { since: number }).since;
    }
    this.chain = new Promise((resolve) => {
      this.release = resolve;
    });
  }

  /**
   * Connect: the socket, hello, and the log from the cursor, which waits for `stream`. A Chips that
   * is down, or restarting, is tried again until it answers, as the SDK does after a drop.
   */
  async open(): Promise<void> {
    for (let attempt = 1; this.connection === undefined; attempt += 1) {
      try {
        this.connection = await this.connect();
      } catch (error) {
        const delay = Math.min(500 * 2 ** attempt, 15_000);
        this.options.log(`chips: not connected (${String(error)}); again in ${delay} ms`);
        await new Promise((done) => setTimeout(done, delay));
      }
    }
    this.connection.on("state", (state) => this.options.log(`chips: ${state}`));
    this.connection.on("event", (event) => this.take(event as unknown as ChipsEvent));
    this.options.log(`chips: connected to workspace ${this.connection.workspaceId}, from seq ${this.cursor ?? "now"}`);
  }

  private connect(): Promise<Connection> {
    const { options } = this;
    return connect({
      url: options.url,
      token: options.token,
      client: { name: "chips-openclaw-bridge", version: VERSION },
      ...(this.cursor === undefined ? {} : { since: this.cursor }),
      ...(options.onRestart === undefined
        ? {}
        : { onRestart: (ask) => options.onRestart?.({ askedBy: ask.askedBy, askedAt: ask.askedAt }) }),
      ...(options.settings === undefined ? {} : { settings: options.settings }),
    });
  }

  /** Every event from here on, handed over in order, each handled before the next. */
  stream(onEvent: (event: ChipsEvent) => Promise<void>): void {
    this.handler = onEvent;
    this.release();
  }

  private take(event: ChipsEvent): void {
    if (event.type === "hello") return;
    this.chain = this.chain.then(async () => {
      try {
        await this.handler?.(event);
      } catch (error) {
        this.options.log(`chips: ${event.type} not handled: ${String(error)}`);
      }
      if (typeof event["seq"] === "number") this.remember(event["seq"]);
    });
  }

  private remember(seq: number): void {
    if (this.cursor !== undefined && seq <= this.cursor) return;
    this.cursor = seq;
    writeFileSync(this.cursorFile, JSON.stringify({ since: seq }), { mode: 0o600 });
  }

  private get chips(): Connection {
    if (this.connection === undefined) throw new Error("Chips is not connected yet");
    return this.connection;
  }

  /** A call the SDK has no word for, as the bridge reads its answer; a refusal as `ChipsRefusal`. */
  private async call(method: "GET" | "POST" | "PUT", path: string, body?: Payload): Promise<unknown> {
    try {
      return await this.chips.request(method, path, body);
    } catch (error) {
      throw refusalOf(error);
    }
  }

  /**
   * One event, over the socket, with its own idempotency key, so one written again after a restart
   * is answered as a duplicate. Chips's answer comes back, for whether it held a message.
   */
  async send(event: ChipsEvent): Promise<Taken> {
    const { type, idempotency_key: key, ...rest } = event;
    try {
      const ack = await this.chips.send(type, {}, rest, typeof key === "string" ? key : undefined);
      return ack.held === true ? { held: true, ...(ack.exchange === undefined ? {} : { exchange: ack.exchange }) } : {};
    } catch (error) {
      throw refusalOf(error);
    }
  }

  async ownSpaces(): Promise<OwnSpaces> {
    return (await this.call("GET", `/v1/harnesses/${this.options.harnessId}/spaces`)) as OwnSpaces;
  }

  /**
   * Say what is wrong on OpenClaw's side, or with nothing that nothing is (Chips ADR 0083). The SDK
   * says it again whenever the socket comes back, since Chips forgets it while the harness is away.
   */
  async status(trouble: string | undefined): Promise<void> {
    await (trouble === undefined ? this.chips.reportOk() : this.chips.reportTrouble(trouble));
  }

  /** This harness's agents, with their rooms (`GET /v1/harnesses/:id/agents`). */
  async agents(): Promise<ChipsAgent[]> {
    const listed = (await this.call("GET", `/v1/harnesses/${this.options.harnessId}/agents`)) as {
      agents?: ChipsAgent[];
    };
    return listed.agents ?? [];
  }

  /** One of this harness's agents by our key for it: made the first time, renamed when the name changed. */
  async registerAgent(agent: NewAgent): Promise<ChipsAgent & Placed> {
    return (await this.call("POST", `/v1/harnesses/${this.options.harnessId}/agents`, { ...agent })) as ChipsAgent &
      Placed;
  }

  /** One of our agents in a room, in the place of `replacing` there. True when it moved in now. */
  async attach(agentId: string, spaceId: string, replacing: string): Promise<boolean> {
    try {
      return (await this.chips.agents.attach(agentId, { spaceId, replacing })).attached;
    } catch (error) {
      throw refusalOf(error);
    }
  }

  /** A room of this harness's own, opened by its key, or found again by it (Chips ADR 0087). */
  async openSpace(key: string): Promise<string> {
    try {
      return await this.chips.openSpace(key);
    } catch (error) {
      throw refusalOf(error);
    }
  }

  /** Claim a room a person asked for, under this harness's own key for its session. */
  async claim(spaceId: string, key: string, title: string | undefined): Promise<void> {
    try {
      await this.chips.claimSpace(spaceId, key, title);
    } catch (error) {
      throw refusalOf(error);
    }
  }

  /** A room's lines before a cursor (`GET /v1/spaces/:id/context`, Chips ADR 0088), as Chips gives them. */
  async roomContext(spaceId: string, before: number, limit: number): Promise<unknown> {
    return this.call("GET", `/v1/spaces/${spaceId}/context?before=${before}&limit=${limit}`);
  }

  /** The log from a cursor, a page at a time (`GET /v1/events`), for a room's history at start. */
  async history(since: number): Promise<{ events: ChipsEvent[]; next_cursor: number }> {
    return (await this.call("GET", `/v1/events?since=${since}&limit=500`)) as {
      events: ChipsEvent[];
      next_cursor: number;
    };
  }

  /** A file for a post, whole or in pieces, resumed after a dropped connection; the upload's id. */
  async upload(filename: string, bytes: Buffer): Promise<string> {
    try {
      return (await this.chips.upload({ bytes: new Uint8Array(bytes), filename })).attachmentId;
    } catch (error) {
      throw refusalOf(error);
    }
  }

  /** A file a person sent, from the signed URL `message.new` carried (good for ten minutes). */
  async fetchAttachment(url: string): Promise<Buffer> {
    return Buffer.from(await this.chips.download(url));
  }

  /** An agent's context files, or the harness's own set, as a copy (Chips ADR 0134). */
  putContext(owner: { readonly agentId: string } | "harness", copy: Payload): Promise<unknown> {
    return owner === "harness"
      ? this.chips.settings.harnessContext(copy as unknown as HarnessContextCopy)
      : this.chips.settings.context(owner.agentId, copy as unknown as AgentContextCopy);
  }

  /** An agent's model and effort, as a copy (Chips ADR 0140). */
  putModel(agentId: string, copy: Payload): Promise<unknown> {
    return this.chips.settings.model(agentId, copy as unknown as AgentModelCopy);
  }

  /** An agent's heartbeat, as a copy (Chips ADR 0143). */
  putHeartbeat(agentId: string, copy: Payload): Promise<unknown> {
    return this.chips.settings.heartbeat(agentId, copy as unknown as AgentHeartbeatCopy);
  }

  /** OpenClaw's own jobs, as a copy (Chips ADR 0252). */
  putJobs(copy: Payload): Promise<unknown> {
    return this.chips.settings.jobs(copy as unknown as HarnessJobsCopy);
  }

  /** Runs of OpenClaw's own jobs that finished (Chips ADR 0252). */
  postJobRuns(runs: readonly Payload[]): Promise<void> {
    return this.chips.settings.jobRuns(runs as unknown as JobRun[]);
  }

  /** An agent's context window, as a copy (Chips ADR 0146). */
  putWindow(agentId: string, copy: Payload): Promise<unknown> {
    return this.chips.settings.contextWindow(agentId, copy as unknown as AgentContextWindowCopy);
  }

  /** A Compact now that was taken and then failed (Chips ADR 0146): refused, with OpenClaw's words. */
  compactFailed(agentId: string, changeId: string, message: string, copy?: Payload): Promise<unknown> {
    return this.chips.settings.contextWindowFailed(
      agentId,
      changeId,
      message,
      copy as unknown as AgentContextWindowCopy | undefined,
    );
  }

  /** An agent deleted: nothing more is remembered of its copies. */
  forget(agentId: string): void {
    this.connection?.settings.forget(agentId);
  }

  close(): void {
    this.connection?.close();
  }
}

/** The SDK's refusal as the bridge reads one: its code and words. */
function refusalOf(error: unknown): unknown {
  return error instanceof RefusedError ? new ChipsRefusal(0, error.code, error.message) : error;
}
