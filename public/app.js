// Pure logic pulled out so it is testable without a DOM — see the comment there for why
// it lives in its own file instead of just being a function in this one.
import { canEnableRawEvidence } from "./compose-guard.js";

const state = {
  user: null,
  authMode: "login",
  meetings: null, // null = not loaded yet (skeletons); [] = loaded, empty
  gmail: null,
  calendar: null,
  googleAccounts: null,
  // Meeting id -> in-progress action-item edits, so a re-render mid-edit does not
  // discard what is being typed.
  actionItemDrafts: new Map(),
  editingActionItems: null,
  selectedId: null,
  view: "detail", // "detail" | "calendar"
  weekOffset: 0,
  pollTimer: null,
  runningStarts: new Set(),
  sendingEmails: new Set(),
  syncingCalendar: false,
  openFolds: new Set(["transcript"]),
  // Operator flags from the server. null until the first answer lands; every video
  // affordance stays hidden until then, so a slow or missing endpoint fails closed.
  features: null,
  openClips: new Set(),
  // Raw share URLs live here and nowhere else. The server stores only the sha256 of a
  // share token and hands the URL back exactly once, so this Map is the single copy in
  // existence — a reload loses it, which is the property being bought.
  revealedShares: new Map(),
  // Per-clip expiry choice, held across the 1.8s poll re-render so a picked "30 days"
  // is not silently reset to the default between choosing it and clicking create.
  shareExpiry: new Map(),
  clipDraft: null,
  export: null // initialised below, once EXPORT_SECTIONS exists
};

const renderCache = { list: "", detail: "" };

// Keys must match EXPORT_SECTIONS in src/domain/export.js — the server validates against
// its own list and answers 400 for anything it does not recognise.
const EXPORT_SECTIONS = [
  { key: "summary", label: "Summary" },
  { key: "detailedNotes", label: "Detailed notes" },
  { key: "actionItems", label: "Action items" },
  { key: "decisions", label: "Decisions" },
  { key: "openQuestions", label: "Open questions" },
  { key: "risks", label: "Risks" },
  { key: "participants", label: "Participants" },
  { key: "roleTranscript", label: "Role-corrected transcript" },
  { key: "cleanTranscript", label: "Clean English transcript" },
  { key: "rawTranscript", label: "Raw Hinglish transcript" },
  { key: "runLog", label: "Run log" }
];

const DEFAULT_EXPORT_SECTIONS = EXPORT_SECTIONS.map((section) => section.key).filter(
  (key) => !["rawTranscript", "runLog"].includes(key)
);

state.export = {
  open: false,
  scope: "meeting", // "meeting" | "all" | "pick"
  picked: new Set(),
  sections: new Set(DEFAULT_EXPORT_SECTIONS),
  format: "md",
  busy: false,
  error: ""
};

// Per-send by design: this lives in memory only and is discarded when the dialog closes.
// Nothing here is ever written back to the meeting.
const composerState = {
  meetingId: "",
  recipients: [],
  confirmExternal: false,
  subject: "",
  intro: "",
  signoff: "",
  sections: { summary: true, decisions: true, actionItems: true, openQuestions: false, risks: false, transcript: false, rawEvidence: false },
  includeIds: new Set(),
  edits: new Map(),
  // UI-only bookkeeping below — none of it is part of the request body.
  preset: "clientSafe", // which radio reads as selected; null once the operator diverges from both
  error: "",
  needsExternalConfirm: false,
  pendingPreview: false, // which action the external-confirm retry should repeat
  inFlight: null, // null | "preview" | "send" — drives button labels
  // busy + activeRequestId together are the actual duplicate-send guard: busy blocks a
  // second click while a request is outstanding, and activeRequestId is what stops a
  // response that arrives after the dialog has moved on (closed and reopened, or sent
  // again for the same or a different meeting) from releasing that guard early. A plain
  // meetingId comparison isn't enough on its own — a second send for the SAME meeting
  // would share it with the first — so this is a token, minted fresh per submitCompose
  // call (see composeRequestSeq), not a meeting identity.
  busy: false,
  activeRequestId: 0
};

const PRESETS = {
  full: { summary: true, decisions: true, actionItems: true, openQuestions: true, risks: true, transcript: true, rawEvidence: true },
  clientSafe: { summary: true, decisions: true, actionItems: true, openQuestions: false, risks: false, transcript: false, rawEvidence: false }
};

// Source of the token above. Module-level (not composerState) because it must keep
// counting across dialog opens/closes — resetting it on open would let a request from a
// PRIOR session collide with request #1 of a new one.
let composeRequestSeq = 0;

// Transcript rows are built once per dialog open and mutated in place (see
// buildComposeTurnList); a 685-turn meeting is thousands of DOM nodes, cheap to build
// once and expensive to rebuild on every checkbox click or keystroke. Kept outside
// composerState because these are DOM handles and a raw snapshot, not request data.
let composeSegments = [];
let composeRows = new Map();
let composeAnchorId = null;

// Mirrors MAX_RECIPIENTS (src/domain/note-delivery.js) and the pattern
// notes-email-selection.js validates with. This is only so an obviously-wrong entry
// gets an answer without a round trip — the server's own check is what is authoritative.
const COMPOSE_EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u;
const MAX_COMPOSE_RECIPIENTS = 25;

// What the UI assumes when the server has not said otherwise. `enabled: false` is the
// load-bearing part: an install with VIDEO_RECORDING_ENABLED off, an older server with
// no features route at all, and a failed request must all produce the same UI — none.
const NO_VIDEO_FEATURE = {
  enabled: false,
  recordByDefault: true,
  retentionDays: 7,
  maxClipSeconds: 300,
  shareDefaultDays: 7
};

const SHARE_EXPIRY_CHOICES = [1, 7, 30];

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
const recordVideoField = $("#record-video-field");
const recordVideoInput = $("#record-video");
const recordVideoHint = $("#record-video-hint");

const clipDialog = $("#clip-dialog");
const clipForm = $("#clip-form");
const clipLabelInput = $("#clip-label");
const clipStartInput = $("#clip-start");
const clipEndInput = $("#clip-end");
const clipLengthHint = $("#clip-length");
const clipError = $("#clip-error");
const clipCreateButton = $("#clip-create");

const composeDialog = $("#compose-dialog");
const composeForm = $("#compose-form");
const composeRecipientChips = $("#compose-recipient-chips");
const composeRecipientInput = $("#compose-recipient-input");
const composeAttendeeSuggestions = $("#compose-attendee-suggestions");
const composePresetRow = $("#compose-preset-row");
const composePresetFullInput = $("#compose-preset-full");
const composePresetClientSafeInput = $("#compose-preset-clientsafe");
const composeSectionsContainer = $("#compose-sections");
const composeRawEvidenceInput = $("#compose-raw-evidence");
const composeRawEvidenceChoice = $("#compose-raw-evidence-choice");
const composeRawEvidenceHint = $("#compose-raw-evidence-hint");
const composeSubjectInput = $("#compose-subject");
const composeIntroInput = $("#compose-intro");
const composeSignoffInput = $("#compose-signoff");
const composeTranscriptCount = $("#compose-transcript-count");
const composeTranscriptOff = $("#compose-transcript-off");
const composeEnableTranscript = $("#compose-enable-transcript");
const composeAllButton = $("#compose-turns-all");
const composeNoneButton = $("#compose-turns-none");
const composeDropBeforeButton = $("#compose-turns-drop-before");
const composeDropAfterButton = $("#compose-turns-drop-after");
const composeTurnListEl = $("#compose-turn-list");
const composeErrorEl = $("#compose-error");
const composeConfirmExternalButton = $("#compose-confirm-external");
const composePreviewGroup = $("#compose-preview-group");
const composePreviewSubject = $("#compose-preview-subject");
const composePreviewFrame = $("#compose-preview-frame");
const composePreviewButton = $("#compose-preview-button");
const composeSendButton = $("#compose-send-button");

const settingsDialog = $("#settings-dialog");
const gmailStatusText = $("#gmail-status-text");
const googleAccountsList = $("#google-accounts-list");
const gmailConnect = $("#gmail-connect");
const calendarStatusText = $("#calendar-status-text");
const calendarMetaText = $("#calendar-meta-text");
const calendarSyncButton = $("#calendar-sync");
const settingsRecipients = $("#settings-recipients");
const settingsAutoEmail = $("#settings-auto-email");
const settingsActionRecipients = $("#settings-action-recipients");
const settingsEmailConnected = $("#settings-email-connected");
const settingsActionConnected = $("#settings-action-connected");
const settingsAutoActionItems = $("#settings-auto-action-items");
const actionHoldHint = $("#action-hold-hint");
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
settingsAutoActionItems?.addEventListener("change", renderActionHoldHint);
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

clipForm.addEventListener("submit", handleCreateClip);
clipStartInput.addEventListener("input", renderClipLengthHint);
clipEndInput.addEventListener("input", renderClipLengthHint);

// Compose dialog: Send lives on the form's submit (Enter in Subject works like every
// other single-line field here); Preview is a plain button so it never doubles as Enter.
composeForm.addEventListener("submit", handleComposeSubmit);
composeEnableTranscript.addEventListener("click", () => {
  composerState.sections.transcript = true;
  clearComposePresetMatch();
  renderComposeSections();
  updateComposeTurnCount();
});
composePreviewButton.addEventListener("click", () => void submitCompose(true));
composeConfirmExternalButton.addEventListener("click", handleComposeConfirmExternal);
composeRecipientInput.addEventListener("keydown", handleComposeRecipientKeydown);
composeRecipientInput.addEventListener("blur", commitComposeRecipientInput);
// Chip removal and attendee-suggestion clicks: both rebuild on every recipient change,
// so delegated on the dialog rather than bound per chip.
composeDialog.addEventListener("click", handleComposeDialogClick);
composeSectionsContainer.addEventListener("change", handleComposeSectionChange);
composePresetRow.addEventListener("change", handleComposePresetChange);
composeSubjectInput.addEventListener("input", () => (composerState.subject = composeSubjectInput.value));
composeIntroInput.addEventListener("input", () => (composerState.intro = composeIntroInput.value));
composeSignoffInput.addEventListener("input", () => (composerState.signoff = composeSignoffInput.value));
composeAllButton.addEventListener("click", () => setAllComposeTurns(true));
composeNoneButton.addEventListener("click", () => setAllComposeTurns(false));
composeDropBeforeButton.addEventListener("click", () => dropComposeTurnsRelativeToAnchor("before"));
composeDropAfterButton.addEventListener("click", () => dropComposeTurnsRelativeToAnchor("after"));
// The turn list can hold thousands of nodes (a 685-turn meeting), so every interaction
// with it is delegated on the list container rather than bound per row.
composeTurnListEl.addEventListener("change", handleComposeTurnCheckboxChange);
composeTurnListEl.addEventListener("click", handleComposeTurnListClick);
composeTurnListEl.addEventListener("keydown", handleComposeTurnTextKeydown);
composeTurnListEl.addEventListener("focusout", handleComposeTurnTextBlur);
composeDialog.addEventListener("close", resetComposeDialog);

// Export popover: delegated, because the app bar it lives in is rebuilt on every render.
detail.addEventListener("click", handleExportClick);
detail.addEventListener("change", handleExportChange);
// Video, seek, clips and share controls: same reason, plus a finished meeting can carry
// hundreds of transcript rows that each want a play affordance.
detail.addEventListener("click", handleVideoClick);
detail.addEventListener("change", handleVideoChange);
document.addEventListener("click", (event) => {
  if (!state.export.open) return;
  if (event.target.closest("[data-export-root]")) return;
  closeExportMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.export.open) closeExportMenu();
});

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
  // A freshly minted share URL is shown in the moment it was made and not kept around
  // afterwards. Leaving it to reappear on every visit would make "shown exactly once"
  // a claim the UI itself contradicts.
  state.revealedShares.clear();
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
    const session = await api("/api/auth/me");
    enterApp(session.user, session.features);
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

function enterApp(user, features) {
  state.user = user;
  authGate.hidden = true;
  appShell.hidden = false;
  teamViewButton.hidden = user.role !== "admin";
  renderUserChip();
  fillSettingsForm();
  renderList();
  void loadFeatures(features);
  if (!state.pollTimer) state.pollTimer = setInterval(refresh, 1800);
  void refresh();
}

// The auth response is allowed to carry the flags, which saves a round trip and gets the
// first paint right; anything else asks the dedicated route. Either way a failure means
// "no video", never "assume yes and 404 on click".
async function loadFeatures(seed) {
  if (!seed) {
    try {
      const payload = await api("/api/features");
      seed = payload.features || payload;
    } catch {
      seed = null;
    }
  }
  state.features = { video: { ...NO_VIDEO_FEATURE, ...(seed?.video || {}) } };
  // Held back until there is something to draw: repainting an empty pane here would
  // flash "Nothing selected" over the boot skeletons.
  if (state.meetings) {
    renderCache.detail = "";
    renderMain();
  }
}

function videoFeature() {
  return state.features?.video || NO_VIDEO_FEATURE;
}

function showAuthGate() {
  state.user = null;
  state.meetings = null;
  state.features = null;
  // A share URL is only ever shown to the person who minted it, in the session that
  // minted it. Signing out must not leave one sitting in memory for the next account
  // that signs in on this machine.
  state.revealedShares.clear();
  state.openClips.clear();
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
    const session = await api(path, { method: "POST", body: JSON.stringify(payload) });
    authPassword.value = "";
    enterApp(session.user, session.features);
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

async function refreshGoogleAccounts() {
  try {
    state.googleAccounts = await api("/api/google/accounts");
  } catch (error) {
    state.googleAccounts = { error: error.message, accounts: [] };
  }
  renderGoogleAccounts();
  renderGoogleChip();
}

/* ---------- Connected Google accounts ---------- */

function renderGoogleAccounts() {
  const payload = state.googleAccounts;
  if (!payload || !googleAccountsList) return;

  if (payload.error) {
    googleAccountsList.innerHTML = `<p class="settings-hint">${escapeHtml(payload.error)}</p>`;
    return;
  }
  if (!payload.configured) {
    googleAccountsList.innerHTML = `<p class="settings-hint">Add Google OAuth credentials on the server to connect accounts.</p>`;
    return;
  }
  if (!payload.accounts.length) {
    googleAccountsList.innerHTML = `<p class="settings-hint">No Google accounts connected yet. Connect one to import calendars and send notes.</p>`;
    return;
  }

  googleAccountsList.innerHTML = payload.accounts
    .map((account) => {
      const flags = [
        account.canReadCalendar ? "" : "no calendar access",
        account.canSendMail ? "" : "cannot send mail",
        account.emailVerified ? "" : "address unconfirmed — reconnect to fix"
      ].filter(Boolean);

      return `
        <div class="account-row${account.needsReconnect ? " needs-reconnect" : ""}" data-account-id="${escapeHtml(account.id)}">
          <div class="account-main">
            <span class="account-email">${escapeHtml(account.email || "Connected account")}</span>
            ${account.isDefault ? `<span class="account-badge">sends by default</span>` : ""}
            ${account.needsReconnect ? `<span class="account-badge bad">reconnect needed</span>` : ""}
            ${flags.length ? `<span class="account-meta">${escapeHtml(flags.join(" · "))}</span>` : ""}
          </div>
          <div class="account-toggles">
            <label class="switch-line switch-line-sm">
              <input type="checkbox" data-account-toggle="calendarSyncEnabled" ${account.calendarSyncEnabled ? "checked" : ""} ${account.canReadCalendar ? "" : "disabled"} />
              <span>Import calendar</span>
            </label>
            <label class="switch-line switch-line-sm">
              <input type="checkbox" data-account-toggle="calendarAutoStart" ${account.calendarAutoStart ? "checked" : ""} ${account.canReadCalendar ? "" : "disabled"} />
              <span>Auto-join</span>
            </label>
            <label class="switch-line switch-line-sm">
              <input type="checkbox" data-account-toggle="receivesNotes" ${account.receivesNotes ? "checked" : ""} />
              <span>Receives notes</span>
            </label>
          </div>
          <div class="account-actions">
            ${account.isDefault ? "" : `<button class="btn btn-ghost btn-sm" type="button" data-account-action="default">Send from this</button>`}
            <a class="btn btn-ghost btn-sm" href="/api/gmail/oauth/start">Reconnect</a>
            <button class="btn btn-ghost btn-sm" type="button" data-account-action="disconnect">Disconnect</button>
          </div>
        </div>`;
    })
    .join("");
}

googleAccountsList?.addEventListener("change", async (event) => {
  const toggle = event.target.closest("[data-account-toggle]");
  if (!toggle) return;
  const accountId = toggle.closest("[data-account-id]")?.dataset.id || toggle.closest(".account-row")?.dataset.accountId;
  if (!accountId) return;
  await patchGoogleAccount(accountId, { [toggle.dataset.accountToggle]: toggle.checked });
});

googleAccountsList?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-account-action]");
  if (!button) return;
  const row = button.closest(".account-row");
  const accountId = row?.dataset.accountId;
  if (!accountId) return;

  if (button.dataset.accountAction === "default") {
    await patchGoogleAccount(accountId, { isDefault: true });
    return;
  }
  const email = row.querySelector(".account-email")?.textContent || "this account";
  // Disconnecting revokes our copy of the credential — worth a confirm, since the only
  // way back is a fresh OAuth round trip.
  if (!confirm(`Disconnect ${email}? Its calendar will stop importing and it can no longer send notes.`)) return;
  try {
    state.googleAccounts = await api(`/api/google/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" });
    renderGoogleAccounts();
    renderGoogleChip();
    await Promise.all([refreshGmail(), refreshCalendar()]);
  } catch (error) {
    setAppError(error.message);
  }
});

async function patchGoogleAccount(accountId, patch) {
  try {
    state.googleAccounts = await api(`/api/google/accounts/${encodeURIComponent(accountId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    });
    renderGoogleAccounts();
    renderGoogleChip();
  } catch (error) {
    setAppError(error.message);
    await refreshGoogleAccounts();
  }
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

/* ---------- Export ---------- */

const MAX_EXPORT_MEETINGS = 200;

function renderExportControl() {
  return `
    <div class="export-menu" data-export-root>
      <button class="btn btn-secondary btn-sm" type="button" data-export-toggle
              aria-haspopup="dialog" aria-expanded="${state.export.open ? "true" : "false"}">Export</button>
      ${state.export.open ? renderExportPanel() : ""}
    </div>
  `;
}

function renderExportPanel() {
  const meetings = state.meetings || [];
  const hasSelection = Boolean(state.selectedId);
  const { scope, sections, format, picked } = state.export;

  return `
    <div class="export-panel" role="dialog" aria-label="Export meetings">
      <section class="export-group">
        <p class="export-label">Meetings</p>
        ${renderExportRadio("export-scope", "meeting", "This meeting", scope === "meeting", !hasSelection)}
        ${renderExportRadio("export-scope", "all", `All meetings (${meetings.length})`, scope === "all")}
        ${renderExportRadio("export-scope", "pick", "Choose…", scope === "pick")}
        <div class="export-picklist" data-export-picklist ${scope === "pick" ? "" : "hidden"}>
          ${
            meetings.length
              ? meetings
                  .map(
                    (meeting) => `
                      <label class="export-choice export-choice-pick">
                        <input type="checkbox" data-pick="${escapeHtml(meeting.id)}" ${picked.has(meeting.id) ? "checked" : ""} />
                        <span class="export-pick-title">${escapeHtml(meeting.title)}</span>
                        <span class="export-pick-time">${escapeHtml(formatDayTime(meeting.scheduledAt))}</span>
                      </label>
                    `
                  )
                  .join("")
              : `<p class="export-empty">No meetings yet.</p>`
          }
        </div>
      </section>

      <section class="export-group">
        <p class="export-label">
          Include
          <span class="export-presets">
            <button type="button" class="link-button" data-export-preset="all">All</button>
            <button type="button" class="link-button" data-export-preset="none">None</button>
          </span>
        </p>
        ${EXPORT_SECTIONS.map(
          (section) => `
            <label class="export-choice">
              <input type="checkbox" data-section="${section.key}" ${sections.has(section.key) ? "checked" : ""} />
              <span>${escapeHtml(section.label)}</span>
            </label>
          `
        ).join("")}
      </section>

      <section class="export-group">
        <p class="export-label">Format</p>
        ${renderExportRadio("export-format", "md", "Markdown (.md)", format === "md")}
        ${renderExportRadio("export-format", "json", "JSON (.json)", format === "json")}
      </section>

      <p class="export-error" data-export-error ${state.export.error ? "" : "hidden"}>${escapeHtml(state.export.error)}</p>
      <footer class="export-foot">
        <span class="export-hint" data-export-hint>${escapeHtml(exportSummaryText())}</span>
        <button type="button" class="btn btn-primary btn-sm" data-export-run ${exportRunnable() ? "" : "disabled"}>
          ${state.export.busy ? "Preparing…" : "Download"}
        </button>
      </footer>
    </div>
  `;
}

function renderExportRadio(name, value, label, checked, disabled = false) {
  return `
    <label class="export-choice${disabled ? " is-disabled" : ""}">
      <input type="radio" name="${name}" value="${value}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} />
      <span>${escapeHtml(label)}</span>
    </label>
  `;
}

function handleExportClick(event) {
  if (event.target.closest("[data-export-toggle]")) {
    toggleExportMenu();
    return;
  }
  const preset = event.target.closest("[data-export-preset]");
  if (preset) {
    state.export.sections =
      preset.dataset.exportPreset === "all"
        ? new Set(EXPORT_SECTIONS.map((section) => section.key))
        : new Set();
    for (const box of detail.querySelectorAll("input[data-section]")) {
      box.checked = state.export.sections.has(box.dataset.section);
    }
    refreshExportPanel();
    return;
  }
  if (event.target.closest("[data-export-run]")) runExport();
}

function handleExportChange(event) {
  const input = event.target;
  if (input.name === "export-scope") state.export.scope = input.value;
  else if (input.name === "export-format") state.export.format = input.value;
  else if (input.dataset.section) toggleInSet(state.export.sections, input.dataset.section, input.checked);
  else if (input.dataset.pick) toggleInSet(state.export.picked, input.dataset.pick, input.checked);
  else return;
  state.export.error = "";
  // Patched in place rather than re-rendered: a full render would steal focus mid-selection.
  refreshExportPanel();
}

function toggleInSet(set, value, present) {
  if (present) set.add(value);
  else set.delete(value);
}

function toggleExportMenu() {
  state.export.open = !state.export.open;
  state.export.error = "";
  // "This meeting" is meaningless with nothing selected — fall back to the whole account.
  if (state.export.open && !state.selectedId && state.export.scope === "meeting") {
    state.export.scope = "all";
  }
  renderCache.detail = "";
  renderDetail();
}

function closeExportMenu() {
  if (!state.export.open) return;
  state.export.open = false;
  renderCache.detail = "";
  renderDetail();
}

function refreshExportPanel() {
  const root = detail.querySelector("[data-export-root]");
  if (!root) return;
  const picklist = root.querySelector("[data-export-picklist]");
  if (picklist) picklist.hidden = state.export.scope !== "pick";
  const hint = root.querySelector("[data-export-hint]");
  if (hint) hint.textContent = exportSummaryText();
  const error = root.querySelector("[data-export-error]");
  if (error) {
    error.textContent = state.export.error;
    error.hidden = !state.export.error;
  }
  const run = root.querySelector("[data-export-run]");
  if (run) {
    run.disabled = !exportRunnable();
    run.textContent = state.export.busy ? "Preparing…" : "Download";
  }
}

function exportMeetingCount() {
  if (state.export.scope === "all") return (state.meetings || []).length;
  if (state.export.scope === "pick") return state.export.picked.size;
  return state.selectedId ? 1 : 0;
}

function exportRunnable() {
  const count = exportMeetingCount();
  return !state.export.busy && count > 0 && count <= MAX_EXPORT_MEETINGS && state.export.sections.size > 0;
}

function exportSummaryText() {
  const count = exportMeetingCount();
  if (!count) return "Nothing selected";
  if (count > MAX_EXPORT_MEETINGS) return `Too many — pick ${MAX_EXPORT_MEETINGS} or fewer`;
  if (!state.export.sections.size) return "Pick at least one section";
  const meetings = `${count} meeting${count === 1 ? "" : "s"}`;
  const sections = `${state.export.sections.size} section${state.export.sections.size === 1 ? "" : "s"}`;
  return count === 1 ? `${meetings} · ${sections}` : `${meetings} · ${sections} · .zip`;
}

async function runExport() {
  if (!exportRunnable()) return;
  state.export.busy = true;
  state.export.error = "";
  refreshExportPanel();

  try {
    const response = await fetch("/api/meetings/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        meetingIds: exportScopeIds(),
        sections: [...state.export.sections],
        format: state.export.format
      })
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const fieldError = body.fields ? Object.values(body.fields)[0] : "";
      throw new Error(fieldError || body.message || "Export failed.");
    }

    const blob = await response.blob();
    downloadBlob(blob, filenameFromResponse(response));
    closeExportMenu();
  } catch (error) {
    state.export.error = error.message;
  } finally {
    state.export.busy = false;
    refreshExportPanel();
  }
}

function exportScopeIds() {
  if (state.export.scope === "all") return "all";
  if (state.export.scope === "pick") return [...state.export.picked];
  return [state.selectedId];
}

function filenameFromResponse(response) {
  const disposition = response.headers.get("Content-Disposition") || "";
  const match = disposition.match(/filename="([^"]+)"/u);
  return match ? match[1] : `opennotetaker-export.${state.export.format}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Safari needs the object URL alive until the download has actually started.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
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
        [...state.openFolds],
        state.editingActionItems,
        state.editingActionItems === meeting.id ? state.actionItemDrafts.get(meeting.id) : null,
        videoFeature().enabled,
        [...state.openClips],
        // Keys only. A share URL is a bearer credential; it has no business being
        // stringified into a cache key that lives on in memory.
        [...state.revealedShares.keys()],
        [...state.shareExpiry]
      ])
    : "empty";
  if (cacheKey === renderCache.detail) return;
  // The list polls every 1.8s. Re-rendering the pane while the action-item editor is
  // open would rebuild the inputs and steal the caret mid-word, so background refreshes
  // are held off until the edit is saved or cancelled. Deliberate redraws clear
  // renderCache.detail first and still get through.
  if (meeting && state.editingActionItems === meeting.id && renderCache.detail !== "") return;
  // Same bargain for playback. Rebuilding the pane swaps the <video> element out from
  // under whoever is watching, so a poll tick that would interrupt a playing recording
  // is dropped instead. Deliberate redraws still get through and put the playhead back.
  if (meeting && isWatchingVideo() && renderCache.detail !== "") return;
  renderCache.detail = cacheKey;

  if (!meeting) {
    detail.innerHTML = `
      ${renderAppBar({ left: `<span class="app-bar-crumb">Meetings</span>`, right: renderExportControl() })}
      <div class="detail-body">
        <div class="empty-state">
          <h3>Nothing selected</h3>
          <p>Pick a meeting from the list, or create a new one — the summary, action items, and transcript will live here.</p>
          <button type="button" class="btn btn-primary" data-open-create>New meeting</button>
        </div>
      </div>
    `;
    detail.querySelector("[data-open-create]")?.addEventListener("click", openCreateDialog);
    indexSeekGroups();
    return;
  }

  const meta = STATUS_META[meeting.status] || { label: meeting.status, tone: "muted" };
  const running = state.runningStarts.has(meeting.id) || isWorking(meeting.status);
  const sendingEmail = state.sendingEmails.has(meeting.id);
  const notes = meeting.artifacts?.notes;
  // Scheme-guarded: escaping alone would still let a stored javascript: URL run on click.
  const meetHref = safeMeetHref(meeting.meetUrl);
  const playhead = capturePlayhead();

  detail.innerHTML = `
    ${renderAppBar({
      left: `<span class="app-bar-crumb">Meetings</span><span class="app-bar-crumb-sep">›</span><span class="app-bar-doc-title">${escapeHtml(meeting.title)}</span>`,
      right: renderExportControl()
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
      ${renderVideo(meeting)}
      ${notes ? renderNotes(notes, meeting) : ""}
      ${renderTranscript(meeting)}
      ${renderRunLog(meeting.events)}
    </div>
  `;

  wireVideoPlayer(playhead);

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

  wireActionItemControls(meeting);

  detail.querySelector("#email-button")?.addEventListener("click", () => {
    // The button used to send the fixed, full-record email itself. Now it only opens
    // the composer — a choice of what to send is the entire point of this feature.
    openComposeDialog(meeting);
  });
}

function renderActionItemEditor(items) {
  return `
    <div class="items-editor" data-items-editor>
      ${items
        .map(
          (item, index) => `
            <div class="item-edit-row" data-item-index="${index}">
              <textarea class="item-task" data-item-field="task" rows="2" placeholder="What was committed to">${escapeHtml(item.task || "")}</textarea>
              <input class="item-owner" data-item-field="owner" value="${escapeHtml(item.owner || "")}" placeholder="Owner" />
              <input class="item-due" data-item-field="due" value="${escapeHtml(item.due || "")}" placeholder="Due" />
              <button class="btn btn-ghost btn-sm item-remove" type="button" data-item-remove aria-label="Remove item">Remove</button>
            </div>`
        )
        .join("")}
      ${items.length ? "" : `<p class="muted-note">No items. Add one, or save an empty list to clear it.</p>`}
    </div>`;
}

// The delivery strip under the action items: who this is going to, when, and the
// controls to change any of it before it does.
function renderActionItemDelivery(meeting, items) {
  if (!meeting || meeting.status !== "completed" || !items.length) return "";
  const delivery = meeting.delivery?.actionItemsEmail || {};
  const recipients = delivery.recipients || [];
  const suggestions = attendeeSuggestionsFor(meeting, recipients);

  let line;
  if (delivery.status === "sent") {
    line = `Sent to ${escapeHtml(recipients.join(", "))}${delivery.sentAt ? ` · ${escapeHtml(formatDayTime(delivery.sentAt))}` : ""}`;
  } else if (delivery.status === "scheduled") {
    line = `Sending to ${escapeHtml(recipients.join(", "))} at ${escapeHtml(formatDayTime(delivery.scheduledFor))}`;
  } else if (delivery.status === "failed") {
    line = `Send failed: ${escapeHtml(delivery.error || "unknown error")}`;
  } else if (delivery.status === "cancelled") {
    line = "Automatic send cancelled for this meeting.";
  } else {
    line = recipients.length
      ? `Ready to send to ${escapeHtml(recipients.join(", "))}`
      : "Not scheduled — add recipients to send these to the people who were in the meeting.";
  }

  return `
    <div class="delivery-strip" data-delivery>
      <div class="delivery-line">
        <span class="delivery-status delivery-${escapeHtml(delivery.status || "idle")}">${line}</span>
        <div class="sec-actions">
          ${
            delivery.status === "scheduled"
              ? `<button class="btn btn-ghost btn-sm" type="button" data-delivery-cancel>Don't send</button>`
              : ""
          }
          <button class="btn btn-secondary btn-sm" type="button" data-delivery-send>
            ${delivery.status === "sent" ? "Send again" : "Send now"}
          </button>
        </div>
      </div>
      <div class="field delivery-field">
        <label for="delivery-recipients">Send action items to</label>
        <input id="delivery-recipients" data-delivery-recipients value="${escapeHtml(recipients.join(", "))}"
               placeholder="name@company.com, another@company.com" />
        <p class="field-hint">Comma separated. Blank means this meeting sends to nobody.</p>
      </div>
      ${
        suggestions.length
          ? `<div class="suggestions">
              <p class="field-hint">On the calendar invite — click to add:</p>
              <div class="suggestion-chips">
                ${suggestions
                  .map(
                    (person) => `
                      <button class="chip-add${person.external ? " external" : ""}" type="button"
                              data-suggest-email="${escapeHtml(person.email)}"
                              title="${escapeHtml(person.external ? "Outside your company" : "Same company")}">
                        ${escapeHtml(person.name || person.email)}${person.external ? " ⚠" : ""}
                      </button>`
                  )
                  .join("")}
              </div>
              <p class="field-hint">⚠ marks someone outside your company's domains.</p>
            </div>`
          : ""
      }
    </div>`;
}

// Attendees are suggestions only — nothing is emailed to them until they are on the
// recipient list, which is a choice someone makes here.
// The domains "internal" means for this account: the owner's own address plus every
// connected Google account. Shared by the attendee suggestions and the composer's
// recipient chips so the two agree on what counts as external.
function ownerDomains() {
  return new Set(
    [state.user?.email, ...(state.googleAccounts?.accounts || []).map((account) => account.email)]
      .filter(Boolean)
      .map((email) => email.split("@").pop().toLowerCase())
  );
}

// Client-side only — a hint for the UI, not the check that matters. The server enforces
// the same rule on every recipient regardless of what this says (notes-email-selection.js).
function isExternalEmail(email) {
  const domain = String(email || "").split("@").pop()?.toLowerCase();
  return !domain || !ownerDomains().has(domain);
}

function attendeeSuggestionsFor(meeting, recipients) {
  const attendees = meeting.source?.googleCalendar?.attendees || [];
  if (!attendees.length) return [];
  const already = new Set((recipients || []).map((email) => email.toLowerCase()));
  return attendees
    .filter((person) => person.email && !already.has(person.email.toLowerCase()))
    .map((person) => ({
      ...person,
      external: isExternalEmail(person.email)
    }));
}

function wireActionItemControls(meeting) {
  const draftFor = () => state.actionItemDrafts.get(meeting.id) || meeting.artifacts?.notes?.actionItems || [];
  const redraw = () => {
    renderCache.detail = "";
    renderDetail();
  };

  detail.querySelector("[data-items-edit]")?.addEventListener("click", () => {
    state.editingActionItems = meeting.id;
    state.actionItemDrafts.set(meeting.id, cloneItems(meeting.artifacts?.notes?.actionItems || []));
    redraw();
  });

  detail.querySelector("[data-items-cancel]")?.addEventListener("click", () => {
    state.editingActionItems = null;
    state.actionItemDrafts.delete(meeting.id);
    redraw();
  });

  detail.querySelector("[data-items-add]")?.addEventListener("click", () => {
    state.actionItemDrafts.set(meeting.id, [...readEditorRows(), { task: "", owner: "", due: "", evidenceTimestamp: "" }]);
    redraw();
  });

  detail.querySelector("[data-items-save]")?.addEventListener("click", async () => {
    const actionItems = readEditorRows().filter((item) => item.task.trim());
    try {
      const { meeting: saved } = await api(`/api/meetings/${meeting.id}/action-items`, {
        method: "PUT",
        body: JSON.stringify({ actionItems })
      });
      state.editingActionItems = null;
      state.actionItemDrafts.delete(meeting.id);
      replaceMeeting(saved);
      redraw();
    } catch (error) {
      setAppError(error.message);
    }
  });

  detail.querySelector("[data-items-editor]")?.addEventListener("input", () => {
    // Held in state rather than read only on save: a background poll re-renders the
    // detail pane, and half-typed edits must survive that.
    state.actionItemDrafts.set(meeting.id, readEditorRows());
  });

  detail.querySelectorAll("[data-item-remove]").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.closest("[data-item-index]")?.dataset.itemIndex);
      const rows = readEditorRows();
      rows.splice(index, 1);
      state.actionItemDrafts.set(meeting.id, rows);
      redraw();
    });
  });

  detail.querySelector("[data-delivery-send]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const recipients = splitEmails(detail.querySelector("[data-delivery-recipients]")?.value || "");
    if (!recipients.length) {
      setAppError("Add at least one recipient before sending action items.");
      return;
    }
    const external = attendeeSuggestionsFor(meeting, []).filter(
      (person) => person.external && recipients.includes(person.email.toLowerCase())
    );
    // Mail to someone outside the company cannot be recalled, so make that explicit
    // once rather than trusting that the ⚠ was noticed.
    if (
      external.length &&
      !confirm(
        `${external.map((person) => person.email).join(", ")} ${external.length === 1 ? "is" : "are"} outside your company. Send them these action items?`
      )
    ) {
      return;
    }

    button.disabled = true;
    button.textContent = "Sending…";
    try {
      const { meeting: saved } = await api(`/api/meetings/${meeting.id}/send-action-items`, {
        method: "POST",
        body: JSON.stringify({ recipients })
      });
      replaceMeeting(saved);
      redraw();
    } catch (error) {
      setAppError(error.message);
      button.disabled = false;
      button.textContent = "Send now";
    }
  });

  detail.querySelector("[data-delivery-cancel]")?.addEventListener("click", async () => {
    try {
      const { meeting: saved } = await api(`/api/meetings/${meeting.id}/action-items/delivery`, {
        method: "PATCH",
        body: JSON.stringify({ autoSend: false })
      });
      replaceMeeting(saved);
      redraw();
    } catch (error) {
      setAppError(error.message);
    }
  });

  detail.querySelectorAll("[data-suggest-email]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const input = detail.querySelector("[data-delivery-recipients]");
      if (!input) return;
      const recipients = new Set(splitEmails(input.value).map((email) => email.toLowerCase()));
      recipients.add(chip.dataset.suggestEmail);
      input.value = [...recipients].join(", ");
      void persistDeliveryRecipients(meeting, [...recipients]);
    });
  });

  detail.querySelector("[data-delivery-recipients]")?.addEventListener("change", (event) => {
    void persistDeliveryRecipients(meeting, splitEmails(event.target.value));
  });

  function readEditorRows() {
    const editor = detail.querySelector("[data-items-editor]");
    if (!editor) return cloneItems(draftFor());
    return [...editor.querySelectorAll("[data-item-index]")].map((row, index) => ({
      ...(draftFor()[index] || {}),
      task: row.querySelector('[data-item-field="task"]')?.value || "",
      owner: row.querySelector('[data-item-field="owner"]')?.value || "",
      due: row.querySelector('[data-item-field="due"]')?.value || ""
    }));
  }
}

async function persistDeliveryRecipients(meeting, recipients) {
  try {
    const { meeting: saved } = await api(`/api/meetings/${meeting.id}/action-items/delivery`, {
      method: "PATCH",
      body: JSON.stringify({ recipients })
    });
    replaceMeeting(saved);
  } catch (error) {
    setAppError(error.message);
  }
}

function replaceMeeting(updated) {
  if (!updated) return;
  state.meetings = (state.meetings || []).map((item) => (item.id === updated.id ? updated : item));
}

function cloneItems(items) {
  return items.map((item) => ({ ...item }));
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

function renderNotes(notes, meeting) {
  const actionItems = notes.actionItems || [];
  const triage = [
    { title: "Decisions", items: notes.decisions },
    { title: "Open questions", items: notes.openQuestions },
    { title: "Risks", items: notes.risks }
  ].filter((block) => block.items?.length);

  const editing = state.editingActionItems === meeting?.id;
  const rows = editing ? state.actionItemDrafts.get(meeting.id) || actionItems : actionItems;

  return `
    <section class="doc-section">
      <div class="sec-label-row">
        <div class="sec-label">Action items <span class="sec-count">${rows.length}</span></div>
        ${
          meeting?.status === "completed"
            ? editing
              ? `<div class="sec-actions">
                   <button class="btn btn-ghost btn-sm" type="button" data-items-cancel>Cancel</button>
                   <button class="btn btn-secondary btn-sm" type="button" data-items-add>Add item</button>
                   <button class="btn btn-primary btn-sm" type="button" data-items-save>Save</button>
                 </div>`
              : `<div class="sec-actions">
                   <button class="btn btn-ghost btn-sm" type="button" data-items-edit>Edit</button>
                 </div>`
            : ""
        }
      </div>
      ${
        editing
          ? renderActionItemEditor(rows)
          : rows.length
            ? `<div class="table-wrap">
                <table class="action-table">
                  <thead>
                    <tr><th>Task</th><th>Owner</th><th>Due</th><th>At</th></tr>
                  </thead>
                  <tbody>
                    ${rows
                      .map(
                        (item) => `
                          <tr>
                            <td class="cell-task">${escapeHtml(item.task)}</td>
                            <td><span class="owner-chip${isKnownOwner(item.owner) ? " known" : ""}">${escapeHtml(item.owner || "Unknown")}</span></td>
                            <td>${escapeHtml(item.due || "Not stated")}</td>
                            <td class="cell-num">${renderEvidenceControls(meeting, item)}</td>
                          </tr>
                        `
                      )
                      .join("")}
                  </tbody>
                </table>
              </div>`
            : `<p class="muted-note">No commitments were made in this meeting.</p>`
      }
      ${editing ? "" : renderActionItemDelivery(meeting, rows)}
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

  const playable = videoPlayable(meeting);

  const turnRows = turns
    .map(
      (turn) => `
        <div class="turn"${playable ? ` data-line-start="${Number(turn.start) || 0}"` : ""}>
          <div class="turn-meta">
            <span class="turn-speaker">${escapeHtml(turn.role)}</span>
            ${renderSeekTime(turn.start, playable)}
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
        <div class="compare-row"${playable ? ` data-line-start="${Number(segment.start) || 0}"` : ""}>
          <div class="turn-meta">
            <span class="turn-speaker">${escapeHtml(segment.speaker)}</span>
            ${renderSeekTime(segment.start, playable)}
          </div>
          <p class="compare-raw"><span class="copy-label">Raw Hinglish</span>${escapeHtml(segment.text)}</p>
          <p><span class="copy-label">Clean English</span>${escapeHtml(normalized?.english || "Waiting for normalization.")}</p>
        </div>
      `;
    })
    .join("");

  // Each list is its own seek group: the two folds cover the same timeline, so one
  // flat index of rows would not be sorted and the "which row is playing" lookup
  // would land on whichever list happened to come second in the DOM.
  const transcriptBody = turns.length
    ? `${roleLegend ? `<div class="role-legend">${roleLegend}</div>` : ""}${warnings}<div class="turn-list" data-seek-group>${turnRows}</div>`
    : `<div class="turn-list" data-seek-group>${compareRows}</div>`;

  return `
    ${renderFold("transcript", "Transcript", turns.length ? `${turns.length} turns` : `${rawSegments.length} segments`, transcriptBody)}
    ${
      turns.length && rawSegments.length
        ? renderFold("raw-evidence", "Raw Hinglish evidence", `${rawSegments.length} segments`, `<div class="turn-list" data-seek-group>${compareRows}</div>`)
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

/* ---------- Recording, seek sync, clips ---------- */

const CLIP_LEAD_SECONDS = 8;
const CLIP_TAIL_SECONDS = 4;

function videoPlayable(meeting) {
  return meeting?.video?.status === "ready";
}

function renderVideo(meeting) {
  const video = meeting.video;
  // Meetings that predate the feature carry no video block at all, and nothing in their
  // UI should suggest a recording was ever an option for them.
  if (!video) return "";

  const clips = meeting.clips || [];
  const ready = video.status === "ready";
  const source = `/api/meetings/${encodeURIComponent(meeting.id)}/video`;
  const toggle = canToggleRecording(meeting)
    ? `<button class="btn btn-secondary btn-sm" type="button" data-video-toggle="${video.enabled ? "off" : "on"}">${
        video.enabled ? "Don't record video" : "Record video"
      }</button>`
    : "";

  return `
    <section class="doc-section">
      <div class="sec-label-row">
        <div class="sec-label">
          Recording
          ${ready && video.durationMs ? `<span class="sec-count">${escapeHtml(formatTimecode(video.durationMs))}</span>` : ""}
        </div>
        ${
          ready
            ? `<div class="sec-actions">
                 <span class="video-meta">${escapeHtml(videoMetaText(video))}</span>
                 <button class="btn btn-secondary btn-sm" type="button" data-clip-here>Clip this moment</button>
               </div>`
            : toggle && `<div class="sec-actions">${toggle}</div>`
        }
      </div>
      ${
        ready
          ? `<video class="video-player" data-video-player="${escapeHtml(meeting.id)}"
                    src="${escapeHtml(source)}" controls playsinline preload="metadata"></video>`
          : renderVideoStatus(meeting, video)
      }
      ${ready || clips.length ? renderClips(meeting, clips) : ""}
    </section>
  `;
}

// Video is additive; the transcript is the product. So every state that is not "here is
// your recording" says plainly what happened instead of leaving a blank space that reads
// like the whole meeting failed.
function renderVideoStatus(meeting, video) {
  if (video.status === "recording") return videoStatusChip("live", "Recording…");
  if (video.status === "processing") return videoStatusChip("warn", "Processing…");
  if (video.status === "pending") return videoStatusChip("muted", "Video queued — capture starts when the bot joins.");
  if (video.status === "skipped") return videoStatusChip("muted", "Not recorded.");
  if (video.status === "failed") {
    return videoStatusChip("bad", `Video unavailable — ${video.error || "the capture failed"}`);
  }
  if (video.status === "purged") {
    const days = effectiveVideoRetentionDays(meeting);
    return videoStatusChip("muted", days ? `Purged after ${days} day${days === 1 ? "" : "s"}.` : "Purged.");
  }
  return videoStatusChip("muted", "No recording.");
}

// The opt-out has to exist wherever the meeting came from. A calendar import never passed
// through the create dialog's checkbox, so on an install with sync on this is the only
// place its owner is ever asked — and the artifact is video of everyone's face. Only while
// the meeting is still scheduled: after that the block is a record of what was captured.
function canToggleRecording(meeting) {
  return (
    videoFeature().enabled &&
    meeting.status === "scheduled" &&
    ["pending", "skipped"].includes(meeting.video?.status)
  );
}

function videoStatusChip(tone, text) {
  return `<p class="video-status is-${tone}">${escapeHtml(text)}</p>`;
}

// Video never outlives the transcript: the operator's ceiling and this meeting's own
// retention both apply, and the shorter one is the one that happened.
function effectiveVideoRetentionDays(meeting) {
  const days = [videoFeature().retentionDays, meeting.retentionDays]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  return days.length ? Math.min(...days) : 0;
}

function videoMetaText(video) {
  return [video.width && video.height ? `${video.width}×${video.height}` : "", video.bytes ? formatBytes(video.bytes) : ""]
    .filter(Boolean)
    .join(" · ");
}

// The timestamp itself is the play control. A separate icon button beside it would double
// the hit targets in a transcript that routinely runs to a couple of thousand rows, to
// put the affordance somewhere nobody would look for it.
function renderSeekTime(seconds, playable) {
  const label = formatTime(seconds);
  if (!playable) return `<span class="turn-time">${label}</span>`;
  return `
    <button type="button" class="turn-time seek-btn" data-seek="${Number(seconds) || 0}"
            aria-label="Play the recording from ${label}">
      <svg class="seek-glyph" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.6 1.4 L8.2 5 L2.6 8.6 Z" fill="currentColor"/></svg>${label}
    </button>`;
}

function renderEvidenceControls(meeting, item) {
  const stamp = item.evidenceTimestamp || "";
  if (!videoPlayable(meeting)) return escapeHtml(stamp);
  const moment = evidenceMoment(meeting, item);
  if (!moment) return escapeHtml(stamp);
  return `
    <div class="evidence-actions">
      ${renderSeekTime(moment.start, true)}
      <button type="button" class="btn btn-ghost btn-sm" data-clip-open
              data-clip-start="${moment.start}" data-clip-end="${moment.end}"
              data-clip-source="${escapeHtml(moment.id || "")}"
              data-clip-label="${escapeHtml(item.task || "")}"
              aria-label="Clip the recording around ${escapeHtml(formatTime(moment.start))}">Clip</button>
    </div>`;
}

// Evidence arrives two ways: ids of the transcript rows where the commitment was made,
// and a "mm:ss" string. The ids win — they survive somebody retyping the timestamp by
// hand while editing the item, and they carry an end time, which a string never does.
function evidenceMoment(meeting, item) {
  for (const id of item.evidenceSegmentIds || []) {
    const row = findTranscriptRow(meeting, id);
    if (row) return { start: Number(row.start) || 0, end: Number(row.end ?? row.start) || 0, id };
  }
  const parsed = parseClockInput(item.evidenceTimestamp);
  if (parsed === null) return null;
  return { start: parsed / 1000, end: parsed / 1000, id: null };
}

function findTranscriptRow(meeting, id) {
  const artifacts = meeting.artifacts || {};
  for (const pool of [artifacts.reconstructedTranscript?.turns, artifacts.rawSegments, artifacts.normalizedSegments]) {
    const hit = (pool || []).find((row) => row.id === id);
    if (hit) return hit;
  }
  return null;
}

function renderClips(meeting, clips) {
  return `
    <div class="clip-block">
      <p class="clip-block-label">Clips <span class="sec-count">${clips.length}</span></p>
      ${
        clips.length
          ? `<div class="clip-list">${clips.map((clip) => renderClip(meeting, clip)).join("")}</div>`
          : `<p class="muted-note">No clips yet. Cut one from an action item above, or from wherever the player is sitting.</p>`
      }
    </div>`;
}

function renderClip(meeting, clip) {
  const open = state.openClips.has(clip.id);
  const source = `/api/meetings/${encodeURIComponent(meeting.id)}/clips/${encodeURIComponent(clip.id)}`;
  const lengthMs = Math.max(0, (Number(clip.endMs) || 0) - (Number(clip.startMs) || 0));
  const meta = [
    `${formatTimecode(clip.startMs)} – ${formatTimecode(clip.endMs)}`,
    lengthMs ? `${(lengthMs / 1000).toFixed(1)}s` : "",
    clip.bytes ? formatBytes(clip.bytes) : ""
  ]
    .filter(Boolean)
    .join(" · ");

  return `
    <article class="clip-row" data-clip-id="${escapeHtml(clip.id)}">
      <div class="clip-head">
        <div class="clip-main">
          <span class="clip-label">${escapeHtml(clip.label)}</span>
          <span class="clip-meta">${escapeHtml(meta)}</span>
        </div>
        <div class="clip-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-clip-toggle aria-expanded="${open ? "true" : "false"}">
            ${open ? "Hide" : "Play"}
          </button>
          ${shareActive(clip.share) ? "" : renderShareControl(clip)}
          <button type="button" class="btn btn-ghost btn-sm clip-destructive" data-clip-delete>Delete</button>
        </div>
      </div>
      ${
        open
          ? `<video class="clip-player" data-clip-player src="${escapeHtml(source)}" controls playsinline preload="metadata"></video>`
          : ""
      }
      ${renderShareBox(clip)}
    </article>`;
}

function renderShareControl(clip) {
  // The operator's default may not be one of the three offered lengths, and a select
  // whose options exclude the value it claims to default to silently picks the first.
  const preferred = Number(state.shareExpiry.get(clip.id)) || Number(videoFeature().shareDefaultDays) || 7;
  const choices = [...new Set([...SHARE_EXPIRY_CHOICES, preferred])].sort((a, b) => a - b);
  return `
    <select class="share-expiry" data-share-days aria-label="How long the public link lasts">
      ${choices
        .map(
          (days) =>
            `<option value="${days}"${days === preferred ? " selected" : ""}>${days} day${days === 1 ? "" : "s"}</option>`
        )
        .join("")}
    </select>
    <button type="button" class="btn btn-secondary btn-sm" data-share-create>
      ${clip.share ? "New public link" : "Create public link"}
    </button>`;
}

function renderShareBox(clip) {
  const revealed = state.revealedShares.get(clip.id);
  if (revealed) {
    return `
      <div class="share-box is-fresh">
        <p class="share-note">
          Copy this now. The server keeps only a hash of the link, so this is the one and
          only time it can be shown — losing it means generating a new one, which stops
          this one working.
        </p>
        <div class="share-url-row">
          <input class="share-url" readonly value="${escapeHtml(revealed)}" aria-label="Public link for this clip" />
          <button type="button" class="btn btn-secondary btn-sm" data-share-copy>Copy</button>
        </div>
        <div class="share-foot">
          ${renderShareMeta(clip.share)}
          <button type="button" class="btn btn-ghost btn-sm clip-destructive" data-share-revoke>Revoke</button>
        </div>
      </div>`;
  }

  const share = clip.share;
  if (!share) return "";

  if (shareActive(share)) {
    return `
      <div class="share-box">
        <p class="share-note">
          A public link is live for this clip. It was shown once when it was made and
          cannot be shown again — generate a new one to get a link you can copy, which
          stops the old one working.
        </p>
        ${renderShareMeta(share)}
        <div class="clip-actions">
          ${renderShareControl(clip)}
          <button type="button" class="btn btn-ghost btn-sm clip-destructive" data-share-revoke>Revoke</button>
        </div>
      </div>`;
  }

  return `
    <div class="share-box">
      <p class="share-note">
        ${share.revokedAt ? "The public link for this clip was revoked" : "The public link for this clip expired"}
        · ${escapeHtml(shareViewsText(share))}
      </p>
    </div>`;
}

// Whether to describe a link as live. The server enforces both conditions on every
// request; this only exists so the UI never calls a dead link a working one.
function shareActive(share) {
  if (!share || share.revokedAt) return false;
  const expiresAt = Date.parse(share.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt > Date.now();
}

function renderShareMeta(share) {
  if (!share) return "";
  const bits = [
    share.expiresAt ? `expires ${formatDayTime(share.expiresAt)}` : "",
    shareViewsText(share),
    share.lastViewedAt ? `last opened ${formatDayTime(share.lastViewedAt)}` : ""
  ].filter(Boolean);
  return `<p class="share-meta">${escapeHtml(bits.join(" · "))}</p>`;
}

function shareViewsText(share) {
  const views = Number(share?.views) || 0;
  return `${views} view${views === 1 ? "" : "s"}`;
}

/* ---------- Video events ---------- */

function handleVideoClick(event) {
  const seek = event.target.closest("[data-seek]");
  if (seek) {
    seekVideo(Number(seek.dataset.seek));
    return;
  }

  const meeting = (state.meetings || []).find((item) => item.id === state.selectedId);
  if (!meeting) return;

  const recordToggle = event.target.closest("[data-video-toggle]");
  if (recordToggle) {
    void setRecordVideo(meeting, recordToggle.dataset.videoToggle === "on", recordToggle);
    return;
  }

  if (event.target.closest("[data-clip-here]")) {
    const player = detail.querySelector("[data-video-player]");
    const at = Number(player?.currentTime) || 0;
    openClipDialog(meeting, { start: at, end: at });
    return;
  }

  const clipOpen = event.target.closest("[data-clip-open]");
  if (clipOpen) {
    openClipDialog(meeting, {
      start: Number(clipOpen.dataset.clipStart) || 0,
      end: Number(clipOpen.dataset.clipEnd) || 0,
      label: clipOpen.dataset.clipLabel || "",
      sourceActionItemId: clipOpen.dataset.clipSource || ""
    });
    return;
  }

  const row = event.target.closest("[data-clip-id]");
  if (!row) return;
  const clipId = row.dataset.clipId;

  if (event.target.closest("[data-clip-toggle]")) {
    const opening = !state.openClips.has(clipId);
    toggleInSet(state.openClips, clipId, opening);
    renderCache.detail = "";
    renderDetail();
    // Started here rather than with an autoplay attribute: autoplay would restart a
    // clip somebody had deliberately paused every time the pane happened to redraw.
    if (opening) playClip(clipId);
    return;
  }
  const copy = event.target.closest("[data-share-copy]");
  if (copy) {
    void copyShareUrl(copy, row);
    return;
  }
  const create = event.target.closest("[data-share-create]");
  if (create) {
    void createShareLink(meeting, clipId, row, create);
    return;
  }
  const revoke = event.target.closest("[data-share-revoke]");
  if (revoke) {
    void revokeShareLink(meeting, clipId, revoke);
    return;
  }
  const remove = event.target.closest("[data-clip-delete]");
  if (remove) void deleteClip(meeting, clipId, remove);
}

function handleVideoChange(event) {
  const select = event.target.closest("[data-share-days]");
  const clipId = select?.closest("[data-clip-id]")?.dataset.clipId;
  if (!clipId) return;
  // Remembered rather than read only at click time: the pane re-renders under this
  // select every poll tick, and snapping back to the default after somebody picked 30
  // days would misstate what the button next to it is about to do.
  state.shareExpiry.set(clipId, Number(select.value));
}

function seekVideo(seconds) {
  const player = detail.querySelector("[data-video-player]");
  if (!player || !Number.isFinite(seconds)) return;
  // Nudged back a beat: a row's start time is where the transcriber decided the words
  // began, which is reliably a fraction late for the first syllable.
  player.currentTime = Math.max(0, seconds - 0.4);
  void player.play().catch(() => {});
  syncSeekHighlight(player.currentTime);
  // Clicking a row eight hundred lines down is useless if the player is off-screen —
  // but scrolling one that is already visible would throw away the reader's place.
  const box = player.getBoundingClientRect();
  if (box.bottom < 0 || box.top > window.innerHeight) {
    player.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }
}

function playClip(clipId) {
  const player = [...detail.querySelectorAll("[data-clip-id]")]
    .find((row) => row.dataset.clipId === clipId)
    ?.querySelector("[data-clip-player]");
  void player?.play().catch(() => {});
}

function wireVideoPlayer(playhead) {
  indexSeekGroups();
  const player = detail.querySelector("[data-video-player]");
  if (!player) return;
  player.addEventListener("timeupdate", handleVideoTimeUpdate);
  // Scrubbing has to move the highlight at once; the throttle below is for playback.
  player.addEventListener("seeked", () => syncSeekHighlight(player.currentTime));
  restorePlayhead(player, playhead);
}

// Any video in the pane that is actually running — the recording or an open clip.
function isWatchingVideo() {
  return [...detail.querySelectorAll("video")].some((player) => !player.paused && !player.ended);
}

// The pane is rebuilt with innerHTML, which destroys the <video> along with its position.
// A deliberate redraw during playback — a clip landing, the action-item editor opening —
// therefore carries the playhead across instead of dumping the viewer back to zero.
function capturePlayhead() {
  const player = detail.querySelector("[data-video-player]");
  if (!player || !player.currentTime) return null;
  return { meetingId: player.dataset.videoPlayer, time: player.currentTime, paused: player.paused };
}

function restorePlayhead(player, saved) {
  if (!saved || saved.meetingId !== player.dataset.videoPlayer) return;
  const seek = () => {
    player.currentTime = saved.time;
    if (!saved.paused) void player.play().catch(() => {});
  };
  // Setting currentTime on a source whose metadata has not arrived is silently dropped.
  if (player.readyState > 0) seek();
  else player.addEventListener("loadedmetadata", seek, { once: true });
}

/* One entry per transcript list, each sorted by time already. The two folds cover the
   same timeline, so a single flat index would not be sorted and the "which row is
   playing" lookup would land on whichever list came second in the DOM. */
let seekGroups = [];
let lastHighlightAt = 0;

function indexSeekGroups() {
  seekGroups = [...detail.querySelectorAll("[data-seek-group]")].map((group) => {
    const nodes = [...group.querySelectorAll("[data-line-start]")];
    return { nodes, times: nodes.map((node) => Number(node.dataset.lineStart) || 0), active: -1 };
  });
}

function handleVideoTimeUpdate(event) {
  // timeupdate is a firehose while scrubbing. Six updates a second is more than the eye
  // needs, and the real saving is below: a tick landing on the same row does nothing.
  const now = performance.now();
  if (now - lastHighlightAt < 150) return;
  lastHighlightAt = now;
  syncSeekHighlight(event.target.currentTime);
}

// Never re-renders the transcript. A 2000-segment meeting would rebuild 2000 nodes four
// times a second; this touches two nodes per list, and only when the row actually
// changes.
function syncSeekHighlight(seconds) {
  for (const group of seekGroups) {
    const index = lastIndexAtOrBefore(group.times, seconds);
    if (index === group.active) continue;
    group.nodes[group.active]?.classList.remove("is-playing");
    group.nodes[index]?.classList.add("is-playing");
    group.active = index;
  }
}

function lastIndexAtOrBefore(times, value) {
  let low = 0;
  let high = times.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (times[mid] <= value) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/* ---------- Clip composer ---------- */

// Padded either side because the interesting part is never the sentence on its own: a
// commitment lands mid-conversation, and the line before it is the context that makes
// the clip worth sending to anyone.
function openClipDialog(meeting, { start, end, label = "", sourceActionItemId = "" }) {
  state.clipDraft = { meetingId: meeting.id, sourceActionItemId: sourceActionItemId || null };
  const durationMs = Number(meeting.video?.durationMs) || 0;
  const startMs = Math.max(0, Math.round(start * 1000) - CLIP_LEAD_SECONDS * 1000);
  const padded = Math.round(Math.max(end, start) * 1000) + CLIP_TAIL_SECONDS * 1000;
  const endMs = durationMs ? Math.min(padded, durationMs) : padded;

  clipLabelInput.value = label.slice(0, 120);
  clipStartInput.value = formatTimecode(startMs, 1);
  clipEndInput.value = formatTimecode(endMs, 1);
  clipError.textContent = "";
  renderClipLengthHint();
  clipDialog.showModal();
  clipLabelInput.focus();
}

function renderClipLengthHint() {
  const startMs = parseClockInput(clipStartInput.value);
  const endMs = parseClockInput(clipEndInput.value);
  const cap = Number(videoFeature().maxClipSeconds) || NO_VIDEO_FEATURE.maxClipSeconds;
  if (startMs === null || endMs === null || endMs <= startMs) {
    clipLengthHint.textContent = `Times are mm:ss. Up to ${cap} seconds.`;
    return;
  }
  const seconds = (endMs - startMs) / 1000;
  clipLengthHint.textContent =
    seconds > cap ? `${seconds.toFixed(1)}s — longer than the ${cap}s cap.` : `${seconds.toFixed(1)}s clip.`;
}

async function handleCreateClip(event) {
  event.preventDefault();
  const draft = state.clipDraft;
  if (!draft) return;

  const startMs = parseClockInput(clipStartInput.value);
  const endMs = parseClockInput(clipEndInput.value);
  const cap = Number(videoFeature().maxClipSeconds) || NO_VIDEO_FEATURE.maxClipSeconds;

  // Checked here only so the answer is instant. The server validates the same range
  // against the recording it will actually cut, and that is the copy that decides.
  if (startMs === null || endMs === null) {
    clipError.textContent = "Give a start and an end as mm:ss.";
    return;
  }
  if (endMs <= startMs) {
    clipError.textContent = "A clip has to end after it starts.";
    return;
  }
  if ((endMs - startMs) / 1000 > cap) {
    clipError.textContent = `Clips are capped at ${cap} seconds.`;
    return;
  }

  clipError.textContent = "";
  clipCreateButton.disabled = true;
  clipCreateButton.textContent = "Cutting…";
  try {
    const { clip } = await api(`/api/meetings/${draft.meetingId}/clips`, {
      method: "POST",
      body: JSON.stringify({
        label: clipLabelInput.value,
        startMs,
        endMs,
        ...(draft.sourceActionItemId ? { sourceActionItemId: draft.sourceActionItemId } : {})
      })
    });
    // Opened straight away: the only way to know a cut landed on the right words is to
    // watch it.
    if (clip?.id) state.openClips.add(clip.id);
    state.clipDraft = null;
    clipDialog.close();
    await reloadMeeting(draft.meetingId);
    if (clip?.id) playClip(clip.id);
  } catch (error) {
    clipError.textContent = error.message;
  } finally {
    clipCreateButton.disabled = false;
    clipCreateButton.textContent = "Create clip";
  }
}

/* ---------- Clip sharing ---------- */

async function createShareLink(meeting, clipId, row, button) {
  const clip = (meeting.clips || []).find((item) => item.id === clipId);
  // Generating a new link retires the one already out there. Anyone holding it loses
  // access the moment this returns, which is not something to do by accident.
  if (
    shareActive(clip?.share) &&
    !confirm("Generate a new link? The link already shared for this clip stops working immediately.")
  ) {
    return;
  }

  const select = row.querySelector("[data-share-days]");
  const expiresInDays =
    Number(select?.value) || Number(state.shareExpiry.get(clipId)) || Number(videoFeature().shareDefaultDays) || 7;

  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Creating…";
  try {
    const { url } = await api(`/api/meetings/${meeting.id}/clips/${clipId}/share`, {
      method: "POST",
      body: JSON.stringify({ expiresInDays })
    });
    // The only copy of this URL that will ever exist on this machine.
    state.revealedShares.set(clipId, url);
    await reloadMeeting(meeting.id);
  } catch (error) {
    setAppError(error.message);
    button.disabled = false;
    button.textContent = label;
  }
}

async function revokeShareLink(meeting, clipId, button) {
  if (!confirm("Revoke this link? Anyone holding it loses access immediately.")) return;
  button.disabled = true;
  button.textContent = "Revoking…";
  try {
    await api(`/api/meetings/${meeting.id}/clips/${clipId}/share`, { method: "DELETE" });
    state.revealedShares.delete(clipId);
    await reloadMeeting(meeting.id);
  } catch (error) {
    setAppError(error.message);
    button.disabled = false;
    button.textContent = "Revoke";
  }
}

async function setRecordVideo(meeting, recordVideo, button) {
  button.disabled = true;
  try {
    await api(`/api/meetings/${meeting.id}`, {
      method: "PATCH",
      body: JSON.stringify({ recordVideo })
    });
    await reloadMeeting(meeting.id);
  } catch (error) {
    setAppError(error.message);
    button.disabled = false;
  }
}

async function deleteClip(meeting, clipId, button) {
  if (!confirm("Delete this clip? Any public link for it stops working.")) return;
  button.disabled = true;
  button.textContent = "Deleting…";
  try {
    await api(`/api/meetings/${meeting.id}/clips/${clipId}`, { method: "DELETE" });
    state.openClips.delete(clipId);
    state.revealedShares.delete(clipId);
    state.shareExpiry.delete(clipId);
    await reloadMeeting(meeting.id);
  } catch (error) {
    setAppError(error.message);
    button.disabled = false;
    button.textContent = "Delete";
  }
}

async function copyShareUrl(button, row) {
  const field = row.querySelector(".share-url");
  if (!field) return;
  try {
    await navigator.clipboard.writeText(field.value);
    button.textContent = "Copied";
    setTimeout(() => (button.textContent = "Copy"), 1500);
  } catch {
    // Clipboard access is denied outside a secure context; selecting the text at least
    // leaves a working Cmd-C behind.
    field.select();
  }
}

// A clip or share change touches exactly one meeting. Refetching that one keeps the full
// transcript already in memory, instead of round-tripping the whole list and then paying
// for the transcript again behind it.
async function reloadMeeting(id) {
  try {
    const { meeting } = await api(`/api/meetings/${id}`);
    replaceMeeting(meeting);
  } catch (error) {
    setAppError(error.message);
  }
  renderCache.detail = "";
  renderDetail();
}

/* ---------- Notes composer ----------
   Sends a SELECTION to POST /api/meetings/:id/notes-email — never a finished message.
   The server renders both the preview and the delivered mail from the same template, so
   nothing built here is trusted content; it is a choice of what to include and a few
   short edited strings, all re-validated server-side. See
   docs/superpowers/specs/2026-08-27-notes-email-composer-design.md for the full design. */

function currentComposeMeeting() {
  return (state.meetings || []).find((meeting) => meeting.id === composerState.meetingId) || null;
}

function openComposeDialog(meeting) {
  if (meeting.status !== "completed") return; // the button that opens this is disabled otherwise

  const segments = meeting.artifacts?.normalizedSegments?.length
    ? meeting.artifacts.normalizedSegments
    : meeting.artifacts?.rawSegments || [];
  composeSegments = segments.map((segment) => ({
    id: segment.id,
    speaker: segment.speaker || "Speaker",
    start: Number(segment.start) || 0,
    text: segment.english || segment.text || segment.raw || ""
  }));
  composeRows = new Map();
  composeAnchorId = null;

  composerState.meetingId = meeting.id;
  composerState.recipients = [];
  composerState.confirmExternal = false;
  composerState.subject = `Notes: ${meeting.title || "Meeting"}`;
  composerState.intro = "";
  composerState.signoff = "";
  composerState.sections = { ...PRESETS.clientSafe };
  composerState.includeIds = new Set();
  composerState.edits = new Map();
  composerState.preset = "clientSafe";
  composerState.error = "";
  composerState.needsExternalConfirm = false;
  composerState.pendingPreview = false;
  composerState.inFlight = null;
  composerState.busy = false;

  composeSubjectInput.value = composerState.subject;
  composeIntroInput.value = "";
  composeSignoffInput.value = "";
  renderComposeSections();
  updatePresetRadios();
  renderComposeRecipients();
  renderComposeError();
  buildComposeTurnList();
  updateComposeTurnCount();
  syncRawEvidenceGuard();
  composePreviewGroup.hidden = true;
  composePreviewFrame.srcdoc = "";
  composeDropBeforeButton.disabled = true;
  composeDropAfterButton.disabled = true;
  // Collapsed by default so the transcript picker below it doesn't start scrolled out
  // of view; a <details> otherwise keeps whatever the operator left it at, unlike the
  // rest of this dialog, which is fully reset every time it opens.
  const advanced = composeDialog.querySelector(".form-advanced");
  if (advanced) advanced.open = false;
  updateComposeButtons();

  composeDialog.showModal();
  composeRecipientInput.focus();
}

// Discards the scratchpad. Nothing built in this dialog is ever written back to the
// meeting, so there is nothing to preserve once it closes — including on Cancel.
function resetComposeDialog() {
  composeSegments = [];
  composeRows.clear();
  composeAnchorId = null;
  composePreviewFrame.srcdoc = "";
  composerState.busy = false;
  composerState.inFlight = null;
}

/* ---- Recipients ---- */

function renderComposeRecipients() {
  const meeting = currentComposeMeeting();

  composeRecipientChips.innerHTML = composerState.recipients
    .map((email) => {
      const external = isExternalEmail(email);
      return `
        <span class="recipient-chip${external ? " external" : ""}">
          ${escapeHtml(email)}
          <button type="button" class="recipient-chip-remove" data-remove-recipient="${escapeHtml(email)}"
                  aria-label="Remove ${escapeHtml(email)}">&times;</button>
        </span>`;
    })
    .join("");

  const suggestions = meeting ? attendeeSuggestionsFor(meeting, composerState.recipients) : [];
  composeAttendeeSuggestions.innerHTML = suggestions
    .map(
      (person) => `
        <button class="chip-add${person.external ? " external" : ""}" type="button"
                data-compose-suggest="${escapeHtml(person.email)}"
                title="${escapeHtml(person.external ? "Outside your company" : "Same company")}">
          ${escapeHtml(person.name || person.email)}${person.external ? " ⚠" : ""}
        </button>`
    )
    .join("");

  updateComposeButtons();
}

function handleComposeRecipientKeydown(event) {
  if (event.key === "Enter" || event.key === ",") {
    event.preventDefault();
    commitComposeRecipientInput();
  } else if (event.key === "Backspace" && !composeRecipientInput.value && composerState.recipients.length) {
    // Mirrors how every chip-style input on the web treats an empty backspace: the last
    // chip is the thing your cursor is logically next to.
    removeComposeRecipient(composerState.recipients[composerState.recipients.length - 1]);
  }
}

function commitComposeRecipientInput() {
  const raw = composeRecipientInput.value.trim().replace(/,$/u, "");
  composeRecipientInput.value = "";
  if (raw) addComposeRecipient(raw);
}

function addComposeRecipient(rawEmail) {
  const email = rawEmail.trim().toLowerCase();
  if (!COMPOSE_EMAIL_PATTERN.test(email)) {
    composerState.error = `"${rawEmail.trim()}" doesn't look like an email address.`;
    renderComposeError();
    return;
  }
  if (composerState.recipients.includes(email)) return;
  if (composerState.recipients.length >= MAX_COMPOSE_RECIPIENTS) {
    composerState.error = `At most ${MAX_COMPOSE_RECIPIENTS} recipients.`;
    renderComposeError();
    return;
  }
  composerState.recipients.push(email);
  // A changed recipient list is a new question about who this is going to — the
  // previous confirmation does not carry over to someone who was not covered by it.
  composerState.confirmExternal = false;
  composerState.error = "";
  composerState.needsExternalConfirm = false;
  renderComposeError();
  renderComposeRecipients();
}

function removeComposeRecipient(email) {
  composerState.recipients = composerState.recipients.filter((item) => item !== email);
  composerState.confirmExternal = false;
  renderComposeRecipients();
}

function handleComposeDialogClick(event) {
  const remove = event.target.closest("[data-remove-recipient]");
  if (remove) {
    removeComposeRecipient(remove.dataset.removeRecipient);
    return;
  }
  const suggest = event.target.closest("[data-compose-suggest]");
  if (suggest) addComposeRecipient(suggest.dataset.composeSuggest);
}

/* ---- Presets and sections ---- */

function renderComposeSections() {
  for (const input of composeSectionsContainer.querySelectorAll("input[data-section]")) {
    input.checked = Boolean(composerState.sections[input.dataset.section]);
  }
}

function updatePresetRadios() {
  composePresetFullInput.checked = composerState.preset === "full";
  composePresetClientSafeInput.checked = composerState.preset === "clientSafe";
}

function handleComposePresetChange(event) {
  const input = event.target.closest("input[data-preset]");
  if (!input || !input.checked) return;
  applyComposePreset(input.dataset.preset);
}

// Mutates checkboxes to match composerState.includeIds without touching the Set itself
// — for callers (a preset) that already replaced includeIds wholesale and just need the
// 685 checkboxes to catch up, as opposed to setAllComposeTurns, which drives both.
function syncAllComposeCheckboxes() {
  for (const [id, row] of composeRows) {
    row.checkbox.checked = composerState.includeIds.has(id);
  }
}

function applyComposePreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;
  composerState.sections = { ...preset };
  composerState.preset = name;
  // "Full record" is the one preset that means every turn too — every other path
  // through the turn list (individual toggles, All/None, drop-before/after) leaves
  // includeIds exactly as the operator left it.
  composerState.includeIds = name === "full" ? new Set(composeSegments.map((segment) => segment.id)) : new Set();
  renderComposeSections();
  updatePresetRadios();
  syncAllComposeCheckboxes();
  syncRawEvidenceGuard();
  updateComposeTurnCount();
}

// Presets are starting points, not modes: any change the operator makes after picking
// one — a section, a turn, a trim — leaves neither radio checked, because the selection
// no longer matches what either preset would produce.
function clearComposePresetMatch() {
  composerState.preset = null;
  updatePresetRadios();
}

function handleComposeSectionChange(event) {
  const input = event.target.closest("input[data-section]");
  if (!input) return;
  composerState.sections[input.dataset.section] = input.checked;
  clearComposePresetMatch();
  // The warning below the picker is about THIS checkbox, so it has to re-evaluate here.
  updateComposeTurnCount();
}

// Ruling 4 (2026-08-27-notes-email-composer progress ledger): the renderer sends raw
// evidence as every raw segment, unfiltered by which turns are selected. Left as-is
// server-side — this dialog is where the combination gets closed off instead: raw
// evidence is disabled outright unless canEnableRawEvidence says the selection could not
// possibly diverge from it.
//
// That covers deselecting a turn AND editing one — editing is redaction too (see
// compose-guard.js), so this must run after every mutation to either includeIds or
// edits, not just includeIds. handleComposeTurnTextBlur is the one call site that
// touches edits without also touching includeIds.
function syncRawEvidenceGuard() {
  const allIncluded = canEnableRawEvidence(composeSegments, composerState.includeIds, composerState.edits);
  composeRawEvidenceInput.disabled = !allIncluded;
  composeRawEvidenceChoice.classList.toggle("is-disabled", !allIncluded);
  if (!allIncluded && composerState.sections.rawEvidence) {
    composerState.sections.rawEvidence = false;
    composeRawEvidenceInput.checked = false;
  }
  composeRawEvidenceHint.textContent = allIncluded
    ? "Sends every raw segment verbatim — it ignores the turn selection below entirely."
    : "Off while any turn below is deselected or edited: raw evidence ignores both, so it would still include a turn you just redacted.";
  composeRawEvidenceHint.classList.toggle("is-warning", !allIncluded);
}

/* ---- Transcript turns ----
   Built once when the dialog opens (buildComposeTurnList) and mutated node-by-node from
   then on. A 685-turn meeting is thousands of DOM nodes; rebuilding that on every
   checkbox click or keystroke is the one thing this section exists to avoid. */

function buildComposeTurnList() {
  const fragment = document.createDocumentFragment();
  for (const segment of composeSegments) {
    const row = document.createElement("div");
    row.className = "compose-turn";
    row.dataset.rowId = segment.id;

    const checkLabel = document.createElement("label");
    checkLabel.className = "compose-turn-check";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.turnCheck = "";
    checkbox.checked = composerState.includeIds.has(segment.id);
    checkLabel.append(checkbox);

    const meta = document.createElement("span");
    meta.className = "compose-turn-meta";
    const time = document.createElement("button");
    time.type = "button";
    time.className = "compose-turn-time";
    time.dataset.turnAnchor = "";
    time.title = "Anchor here for Drop before / Drop after";
    time.textContent = formatTime(segment.start);
    const speaker = document.createElement("span");
    speaker.className = "compose-turn-speaker";
    speaker.textContent = segment.speaker;
    meta.append(time, speaker);

    // contenteditable rather than a mode toggle: clicking straight into the text is the
    // click-to-edit, and :focus styling (see styles.css) is the only signal it needs.
    const text = document.createElement("p");
    text.className = "compose-turn-text";
    text.dataset.turnText = "";
    text.contentEditable = "true";
    text.tabIndex = 0;
    text.textContent = segment.text;

    row.append(checkLabel, meta, text);
    fragment.append(row);
    composeRows.set(segment.id, { root: row, checkbox, text });
  }
  composeTurnListEl.replaceChildren(fragment);
}

function updateComposeTurnCount() {
  composeTranscriptCount.textContent = composeSegments.length
    ? `${composerState.includeIds.size} of ${composeSegments.length} selected`
    : "No transcript available";

  // Picking turns and editing them are only meaningful if the Transcript SECTION is on,
  // and the two controls sit far apart — the checkbox is above the fold, the picker is
  // below a list that can run to 1,746 rows. Someone selected every turn, edited one, sent,
  // and got an email with no transcript in it: the payload was right, the dialog just never
  // said the work was being discarded. Deliberately not auto-enabling the section — this
  // feature exists to stop things being sent that nobody chose to send, so the safe default
  // is to say so and let the operator decide.
  const hasTurnWork = composerState.includeIds.size > 0 || composerState.edits.size > 0;
  composeTranscriptOff.hidden = !(hasTurnWork && !composerState.sections.transcript);
}

function handleComposeTurnCheckboxChange(event) {
  const checkbox = event.target.closest("[data-turn-check]");
  if (!checkbox) return;
  const id = checkbox.closest("[data-row-id]")?.dataset.rowId;
  if (!id) return;
  toggleInSet(composerState.includeIds, id, checkbox.checked);
  clearComposePresetMatch();
  syncRawEvidenceGuard();
  updateComposeTurnCount();
}

function handleComposeTurnListClick(event) {
  const anchorButton = event.target.closest("[data-turn-anchor]");
  if (!anchorButton) return;
  const id = anchorButton.closest("[data-row-id]")?.dataset.rowId;
  if (id) setComposeAnchor(id);
}

function setComposeAnchor(id) {
  if (composeAnchorId) composeRows.get(composeAnchorId)?.root.classList.remove("is-anchor");
  composeAnchorId = id;
  composeRows.get(id)?.root.classList.add("is-anchor");
  composeDropBeforeButton.disabled = false;
  composeDropAfterButton.disabled = false;
}

function setAllComposeTurns(included) {
  for (const segment of composeSegments) {
    if (included) composerState.includeIds.add(segment.id);
    else composerState.includeIds.delete(segment.id);
    const row = composeRows.get(segment.id);
    if (row) row.checkbox.checked = included;
  }
  clearComposePresetMatch();
  syncRawEvidenceGuard();
  updateComposeTurnCount();
}

// Trims around the anchored turn: "before" drops everything earlier and keeps the
// anchor onward; "after" drops everything later and keeps up to the anchor. The anchor
// row's own checked state is left exactly as it was — trimming decides a range, not
// what happens to the one row it is measured from.
function dropComposeTurnsRelativeToAnchor(direction) {
  if (!composeAnchorId) return;
  const anchorIndex = composeSegments.findIndex((segment) => segment.id === composeAnchorId);
  if (anchorIndex === -1) return;
  composeSegments.forEach((segment, index) => {
    const shouldDrop = direction === "before" ? index < anchorIndex : index > anchorIndex;
    if (!shouldDrop || !composerState.includeIds.delete(segment.id)) return;
    const row = composeRows.get(segment.id);
    if (row) row.checkbox.checked = false;
  });
  clearComposePresetMatch();
  syncRawEvidenceGuard();
  updateComposeTurnCount();
}

function handleComposeTurnTextKeydown(event) {
  // A transcript turn is one line. Enter commits the edit instead of inserting a
  // newline into what the recipient would otherwise read as a paragraph break.
  if (event.key !== "Enter" || !event.target.closest("[data-turn-text]")) return;
  event.preventDefault();
  event.target.blur();
}

function handleComposeTurnTextBlur(event) {
  const textEl = event.target.closest("[data-turn-text]");
  if (!textEl) return;
  const id = textEl.closest("[data-row-id]")?.dataset.rowId;
  const segment = composeSegments.find((item) => item.id === id);
  if (!id || !segment) return;

  // SELECTION_LIMITS.turnEdit (notes-email-selection.js) is 2000 chars; the server
  // clamps silently, but showing the operator the clamp here means the preview and the
  // send agree with what they see on screen.
  const edited = textEl.textContent.slice(0, 2000);
  if (edited !== textEl.textContent) textEl.textContent = edited;

  const row = composeRows.get(id);
  if (edited === segment.text) {
    composerState.edits.delete(id);
    row?.root.classList.remove("is-edited");
  } else {
    // Stored even when empty: clearing a turn's text is a legitimate way to redact one
    // line without dropping the turn entirely (notes-email-render.js).
    composerState.edits.set(id, edited);
    row?.root.classList.add("is-edited");
  }
  // An edit is turn work in its own right: it can raise the "section is off" warning with
  // nothing selected at all, so the count/warning has to re-evaluate on this path too.
  updateComposeTurnCount();
  // This edit just changed composerState.edits without touching includeIds — the one
  // mutation this dialog makes that the other five (checkbox, preset, select-all/none,
  // drop-before/after) don't. Raw evidence has to react to an edit exactly as it reacts
  // to deselection, or "[redacted]" in the transcript ships alongside the original
  // sentence in raw evidence.
  syncRawEvidenceGuard();
}

/* ---- Preview and send ---- */

function updateComposeButtons() {
  const blocked = composerState.busy || composerState.recipients.length === 0;
  composePreviewButton.disabled = blocked;
  composeSendButton.disabled = blocked;
  composePreviewButton.textContent = composerState.inFlight === "preview" ? "Loading…" : "Preview";
  composeSendButton.textContent = composerState.inFlight === "send" ? "Sending…" : "Send";
}

function renderComposeError() {
  composeErrorEl.textContent = composerState.error;
  composeErrorEl.hidden = !composerState.error;
  composeConfirmExternalButton.hidden = !composerState.needsExternalConfirm;
}

function handleComposeSubmit(event) {
  event.preventDefault();
  void submitCompose(false);
}

function handleComposeConfirmExternal() {
  composerState.confirmExternal = true;
  void submitCompose(composerState.pendingPreview);
}

function buildComposePayload() {
  return {
    recipients: composerState.recipients,
    confirmExternal: composerState.confirmExternal,
    subject: composerState.subject,
    intro: composerState.intro,
    signoff: composerState.signoff,
    sections: { ...composerState.sections },
    transcript: {
      includeIds: [...composerState.includeIds],
      edits: Object.fromEntries(composerState.edits)
    }
  };
}

// Bypasses the shared api() helper deliberately: that helper collapses every error down
// to a message string, and telling "external_not_confirmed" apart from
// "meeting_not_completed" (both 409s) needs the error code the response actually sends.
async function callNotesEmail(meetingId, payload, { preview }) {
  const response = await fetch(
    `/api/meetings/${encodeURIComponent(meetingId)}/notes-email${preview ? "?preview=1" : ""}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || "Request failed.");
    error.status = response.status;
    error.code = body.error || "";
    throw error;
  }
  return body;
}

async function submitCompose(preview) {
  if (composerState.busy) return;
  if (!composerState.recipients.length) {
    composerState.error = "Add at least one recipient.";
    renderComposeError();
    return;
  }

  const meetingId = composerState.meetingId;
  // Minted fresh for this call and never reused — see the comment on composerState's
  // activeRequestId. Whoever holds the matching id when the response comes back is the
  // request the dialog is still waiting on; anyone else's response is stale and must not
  // touch the dialog, even though it still has to finish the meeting-scoped bookkeeping
  // below (reloadMeeting, sendingEmails) that isn't about the dialog at all.
  const requestId = ++composeRequestSeq;
  composerState.activeRequestId = requestId;
  composerState.busy = true;
  composerState.inFlight = preview ? "preview" : "send";
  composerState.error = "";
  composerState.needsExternalConfirm = false;
  renderComposeError();
  updateComposeButtons();
  // Reflected on the meeting detail pane too, so the outer "Compose & send" button
  // shows the same "Sending…" state a background poll would otherwise silently repaint.
  if (!preview) {
    state.sendingEmails.add(meetingId);
    renderCache.detail = "";
    renderDetail();
  }

  try {
    const body = await callNotesEmail(meetingId, buildComposePayload(), { preview });
    const isCurrentRequest = composerState.activeRequestId === requestId;
    if (preview) {
      // A stale preview response must not overwrite what is now a different (or newer)
      // send's preview pane.
      if (isCurrentRequest) {
        composePreviewSubject.textContent = body.subject ? `Subject: ${body.subject}` : "";
        composePreviewFrame.srcdoc = body.html || "";
        composePreviewGroup.hidden = false;
        composePreviewGroup.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
      }
    } else {
      // A stale send response must not close a dialog that has since moved on to a
      // different composition — that send may still be genuinely in flight.
      if (isCurrentRequest) composeDialog.close();
      // Unconditional either way: this send genuinely happened (or failed) for
      // meetingId, and that is true regardless of what the dialog is doing now.
      await reloadMeeting(meetingId);
    }
  } catch (error) {
    if (composerState.activeRequestId === requestId) {
      composerState.error = error.message;
      composerState.needsExternalConfirm = error.code === "external_not_confirmed";
      composerState.pendingPreview = preview;
      renderComposeError();
    }
  } finally {
    // The actual fix for the duplicate-send race: only the request the dialog is still
    // waiting on may release the busy guard. A meetingId check alone isn't enough here —
    // a second send of the SAME meeting would share it with the first — which is why
    // this compares the per-call token instead.
    if (composerState.activeRequestId === requestId) {
      composerState.busy = false;
      composerState.inFlight = null;
    }
    if (!preview) {
      state.sendingEmails.delete(meetingId);
      renderCache.detail = "";
      renderDetail();
    }
    updateComposeButtons();
  }
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

  // The transcript that the seek index pointed at is gone with the innerHTML above.
  indexSeekGroups();

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
  fillRecordVideoField();
  createDialog.showModal();
  $("#title").focus();
}

// Recording is an operator decision first and a per-meeting one second: the checkbox
// only exists on an install where VIDEO_RECORDING_ENABLED is on, and there it defaults
// to whatever the operator set as the house default.
function fillRecordVideoField() {
  const video = videoFeature();
  recordVideoField.hidden = !video.enabled;
  if (!video.enabled) return;
  recordVideoInput.checked = video.recordByDefault !== false;
  recordVideoHint.textContent = `Kept ${video.retentionDays} day${video.retentionDays === 1 ? "" : "s"}, and never longer than this meeting's transcript.`;
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
  // Sent as a real boolean rather than through FormData, which reports a ticked box as
  // the string "on" and omits an unticked one entirely — neither of which a server can
  // tell apart from "the client is too old to know about video".
  if (videoFeature().enabled) payload.recordVideo = recordVideoInput.checked;

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
  void Promise.all([refreshGmail(), refreshCalendar(), refreshGoogleAccounts()]);
}

function fillSettingsForm() {
  const settings = state.user?.settings;
  if (!settings) return;
  settingsRecipients.value = (settings.transcriptRecipients || []).join(", ");
  settingsActionRecipients.value = (settings.actionItemRecipients || []).join(", ");
  settingsAutoEmail.checked = Boolean(settings.autoEmailTranscript);
  settingsEmailConnected.checked = settings.emailConnectedAccounts !== false;
  settingsActionConnected.checked = settings.actionItemsToConnectedAccounts !== false;
  settingsAutoActionItems.checked = Boolean(settings.autoEmailActionItems);
  renderActionHoldHint();
}

function renderActionHoldHint() {
  if (!actionHoldHint) return;
  const hold = state.googleAccounts?.actionItemsHoldMinutes;
  if (!settingsAutoActionItems.checked) {
    actionHoldHint.textContent = "Off — send action items yourself from the meeting.";
    return;
  }
  actionHoldHint.textContent = hold
    ? `Held ${hold} minutes after the notes are ready, so you can fix or cancel before it goes out.`
    : "Sent as soon as the notes are ready.";
}

async function saveSettings() {
  settingsStatus.textContent = "Saving…";
  try {
    const { user } = await api("/api/auth/settings", {
      method: "PATCH",
      body: JSON.stringify({
        transcriptRecipients: splitEmails(settingsRecipients.value),
        actionItemRecipients: splitEmails(settingsActionRecipients.value),
        autoEmailTranscript: settingsAutoEmail.checked,
        emailConnectedAccounts: settingsEmailConnected.checked,
        actionItemsToConnectedAccounts: settingsActionConnected.checked,
        autoEmailActionItems: settingsAutoActionItems.checked
      })
    });
    state.user = user;
    fillSettingsForm();
    settingsStatus.textContent = "Saved.";
    await Promise.all([refreshGmail(), refreshCalendar(), refreshGoogleAccounts()]);
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
    } else if (!gmail.configured) {
      gmailStatusText.textContent = "Add Google OAuth credentials on the server to enable Gmail.";
    } else if (!gmail.accountCount) {
      gmailStatusText.textContent = "Connect a Google account to import calendars and email notes.";
    } else {
      const count = `${gmail.accountCount} account${gmail.accountCount === 1 ? "" : "s"} connected`;
      gmailStatusText.textContent = gmail.recipient
        ? `${count}. Notes go to ${gmail.recipient}.`
        : `${count}.`;
    }
    gmailConnect.textContent = gmail.accountCount ? "Connect another" : "Connect account";
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
      // Name the account: "reconnect Google" is not actionable once several are connected.
      const which = (calendar.reconnectAccounts || []).join(", ");
      calendarStatusText.textContent = which
        ? `${which} needs reconnecting before its calendar can sync again.`
        : `Google access expired — reconnect to resume calendar sync.${calendar.lastSyncError ? ` (${calendar.lastSyncError})` : ""}`;
    } else if (!calendar.connected) {
      calendarStatusText.textContent = calendar.googleConnected
        ? "Turn on \u201cImport calendar\u201d for an account above to import its meetings."
        : "Connect a Google account to import your meetings.";
    } else {
      const lastSync = calendar.lastSync ? `Last sync ${formatDayTime(calendar.lastSync)}.` : "";
      const syncing = calendar.syncingAccounts || [];
      const which = syncing.length > 1 ? `${syncing.length} calendars importing` : "Calendar import is on";
      calendarStatusText.textContent = `${which}. ${lastSync}`.trim();
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

// `sending` reflects a send actually in flight from inside the compose dialog (see
// submitCompose), not the dialog merely being open — opening it makes no network call.
function emailButtonLabel(meeting, sending) {
  return sending ? "Sending…" : "Compose & send";
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

function splitEmails(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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

// Milliseconds to a timecode, growing an hours field only when there are hours. Clip
// bounds get a decimal because a tenth of a second is the difference between catching
// the start of a sentence and cutting into it.
function formatTimecode(ms, decimals = 0) {
  const total = Math.max(0, Number(ms) || 0) / 1000;
  const hours = Math.floor(total / 3600);
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const rest = total % 60;
  const seconds = (decimals ? rest.toFixed(decimals) : String(Math.floor(rest))).padStart(decimals ? decimals + 3 : 2, "0");
  return hours ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
}

// Accepts "90", "1:30", "1:30.5" and "1:02:03" — clip bounds are typed by hand, and
// every one of those is unambiguously what the person meant. Returns null rather than
// NaN or 0, so "unparseable" cannot be mistaken for "the start of the recording".
function parseClockInput(value) {
  const parts = String(value ?? "").trim().split(":");
  if (parts.length > 3) return null;
  let seconds = 0;
  for (const part of parts) {
    if (!/^\d+(\.\d+)?$/u.test(part)) return null;
    seconds = seconds * 60 + Number(part);
  }
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled >= 10 ? Math.round(scaled) : scaled.toFixed(1)} ${units[unit]}`;
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
