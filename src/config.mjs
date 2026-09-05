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

function runtimeSeconds(env) {
  const raw = env.CODEX_MAX_RUNTIME_SECONDS?.trim() || "0";
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(seconds) || (seconds !== 0 && (seconds < 30 || seconds > 7200))) {
    throw new Error("CODEX_MAX_RUNTIME_SECONDS must be 0 (unlimited) or an integer from 30 to 7200");
  }
  return seconds;
}

function workspaceSync(env, allowedChannelIds) {
  const urlValue = env.TOTEM_WORKSPACE_SYNC_URL?.trim();
  const token = env.TOTEM_WORKSPACE_SYNC_TOKEN?.trim();
  const channelId = env.TOTEM_WORKSPACE_SYNC_CHANNEL_ID?.trim();
  const workspaceName = env.TOTEM_WORKSPACE_SYNC_WORKSPACE?.trim() || "workspace";
  if (!urlValue && !token && !channelId && !env.TOTEM_WORKSPACE_SYNC_WORKSPACE?.trim()) return null;
  if (!urlValue || !token || !channelId) {
    throw new Error("TOTEM_WORKSPACE_SYNC_URL, TOTEM_WORKSPACE_SYNC_TOKEN, and TOTEM_WORKSPACE_SYNC_CHANNEL_ID must be configured together");
  }
  if (!DISCORD_ID.test(channelId) || !allowedChannelIds.has(channelId)) {
    throw new Error("TOTEM_WORKSPACE_SYNC_CHANNEL_ID must be an allowed Discord channel ID");
  }
  if (!WORKSPACE_NAME.test(workspaceName)) throw new Error("TOTEM_WORKSPACE_SYNC_WORKSPACE must be a configured workspace name");
  let url;
  try {
    url = new URL(urlValue);
  } catch {
    throw new Error("TOTEM_WORKSPACE_SYNC_URL must be a valid URL");
  }
  const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
  if (!loopback) throw new Error("TOTEM_WORKSPACE_SYNC_URL must use an http loopback host");
  if (token.length < 16) throw new Error("TOTEM_WORKSPACE_SYNC_TOKEN must contain at least 16 characters");
  return Object.freeze({
    url: url.toString(),
    token,
    channelId,
    workspaceName
  });
}

export function loadConfig(env = process.env) {
  const applicationId = required(env, "DISCORD_APPLICATION_ID");
  const bridgeApplicationId = required(env, "DISCORD_BRIDGE_APPLICATION_ID");
  const guildId = required(env, "DISCORD_GUILD_ID");
  if (!DISCORD_ID.test(applicationId) || !DISCORD_ID.test(bridgeApplicationId) || !DISCORD_ID.test(guildId)) {
    throw new Error("Discord application and guild IDs must be Discord snowflake IDs");
  }
  if (applicationId === bridgeApplicationId) {
    throw new Error("Discord Codex must use a different Application than the Minecraft Discord Bridge");
  }
  const allowedUserIds = idSet(env, "DISCORD_ALLOWED_USER_IDS");
  const allowedChannelIds = idSet(env, "DISCORD_ALLOWED_CHANNEL_IDS");
  const workspaces = workspaceMap(env);
  const sync = workspaceSync(env, allowedChannelIds);
  if (sync && !workspaces.has(sync.workspaceName)) {
    throw new Error("TOTEM_WORKSPACE_SYNC_WORKSPACE must name a configured workspace");
  }
  return Object.freeze({
    botToken: required(env, "DISCORD_BOT_TOKEN"),
    applicationId,
    bridgeApplicationId,
    guildId,
    allowedUserIds,
    allowedChannelIds,
    workspaces,
    maxRuntimeMs: runtimeSeconds(env) * 1000,
    stateDir: path.resolve(env.CODEX_STATE_DIR || "data"),
    workspaceSync: sync
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
