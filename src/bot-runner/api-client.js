// fetch() has no default timeout, and every video call is on the path that ends a
// meeting. Without these a stalled upload or a wedged remux holds the worker forever.
const VIDEO_CHUNK_TIMEOUT_MS = 60_000;
const VIDEO_FINALIZE_TIMEOUT_MS = 110_000;

export class RunnerApiClient {
  constructor({ baseUrl, token, meetingId }) {
    if (!baseUrl) throw new Error("RunnerApiClient requires OPENNOTETAKER_BASE_URL.");
    if (!token) throw new Error("RunnerApiClient requires RUNNER_TOKEN.");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    // Optional: fleet workers create a claim-only client first, then a per-meeting
    // client once a job is assigned.
    this.meetingId = meetingId || "";
  }

  requireMeetingId() {
    if (!this.meetingId) throw new Error("RunnerApiClient requires meetingId for meeting-scoped calls.");
    return this.meetingId;
  }

  async claimJob(workerId) {
    return this.request("/api/runner/jobs/claim", {
      method: "POST",
      body: { workerId }
    });
  }

  async getMeeting() {
    // Meeting reads go through the runner-token endpoint: the public meetings API is
    // session-authenticated and owner-scoped.
    const body = await this.request(`/api/runner/meetings/${this.requireMeetingId()}`, { method: "GET" });
    return body.meeting;
  }

  async updateMeeting(patch) {
    const body = await this.request(`/api/runner/meetings/${this.meetingId}`, {
      method: "PATCH",
      body: patch
    });
    return body.meeting;
  }

  async appendEvent(type, message) {
    const body = await this.request(`/api/runner/meetings/${this.meetingId}/events`, {
      method: "POST",
      body: { type, message }
    });
    return body.meeting;
  }

  async appendSegments(segments) {
    return this.request(`/api/runner/meetings/${this.meetingId}/segments`, {
      method: "POST",
      body: { segments }
    });
  }

  async submitRawTranscript(rawSegments) {
    return this.request(`/api/runner/meetings/${this.meetingId}/raw-transcript`, {
      method: "POST",
      body: { rawSegments }
    });
  }

  // The worker container has no writable volume, so video bytes reach the app the same
  // way transcript segments do: over this API. `offset` is where the caller believes the
  // server's partial file ends, and the server answers with its own size — that, not any
  // sequence number held here, is what makes a retried or restarted upload recover
  // instead of duplicating bytes into the middle of a media stream.
  async appendVideoChunk(offset, buffer) {
    return this.requestBytes(
      `/api/runner/meetings/${this.requireMeetingId()}/video?offset=${encodeURIComponent(offset)}`,
      { body: buffer, timeoutMs: VIDEO_CHUNK_TIMEOUT_MS }
    );
  }

  async finalizeVideo() {
    const payload = await this.request(`/api/runner/meetings/${this.requireMeetingId()}/video/finalize`, {
      method: "POST",
      body: {},
      // Finalize is a remux of the whole meeting on the app container. It is seconds of
      // work, but a wedged ffmpeg there must not hold this worker open: the transcript
      // submission is queued behind it.
      timeoutMs: VIDEO_FINALIZE_TIMEOUT_MS
    });
    return payload.video;
  }

  async request(path, { method, body, runnerAuth = true, timeoutMs = 0 }) {
    const headers = { "Content-Type": "application/json" };
    if (runnerAuth) headers.Authorization = `Bearer ${this.token}`;

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.message || payload.error || `Request failed with ${response.status}.`);
    }
    return payload;
  }

  // Separate from request() rather than folded into it: the body is raw bytes instead of
  // JSON, and a rejection has to reach the caller as data (the offset to resync to, the
  // status that says "stop capturing") instead of as a message string it would have to
  // pattern-match. Keeping them apart leaves the JSON path the simple thing it is.
  async requestBytes(path, { body, timeoutMs }) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        Authorization: `Bearer ${this.token}`
      },
      body,
      signal: AbortSignal.timeout(timeoutMs)
    });
    // An error body is not guaranteed to be JSON (a proxy's own 413 page, for one), and
    // a parse failure must not mask the status the caller needs to act on.
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.message || payload.error || `Request failed with ${response.status}.`);
      error.status = response.status;
      error.code = typeof payload.error === "string" ? payload.error : "";
      if (Number.isSafeInteger(payload.expected)) error.expected = payload.expected;
      throw error;
    }
    return payload;
  }
}
