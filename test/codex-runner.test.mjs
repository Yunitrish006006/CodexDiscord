import test from "node:test";
import assert from "node:assert/strict";
import { resumeArgs, sessionIdFromEvent, startArgs, validatePrompt } from "../src/codex-runner.mjs";

const sessionId = "123e4567-e89b-42d3-a456-426614174000";

test("Codex commands always use the workspace-write sandbox and never a shell", () => {
  const args = startArgs({ workspace: "/srv/nexus", prompt: "Run tests", outputFile: "/tmp/result.txt" });
  assert.deepEqual(args.slice(0, 7), ["exec", "--json", "--sandbox", "workspace-write", "--cd", "/srv/nexus", "--output-last-message"]);
  assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
  assert.deepEqual(resumeArgs({ sessionId, prompt: "Continue", outputFile: "/tmp/result.txt" }).slice(0, 5), ["exec", "resume", "--json", "--output-last-message", "/tmp/result.txt"]);
});

test("session IDs are extracted only from valid Codex JSON events", () => {
  assert.equal(sessionIdFromEvent({ thread_id: sessionId }), sessionId);
  assert.equal(sessionIdFromEvent({ data: { session: { id: sessionId } } }), sessionId);
  assert.equal(sessionIdFromEvent({ thread_id: "not-a-session" }), null);
  assert.equal(validatePrompt("  Update the tests  "), "Update the tests");
  assert.throws(() => validatePrompt(""), /cannot be empty/);
});
