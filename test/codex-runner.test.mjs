import test from "node:test";
import assert from "node:assert/strict";
import { approvalResponse, finalAgentMessage, threadResumeParams, threadStartParams, turnStartParams, validateModel, validatePrompt } from "../src/codex-runner.mjs";

test("Codex App Server sessions always confine writes to the selected workspace", () => {
  const start = threadStartParams({ workspace: "/srv/nexus", model: "gpt-5.6-terra" });
  assert.deepEqual(start, {
    cwd: "/srv/nexus",
    runtimeWorkspaceRoots: ["/srv/nexus"],
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    model: "gpt-5.6-terra"
  });
  assert.equal(JSON.stringify(start).includes("danger-full-access"), false);
  assert.deepEqual(threadResumeParams({ threadId: "thread-123", workspace: "/srv/nexus" }).runtimeWorkspaceRoots, ["/srv/nexus"]);

  const turn = turnStartParams({ threadId: "thread-123", workspace: "/srv/nexus", prompt: "Run tests" });
  assert.deepEqual(turn.sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: ["/srv/nexus"],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  });
  assert.deepEqual(turn.input, [{ type: "text", text: "Run tests" }]);
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

test("final messages and user input are validated before reaching Codex", () => {
  assert.equal(finalAgentMessage({ items: [{ type: "agentMessage", text: " first " }, { type: "agentMessage", text: " final " }] }), "final");
  assert.equal(validatePrompt("  Update the tests  "), "Update the tests");
  assert.throws(() => validatePrompt(""), /cannot be empty/);
  assert.equal(validateModel("gpt-5.6-terra"), "gpt-5.6-terra");
  assert.equal(validateModel("default"), null);
  assert.throws(() => validateModel("bad model name"), /Model name/);
});
