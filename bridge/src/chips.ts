/**
 * Chips, from its public docs only (`connect/custom`, `connect/websocket`, `connect/new-spaces`,
 * `reference/frames`): events written over HTTP, each with an idempotency key; the log read as a
 * stream on `/v1/ws`, resumed from the last `seq`; a room claimed through the space door.
 *
 * Where the docs left something to guess, the guess is marked `DOCS:` here and listed as a finding
 * in the test report (test D1).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";

export type ChipsEvent = Record<string, unknown> & { readonly type: string };

/** What Chips answers an event it took with, as far as the bridge reads it. */
export interface Taken {
  /**
   * A message Chips took but handed to none of the agents it named: the agents in the room have
   * sent each other too many since a person last acted, or a person paused them. Absent from a
   * Chips that never holds.
   */
  readonly held?: boolean;
  /** How the agents' talk in the room stands, with a held message. */
  readonly exchange?: { readonly count?: number; readonly allowance?: number };
}

/** The size Chips's own apps send an upload's pieces in. */
const PIECE_BYTES = 4 * 1024 * 1024;

export interface ChipsOptions {
  readonly url: string;
  readonly harnessId: string;
  readonly token: string;
  readonly stateDir: string;
  readonly log: (message: string) => void;
  /**
   * A person asked OpenClaw to restart, from its page in Chips (Chips ADR 0094). Given, the
   * bridge's socket says `restart` in its hello, so Chips may ask it.
   */
  readonly onRestart?: (ask: { readonly askedBy: string; readonly askedAt: string }) => void;
  /**
   * A person changed one of an agent's context files, or one of the harness's own, from Chips
   * (Chips ADR 0134). Given, the socket says `context` in its hello, so Chips sends edits to it.
   */
  readonly onContextEdit?: (frame: Record<string, unknown>) => void;
  /**
   * A person changed an agent's model or effort from Chips (Chips ADR 0140). Given, the socket says
   * `models` in its hello, so Chips sends changes to it.
   */
  readonly onModelChange?: (frame: Record<string, unknown>) => void;
}

/** What a refused write said, so the bridge can tell a duplicate or a closed run from a fault. */
export class ChipsRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** One of this harness's agents in Chips (`connect/websocket#agents`): the key is ours for it. */
/**
 * One of our agents to register: its key and name, and for a new agent a person asked for in a
 * room (Chips ADR 0108) the ask it answers and the room, which Chips puts it in while it waits.
 */
export interface NewAgent {
  readonly key: string;
  readonly name: string;
  /** The harness's Main agent (Chips ADR 0087): one at most, only ever in its Main room. */
  readonly lead?: boolean;
  readonly made_for?: string;
  readonly space_id?: string;
}

/** For an agent registered for a room: whether Chips put it there, and why not when it didn't. */
export interface Placed {
  readonly attached?: boolean;
  readonly why?: string;
}

export interface ChipsAgent {
  readonly agent_id: string;
  readonly key: string;
  readonly name: string;
  readonly lead: boolean;
  readonly state: "active" | "archived";
  /** The rooms it is in. */
  readonly spaces: readonly string[];
  /**
   * The one open room it is in, or null when it is free (ADR 0087: one room at a time). A Chips
   * from before that says only `spaces`.
   */
  readonly room?: string | null;
  /** How many of its words Chips holds, said while it was in no room. */
  readonly held?: number;
}

export interface OwnSpaces {
  readonly spaces: readonly Record<string, unknown>[];
  readonly asked: readonly { space_id: string; asked_by?: string; title?: string | null }[];
}

export class Chips {
  private socket: WebSocket | undefined;
  private closed = false;
  private retry = 0;
  private workspaceId: string | undefined;
  private cursor: number | undefined;
  private readonly cursorFile: string;
  /**
   * What is wrong on OpenClaw's side, as Chips was last told (Chips ADR 0083). Chips forgets it
   * when the harness goes offline, so it is said again on every connection.
   */
  private trouble: string | undefined;

  constructor(private readonly options: ChipsOptions) {
    // One cursor per harness: the scratch server's place in its log means nothing on 4431's.
    this.cursorFile = join(options.stateDir, `chips-cursor-${options.harnessId}.json`);
    if (existsSync(this.cursorFile)) {
      this.cursor = (JSON.parse(readFileSync(this.cursorFile, "utf8")) as { since: number }).since;
    }
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.options.token}`, "content-type": "application/json" };
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${this.options.url}${path}`, {
      method,
      headers: this.headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const parsed = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
    if (!response.ok) {
      // DOCS: the error body's shape is not shown for HTTP; `{error: {code, message}}` is assumed.
      const error = (parsed["error"] ?? parsed) as { code?: string; message?: string };
      throw new ChipsRefusal(response.status, error.code ?? String(response.status), error.message ?? text);
    }
    return parsed;
  }

  /**
   * One event, on the run's route when it names a run and the harness's route otherwise. A retry
   * with the same key is answered as a duplicate, so a network failure is retried here. Chips's
   * answer comes back, for whether it held a message.
   */
  async send(event: ChipsEvent): Promise<Taken> {
    const runId = event["run_id"];
    const path =
      typeof runId === "string" && event.type !== "run.started"
        ? `/v1/runs/${runId}/events`
        : `/v1/harnesses/${this.options.harnessId}/events`;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return (await this.call("POST", path, event)) as Taken;
      } catch (error) {
        if (error instanceof ChipsRefusal || attempt >= 5) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
  }

  async ownSpaces(): Promise<OwnSpaces> {
    return (await this.call("GET", `/v1/harnesses/${this.options.harnessId}/spaces`)) as OwnSpaces;
  }

  /**
   * Say what is wrong on OpenClaw's side, or with nothing that nothing is (Chips ADR 0083). People
   * see OpenClaw marked, and why, under a message it has not picked up.
   */
  async status(trouble: string | undefined): Promise<void> {
    this.trouble = trouble;
    await this.call(
      "PUT",
      `/v1/harnesses/${this.options.harnessId}/status`,
      trouble === undefined ? { state: "ok" } : { state: "trouble", reason: trouble },
    );
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
    return (await this.call("POST", `/v1/harnesses/${this.options.harnessId}/agents`, agent)) as ChipsAgent & Placed;
  }

  /**
   * A copy of an agent's context files, or of the harness's own set, whole (Chips ADR 0134):
   * `PUT /v1/agents/:id/context` or `PUT /v1/harnesses/:id/context`, answering an edit or not.
   */
  async putContext(owner: { readonly agentId: string } | "harness", body: Record<string, unknown>): Promise<void> {
    const path =
      owner === "harness" ? `/v1/harnesses/${this.options.harnessId}/context` : `/v1/agents/${owner.agentId}/context`;
    await this.call("PUT", path, body);
  }

  /**
   * A copy of an agent's model and effort, whole (Chips ADR 0140): `PUT /v1/agents/:id/model`,
   * answering a change or not.
   */
  async putModel(agentId: string, body: Record<string, unknown>): Promise<void> {
    await this.call("PUT", `/v1/agents/${agentId}/model`, body);
  }

  /** One of our agents in a room, in the place of `replacing` there. True when it moved in now. */
  async attach(agentId: string, spaceId: string, replacing: string): Promise<boolean> {
    const answer = (await this.call("POST", `/v1/agents/${agentId}/attach`, { space_id: spaceId, replacing })) as {
      attached?: boolean;
    };
    return answer.attached === true;
  }

  /**
   * A room of this harness's own, opened by its key, or found again by it: Chips puts the agent
   * registered under the same key in it, in the harness's place (Chips ADR 0087's addendum of 30
   * September, point 5). Untitled, it is called what its agent is.
   */
  async openSpace(key: string): Promise<string> {
    const opened = (await this.call("POST", `/v1/harnesses/${this.options.harnessId}/spaces`, { key })) as {
      space_id: string;
    };
    return opened.space_id;
  }

  /** Claim a room a person asked for, under this harness's own key for its session. */
  async claim(spaceId: string, key: string, title: string | undefined): Promise<void> {
    await this.call("POST", `/v1/harnesses/${this.options.harnessId}/spaces`, {
      key,
      space_id: spaceId,
      ...(title === undefined ? {} : { title }),
    });
  }

  /**
   * A room's lines before a cursor (`GET /v1/spaces/:id/context`, Chips ADR 0088): the newest that
   * fit, oldest first, from a room this harness is in now, itself or as one of its agents.
   */
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

  /**
   * A file for a post (`reference/http`, "Uploads and attachments"): a slot, then its bytes, whole
   * or, for a large one, in pieces at the offset the server holds. The post names the upload's id
   * in `upload_ids`, and Chips fills in what the bytes turned out to be.
   */
  async upload(filename: string, bytes: Buffer): Promise<string> {
    const slot = (await this.call("POST", "/v1/uploads", { filename, byte_size: bytes.length })) as {
      attachment_id: string;
      upload_url?: string;
      pieces?: boolean;
    };
    const path = slot.upload_url ?? `/v1/uploads/${slot.attachment_id}`;
    // A server from before pieces would keep the first piece as the whole file.
    if (slot.pieces !== true || bytes.length <= PIECE_BYTES) {
      await this.put(path, bytes);
      return slot.attachment_id;
    }
    for (let offset = 0; offset < bytes.length; offset += PIECE_BYTES) {
      await this.put(`${path}?offset=${offset}`, bytes.subarray(offset, offset + PIECE_BYTES));
    }
    return slot.attachment_id;
  }

  private async put(path: string, body: Buffer): Promise<void> {
    const response = await fetch(`${this.options.url}${path}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${this.options.token}`, "content-type": "application/octet-stream" },
      body: new Uint8Array(body),
    });
    if (response.ok) return;
    const text = await response.text();
    const parsed = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
    const error = (parsed["error"] ?? parsed) as { code?: string; message?: string };
    throw new ChipsRefusal(response.status, error.code ?? String(response.status), error.message ?? text);
  }

  /** A file a person sent, from the signed URL `message.new` carried (good for ten minutes). */
  async fetchAttachment(url: string): Promise<Buffer> {
    // DOCS: whether a signed URL wants the bearer token too is not said; the SDK page sends it.
    const response = await fetch(url, { headers: { authorization: `Bearer ${this.options.token}` } });
    if (!response.ok) throw new Error(`attachment answered ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  /** The stream: hello, subscribe from the cursor, every event handed over in order, resumed on loss. */
  stream(onEvent: (event: ChipsEvent) => Promise<void>): void {
    const wsUrl = `${this.options.url.replace(/^http/, "ws")}/v1/ws`;
    const socket = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${this.options.token}` } });
    this.socket = socket;
    let chain = Promise.resolve();
    const handle = (event: ChipsEvent): void => {
      chain = chain.then(async () => {
        try {
          await onEvent(event);
        } catch (error) {
          this.options.log(`chips: ${event.type} not handled: ${String(error)}`);
        }
        if (typeof event["seq"] === "number") this.remember(event["seq"]);
      });
    };
    socket.on("open", () => {
      this.retry = 0;
      socket.send(
        JSON.stringify({
          frame: "hello",
          protocol: { min: 1, max: 1 },
          client: { name: "chips-openclaw-bridge", version: "0.1.0" },
          accepts: [
            "events",
            ...(this.options.onRestart === undefined ? [] : ["restart"]),
            ...(this.options.onContextEdit === undefined ? [] : ["context"]),
            ...(this.options.onModelChange === undefined ? [] : ["models"]),
          ],
        }),
      );
    });
    socket.on("message", (data) => this.onFrame(socket, JSON.parse(String(data)) as Record<string, unknown>, handle));
    socket.on("close", () => this.reconnect(onEvent));
    socket.on("error", (error) => this.options.log(`chips: socket error: ${error.message}`));
  }

  private onFrame(socket: WebSocket, frame: Record<string, unknown>, handle: (event: ChipsEvent) => void): void {
    switch (frame["frame"]) {
      case "event": {
        // DOCS: the `event` frame's shape is not shown; `{frame: "event", event: {...}}` is assumed.
        const event = (frame["event"] ?? frame) as ChipsEvent;
        if (event.type === "hello") return this.subscribe(socket, event);
        return handle(event);
      }
      case "events":
        for (const event of (frame["events"] as ChipsEvent[]) ?? []) handle(event);
        return;
      case "ping":
        socket.send(JSON.stringify({ frame: "pong", ts: frame["ts"] }));
        return;
      case "restart":
        // Now or never: not an event, so it is not remembered with the cursor (Chips ADR 0094).
        this.options.onRestart?.({ askedBy: String(frame["asked_by"]), askedAt: String(frame["asked_at"]) });
        return;
      case "context.edit":
        // Now or never, as a restart is: answered by the next copy of the file's set (ADR 0134).
        this.options.onContextEdit?.(frame);
        return;
      case "model.change":
        // Now or never too: answered by the agent's next copy (Chips ADR 0140).
        this.options.onModelChange?.(frame);
        return;
      case "error":
        this.options.log(`chips: error frame ${JSON.stringify(frame)}`);
        if (frame["code"] === "too_far_behind") socket.close();
        return;
      default:
        return;
    }
  }

  private subscribe(socket: WebSocket, hello: ChipsEvent): void {
    this.workspaceId = String(hello["workspace_id"]);
    this.options.log(`chips: connected to workspace ${this.workspaceId}, from seq ${this.cursor ?? "now"}`);
    // Said again, since Chips forgot it when this harness went offline (Chips ADR 0083).
    if (this.trouble !== undefined) {
      void this.status(this.trouble).catch((error) =>
        this.options.log(`chips: could not say the trouble again: ${String(error)}`),
      );
    }
    socket.send(
      JSON.stringify({
        frame: "subscribe",
        workspace_id: this.workspaceId,
        ...(this.cursor === undefined ? {} : { since: this.cursor }),
      }),
    );
  }

  private remember(seq: number): void {
    if (this.cursor !== undefined && seq <= this.cursor) return;
    this.cursor = seq;
    writeFileSync(this.cursorFile, JSON.stringify({ since: seq }), { mode: 0o600 });
  }

  private reconnect(onEvent: (event: ChipsEvent) => Promise<void>): void {
    if (this.closed) return;
    this.retry += 1;
    const delay = Math.min(500 * 2 ** this.retry, 15_000);
    this.options.log(`chips: disconnected; again in ${delay} ms`);
    setTimeout(() => this.stream(onEvent), delay);
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
  }
}
