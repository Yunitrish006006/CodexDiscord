const MAX_DISCORD_CONTENT = 1_850;
const DRAFT_EDIT_INTERVAL_MS = 2_500;
const STATUS_EDIT_INTERVAL_MS = 1_200;

function clippedText(value, maxLength = MAX_DISCORD_CONTENT) {
  const text = String(value ?? "").trim();
  if (!text) return "—";
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function statusKey(entry) {
  return entry.conversationId ?? entry.taskId ?? `conversation:${entry.revision}`;
}

function entryLabel(entry) {
  if (entry.kind === "prompt") return entry.source === "discord" ? "Discord Prompt" : "網頁 Prompt";
  if (entry.status === "failed") return "Codex 失敗";
  if (entry.status === "busy") return "Codex 忙碌中";
  return "Codex 處理中";
}

/** Formats only the explicit conversation contract, never raw tool/command output. */
export function workspaceConversationCard(entry) {
  const label = entryLabel(entry);
  const suffix = entry.kind === "prompt" ? "\n\n-# 已送到 TotemWorkspace 的單一 Codex 執行佇列。" : "";
  return `**${label}**\n${clippedText(entry.text)}${suffix}`;
}

export function isWorkspaceSyncEnabled(config, workspaceName) {
  return Boolean(config.workspaceSync && config.workspaceSync.workspaceName === workspaceName);
}

export function createWorkspaceSync({ config, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console.warn } = {}) {
  const settings = config?.workspaceSync ?? null;
  let client = null;
  let pollTimer = null;
  let latestRevision = 0;
  let draftMessage = null;
  let renderedDraft = null;
  let lastDraftEditAt = 0;
  const statusMessages = new Map();

  async function request(path, { method = "GET", body = null } = {}) {
    if (!settings) throw new Error("Workspace conversation sync is not configured");
    const response = await fetchImpl(new URL(path, settings.url), {
      method,
      headers: {
        authorization: `Bearer ${settings.token}`,
        ...(body == null ? {} : { "content-type": "application/json" })
      },
      ...(body == null ? {} : { body: JSON.stringify(body) })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Workspace conversation request failed: HTTP ${response.status}`);
    return payload;
  }

  async function syncChannel() {
    if (!client || !settings) return null;
    const channel = await client.channels.fetch(settings.channelId);
    return channel && typeof channel.send === "function" ? channel : null;
  }

  async function mirrorDraft(draft) {
    const text = draft?.text?.trim() ?? "";
    if (text === renderedDraft) return;
    const elapsed = now() - lastDraftEditAt;
    if (elapsed < DRAFT_EDIT_INTERVAL_MS) return;
    const channel = await syncChannel();
    if (!channel) return;
    const content = text
      ? `📝 **網頁草稿（未送出）**\n${clippedText(text)}`
      : "📝 **網頁草稿已清除**";
    if (draftMessage && typeof draftMessage.edit === "function") draftMessage = await draftMessage.edit({ content, allowedMentions: { parse: [] } });
    else draftMessage = await channel.send({ content, allowedMentions: { parse: [] } });
    renderedDraft = text;
    lastDraftEditAt = now();
  }

  async function flushStatus(state) {
    state.timer = null;
    const content = state.pending;
    if (!content || content === state.rendered) return;
    const channel = await syncChannel();
    if (!channel) return;
    if (state.message && typeof state.message.edit === "function") state.message = await state.message.edit({ content, allowedMentions: { parse: [] } });
    else state.message = await channel.send({ content, allowedMentions: { parse: [] } });
    state.lastEditAt = now();
    state.rendered = content;
  }

  async function mirrorEntry(entry) {
    const key = statusKey(entry);
    const state = statusMessages.get(key) ?? { message: null, lastEditAt: 0, rendered: null, pending: null, timer: null };
    state.pending = workspaceConversationCard(entry);
    statusMessages.set(key, state);
    if (state.pending === state.rendered || state.timer) return;
    const delay = Math.max(0, STATUS_EDIT_INTERVAL_MS - (now() - state.lastEditAt));
    if (delay === 0) {
      await flushStatus(state);
      return;
    }
    state.timer = setTimeout(() => { void flushStatus(state); }, delay);
    state.timer.unref?.();
  }

  async function poll() {
    if (!settings) return;
    try {
      const snapshot = await request(`/api/conversation?after=${encodeURIComponent(latestRevision)}`);
      latestRevision = Math.max(latestRevision, Number(snapshot.latestRevision) || 0);
      await mirrorDraft(snapshot.draft);
      for (const entry of Array.isArray(snapshot.entries) ? snapshot.entries : []) await mirrorEntry(entry);
    } catch (error) {
      log(`Workspace conversation sync poll failed: ${error.message}`);
    }
  }

  return Object.freeze({
    enabled: Boolean(settings),
    handlesWorkspace: (workspaceName) => isWorkspaceSyncEnabled(config, workspaceName),
    async start(discordClient) {
      if (!settings || pollTimer) return;
      client = discordClient;
      await poll();
      pollTimer = setInterval(() => { void poll(); }, 1_000);
      pollTimer.unref?.();
    },
    stop() {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      for (const state of statusMessages.values()) {
        if (state.timer) clearTimeout(state.timer);
      }
      client = null;
    },
    async submitPrompt({ prompt, clientMessageId }) {
      if (!settings) throw new Error("Workspace conversation sync is not configured");
      return request("/api/conversation/prompt", {
        method: "POST",
        body: { prompt, clientMessageId }
      });
    },
    async cancel() {
      if (!settings) throw new Error("Workspace conversation sync is not configured");
      return request("/api/conversation/cancel", { method: "POST", body: {} });
    },
    async status() {
      if (!settings) throw new Error("Workspace conversation sync is not configured");
      return request("/api/conversation/status");
    }
  });
}
