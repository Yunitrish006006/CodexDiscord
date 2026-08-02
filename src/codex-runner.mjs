import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PROMPT_LENGTH = 6_000;

export function validatePrompt(prompt) {
  const normalized = prompt?.trim();
  if (!normalized) throw new Error("Task cannot be empty");
  if (normalized.length > MAX_PROMPT_LENGTH) throw new Error(`Task must be at most ${MAX_PROMPT_LENGTH} characters`);
  return normalized;
}

export function startArgs({ workspace, prompt, outputFile }) {
  return [
    "exec", "--json", "--sandbox", "workspace-write", "--cd", workspace,
    "--output-last-message", outputFile, prompt
  ];
}

export function resumeArgs({ sessionId, prompt, outputFile }) {
  if (!UUID.test(sessionId)) throw new Error("Saved Codex session ID is invalid");
  return ["exec", "resume", "--json", "--output-last-message", outputFile, sessionId, prompt];
}

export function sessionIdFromEvent(event) {
  const candidates = [
    event?.thread_id,
    event?.session_id,
    event?.thread?.id,
    event?.session?.id,
    event?.data?.thread_id,
    event?.data?.session_id,
    event?.data?.thread?.id,
    event?.data?.session?.id
  ];
  return candidates.find((candidate) => typeof candidate === "string" && UUID.test(candidate)) ?? null;
}

function tail(text, limit = 8_000) {
  return text.length <= limit ? text : text.slice(-limit);
}

export class CodexRunner {
  #stateDir;
  #maxRuntimeMs;
  #spawn;
  #runs = new Map();

  constructor({ stateDir, maxRuntimeMs, spawnImpl = spawn }) {
    this.#stateDir = stateDir;
    this.#maxRuntimeMs = maxRuntimeMs;
    this.#spawn = spawnImpl;
  }

  isRunning(key) {
    return this.#runs.has(key);
  }

  cancel(key) {
    const child = this.#runs.get(key);
    if (!child) return false;
    child.kill("SIGTERM");
    return true;
  }

  async execute({ key, workspace, prompt, resumeSessionId = null, onSessionId = () => {} }) {
    if (this.#runs.has(key)) throw new Error("A Codex task is already running for this workspace session");
    const safePrompt = validatePrompt(prompt);
    const outputFile = path.join(this.#stateDir, `result-${process.pid}-${Date.now()}.txt`);
    const args = resumeSessionId
      ? resumeArgs({ sessionId: resumeSessionId, prompt: safePrompt, outputFile })
      : startArgs({ workspace, prompt: safePrompt, outputFile });

    return await new Promise((resolve, reject) => {
      let child;
      try {
        child = this.#spawn("codex", args, { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        reject(error);
        return;
      }
      this.#runs.set(key, child);
      let stderr = "";
      let stdout = "";
      let discoveredSessionId = resumeSessionId;
      let timedOut = false;
      const sessionWrites = [];
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, this.#maxRuntimeMs);

      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        stdout = tail(`${stdout}${line}\n`);
        try {
          const sessionId = sessionIdFromEvent(JSON.parse(line));
          if (sessionId && sessionId !== discoveredSessionId) {
            discoveredSessionId = sessionId;
            sessionWrites.push(Promise.resolve(onSessionId(sessionId)));
          }
        } catch {
          // Codex JSONL is diagnostic input only; the final output file is authoritative.
        }
      });
      child.stderr.on("data", (chunk) => { stderr = tail(`${stderr}${chunk}`); });
      child.once("error", (error) => {
        clearTimeout(timer);
        this.#runs.delete(key);
        reject(error);
      });
      child.once("close", async (exitCode, signal) => {
        clearTimeout(timer);
        this.#runs.delete(key);
        let message = "";
        try {
          message = (await readFile(outputFile, "utf8")).trim();
        } catch {
          message = "";
        } finally {
          await rm(outputFile, { force: true });
        }
        try {
          await Promise.all(sessionWrites);
        } catch (error) {
          reject(error);
          return;
        }
        resolve({
          exitCode,
          signal,
          timedOut,
          sessionId: discoveredSessionId,
          message: message || stderr.trim() || stdout.trim() || "Codex returned no final message."
        });
      });
    });
  }
}
