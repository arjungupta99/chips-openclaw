/**
 * OpenClaw's gateway, through its own published client (`@openclaw/gateway-client`, pinned to the
 * gateway's version). The bridge is an operator device: an Ed25519 key kept in the bridge's state,
 * paired once on the gateway host (`scripts/cli.sh devices approve <id>`), then a device token.
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GatewayClient } from "@openclaw/gateway-client";

export type ClawEvent = { readonly event: string; readonly payload: Record<string, unknown> };

interface DeviceIdentity {
  readonly deviceId: string;
  readonly publicKeyPem: string;
  readonly privateKeyPem: string;
}

/** The 32 bytes of an Ed25519 public key, from its PEM. */
function rawPublicKey(pem: string): Buffer {
  const der = createPublicKey(pem).export({ type: "spki", format: "der" });
  return der.subarray(der.length - 32);
}

/** The device key, made once; its id is the SHA-256 of the raw public key, as the gateway checks. */
function identity(stateDir: string): DeviceIdentity {
  const file = join(stateDir, "device.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as DeviceIdentity;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const deviceId = createHash("sha256").update(rawPublicKey(publicKeyPem)).digest("hex");
  const made = { deviceId, publicKeyPem, privateKeyPem };
  writeFileSync(file, JSON.stringify(made), { mode: 0o600 });
  return made;
}

export interface OpenClawOptions {
  readonly url: string;
  readonly token: string;
  readonly stateDir: string;
  readonly log: (message: string) => void;
  readonly onEvent: (event: ClawEvent) => void;
}

export class OpenClaw {
  private readonly client: GatewayClient;
  /**
   * Whether the gateway has said hello on the current socket, and who is waiting for it to. A flag
   * and a list rather than a promise replaced at each close: a request made while the gateway was
   * down waited on one promise, a second failed reconnect replaced it, and the request never woke.
   */
  private connected = false;
  private readonly waiting: (() => void)[] = [];

  constructor(options: OpenClawOptions) {
    const tokenFile = join(options.stateDir, "device-token.json");
    this.client = new GatewayClient({
      url: options.url,
      token: options.token,
      clientName: "gateway-client",
      clientDisplayName: "Chips bridge",
      clientVersion: "0.1.0",
      mode: "backend",
      platform: "macos",
      role: "operator",
      // Not operator.admin, though a plugin's ask (Codex's own shell) names no reviewer device and
      // OpenClaw shows such an ask only to the client that raised it and to admins: without it those
      // commands are denied at once ("no-approval-route"). Widening the scope is Arjun's call.
      scopes: ["operator.read", "operator.write", "operator.approvals", "operator.questions"],
      caps: ["tool-events", "exec-approvals", "plugin-approvals", "approvals"],
      minProtocol: 4,
      maxProtocol: 4,
      deviceIdentity: identity(options.stateDir),
      hostDeps: {
        signDevicePayload: (pem, payload) =>
          sign(null, Buffer.from(payload, "utf8"), createPrivateKey(pem)).toString("base64url"),
        publicKeyRawBase64UrlFromPem: (pem) => rawPublicKey(pem).toString("base64url"),
        loadDeviceAuthToken: () =>
          existsSync(tokenFile) ? (JSON.parse(readFileSync(tokenFile, "utf8")) as { token: string }) : null,
        storeDeviceAuthToken: ({ token, scopes }) =>
          writeFileSync(tokenFile, JSON.stringify({ token, scopes }), { mode: 0o600 }),
        clearDeviceAuthToken: () => rmSync(tokenFile, { force: true }),
        logError: (message) => options.log(`openclaw: ${message}`),
      },
      onHelloOk: (hello) => {
        options.log(`openclaw: connected, protocol ${hello.protocol}, scopes ${hello.auth.scopes.join(" ")}`);
        this.connected = true;
        for (const wake of this.waiting.splice(0)) wake();
      },
      onConnectError: (error) => options.log(`openclaw: connect failed: ${error.message}`),
      onReconnectPaused: (info) =>
        options.log(`openclaw: reconnect paused (${info.detailCode ?? info.code}): ${info.reason}`),
      onClose: (code) => {
        options.log(`openclaw: closed (${code})`);
        this.connected = false;
      },
      onEvent: (frame) =>
        options.onEvent({ event: frame.event, payload: (frame.payload ?? {}) as Record<string, unknown> }),
    });
  }

  /** Until the gateway has said hello on a live socket; at once when it has. */
  private async ready(): Promise<void> {
    if (this.connected) return;
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  /** Connect, and resolve once the gateway has said hello. */
  async start(): Promise<void> {
    this.client.start();
    await this.ready();
  }

  /** A gateway method, once connected; one the socket dropped under is tried again after hello. */
  async request<T = Record<string, unknown>>(method: string, params: Record<string, unknown>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      await this.ready();
      try {
        return (await this.client.request(method, params)) as T;
      } catch (error) {
        // A refusal from the gateway is its answer; only a lost socket is worth another try.
        if (this.connected || attempt >= 3) throw error;
      }
    }
  }

  stop(): void {
    this.client.stop();
  }
}
