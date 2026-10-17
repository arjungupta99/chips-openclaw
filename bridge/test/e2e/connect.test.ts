/**
 * The gallery's OpenClaw card, run as a person runs it, against a scratch Chips and a fake gateway
 * (Chips ADRs 0122, 0171; its findings' ON-8): what isn't set up stops it before the link is
 * spent; then it joins with what the card grants and says hello once; started again it says
 * nothing more; and a new link is taken up in place of the key it kept.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { STILL_GOOD } from "../../src/config.ts";
import { type FakeGateway, startFakeGateway } from "../fake-gateway.ts";
import { type CardLink, here, type ScratchChips, scratchChips, skip } from "./kit.ts";

const HELLO = /^Hi, OpenClaw here, connected to Chips\. Ask me anything\.$/;
const UP = /openclaw: connected, protocol 4/;

/** A port nothing is listening on yet: where the gateway will be. */
const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

describe("OpenClaw's card, from a link to its hello", { skip, timeout: 180_000 }, () => {
  let chips: ScratchChips;
  let gateway: FakeGateway | undefined;
  let port: number;
  let home: string;
  let card: CardLink;
  const kept = () =>
    Object.values(JSON.parse(readFileSync(join(home, ".config/chips/harness-keys.json"), "utf8")) as Record<string, string>).map(
      (record) => JSON.parse(record) as { harnessId: string; hello: string },
    );
  const hellos = async (spaceId: string) => (await chips.said(spaceId)).filter((each) => HELLO.test(each.text));
  const run = (command: string) => chips.run(command, { folder: here, home });
  /** The command run to its end: what not being set up stops it with. */
  const stopped = async (command: string, says: RegExp) => {
    const running = run(command);
    assert.equal(await running.exited, 1, running.output());
    assert.match(running.output(), says);
    assert.ok(running.output().includes(STILL_GOOD), running.output());
    assert.equal((await chips.request(card.requestId)).state, "allowed", "the link is still good");
  };

  before(async () => {
    [chips, port] = await Promise.all([scratchChips(), freePort()]);
    home = mkdtempSync(join(tmpdir(), "chips-openclaw-home-"));
    card = await chips.card("openclaw");
  });

  after(async () => {
    await Promise.all([chips?.stop(), gateway?.close()]);
    rmSync(home, { recursive: true, force: true });
  });

  it("stops on each thing not set up, and leaves the link good", async () => {
    await stopped(card.command, /OPENCLAW_GATEWAY_TOKEN isn't set: scripts\/up\.sh makes it, in .*chips-openclaw\/\.env/);
    // What scripts/up.sh writes when it first starts OpenClaw, but OpenClaw not started.
    mkdirSync(join(home, "chips-openclaw"), { recursive: true });
    writeFileSync(
      join(home, "chips-openclaw", ".env"),
      `OPENCLAW_GATEWAY_TOKEN=gateway-test-token\nOPENCLAW_URL=ws://127.0.0.1:${port}\n`,
    );
    await stopped(card.command, new RegExp(`OpenClaw's gateway isn't answering at ws://127\\.0\\.0\\.1:${port}`));
  });

  it("joins with what the card grants, and says hello once in its room", async () => {
    gateway = await startFakeGateway({ port });
    const running = run(card.command);
    try {
      const request = await chips.until("the link taken up", async () => {
        const read = await chips.request(card.requestId);
        return read.state === "redeemed" && read;
      });
      assert.ok(request.harness_id !== undefined && request.space_id !== undefined);
      assert.deepEqual([...(await chips.capabilities(request.harness_id))].sort(), [...card.capabilities].sort());
      await running.saw(UP);
      await chips.until("its hello", async () => (await hellos(request.space_id!)).length > 0);
      assert.equal((await hellos(request.space_id)).length, 1);
      // Marked said once it is: the key it kept is the one the link handed it.
      await chips.until("its hello marked said", async () => kept()[0]?.hello === "said");
      assert.deepEqual(
        kept().map((each) => each.harnessId),
        [request.harness_id],
      );
    } finally {
      await running.stop();
    }
  });

  it("started again with the same command, says nothing more", async () => {
    const { space_id } = await chips.request(card.requestId);
    const running = run(card.command);
    try {
      await running.saw(UP);
      // Its hello, were it to say one, comes once OpenClaw's side is read.
      await new Promise((done) => setTimeout(done, 2500));
      assert.equal((await hellos(space_id!)).length, 1, running.output());
    } finally {
      await running.stop();
    }
  });

  it("takes up a new link in place of the key it kept, and says hello in the new room", async () => {
    const first = await chips.request(card.requestId);
    const again = await chips.card("openclaw");
    const running = run(again.command);
    try {
      const request = await chips.until("the new link taken up", async () => {
        const read = await chips.request(again.requestId);
        return read.state === "redeemed" && read;
      });
      assert.notEqual(request.harness_id, first.harness_id);
      await chips.until("its hello in the new room", async () => (await hellos(request.space_id!)).length === 1);
      assert.deepEqual(
        kept().map((each) => each.harnessId),
        [request.harness_id],
      );
    } finally {
      await running.stop();
    }
  });
});
