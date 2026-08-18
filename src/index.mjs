import { mkdir } from "node:fs/promises";
import { loadConfig } from "./config.mjs";
import { SessionStore } from "./session-store.mjs";
import { CodexRunner } from "./codex-runner.mjs";
import { registerCommands, startBot } from "./bot.mjs";

const config = loadConfig();
await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
const sessions = new SessionStore(config.stateDir);
await sessions.load();
const runner = new CodexRunner({ stateDir: config.stateDir, maxRuntimeMs: config.maxRuntimeMs });
const catalogWorkspace = config.workspaces.values().next().value;
const models = await runner.listModels({ workspace: catalogWorkspace.path });
if (models.length === 0) throw new Error("Codex did not report any picker-visible models for this login");
await registerCommands(config);
await startBot({
  config,
  sessions,
  runner,
  models
});
