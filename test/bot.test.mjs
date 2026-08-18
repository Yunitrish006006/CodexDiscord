import test from "node:test";
import assert from "node:assert/strict";
import { applyUsagePresence, approvalComponents, commandDefinition, createProgressReporter, formatQuestionResult, formatUsageResult, imageUrlsForAttachments, modelAutocompleteChoices, reasoningAutocompleteChoices, statusChunks, usagePresenceText } from "../src/bot.mjs";

test("progress cards show sanitized CLI-style activity as Discord subtext", async () => {
  const edits = [];
  const progress = createProgressReporter({
    workspaceName: "workspace",
    task: "請檢查目前的測試是否可執行",
    model: null,
    edit: async (payload) => edits.push(payload)
  });

  progress.update({ method: "item/reasoning/summaryTextDelta", params: { itemId: "reasoning-1", delta: "先確認測試與目前設定。" } });
  progress.update({ method: "item/reasoning/textDelta", params: { itemId: "reasoning-1", delta: "NEVER_SHOW_RAW_REASONING" } });
  progress.update({ method: "item/started", params: { item: { id: "test-1", type: "commandExecution", command: "npm test", status: "inProgress" } } });
  progress.update({ method: "item/commandExecution/outputDelta", params: { itemId: "test-1", delta: "NEVER_SHOW_RAW_OUTPUT" } });
  progress.update({ method: "item/completed", params: { item: { id: "test-1", type: "commandExecution", command: "npm test", status: "completed", exitCode: 0, durationMs: 1_250 } } });
  progress.update({ method: "item/started", params: { item: { id: "patch-1", type: "fileChange", changes: [{ path: "src/bot.mjs" }] } } });
  progress.update({ method: "item/started", params: { item: { id: "secret-1", type: "commandExecution", command: "curl -H 'Authorization: super-secret' https://example.com" } } });

  await progress.requestApproval({ requestId: "approval-1", kind: "file-change" }, []);
  const approvalContent = edits.at(-1).content;
  assert.match(approvalContent, /問題／需求/);
  assert.match(approvalContent, /需要你的授權才能繼續/);
  assert.doesNotMatch(approvalContent, /-# /);

  await progress.approvalSubmitted();
  const content = edits.at(-1).content;
  assert.match(content, /-# 思考：先確認測試與目前設定。/);
  assert.match(content, /-# 完成：`npm test` · exit 0 · 1.3s/);
  assert.match(content, /-# 修改檔案：src\/bot\.mjs/);
  assert.match(content, /-# 執行：本機指令（敏感內容已隱藏）/);
  assert.doesNotMatch(content, /NEVER_SHOW_RAW_REASONING|NEVER_SHOW_RAW_OUTPUT|super-secret/);

  const retainedProgress = await progress.finish();
  const final = formatQuestionResult(
    "請檢查目前的測試是否可執行",
    { exitCode: 0, message: "測試已完成。" },
    retainedProgress
  );
  assert.match(final, /問題／需求/);
  assert.match(final, /Codex 回覆/);
  assert.match(final, /測試已完成/);
  assert.match(final, /-# 思考：先確認測試與目前設定。/);
  assert.doesNotMatch(final, /npm test|本機指令|exit 0/);
  assert.ok(final.indexOf("-# 思考：") < final.indexOf("**Codex 回覆**"));
});

test("progress cards identify the Spark coding subagent", async () => {
  const edits = [];
  const progress = createProgressReporter({
    workspaceName: "workspace",
    task: "修改程式並補測試",
    model: "gpt-5.6-sol",
    progressLines: 2,
    edit: async (payload) => edits.push(payload)
  });

  progress.update({
    method: "item/completed",
    params: {
      item: {
        id: "agent-1",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "completed",
        model: "gpt-5.3-codex-spark"
      }
    }
  });
  const retainedProgress = await progress.finish();

  assert.match(edits.at(-1).content, /已啟動程式 subagent：gpt-5\.3-codex-spark/);
  assert.deepEqual(retainedProgress, ["已啟動程式 subagent：gpt-5.3-codex-spark"]);
});

test("approval cards offer task-scoped automatic approval", async () => {
  const [row] = approvalComponents("approval-token", {
    kind: "command",
    availableDecisions: ["accept", "acceptForSession", "decline"]
  });
  const buttons = row.toJSON().components;

  assert.ok(buttons.some((button) => button.custom_id === "codex:approval:approval-token:allow-all"
    && button.label === "本次工作全部允許"));
  assert.ok(buttons.some((button) => button.custom_id === "codex:approval:approval-token:decline"));
});

test("the progress command accepts zero through eight gray activity lines", () => {
  const command = commandDefinition(["workspace"]).toJSON();
  const progress = command.options.find((option) => option.name === "progress");
  const lines = progress.options.find((option) => option.name === "lines");

  assert.equal(lines.required, true);
  assert.equal(lines.min_value, 0);
  assert.equal(lines.max_value, 8);
});

test("progress cards show the configured command tail without retaining commands for the final reply", async () => {
  const edits = [];
  const progress = createProgressReporter({
    workspaceName: "workspace",
    task: "Run three checks",
    model: null,
    progressLines: 2,
    edit: async (payload) => edits.push(payload)
  });
  for (const [id, command] of [["one", "first-check"], ["two", "second-check"], ["three", "third-check"]]) {
    progress.update({ method: "item/started", params: { item: { id, type: "commandExecution", command } } });
  }

  const retainedProgress = await progress.finish();

  const content = edits.at(-1).content;
  assert.doesNotMatch(content, /first-check/);
  assert.match(content, /-# 執行：`second-check`/);
  assert.match(content, /-# 執行：`third-check`/);
  assert.equal((content.match(/^-# /gm) ?? []).length, 2);
  assert.deepEqual(retainedProgress, []);
});

test("streamed gray progress keeps the complete sentence without character truncation", async () => {
  const edits = [];
  const progress = createProgressReporter({
    workspaceName: "workspace",
    task: "Keep the complete progress sentence",
    model: null,
    edit: async (payload) => edits.push(payload)
  });
  const firstHalf = `進度句子的前半部${"很長但仍需完整保留".repeat(8)}`;
  const secondHalf = "，這是不可被截斷的結尾。";

  progress.update({ method: "item/agentMessage/delta", params: { itemId: "message-1", delta: firstHalf } });
  progress.update({ method: "item/agentMessage/delta", params: { itemId: "message-1", delta: secondHalf } });
  const retainedProgress = await progress.finish();

  assert.deepEqual(retainedProgress, [`進度：${firstHalf}${secondHalf}`]);
  assert.match(edits.at(-1).content, /這是不可被截斷的結尾。/);
});

test("unfinished streamed fragments and final-answer deltas are not retained as progress", async () => {
  const progress = createProgressReporter({
    workspaceName: "workspace",
    task: "Keep only complete progress",
    model: null,
    edit: async () => {}
  });

  progress.update({ method: "item/agentMessage/delta", params: { itemId: "partial", delta: "尚未完成的半句" } });
  progress.update({ method: "item/started", params: { item: { id: "answer", type: "agentMessage", phase: "final_answer" } } });
  progress.update({ method: "item/agentMessage/delta", params: { itemId: "answer", delta: "這是正式答案，不是進度。" } });
  progress.update({ method: "item/completed", params: { item: { id: "answer", type: "agentMessage" } } });

  assert.deepEqual(await progress.finish(), []);
});

test("a completed commentary item is retained even when no delta notification arrived", async () => {
  const progress = createProgressReporter({
    workspaceName: "workspace",
    task: "Retain completed commentary",
    model: null,
    edit: async () => {}
  });

  progress.update({
    method: "item/completed",
    params: { item: { id: "commentary", type: "agentMessage", phase: "commentary", text: "已完成檢查，接著整理結果。" } }
  });

  assert.deepEqual(await progress.finish(), ["進度：已完成檢查，接著整理結果。"]);
});

test("model autocomplete shows only the current Codex catalog plus the local default", () => {
  const models = [
    { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", isDefault: true },
    { id: "gpt-5.6-luna", displayName: "GPT-5.6 Luna", isDefault: false }
  ];

  assert.deepEqual(modelAutocompleteChoices(models), [
    { name: "Codex local default", value: "default" },
    { name: "GPT-5.6 Sol — gpt-5.6-sol", value: "gpt-5.6-sol" },
    { name: "GPT-5.6 Luna — gpt-5.6-luna", value: "gpt-5.6-luna" }
  ]);
  assert.deepEqual(modelAutocompleteChoices(models, "luna"), [
    { name: "GPT-5.6 Luna — gpt-5.6-luna", value: "gpt-5.6-luna" }
  ]);
});

test("reasoning autocomplete uses only depths supported by the active model", () => {
  const model = {
    id: "gpt-5.6-sol",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Fast responses" },
      { reasoningEffort: "medium", description: "Balanced" },
      { reasoningEffort: "high", description: "Deep analysis" }
    ]
  };

  assert.deepEqual(reasoningAutocompleteChoices(model), [
    { name: "Model default (medium)", value: "default" },
    { name: "low — Fast responses", value: "low" },
    { name: "medium — Balanced", value: "medium" },
    { name: "high — Deep analysis", value: "high" }
  ]);
  assert.deepEqual(reasoningAutocompleteChoices(model, "deep"), [
    { name: "high — Deep analysis", value: "high" }
  ]);
});

test("image uploads accept only trusted Discord image attachments for image-capable models", () => {
  const imageModel = { inputModalities: ["text", "image"] };
  const image = {
    url: "https://cdn.discordapp.com/attachments/123/456/screenshot.png",
    contentType: "image/png",
    name: "screenshot.png",
    size: 1_024
  };

  assert.deepEqual(imageUrlsForAttachments([image], imageModel), [image.url]);
  assert.throws(() => imageUrlsForAttachments([image], { inputModalities: ["text"] }), /does not support image/);
  assert.throws(() => imageUrlsForAttachments([{ ...image, contentType: "application/pdf" }], imageModel), /Only PNG/);
  assert.throws(() => imageUrlsForAttachments([{ ...image, url: "https://example.com/screenshot.png" }], imageModel), /trusted Discord CDN/);
  assert.throws(() => imageUrlsForAttachments(Array.from({ length: 5 }, () => image), imageModel), /at most 4/);
});

test("output attachment failures preserve the final text and explain the missing permission", async () => {
  const edits = [];
  const warnings = [];
  const status = {
    edit: async (payload) => {
      edits.push(payload);
      if (payload.files.length > 0) throw new Error("Missing Permissions");
    },
    channel: { send: async () => {} }
  };

  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    await statusChunks(status, "Codex finished.", [{ attachment: "/tmp/result.png", name: "result.png" }]);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(edits.length, 2);
  assert.equal(edits[1].files.length, 0);
  assert.match(edits[1].content, /Codex finished/);
  assert.match(edits[1].content, /Attach Files/);
  assert.deepEqual(warnings, ["Discord attachment upload failed for 1 file(s): Error: Missing Permissions"]);
});

test("usage results show remaining quota and Discord reset times without account details", () => {
  const content = formatUsageResult({
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        limitName: "Codex",
        primary: { usedPercent: 25, windowDurationMins: 15, resetsAt: 1_730_947_200 },
        secondary: { usedPercent: 42, windowDurationMins: 60, resetsAt: 1_730_950_800 }
      }
    },
    rateLimitResetCredits: { availableCount: 2 }
  });

  assert.match(content, /Codex 剩餘用量/);
  assert.match(content, /主要額度（15 分鐘）：剩餘 \*\*75%\*\*，將於 <t:1730947200:R> 重置/);
  assert.match(content, /次要額度（60 分鐘）：剩餘 \*\*58%\*\*，將於 <t:1730950800:R> 重置/);
  assert.match(content, /可用的額度重設次數：\*\*2\*\*/);
});

test("usage presence shows compact remaining windows on the Bot activity", () => {
  const usage = {
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 25, windowDurationMins: 300 },
      secondary: { usedPercent: 42, windowDurationMins: 10_080 }
    }
  };
  let presence = null;
  const text = applyUsagePresence({ user: { setPresence: (value) => { presence = value; } } }, usage);

  assert.equal(text, "剩餘用量：5h 75% · 7d 58%");
  assert.equal(usagePresenceText({}), "剩餘用量：暫無資料");
  assert.deepEqual(presence, {
    activities: [{ name: "剩餘用量：5h 75% · 7d 58%", type: 3 }],
    status: "online"
  });
});
