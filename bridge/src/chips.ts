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

export interface ChipsOptions {
  readonly url: string;
  readonly harnessId: string;
  readonly token: string;
  readonly stateDir: string;
  readonly log: (message: string) => void;
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
   * with the same key is answered as a duplicate, so a network failure is retried here.
   */
  async send(event: ChipsEvent): Promise<void> {
    const runId = event["run_id"];
    const path =
      typeof runId === "string" && event.type !== "run.started"
        ? `/v1/runs/${runId}/events`
        : `/v1/harnesses/${this.options.harnessId}/events`;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.call("POST", path, event);
        return;
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
  async registerAgent(agent: { key: string; name: string }): Promise<ChipsAgent> {
    return (await this.call("POST", `/v1/harnesses/${this.options.harnessId}/agents`, agent)) as ChipsAgent;
  }

  /** One of our agents in a room, in the place of `replacing` there. True when it moved in now. */
  async attach(agentId: string, spaceId: string, replacing: string): Promise<boolean> {
    const answer = (await this.call("POST", `/v1/agents/${agentId}/attach`, { space_id: spaceId, replacing })) as {
      attached?: boolean;
    };
    return answer.attached === true;
  }

  /** Claim a room a person asked for, under this harness's own key for its session. */
  async claim(spaceId: string, key: string, title: string | undefined): Promise<void> {
    await this.call("POST", `/v1/harnesses/${this.options.harnessId}/spaces`, {
      key,
      space_id: spaceId,
      ...(title === undefined ? {} : { title }),
    });
  }

  /** The log from a cursor, a page at a time (`GET /v1/events`), for a room's history at start. */
  async history(since: number): Promise<{ events: ChipsEvent[]; next_cursor: number }> {
    return (await this.call("GET", `/v1/events?since=${since}&limit=500`)) as {
      events: ChipsEvent[];
      next_cursor: number;
    };
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
          accepts: ["events"],
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
