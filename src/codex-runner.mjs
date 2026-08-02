import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const MAX_PROMPT_LENGTH = 6_000;
const MODEL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const MAX_ERROR_LENGTH = 8_000;

export function validatePrompt(prompt) {
  const normalized = prompt?.trim();
  if (!normalized) throw new Error("Task cannot be empty");
  if (normalized.length > MAX_PROMPT_LENGTH) throw new Error(`Task must be at most ${MAX_PROMPT_LENGTH} characters`);
  return normalized;
}

export function validateModel(model) {
  if (model === null || model === undefined || model === "default") return null;
  const normalized = model.trim();
  if (!MODEL_NAME.test(normalized)) throw new Error("Model name must be 1–80 letters, numbers, dots, dashes, or underscores");
  return normalized;
}

export function threadStartParams({ workspace, model = null }) {
  return compactObject({
    cwd: workspace,
    runtimeWorkspaceRoots: [workspace],
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    model
  });
}

export function threadResumeParams({ threadId, workspace, model = null }) {
  if (typeof threadId !== "string" || !threadId.trim()) throw new Error("Saved Codex session ID is invalid");
  return compactObject({ threadId, ...threadStartParams({ workspace, model }) });
}

export function turnStartParams({ threadId, workspace, prompt, model = null }) {
  if (typeof threadId !== "string" || !threadId.trim()) throw new Error("Saved Codex session ID is invalid");
  return compactObject({
    threadId,
    input: [{ type: "text", text: validatePrompt(prompt) }],
    cwd: workspace,
    runtimeWorkspaceRoots: [workspace],
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [workspace],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    },
    model
  });
}

export function approvalResponse(approval, choice) {
  if (!approval || typeof approval !== "object") throw new Error("Approval request is invalid");
  if (approval.kind === "command" || approval.kind === "file-change") {
    let decision = choice === "allow" ? "accept"
      : choice === "allow-session" ? "acceptForSession"
        : choice === "cancel" ? "cancel" : "decline";
    if (approval.kind === "command" && choice === "decline" && Array.isArray(approval.availableDecisions)
      && !approval.availableDecisions.includes("decline") && approval.availableDecisions.includes("cancel")) {
      decision = "cancel";
    }
    if (approval.kind === "command" && Array.isArray(approval.availableDecisions)
      && !approval.availableDecisions.includes(decision)) {
      throw new Error("That approval choice is not available for this command");
    }
    return { decision };
  }
  if (approval.kind === "permissions") {
    if (choice !== "allow" && choice !== "allow-session") return { permissions: {}, scope: "turn" };
    const requested = approval.permissions ?? {};
    const permissions = {};
    if (requested.network) permissions.network = requested.network;
    if (requested.fileSystem) permissions.fileSystem = requested.fileSystem;
    return { permissions, scope: choice === "allow-session" ? "session" : "turn" };
  }
  throw new Error("This approval type is not supported");
}

export function finalAgentMessage(turn) {
  const messages = Array.isArray(turn?.items) ? turn.items.filter((item) => item?.type === "agentMessage") : [];
  return [...messages].reverse().find((item) => typeof item.text === "string" && item.text.trim())?.text.trim() ?? "";
}

function compactObject(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== null && value !== undefined));
}

function tail(text, limit = MAX_ERROR_LENGTH) {
  return text.length <= limit ? text : text.slice(-limit);
}

function rpcError(message) {
  const detail = message?.error?.message ?? "Unknown Codex App Server error";
  return new Error(detail);
}

function isServerRequest(message) {
  return typeof message?.method === "string" && Object.hasOwn(message, "id");
}

function approvalFromRequest(message) {
  const params = message.params ?? {};
  if (message.method === "item/commandExecution/requestApproval") {
    return {
      kind: "command",
      requestId: String(message.id),
      itemId: params.itemId,
      threadId: params.threadId,
      turnId: params.turnId,
      command: params.command ?? null,
      cwd: params.cwd ?? null,
      reason: params.reason ?? null,
      network: params.networkApprovalContext ?? null,
      availableDecisions: Array.isArray(params.availableDecisions) ? params.availableDecisions : null
    };
  }
  if (message.method === "item/fileChange/requestApproval") {
    return {
      kind: "file-change",
      requestId: String(message.id),
      itemId: params.itemId,
      threadId: params.threadId,
      turnId: params.turnId,
      reason: params.reason ?? null,
      grantRoot: params.grantRoot ?? null
    };
  }
  if (message.method === "item/permissions/requestApproval") {
    return {
      kind: "permissions",
      requestId: String(message.id),
      itemId: params.itemId,
      threadId: params.threadId,
      turnId: params.turnId,
      cwd: params.cwd ?? null,
      reason: params.reason ?? null,
      permissions: params.permissions ?? {}
    };
  }
  return null;
}

export class CodexRunner {
  #maxRuntimeMs;
  #spawn;
  #runs = new Map();

  constructor({ maxRuntimeMs, spawnImpl = spawn }) {
    this.#maxRuntimeMs = maxRuntimeMs;
    this.#spawn = spawnImpl;
  }

  isRunning(key) {
    return this.#runs.has(key);
  }

  cancel(key) {
    const run = this.#runs.get(key);
    if (!run) return false;
    run.cancel();
    return true;
  }

  approve(key, requestId, choice) {
    const run = this.#runs.get(key);
    return run?.approve(requestId, choice) ?? false;
  }

  async execute({ key, workspace, prompt, model = null, resumeSessionId = null, onSessionId = () => {}, onProgress = () => {}, onApproval = () => {} }) {
    if (this.#runs.has(key)) throw new Error("A Codex task is already running for this workspace session");
    const safePrompt = validatePrompt(prompt);
    const safeModel = validateModel(model);

    return await new Promise((resolve, reject) => {
      let child;
      try {
        child = this.#spawn("codex", ["app-server"], { cwd: workspace, stdio: ["pipe", "pipe", "pipe"] });
      } catch (error) {
        reject(error);
        return;
      }

      let settled = false;
      let timedOut = false;
      let cancelled = false;
      let threadId = resumeSessionId;
      let turnId = null;
      let lastAgentMessage = "";
      let lastError = "";
      let stderr = "";
      let nextRequestId = 0;
      const requests = new Map();
      const pendingApprovals = new Map();
      const sessionWrites = [];

      const send = (message) => {
        if (child.stdin.destroyed || child.killed) return false;
        child.stdin.write(`${JSON.stringify(message)}\n`);
        return true;
      };
      const request = (method, params, handler = () => {}) => {
        const id = ++nextRequestId;
        requests.set(String(id), handler);
        if (!send({ method, id, params })) {
          requests.delete(String(id));
          throw new Error("Codex App Server is no longer running");
        }
        return id;
      };
      const notify = (method, params) => send({ method, params });
      const safeProgress = (event) => {
        Promise.resolve(onProgress(event)).catch(() => {});
      };
      const finish = async (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#runs.delete(key);
        if (!child.killed) child.kill("SIGTERM");
        try {
          await Promise.all(sessionWrites);
          resolve(result);
        } catch (error) {
          reject(error);
        }
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#runs.delete(key);
        if (!child.killed) child.kill("SIGTERM");
        reject(error);
      };
      const startTurn = (resolvedThreadId) => {
        threadId = resolvedThreadId;
        if (threadId !== resumeSessionId) {
          sessionWrites.push(Promise.resolve(onSessionId(threadId)));
        }
        request("turn/start", turnStartParams({ threadId, workspace, prompt: safePrompt, model: safeModel }), (message) => {
          if (message.error) {
            fail(rpcError(message));
            return;
          }
          turnId = message.result?.turn?.id ?? null;
        });
      };
      const startNewThread = () => {
        request("thread/start", threadStartParams({ workspace, model: safeModel }), (message) => {
          if (message.error) {
            fail(rpcError(message));
            return;
          }
          const resolvedThreadId = message.result?.thread?.id;
          if (typeof resolvedThreadId !== "string" || !resolvedThreadId) {
            fail(new Error("Codex App Server did not return a thread ID"));
            return;
          }
          startTurn(resolvedThreadId);
        });
      };
      const startOrResumeThread = () => {
        if (!resumeSessionId) {
          startNewThread();
          return;
        }
        request("thread/resume", threadResumeParams({ threadId: resumeSessionId, workspace, model: safeModel }), (message) => {
          if (message.error) {
            safeProgress({ method: "bridge/sessionReset", params: { reason: "The saved session could not be resumed." } });
            startNewThread();
            return;
          }
          const resolvedThreadId = message.result?.thread?.id;
          if (typeof resolvedThreadId !== "string" || !resolvedThreadId) {
            fail(new Error("Codex App Server did not return a thread ID"));
            return;
          }
          startTurn(resolvedThreadId);
        });
      };
      const respondApproval = (requestId, choice) => {
        const approval = pendingApprovals.get(String(requestId));
        if (!approval || settled) return false;
        let result;
        try {
          result = approvalResponse(approval, choice);
        } catch {
          return false;
        }
        pendingApprovals.delete(String(requestId));
        return send({ id: Number.isSafeInteger(Number(requestId)) ? Number(requestId) : requestId, result });
      };
      const cancel = () => {
        if (settled || cancelled) return;
        cancelled = true;
        if (threadId && turnId) {
          try {
            request("turn/interrupt", { threadId, turnId });
          } catch {
            child.kill("SIGTERM");
            return;
          }
          const shutdown = setTimeout(() => {
            if (!settled) child.kill("SIGTERM");
          }, 2_000);
          shutdown.unref();
        } else {
          child.kill("SIGTERM");
        }
      };
      const run = { cancel, approve: respondApproval };
      this.#runs.set(key, run);
      const timer = setTimeout(() => {
        timedOut = true;
        cancel();
      }, this.#maxRuntimeMs);

      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (isServerRequest(message)) {
          const approval = approvalFromRequest(message);
          if (approval) {
            pendingApprovals.set(approval.requestId, approval);
            safeProgress({ method: "bridge/approvalRequested", params: approval });
            Promise.resolve(onApproval(approval)).catch(() => respondApproval(approval.requestId, "decline"));
            return;
          }
          send({ id: message.id, error: { code: -32601, message: "CodexDiscord does not support this server request" } });
          return;
        }
        if (typeof message?.method === "string") {
          safeProgress(message);
          if (message.method === "item/completed" && message.params?.item?.type === "agentMessage") {
            lastAgentMessage = message.params.item.text?.trim() || lastAgentMessage;
          }
          if (message.method === "error") lastError = message.params?.error?.message ?? lastError;
          if (message.method === "turn/completed") {
            const turn = message.params?.turn;
            const messageText = finalAgentMessage(turn) || lastAgentMessage || turn?.error?.message || lastError;
            finish({
              exitCode: turn?.status === "completed" ? 0 : 1,
              signal: null,
              timedOut,
              sessionId: threadId,
              message: messageText || (cancelled ? "Codex task stopped." : "Codex returned no final message.")
            });
          }
          return;
        }
        if (Object.hasOwn(message ?? {}, "id")) {
          const handler = requests.get(String(message.id));
          if (!handler) return;
          requests.delete(String(message.id));
          try {
            handler(message);
          } catch (error) {
            fail(error);
          }
        }
      });
      child.stderr.on("data", (chunk) => { stderr = tail(`${stderr}${chunk}`); });
      child.once("error", fail);
      child.once("close", (exitCode, signal) => {
        if (settled) return;
        finish({
          exitCode,
          signal,
          timedOut,
          sessionId: threadId,
          message: stderr.trim() || (cancelled ? "Codex task stopped." : "Codex App Server stopped before completing the task.")
        });
      });

      try {
        request("initialize", {
          clientInfo: { name: "codex_discord", title: "CodexDiscord", version: "0.1.0" },
          capabilities: { experimentalApi: true }
        }, (message) => {
          if (message.error) {
            fail(rpcError(message));
            return;
          }
          notify("initialized", {});
          startOrResumeThread();
        });
      } catch (error) {
        fail(error);
      }
    });
  }
}
