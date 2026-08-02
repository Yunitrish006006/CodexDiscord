import test from "node:test";
import assert from "node:assert/strict";
import { isAllowedInteraction, loadConfig } from "../src/config.mjs";

const env = {
  DISCORD_BOT_TOKEN: "test-token",
  DISCORD_APPLICATION_ID: "123456789012345678",
  DISCORD_GUILD_ID: "223456789012345678",
  DISCORD_ALLOWED_USER_IDS: "323456789012345678",
  DISCORD_ALLOWED_CHANNEL_IDS: "423456789012345678",
  CODEX_WORKSPACES_JSON: '{"nexus":"/home/thomas/workspace/TotemNexus"}'
};

test("configuration requires explicit user, channel and workspace allowlists", () => {
  const config = loadConfig(env);
  assert.equal(config.workspaces.get("nexus"), "/home/thomas/workspace/TotemNexus");
  assert.throws(() => loadConfig({ ...env, DISCORD_ALLOWED_USER_IDS: "" }), /DISCORD_ALLOWED_USER_IDS is required/);
  assert.throws(() => loadConfig({ ...env, CODEX_WORKSPACES_JSON: '{"bad":"relative"}' }), /absolute path/);
  assert.throws(() => loadConfig({ ...env, DISCORD_GUILD_ID: "not-an-id" }), /snowflake/);
});

test("access requires both the configured user and channel", () => {
  const config = loadConfig(env);
  const allowed = { user: { id: "323456789012345678" }, channelId: "423456789012345678", channel: { parentId: null } };
  assert.equal(isAllowedInteraction(allowed, config), true);
  assert.equal(isAllowedInteraction({ ...allowed, user: { id: "999999999999999999" } }, config), false);
  assert.equal(isAllowedInteraction({ ...allowed, channelId: "999999999999999999" }, config), false);
  assert.equal(isAllowedInteraction({ ...allowed, channelId: "999999999999999999", channel: { parentId: "423456789012345678" } }, config), true);
});
