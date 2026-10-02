/**
 * Reading the files an OpenClaw answer names, from a folder laid out as the container's state is
 * mounted on the Mac: only what is under it, however the path is spelled.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { type Media, type MediaRoots, readMedia, rootsFor } from "../src/media.ts";

let sandbox: string;
let roots: MediaRoots;

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), "bridge-media-"));
  roots = rootsFor(sandbox);
  mkdirSync(join(sandbox, "state", "workspace", "pages"), { recursive: true });
  mkdirSync(join(sandbox, "state", "media", "inbound"), { recursive: true });
  writeFileSync(join(sandbox, "state", "workspace", "ascii-alphabet.html"), "<html>A–J</html>");
  writeFileSync(join(sandbox, "state", "workspace", "pages", "cat.html"), "<html>cat</html>");
  writeFileSync(join(sandbox, "state", "media", "inbound", "photo.png"), "png");
  writeFileSync(join(sandbox, "state", "workspace", "empty.txt"), "");
  writeFileSync(join(sandbox, "secret.txt"), "the bridge's own");
  symlinkSync(join(sandbox, "secret.txt"), join(sandbox, "state", "workspace", "leak.txt"));
});

after(() => rmSync(sandbox, { recursive: true, force: true }));

const read = (reference: string): Promise<Media> => readMedia(reference, roots);

function file(media: Media): { filename: string; text: string } {
  assert.equal(media.kind, "file", JSON.stringify(media));
  return media.kind === "file" ? { filename: media.filename, text: media.bytes.toString() } : { filename: "", text: "" };
}

function refusal(media: Media): string {
  assert.equal(media.kind, "refused", JSON.stringify(media));
  return media.kind === "refused" ? media.why : "";
}

describe("an answer's files, read where OpenClaw keeps them", () => {
  it("reads a file in the workspace by the gateway's path", async () => {
    assert.deepEqual(file(await read("/home/node/.openclaw/workspace/ascii-alphabet.html")), {
      filename: "ascii-alphabet.html",
      text: "<html>A–J</html>",
    });
  });

  it("reads anything under OpenClaw's state, not only the workspace", async () => {
    assert.equal(file(await read("/home/node/.openclaw/media/inbound/photo.png")).text, "png");
  });

  it("takes a relative path from the workspace, and a file URL or the gateway's ~ as the same path", async () => {
    assert.equal(file(await read("pages/cat.html")).text, "<html>cat</html>");
    assert.equal(file(await read("./ascii-alphabet.html")).filename, "ascii-alphabet.html");
    assert.equal(file(await read("file:///home/node/.openclaw/workspace/pages/cat.html")).text, "<html>cat</html>");
    assert.equal(file(await read("~/.openclaw/workspace/pages/cat.html")).text, "<html>cat</html>");
  });

  it("gives a web address back as a link, unfetched", async () => {
    assert.deepEqual(await read(" https://example.com/cat.png "), { kind: "link", url: "https://example.com/cat.png" });
  });

  it("reads nothing outside OpenClaw's state, however the path gets there", async () => {
    assert.equal(refusal(await read("/etc/passwd")), "it is outside OpenClaw's folder");
    assert.equal(refusal(await read("/home/node/.openclaw/workspace/../../../../etc/passwd")), "it is outside OpenClaw's folder");
    assert.equal(refusal(await read("../../secret.txt")), "it is outside OpenClaw's folder");
    // A link inside the workspace that leads out of it.
    assert.equal(refusal(await read("/home/node/.openclaw/workspace/leak.txt")), "it is outside OpenClaw's folder");
  });

  it("says why when there is nothing to send", async () => {
    assert.equal(refusal(await read("/home/node/.openclaw/workspace/gone.html")), "it is not there");
    assert.equal(refusal(await read("/home/node/.openclaw/workspace/pages")), "it is not a file");
    assert.equal(refusal(await read("/home/node/.openclaw/workspace/empty.txt")), "it is empty");
  });
});
