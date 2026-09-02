import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const MAX_PROMPT_LENGTH = 6_000;
const MAX_IMAGE_INPUTS = 4;
const MODEL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const REASONING_EFFORT_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/;
const MAX_ERROR_LENGTH = 8_000;
const MODEL_LIST_TIMEOUT_MS = 15_000;
const MODEL_LIST_PAGE_SIZE = 100;
export const CODING_SUBAGENT_MODEL = "gpt-5.3-codex-spark";
const CODING_SUBAGENT_REASONING_EFFORT = "medium";
const DISCORD_DEVELOPER_INSTRUCTIONS = `
You are the primary technical lead and orchestrator for tasks sent through CodexDiscord.
Inspect the selected workspace, repository structure, AGENTS.md files, build configuration, module boundaries, and current implementation before making assumptions. When the workspace contains related Minecraft Fabric mods, treat them as one product family: a locally correct change that breaks a sibling module is not complete.

Choose subagents dynamically and do not ask the Discord user which agent to use or whether to spawn one. Use the minimum useful set. Trivial isolated changes may be handled directly. Use explorer-style subagents for uncertain scope, dependency tracing, or read-heavy investigation. Use an architecture/core specialist when shared APIs, dependency direction, persistence, networking contracts, or cross-module behavior are involved. Use separate bounded implementation workers for independent modules. Use a Minecraft/Fabric compatibility specialist for versioned APIs, mappings, mixins, registries, networking, lifecycle hooks, data generation, or client/server environment boundaries. Use an independent integration reviewer after substantial changes.

For a narrow isolated coding task, you may delegate the implementation to one implementation-focused subagent. When an implementation worker is appropriate, prefer model ${CODING_SUBAGENT_MODEL} with ${CODING_SUBAGENT_REASONING_EFFORT} reasoning effort when available; this is a worker preference, not a requirement to use exactly one subagent or to route every coding task through it. Give every writing agent a bounded module/file ownership scope and do not let multiple agents concurrently edit the same files.

For non-trivial work, determine affected modules, shared contracts, dependencies, what can run independently, and what must happen sequentially. Prefer this order when relevant: explore -> architecture/contract -> core/shared implementation -> parallel independent module workers -> integration review -> build/test. Stabilize shared APIs before dispatching dependent feature-module work.

For Minecraft/Fabric projects, verify the configured Minecraft version, Fabric Loader, Fabric API, mappings, Java version, Gradle setup, and environment boundaries from the repository. Do not blindly apply APIs from another version. Check dedicated-server safety and prevent client-only classes from loading through common/server paths. Before changing a shared API, find all consumers. Keep feature-specific behavior out of core unless it is genuinely shared.

Use the repository's own Gradle wrapper and existing build/test tasks. Targeted validation is appropriate during development, but cross-module changes require broader validation before completion. Do not report success when relevant validation failed. Distinguish pre-existing failures from failures introduced by the current task.

Read-heavy independent investigations may run in parallel. Parallel writes are allowed only when ownership does not materially overlap. The primary coordinator owns final correctness: review the resulting diff, integrate subagent work, verify affected consumers, and make necessary corrections rather than trusting subagent reports at face value.

Ordinary explanations, status checks, and read-only questions do not require subagents. Ask the user only for genuine product decisions that cannot be inferred from the request, repository, existing behavior, or platform constraints; investigate implementation uncertainty yourself first.

Keep the final Discord response concise: summarize the result, affected modules/components, validation performed, and important remaining risks. Do not dump raw subagent conversations or long command logs.
`.trim();
const GRADLE_EXECUTABLE = /(?:^|\/)gradlew?$/;
const GRADLE_SAFE_FLAG = /^(?:--(?:no-daemon|stacktrace|full-stacktrace|info|debug|offline|rerun-tasks|continue|configuration-cache|no-configuration-cache|build-cache|no-build-cache)|--(?:console|warning-mode)=[a-z-]+|-[qidsS])$/;
const GRADLE_COMPILE_TASK = /^(?::[a-zA-Z0-9_.-]+)*(?::)?(?:assemble|build|classes|compile[a-zA-Z0-9]*|jar|test|check|process[a-zA-Z0-9]*Resources|run(?:Client)?GameTest)$/;

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

export function validateReasoningEffort(effort) {
  if (effort === null || effort === undefined || effort === "default") return null;
  const normalized = effort.trim();
  if (!REASONING_EFFORT_NAME.test(normalized)) {
    throw new Error("Reasoning effort must be 1–80 letters, numbers, dashes, or underscores");
  }
  return normalized;
}

export function imageInputs(imageUrls = []) {
  if (!Array.isArray(imageUrls)) throw new Error("Image inputs must be an array");
  if (imageUrls.length > MAX_IMAGE_INPUTS) throw new Error(`At most ${MAX_IMAGE_INPUTS} images can be sent to Codex at once`);
  return imageUrls.map((url) => {
    if (typeof url !== "string" || !url.trim()) throw new Error("Image URL must be a non-empty string");
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("Image URL must be valid");
    }
    if (parsed.protocol !== "https:") throw new Error("Image URL must use HTTPS");
    return Object.freeze({ type: "image", url: parsed.toString() });
  });
}

export function threadStartParams({ workspace, model = null }) {
  return compactObject({
    cwd: workspace,
    runtimeWorkspaceRoots: [workspace],
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    developerInstructions: DISCORD_DEVELOPER_INSTRUCTIONS,
    model
  });
}

export function threadResumeParams({ threadId, workspace, model = null }) {
  if (typeof threadId !== "string" || !threadId.trim()) throw new Error("Saved Codex session ID is invalid");
  return compactObject({ threadId, ...threadStartParams({ workspace, model }) });
}

export function turnStartParams({ threadId, workspace, prompt, model = null, reasoningEffort = null, imageUrls = [] }) {
  if (typeof threadId !== "string" || !threadId.trim()) throw new Error("Saved Codex session ID is invalid");
  return compactObject({
    threadId,
    input: [{ type: "text", text: validatePrompt(prompt) }, ...imageInputs(imageUrls)],
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
    model,
    effort: validateReasoningEffort(reasoningEffort)
  });
}

/**
 * Builds the deliberately narrow App Server request used to redirect an
 * in-flight turn. Unlike turn/start, steering must not be able to alter the
 * workspace, model, approvals, or sandbox chosen for the task.
 */
export function turnSteerParams({ threadId, expectedTurnId, prompt, imageUrls = [], clientUserMessageId = null }) {
  if (typeof threadId !== "string" || !threadId.trim()) throw new Error("Saved Codex session ID is invalid");
  if (typeof expectedTurnId !== "string" || !expectedTurnId.trim()) throw new Error("Active Codex turn ID is invalid");
  if (clientUserMessageId !== null && clientUserMessageId !== undefined
    && (typeof clientUserMessageId !== "string" || !clientUserMessageId.trim() || clientUserMessageId.length > 200)) {
    throw new Error("Discord message ID is invalid");
  }
  return compactObject({
    threadId,
    expectedTurnId,
    input: [{ type: "text", text: validatePrompt(prompt) }, ...imageInputs(imageUrls)],
    clientUserMessageId: clientUserMessageId?.trim() || null
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

/**
 * Gradle compilation, test, and packaging tasks are repeatable local checks
 * for this bridge. Auto-approval intentionally excludes shell wrappers,
 * deletion, publishing, arbitrary Gradle properties, and all non-Gradle work.
 */
export function isAutoApprovedGradleCompile(approval) {
  if (approval?.kind !== "command" || typeof approval.command !== "string") return false;
  if (approval.network) return false;
  if (Array.isArray(approval.availableDecisions) && !approval.availableDecisions.includes("accept")) return false;

  const command = approval.command.trim();
  if (!command || /[|;&><`$\r\n]/.test(command)) return false;
  const [executable, ...arguments_] = command.split(/\s+/);
  if (!GRADLE_EXECUTABLE.test(executable)) return false;

  const tasks = arguments_.filter((argument) => !argument.startsWith("-"));
  return tasks.length > 0
    && arguments_.every((argument) => argument.startsWith("-") ? GRADLE_SAFE_FLAG.test(argument) : GRADLE_COMPILE_TASK.test(argument));
}

export function finalAgentMessage(turn) {
  const messages = Array.isArray(turn?.items) ? turn.items.filter((item) => item?.type === "agentMessage") : [];
  return [...messages].reverse().find((item) => typeof item.text === "string" && item.text.trim())?.text.trim() ?? "";
}

export function generatedImagePaths(turn) {
  if (!Array.isArray(turn?.items)) return [];
  return turn.items
    .filter((item) => item?.type === "imageGeneration" && typeof item.savedPath === "string" && item.savedPath)
    .map((item) => item.savedPath);
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

  approveAll(key, requestId) {
    const run = this.#runs.get(key);
    return run?.approveAll(requestId) ?? false;
  }

  /**
   * Appends user input to the single turn already in progress for this
   * workspace session. Calls made while turn/start is still resolving are
   * held by the run and sent in arrival order once its IDs are known.
   */
  async steer(key, { prompt, imageUrls = [], clientUserMessageId = null } = {}) {
    const safePrompt = validatePrompt(prompt);
    const safeImageUrls = imageInputs(imageUrls).map((image) => image.url);
    const safeClientUserMessageId = clientUserMessageId === null || clientUserMessageId === undefined
      ? null
      : (() => {
        if (typeof clientUserMessageId !== "string" || !clientUserMessageId.trim() || clientUserMessageId.length > 200) {
          throw new Error("Discord message ID is invalid");
        }
        return clientUserMessageId.trim();
      })();
    const run = this.#runs.get(key);
    if (!run) throw new Error("No active Codex turn is available to steer.");
    return await run.steer({
      prompt: safePrompt,
      imageUrls: safeImageUrls,
      clientUserMessageId: safeClientUserMessageId
    });
  }

  /**
   * Reads the model picker catalog from the locally authenticated Codex App
   * Server. The result intentionally excludes hidden and malformed entries so
   * callers can expose it directly to a user-facing selector.
   */
  async listModels({ workspace }) {
    if (typeof workspace !== "string" || !workspace.trim()) {
      throw new Error("A workspace is required to read the Codex model catalog");
    }

    return await new Promise((resolve, reject) => {
      let child;
      try {
        child = this.#spawn("codex", ["app-server"], { cwd: workspace, stdio: ["pipe", "pipe", "pipe"] });
      } catch (error) {
        reject(error);
        return;
      }

      let settled = false;
      let stderr = "";
      let nextRequestId = 0;
      let nextCursor = null;
      const seenCursors = new Set();
      const models = new Map();

      const cleanup = () => {
        clearTimeout(timer);
        lines.close();
        if (!child.killed) child.kill("SIGTERM");
      };
      const finish = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const send = (message) => {
        if (child.stdin.destroyed || child.killed) return false;
        child.stdin.write(`${JSON.stringify(message)}\n`);
        return true;
      };
      const request = (method, params) => {
        const id = ++nextRequestId;
        if (!send({ method, id, params })) throw new Error("Codex App Server is no longer running");
        return id;
      };
      const requestModelPage = () => {
        request("model/list", {
          limit: MODEL_LIST_PAGE_SIZE,
          includeHidden: false,
          ...(nextCursor ? { cursor: nextCursor } : {})
        });
      };
      const acceptModel = (entry) => {
        if (!entry || entry.hidden) return;
        const rawModel = typeof entry.model === "string" ? entry.model : entry.id;
        let id;
        try {
          id = validateModel(rawModel);
        } catch {
          return;
        }
        if (!id) return;
        const displayName = typeof entry.displayName === "string" && entry.displayName.trim()
          ? entry.displayName.trim()
          : id;
        const supportedReasoningEfforts = Array.isArray(entry.supportedReasoningEfforts)
          ? entry.supportedReasoningEfforts.flatMap((option) => {
            try {
              const reasoningEffort = validateReasoningEffort(option?.reasoningEffort);
              if (!reasoningEffort) return [];
              return [Object.freeze({
                reasoningEffort,
                description: typeof option.description === "string" ? option.description.trim() : ""
              })];
            } catch {
              return [];
            }
          })
          : [];
        let defaultReasoningEffort = null;
        try {
          defaultReasoningEffort = validateReasoningEffort(entry.defaultReasoningEffort);
        } catch {
          // Old or custom catalogs can omit this value; the model default still works.
        }
        const inputModalities = Array.isArray(entry.inputModalities)
          ? Object.freeze([...new Set(entry.inputModalities.filter((modality) => typeof modality === "string"))])
          : Object.freeze(["text", "image"]);
        models.set(id, Object.freeze({
          id,
          displayName,
          isDefault: entry.isDefault === true,
          defaultReasoningEffort,
          supportedReasoningEfforts: Object.freeze(supportedReasoningEfforts),
          inputModalities
        }));
      };
      const timer = setTimeout(() => fail(new Error("Timed out while reading the Codex model catalog")), MODEL_LIST_TIMEOUT_MS);
      const lines = createInterface({ input: child.stdout });

      lines.on("line", (line) => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (!Object.hasOwn(message ?? {}, "id")) return;
        try {
          if (message.id === 1) {
            if (message.error) throw rpcError(message);
            if (!send({ method: "initialized", params: {} })) {
              throw new Error("Codex App Server is no longer running");
            }
            requestModelPage();
            return;
          }
          if (message.id <= 1) return;
          if (message.error) throw rpcError(message);
          const page = message.result;
          if (!Array.isArray(page?.data)) throw new Error("Codex App Server returned an invalid model catalog");
          page.data.forEach(acceptModel);
          nextCursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : null;
          if (nextCursor) {
            if (seenCursors.has(nextCursor)) throw new Error("Codex App Server returned a repeated model catalog cursor");
            seenCursors.add(nextCursor);
            requestModelPage();
            return;
          }
          finish([...models.values()]);
        } catch (error) {
          fail(error);
        }
      });
      child.stderr.on("data", (chunk) => { stderr = tail(`${stderr}${chunk}`); });
      child.once("error", fail);
      child.once("close", () => {
        if (!settled) fail(new Error(stderr.trim() || "Codex App Server stopped before returning its model catalog"));
      });

      try {
        request("initialize", {
          clientInfo: { name: "codex_discord", title: "CodexDiscord", version: "0.1.0" }
        });
      } catch (error) {
        fail(error);
      }
    });
  }

  /**
   * Reads the authenticated ChatGPT account's current Codex rate-limit
   * snapshot. This is intentionally a short-lived read-only App Server
   * connection, separate from a coding turn and its workspace session.
   */
  async getUsage({ workspace }) {
    if (typeof workspace !== "string" || !workspace.trim()) {
      throw new Error("A workspace is required to read Codex usage limits");
    }

    return await new Promise((resolve, reject) => {
      let child;
      try {
        child = this.#spawn("codex", ["app-server"], { cwd: workspace, stdio: ["pipe", "pipe", "pipe"] });
      } catch (error) {
        reject(error);
        return;
      }

      let settled = false;
      let stderr = "";
      let nextRequestId = 0;
      const cleanup = () => {
        clearTimeout(timer);
        lines.close();
        if (!child.killed) child.kill("SIGTERM");
      };
      const finish = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const send = (message) => {
        if (child.stdin.destroyed || child.killed) return false;
        child.stdin.write(`${JSON.stringify(message)}\n`);
        return true;
      };
      const request = (method, params) => {
        const id = ++nextRequestId;
        if (!send({ method, id, params })) throw new Error("Codex App Server is no longer running");
        return id;
      };
      const timer = setTimeout(() => fail(new Error("Timed out while reading Codex usage limits")), MODEL_LIST_TIMEOUT_MS);
      const lines = createInterface({ input: child.stdout });

      lines.on("line", (line) => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (!Object.hasOwn(message ?? {}, "id")) return;
        try {
          if (message.id === 1) {
            if (message.error) throw rpcError(message);
            if (!send({ method: "initialized", params: {} })) {
              throw new Error("Codex App Server is no longer running");
            }
            request("account/rateLimits/read");
            return;
          }
          if (message.id <= 1) return;
          if (message.error) throw rpcError(message);
          if (!message.result || typeof message.result !== "object" || Array.isArray(message.result)
            || !Object.hasOwn(message.result, "rateLimits")) {
            throw new Error("Codex App Server returned invalid usage limits");
          }
          finish(message.result);
        } catch (error) {
          fail(error);
        }
      });
      child.stderr.on("data", (chunk) => { stderr = tail(`${stderr}${chunk}`); });
      child.once("error", fail);
      child.once("close", () => {
        if (!settled) fail(new Error(stderr.trim() || "Codex App Server stopped before returning usage limits"));
      });

      try {
        request("initialize", {
          clientInfo: { name: "codex_discord", title: "CodexDiscord", version: "0.1.0" }
        });
      } catch (error) {
        fail(error);
      }
    });
  }

  async execute({ key, workspace, prompt, model = null, reasoningEffort = null, imageUrls = [], resumeSessionId = null, onSessionId = () => {}, onProgress = () => {}, onApproval = () => {} }) {
    if (this.#runs.has(key)) throw new Error("A Codex task is already running for this workspace session");
    const safePrompt = validatePrompt(prompt);
    const safeModel = validateModel(model);
    const safeReasoningEffort = validateReasoningEffort(reasoningEffort);
    const safeImageUrls = imageInputs(imageUrls).map((image) => image.url);

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
      let autoApproveAll = false;
      let threadId = resumeSessionId;
      let turnId = null;
      let lastAgentMessage = "";
      const outputImagePaths = new Set();
      let lastError = "";
      let stderr = "";
      let resetSavedSession = false;
      let nextRequestId = 0;
      const requests = new Map();
      const pendingApprovals = new Map();
      const sessionWrites = [];
      const pendingSteers = [];
      let steeringInFlight = false;

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
      const steeringUnavailable = (detail = "Codex completed before the steering message could be applied.") => (
        new Error(`Codex task is no longer accepting steering input: ${detail}`)
      );
      const rejectPendingSteers = (error = steeringUnavailable()) => {
        while (pendingSteers.length > 0) {
          const pending = pendingSteers.shift();
          if (!pending.settled) {
            pending.settled = true;
            pending.reject(error);
          }
        }
      };
      const flushSteers = () => {
        if (settled || steeringInFlight || !threadId || !turnId || pendingSteers.length === 0) return;
        const pending = pendingSteers[0];
        steeringInFlight = true;
        try {
          request("turn/steer", turnSteerParams({
            threadId,
            expectedTurnId: turnId,
            prompt: pending.prompt,
            imageUrls: pending.imageUrls,
            clientUserMessageId: pending.clientUserMessageId
          }), (message) => {
            steeringInFlight = false;
            if (pendingSteers[0] === pending) pendingSteers.shift();
            if (pending.settled) return;
            pending.settled = true;
            if (message.error) {
              pending.reject(steeringUnavailable(rpcError(message).message));
            } else {
              const acceptedTurnId = message.result?.turnId;
              if (typeof acceptedTurnId !== "string" || acceptedTurnId !== turnId) {
                pending.reject(steeringUnavailable("Codex App Server did not confirm the active turn."));
              } else {
                pending.resolve(Object.freeze({ threadId, turnId: acceptedTurnId }));
              }
            }
            flushSteers();
          });
        } catch (error) {
          steeringInFlight = false;
          if (pendingSteers[0] === pending) pendingSteers.shift();
          if (!pending.settled) {
            pending.settled = true;
            pending.reject(steeringUnavailable(error instanceof Error ? error.message : String(error)));
          }
          flushSteers();
        }
      };
      const enqueueSteer = (input) => new Promise((resolve, reject) => {
        if (settled) {
          reject(steeringUnavailable());
          return;
        }
        pendingSteers.push({ ...input, resolve, reject, settled: false });
        flushSteers();
      });
      const finish = async (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#runs.delete(key);
        rejectPendingSteers();
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
        rejectPendingSteers(steeringUnavailable(error instanceof Error ? error.message : String(error)));
        if (!child.killed) child.kill("SIGTERM");
        reject(error);
      };
      const startTurn = (resolvedThreadId, fromSavedSession = false) => {
        threadId = resolvedThreadId;
        if (threadId !== resumeSessionId) {
          sessionWrites.push(Promise.resolve(onSessionId(threadId)));
        }
        request("turn/start", turnStartParams({
          threadId,
          workspace,
          prompt: safePrompt,
          model: safeModel,
          reasoningEffort: safeReasoningEffort,
          imageUrls: safeImageUrls
        }), (message) => {
          if (message.error) {
            if (fromSavedSession && !resetSavedSession) {
              resetSavedSession = true;
              safeProgress({ method: "bridge/sessionReset", params: { reason: "The saved session expired before its turn could start." } });
              startNewThread();
              return;
            }
            fail(rpcError(message));
            return;
          }
          const resolvedTurnId = message.result?.turn?.id;
          if (typeof resolvedTurnId !== "string" || !resolvedTurnId) {
            fail(new Error("Codex App Server did not return an active turn ID"));
            return;
          }
          turnId = resolvedTurnId;
          flushSteers();
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
            resetSavedSession = true;
            safeProgress({ method: "bridge/sessionReset", params: { reason: "The saved session could not be resumed." } });
            startNewThread();
            return;
          }
          const resolvedThreadId = message.result?.thread?.id;
          if (typeof resolvedThreadId !== "string" || !resolvedThreadId) {
            fail(new Error("Codex App Server did not return a thread ID"));
            return;
          }
          startTurn(resolvedThreadId, true);
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
      const enableAutoApproval = (requestId) => {
        const currentRequestId = String(requestId);
        const currentApproval = pendingApprovals.get(currentRequestId);
        if (!currentApproval || settled) return false;
        try {
          approvalResponse(currentApproval, "allow");
        } catch {
          return false;
        }

        autoApproveAll = true;
        for (const pendingRequestId of [...pendingApprovals.keys()]) {
          if (respondApproval(pendingRequestId, "allow")) {
            safeProgress({ method: "bridge/allPermissionsAutoApproved", params: { requestId: pendingRequestId } });
          }
        }
        return !pendingApprovals.has(currentRequestId);
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
      const run = { cancel, approve: respondApproval, approveAll: enableAutoApproval, steer: enqueueSteer };
      this.#runs.set(key, run);
      const timer = this.#maxRuntimeMs > 0
        ? setTimeout(() => {
          timedOut = true;
          cancel();
        }, this.#maxRuntimeMs)
        : null;

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
            if (autoApproveAll && respondApproval(approval.requestId, "allow")) {
              safeProgress({ method: "bridge/allPermissionsAutoApproved", params: { requestId: approval.requestId } });
              return;
            }
            if (isAutoApprovedGradleCompile(approval)) {
              pendingApprovals.delete(approval.requestId);
              const accepted = send({
                id: Number.isSafeInteger(Number(approval.requestId)) ? Number(approval.requestId) : approval.requestId,
                result: approvalResponse(approval, "allow")
              });
              if (!accepted) fail(new Error("Codex App Server is no longer running"));
              else safeProgress({ method: "bridge/gradleAutoApproved", params: {} });
              return;
            }
            safeProgress({ method: "bridge/approvalRequested", params: approval });
            Promise.resolve(onApproval(approval)).catch(() => respondApproval(approval.requestId, "decline"));
            return;
          }
          send({ id: message.id, error: { code: -32601, message: "CodexDiscord does not support this server request" } });
          return;
        }
        if (typeof message?.method === "string") {
          if (message.method === "turn/started") {
            const notifiedThreadId = message.params?.threadId ?? message.params?.turn?.threadId;
            const notifiedTurnId = message.params?.turn?.id ?? message.params?.turnId;
            if ((!notifiedThreadId || notifiedThreadId === threadId) && typeof notifiedTurnId === "string" && notifiedTurnId) {
              turnId = notifiedTurnId;
              flushSteers();
            }
          }
          safeProgress(message);
          if (message.method === "item/completed") {
            const item = message.params?.item;
            if (item?.type === "agentMessage") lastAgentMessage = item.text?.trim() || lastAgentMessage;
            if (item?.type === "imageGeneration" && typeof item.savedPath === "string" && item.savedPath) {
              outputImagePaths.add(item.savedPath);
            }
          }
          if (message.method === "error") lastError = message.params?.error?.message ?? lastError;
          if (message.method === "turn/completed") {
            const turn = message.params?.turn;
            const messageText = finalAgentMessage(turn) || lastAgentMessage || turn?.error?.message || lastError;
            generatedImagePaths(turn).forEach((imagePath) => outputImagePaths.add(imagePath));
            finish({
              exitCode: turn?.status === "completed" ? 0 : 1,
              signal: null,
              timedOut,
              sessionId: threadId,
              message: messageText || (cancelled ? "Codex task stopped." : "Codex returned no final message."),
              imagePaths: [...outputImagePaths]
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
          message: stderr.trim() || (cancelled ? "Codex task stopped." : "Codex App Server stopped before completing the task."),
          imagePaths: [...outputImagePaths]
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
