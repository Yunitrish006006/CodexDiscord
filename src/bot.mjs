import { Client, Events, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from "discord.js";
import { isAllowedInteraction, isAllowedMessage } from "./config.mjs";
import { validateModel } from "./codex-runner.mjs";
import { conversationKey, sessionKey } from "./session-store.mjs";

const MAX_DISCORD_MESSAGE = 1_850;

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
  await interaction.editReply({ content: first, allowedMentions: { parse: [] } });
  for (const chunk of rest) {
    await interaction.followUp({ content: chunk, ephemeral: true, allowedMentions: { parse: [] } });
  }
}

async function messageChunks(message, status, content) {
  const [first, ...rest] = splitMessage(content);
  await status.edit({ content: first, allowedMentions: { parse: [] } });
  for (const chunk of rest) await message.channel.send({ content: chunk, allowedMentions: { parse: [] } });
}

function resultPrefix(result) {
  if (result.timedOut) return "Codex exceeded the configured time limit and was stopped.\n\n";
  return result.exitCode === 0 ? "" : `Codex exited with status ${result.exitCode ?? "unknown"}.\n\n`;
}

async function runTask({ config, runner, sessions, userId, channelId, workspaceName, task, model = null }) {
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
    }
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
  const client = new Client({ intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ] });
  client.once(Events.ClientReady, (readyClient) => {
    console.info(`CodexDiscord ready as ${readyClient.user.tag}`);
  });
  client.on(Events.InteractionCreate, async (interaction) => {
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
      const { result } = await runTask({
        config, runner, sessions, userId: interaction.user.id, channelId: interaction.channelId, workspaceName, task,
        model: sessions.activeModel(conversation)
      });
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
    try {
      const { result } = await runTask({
        config, runner, sessions, userId: message.author.id, channelId: message.channelId, workspaceName, task: message.content, model
      });
      await messageChunks(message, status, `${resultPrefix(result)}${result.message}`);
    } catch (error) {
      await status.edit({ content: `Codex request failed: ${error.message}`, allowedMentions: { parse: [] } });
    }
  });
  await client.login(config.botToken);
  return client;
}
