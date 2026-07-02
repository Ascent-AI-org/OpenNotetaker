import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const EMPTY_STATE = {
  version: 1,
  meetings: []
};

export class JsonStore {
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
        meetings: Array.isArray(parsed.meetings) ? parsed.meetings : []
      };
    } catch {
      // A corrupted store file must not crash-loop the server on boot. Keep the bad
      // file for manual recovery and start from an empty state.
      const backupPath = `${this.filePath}.corrupt-${Date.now()}`;
      await rename(this.filePath, backupPath);
      console.error(`meetings store was not valid JSON; moved it to ${backupPath} and started fresh.`);
      this.state = structuredClone(EMPTY_STATE);
      await this.persist();
    }
  }

  listMeetings() {
    return [...this.state.meetings].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getMeeting(id) {
    return this.state.meetings.find((meeting) => meeting.id === id) || null;
  }

  async createMeeting(input) {
    const meeting = {
      id: crypto.randomUUID(),
      ownerId: input.ownerId || null,
      title: input.title,
      meetUrl: input.meetUrl,
      scheduledAt: input.scheduledAt,
      consentMode: input.consentMode,
      retentionDays: input.retentionDays,
      status: "scheduled",
      statusMessage: "Waiting for the bot runner.",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      source: input.source || null,
      artifacts: {
        rawSegments: [],
        normalizedSegments: [],
        notes: null
      },
      events: [
        {
          at: new Date().toISOString(),
          type: "meeting.created",
          message: "Notetaker job created."
        }
      ]
    };

    this.state.meetings.push(meeting);
    await this.persist();
    return meeting;
  }

  async updateMeeting(id, patch) {
    const index = this.state.meetings.findIndex((meeting) => meeting.id === id);
    if (index === -1) return null;

    const current = this.state.meetings[index];
    const next = {
      ...current,
      ...patch,
      artifacts: {
        ...current.artifacts,
        ...(patch.artifacts || {})
      },
      updatedAt: new Date().toISOString()
    };
    this.state.meetings[index] = next;
    await this.persist();
    return next;
  }

  async appendEvent(id, event) {
    const meeting = this.getMeeting(id);
    if (!meeting) return null;
    return this.updateMeeting(id, {
      events: [
        ...meeting.events,
        {
          at: new Date().toISOString(),
          ...event
        }
      ]
    });
  }

  async persist() {
    // Recover the chain from a previous failed write before appending the next one:
    // chaining .then() onto a rejected promise would silently skip every future write,
    // while the caller of THIS write still needs to observe its own failure.
    const write = this.writeQueue.catch(() => {}).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
      await rename(tempPath, this.filePath);
    });
    this.writeQueue = write;
    return write;
  }
}
