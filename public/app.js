const state = {
  user: null,
  authMode: "login",
  meetings: null, // null = not loaded yet (skeletons); [] = loaded, empty
  gmail: null,
  calendar: null,
  selectedId: null,
  view: "detail", // "detail" | "calendar"
  weekOffset: 0,
  pollTimer: null,
  runningStarts: new Set(),
  sendingEmails: new Set(),
  syncingCalendar: false,
  openFolds: new Set(["transcript"])
};

const renderCache = { list: "", detail: "" };

const STATUS_META = {
  scheduled: { label: "Scheduled", tone: "muted" },
  queued: { label: "Waiting for bot", tone: "amber" },
  following: { label: "Shared recording", tone: "accent" },
  recording: { label: "Recording", tone: "live" },
  transcribing: { label: "Making notes", tone: "amber" },
  normalizing: { label: "Making notes", tone: "amber" },
  reconstructing: { label: "Making notes", tone: "amber" },
  completed: { label: "Notes ready", tone: "ok" },
  failed: { label: "Failed", tone: "bad" }
};

// Linear-style status glyphs: dashed = not started, half-fill = working,
// filled check = done. The icon carries the status; labels stay quiet.
const STATUS_ICONS = {
  scheduled: `<svg class="sicon" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5.4" fill="none" stroke="#9a9ca6" stroke-width="1.6" stroke-dasharray="2.4 2"/></svg>`,
  queued: `<svg class="sicon" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5.4" fill="none" stroke="#d9a514" stroke-width="1.6"/></svg>`,
  following: `<svg class="sicon" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5.4" fill="none" stroke="#5e6ad2" stroke-width="1.6"/><circle cx="7" cy="7" r="2.2" fill="#5e6ad2"/></svg>`,
  recording: `<svg class="sicon sicon-live" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="#d3494e"/></svg>`,
  processing: `<svg class="sicon" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5.4" fill="none" stroke="#d9a514" stroke-width="1.6"/><path d="M7 3.4 A3.6 3.6 0 0 1 7 10.6 Z" fill="#d9a514"/></svg>`,
  completed: `<svg class="sicon" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6" fill="#5e6ad2"/><path d="M4.4 7.2 L6.2 9 L9.6 5.2" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  failed: `<svg class="sicon" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6" fill="#d3494e"/><path d="M5 5 L9 9 M9 5 L5 9" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/></svg>`
};

function statusIcon(status) {
  const key = ["transcribing", "normalizing", "reconstructing"].includes(status) ? "processing" : status;
  return STATUS_ICONS[key] || STATUS_ICONS.scheduled;
}

const $ = (selector) => document.querySelector(selector);

const appShell = $("#app-shell");
const authGate = $("#auth-gate");
const authForm = $("#auth-form");
const authTitle = $("#auth-title");
const authNameField = $("#auth-name-field");
const authName = $("#auth-name");
const authEmail = $("#auth-email");
const authPassword = $("#auth-password");
const authPasswordField = $("#auth-password-field");
const authPasswordLabel = $("#auth-password-label");
const authTokenField = $("#auth-token-field");
const authToken = $("#auth-token");
const authSubmit = $("#auth-submit");
const authError = $("#auth-error");
const authNotice = $("#auth-notice");
const authToggle = $("#auth-toggle");
const authForgot = $("#auth-forgot");

const meetingList = $("#meeting-list");
const detail = $("#meeting-detail");
const calendarViewButton = $("#calendar-view-button");
const appError = $("#app-error");
const newMeetingButton = $("#new-meeting-button");
const userChip = $("#user-chip");
const logoutButton = $("#logout-button");
const settingsButton = $("#settings-button");
const googleDot = $("#google-dot");
const googleStatusLabel = $("#google-status-label");

const createDialog = $("#create-dialog");
const meetingForm = $("#meeting-form");
const formError = $("#form-error");
const createButton = $("#create-button");

const settingsDialog = $("#settings-dialog");
const gmailStatusText = $("#gmail-status-text");
const gmailRecipientText = $("#gmail-recipient-text");
const gmailConnect = $("#gmail-connect");
const calendarStatusText = $("#calendar-status-text");
const calendarMetaText = $("#calendar-meta-text");
const calendarSyncButton = $("#calendar-sync");
const settingsRecipients = $("#settings-recipients");
const settingsAutoEmail = $("#settings-auto-email");
const settingsCalendarSync = $("#settings-calendar-sync");
const settingsCalendarAutostart = $("#settings-calendar-autostart");
const settingsSave = $("#settings-save");
const settingsStatus = $("#settings-status");
const passwordCurrent = $("#password-current");
const passwordNew = $("#password-new");
const passwordChange = $("#password-change");
const passwordStatus = $("#password-status");
const teamViewButton = $("#team-view-button");
const teamDialog = $("#team-dialog");
const teamList = $("#team-list");
const inviteEmail = $("#invite-email");
const inviteName = $("#invite-name");
const inviteSend = $("#invite-send");
const inviteStatus = $("#invite-status");
const inviteResult = $("#invite-result");
const inviteLink = $("#invite-link");
const inviteCopy = $("#invite-copy");

authToggle.addEventListener("click", () => setAuthMode(state.authMode === "login" ? "signup" : "login"));
authForgot.addEventListener("click", () => setAuthMode(state.authMode === "forgot" || state.authMode === "reset" ? "login" : "forgot"));
authForm.addEventListener("submit", handleAuthSubmit);
logoutButton.addEventListener("click", handleLogout);
newMeetingButton.addEventListener("click", openCreateDialog);
settingsButton.addEventListener("click", openSettingsDialog);
meetingForm.addEventListener("submit", handleCreateMeeting);
settingsSave.addEventListener("click", saveSettings);
passwordChange.addEventListener("click", changePassword);
calendarSyncButton.addEventListener("click", syncCalendar);

for (const closer of document.querySelectorAll("[data-close-dialog]")) {
  closer.addEventListener("click", () => closer.closest("dialog")?.close());
}

// Preserve which collapsible sections the user opened across poll re-renders.
detail.addEventListener(
  "toggle",
  (event) => {
    const fold = event.target.closest("details[data-fold]");
    if (!fold) return;
    if (fold.open) state.openFolds.add(fold.dataset.fold);
    else state.openFolds.delete(fold.dataset.fold);
  },
  true
);

// Meeting selection via event delegation: the list re-renders on every data change.
meetingList.addEventListener("click", (event) => {
  const card = event.target.closest(".meeting-card");
  if (!card) return;
  selectMeeting(card.dataset.id);
});

calendarViewButton.addEventListener("click", () => showCalendarView());
teamViewButton.addEventListener("click", openTeamDialog);
inviteSend.addEventListener("click", sendInvite);
inviteCopy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(inviteLink.value);
    inviteCopy.textContent = "Copied";
    setTimeout(() => (inviteCopy.textContent = "Copy"), 1500);
  } catch {
    inviteLink.select();
  }
});
teamList.addEventListener("click", handleTeamAction);

// Keyboard: C creates a meeting, J/K move through the list, V toggles the calendar,
// arrows page weeks while the calendar is open (Linear-style).
document.addEventListener("keydown", (event) => {
  if (!state.user) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target.closest("input, textarea, select")) return;
  if (document.querySelector("dialog[open]")) return;
  const key = event.key.toLowerCase();
  if (key === "c") {
    event.preventDefault();
    openCreateDialog();
  } else if (key === "v") {
    event.preventDefault();
    if (state.view === "calendar") selectMeeting(state.selectedId);
    else showCalendarView();
  } else if (key === "j" || key === "k") {
    event.preventDefault();
    const ordered = groupedMeetings().flatMap(({ items }) => items.map((meeting) => meeting.id));
    if (!ordered.length) return;
    const index = ordered.indexOf(state.selectedId);
    const next = ordered[Math.min(ordered.length - 1, Math.max(0, index + (key === "j" ? 1 : -1)))];
    selectMeeting(next);
  } else if (state.view === "calendar" && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
    event.preventDefault();
    shiftWeek(event.key === "ArrowLeft" ? -1 : 1);
  }
});

function selectMeeting(id) {
  state.selectedId = id;
  state.view = "detail";
  renderCache.list = "";
  renderCache.detail = "";
  updateViewNav();
  renderList();
  renderMain();
  // The list only carries a summary; fetch the full transcript for whatever
  // just got selected and re-render once it lands.
  void ensureMeetingDetail(id).then((changed) => {
    if (changed && state.selectedId === id) renderMain();
  });
}

function showCalendarView() {
  state.view = "calendar";
  state.weekOffset = 0;
  renderCache.detail = "";
  updateViewNav();
  renderMain();
}

function updateViewNav() {
  calendarViewButton.classList.toggle("active", state.view === "calendar");
}

function renderMain() {
  // The calendar breaks out of the reading column and fills the viewport.
  detail.classList.toggle("is-calendar", state.view === "calendar");
  if (state.view === "calendar") renderCalendar();
  else renderDetail();
}

function shiftWeek(delta, reset = false) {
  state.weekOffset = reset ? 0 : state.weekOffset + delta;
  renderCache.detail = "";
  renderCalendar();
}

function groupedMeetings() {
  const groups = [
    { label: "In progress", filter: (m) => !["scheduled", "completed", "failed"].includes(m.status) },
    { label: "Scheduled", filter: (m) => m.status === "scheduled" },
    { label: "History", filter: (m) => ["completed", "failed"].includes(m.status) }
  ];
  return groups
    .map(({ label, filter }) => ({ label, items: (state.meetings || []).filter(filter) }))
    .filter(({ items }) => items.length);
}

await boot();

async function boot() {
  // Invite links land here: /?invite=<code>&email=<address> prefills the
  // set-password form (the invite code is a single-use reset code).
  const params = new URLSearchParams(location.search);
  const authErrorCode = params.get("auth_error");
  if (authErrorCode) {
    history.replaceState(null, "", location.pathname);
    showAuthGate();
    authError.textContent =
      authErrorCode === "no_account"
        ? "No account for that Google email — ask an admin for an invite."
        : "Google sign-in failed. Try again or use your password.";
    return;
  }
  const inviteToken = params.get("invite");
  if (inviteToken) {
    history.replaceState(null, "", location.pathname);
    showAuthGate();
    setAuthMode("reset");
    authEmail.value = params.get("email") || "";
    authToken.value = inviteToken;
    authTitle.textContent = "Join OpenNotetaker";
    authNotice.textContent = "You've been invited — choose a password to finish setting up your account.";
    return;
  }
  try {
    const { user } = await api("/api/auth/me");
    enterApp(user);
  } catch {
    showAuthGate();
  }
}

/* ---------- Team admin ---------- */

function openTeamDialog() {
  inviteStatus.textContent = "";
  inviteResult.hidden = true;
  teamDialog.showModal();
  void loadTeam();
}

async function loadTeam() {
  teamList.innerHTML = `<div class="skeleton skeleton-card"></div>`;
  try {
    const { users } = await api("/api/admin/users");
    teamList.innerHTML = users
      .map((member) => {
        const isSelf = member.id === state.user.id;
        const meta = [
          member.email,
          `${member.meetingCount} meeting${member.meetingCount === 1 ? "" : "s"}`,
          member.googleConnected ? "Google connected" : "Google not connected",
          member.lastLoginAt ? `last seen ${formatDayTime(member.lastLoginAt)}` : "never signed in"
        ].join(" · ");
        return `
          <div class="team-row" data-id="${escapeHtml(member.id)}">
            <div class="team-row-main">
              <span class="team-row-name">${escapeHtml(member.name || member.email)}${isSelf ? " (you)" : ""}</span>
              <span class="team-row-meta">${escapeHtml(meta)}</span>
            </div>
            ${member.pendingInvite ? `<span class="team-badge pending">Invited</span>` : ""}
            <span class="team-badge${member.role === "admin" ? " admin" : ""}">${escapeHtml(member.role)}</span>
            ${
              isSelf
                ? ""
                : `<div class="team-row-actions">
                    <button class="btn btn-ghost btn-sm" data-action="invite" type="button">New link</button>
                    <button class="btn btn-ghost btn-sm" data-action="role" data-role="${member.role === "admin" ? "member" : "admin"}" type="button">${member.role === "admin" ? "Make member" : "Make admin"}</button>
                    <button class="btn btn-ghost btn-sm" data-action="remove" type="button">Remove</button>
                  </div>`
            }
          </div>
        `;
      })
      .join("");
  } catch (error) {
    teamList.innerHTML = `<p class="settings-hint">${escapeHtml(error.message)}</p>`;
  }
}

async function sendInvite() {
  inviteStatus.textContent = "Creating…";
  inviteResult.hidden = true;
  try {
    const { inviteUrl } = await api("/api/admin/users", {
      method: "POST",
      body: JSON.stringify({ email: inviteEmail.value, name: inviteName.value })
    });
    inviteLink.value = inviteUrl;
    inviteResult.hidden = false;
    inviteStatus.textContent = "";
    inviteEmail.value = "";
    inviteName.value = "";
    await loadTeam();
  } catch (error) {
    inviteStatus.textContent = error.message;
  }
}

async function handleTeamAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const row = button.closest(".team-row");
  const id = row?.dataset.id;
  if (!id) return;
  try {
    if (button.dataset.action === "invite") {
      const { inviteUrl } = await api(`/api/admin/users/${id}/invite`, { method: "POST" });
      inviteLink.value = inviteUrl;
      inviteResult.hidden = false;
    } else if (button.dataset.action === "role") {
      await api(`/api/admin/users/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ role: button.dataset.role })
      });
      await loadTeam();
    } else if (button.dataset.action === "remove") {
      if (!window.confirm("Remove this account? Their meetings stay stored but become inaccessible.")) return;
      await api(`/api/admin/users/${id}`, { method: "DELETE" });
      await loadTeam();
    }
  } catch (error) {
    inviteStatus.textContent = error.message;
  }
}

function enterApp(user) {
  state.user = user;
  authGate.hidden = true;
  appShell.hidden = false;
  teamViewButton.hidden = user.role !== "admin";
  renderUserChip();
  fillSettingsForm();
  renderList();
  if (!state.pollTimer) state.pollTimer = setInterval(refresh, 1800);
  void refresh();
}

function showAuthGate() {
  state.user = null;
  state.meetings = null;
  renderCache.list = "";
  renderCache.detail = "";
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  appShell.hidden = true;
  authGate.hidden = false;
  setAuthMode(state.authMode === "reset" ? "reset" : "login");
}

/* ---------- Auth ---------- */

function setAuthMode(mode) {
  state.authMode = mode;
  authError.textContent = "";
  authNotice.textContent = "";
  const titles = {
    login: "Sign in",
    signup: "Create your account",
    forgot: "Reset your password",
    reset: "Choose a new password"
  };
  const submits = {
    login: "Sign in",
    signup: "Sign up",
    forgot: "Email me a reset code",
    reset: "Set new password"
  };
  authTitle.textContent = titles[mode];
  authSubmit.textContent = submits[mode];
  authToggle.textContent = mode === "signup" ? "Already have an account? Sign in" : "Need an account? Sign up";
  authForgot.textContent = mode === "forgot" || mode === "reset" ? "Back to sign in" : "Forgot password?";
  authNameField.hidden = mode !== "signup";
  authTokenField.hidden = mode !== "reset";
  authPasswordField.hidden = mode === "forgot";
  authPassword.required = mode !== "forgot";
  authPasswordLabel.textContent = mode === "reset" ? "New password" : "Password";
  authPassword.autocomplete = mode === "login" ? "current-password" : "new-password";
  const googleLogin = $("#google-login");
  if (googleLogin) googleLogin.hidden = mode === "forgot" || mode === "reset";
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  authError.textContent = "";
  authSubmit.disabled = true;
  try {
    if (state.authMode === "forgot") {
      const { message } = await api("/api/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email: authEmail.value })
      });
      setAuthMode("reset");
      authNotice.textContent = message;
      return;
    }
    if (state.authMode === "reset") {
      const { message } = await api("/api/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({
          email: authEmail.value,
          token: authToken.value.trim(),
          newPassword: authPassword.value
        })
      });
      authToken.value = "";
      authPassword.value = "";
      setAuthMode("login");
      authNotice.textContent = message;
      return;
    }

    const path = state.authMode === "signup" ? "/api/auth/signup" : "/api/auth/login";
    const payload = { email: authEmail.value, password: authPassword.value };
    if (state.authMode === "signup") payload.name = authName.value;
    const { user } = await api(path, { method: "POST", body: JSON.stringify(payload) });
    authPassword.value = "";
    enterApp(user);
  } catch (error) {
    authError.textContent = error.message;
  } finally {
    authSubmit.disabled = false;
  }
}

async function handleLogout() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    // The session may already be gone; show the gate regardless.
  }
  showAuthGate();
}

function renderUserChip() {
  userChip.textContent = state.user ? state.user.name || state.user.email : "";
}

/* ---------- Data refresh ---------- */

async function refresh() {
  if (!state.user) return;
  try {
    const { meetings } = await api("/api/meetings");
    // The list only carries summaries (see summarizeMeeting on the server). Keep
    // whatever full transcript we've already fetched for a meeting as long as it
    // hasn't changed server-side, instead of downgrading it back to a summary on
    // every poll tick.
    const cachedById = new Map(
      (state.meetings || []).filter(hasFullArtifacts).map((meeting) => [meeting.id, meeting])
    );
    state.meetings = meetings.map((meeting) => {
      const cached = cachedById.get(meeting.id);
      return cached && cached.updatedAt === meeting.updatedAt ? cached : meeting;
    });
    setAppError("");
    if (!state.selectedId && state.meetings.length) state.selectedId = state.meetings[0].id;
    if (state.selectedId && !state.meetings.some((meeting) => meeting.id === state.selectedId)) {
      state.selectedId = state.meetings[0]?.id || null;
    }
    renderList();
    renderMain();
    if (await ensureMeetingDetail(state.selectedId)) renderMain();
  } catch (error) {
    if (error.status === 401) {
      showAuthGate();
      return;
    }
    setAppError(error.message);
  }
  await Promise.all([refreshGmail(), refreshCalendar()]);
}

function hasFullArtifacts(meeting) {
  return Array.isArray(meeting?.artifacts?.rawSegments);
}

// Fetches the full meeting (transcript included) when the list-view summary
// isn't enough. Returns whether state.meetings actually changed, so callers
// know whether a re-render is worth it.
async function ensureMeetingDetail(id) {
  if (!id) return false;
  const current = (state.meetings || []).find((meeting) => meeting.id === id);
  if (!current || hasFullArtifacts(current)) return false;
  try {
    const { meeting } = await api(`/api/meetings/${id}`);
    const index = state.meetings.findIndex((item) => item.id === id);
    if (index === -1) return false;
    state.meetings[index] = meeting;
    return true;
  } catch (error) {
    if (error.status === 401) showAuthGate();
    else setAppError(error.message);
    return false;
  }
}

function setAppError(message) {
  appError.textContent = message;
  appError.hidden = !message;
}

async function refreshGmail() {
  try {
    state.gmail = await api("/api/gmail/status");
  } catch (error) {
    state.gmail = { error: error.message };
  }
  renderGoogleChip();
  renderSettingsStatuses();
}

async function refreshCalendar() {
  try {
    state.calendar = await api("/api/calendar/status");
  } catch (error) {
    state.calendar = { error: error.message };
  }
  renderGoogleChip();
  renderSettingsStatuses();
}

/* ---------- Sidebar list ---------- */

function renderList() {
  if (state.meetings === null) {
    if (renderCache.list === "skeleton") return;
    renderCache.list = "skeleton";
    meetingList.innerHTML = Array.from({ length: 4 })
      .map(() => `<div class="skeleton skeleton-card"></div>`)
      .join("");
    return;
  }

  const cacheKey = JSON.stringify([
    state.selectedId,
    state.meetings.map((meeting) => [meeting.id, meeting.status, meeting.title, meeting.scheduledAt, meeting.statusMessage, meeting.artifacts?.notes?.actionItems?.length])
  ]);
  if (cacheKey === renderCache.list) return;
  renderCache.list = cacheKey;

  if (!state.meetings.length) {
    meetingList.innerHTML = `
      <div class="empty-state">
        <h3>No meetings yet</h3>
        <p>Press <kbd class="kbd">C</kbd> to create one, or connect Google Calendar in Settings and they'll appear on their own.</p>
      </div>
    `;
    return;
  }

  meetingList.innerHTML = groupedMeetings()
    .map(
      ({ label, items }) => `
        <p class="list-group-label">${label}</p>
        ${items.map(renderMeetingCard).join("")}
      `
    )
    .join("");
}

function renderMeetingCard(meeting) {
  const meta = STATUS_META[meeting.status] || { label: meeting.status, tone: "muted" };
  const active = meeting.id === state.selectedId ? " active" : "";
  const actionCount = meeting.artifacts?.notes?.actionItems?.length || 0;
  // Quiet rows: the icon carries status; a sub-line appears only when something is
  // actually happening, or to surface the action count on finished meetings.
  const sub =
    meeting.status === "completed" && actionCount
      ? `${actionCount} action item${actionCount === 1 ? "" : "s"}`
      : !["scheduled", "completed", "failed"].includes(meeting.status)
        ? meta.label
        : "";

  return `
    <button type="button" class="meeting-card${active}" data-id="${escapeHtml(meeting.id)}">
      <span class="meeting-card-top">
        ${statusIcon(meeting.status)}
        <span class="meeting-card-title">${escapeHtml(meeting.title)}</span>
        <span class="meeting-card-time">${escapeHtml(formatDayTime(meeting.scheduledAt))}</span>
      </span>
      ${sub ? `<span class="meeting-card-sub">${escapeHtml(sub)}</span>` : ""}
    </button>
  `;
}

/* ---------- App bar ---------- */

function renderAppBar({ left, right = "" }) {
  return `
    <div class="app-bar">
      <div class="app-bar-left">${left}</div>
      <div class="app-bar-right">${right}</div>
    </div>
  `;
}

/* ---------- Detail ---------- */

function renderDetail() {
  const meeting = (state.meetings || []).find((item) => item.id === state.selectedId);
  const cacheKey = meeting
    ? JSON.stringify([
        meeting,
        state.runningStarts.has(meeting.id),
        state.sendingEmails.has(meeting.id),
        canEmailTranscript(meeting),
        [...state.openFolds]
      ])
    : "empty";
  if (cacheKey === renderCache.detail) return;
  renderCache.detail = cacheKey;

  if (!meeting) {
    detail.innerHTML = `
      ${renderAppBar({ left: `<span class="app-bar-crumb">Meetings</span>` })}
      <div class="detail-body">
        <div class="empty-state">
          <h3>Nothing selected</h3>
          <p>Pick a meeting from the list, or create a new one — the summary, action items, and transcript will live here.</p>
          <button type="button" class="btn btn-primary" data-open-create>New meeting</button>
        </div>
      </div>
    `;
    detail.querySelector("[data-open-create]")?.addEventListener("click", openCreateDialog);
    return;
  }

  const meta = STATUS_META[meeting.status] || { label: meeting.status, tone: "muted" };
  const running = state.runningStarts.has(meeting.id) || isWorking(meeting.status);
  const sendingEmail = state.sendingEmails.has(meeting.id);
  const notes = meeting.artifacts?.notes;
  // Scheme-guarded: escaping alone would still let a stored javascript: URL run on click.
  const meetHref = safeMeetHref(meeting.meetUrl);

  detail.innerHTML = `
    ${renderAppBar({
      left: `<span class="app-bar-crumb">Meetings</span><span class="app-bar-crumb-sep">›</span><span class="app-bar-doc-title">${escapeHtml(meeting.title)}</span>`
    })}
    <div class="detail-body">
      <header class="detail-head">
        <div class="doc-title-row">
          <h2>${escapeHtml(meeting.title)}</h2>
          <div class="head-actions">
            <button id="email-button" class="btn btn-secondary" type="button" ${canEmailTranscript(meeting) && !sendingEmail ? "" : "disabled"}>
              ${emailButtonLabel(meeting, sendingEmail)}
            </button>
            <button id="start-button" class="btn btn-primary" type="button" ${isRunnable(meeting) && !running ? "" : "disabled"}>
              ${startButtonLabel(meeting, running)}
            </button>
          </div>
        </div>
        <div class="prop-row">
          <span class="prop-chip">${statusIcon(meeting.status)}${escapeHtml(meta.label)}</span>
          <span class="prop-chip">${escapeHtml(formatDayTime(meeting.scheduledAt))}</span>
          ${
            meetHref
              ? `<a class="prop-chip" href="${escapeHtml(meetHref)}" target="_blank" rel="noopener noreferrer">${escapeHtml(shortMeetUrl(meeting.meetUrl))}</a>`
              : `<span class="prop-chip">${escapeHtml(shortMeetUrl(meeting.meetUrl))}</span>`
          }
          ${renderDurationMeta(meeting)}
        </div>
        ${renderDeliveryNote(meeting)}
      </header>

      ${renderStatusBanner(meeting)}
      ${notes ? renderNotes(notes) : ""}
      ${renderTranscript(meeting)}
      ${renderRunLog(meeting.events)}
    </div>
  `;

  detail.querySelector("#start-button")?.addEventListener("click", async () => {
    state.runningStarts.add(meeting.id);
    renderCache.detail = "";
    renderDetail();
    try {
      await api(`/api/meetings/${meeting.id}/start`, { method: "POST" });
      await refresh();
    } catch (error) {
      setAppError(error.message);
    } finally {
      state.runningStarts.delete(meeting.id);
      renderCache.detail = "";
      renderDetail();
    }
  });

  detail.querySelector("#email-button")?.addEventListener("click", async () => {
    state.sendingEmails.add(meeting.id);
    renderCache.detail = "";
    renderDetail();
    try {
      await api(`/api/meetings/${meeting.id}/email-transcript`, { method: "POST" });
      await refresh();
    } catch (error) {
      setAppError(error.message);
    } finally {
      state.sendingEmails.delete(meeting.id);
      renderCache.detail = "";
      renderDetail();
    }
  });
}

function renderStatusBanner(meeting) {
  if (meeting.status === "failed") {
    return `<div class="failed-banner">${escapeHtml(meeting.statusMessage || "The notetaker job failed.")}</div>`;
  }
  if (isWorking(meeting.status) || meeting.status === "queued" || meeting.status === "following") {
    return `
      <div class="working-banner">
        <span class="working-bar" aria-hidden="true"></span>
        <span>${escapeHtml(meeting.statusMessage || "Working…")}</span>
      </div>
    `;
  }
  return "";
}

function renderNotes(notes) {
  const actionItems = notes.actionItems || [];
  const triage = [
    { title: "Decisions", items: notes.decisions },
    { title: "Open questions", items: notes.openQuestions },
    { title: "Risks", items: notes.risks }
  ].filter((block) => block.items?.length);

  return `
    <section class="doc-section">
      <div class="sec-label">Action items <span class="sec-count">${actionItems.length}</span></div>
      ${
        actionItems.length
          ? `<div class="table-wrap">
              <table class="action-table">
                <thead>
                  <tr><th>Task</th><th>Owner</th><th>Due</th><th>At</th></tr>
                </thead>
                <tbody>
                  ${actionItems
                    .map(
                      (item) => `
                        <tr>
                          <td class="cell-task">${escapeHtml(item.task)}</td>
                          <td><span class="owner-chip${isKnownOwner(item.owner) ? " known" : ""}">${escapeHtml(item.owner || "Unknown")}</span></td>
                          <td>${escapeHtml(item.due || "Not stated")}</td>
                          <td class="cell-num">${escapeHtml(item.evidenceTimestamp || "")}</td>
                        </tr>
                      `
                    )
                    .join("")}
                </tbody>
              </table>
            </div>`
          : `<p class="muted-note">No commitments were made in this meeting.</p>`
      }
    </section>

    <section class="doc-section">
      <div class="sec-label">Summary</div>
      <p class="summary-text">${escapeHtml(notes.summary || "No summary was generated.")}</p>
    </section>

    ${
      triage.length
        ? `<section class="doc-section">
            <div class="triage-grid">
              ${triage
                .map(
                  (block) => `
                    <article class="triage-card">
                      <h4>${escapeHtml(block.title)}</h4>
                      <ul class="notes-list">${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
                    </article>
                  `
                )
                .join("")}
            </div>
          </section>`
        : ""
    }

    ${
      notes.detailedNotes?.length
        ? renderFold(
            "detailed-notes",
            "Detailed notes",
            String(notes.detailedNotes.length),
            `<ul class="notes-list">${notes.detailedNotes.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
          )
        : ""
    }
  `;
}

function renderTranscript(meeting) {
  // The list endpoint only sends a summary; a meeting past "scheduled" has (or
  // is expected to grow) a transcript, so show a loading fold instead of
  // silently rendering nothing until ensureMeetingDetail's fetch lands.
  if (!hasFullArtifacts(meeting)) {
    return meeting.status === "scheduled"
      ? ""
      : renderFold("transcript", "Transcript", "…", `<p>Loading transcript…</p>`);
  }

  const reconstructed = meeting.artifacts?.reconstructedTranscript;
  const turns = reconstructed?.turns || [];
  const rawSegments = meeting.artifacts?.rawSegments || [];
  const normalizedSegments = meeting.artifacts?.normalizedSegments || [];

  if (!turns.length && !rawSegments.length) return "";

  const roleLegend = (reconstructed?.roles || [])
    .map(
      (role) => `
        <span class="role-chip">
          <strong>${escapeHtml(role.label)}</strong>
          ${role.description ? escapeHtml(role.description) : ""}
        </span>
      `
    )
    .join("");
  const warnings = (reconstructed?.warnings || []).length
    ? `<div class="transcript-warning">${reconstructed.warnings.map(escapeHtml).join(" · ")}</div>`
    : "";

  const turnRows = turns
    .map(
      (turn) => `
        <div class="turn">
          <div class="turn-meta">
            <span class="turn-speaker">${escapeHtml(turn.role)}</span>
            <span class="turn-time">${formatTime(turn.start)}</span>
            ${turn.flags?.length ? `<span class="turn-flag">${escapeHtml(turn.flags.join(", "))}</span>` : ""}
          </div>
          <p class="turn-text">${escapeHtml(turn.text)}</p>
        </div>
      `
    )
    .join("");

  const normalizedById = new Map(normalizedSegments.map((segment) => [segment.id, segment]));
  const compareRows = rawSegments
    .map((segment) => {
      const normalized = normalizedById.get(segment.id);
      return `
        <div class="compare-row">
          <div class="turn-meta">
            <span class="turn-speaker">${escapeHtml(segment.speaker)}</span>
            <span class="turn-time">${formatTime(segment.start)}</span>
          </div>
          <p class="compare-raw"><span class="copy-label">Raw Hinglish</span>${escapeHtml(segment.text)}</p>
          <p><span class="copy-label">Clean English</span>${escapeHtml(normalized?.english || "Waiting for normalization.")}</p>
        </div>
      `;
    })
    .join("");

  const transcriptBody = turns.length
    ? `${roleLegend ? `<div class="role-legend">${roleLegend}</div>` : ""}${warnings}<div class="turn-list">${turnRows}</div>`
    : `<div class="turn-list">${compareRows}</div>`;

  return `
    ${renderFold("transcript", "Transcript", turns.length ? `${turns.length} turns` : `${rawSegments.length} segments`, transcriptBody)}
    ${
      turns.length && rawSegments.length
        ? renderFold("raw-evidence", "Raw Hinglish evidence", `${rawSegments.length} segments`, `<div class="turn-list">${compareRows}</div>`)
        : ""
    }
  `;
}

function renderRunLog(events) {
  if (!events?.length) return "";
  const rows = events
    .slice()
    .reverse()
    .map(
      (event) => `
        <li>
          <span class="event-time">${escapeHtml(formatDayTime(event.at))}</span>
          <span class="event-message">${escapeHtml(event.message)}</span>
        </li>
      `
    )
    .join("");
  return renderFold("run-log", "Run log", String(events.length), `<ol class="event-list">${rows}</ol>`);
}

/* ---------- Calendar view ---------- */

const CAL_HOUR_PX = 56;
const CAL_PX_PER_MIN = CAL_HOUR_PX / 60;
const CAL_MIN_EVENT_PX = 24;
const CAL_MIN_EVENT_MIN = Math.ceil(CAL_MIN_EVENT_PX / CAL_PX_PER_MIN); // 26
const CAL_DEFAULT_EVENT_MIN = 45; // default scheduled meeting length (minutes)
// Chips shorter than this render time + title inline on one row.
const CAL_COMPACT_EVENT_PX = 40;

// Tracks the week the calendar last painted so a week change re-anchors the
// scroll position while a plain data refresh preserves it.
let lastCalWeekOffset = null;

function meetingDurationMinutes(meeting) {
  const segments = meeting.artifacts?.rawSegments || [];
  const seconds = Number(segments[segments.length - 1]?.end || 0);
  return seconds > 0 ? Math.max(1, Math.round(seconds / 60)) : CAL_DEFAULT_EVENT_MIN;
}

// Canonical interval partitioning: collision groups chained on VISUAL extent
// (so 24px-clamped chips never stack), then greedy leftmost-free-column packing.
function layoutDayEvents(events) {
  const items = events.map((event) => {
    const date = new Date(event.scheduledAt);
    const startMin = date.getHours() * 60 + date.getMinutes();
    const durMin = meetingDurationMinutes(event);
    // Completed/failed meetings can carry a very short transcript (demo data
    // ends at ~1 min), which would shrink their collision extent below the
    // slot they actually occupied and stop a 10:00 meeting from contending
    // with a 10:30 neighbor. Floor the COLLISION extent at the default
    // scheduled duration; the rendered height stays truthful to durMin.
    const layoutMin =
      event.status === "completed" || event.status === "failed"
        ? Math.max(durMin, CAL_DEFAULT_EVENT_MIN)
        : durMin;
    return { event, startMin, durMin, visEnd: startMin + Math.max(layoutMin, CAL_MIN_EVENT_MIN) };
  });
  items.sort((a, b) => a.startMin - b.startMin || b.visEnd - a.visEnd);

  const groups = [];
  let current = [];
  let groupMaxEnd = -1;
  for (const item of items) {
    if (current.length && item.startMin >= groupMaxEnd) {
      groups.push(current);
      current = [];
      groupMaxEnd = -1;
    }
    current.push(item);
    groupMaxEnd = Math.max(groupMaxEnd, item.visEnd);
  }
  if (current.length) groups.push(current);

  const out = [];
  for (const group of groups) {
    const colEnds = [];
    for (const item of group) {
      let col = colEnds.findIndex((end) => end <= item.startMin); // touching ≠ overlap
      if (col === -1) col = colEnds.length;
      colEnds[col] = item.visEnd;
      item.col = col;
    }
    for (const item of group) {
      out.push({
        event: item.event,
        top: Math.round(item.startMin * CAL_PX_PER_MIN),
        height: Math.max(Math.round(item.durMin * CAL_PX_PER_MIN), CAL_MIN_EVENT_PX),
        col: item.col,
        cols: colEnds.length
      });
    }
  }
  return out;
}

function positionNowLine() {
  const line = detail.querySelector(".cal-now");
  if (!line) return; // today not in the visible week
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  line.style.top = `${Math.round(minutes * CAL_PX_PER_MIN)}px`;
}

function renderCalendar() {
  const meetings = state.meetings || [];
  const now = new Date();
  const todayKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  const cacheKey =
    "cal:" +
    JSON.stringify([
      state.weekOffset,
      todayKey,
      meetings.map((meeting) => [
        meeting.id,
        meeting.status,
        meeting.title,
        meeting.scheduledAt,
        meeting.artifacts?.rawSegments?.at(-1)?.end || 0
      ])
    ]);
  if (cacheKey === renderCache.detail) {
    // Cache hit: only nudge the now-line — no innerHTML, scroll stays put.
    positionNowLine();
    return;
  }
  const isNewWeek = lastCalWeekOffset !== state.weekOffset;
  lastCalWeekOffset = state.weekOffset;
  const prevScroller = detail.querySelector(".cal-scroll");
  const prevScroll = prevScroller?.scrollTop ?? null;
  const prevScrollLeft = prevScroller?.scrollLeft ?? 0;
  renderCache.detail = cacheKey;

  const weekStart = startOfWeek(now, state.weekOffset);
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(weekStart);
    day.setDate(day.getDate() + index);
    return day;
  });
  const byDay = days.map((day) =>
    meetings
      .filter((meeting) => sameDay(new Date(meeting.scheduledAt), day))
      .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt))
  );
  const layouts = byDay.map(layoutDayEvents);
  const total = layouts.reduce((sum, list) => sum + list.length, 0);
  const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short" });
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const chevronLeft = `<svg class="sicon" viewBox="0 0 14 14" aria-hidden="true"><path d="M8.5 3.5 L5 7 L8.5 10.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const chevronRight = `<svg class="sicon" viewBox="0 0 14 14" aria-hidden="true"><path d="M5.5 3.5 L9 7 L5.5 10.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  const daybarCells = days
    .map((day) => {
      const isToday = sameDay(day, now);
      const isWeekend = day.getDay() === 0 || day.getDay() === 6;
      return `
        <div class="cal-daybar-cell${isToday ? " is-today" : ""}${isWeekend ? " is-weekend" : ""}">
          <span class="cal-dayname">${escapeHtml(weekdayFormat.format(day))}</span>
          <span class="cal-daynum">${day.getDate()}</span>
        </div>
      `;
    })
    .join("");

  // Hour 0 (12 AM) is omitted so the first label never collides with the daybar.
  const gutterLabels = Array.from({ length: 23 }, (_, index) => index + 1)
    .map((hour) => `<span class="cal-hour-label" style="top: ${hour * CAL_HOUR_PX}px">${escapeHtml(formatHourLabel(hour))}</span>`)
    .join("");

  const columns = days
    .map((day, index) => {
      const isToday = sameDay(day, now);
      const isWeekend = day.getDay() === 0 || day.getDay() === 6;
      const isPast = !isToday && day < todayStart;
      const chips = layouts[index]
        .map(({ event, top, height, col, cols }) => {
          const endMs = Date.parse(event.scheduledAt) + meetingDurationMinutes(event) * 60_000;
          const isPastEvent = endMs < now.getTime();
          const left = ((col / cols) * 100).toFixed(3);
          const width = (100 / cols).toFixed(3);
          const isCompact = height < CAL_COMPACT_EVENT_PX;
          return `
            <button type="button"
              class="cal-event status-${escapeHtml(event.status)}${isPastEvent ? " is-past-event" : ""}${isCompact ? " is-compact" : ""}"
              data-id="${escapeHtml(event.id)}" title="${escapeHtml(event.title)}"
              style="top:${top}px;height:${height}px;left:calc(${left}% + 1px);width:calc(${width}% - 5px)">
              <span class="cal-event-time">${escapeHtml(formatClock(event.scheduledAt))}</span>
              <span class="cal-event-title">${escapeHtml(event.title)}</span>
              <span class="cal-event-glyph">${statusIcon(event.status)}</span>
            </button>
          `;
        })
        .join("");
      return `
        <div class="cal-col${isToday ? " is-today" : ""}${isWeekend ? " is-weekend" : ""}${isPast ? " is-past" : ""}">
          ${isToday ? `<div class="cal-now"><span class="cal-now-dot"></span></div>` : ""}
          ${chips}
        </div>
      `;
    })
    .join("");

  detail.innerHTML = `
    ${renderAppBar({
      left: `<span class="app-bar-title">Calendar</span><span class="app-bar-sub">${escapeHtml(formatWeekRange(days[0], days[6]))}</span>`,
      right: `
        <div class="cal-controls" role="group" aria-label="Week navigation">
          <button id="cal-prev" class="icon-btn" type="button" aria-label="Previous week" title="Previous week — ←">${chevronLeft}</button>
          <button id="cal-today" class="btn btn-secondary btn-sm" type="button" title="Jump to this week" ${state.weekOffset === 0 ? "disabled" : ""}>Today</button>
          <button id="cal-next" class="icon-btn" type="button" aria-label="Next week" title="Next week — →">${chevronRight}</button>
        </div>
      `
    })}
    <div class="cal-scroll">
      <div class="cal-daybar">
        <div class="cal-daybar-gutter"></div>
        ${daybarCells}
      </div>
      <div class="cal-body">
        <div class="cal-gutter">${gutterLabels}</div>
        ${columns}
      </div>
      ${total === 0 ? `<p class="cal-empty-hint" style="top: calc(10 * var(--cal-hour))">Nothing scheduled this week. Connect Google Calendar in Settings.</p>` : ""}
    </div>
  `;

  detail.querySelector("#cal-prev").addEventListener("click", () => shiftWeek(-1));
  detail.querySelector("#cal-next").addEventListener("click", () => shiftWeek(1));
  detail.querySelector("#cal-today").addEventListener("click", () => shiftWeek(0, true));
  for (const chip of detail.querySelectorAll(".cal-event")) {
    chip.addEventListener("click", () => selectMeeting(chip.dataset.id));
  }

  positionNowLine();
  const scroller = detail.querySelector(".cal-scroll");
  if (isNewWeek || prevScroll === null) {
    const firstTop = layouts.reduce((min, list) => list.reduce((least, item) => Math.min(least, item.top), min), Infinity);
    const target = firstTop < Infinity ? firstTop - CAL_HOUR_PX : 8 * CAL_HOUR_PX;
    scroller.scrollTop = Math.max(0, Math.min(target, scroller.scrollHeight - scroller.clientHeight));
    // Mobile: the grid overflows horizontally — bring today's column fully
    // into view instead of leaving it clipped past the right viewport edge.
    const todayCol = scroller.querySelector(".cal-col.is-today");
    const maxLeft = scroller.scrollWidth - scroller.clientWidth;
    if (todayCol && maxLeft > 0) {
      const colRight = todayCol.offsetLeft + todayCol.offsetWidth;
      scroller.scrollLeft = Math.max(0, Math.min(colRight - scroller.clientWidth, maxLeft));
    }
  } else {
    // Data-change re-render must not move the user's scroll position.
    scroller.scrollTop = prevScroll;
    scroller.scrollLeft = prevScrollLeft;
  }
}

function startOfWeek(date, offsetWeeks = 0) {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  // Week starts on Monday.
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7) + offsetWeeks * 7);
  return day;
}

function sameDay(a, b) {
  return (
    a instanceof Date &&
    !Number.isNaN(a.getTime()) &&
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatWeekRange(first, last) {
  if (first.getFullYear() !== last.getFullYear()) {
    const format = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
    return `${format.format(first)} – ${format.format(last)}`;
  }
  const format = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
  return `${format.format(first)} – ${format.format(last)}, ${first.getFullYear()}`;
}

function formatClock(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true }).format(date);
}

function formatHourLabel(hour) {
  if (hour === 0 || hour === 24) return "12 AM";
  if (hour === 12) return "12 PM";
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

function renderFold(key, title, count, bodyHtml) {
  const open = state.openFolds.has(key) ? " open" : "";
  return `
    <details class="section-fold" data-fold="${escapeHtml(key)}"${open}>
      <summary>${escapeHtml(title)}<span class="sec-count">${escapeHtml(count)}</span></summary>
      <div class="fold-body">${bodyHtml}</div>
    </details>
  `;
}

function renderDurationMeta(meeting) {
  const segments = meeting.artifacts?.rawSegments || [];
  if (!segments.length) return "";
  const seconds = Number(segments[segments.length - 1]?.end || 0);
  if (!seconds) return "";
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `<span class="prop-chip">${minutes} min recorded</span>`;
}

function renderDeliveryNote(meeting) {
  const delivery = meeting.delivery?.transcriptEmail;
  if (!delivery) return "";
  if (delivery.status === "sent") {
    const recipients = Array.isArray(delivery.recipients) && delivery.recipients.length
      ? delivery.recipients.join(", ")
      : delivery.recipient;
    return `<p class="delivery-note">Notes emailed to ${escapeHtml(recipients)} · ${escapeHtml(formatDayTime(delivery.sentAt))}</p>`;
  }
  if (delivery.status === "failed") {
    return `<p class="delivery-note error">Email failed: ${escapeHtml(delivery.error || "unknown error")}</p>`;
  }
  return "";
}

/* ---------- Dialogs ---------- */

function openCreateDialog() {
  meetingForm.reset();
  formError.textContent = "";
  createDialog.showModal();
  $("#title").focus();
}

async function handleCreateMeeting(event) {
  event.preventDefault();
  formError.textContent = "";
  createButton.disabled = true;
  createButton.textContent = "Creating…";

  const formData = new FormData(meetingForm);
  const payload = Object.fromEntries(formData.entries());
  if (payload.scheduledAt) {
    payload.scheduledAt = new Date(payload.scheduledAt).toISOString();
  }

  try {
    const { meeting } = await api("/api/meetings", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    state.selectedId = meeting.id;
    createDialog.close();
    await refresh();
  } catch (error) {
    formError.textContent = error.message;
  } finally {
    createButton.disabled = false;
    createButton.textContent = "Create meeting";
  }
}

function openSettingsDialog() {
  fillSettingsForm();
  settingsStatus.textContent = "";
  passwordStatus.textContent = "";
  renderSettingsStatuses();
  settingsDialog.showModal();
  void Promise.all([refreshGmail(), refreshCalendar()]);
}

function fillSettingsForm() {
  const settings = state.user?.settings;
  if (!settings) return;
  settingsRecipients.value = (settings.transcriptRecipients || []).join(", ");
  settingsAutoEmail.checked = Boolean(settings.autoEmailTranscript);
  settingsCalendarSync.checked = Boolean(settings.calendarSyncEnabled);
  settingsCalendarAutostart.checked = Boolean(settings.calendarAutoStart);
}

async function saveSettings() {
  settingsStatus.textContent = "Saving…";
  try {
    const { user } = await api("/api/auth/settings", {
      method: "PATCH",
      body: JSON.stringify({
        transcriptRecipients: settingsRecipients.value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
        autoEmailTranscript: settingsAutoEmail.checked,
        calendarSyncEnabled: settingsCalendarSync.checked,
        calendarAutoStart: settingsCalendarAutostart.checked
      })
    });
    state.user = user;
    fillSettingsForm();
    settingsStatus.textContent = "Saved.";
    await Promise.all([refreshGmail(), refreshCalendar()]);
  } catch (error) {
    settingsStatus.textContent = error.message;
  }
}

async function changePassword() {
  passwordStatus.textContent = "Updating…";
  try {
    await api("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword: passwordCurrent.value, newPassword: passwordNew.value })
    });
    passwordCurrent.value = "";
    passwordNew.value = "";
    passwordStatus.textContent = "Password changed. Other sessions were signed out.";
  } catch (error) {
    passwordStatus.textContent = error.message;
  }
}

async function syncCalendar() {
  state.syncingCalendar = true;
  renderSettingsStatuses();
  try {
    const result = await api("/api/calendar/sync", { method: "POST" });
    state.calendar = await api("/api/calendar/status");
    calendarMetaText.textContent = result.startedCount
      ? `Synced. Started ${result.startedCount} bot${result.startedCount === 1 ? "" : "s"}.`
      : `Synced. ${result.importedCount} new meeting${result.importedCount === 1 ? "" : "s"} imported.`;
    await refresh();
  } catch (error) {
    calendarMetaText.textContent = error.message;
  } finally {
    state.syncingCalendar = false;
    renderSettingsStatuses({ keepCalendarMeta: true });
  }
}

/* ---------- Google status ---------- */

function renderGoogleChip() {
  const gmail = state.gmail;
  const calendar = state.calendar;
  if (!gmail && !calendar) return;

  if (gmail?.error) {
    googleDot.className = "dot dot-bad";
    googleStatusLabel.textContent = "Google status unavailable";
    return;
  }
  if (!gmail?.configured) {
    googleDot.className = "dot dot-muted";
    googleStatusLabel.textContent = "Google not configured";
    return;
  }
  if (calendar?.needsReconnect) {
    googleDot.className = "dot dot-bad";
    googleStatusLabel.textContent = "Google access expired";
    return;
  }
  if (gmail.connected || calendar?.connected) {
    googleDot.className = "dot dot-ok";
    googleStatusLabel.textContent = "Google connected";
    return;
  }
  googleDot.className = "dot dot-amber";
  googleStatusLabel.textContent = "Connect Google";
}

function renderSettingsStatuses({ keepCalendarMeta = false } = {}) {
  const gmail = state.gmail;
  if (gmail) {
    if (gmail.error) {
      gmailStatusText.textContent = gmail.error;
      gmailRecipientText.textContent = "";
    } else if (!gmail.configured) {
      gmailStatusText.textContent = "Add Google OAuth credentials on the server to enable Gmail.";
      gmailRecipientText.textContent = "";
    } else {
      gmailStatusText.textContent = gmail.connected
        ? "Gmail connected — transcripts send from your account."
        : gmail.googleConnected
          ? "Reconnect Google to grant Gmail send access."
          : "Connect Google to email transcripts.";
      gmailRecipientText.textContent = gmail.recipient ? `Sending to ${gmail.recipient}` : "";
    }
    gmailConnect.textContent = gmail.connected ? "Reconnect" : "Connect";
    const usable = Boolean(gmail.configured && !gmail.error);
    gmailConnect.toggleAttribute("aria-disabled", !usable);
    gmailConnect.classList.toggle("btn-ghost", !usable);
    gmailConnect.classList.toggle("btn-secondary", usable);
  }

  const calendar = state.calendar;
  if (calendar) {
    if (calendar.error) {
      calendarStatusText.textContent = calendar.error;
    } else if (!calendar.configured) {
      calendarStatusText.textContent = "Calendar needs the same Google OAuth credentials.";
    } else if (calendar.needsReconnect) {
      calendarStatusText.textContent = `Google access expired — reconnect to resume calendar sync.${calendar.lastSyncError ? ` (${calendar.lastSyncError})` : ""}`;
    } else if (!calendar.connected) {
      calendarStatusText.textContent = calendar.googleConnected
        ? "Reconnect Google to grant Calendar read access."
        : "Connect Google to import your meetings.";
    } else {
      const lastSync = calendar.lastSync ? `Last sync ${formatDayTime(calendar.lastSync)}.` : "";
      calendarStatusText.textContent = calendar.enabled
        ? `Calendar import is on. ${lastSync}`.trim()
        : "Calendar connected — turn on import below.";
    }
    if (!keepCalendarMeta) {
      calendarMetaText.textContent = calendar.lastError ? `Last error: ${calendar.lastError.message}` : "";
    }
    calendarSyncButton.disabled = !calendar.connected || state.syncingCalendar;
    calendarSyncButton.textContent = state.syncingCalendar ? "Syncing…" : "Sync now";
  }
}

/* ---------- Helpers ---------- */

function isRunnable(meeting) {
  return ["scheduled", "completed", "failed"].includes(meeting.status);
}

function isWorking(status) {
  return ["recording", "transcribing", "normalizing", "reconstructing"].includes(status);
}

function canEmailTranscript(meeting) {
  return meeting.status === "completed" && state.gmail?.configured && state.gmail?.connected && Boolean(state.gmail?.recipient);
}

function isKnownOwner(owner) {
  return owner && !/^(unknown|not stated)$/i.test(owner.trim());
}

function startButtonLabel(meeting, running) {
  if (running) return "Running…";
  if (meeting.status === "scheduled") return "Send bot now";
  if (meeting.status === "failed") return "Retry";
  return "Record again";
}

function emailButtonLabel(meeting, sending) {
  if (sending) return "Sending…";
  const delivery = meeting.delivery?.transcriptEmail;
  if (delivery?.status === "sent") return "Resend notes";
  if (delivery?.status === "failed") return "Retry email";
  return "Email notes";
}

function shortMeetUrl(value) {
  return String(value || "").replace(/^https?:\/\//, "");
}

// Only https: URLs get a live link; anything else (javascript:, data:, garbage)
// renders as inert text. Escaping alone cannot block scheme-based XSS on click.
function safeMeetHref(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });
  const body = await response.json();
  if (!response.ok) {
    const fieldError = body.fields ? Object.values(body.fields)[0] : "";
    const error = new Error(fieldError || body.message || body.error || "Request failed.");
    error.status = response.status;
    throw error;
  }
  return body;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDayTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  // Pin en-US like formatClock so AM/PM casing matches the calendar chips
  // ("Today 3:00 PM" everywhere, never "3:00 pm").
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true }).format(date);
  const dayDiff = Math.round(
    (new Date(date.getFullYear(), date.getMonth(), date.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) /
      86_400_000
  );
  if (dayDiff === 0) return `Today ${time}`;
  if (dayDiff === 1) return `Tomorrow ${time}`;
  if (dayDiff === -1) return `Yesterday ${time}`;
  const sameYear = date.getFullYear() === now.getFullYear();
  const day = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour12: true,
    ...(sameYear ? {} : { year: "numeric" })
  }).format(date);
  return `${day}, ${time}`;
}

function formatTime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds || 0)));
  const minutes = Math.floor(total / 60).toString().padStart(2, "0");
  const remainder = (total % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}
