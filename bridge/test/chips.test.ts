/**
 * The bridge's side of Chips, on `@chipschat/harness`, against the conformance kit's fake Chips: the
 * wire as Chips speaks it, every event checked against the protocol's schemas. What the bridge adds
 * to the SDK is tested here: events held until the bridge is ready, handed over one at a time, and
 * the cursor kept once each is handled, so a restart hears what it had not finished; events sent
 * under the bridge's own keys; refusals as `ChipsRefusal`; and the routes read as the bridge reads
 * them.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type FakeChips, startFakeChips } from "@chipschat/conformance";
import { Chips, type ChipsEvent, ChipsRefusal } from "../src/chips.ts";

let fake: FakeChips;
let stateDir: string;
const opened: Chips[] = [];

beforeEach(async () => {
  fake = await startFakeChips({ capabilities: ["agents"] });
  stateDir = mkdtempSync(join(tmpdir(), "bridge-chips-"));
});

afterEach(async () => {
  for (const chips of opened.splice(0)) chips.close();
  await fake.close();
});

async function open(): Promise<Chips> {
  const chips = new Chips({
    url: fake.address.url,
    harnessId: fake.address.harnessId,
    token: fake.address.token,
    stateDir,
    log: () => undefined,
  });
  opened.push(chips);
  await chips.open();
  return chips;
}

/** The words the bridge hears, in the order its handler finished them, once there are `count`. */
function heard(chips: Chips, count: number, slow = 0): Promise<string[]> {
  const words: string[] = [];
  let busy = false;
  return new Promise((resolve, reject) => {
    chips.stream(async (event: ChipsEvent) => {
      if (event.type !== "message.new") return;
      if (busy) reject(new Error("two events handled at once"));
      busy = true;
      // A handler that takes its time: the next waits for it.
      if (slow > 0) await new Promise((done) => setTimeout(done, slow));
      words.push(String(event["text"]));
      busy = false;
      if (words.length === count) resolve(words);
    });
  });
}

const cursorOf = (): number | undefined => {
  const file = join(stateDir, `chips-cursor-${fake.address.harnessId}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { since: number }).since : undefined;
};

describe("what the bridge hears", () => {
  it("holds what is said until the bridge is ready, then hands it over in order, one at a time", async () => {
    const chips = await open();
    await fake.say("one");
    await fake.say("two");
    await new Promise((done) => setTimeout(done, 50));
    assert.equal(cursorOf(), undefined, "nothing handled before the bridge is ready");
    const words = heard(chips, 3, 10);
    await fake.say("three");
    assert.deepEqual(await words, ["one", "two", "three"]);
    const last = await fake.waitFor((event) => (event.type === "message.post" && event.payload["text"] === "three" ? event : undefined), 1000);
    await new Promise((done) => setTimeout(done, 20));
    assert.equal(cursorOf(), last.seq, "the cursor is the last event handled");
  });

  it("hears after a restart what was said while it was away, and nothing it had handled", async () => {
    const first = await open();
    const before = heard(first, 1);
    await fake.say("before");
    assert.deepEqual(await before, ["before"]);
    await new Promise((done) => setTimeout(done, 20));
    first.close();
    await fake.say("while away");
    const again = await open();
    const after = heard(again, 1);
    assert.deepEqual(await after, ["while away"]);
  });
});

describe("what the bridge says", () => {
  it("sends an event under its own key, and the same key again is answered as done", async () => {
    const chips = await open();
    const post = { type: "message.post", space_id: fake.address.spaceId, text: "On it.", idempotency_key: "bridge-post-1" };
    assert.deepEqual(await chips.send(post), {});
    assert.deepEqual(await chips.send(post), {});
    const posts = fake.workspace.log.filter((event) => event.type === "message.post" && event.payload["text"] === "On it.");
    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.idempotency_key, "bridge-post-1");
  });

  it("is refused as a ChipsRefusal, with Chips's code and words", async () => {
    const chips = await open();
    await assert.rejects(
      chips.send({ type: "message.post", text: "Nowhere.", idempotency_key: "bridge-post-2" }),
      (error: unknown) => error instanceof ChipsRefusal && error.code !== "" && error.message !== "",
    );
  });
});

describe("the routes, as the bridge reads them", () => {
  it("registers an agent by its key, lists it, opens a room by key, and reads the room", async () => {
    const chips = await open();
    const agent = await chips.registerAgent({ key: "agent:scout:chips-main", name: "Scout" });
    assert.match(agent.agent_id, /^agt_/);
    assert.equal(agent.key, "agent:scout:chips-main");
    assert.ok((await chips.agents()).some((each) => each.agent_id === agent.agent_id));
    const room = await chips.openSpace("agent:scout:chips-main");
    assert.equal(await chips.openSpace("agent:scout:chips-main"), room);
    const own = await chips.ownSpaces();
    assert.ok(own.spaces.some((space) => space["space_id"] === room));
    assert.deepEqual(own.asked, []);
    await fake.say("hello", room);
    const context = (await chips.roomContext(room, 1_000_000, 20)) as { lines?: unknown[] };
    assert.ok(Array.isArray(context.lines));
    const history = await chips.history(0);
    assert.ok(history.events.some((event) => event.type === "message.post" && event["text"] === "hello"));
  });

  it("hears a person's Fork, and registers the copy forked_from its original for the room, which it joins (Chips ADR 0087)", async () => {
    await fake.close();
    fake = await startFakeChips({ capabilities: ["agents", "forks"] });
    const chips = await open();
    const original = await chips.registerAgent({ key: "agent:scout:chips-main", name: "Scout" });
    await chips.openSpace("agent:scout:chips-main");
    const room = await fake.openRoom("Elsewhere");
    const asks: ChipsEvent[] = [];
    chips.stream(async (event) => {
      if (event.type === "agent.fork") asks.push(event);
    });
    const { forkId } = await fake.askForFork(original.agent_id, room);
    for (let waited = 0; asks.length === 0 && waited < 5_000; waited += 20) await new Promise((done) => setTimeout(done, 20));
    assert.deepEqual([asks[0]?.["id"], asks[0]?.["agent_id"], asks[0]?.["space_id"]], [forkId, original.agent_id, room]);
    // When it was asked, by Chips's clock: the room waits a minute from it.
    assert.ok(Date.now() - Date.parse(String(asks[0]?.["ts"])) < 60_000);
    const copy = await chips.registerAgent({ key: "agent:chips-01k5:chips-elsewhere", name: "Scout · fork", forked_from: original.agent_id, space_id: room });
    assert.equal(copy.attached, true);
    assert.equal((await chips.agents()).find((each) => each.agent_id === copy.agent_id)?.room, room);
  });

  it("uploads a file and hands back the id a post names", async () => {
    const chips = await open();
    const id = await chips.upload("notes.md", Buffer.from("# Notes\n"));
    assert.match(id, /^att_/);
    assert.deepEqual(await chips.send({ type: "message.post", space_id: fake.address.spaceId, text: "Here.", upload_ids: [id], idempotency_key: "bridge-post-3" }), {});
  });
});
