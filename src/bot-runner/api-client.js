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

  async request(path, { method, body, runnerAuth = true }) {
    const headers = { "Content-Type": "application/json" };
    if (runnerAuth) headers.Authorization = `Bearer ${this.token}`;

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.message || payload.error || `Request failed with ${response.status}.`);
    }
    return payload;
  }
}
