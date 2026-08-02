import test from "node:test";
import assert from "node:assert/strict";
import { resumeArgs, sessionIdFromEvent, startArgs, validateModel, validatePrompt } from "../src/codex-runner.mjs";

const sessionId = "123e4567-e89b-42d3-a456-426614174000";

test("Codex commands always use the workspace-write sandbox and never a shell", () => {
  const args = startArgs({ workspace: "/srv/nexus", prompt: "Run tests", outputFile: "/tmp/result.txt" });
  assert.deepEqual(args.slice(0, 7), ["exec", "--json", "--sandbox", "workspace-write", "--cd", "/srv/nexus", "--output-last-message"]);
  assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
  assert.equal(startArgs({ workspace: "/home/thomas/workspace", prompt: "Inspect every module", outputFile: "/tmp/result.txt", skipGitRepoCheck: true }).includes("--skip-git-repo-check"), true);
  assert.deepEqual(resumeArgs({ sessionId, prompt: "Continue", outputFile: "/tmp/result.txt" }).slice(0, 5), ["exec", "resume", "--json", "--output-last-message", "/tmp/result.txt"]);
  assert.deepEqual(startArgs({ workspace: "/srv/nexus", prompt: "Run tests", outputFile: "/tmp/result.txt", model: "gpt-5.6-terra" }).slice(-3), ["--model", "gpt-5.6-terra", "Run tests"]);
  assert.deepEqual(resumeArgs({ sessionId, prompt: "Continue", outputFile: "/tmp/result.txt", model: "gpt-5.6-terra" }).slice(-4), ["--model", "gpt-5.6-terra", sessionId, "Continue"]);
});

test("session IDs are extracted only from valid Codex JSON events", () => {
  assert.equal(sessionIdFromEvent({ thread_id: sessionId }), sessionId);
  assert.equal(sessionIdFromEvent({ data: { session: { id: sessionId } } }), sessionId);
  assert.equal(sessionIdFromEvent({ thread_id: "not-a-session" }), null);
  assert.equal(validatePrompt("  Update the tests  "), "Update the tests");
  assert.throws(() => validatePrompt(""), /cannot be empty/);
  assert.equal(validateModel("gpt-5.6-terra"), "gpt-5.6-terra");
  assert.equal(validateModel("default"), null);
  assert.throws(() => validateModel("bad model name"), /Model name/);
});
