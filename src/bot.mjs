import { randomUUID } from "node:crypto";
import { ActionRowBuilder, ActivityType, ButtonBuilder, ButtonStyle, Client, Events, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from "discord.js";
import { isAllowedInteraction, isAllowedMessage } from "./config.mjs";
import { CODING_SUBAGENT_MODEL, validateModel } from "./codex-runner.mjs";
import { discordOutputImages } from "./output-images.mjs";
import { conversationKey, sessionKey, taskKey } from "./session-store.mjs";
import { createWorkspaceSync } from "./workspace-sync.mjs";

const MAX_DISCORD_MESSAGE = 1_850;
const PROGRESS_EDIT_INTERVAL_MS = 1_200;
const MAX_AUTOCOMPLETE_CHOICES = 25;
const MAX_IMAGE_ATTACHMENTS = 4;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const IMAGE_FILE_EXTENSION = /\.(?:png|jpe?g|webp|gif)$/i;
const DEFAULT_CLI_PROGRESS_LINES = 4;
const MAX_CLI_PROGRESS_LINES = 8;
const MAX_FINAL_PROGRESS_LINE = MAX_DISCORD_MESSAGE - 3;
const DISCORD_REST_TIMEOUT_MS = 5 * 60 * 1_000;
const LIVE_ONLY_ITEM_TYPES = new Set(["commandexecution", "filechange", "collabagenttoolcall", "collabtoolcall", "subagentactivity"]);

export function commandDefinition(workspaceNames) {
  const choices = workspaceNames.map((name) => ({ name, value: name }));
  const workspaceOption = (option) => option
    .setName("workspace")
    .setDescription("Allowed local workspace")
    .setRequired(true)
    .addChoices(...choices);
  return new SlashCommandBuilder()
    .setName("codex")
    .setDescription("Run the local Codex CLI in an allow-listed workspace")
    .addSubcommand((subcommand) => subcommand
      .setName("run")
      .setDescription("Start or resume your Codex session")
      .addStringOption(workspaceOption)
      .addStringOption((option) => option
        .setName("task")
        .setDescription("Coding task for Codex")
        .setRequired(true))
      .addAttachmentOption((option) => option
        .setName("image")
        .setDescription("Optional image for Codex to inspect")
        .setRequired(false)))
    .addSubcommand((subcommand) => subcommand
      .setName("status")
      .setDescription("Show your current Codex session state")
      .addStringOption(workspaceOption))
    .addSubcommand((subcommand) => subcommand
      .setName("cancel")
      .setDescription("Stop your active Codex process")
      .addStringOption(workspaceOption))
    .addSubcommand((subcommand) => subcommand
      .setName("reset")
      .setDescription("Forget your saved Codex session mapping")
      .addStringOption(workspaceOption))
    .addSubcommand((subcommand) => subcommand
      .setName("use")
      .setDescription("Use this workspace for normal messages in this channel")
      .addStringOption(workspaceOption))
    .addSubcommand((subcommand) => subcommand
      .setName("model")
      .setDescription("Select the Codex model for normal messages in this channel")
      .addStringOption((option) => option
        .setName("name")
        .setDescription("Choose a model available to this local Codex login")
        .setRequired(true)
        .setAutocomplete(true)))
    .addSubcommand((subcommand) => subcommand
      .setName("reasoning")
      .setDescription("Select the reasoning depth for the active Codex model")
      .addStringOption((option) => option
        .setName("effort")
        .setDescription("Choose a depth supported by the active model")
        .setRequired(true)
        .setAutocomplete(true)))
    .addSubcommand((subcommand) => subcommand
      .setName("progress")
      .setDescription("Set the number of gray CLI-style progress lines")
      .addIntegerOption((option) => option
        .setName("lines")
        .setDescription("Number of recent activity lines to show (0 hides them)")
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(MAX_CLI_PROGRESS_LINES)))
    .addSubcommand((subcommand) => subcommand
      .setName("usage")
      .setDescription("Show remaining Codex account usage"));
}

function modelChoiceName(model) {
  const displayName = typeof model.displayName === "string" ? model.displayName.trim() : "";
  const label = displayName && displayName !== model.id ? `${displayName} — ${model.id}` : model.id;
  return label.slice(0, 100);
}

/** Returns Discord autocomplete entries for the current App Server model catalog. */
export function modelAutocompleteChoices(models, query = "") {
  const needle = String(query).trim().toLocaleLowerCase();
  const candidates = [
    { name: "Codex local default", value: "default", id: "default", displayName: "Codex local default", isDefault: true },
    ...models
  ];
  return candidates
    .filter((model) => !needle || model.id.toLocaleLowerCase().includes(needle)
      || model.displayName.toLocaleLowerCase().includes(needle))
    .sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || left.id.localeCompare(right.id))
    .slice(0, MAX_AUTOCOMPLETE_CHOICES)
    .map((model) => ({ name: model.id === "default" ? model.name : modelChoiceName(model), value: model.id }));
}

function selectedModel(modelId, models) {
  if (modelId === "default") return null;
  if (!models.some((model) => model.id === modelId)) {
    throw new Error("That model is not currently available to this local Codex login");
  }
  return validateModel(modelId);
}

function activeCatalogModel(activeModel, models) {
  if (activeModel !== null) return models.find((model) => model.id === activeModel) ?? null;
  return models.find((model) => model.isDefault) ?? null;
}

function isDiscordImageUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:"
      && (url.hostname === "cdn.discordapp.com" || url.hostname.endsWith(".discordapp.net"));
  } catch {
    return false;
  }
}

function isImageAttachment(attachment) {
  const contentType = typeof attachment?.contentType === "string" ? attachment.contentType.toLocaleLowerCase() : "";
  return contentType === "image/png"
    || contentType === "image/jpeg"
    || contentType === "image/webp"
    || contentType === "image/gif"
    || (contentType === "" && IMAGE_FILE_EXTENSION.test(attachment?.name ?? ""));
}

/** Converts trusted Discord image attachments into Codex App Server image URLs. */
export function imageUrlsForAttachments(attachments, model) {
  const values = Array.from(attachments ?? []);
  if (values.length === 0) return [];
  if (!model?.inputModalities?.includes("image")) {
    throw new Error("The active Codex model does not support image inputs");
  }
  if (values.length > MAX_IMAGE_ATTACHMENTS) {
    throw new Error(`Attach at most ${MAX_IMAGE_ATTACHMENTS} images in one message`);
  }
  return values.map((attachment) => {
    if (!isImageAttachment(attachment)) throw new Error("Only PNG, JPEG, WebP, and GIF attachments are supported");
    if (Number.isFinite(attachment.size) && attachment.size > MAX_IMAGE_BYTES) {
      throw new Error("Each image must be at most 25 MiB");
    }
    if (!isDiscordImageUrl(attachment.url)) throw new Error("Image attachment URL is not a trusted Discord CDN URL");
    return attachment.url;
  });
}

function reasoningChoiceName(option) {
  const description = typeof option.description === "string" ? option.description.trim() : "";
  return (description ? `${option.reasoningEffort} — ${description}` : option.reasoningEffort).slice(0, 100);
}

/** Returns depth choices that the selected model explicitly advertises. */
export function reasoningAutocompleteChoices(model, query = "") {
  if (!model) return [];
  const needle = String(query).trim().toLocaleLowerCase();
  const defaultName = model.defaultReasoningEffort
    ? `Model default (${model.defaultReasoningEffort})`
    : "Model default";
  const candidates = [
    { name: defaultName, reasoningEffort: "default", description: defaultName },
    ...model.supportedReasoningEfforts
  ];
  return candidates
    .filter((option) => !needle || option.reasoningEffort.toLocaleLowerCase().includes(needle)
      || option.description.toLocaleLowerCase().includes(needle))
    .slice(0, MAX_AUTOCOMPLETE_CHOICES)
    .map((option) => ({
      name: option.reasoningEffort === "default" ? option.name : reasoningChoiceName(option),
      value: option.reasoningEffort
    }));
}

function selectedReasoningEffort(effort, model) {
  if (effort === "default") return null;
  if (!model?.supportedReasoningEfforts.some((option) => option.reasoningEffort === effort)) {
    throw new Error("That reasoning depth is not available for the active Codex model");
  }
  return effort;
}

function reasoningLabel(effort) {
  return effort ?? "model default";
}

function splitMessage(message) {
  const normalized = message.trim() || "Codex completed without a final message.";
  const chunks = [];
  let remaining = normalized;
  while (remaining.length > MAX_DISCORD_MESSAGE) {
    let cut = remaining.lastIndexOf("\n", MAX_DISCORD_MESSAGE);
    if (cut < 1) cut = MAX_DISCORD_MESSAGE;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  chunks.push(remaining);
  return chunks;
}

/**
 * Finishes a persistent status message. Long-running slash-command work uses a
 * normal bot message rather than an expiring interaction webhook, so approval
 * cards remain editable for the whole local Codex run.
 */
export async function statusChunks(status, message, files = []) {
  const [first, ...rest] = splitMessage(message);
  try {
    await status.edit({ content: first, components: [], files, allowedMentions: { parse: [] } });
  } catch (error) {
    if (error?.code === 10_008 || error?.rawError?.code === 10_008) {
      console.warn("Discord status message no longer exists; skipping its final update.");
      return false;
    }
    if (files.length === 0) throw error;
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.warn(`Discord attachment upload failed for ${files.length} file(s): ${detail}`);
    return statusChunks(status,
      `${message}\n\n（圖片附件上傳失敗；請確認 Bot 具有 Attach Files 權限，且伺服器附件大小限制足夠。）`, []);
  }
  for (const chunk of rest) {
    await status.channel.send({ content: chunk, allowedMentions: { parse: [] } });
  }
  return true;
}

/** Keeps a Discord delivery failure from terminating the Gateway event loop. */
export async function safeStatusChunks(status, content, files = []) {
  try {
    return await statusChunks(status, content, files);
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(`Could not update the Discord status message: ${detail}`);
    return false;
  }
}

async function completedTaskPayload(result, workspace) {
  const images = await discordOutputImages({
    generatedPaths: result.imagePaths ?? [],
    message: result.message,
    workspace
  });
  const warning = images.skipped > 0
    ? `\n\n（另有 ${images.skipped} 張圖片因超過限制、格式錯誤或不在允許的工作區而未上傳。）`
    : "";
  return { files: images.files, warning };
}

function resultPrefix(result) {
  if (result.timedOut) return "Codex exceeded the configured time limit and was stopped.\n\n";
  return result.exitCode === 0 ? "" : `Codex exited with status ${result.exitCode ?? "unknown"}.\n\n`;
}

function publicText(value, limit = 600) {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\s+/g, " ").replace(/@/g, "@\u200b").trim();
  return limit === null ? normalized : normalized.slice(0, limit);
}

function commandLabel(command, limit = 240) {
  const normalized = publicText(command, limit);
  if (!normalized) return "本機指令";
  if (/(token|password|secret|authorization|cookie|private[ _-]?key|\.env)/i.test(normalized)) {
    return "本機指令（敏感內容已隱藏）";
  }
  return `\`${normalized.replace(/`/g, "'")}\``;
}

function safeProgressText(value, limit = null) {
  const normalized = publicText(value, limit);
  if (!normalized) return "";
  if (/(token|password|secret|authorization|cookie|private[ _-]?key|\.env)/i.test(normalized)) {
    return "敏感內容已隱藏";
  }
  return normalized;
}

function durationLabel(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "";
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  return `${Math.round(durationMs / 100) / 10}s`;
}

function fileChangeLabel(item) {
  const paths = Array.isArray(item?.changes)
    ? item.changes.flatMap((change) => {
      const path = safeProgressText(change?.path);
      return path ? [path] : [];
    })
    : [];
  if (paths.length === 0) return "工作區檔案";
  const visible = paths.slice(0, 2).join("、");
  return paths.length > 2 ? `${visible} 等 ${paths.length} 個檔案` : visible;
}

function cliItemDetail(item, completed) {
  const type = String(item?.type ?? "").replaceAll("_", "").toLocaleLowerCase();
  const duration = durationLabel(item?.durationMs);
  const suffix = duration ? ` · ${duration}` : "";
  if (type === "commandexecution") {
    const failed = item?.status === "failed" || item?.status === "declined"
      || (Number.isInteger(item?.exitCode) && item.exitCode !== 0);
    const action = completed ? (failed ? "失敗" : "完成") : "執行";
    const exit = completed && Number.isInteger(item?.exitCode) ? ` · exit ${item.exitCode}` : "";
    return `${action}：${commandLabel(item?.command, null)}${exit}${suffix}`;
  }
  if (type === "filechange") {
    return `${completed ? "已修改" : "修改檔案"}：${fileChangeLabel(item)}`;
  }
  if (type === "mcptoolcall") {
    const name = safeProgressText([item?.server, item?.tool].filter(Boolean).join(" / ")) || "整合工具";
    return `${completed ? "工具完成" : "使用工具"}：${name}${suffix}`;
  }
  if (type === "dynamictoolcall") {
    const name = safeProgressText([item?.namespace, item?.tool].filter(Boolean).join(" / ")) || "整合工具";
    return `${completed ? "工具完成" : "使用工具"}：${name}`;
  }
  if (type === "websearch") {
    return `${completed ? "搜尋完成" : "搜尋"}：${safeProgressText(item?.query) || "網路資料"}`;
  }
  if (type === "imageview") return `檢視圖片：${safeProgressText(item?.path) || "圖片"}`;
  if (type === "imagegeneration") return completed ? "圖片產生完成" : "正在產生圖片";
  if (type === "collabagenttoolcall" || type === "collabtoolcall") {
    const model = safeProgressText(item?.model) || CODING_SUBAGENT_MODEL;
    if (item?.tool === "spawnAgent") return `${completed ? "已啟動" : "正在啟動"}程式 subagent：${model}`;
    if (item?.tool === "wait") return completed ? "程式 subagent 工作完成" : "正在等待程式 subagent";
    return `${completed ? "subagent 協調完成" : "正在協調 subagent"}：${model}`;
  }
  if (type === "subagentactivity") {
    const byKind = {
      started: "程式 subagent 已開始工作",
      interacted: "程式 subagent 正在回覆協調訊息",
      interrupted: "程式 subagent 已停止"
    };
    return byKind[item?.kind] ?? "程式 subagent 正在工作…";
  }
  return "";
}

function requestedPermissions(permissions) {
  const labels = [];
  if (permissions?.network) labels.push("網路存取");
  if (permissions?.fileSystem) labels.push("額外檔案存取");
  return labels.length ? labels.join("、") : "額外權限";
}

function approvalDescription(approval) {
  const lines = ["**需要你的授權才能繼續。**"];
  if (approval.kind === "command") {
    if (approval.network) lines.push(`網路連線：\`${approval.network.protocol}://${approval.network.host}\``);
    else lines.push(`指令：${commandLabel(approval.command)}`);
    if (approval.cwd) lines.push(`目錄：\`${publicText(approval.cwd, 180)}\``);
  } else if (approval.kind === "file-change") {
    lines.push(`檔案修改${approval.grantRoot ? `：\`${publicText(approval.grantRoot, 180)}\`` : ""}`);
  } else {
    lines.push(`請求：${requestedPermissions(approval.permissions)}`);
    if (approval.cwd) lines.push(`目錄：\`${publicText(approval.cwd, 180)}\``);
  }
  if (approval.reason) lines.push(`原因：${publicText(approval.reason, 360)}`);
  lines.push("你也可以只針對本次工作，自動允許目前及後續所有要求。");
  return lines.join("\n");
}

export function approvalComponents(token, approval) {
  const allowSession = approval.kind !== "command" || !Array.isArray(approval.availableDecisions)
    || approval.availableDecisions.includes("acceptForSession");
  const buttons = [
    new ButtonBuilder().setCustomId(`codex:approval:${token}:allow`).setLabel("允許一次").setStyle(ButtonStyle.Success)
  ];
  if (allowSession) {
    buttons.push(new ButtonBuilder().setCustomId(`codex:approval:${token}:allow-session`).setLabel("本工作階段允許").setStyle(ButtonStyle.Primary));
  }
  buttons.push(new ButtonBuilder().setCustomId(`codex:approval:${token}:allow-all`).setLabel("本次工作全部允許").setStyle(ButtonStyle.Secondary));
  buttons.push(new ButtonBuilder().setCustomId(`codex:approval:${token}:decline`).setLabel("拒絕").setStyle(ButtonStyle.Danger));
  return [new ActionRowBuilder().addComponents(...buttons)];
}

function questionText(task) {
  return publicText(task, 720) || "（未提供）";
}

function splitProgressLine(text, limit = MAX_FINAL_PROGRESS_LINE) {
  const chunks = [];
  let remaining = safeProgressText(text);
  while (remaining.length > limit) {
    const candidate = remaining.slice(0, limit + 1);
    const endings = [...candidate.matchAll(/[。！？!?；;](?:["'”’）)\]]*)|\.(?=\s|$)/gu)];
    let cut = endings.at(-1)?.index;
    if (Number.isSafeInteger(cut)) cut += endings.at(-1)[0].length;
    if (!Number.isSafeInteger(cut) || cut < Math.floor(limit / 3)) cut = candidate.lastIndexOf(" ", limit);
    if (cut < 1) cut = limit;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function progressSubtextLines(progressLines) {
  if (!Array.isArray(progressLines)) return [];
  return progressLines.flatMap((line) => splitProgressLine(line).map((part) => `-# ${part}`));
}

export function formatQuestionResult(task, result, progressLines = []) {
  const lines = [
    "**問題／需求**",
    questionText(task),
  ];
  const progress = progressSubtextLines(progressLines);
  if (progress.length > 0) lines.push("", ...progress);
  lines.push(
    "",
    "**Codex 回覆**",
    `${resultPrefix(result)}${result.message}`
  );
  return lines.join("\n");
}

function rateLimitWindowLine(label, window) {
  if (!window || !Number.isFinite(window.usedPercent)) return null;
  const usedPercent = Math.max(0, Math.min(100, window.usedPercent));
  const remainingPercent = Math.round((100 - usedPercent) * 10) / 10;
  const duration = Number.isSafeInteger(window.windowDurationMins) && window.windowDurationMins > 0
    ? `（${window.windowDurationMins} 分鐘）`
    : "";
  const resetAt = Number.isSafeInteger(window.resetsAt) && window.resetsAt > 0
    ? `，將於 <t:${window.resetsAt}:R> 重置`
    : "";
  return `- ${label}${duration}：剩餘 **${remainingPercent}%**${resetAt}`;
}

function rateLimitSnapshots(usage) {
  const multiBucket = usage?.rateLimitsByLimitId;
  if (multiBucket && typeof multiBucket === "object" && !Array.isArray(multiBucket)) {
    return Object.values(multiBucket).filter((snapshot) => snapshot && typeof snapshot === "object");
  }
  return usage?.rateLimits && typeof usage.rateLimits === "object" && !Array.isArray(usage.rateLimits)
    ? [usage.rateLimits]
    : [];
}

function usageWindowDuration(windowDurationMins) {
  if (!Number.isSafeInteger(windowDurationMins) || windowDurationMins <= 0) return "";
  if (windowDurationMins % 1_440 === 0) return `${windowDurationMins / 1_440}d`;
  if (windowDurationMins % 60 === 0) return `${windowDurationMins / 60}h`;
  return `${windowDurationMins}m`;
}

function remainingUsagePercent(window) {
  if (!window || !Number.isFinite(window.usedPercent)) return null;
  const usedPercent = Math.max(0, Math.min(100, window.usedPercent));
  return Math.round((100 - usedPercent) * 10) / 10;
}

/** Formats a compact Discord activity label from the current Codex quota windows. */
export function usagePresenceText(usage) {
  const snapshots = rateLimitSnapshots(usage);
  const includeLimitNames = snapshots.length > 1;
  const windows = snapshots.flatMap((snapshot, snapshotIndex) => {
    const limitName = publicText(snapshot.limitName, 24) || publicText(snapshot.limitId, 24) || `額度 ${snapshotIndex + 1}`;
    return [snapshot.primary, snapshot.secondary].flatMap((window) => {
      const remaining = remainingUsagePercent(window);
      if (remaining === null) return [];
      const duration = usageWindowDuration(window.windowDurationMins);
      const prefix = includeLimitNames ? `${limitName} ` : "";
      return [`${prefix}${duration ? `${duration} ` : ""}${remaining}%`];
    });
  });
  return (windows.length > 0 ? `剩餘用量：${windows.join(" · ")}` : "剩餘用量：暫無資料").slice(0, 128);
}

/** Updates the Bot's visible Discord activity without exposing account details. */
export function applyUsagePresence(client, usage) {
  const text = usagePresenceText(usage);
  client.user?.setPresence({
    activities: [{ name: text, type: ActivityType.Watching }],
    status: "online"
  });
  return text;
}

/** Formats the authenticated Codex account's currently reported quota windows. */
export function formatUsageResult(usage) {
  const lines = ["**Codex 剩餘用量**"];
  const snapshots = rateLimitSnapshots(usage);
  if (snapshots.length === 0) {
    lines.push("目前沒有可顯示的用量窗口。");
    return lines.join("\n");
  }

  for (const [index, snapshot] of snapshots.entries()) {
    const label = publicText(snapshot.limitName, 100) || publicText(snapshot.limitId, 100) || `額度 ${index + 1}`;
    const windows = [
      rateLimitWindowLine("主要額度", snapshot.primary),
      rateLimitWindowLine("次要額度", snapshot.secondary)
    ].filter(Boolean);
    lines.push("", `**${label}**`);
    if (windows.length > 0) lines.push(...windows);
    else lines.push("- 此額度目前沒有可顯示的剩餘百分比。");
    if (snapshot.rateLimitReachedType) lines.push("- **目前已達到此額度上限。**");
  }

  if (Number.isSafeInteger(usage?.rateLimitResetCredits?.availableCount)) {
    lines.push("", `可用的額度重設次數：**${usage.rateLimitResetCredits.availableCount}**`);
  }
  return lines.join("\n").slice(0, MAX_DISCORD_MESSAGE);
}

/**
 * Builds one durable status card. It keeps the Discord question visible while
 * work is in progress and renders a short, sanitized CLI-style activity tail
 * using Discord subtext. Raw command output and raw reasoning stay local.
 */
export function createProgressReporter({ workspaceName, task, model, reasoningEffort, progressLines = DEFAULT_CLI_PROGRESS_LINES, imageCount = 0, edit }) {
  if (!Number.isSafeInteger(progressLines) || progressLines < 0 || progressLines > MAX_CLI_PROGRESS_LINES) {
    throw new Error(`Progress line count must be an integer from 0 to ${MAX_CLI_PROGRESS_LINES}`);
  }
  let activity = "正在分析需求…";
  let approval = null;
  let timer = null;
  let closed = false;
  let lastEditAt = 0;
  let pendingEdit = Promise.resolve();
  const cliProgress = [];
  const retainedProgress = [];
  const streamedProgress = new Map();
  const itemPhases = new Map();

  const setCliProgress = (key, value, retainMode = "replace") => {
    if (progressLines === 0) return;
    const text = safeProgressText(value);
    if (!text) return;
    const existing = cliProgress.findIndex((entry) => entry.key === key);
    if (existing >= 0) cliProgress.splice(existing, 1);
    cliProgress.push({ key, text });
    while (cliProgress.length > progressLines) cliProgress.shift();

    if (retainMode === "none") return;
    if (retainMode === "append") {
      if (retainedProgress.at(-1)?.text !== text) retainedProgress.push({ key: `${key}:${retainedProgress.length}`, text });
      return;
    }
    const retained = retainedProgress.findIndex((entry) => entry.key === key);
    if (retained >= 0) retainedProgress[retained] = { key, text };
    else retainedProgress.push({ key, text });
  };
  const removeCliProgress = (key) => {
    const visible = cliProgress.findIndex((entry) => entry.key === key);
    if (visible >= 0) cliProgress.splice(visible, 1);
    const retained = retainedProgress.findIndex((entry) => entry.key === key);
    if (retained >= 0) retainedProgress.splice(retained, 1);
  };
  const completeSentencePrefix = (value) => {
    let boundary = -1;
    for (const match of value.matchAll(/(?:\r?\n+)|[。！？!?；;](?:["'”’）)\]]*)|\.(?=\s|$)/gu)) {
      boundary = match.index + match[0].length;
    }
    return boundary < 0 ? "" : value.slice(0, boundary);
  };
  const appendStreamedProgress = (key, itemId, prefix, delta) => {
    if (typeof delta !== "string" || !delta) return;
    const current = streamedProgress.get(key) ?? { itemId, prefix, text: "" };
    current.text += delta;
    streamedProgress.set(key, current);
    const complete = completeSentencePrefix(current.text);
    if (complete) setCliProgress(key, `${prefix}${complete}`);
  };
  const finalizeStreamedProgress = (itemId = null, includeRemainder = false) => {
    for (const [key, progress] of streamedProgress) {
      if (itemId !== null && progress.itemId !== itemId) continue;
      if (itemPhases.get(progress.itemId) === "final_answer") {
        removeCliProgress(key);
      } else {
        const complete = includeRemainder ? progress.text : completeSentencePrefix(progress.text);
        if (complete) setCliProgress(key, `${progress.prefix}${complete}`);
      }
      streamedProgress.delete(key);
    }
  };

  const content = () => {
    const lines = [
      "**問題／需求**",
      questionText(task),
      "",
      `Codex 正在 **${workspaceName}** 使用 **${model ?? "local default"}**（思考深度：**${reasoningLabel(reasoningEffort)}**）工作…`,
      imageCount > 0 ? `已附上 ${imageCount} 張圖片。` : null,
      activity
    ].filter(Boolean);
    if (!approval && cliProgress.length > 0) {
      const groups = cliProgress.map((entry) => progressSubtextLines([entry.text]));
      const progress = [];
      for (let index = groups.length - 1; index >= 0; index -= 1) {
        const candidate = [...groups[index], ...progress];
        if ([...lines, "", ...candidate].join("\n").length <= MAX_DISCORD_MESSAGE) {
          progress.unshift(...groups[index]);
        }
      }
      if (progress.length > 0) lines.push("", ...progress);
    }
    if (approval) lines.push("", approvalDescription(approval.value));
    return lines.join("\n");
  };
  const flush = async () => {
    if (closed) return;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    lastEditAt = Date.now();
    const payload = { content: content(), components: approval?.components ?? [], allowedMentions: { parse: [] } };
    pendingEdit = pendingEdit.catch(() => {}).then(() => edit(payload)).catch(() => {});
    await pendingEdit;
  };
  const schedule = (immediate = false) => {
    if (closed) return;
    if (immediate) {
      void flush();
      return;
    }
    if (timer) return;
    const delay = Math.max(0, PROGRESS_EDIT_INTERVAL_MS - (Date.now() - lastEditAt));
    timer = setTimeout(() => { void flush(); }, delay);
  };
  const update = (event) => {
    const method = event?.method ?? event?.type;
    const params = event?.params ?? event ?? {};
    if (method === "item/reasoning/summaryTextDelta") {
      activity = "正在思考與規劃…";
      appendStreamedProgress(`reasoning:${params.itemId ?? "active"}`, params.itemId ?? "active", "思考：", params.delta);
    } else if (method === "item/reasoning/textDelta") {
      activity = "正在思考與規劃…";
    } else if (method === "item/plan/delta") {
      activity = "正在更新執行計畫…";
      appendStreamedProgress(`plan:${params.itemId ?? "active"}`, params.itemId ?? "active", "計畫：", params.delta);
    } else if (method === "item/agentMessage/delta") {
      activity = "正在整理回覆…";
      if (itemPhases.get(params.itemId) !== "final_answer") {
        appendStreamedProgress(`message:${params.itemId ?? "active"}`, params.itemId ?? "active", "進度：", params.delta);
      }
    } else if (method === "item/mcpToolCall/progress") {
      activity = "正在使用整合工具…";
      setCliProgress(`tool-progress:${params.itemId ?? "active"}`, `工具：${params.message ?? "正在處理"}`, "append");
    } else if (method === "item/started" || method === "item/completed") {
      const item = params.item ?? {};
      const itemType = String(item.type ?? "").replaceAll("_", "").toLocaleLowerCase();
      if (item.id && itemType === "agentmessage" && typeof item.phase === "string") itemPhases.set(item.id, item.phase);
      if (method === "item/completed" && item.id) finalizeStreamedProgress(item.id, true);
      if (method === "item/completed" && item.id && itemType === "agentmessage") {
        const key = `message:${item.id}`;
        if (itemPhases.get(item.id) === "final_answer") removeCliProgress(key);
        else if (typeof item.text === "string" && item.text.trim()) setCliProgress(key, `進度：${item.text}`);
      }
      const detail = cliItemDetail(item, method === "item/completed");
      if (detail) {
        const retainMode = LIVE_ONLY_ITEM_TYPES.has(itemType) ? "none" : "append";
        setCliProgress(`item:${item.id ?? itemType}`, detail, retainMode);
      }
      if (itemType === "commandexecution") activity = "正在執行本機工作…";
      else if (itemType === "filechange") activity = "正在修改工作區檔案…";
      else if (itemType === "collabagenttoolcall" || itemType === "collabtoolcall" || itemType === "subagentactivity") activity = `正在協調 ${CODING_SUBAGENT_MODEL} subagent…`;
      else if (itemType === "mcptoolcall" || itemType === "dynamictoolcall") activity = "正在使用整合工具…";
      else if (itemType === "agentmessage") activity = "正在整理回覆…";
      else if (itemType === "websearch") activity = "正在搜尋資料…";
    } else if (method === "turn/started") {
      activity = "正在處理需求…";
    } else if (method === "turn/completed") {
      activity = "正在整理最終回覆…";
    } else if (method === "bridge/sessionReset") {
      activity = "舊工作階段無法恢復，正在建立新的工作階段…";
    } else if (method === "bridge/gradleAutoApproved") {
      activity = "已自動同意 Gradle 編譯／測試，正在繼續…";
    } else if (method === "bridge/allPermissionsAutoApproved") {
      activity = "本次工作已自動同意權限要求，正在繼續…";
    }
    schedule();
  };

  return {
    update,
    async requestApproval(value, components) {
      approval = { value, components };
      activity = "正在等待你的授權…";
      await flush();
    },
    async approvalSubmitted(autoApproveAll = false) {
      approval = null;
      activity = autoApproveAll
        ? "本次工作將自動同意目前及後續所有權限要求，正在繼續…"
        : "已送出你的授權決定，正在繼續…";
      await flush();
    },
    async resolveApproval(requestId) {
      if (approval?.value?.requestId === String(requestId)) {
        approval = null;
        await flush();
      }
    },
    async steeringReceived() {
      activity = "已收到導正，正在調整方向…";
      await flush();
    },
    async finish() {
      finalizeStreamedProgress();
      await flush();
      closed = true;
      return retainedProgress.map((entry) => entry.text);
    }
  };
}

/** True only for a reply from the task owner in the status message's channel. */
export function isReplyToActiveStatus(message, activeTask) {
  const referenceId = message?.reference?.messageId ?? message?.reference?.message_id;
  return Boolean(activeTask
    && typeof referenceId === "string"
    && referenceId === activeTask.statusMessageId
    && message?.author?.id === activeTask.userId
    && message?.channelId === activeTask.channelId);
}

async function acknowledgeSteering(message) {
  if (typeof message?.react !== "function") return;
  try {
    await message.react("↪️");
  } catch {
    // Reactions are only an unobtrusive acknowledgement; missing permission is fine.
  }
}

async function runTask({ config, runner, sessions, userId, channelId, workspaceName, task, model = null, reasoningEffort = null, imageUrls = [], onProgress = () => {}, onApproval = () => {} }) {
  const workspaceConfig = config.workspaces.get(workspaceName);
  if (!workspaceConfig) throw new Error("That workspace is not configured");
  const savedKey = sessionKey({ userId, channelId, workspace: workspaceName });
  const activeKey = taskKey({ userId, workspace: workspaceName });
  const saved = sessions.get(savedKey);
  const result = await runner.execute({
    key: activeKey,
    workspace: workspaceConfig.path,
    prompt: task,
    model,
    reasoningEffort,
    imageUrls,
    skipGitRepoCheck: workspaceConfig.allowNonGit,
    resumeSessionId: saved?.sessionId ?? null,
    onSessionId: async (sessionId) => {
      await sessions.set(savedKey, { sessionId, workspace: workspaceName, updatedAt: new Date().toISOString() });
    },
    onProgress,
    onApproval
  });
  if (result.sessionId && result.sessionId !== saved?.sessionId) {
    await sessions.set(savedKey, { sessionId: result.sessionId, workspace: workspaceName, updatedAt: new Date().toISOString() });
  }
  return { key: activeKey, result };
}

export async function registerCommands(config) {
  const rest = new REST({ version: "10" }).setToken(config.botToken);
  await rest.put(Routes.applicationGuildCommands(config.applicationId, config.guildId), {
    body: [commandDefinition([...config.workspaces.keys()]).toJSON()]
  });
}

export async function startBot({ config, runner, sessions, models = [] }) {
  const approvals = new Map();
  const activeTasks = new Map();
  const workspaceSync = createWorkspaceSync({ config });
  const catalogWorkspace = config.workspaces.values().next().value;
  let usagePresenceRefresh = Promise.resolve();
  const refreshUsagePresence = () => {
    usagePresenceRefresh = usagePresenceRefresh
      .then(async () => applyUsagePresence(client, await runner.getUsage({ workspace: catalogWorkspace.path })))
      .catch((error) => { console.warn(`Could not refresh Codex usage presence: ${error.message}`); });
    return usagePresenceRefresh;
  };
  const registerApproval = ({ approval, key, userId, channelId, progress }) => {
    const token = randomUUID();
    approvals.set(token, {
      ...approval,
      key,
      userId,
      channelId,
      progress
    });
    return token;
  };
  const resolveApproval = async (key, requestId) => {
    for (const [token, approval] of approvals) {
      if (approval.key === key && approval.requestId === String(requestId)) {
        approvals.delete(token);
        await approval.progress.resolveApproval(requestId);
      }
    }
  };
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ],
    rest: {
      timeout: DISCORD_REST_TIMEOUT_MS,
      retries: 1
    }
  });
  client.once(Events.ClientReady, (readyClient) => {
    console.info(`CodexDiscord ready as ${readyClient.user.tag}`);
    void refreshUsagePresence();
    void workspaceSync.start(readyClient);
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isAutocomplete()) {
      if (interaction.commandName !== "codex" || !isAllowedInteraction(interaction, config)) {
        await interaction.respond([]);
        return;
      }
      const focused = interaction.options.getFocused(true);
      const action = interaction.options.getSubcommand(false);
      const conversation = conversationKey({ userId: interaction.user.id, channelId: interaction.channelId });
      if (action === "model" && focused.name === "name") {
        await interaction.respond(modelAutocompleteChoices(models, focused.value));
        return;
      }
      if (action === "reasoning" && focused.name === "effort") {
        const model = activeCatalogModel(sessions.activeModel(conversation), models);
        await interaction.respond(reasoningAutocompleteChoices(model, focused.value));
        return;
      }
      if (action !== "model" && action !== "reasoning") {
        await interaction.respond([]);
        return;
      }
      await interaction.respond([]);
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith("codex:approval:")) {
      const [, , token, choice] = interaction.customId.split(":");
      const approval = approvals.get(token);
      if (!approval) {
        approvals.delete(token);
        await interaction.update({ components: [] });
        await interaction.followUp({
          content: "This Codex approval is no longer active. The task may have finished, been cancelled, or the bot was restarted.",
          ephemeral: true,
          allowedMentions: { parse: [] }
        });
        return;
      }
      if (!isAllowedInteraction(interaction, config) || interaction.user.id !== approval.userId || interaction.channelId !== approval.channelId) {
        await interaction.reply({ content: "You are not allowed to answer this Codex approval.", ephemeral: true, allowedMentions: { parse: [] } });
        return;
      }
      await interaction.deferUpdate();
      const autoApproveAll = choice === "allow-all";
      const accepted = autoApproveAll
        ? runner.approveAll(approval.key, approval.requestId)
        : runner.approve(approval.key, approval.requestId, choice);
      approvals.delete(token);
      if (accepted) {
        if (autoApproveAll) {
          for (const [pendingToken, pendingApproval] of approvals) {
            if (pendingApproval.key === approval.key) approvals.delete(pendingToken);
          }
        }
        await approval.progress.approvalSubmitted(autoApproveAll);
      }
      else {
        await approval.progress.resolveApproval(approval.requestId);
        await interaction.followUp({
          content: "This Codex approval is no longer pending.",
          ephemeral: true,
          allowedMentions: { parse: [] }
        });
      }
      return;
    }
    if (!interaction.isChatInputCommand() || interaction.commandName !== "codex") return;
    if (!isAllowedInteraction(interaction, config)) {
      await interaction.reply({ content: "You are not allowed to run local Codex here.", ephemeral: true, allowedMentions: { parse: [] } });
      return;
    }
    const action = interaction.options.getSubcommand();
    const conversation = conversationKey({ userId: interaction.user.id, channelId: interaction.channelId });
    if (action === "model") {
      try {
        const model = selectedModel(interaction.options.getString("name", true), models);
        await sessions.setActiveModel(conversation, model);
        await sessions.setActiveReasoningEffort(conversation, null);
        await interaction.reply({
          content: model
            ? `Normal messages in this channel will now use **${model}**. Reasoning depth was reset to the model default.`
            : "Normal messages in this channel will now use the local Codex default model and its default reasoning depth.",
          ephemeral: true,
          allowedMentions: { parse: [] }
        });
      } catch (error) {
        await interaction.reply({ content: `Invalid model: ${error.message}`, ephemeral: true, allowedMentions: { parse: [] } });
      }
      return;
    }
    if (action === "reasoning") {
      try {
        const model = activeCatalogModel(sessions.activeModel(conversation), models);
        if (!model) throw new Error("Select an available Codex model before choosing a reasoning depth");
        const reasoningEffort = selectedReasoningEffort(interaction.options.getString("effort", true), model);
        await sessions.setActiveReasoningEffort(conversation, reasoningEffort);
        await interaction.reply({
          content: reasoningEffort
            ? `Reasoning depth for **${model.id}** is now **${reasoningEffort}**.`
            : `Reasoning depth for **${model.id}** now uses the model default.`,
          ephemeral: true,
          allowedMentions: { parse: [] }
        });
      } catch (error) {
        await interaction.reply({ content: `Invalid reasoning depth: ${error.message}`, ephemeral: true, allowedMentions: { parse: [] } });
      }
      return;
    }
    if (action === "progress") {
      const lines = interaction.options.getInteger("lines", true);
      await sessions.setProgressLineCount(conversation, lines);
      await interaction.reply({
        content: lines === 0
          ? "CLI-style gray progress lines are now hidden for this channel."
          : `CLI-style progress will show the latest **${lines}** gray line${lines === 1 ? "" : "s"} while running and retain the full history above the final reply.`,
        ephemeral: true,
        allowedMentions: { parse: [] }
      });
      return;
    }
    if (action === "usage") {
      try {
        await interaction.deferReply({ ephemeral: true });
        const usage = await runner.getUsage({ workspace: catalogWorkspace.path });
        applyUsagePresence(client, usage);
        await interaction.editReply({ content: formatUsageResult(usage), allowedMentions: { parse: [] } });
      } catch (error) {
        const message = `Codex usage query failed: ${error.message}`;
        if (interaction.deferred || interaction.replied) await interaction.editReply({ content: message, allowedMentions: { parse: [] } });
        else await interaction.reply({ content: message, ephemeral: true, allowedMentions: { parse: [] } });
      }
      return;
    }
    const workspaceName = interaction.options.getString("workspace", true);
    const workspaceConfig = config.workspaces.get(workspaceName);
    if (!workspaceConfig) {
      await interaction.reply({ content: "That workspace is not configured.", ephemeral: true, allowedMentions: { parse: [] } });
      return;
    }
    const savedKey = sessionKey({ userId: interaction.user.id, channelId: interaction.channelId, workspace: workspaceName });
    const activeKey = taskKey({ userId: interaction.user.id, workspace: workspaceName });
    let status = null;
    let task = "";
    let taskStarted = false;
    let progress = null;
    let activeTask = null;
    try {
      if (action === "status") {
        if (workspaceSync.handlesWorkspace(workspaceName)) {
          try {
            const shared = await workspaceSync.status();
            const state = shared.busy ? `running (${shared.currentTask?.id ?? "task"})` : shared.available ? "idle" : "adapter unavailable";
            await interaction.reply({ content: `Shared TotemWorkspace Codex queue: ${state}.`, ephemeral: true, allowedMentions: { parse: [] } });
          } catch (error) {
            await interaction.reply({ content: `Could not query the shared TotemWorkspace queue: ${error.message}`, ephemeral: true, allowedMentions: { parse: [] } });
          }
          return;
        }
        const saved = sessions.get(savedKey);
        const state = runner.isRunning(activeKey) ? "running" : saved ? "ready to resume" : "new";
        const model = sessions.activeModel(conversation) ?? "local default";
        const reasoningEffort = reasoningLabel(sessions.activeReasoningEffort(conversation));
        const progressLines = sessions.progressLineCount(conversation) ?? DEFAULT_CLI_PROGRESS_LINES;
        await interaction.reply({ content: `Codex session for **${workspaceName}**: ${state}. Model: **${model}**. Reasoning depth: **${reasoningEffort}**. Gray progress lines: **${progressLines}**.`, ephemeral: true, allowedMentions: { parse: [] } });
        return;
      }
      if (action === "cancel") {
        if (workspaceSync.handlesWorkspace(workspaceName)) {
          try {
            const result = await workspaceSync.cancel();
            await interaction.reply({
              content: result.status === "cancelling"
                ? "Sent a cancellation request to the shared TotemWorkspace Codex task."
                : "The shared TotemWorkspace Codex queue is already idle.",
              ephemeral: true,
              allowedMentions: { parse: [] }
            });
          } catch (error) {
            await interaction.reply({ content: `Could not cancel the shared TotemWorkspace task: ${error.message}`, ephemeral: true, allowedMentions: { parse: [] } });
          }
          return;
        }
        const stopped = runner.cancel(activeKey);
        await interaction.reply({ content: stopped ? "Sent a stop request to your active Codex task." : "No active Codex task for this workspace.", ephemeral: true, allowedMentions: { parse: [] } });
        return;
      }
      if (action === "reset") {
        if (runner.isRunning(activeKey)) throw new Error("Cancel the active task before resetting its session");
        const deleted = await sessions.delete(savedKey);
        await interaction.reply({ content: deleted ? "Saved Codex session mapping removed." : "No saved Codex session mapping exists.", ephemeral: true, allowedMentions: { parse: [] } });
        return;
      }
      if (action === "use") {
        await sessions.setActiveWorkspace(conversation, workspaceName);
        await interaction.reply({ content: `Normal messages in this channel will now use **${workspaceName}**.`, ephemeral: true, allowedMentions: { parse: [] } });
        return;
      }

      task = interaction.options.getString("task", true);
      if (workspaceSync.handlesWorkspace(workspaceName)) {
        if (interaction.options.getAttachment("image", false)) {
          await interaction.reply({
            content: "The shared TotemWorkspace prompt channel currently accepts text only.",
            ephemeral: true,
            allowedMentions: { parse: [] }
          });
          return;
        }
        await interaction.deferReply();
        status = await interaction.fetchReply();
        const relay = await workspaceSync.submitPrompt({
          prompt: task,
          clientMessageId: `interaction:${interaction.id}`
        });
        await status.edit({
          content: relay.execution === "codex"
            ? "Prompt sent to the shared TotemWorkspace Codex queue. Progress is mirrored below."
            : "Prompt was recorded by TotemWorkspace; check the mirrored status for its execution state.",
          allowedMentions: { parse: [] }
        });
        return;
      }
      const model = sessions.activeModel(conversation);
      const activeModel = activeCatalogModel(model, models);
      const attachment = interaction.options.getAttachment("image", false);
      const imageUrls = imageUrlsForAttachments(attachment ? [attachment] : [], activeModel);
      if (runner.isRunning(activeKey)) {
        await interaction.reply({
          content: "Codex is already working on this workspace in another Discord thread. Reply to that task's status card to steer it, or use `/codex cancel` first.",
          ephemeral: true,
          allowedMentions: { parse: [] }
        });
        return;
      }
      // Interaction webhooks expire, while a normal bot message can carry a
      // long-running approval card and receive the final result safely.
      await interaction.deferReply();
      status = await interaction.fetchReply();
      await sessions.setActiveWorkspace(conversation, workspaceName);
      const reasoningEffort = sessions.activeReasoningEffort(conversation);
      progress = createProgressReporter({
        workspaceName,
        task,
        model,
        reasoningEffort,
        progressLines: sessions.progressLineCount(conversation) ?? DEFAULT_CLI_PROGRESS_LINES,
        imageCount: imageUrls.length,
        edit: (payload) => status.edit(payload)
      });
      taskStarted = true;
      activeTask = {
        key: activeKey,
        mapKey: savedKey,
        userId: interaction.user.id,
        channelId: interaction.channelId,
        workspaceName,
        statusMessageId: status.id,
        progress,
        model: activeModel
      };
      activeTasks.set(savedKey, activeTask);
      const { result } = await runTask({
        config, runner, sessions, userId: interaction.user.id, channelId: interaction.channelId, workspaceName, task,
        model,
        reasoningEffort,
        imageUrls,
        onProgress: async (event) => {
          if (event?.method === "serverRequest/resolved") await resolveApproval(activeKey, event.params?.requestId);
          progress.update(event);
        },
        onApproval: async (approval) => {
          const token = registerApproval({ approval, key: activeKey, userId: interaction.user.id, channelId: interaction.channelId, progress });
          await progress.requestApproval(approval, approvalComponents(token, approval));
        }
      });
      const retainedProgress = await progress.finish();
      const output = await completedTaskPayload(result, workspaceConfig.path);
      await safeStatusChunks(status, `${formatQuestionResult(task, result, retainedProgress)}${output.warning}`, output.files);
    } catch (error) {
      const message = `Codex request failed: ${error.message}`;
      if (status) {
        const retainedProgress = progress ? await progress.finish() : [];
        await safeStatusChunks(status, formatQuestionResult(task, { exitCode: 1, message }, retainedProgress));
      }
      else if (interaction.deferred || interaction.replied) await interaction.editReply({ content: message, allowedMentions: { parse: [] } });
      else await interaction.reply({ content: message, ephemeral: true, allowedMentions: { parse: [] } });
    } finally {
      if (activeTask && activeTasks.get(activeTask.mapKey) === activeTask) activeTasks.delete(activeTask.mapKey);
      if (taskStarted) void refreshUsagePresence();
    }
  });
  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.guildId || (!message.content.trim() && message.attachments.size === 0) || !isAllowedMessage(message, config)) return;
    const conversation = conversationKey({ userId: message.author.id, channelId: message.channelId });
    const replyTask = [...activeTasks.values()].find((activeTask) => isReplyToActiveStatus(message, activeTask));
    if (replyTask) {
      let imageUrls;
      try {
        imageUrls = imageUrlsForAttachments(message.attachments.values(), replyTask.model);
      } catch (error) {
        await message.reply({ content: `Codex image upload failed: ${error.message}`, allowedMentions: { parse: [] } });
        return;
      }
      const steeringTask = message.content.trim() || "請檢視我上傳的圖片，並依此導正目前工作。";
      try {
        await runner.steer(replyTask.key, {
          prompt: steeringTask,
          imageUrls,
          clientUserMessageId: message.id
        });
        await replyTask.progress.steeringReceived();
        await acknowledgeSteering(message);
      } catch (error) {
        await message.reply({
          content: `無法導正目前的 Codex 工作：${error.message}`,
          allowedMentions: { parse: [] }
        });
      }
      return;
    }
    const workspaceName = sessions.activeWorkspace(conversation) ?? "workspace";
    const workspaceConfig = config.workspaces.get(workspaceName);
    if (!workspaceConfig) {
      await message.reply({ content: "No active workspace is configured. Use `/codex use` once.", allowedMentions: { parse: [] } });
      return;
    }
    const task = message.content.trim() || "請檢視我上傳的圖片，說明你看到的內容並依此處理。";
    if (workspaceSync.handlesWorkspace(workspaceName)) {
      if (message.attachments.size > 0) {
        await message.reply({
          content: "The shared TotemWorkspace prompt channel currently accepts text only.",
          allowedMentions: { parse: [] }
        });
        return;
      }
      try {
        const relay = await workspaceSync.submitPrompt({ prompt: task, clientMessageId: message.id });
        await message.reply({
          content: relay.execution === "codex"
            ? "已送到共用 TotemWorkspace Codex 佇列；處理進度會同步到這裡與網頁。"
            : "Prompt 已由 TotemWorkspace 記錄；請查看同步狀態。",
          allowedMentions: { parse: [] }
        });
      } catch (error) {
        await message.reply({
          content: `無法送到 TotemWorkspace：${error.message}`,
          allowedMentions: { parse: [] }
        });
      }
      return;
    }
    const model = sessions.activeModel(conversation);
    const reasoningEffort = sessions.activeReasoningEffort(conversation);
    let imageUrls;
    try {
      imageUrls = imageUrlsForAttachments(message.attachments.values(), activeCatalogModel(model, models));
    } catch (error) {
      await message.reply({ content: `Codex image upload failed: ${error.message}`, allowedMentions: { parse: [] } });
      return;
    }
    const savedKey = sessionKey({ userId: message.author.id, channelId: message.channelId, workspace: workspaceName });
    const activeKey = taskKey({ userId: message.author.id, workspace: workspaceName });
    if (runner.isRunning(activeKey)) {
      await message.reply({ content: "Codex is already working on this workspace, possibly in another Discord thread. Reply to that task's status card to steer it, or use `/codex cancel` first.", allowedMentions: { parse: [] } });
      return;
    }
    const modelLabel = model ?? "local default";
    const status = await message.reply({ content: `Codex is working in **${workspaceName}** with **${modelLabel}** at **${reasoningLabel(reasoningEffort)}** reasoning depth${imageUrls.length ? ` and ${imageUrls.length} image(s)` : ""}…`, allowedMentions: { parse: [] } });
    const progress = createProgressReporter({
      workspaceName,
      task,
      model,
      reasoningEffort,
      progressLines: sessions.progressLineCount(conversation) ?? DEFAULT_CLI_PROGRESS_LINES,
      imageCount: imageUrls.length,
      edit: (payload) => status.edit(payload)
    });
    const activeTask = {
      key: activeKey,
      mapKey: savedKey,
      userId: message.author.id,
      channelId: message.channelId,
      workspaceName,
      statusMessageId: status.id,
      progress,
      model: activeCatalogModel(model, models)
    };
    activeTasks.set(savedKey, activeTask);
    try {
      const { result } = await runTask({
        config, runner, sessions, userId: message.author.id, channelId: message.channelId, workspaceName, task, model, reasoningEffort, imageUrls,
        onProgress: async (event) => {
          if (event?.method === "serverRequest/resolved") await resolveApproval(activeKey, event.params?.requestId);
          progress.update(event);
        },
        onApproval: async (approval) => {
          const token = registerApproval({ approval, key: activeKey, userId: message.author.id, channelId: message.channelId, progress });
          await progress.requestApproval(approval, approvalComponents(token, approval));
        }
      });
      const retainedProgress = await progress.finish();
      const output = await completedTaskPayload(result, workspaceConfig.path);
      await safeStatusChunks(status, `${formatQuestionResult(task, result, retainedProgress)}${output.warning}`, output.files);
    } catch (error) {
      const retainedProgress = await progress.finish();
      await safeStatusChunks(status,
        formatQuestionResult(task, { exitCode: 1, message: `Codex request failed: ${error.message}` }, retainedProgress));
    } finally {
      if (activeTasks.get(savedKey) === activeTask) activeTasks.delete(savedKey);
      void refreshUsagePresence();
    }
  });
  await client.login(config.botToken);
  return client;
}
