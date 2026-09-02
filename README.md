# CodexDiscord

CodexDiscord is a **local, allow-listed Discord Bot service** that starts the
Codex CLI already logged in on this host. It is intentionally separate from
the Minecraft mod: TotemDiscordBridge continues to send Minecraft notifications
to Discord, while this service receives a privileged Discord slash command and
starts a local coding session for developing the Totem modules.

It deliberately uses a **separate Discord Bot application** from the Minecraft
bridge. The Minecraft application owns its HTTP Interaction Endpoint and
commands; the Codex application uses the Bot Gateway and owns only `/codex`.
Keeping separate applications prevents command registration and interaction
delivery from overwriting or intercepting each other.

## Security model

- Only `DISCORD_ALLOWED_USER_IDS` may use the commands.
- Only `DISCORD_ALLOWED_CHANNEL_IDS` (or threads beneath those channels) are
  accepted.
- The user can choose only a configured workspace name; Discord can never pass
  an arbitrary host path or shell command. The optional `workspace` root is
  explicit configuration for cross-module work, not a user-supplied path.
- Codex is launched with `--sandbox workspace-write`. This service never uses
  `--dangerously-bypass-approvals-and-sandbox`.
- A Discord conversation stores a separate local Codex session per
  user/channel/workspace. It does **not** attach to an already-open Codex app
  conversation.
- Active work is locked per user/workspace across Discord threads. A second
  thread cannot start a conflicting task until the first finishes or is cancelled.

## Setup

1. Create a dedicated Discord Application such as `Totem Codex`, add its Bot,
   and enable **Message Content Intent**. Do not configure an Interaction
   Endpoint URL; this service receives interactions through the Gateway.
2. Invite that Bot to the intended server with the `bot` and
   `applications.commands` scopes. Grant only View Channels, Send Messages,
   Send Messages in Threads, Attach Files, and Read Message History in the
   private Codex channel.
3. Copy `.env.example` to `.env`. Put the new Codex Bot token and Application
   ID in `DISCORD_BOT_TOKEN` and `DISCORD_APPLICATION_ID`, and put the existing
   Minecraft application ID in `DISCORD_BRIDGE_APPLICATION_ID`. Startup rejects
   a configuration where the two Application IDs are equal. Fill every other
   Discord ID and list only workspaces you are willing to let Codex modify.
4. Install dependencies and verify the pure security/runner tests:

   ```bash
   npm install
   npm test
   ```

5. Confirm this host is already authenticated for the CLI with
   `codex login status`, then start the bot:

   ```bash
   node --env-file=.env src/index.mjs
   ```

The bot registers guild-local slash commands on startup, so command changes
appear quickly in the selected server. When `CODEX_WORKSPACE_ROOT` is set,
select `workspace` for tasks spanning several Totem modules; it is intentionally
broader than individual module choices and is still restricted to the allowed
Discord user and channel.

## Commands

- `/codex run workspace:<name> task:<request>` starts or resumes that caller's
  Codex session for the selected workspace.
- `/codex status workspace:<name>` reports whether that session is active.
- `/codex cancel workspace:<name>` sends `SIGTERM` only to that caller's active
  local Codex process.
- `/codex reset workspace:<name>` removes the saved session mapping; it does
  not delete repository files or Codex's global history.
- `/codex use workspace:<name>` changes the workspace used by subsequent normal
  messages in that channel. Without selection, normal messages use `workspace`.
- `/codex model name:<model>` changes the model for subsequent normal messages
  and `/codex run` requests in that channel. Discord shows an autocomplete
  picker populated from the models currently available to this host's Codex
  login; arbitrary model IDs are rejected. Choose **Codex local default** to
  return to the model configured locally for Codex. The catalog is refreshed
  whenever the service starts.
- `/codex reasoning effort:<depth>` shows only the thinking depths that the
  active model supports. Select **Model default** to remove the override; model
  changes also reset the depth to that model's default.
- `/codex progress lines:<0–8>` changes how many recent CLI-style gray activity
  lines are shown live for this user in this channel. The default is 4; choose
  0 to hide progress entirely. When enabled, sanitized commentary and planning
  progress is retained above the final Codex reply. Command execution, file
  changes, and subagent activity appear only in the live tail. The setting
  survives Bot restarts.
- `/codex usage` shows the authenticated Codex account's remaining quota
  percentage for each currently reported usage window and its reset time. This
  response is visible only to the caller. The Bot's Discord activity also shows
  a compact remaining-usage summary; it refreshes at startup, after each Codex
  task finishes, and whenever `/codex usage` is queried.
- CodexDiscord now gives the selected primary model an adaptive orchestration
  policy instead of forcing every coding request through exactly one worker.
  The primary may work directly on trivial isolated changes, use explorers for
  read-heavy investigation, use architecture/core specialists for shared APIs
  and cross-module contracts, fan independent modules out to bounded workers,
  and request an independent integration review for substantial changes.
  Minecraft/Fabric work additionally checks configured versions, mappings,
  module consumers, Gradle validation, and client/dedicated-server boundaries.
  `gpt-5.3-codex-spark` at medium reasoning remains the preferred implementation
  worker when available, but it is no longer the only allowed delegation shape.
- Attach a PNG, JPEG, WebP, or GIF to an ordinary message and Codex receives it
  as visual context; a message containing only an image asks Codex to inspect
  it. `/codex run` also accepts one optional `image` attachment. Up to four
  images, each 25 MiB, are accepted per ordinary message. Images are passed
  directly from Discord's CDN to Codex and are not saved on this host.
- Images generated by Codex are uploaded directly to the final Discord reply.
  PNG, JPEG, WebP, and GIF links in the final response are also attached when
  their real files stay inside the selected allow-listed workspace. Up to four
  output images of 25 MiB each are sent. Symlinks cannot escape the workspace;
  only authoritative built-in image-generation results may come from `/tmp`.
  Attachment requests may run for up to five minutes on slow uplinks; one retry
  is allowed, and terminal failures are written to the service journal before
  the final response falls back to text-only delivery.

After enabling Discord's **Message Content Intent** for this Bot Application,
ordinary text from an allowed user in an allowed channel is sent directly to
that user's active Codex session. No mention or command prefix is required.
Keep this channel private: every ordinary message from the configured user is a
Codex task. Slash-command responses remain ephemeral; ordinary-message
responses are visible in the allowed channel.

While a task is running, its initial Bot response is edited in place with safe
progress. A rolling CLI-style activity tail uses Discord's gray subtext for
readable reasoning summaries, commands, file changes, searches, and tool calls.
Sensitive command details are redacted, and raw reasoning text and command
output are not posted to Discord. When Codex needs approval, that same message becomes an approval card
with **Allow once**, **Allow for this session**, and **Decline** buttons. Only
the configured Discord user in the configured channel can answer those buttons.
The service continues to run in the `workspace-write` sandbox; a button never
grants `danger-full-access`.

The approval card also offers **Allow all for this task**. It accepts the
current request and automatically accepts later command, file-change, and
permission requests only until that active task finishes or is cancelled. The
choice is never carried into a later Discord message or Codex task.

To redirect a running task like Codex CLI, reply directly to its persistent
status message. The reply's text and up to four trusted Discord image
attachments are appended to the same in-flight turn in arrival order. The Bot
acknowledges an accepted reply with `↪️`; ordinary messages that are not replies
keep the existing busy-task behavior. A reply cannot approve an operation or
grant permissions: approval buttons remain the only approval path.

The persistent status message keeps the Discord **question/request**, current
status, and a short sanitized activity tail while work is running. Approval
details are shown only while the decision is pending. On completion, operational
command, file-change, and subagent entries are removed with the live status;
only sanitized commentary/planning progress may remain above Codex's final
response. Streamed progress is accumulated without character slicing so its
sentences remain complete; long final output is split across Discord messages
without dropping text.

Direct Gradle compilation, test, and local packaging tasks are accepted
automatically. Shell-wrapped commands, cleanup, publishing, network or file
scope changes, and other operations still require the allowed Discord user to
decide.

Short slash-command responses are ephemeral. A running `/codex run` request is
instead a persistent status message: Discord expires interaction webhooks after
a short window, while a normal Bot message keeps its approval controls and
progress updates usable for the complete local run. Keep the allowed channel
private, because long-running task prompts and final results are visible there.

## Service operation

Run this as the same operating-system user that owns the existing Codex login.
Keep `.env` outside source control. A systemd unit should use an `EnvironmentFile`
with mode `0600`, set `WorkingDirectory` to this directory, and run only after
the configured workspaces are mounted.

`CODEX_MAX_RUNTIME_SECONDS=0` leaves Codex tasks running until they complete or
the user cancels them. Set it to 30–7200 only when a finite safety deadline is
desired.