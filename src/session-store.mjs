import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export function sessionKey({ userId, channelId, workspace }) {
  return `${userId}:${channelId}:${workspace}`;
}

export class SessionStore {
  #file;
  #sessions = new Map();

  constructor(stateDir) {
    this.#file = path.join(stateDir, "sessions.json");
  }

  async load() {
    await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    try {
      const raw = JSON.parse(await readFile(this.#file, "utf8"));
      if (raw && typeof raw === "object" && raw.sessions && typeof raw.sessions === "object") {
        for (const [key, value] of Object.entries(raw.sessions)) {
          if (typeof value?.sessionId === "string" && typeof value?.workspace === "string") {
            this.#sessions.set(key, value);
          }
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  get(key) {
    return this.#sessions.get(key) ?? null;
  }

  async set(key, value) {
    this.#sessions.set(key, Object.freeze({ ...value }));
    await this.#save();
  }

  async delete(key) {
    const deleted = this.#sessions.delete(key);
    if (deleted) await this.#save();
    return deleted;
  }

  async #save() {
    const payload = JSON.stringify({ sessions: Object.fromEntries(this.#sessions) }, null, 2) + "\n";
    const temp = `${this.#file}.${process.pid}.tmp`;
    await writeFile(temp, payload, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, this.#file);
  }
}
