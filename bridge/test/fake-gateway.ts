/**
 * A fake OpenClaw gateway on a WebSocket, as far as the bridge's start needs one: the connect
 * challenge, a hello for the `connect` that answers it, one agent listed, and every other method
 * refused, as a gateway without it refuses. It records the methods it was asked, in order.
 */

import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";

export interface FakeGateway {
  readonly url: string;
  readonly token: string;
  readonly asked: string[];
  close(): Promise<void>;
}

const SCOPES = ["operator.read", "operator.write", "operator.approvals", "operator.questions", "operator.admin"];

/** What the gateway answers a method with, or undefined to refuse it. */
function answer(method: string): unknown {
  switch (method) {
    case "connect":
      return {
        type: "hello-ok",
        protocol: 4,
        server: { version: "fake", connId: randomUUID() },
        features: { methods: [], events: [] },
        snapshot: { presence: [] },
        auth: { role: "operator", scopes: SCOPES },
        policy: { maxPayload: 26_214_400, maxBufferedBytes: 52_428_800, tickIntervalMs: 30_000 },
      };
    case "sessions.subscribe":
      return {};
    case "agents.list":
      return { defaultId: "main", agents: [{ id: "main", name: "Main" }] };
    default:
      return undefined;
  }
}

/** On `port` when given: where a bridge was told the gateway is before it was up. */
export async function startFakeGateway(options: { port?: number } = {}): Promise<FakeGateway> {
  const asked: string[] = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: options.port ?? 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  server.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: randomUUID(), ts: Date.now() } }));
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as { type?: string; id?: string; method?: string };
      if (frame.type !== "req" || frame.id === undefined || frame.method === undefined) return;
      asked.push(frame.method);
      const payload = answer(frame.method);
      socket.send(
        JSON.stringify(
          payload === undefined
            ? { type: "res", id: frame.id, ok: false, error: { code: "INVALID_REQUEST", message: `unknown method: ${frame.method}` } }
            : { type: "res", id: frame.id, ok: true, payload },
        ),
      );
    });
  });
  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    token: "gateway-test-token",
    asked,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  };
}
