/** How OpenClaw is, as Chips is told it: fine at the first hello, trouble only after a real outage. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { health } from "../src/health.ts";

const until = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("OpenClaw's health, as Chips is told it", () => {
  it("says fine at the first hello, whatever an earlier process said, and not again after", () => {
    const said: (string | undefined)[] = [];
    const openClaw = health((trouble) => said.push(trouble), () => undefined);
    openClaw.up();
    openClaw.up();
    assert.deepEqual(said, [undefined]);
  });

  it("says trouble only once the gateway has been gone for the wait, and fine when it is back", async () => {
    const said: (string | undefined)[] = [];
    const openClaw = health((trouble) => said.push(trouble), () => undefined, 20);
    openClaw.up();
    // A blip: down and up inside the wait is nothing.
    openClaw.down();
    openClaw.up();
    await until(40);
    assert.deepEqual(said, [undefined]);
    openClaw.down();
    await until(40);
    openClaw.down();
    assert.deepEqual(said, [undefined, "Can't reach its gateway"]);
    openClaw.up();
    assert.deepEqual(said, [undefined, "Can't reach its gateway", undefined]);
  });

  it("says trouble from the start when the gateway never answers", async () => {
    const said: (string | undefined)[] = [];
    const openClaw = health((trouble) => said.push(trouble), () => undefined, 20);
    openClaw.down();
    await until(40);
    openClaw.up();
    assert.deepEqual(said, ["Can't reach its gateway", undefined]);
  });
});
