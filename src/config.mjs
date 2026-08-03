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
  const rootWorkspace = env.CODEX_WORKSPACE_ROOT?.trim();
  if (rootWorkspace && !Object.hasOwn(parsed, "workspace")) {
    parsed.workspace = { path: rootWorkspace, allowNonGit: true };
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0) throw new Error("CODEX_WORKSPACES_JSON must not be empty");
  if (entries.length > 25) throw new Error("CODEX_WORKSPACES_JSON supports at most 25 workspaces for Discord commands");

  const workspaces = new Map();
  for (const [name, configured] of entries) {
    if (!WORKSPACE_NAME.test(name)) throw new Error(`Invalid workspace name: ${name}`);
    const candidate = typeof configured === "string" ? { path: configured, allowNonGit: false } : configured;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`Workspace ${name} must be a path string or configuration object`);
    }
    if (candidate.allowNonGit !== undefined && typeof candidate.allowNonGit !== "boolean") {
      throw new Error(`Workspace ${name} allowNonGit must be a boolean`);
    }
    if (typeof candidate.path !== "string" || !path.isAbsolute(candidate.path)) {
      throw new Error(`Workspace ${name} must use an absolute path`);
    }
    workspaces.set(name, Object.freeze({
      path: path.resolve(candidate.path),
      allowNonGit: candidate.allowNonGit === true
    }));
  }
  return workspaces;
}

function positiveSeconds(env) {
  const raw = env.CODEX_MAX_RUNTIME_SECONDS?.trim() || "900";
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(seconds) || seconds < 30 || seconds > 7200) {
    throw new Error("CODEX_MAX_RUNTIME_SECONDS must be an integer from 30 to 7200");
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

function isAllowed({ userId, channelId, parentId }, config) {
  if (!config.allowedUserIds.has(userId)) return false;
  return config.allowedChannelIds.has(channelId)
    || (parentId !== null && parentId !== undefined && config.allowedChannelIds.has(parentId));
}

export function isAllowedInteraction(interaction, config) {
  return isAllowed({
    userId: interaction.user.id,
    channelId: interaction.channelId,
    parentId: interaction.channel?.parentId
  }, config);
}

export function isAllowedMessage(message, config) {
  return isAllowed({
    userId: message.author.id,
    channelId: message.channelId,
    parentId: message.channel?.parentId
  }, config);
}
