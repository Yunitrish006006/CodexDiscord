import { randomUUID } from "node:crypto";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, Events, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from "discord.js";
import { isAllowedInteraction, isAllowedMessage } from "./config.mjs";
import { validateModel } from "./codex-runner.mjs";
import { conversationKey, sessionKey } from "./session-store.mjs";

const MAX_DISCORD_MESSAGE = 1_850;
const PROGRESS_EDIT_INTERVAL_MS = 1_200;
const APPROVAL_EXPIRY_MS = 30 * 60 * 1_000;

function commandDefinition(workspaceNames) {
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
        .setRequired(true)))
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
        .setDescription('Model ID, or "default" to use the local Codex default')
        .setRequired(true)));
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

async function replyChunks(interaction, message) {
  const [first, ...rest] = splitMessage(message);
  await interaction.editReply({ content: first, components: [], allowedMentions: { parse: [] } });
  for (const chunk of rest) {
    await interaction.followUp({ content: chunk, ephemeral: true, allowedMentions: { parse: [] } });
  }
}

async function messageChunks(message, status, content) {
  const [first, ...rest] = splitMessage(content);
  await status.edit({ content: first, components: [], allowedMentions: { parse: [] } });
  for (const chunk of rest) await message.channel.send({ content: chunk, allowedMentions: { parse: [] } });
}

function resultPrefix(result) {
  if (result.timedOut) return "Codex exceeded the configured time limit and was stopped.\n\n";
  return result.exitCode === 0 ? "" : `Codex exited with status ${result.exitCode ?? "unknown"}.\n\n`;
}

function publicText(value, limit = 600) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").replace(/@/g, "@\u200b").trim().slice(0, limit);
}

function commandLabel(command) {
  const normalized = publicText(command, 240);
  if (!normalized) return "本機指令";
  if (/(token|password|secret|authorization|cookie|private[ _-]?key|\.env)/i.test(normalized)) {
    return "本機指令（敏感內容已隱藏）";
  }
  return `\`${normalized.replace(/`/g, "'")}\``;
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
  lines.push("請選擇允許一次、允許本工作階段，或拒絕。");
  return lines.join("\n");
}

function approvalComponents(token, approval) {
  const allowSession = approval.kind !== "command" || !Array.isArray(approval.availableDecisions)
    || approval.availableDecisions.includes("acceptForSession");
  const buttons = [
    new ButtonBuilder().setCustomId(`codex:approval:${token}:allow`).setLabel("允許一次").setStyle(ButtonStyle.Success)
  ];
  if (allowSession) {
    buttons.push(new ButtonBuilder().setCustomId(`codex:approval:${token}:allow-session`).setLabel("本工作階段允許").setStyle(ButtonStyle.Primary));
  }
  buttons.push(new ButtonBuilder().setCustomId(`codex:approval:${token}:decline`).setLabel("拒絕").setStyle(ButtonStyle.Danger));
  return [new ActionRowBuilder().addComponents(...buttons)];
}

function createProgressReporter({ workspaceName, model, edit }) {
  let activity = "正在分析需求…";
  let reasoningSummary = "";
  let plan = "";
  let approval = null;
  let timer = null;
  let closed = false;
  let lastEditAt = 0;
  let pendingEdit = Promise.resolve();

  const content = () => {
    const lines = [`Codex 正在 **${workspaceName}** 使用 **${model ?? "local default"}** 工作…`, "", activity];
    if (reasoningSummary) lines.push(`思考摘要：${reasoningSummary}`);
    if (plan) lines.push(`計畫：${plan}`);
    if (approval) lines.push("", approvalDescription(approval.value));
    return lines.join("\n").slice(0, MAX_DISCORD_MESSAGE);
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
      reasoningSummary = publicText(`${reasoningSummary}${params.delta ?? ""}`, 620);
      activity = "正在思考與規劃…";
    } else if (method === "item/reasoning/textDelta") {
      activity = "正在思考與規劃…";
    } else if (method === "item/plan/delta") {
      plan = publicText(`${plan}${params.delta ?? ""}`, 500);
      activity = "正在更新執行計畫…";
    } else if (method === "item/started" || method === "item/completed") {
      const item = params.item ?? {};
      if (item.type === "commandExecution" || item.type === "command_execution") activity = `正在執行：${commandLabel(item.command)}`;
      else if (item.type === "fileChange" || item.type === "file_change") activity = "正在修改工作區檔案…";
      else if (item.type === "mcpToolCall" || item.type === "mcp_tool_call") activity = "正在使用整合工具…";
      else if (item.type === "agentMessage" || item.type === "agent_message") activity = "正在整理回覆…";
    } else if (method === "turn/started") {
      activity = "正在處理需求…";
    } else if (method === "turn/completed") {
      activity = "正在整理最終回覆…";
    } else if (method === "bridge/sessionReset") {
      activity = "舊工作階段無法恢復，正在建立新的工作階段…";
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
    async approvalSubmitted() {
      approval = null;
      activity = "已送出你的授權決定，正在繼續…";
      await flush();
    },
    async resolveApproval(requestId) {
      if (approval?.value?.requestId === String(requestId)) {
        approval = null;
        await flush();
      }
    },
    async finish() {
      await flush();
      closed = true;
    }
  };
}

async function runTask({ config, runner, sessions, userId, channelId, workspaceName, task, model = null, onProgress = () => {}, onApproval = () => {} }) {
  const workspaceConfig = config.workspaces.get(workspaceName);
  if (!workspaceConfig) throw new Error("That workspace is not configured");
  const key = sessionKey({ userId, channelId, workspace: workspaceName });
  const saved = sessions.get(key);
  const result = await runner.execute({
    key,
    workspace: workspaceConfig.path,
    prompt: task,
    model,
    skipGitRepoCheck: workspaceConfig.allowNonGit,
    resumeSessionId: saved?.sessionId ?? null,
    onSessionId: async (sessionId) => {
      await sessions.set(key, { sessionId, workspace: workspaceName, updatedAt: new Date().toISOString() });
    },
    onProgress,
    onApproval
  });
  if (result.sessionId && result.sessionId !== saved?.sessionId) {
    await sessions.set(key, { sessionId: result.sessionId, workspace: workspaceName, updatedAt: new Date().toISOString() });
  }
  return { key, result };
}

export async function registerCommands(config) {
  const rest = new REST({ version: "10" }).setToken(config.botToken);
  await rest.put(Routes.applicationGuildCommands(config.applicationId, config.guildId), {
    body: [commandDefinition([...config.workspaces.keys()]).toJSON()]
  });
}

export async function startBot({ config, runner, sessions }) {
  const approvals = new Map();
  const registerApproval = ({ approval, key, userId, channelId, progress }) => {
    const token = randomUUID();
    approvals.set(token, {
      ...approval,
      key,
      userId,
      channelId,
      progress,
      expiresAt: Date.now() + APPROVAL_EXPIRY_MS
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
  const client = new Client({ intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ] });
  client.once(Events.ClientReady, (readyClient) => {
    console.info(`CodexDiscord ready as ${readyClient.user.tag}`);
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isButton() && interaction.customId.startsWith("codex:approval:")) {
      const [, , token, choice] = interaction.customId.split(":");
      const approval = approvals.get(token);
      if (!approval || approval.expiresAt < Date.now()) {
        approvals.delete(token);
        await interaction.reply({ content: "This Codex approval has expired.", ephemeral: true, allowedMentions: { parse: [] } });
        return;
      }
      if (!isAllowedInteraction(interaction, config) || interaction.user.id !== approval.userId || interaction.channelId !== approval.channelId) {
        await interaction.reply({ content: "You are not allowed to answer this Codex approval.", ephemeral: true, allowedMentions: { parse: [] } });
        return;
      }
      await interaction.deferUpdate();
      const accepted = runner.approve(approval.key, approval.requestId, choice);
      approvals.delete(token);
      if (accepted) await approval.progress.approvalSubmitted();
      else await approval.progress.resolveApproval(approval.requestId);
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
        const model = validateModel(interaction.options.getString("name", true));
        await sessions.setActiveModel(conversation, model);
        await interaction.reply({
          content: model ? `Normal messages in this channel will now use **${model}**.` : "Normal messages in this channel will now use the local Codex default model.",
          ephemeral: true,
          allowedMentions: { parse: [] }
        });
      } catch (error) {
        await interaction.reply({ content: `Invalid model: ${error.message}`, ephemeral: true, allowedMentions: { parse: [] } });
      }
      return;
    }
    const workspaceName = interaction.options.getString("workspace", true);
    const workspaceConfig = config.workspaces.get(workspaceName);
    if (!workspaceConfig) {
      await interaction.reply({ content: "That workspace is not configured.", ephemeral: true, allowedMentions: { parse: [] } });
      return;
    }
    const key = sessionKey({ userId: interaction.user.id, channelId: interaction.channelId, workspace: workspaceName });
    try {
      if (action === "status") {
        const saved = sessions.get(key);
        const state = runner.isRunning(key) ? "running" : saved ? "ready to resume" : "new";
        const model = sessions.activeModel(conversation) ?? "local default";
        await interaction.reply({ content: `Codex session for **${workspaceName}**: ${state}. Model: **${model}**.`, ephemeral: true, allowedMentions: { parse: [] } });
        return;
      }
      if (action === "cancel") {
        const stopped = runner.cancel(key);
        await interaction.reply({ content: stopped ? "Sent a stop request to your active Codex task." : "No active Codex task for this workspace.", ephemeral: true, allowedMentions: { parse: [] } });
        return;
      }
      if (action === "reset") {
        if (runner.isRunning(key)) throw new Error("Cancel the active task before resetting its session");
        const deleted = await sessions.delete(key);
        await interaction.reply({ content: deleted ? "Saved Codex session mapping removed." : "No saved Codex session mapping exists.", ephemeral: true, allowedMentions: { parse: [] } });
        return;
      }
      if (action === "use") {
        await sessions.setActiveWorkspace(conversation, workspaceName);
        await interaction.reply({ content: `Normal messages in this channel will now use **${workspaceName}**.`, ephemeral: true, allowedMentions: { parse: [] } });
        return;
      }

      const task = interaction.options.getString("task", true);
      await interaction.deferReply({ ephemeral: true });
      await sessions.setActiveWorkspace(conversation, workspaceName);
      const model = sessions.activeModel(conversation);
      const progress = createProgressReporter({
        workspaceName,
        model,
        edit: (payload) => interaction.editReply(payload)
      });
      const { result } = await runTask({
        config, runner, sessions, userId: interaction.user.id, channelId: interaction.channelId, workspaceName, task,
        model,
        onProgress: async (event) => {
          if (event?.method === "serverRequest/resolved") await resolveApproval(key, event.params?.requestId);
          progress.update(event);
        },
        onApproval: async (approval) => {
          const token = registerApproval({ approval, key, userId: interaction.user.id, channelId: interaction.channelId, progress });
          await progress.requestApproval(approval, approvalComponents(token, approval));
        }
      });
      await progress.finish();
      await replyChunks(interaction, `${resultPrefix(result)}${result.message}`);
    } catch (error) {
      const message = `Codex request failed: ${error.message}`;
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content: message, allowedMentions: { parse: [] } });
      else await interaction.reply({ content: message, ephemeral: true, allowedMentions: { parse: [] } });
    }
  });
  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.guildId || !message.content.trim() || !isAllowedMessage(message, config)) return;
    const conversation = conversationKey({ userId: message.author.id, channelId: message.channelId });
    const workspaceName = sessions.activeWorkspace(conversation) ?? "workspace";
    const workspaceConfig = config.workspaces.get(workspaceName);
    if (!workspaceConfig) {
      await message.reply({ content: "No active workspace is configured. Use `/codex use` once.", allowedMentions: { parse: [] } });
      return;
    }
    const model = sessions.activeModel(conversation);
    const key = sessionKey({ userId: message.author.id, channelId: message.channelId, workspace: workspaceName });
    if (runner.isRunning(key)) {
      await message.reply({ content: "Codex is still working on the previous message. Use `/codex cancel` if needed.", allowedMentions: { parse: [] } });
      return;
    }
    const modelLabel = model ?? "local default";
    const status = await message.reply({ content: `Codex is working in **${workspaceName}** with **${modelLabel}**…`, allowedMentions: { parse: [] } });
    const progress = createProgressReporter({
      workspaceName,
      model,
      edit: (payload) => status.edit(payload)
    });
    try {
      const { result } = await runTask({
        config, runner, sessions, userId: message.author.id, channelId: message.channelId, workspaceName, task: message.content, model,
        onProgress: async (event) => {
          if (event?.method === "serverRequest/resolved") await resolveApproval(key, event.params?.requestId);
          progress.update(event);
        },
        onApproval: async (approval) => {
          const token = registerApproval({ approval, key, userId: message.author.id, channelId: message.channelId, progress });
          await progress.requestApproval(approval, approvalComponents(token, approval));
        }
      });
      await progress.finish();
      await messageChunks(message, status, `${resultPrefix(result)}${result.message}`);
    } catch (error) {
      await progress.finish();
      await status.edit({ content: `Codex request failed: ${error.message}`, allowedMentions: { parse: [] } });
    }
  });
  await client.login(config.botToken);
  return client;
}
