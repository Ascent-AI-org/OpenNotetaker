import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const EMPTY_STATE = {
  version: 1,
  users: [],
  sessions: []
};

export const DEFAULT_USER_SETTINGS = {
  transcriptRecipients: [],
  autoEmailTranscript: false,
  calendarSyncEnabled: false,
  calendarAutoStart: true
};

export class UsersStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = structuredClone(EMPTY_STATE);
    this.writeQueue = Promise.resolve();
  }

  async load() {
    let data;
    try {
      data = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.persist();
      return;
    }

    try {
      const parsed = JSON.parse(data);
      this.state = {
        ...structuredClone(EMPTY_STATE),
        ...parsed,
        users: Array.isArray(parsed.users) ? parsed.users : [],
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : []
      };
    } catch {
      const backupPath = `${this.filePath}.corrupt-${Date.now()}`;
      await rename(this.filePath, backupPath);
      console.error(`users store was not valid JSON; moved it to ${backupPath} and started fresh.`);
      this.state = structuredClone(EMPTY_STATE);
      await this.persist();
      return;
    }

    // Role migration: pre-role users become members, and the earliest account is
    // promoted so there is always at least one admin.
    let migrated = false;
    for (const user of this.state.users) {
      if (!user.role) {
        user.role = "member";
        migrated = true;
      }
    }
    if (this.state.users.length && !this.state.users.some((user) => user.role === "admin")) {
      const first = [...this.state.users].sort((a, b) =>
        String(a.createdAt || "").localeCompare(String(b.createdAt || ""))
      )[0];
      first.role = "admin";
      migrated = true;
    }
    if (migrated) await this.persist();
  }

  countUsers() {
    return this.state.users.length;
  }

  listUsers() {
    return [...this.state.users];
  }

  getUser(id) {
    return this.state.users.find((user) => user.id === id) || null;
  }

  findUserByEmail(email) {
    const needle = String(email || "").trim().toLowerCase();
    return this.state.users.find((user) => user.email === needle) || null;
  }

  async createUser({ id, email, name, passwordHash, role }) {
    if (this.findUserByEmail(email)) {
      throw new Error("An account with this email already exists.");
    }
    const user = {
      id,
      email: String(email).trim().toLowerCase(),
      name: name || "",
      // The first account on a fresh instance administers the team.
      role: role || (this.state.users.length === 0 ? "admin" : "member"),
      passwordHash,
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
      lastLoginIp: "",
      settings: structuredClone(DEFAULT_USER_SETTINGS)
    };
    this.state.users.push(user);
    await this.persist();
    return user;
  }

  async updateUser(id, patch) {
    const index = this.state.users.findIndex((user) => user.id === id);
    if (index === -1) return null;
    const current = this.state.users[index];
    const next = {
      ...current,
      ...patch,
      // Settings merge shallowly so a partial settings patch never wipes the rest.
      settings: {
        ...structuredClone(DEFAULT_USER_SETTINGS),
        ...current.settings,
        ...(patch.settings || {})
      }
    };
    this.state.users[index] = next;
    await this.persist();
    return next;
  }

  async createSession({ tokenHash, userId, ttlMs, ip, userAgent }) {
    const now = Date.now();
    const session = {
      tokenHash,
      userId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      ip: String(ip || "").slice(0, 60),
      userAgent: String(userAgent || "").slice(0, 200)
    };
    this.state.sessions.push(session);
    await this.persist();
    return session;
  }

  getSessionByTokenHash(tokenHash, nowMs = Date.now()) {
    const session = this.state.sessions.find((item) => item.tokenHash === tokenHash) || null;
    if (!session) return null;
    if (Date.parse(session.expiresAt) <= nowMs) return null;
    return session;
  }

  async touchSession(tokenHash, ttlMs, nowMs = Date.now()) {
    const session = this.state.sessions.find((item) => item.tokenHash === tokenHash);
    if (!session) return null;
    session.lastSeenAt = new Date(nowMs).toISOString();
    session.expiresAt = new Date(nowMs + ttlMs).toISOString();
    await this.persist();
    return session;
  }

  async removeUser(id) {
    const before = this.state.users.length;
    this.state.users = this.state.users.filter((user) => user.id !== id);
    this.state.sessions = this.state.sessions.filter((session) => session.userId !== id);
    if (this.state.users.length !== before) await this.persist();
  }

  async deleteSessionByTokenHash(tokenHash) {
    const before = this.state.sessions.length;
    this.state.sessions = this.state.sessions.filter((item) => item.tokenHash !== tokenHash);
    if (this.state.sessions.length !== before) await this.persist();
  }

  async deleteUserSessions(userId) {
    const before = this.state.sessions.length;
    this.state.sessions = this.state.sessions.filter((item) => item.userId !== userId);
    if (this.state.sessions.length !== before) await this.persist();
  }

  async pruneExpiredSessions(nowMs = Date.now()) {
    const before = this.state.sessions.length;
    this.state.sessions = this.state.sessions.filter((item) => Date.parse(item.expiresAt) > nowMs);
    if (this.state.sessions.length !== before) await this.persist();
    return before - this.state.sessions.length;
  }

  async persist() {
    // Same non-poisoning queue as JsonStore: a failed write rejects its caller but
    // never blocks subsequent writes.
    const write = this.writeQueue.catch(() => {}).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(tempPath, this.filePath);
    });
    this.writeQueue = write;
    return write;
  }
}

// Never send passwordHash (or future secret fields) to the client.
export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role || "member",
    createdAt: user.createdAt,
    settings: {
      ...structuredClone(DEFAULT_USER_SETTINGS),
      ...user.settings
    }
  };
}
