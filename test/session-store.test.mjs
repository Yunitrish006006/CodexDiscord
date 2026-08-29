import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sessionKey, SessionStore, taskKey } from "../src/session-store.mjs";

test("active task locks span Discord threads without merging saved sessions", () => {
  assert.equal(
    taskKey({ userId: "user", channelId: "thread-a", workspace: "core" }),
    taskKey({ userId: "user", channelId: "thread-b", workspace: "core" })
  );
  assert.notEqual(taskKey({ userId: "user", workspace: "core" }), taskKey({ userId: "user", workspace: "nexus" }));
  assert.notEqual(
    sessionKey({ userId: "user", channelId: "thread-a", workspace: "core" }),
    sessionKey({ userId: "user", channelId: "thread-b", workspace: "core" })
  );
});

test("the selected reasoning depth survives a bot restart", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "codex-discord-session-"));
  try {
    const first = new SessionStore(stateDir);
    await first.load();
    await first.setActiveModel("user:channel", "gpt-5.6-sol");
    await first.setActiveReasoningEffort("user:channel", "high");
    await first.setProgressLineCount("user:channel", 7);

    const restarted = new SessionStore(stateDir);
    await restarted.load();
    assert.equal(restarted.activeModel("user:channel"), "gpt-5.6-sol");
    assert.equal(restarted.activeReasoningEffort("user:channel"), "high");
    assert.equal(restarted.progressLineCount("user:channel"), 7);

    await restarted.setActiveReasoningEffort("user:channel", null);
    assert.equal(restarted.activeReasoningEffort("user:channel"), null);
    await assert.rejects(() => restarted.setProgressLineCount("user:channel", 9), /0 to 8/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
