import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { approvalResponse, CODING_SUBAGENT_MODEL, CodexRunner, finalAgentMessage, generatedImagePaths, imageInputs, isAutoApprovedGradleCompile, threadResumeParams, threadStartParams, turnStartParams, validateModel, validatePrompt, validateReasoningEffort } from "../src/codex-runner.mjs";

test("Codex App Server sessions always confine writes to the selected workspace", () => {
  const start = threadStartParams({ workspace: "/srv/nexus", model: "gpt-5.6-terra" });
  assert.deepEqual(start, {
    cwd: "/srv/nexus",
    runtimeWorkspaceRoots: ["/srv/nexus"],
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    developerInstructions: start.developerInstructions,
    model: "gpt-5.6-terra"
  });
  assert.match(start.developerInstructions, /delegate the implementation to one implementation-focused subagent/);
  assert.match(start.developerInstructions, new RegExp(CODING_SUBAGENT_MODEL));
  assert.match(start.developerInstructions, /medium reasoning effort/);
  assert.equal(JSON.stringify(start).includes("danger-full-access"), false);
  const resumed = threadResumeParams({ threadId: "thread-123", workspace: "/srv/nexus" });
  assert.deepEqual(resumed.runtimeWorkspaceRoots, ["/srv/nexus"]);
  assert.equal(resumed.developerInstructions, start.developerInstructions);

  const turn = turnStartParams({
    threadId: "thread-123",
    workspace: "/srv/nexus",
    prompt: "Run tests",
    reasoningEffort: "high",
    imageUrls: ["https://cdn.discordapp.com/attachments/1/2/screenshot.png"]
  });
  assert.deepEqual(turn.sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: ["/srv/nexus"],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  });
  assert.deepEqual(turn.input, [
    { type: "text", text: "Run tests" },
    { type: "image", url: "https://cdn.discordapp.com/attachments/1/2/screenshot.png" }
  ]);
  assert.equal(turn.effort, "high");
});

test("approval responses are scoped and never auto-grant unrequested permissions", () => {
  const command = { kind: "command", availableDecisions: ["accept", "decline"] };
  assert.deepEqual(approvalResponse(command, "allow"), { decision: "accept" });
  assert.throws(() => approvalResponse(command, "allow-session"), /not available/);
  assert.deepEqual(approvalResponse({ kind: "command", availableDecisions: ["accept", "cancel"] }, "decline"), { decision: "cancel" });
  assert.deepEqual(approvalResponse({ kind: "file-change" }, "decline"), { decision: "decline" });

  const permissions = {
    kind: "permissions",
    permissions: { network: { host: ["example.com"] }, fileSystem: null }
  };
  assert.deepEqual(approvalResponse(permissions, "allow"), {
    permissions: { network: { host: ["example.com"] } },
    scope: "turn"
  });
  assert.deepEqual(approvalResponse(permissions, "allow-session"), {
    permissions: { network: { host: ["example.com"] } },
    scope: "session"
  });
  assert.deepEqual(approvalResponse(permissions, "decline"), { permissions: {}, scope: "turn" });
});

test("only direct Gradle compile, test, and build commands are automatically approved", () => {
  const approval = (command, availableDecisions = ["accept", "decline"]) => ({ kind: "command", command, availableDecisions });
  assert.equal(isAutoApprovedGradleCompile(approval("./gradlew :module:compileJava --no-daemon")), true);
  assert.equal(isAutoApprovedGradleCompile(approval("../TotemCore/gradlew build --stacktrace")), true);
  assert.equal(isAutoApprovedGradleCompile(approval("./gradlew clean build")), false);
  assert.equal(isAutoApprovedGradleCompile(approval("./gradlew publish")), false);
  assert.equal(isAutoApprovedGradleCompile(approval("bash -lc './gradlew build'")), false);
  assert.equal(isAutoApprovedGradleCompile(approval("./gradlew build -Pversion=1.2.3")), false);
  assert.equal(isAutoApprovedGradleCompile(approval("./gradlew build", ["decline"])), false);
  assert.equal(isAutoApprovedGradleCompile({ ...approval("./gradlew build"), network: { host: "repo.example" } }), false);
  assert.equal(isAutoApprovedGradleCompile({ kind: "permissions", command: "./gradlew build" }), false);
});

test("final messages and user input are validated before reaching Codex", () => {
  assert.equal(finalAgentMessage({ items: [{ type: "agentMessage", text: " first " }, { type: "agentMessage", text: " final " }] }), "final");
  assert.equal(validatePrompt("  Update the tests  "), "Update the tests");
  assert.throws(() => validatePrompt(""), /cannot be empty/);
  assert.equal(validateModel("gpt-5.6-terra"), "gpt-5.6-terra");
  assert.equal(validateModel("default"), null);
  assert.throws(() => validateModel("bad model name"), /Model name/);
  assert.equal(validateReasoningEffort("xhigh"), "xhigh");
  assert.equal(validateReasoningEffort("default"), null);
  assert.throws(() => validateReasoningEffort("too deep"), /Reasoning effort/);
  assert.deepEqual(imageInputs(["https://cdn.discordapp.com/attachments/1/2/screenshot.png"]), [
    { type: "image", url: "https://cdn.discordapp.com/attachments/1/2/screenshot.png" }
  ]);
  assert.throws(() => imageInputs(["http://cdn.discordapp.com/attachments/1/2/screenshot.png"]), /HTTPS/);
  assert.deepEqual(generatedImagePaths({ items: [
    { type: "imageGeneration", savedPath: "/tmp/generated.png", status: "completed" },
    { type: "agentMessage", text: "done" }
  ] }), ["/tmp/generated.png"]);
});

test("the model catalog uses only picker-visible models reported by Codex", async () => {
  const child = new FakeAppServer((request, respond) => {
    if (request.method === "initialize") respond({ id: request.id, result: {} });
    else if (request.method === "model/list" && !request.params.cursor) {
      respond({
        id: request.id,
        result: {
          data: [
            {
              id: "gpt-5.6-sol",
              model: "gpt-5.6-sol",
              displayName: "GPT-5.6 Sol",
              isDefault: true,
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: [
                { reasoningEffort: "low", description: "Fast" },
                { reasoningEffort: "medium", description: "Balanced" }
              ]
            },
            { id: "internal", model: "internal", hidden: true },
            { id: "not a model", model: "not a model" }
          ],
          nextCursor: "page-2"
        }
      });
    } else if (request.method === "model/list" && request.params.cursor === "page-2") {
      respond({
        id: request.id,
        result: {
          data: [{
            id: "gpt-5.6-luna",
            model: "gpt-5.6-luna",
            displayName: "GPT-5.6 Luna",
            defaultReasoningEffort: "low",
            supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }]
          }],
          nextCursor: null
        }
      });
    }
  });
  const runner = new CodexRunner({ maxRuntimeMs: 5_000, spawnImpl: () => child });

  const models = await runner.listModels({ workspace: "/srv/nexus" });

  assert.deepEqual(models, [
    {
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Fast" },
        { reasoningEffort: "medium", description: "Balanced" }
      ],
      inputModalities: ["text", "image"]
    },
    {
      id: "gpt-5.6-luna",
      displayName: "GPT-5.6 Luna",
      isDefault: false,
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }],
      inputModalities: ["text", "image"]
    }
  ]);
  assert.equal(child.killed, true);
});

test("usage limits are read from the authenticated Codex App Server account", async () => {
  const child = new FakeAppServer((request, respond) => {
    if (request.method === "initialize") respond({ id: request.id, result: {} });
    else if (request.method === "account/rateLimits/read") {
      assert.equal(request.params, undefined);
      respond({
        id: request.id,
        result: {
          rateLimits: {
            limitId: "codex",
            primary: { usedPercent: 25, windowDurationMins: 15, resetsAt: 1_730_947_200 },
            secondary: null
          }
        }
      });
    }
  });
  const runner = new CodexRunner({ maxRuntimeMs: 5_000, spawnImpl: () => child });

  const usage = await runner.getUsage({ workspace: "/srv/nexus" });

  assert.deepEqual(usage, {
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 25, windowDurationMins: 15, resetsAt: 1_730_947_200 },
      secondary: null
    }
  });
  assert.equal(child.killed, true);
});

test("an expired saved thread is replaced when its next turn cannot start", async () => {
  let requestedReasoningEffort = null;
  let requestedImageUrls = [];
  const child = new FakeAppServer((request, respond, notify) => {
    if (request.method === "initialize") respond({ id: request.id, result: {} });
    else if (request.method === "thread/resume") respond({ id: request.id, result: { thread: { id: "saved-thread" } } });
    else if (request.method === "turn/start" && request.params.threadId === "saved-thread") {
      respond({ id: request.id, error: { message: "Conversation expired" } });
    } else if (request.method === "thread/start") respond({ id: request.id, result: { thread: { id: "fresh-thread" } } });
    else if (request.method === "turn/start" && request.params.threadId === "fresh-thread") {
      requestedReasoningEffort = request.params.effort;
      requestedImageUrls = request.params.input.filter((input) => input.type === "image").map((input) => input.url);
      respond({ id: request.id, result: { turn: { id: "turn-1" } } });
      notify({
        method: "item/completed",
        params: { item: { id: "image-1", type: "imageGeneration", status: "completed", result: "ok", savedPath: "/tmp/generated.png" } }
      });
      notify({
        method: "turn/completed",
        params: { turn: { status: "completed", items: [{ type: "agentMessage", text: "Fresh session completed." }] } }
      });
    }
  });
  const saved = [];
  const progress = [];
  const runner = new CodexRunner({ maxRuntimeMs: 5_000, spawnImpl: () => child });

  const result = await runner.execute({
    key: "user:channel:workspace",
    workspace: "/srv/nexus",
    prompt: "Continue the task",
    reasoningEffort: "high",
    imageUrls: ["https://cdn.discordapp.com/attachments/1/2/screenshot.png"],
    resumeSessionId: "saved-thread",
    onSessionId: async (sessionId) => saved.push(sessionId),
    onProgress: async (event) => progress.push(event.method)
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.sessionId, "fresh-thread");
  assert.equal(result.message, "Fresh session completed.");
  assert.deepEqual(result.imagePaths, ["/tmp/generated.png"]);
  assert.deepEqual(saved, ["fresh-thread"]);
  assert.ok(progress.includes("bridge/sessionReset"));
  assert.equal(requestedReasoningEffort, "high");
  assert.deepEqual(requestedImageUrls, ["https://cdn.discordapp.com/attachments/1/2/screenshot.png"]);
});

test("zero max runtime leaves a Codex task running until it completes", async () => {
  const child = new FakeAppServer((request, respond, notify) => {
    if (request.method === "initialize") respond({ id: request.id, result: {} });
    else if (request.method === "thread/start") {
      respond({ id: request.id, result: { thread: { id: "unlimited-thread" } } });
    } else if (request.method === "turn/start") {
      respond({ id: request.id, result: { turn: { id: "turn-1" } } });
      setTimeout(() => notify({
        method: "turn/completed",
        params: { turn: { status: "completed", items: [{ type: "agentMessage", text: "Completed without a deadline." }] } }
      }), 20);
    }
  });
  const runner = new CodexRunner({ maxRuntimeMs: 0, spawnImpl: () => child });

  const result = await runner.execute({
    key: "user:channel:workspace",
    workspace: "/srv/nexus",
    prompt: "Finish eventually"
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.message, "Completed without a deadline.");
});

test("task-scoped automatic approval accepts current and subsequent permission types", async () => {
  const key = "user:channel:workspace";
  const decisions = [];
  let approvalPrompts = 0;
  let runner;
  const child = new FakeAppServer((request, respond, notify) => {
    if (request.method === "initialize") respond({ id: request.id, result: {} });
    else if (request.method === "thread/start") {
      respond({ id: request.id, result: { thread: { id: "approval-thread" } } });
    } else if (request.method === "turn/start") {
      respond({ id: request.id, result: { turn: { id: "turn-1" } } });
      notify({
        id: 101,
        method: "item/permissions/requestApproval",
        params: { permissions: { network: { host: ["example.com"] } } }
      });
    } else if (request.id === 101 && request.result) {
      decisions.push(request.result);
      notify({
        id: 102,
        method: "item/commandExecution/requestApproval",
        params: { command: "npm install", availableDecisions: ["accept", "decline"] }
      });
    } else if (request.id === 102 && request.result) {
      decisions.push(request.result);
      notify({
        method: "turn/completed",
        params: { turn: { status: "completed", items: [{ type: "agentMessage", text: "Approved task completed." }] } }
      });
    }
  });
  runner = new CodexRunner({ maxRuntimeMs: 0, spawnImpl: () => child });

  const result = await runner.execute({
    key,
    workspace: "/srv/nexus",
    prompt: "Complete the approved task",
    onApproval: (approval) => {
      approvalPrompts += 1;
      assert.equal(runner.approveAll(key, approval.requestId), true);
    }
  });

  assert.equal(result.exitCode, 0);
  assert.equal(approvalPrompts, 1);
  assert.deepEqual(decisions, [
    { permissions: { network: { host: ["example.com"] } }, scope: "turn" },
    { decision: "accept" }
  ]);
});

class FakeAppServer extends EventEmitter {
  constructor(handleRequest) {
    super();
    this.killed = false;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = {
      destroyed: false,
      write: (line) => {
        const request = JSON.parse(line);
        queueMicrotask(() => handleRequest(request, (response) => this.#send(response), (notification) => this.#send(notification)));
        return true;
      }
    };
  }

  kill() {
    this.killed = true;
    this.stdin.destroyed = true;
    return true;
  }

  #send(message) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
}
