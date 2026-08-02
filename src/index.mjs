import { mkdir } from "node:fs/promises";
import { loadConfig } from "./config.mjs";
import { SessionStore } from "./session-store.mjs";
import { CodexRunner } from "./codex-runner.mjs";
import { registerCommands, startBot } from "./bot.mjs";

const config = loadConfig();
await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
const sessions = new SessionStore(config.stateDir);
await sessions.load();
await registerCommands(config);
await startBot({
  config,
  sessions,
  runner: new CodexRunner({ stateDir: config.stateDir, maxRuntimeMs: config.maxRuntimeMs })
});
