import path from "node:path";

const DISCORD_ID = /^\d{17,20}$/;
const WORKSPACE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function idSet(env, name) {
  const values = required(env, name).split(",").map((value) => value.trim()).filter(Boolean);
  if (values.length === 0 || values.some((value) => !DISCORD_ID.test(value))) {
    throw new Error(`${name} must contain one or more Discord snowflake IDs`);
  }
  return new Set(values);
}

function workspaceMap(env) {
  let parsed;
  try {
    parsed = JSON.parse(required(env, "CODEX_WORKSPACES_JSON"));
  } catch (error) {
    throw new Error(`CODEX_WORKSPACES_JSON must be a JSON object: ${error.message}`);
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("CODEX_WORKSPACES_JSON must be a non-empty object");
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0) throw new Error("CODEX_WORKSPACES_JSON must not be empty");
  if (entries.length > 25) throw new Error("CODEX_WORKSPACES_JSON supports at most 25 workspaces for Discord commands");

  const workspaces = new Map();
  for (const [name, candidate] of entries) {
    if (!WORKSPACE_NAME.test(name)) throw new Error(`Invalid workspace name: ${name}`);
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
      throw new Error(`Workspace ${name} must use an absolute path`);
    }
    workspaces.set(name, path.resolve(candidate));
  }
  return workspaces;
}

function positiveSeconds(env) {
  const raw = env.CODEX_MAX_RUNTIME_SECONDS?.trim() || "900";
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(seconds) || seconds < 30 || seconds > 3600) {
    throw new Error("CODEX_MAX_RUNTIME_SECONDS must be an integer from 30 to 3600");
  }
  return seconds;
}

export function loadConfig(env = process.env) {
  const applicationId = required(env, "DISCORD_APPLICATION_ID");
  const guildId = required(env, "DISCORD_GUILD_ID");
  if (!DISCORD_ID.test(applicationId) || !DISCORD_ID.test(guildId)) {
    throw new Error("DISCORD_APPLICATION_ID and DISCORD_GUILD_ID must be Discord snowflake IDs");
  }
  return Object.freeze({
    botToken: required(env, "DISCORD_BOT_TOKEN"),
    applicationId,
    guildId,
    allowedUserIds: idSet(env, "DISCORD_ALLOWED_USER_IDS"),
    allowedChannelIds: idSet(env, "DISCORD_ALLOWED_CHANNEL_IDS"),
    workspaces: workspaceMap(env),
    maxRuntimeMs: positiveSeconds(env) * 1000,
    stateDir: path.resolve(env.CODEX_STATE_DIR || "data")
  });
}

export function isAllowedInteraction(interaction, config) {
  if (!config.allowedUserIds.has(interaction.user.id)) return false;
  const parentId = interaction.channel?.parentId;
  return config.allowedChannelIds.has(interaction.channelId)
    || (parentId !== null && parentId !== undefined && config.allowedChannelIds.has(parentId));
}
