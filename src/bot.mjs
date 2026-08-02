import { Client, Events, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from "discord.js";
import { isAllowedInteraction } from "./config.mjs";
import { sessionKey } from "./session-store.mjs";

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
      .addStringOption(workspaceOption));
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

export async function registerCommands(config) {
  const rest = new REST({ version: "10" }).setToken(config.botToken);
  await rest.put(Routes.applicationGuildCommands(config.applicationId, config.guildId), {
    body: [commandDefinition([...config.workspaces.keys()]).toJSON()]
  });
}

export async function startBot({ config, runner, sessions }) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
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
        await interaction.reply({ content: `Codex session for **${workspaceName}**: ${state}.`, ephemeral: true, allowedMentions: { parse: [] } });
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

      const task = interaction.options.getString("task", true);
      const saved = sessions.get(key);
      await interaction.deferReply({ ephemeral: true });
      const result = await runner.execute({
        key,
        workspace: workspaceConfig.path,
        prompt: task,
        skipGitRepoCheck: workspaceConfig.allowNonGit,
        resumeSessionId: saved?.sessionId ?? null,
        onSessionId: async (sessionId) => {
          await sessions.set(key, { sessionId, workspace: workspaceName, updatedAt: new Date().toISOString() });
        }
      });
      if (result.sessionId && result.sessionId !== saved?.sessionId) {
        await sessions.set(key, { sessionId: result.sessionId, workspace: workspaceName, updatedAt: new Date().toISOString() });
      }
      const prefix = result.timedOut
        ? "Codex exceeded the configured time limit and was stopped.\n\n"
        : result.exitCode === 0 ? "" : `Codex exited with status ${result.exitCode ?? "unknown"}.\n\n`;
      await replyChunks(interaction, `${prefix}${result.message}`);
    } catch (error) {
      const message = `Codex request failed: ${error.message}`;
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content: message, allowedMentions: { parse: [] } });
      else await interaction.reply({ content: message, ephemeral: true, allowedMentions: { parse: [] } });
    }
  });
  await client.login(config.botToken);
  return client;
}
