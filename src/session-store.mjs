import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export function sessionKey({ userId, channelId, workspace }) {
  return `${userId}:${channelId}:${workspace}`;
}

export function conversationKey({ userId, channelId }) {
  return `${userId}:${channelId}`;
}

export class SessionStore {
  #file;
  #sessions = new Map();
  #activeWorkspaces = new Map();

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
      if (raw && typeof raw === "object" && raw.activeWorkspaces && typeof raw.activeWorkspaces === "object") {
        for (const [key, workspace] of Object.entries(raw.activeWorkspaces)) {
          if (typeof workspace === "string") this.#activeWorkspaces.set(key, workspace);
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

  activeWorkspace(key) {
    return this.#activeWorkspaces.get(key) ?? null;
  }

  async setActiveWorkspace(key, workspace) {
    this.#activeWorkspaces.set(key, workspace);
    await this.#save();
  }

  async #save() {
    const payload = JSON.stringify({
      sessions: Object.fromEntries(this.#sessions),
      activeWorkspaces: Object.fromEntries(this.#activeWorkspaces)
    }, null, 2) + "\n";
    const temp = `${this.#file}.${process.pid}.tmp`;
    await writeFile(temp, payload, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, this.#file);
  }
}
