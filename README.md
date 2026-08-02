# CodexDiscord

CodexDiscord is a **local, allow-listed Discord Bot service** that starts the
Codex CLI already logged in on this host. It is intentionally separate from
the Minecraft mod: TotemDiscordBridge continues to send Minecraft notifications
to Discord, while this service receives a privileged Discord slash command and
starts a local coding session for developing the Totem modules.

It deliberately uses the **same Discord Bot application** as the Minecraft
bridge. The existing Cloudflare Worker uses that token only for Discord REST
delivery; CodexDiscord is the only process that opens the Bot Gateway and
handles slash commands. Do not add a Gateway listener to the Worker.

## Security model

- Only `DISCORD_ALLOWED_USER_IDS` may use the commands.
- Only `DISCORD_ALLOWED_CHANNEL_IDS` (or threads beneath those channels) are
  accepted.
- The user can choose only a configured workspace name; Discord can never pass
  an arbitrary host path or shell command.
- Codex is launched with `--sandbox workspace-write`. This service never uses
  `--dangerously-bypass-approvals-and-sandbox`.
- A Discord conversation stores a separate local Codex session per
  user/channel/workspace. It does **not** attach to an already-open Codex app
  conversation.

## Setup

1. Use the Discord Application and Bot already configured for the Minecraft
   bridge. Ensure it was invited with the `bot` and `applications.commands`
   scopes in the intended server.
2. Copy `.env.example` to `.env`. Provision the same Bot token as a local
   secret (the Cloudflare Worker secret is not automatically available on this
   host), fill every Discord ID, and list only workspaces you are willing to
   let Codex modify.
3. Install dependencies and verify the pure security/runner tests:

   ```bash
   npm install
   npm test
   ```

4. Confirm this host is already authenticated for the CLI with
   `codex login status`, then start the bot:

   ```bash
   node --env-file=.env src/index.mjs
   ```

The bot registers guild-local slash commands on startup, so command changes
appear quickly in the selected server.

## Commands

- `/codex run workspace:<name> task:<request>` starts or resumes that caller's
  Codex session for the selected workspace.
- `/codex status workspace:<name>` reports whether that session is active.
- `/codex cancel workspace:<name>` sends `SIGTERM` only to that caller's active
  local Codex process.
- `/codex reset workspace:<name>` removes the saved session mapping; it does
  not delete repository files or Codex's global history.

Responses are ephemeral by default so code output does not flood the channel.
The bot token, prompts and Codex output must still be treated as private to the
allowed Discord users.

## Service operation

Run this as the same operating-system user that owns the existing Codex login.
Keep `.env` outside source control. A systemd unit should use an `EnvironmentFile`
with mode `0600`, set `WorkingDirectory` to this directory, and run only after
the configured workspaces are mounted.
