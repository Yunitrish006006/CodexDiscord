import test from "node:test";
import assert from "node:assert/strict";
import { createWorkspaceSync, isWorkspaceSyncEnabled, workspaceConversationCard } from "../src/workspace-sync.mjs";

const config = Object.freeze({
  workspaceSync: Object.freeze({
    url: "http://127.0.0.1:18765/",
    token: "a-long-private-sync-token",
    channelId: "423456789012345678",
    workspaceName: "workspace"
  })
});

test("workspace sync mirrors the explicit conversation contract and submits through the loopback relay", async () => {
  const requests = [];
  const sent = [];
  let clock = 10_000;
  const message = {
    async edit(payload) {
      sent.push({ edit: true, payload });
      return this;
    }
  };
  const channel = {
    async send(payload) {
      sent.push({ edit: false, payload });
      return message;
    }
  };
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    if (options.method === "POST") {
      return new Response(JSON.stringify({ status: "accepted", execution: "codex" }), { status: 202 });
    }
    if (String(url).endsWith("/api/conversation/status")) {
      return new Response(JSON.stringify({ available: true, busy: true, currentTask: { id: "task:1" } }), { status: 200 });
    }
    return new Response(JSON.stringify({
      schemaVersion: 1,
      latestRevision: 3,
      draft: { revision: 1, clientId: "viewer:1", text: "正在輸入的網頁草稿" },
      entries: [{
        revision: 2,
        source: "viewer",
        kind: "prompt",
        text: "請同步處理開發工具",
        conversationId: "viewer:prompt:1"
      }, {
        revision: 3,
        source: "workspace",
        kind: "progress",
        text: "Codex is processing the request",
        conversationId: "viewer:prompt:1"
      }]
    }), { status: 200 });
  };
  const sync = createWorkspaceSync({
    config,
    fetchImpl,
    now: () => clock,
    log: () => {}
  });

  assert.equal(sync.handlesWorkspace("workspace"), true);
  assert.equal(sync.handlesWorkspace("core"), false);
  assert.equal(isWorkspaceSyncEnabled(config, "workspace"), true);
  await sync.start({ channels: { fetch: async () => channel } });
  assert.equal(sent.length, 2, "draft preview and one coalesced status card should be created");
  assert.match(sent[0].payload.content, /網頁草稿/);
  assert.match(sent[1].payload.content, /網頁 Prompt/);

  const result = await sync.submitPrompt({ prompt: "從 Discord 送出", clientMessageId: "discord:1" });
  assert.equal(result.execution, "codex");
  const post = requests.at(-1);
  assert.equal(post.options.headers.authorization, "Bearer a-long-private-sync-token");
  assert.match(post.url, /\/api\/conversation\/prompt$/);
  assert.deepEqual(JSON.parse(post.options.body), { prompt: "從 Discord 送出", clientMessageId: "discord:1" });
  assert.deepEqual(await sync.status(), { available: true, busy: true, currentTask: { id: "task:1" } });
  assert.equal((await sync.cancel()).status, "accepted");
  sync.stop();
  clock += 10_000;
});

test("conversation cards limit Discord payloads and keep prompt content explicit", () => {
  const card = workspaceConversationCard({
    revision: 1,
    source: "discord",
    kind: "prompt",
    text: "x".repeat(2_000)
  });
  assert.match(card, /Discord Prompt/);
  assert.match(card, /已送到 TotemWorkspace/);
  assert.ok(card.length <= 1_950);
});
