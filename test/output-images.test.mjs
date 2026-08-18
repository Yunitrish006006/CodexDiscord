import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { discordOutputImages } from "../src/output-images.mjs";

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

test("Codex output images upload only validated files inside the selected workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-discord-images-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside.png");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "screenshot.png"), PNG_HEADER);
  await writeFile(path.join(workspace, "fake.png"), "not an image");
  await writeFile(outside, PNG_HEADER);
  await symlink(outside, path.join(workspace, "escape.png"));

  try {
    const result = await discordOutputImages({
      workspace,
      generatedPaths: [],
      message: [
        `[valid](${path.join(workspace, "screenshot.png")})`,
        `[wrong bytes](${path.join(workspace, "fake.png")})`,
        `[outside](${outside})`,
        `[symlink escape](${path.join(workspace, "escape.png")})`
      ].join("\n")
    });

    assert.deepEqual(result.files, [{
      attachment: path.join(workspace, "screenshot.png"),
      name: "screenshot.png"
    }]);
    assert.equal(result.skipped, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("authoritative image-generation results may upload from temporary storage", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-discord-generated-"));
  const workspace = path.join(root, "workspace");
  const generated = path.join(root, "generated.webp");
  await mkdir(workspace);
  await writeFile(generated, Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    Buffer.from([0x04, 0x00, 0x00, 0x00]),
    Buffer.from("WEBP", "ascii")
  ]));

  try {
    const result = await discordOutputImages({ generatedPaths: [generated], workspace });
    assert.deepEqual(result.files, [{ attachment: generated, name: "generated.webp" }]);
    assert.equal(result.skipped, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
