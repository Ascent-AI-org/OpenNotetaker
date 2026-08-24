// Who receives what when a meeting finishes.
//
// Two different mailings, deliberately kept apart:
//
//   Transcript — the full record. Goes to the meeting owner's connected Google accounts
//   and any addresses they configured. These are all inboxes the owner controls.
//
//   Action items — the short "here's what you committed to" list. Goes to an explicitly
//   curated list. Calendar attendees are *never* added automatically, even though their
//   addresses are on the invite and we store them: a meeting with a client, a candidate,
//   or a vendor on it would otherwise mail them internal notes with no one having
//   decided to. Attendees are offered in the UI as one-click suggestions instead, so
//   reaching everyone stays easy but stays a choice.
//
// Everything here is pure so the "who gets mail" decision is testable without sending
// any, which is the one mistake in this area you cannot take back.

import { noteRecipientEmails } from "./google-accounts.js";

export const MAX_RECIPIENTS = 25;

/**
 * Addresses for the full transcript: the owner's own inboxes.
 *
 * Falls back to the account's login address so a user who has configured nothing still
 * receives their own notes.
 */
export function transcriptRecipients({ owner, accounts = [] }) {
  const configured = sanitizeEmails(owner?.settings?.transcriptRecipients);
  const connected = owner?.settings?.emailConnectedAccounts === false ? [] : noteRecipientEmails(accounts);
  const recipients = dedupe([...configured, ...connected]);
  if (recipients.length) return recipients.slice(0, MAX_RECIPIENTS);
  return owner?.email ? [normalize(owner.email)] : [];
}

/**
 * Addresses for the action-item summary.
 *
 * The per-meeting list is the authority when it has been set — that is the "only people
 * I list" contract, and an empty list set on a meeting means "send this one to nobody"
 * rather than "fall back to the defaults".
 */
export function actionItemRecipients({ owner, accounts = [], meeting }) {
  const perMeeting = meeting?.delivery?.actionItemsEmail?.recipients;
  if (Array.isArray(perMeeting)) return sanitizeEmails(perMeeting).slice(0, MAX_RECIPIENTS);

  const configured = sanitizeEmails(owner?.settings?.actionItemRecipients);
  const connected = owner?.settings?.actionItemsToConnectedAccounts === false ? [] : noteRecipientEmails(accounts);
  return dedupe([...configured, ...connected]).slice(0, MAX_RECIPIENTS);
}

/**
 * Calendar attendees we could offer as recipients, minus the ones already receiving the
 * mail. Suggestions only — nothing here is sent to without an explicit choice.
 *
 * `external` marks addresses outside every domain the owner is connected with, so the UI
 * can make "this person is not from your company" impossible to miss.
 */
export function attendeeSuggestions({ meeting, owner, accounts = [], currentRecipients = [] }) {
  const attendees = Array.isArray(meeting?.source?.googleCalendar?.attendees)
    ? meeting.source.googleCalendar.attendees
    : [];
  const already = new Set(sanitizeEmails(currentRecipients));
  const domains = ownDomains({ owner, accounts });

  const seen = new Set();
  const suggestions = [];
  for (const attendee of attendees) {
    const email = normalize(attendee?.email);
    if (!email || !isEmail(email) || already.has(email) || seen.has(email)) continue;
    seen.add(email);
    suggestions.push({
      email,
      name: String(attendee?.name || "").slice(0, 120),
      responseStatus: String(attendee?.responseStatus || ""),
      organizer: Boolean(attendee?.organizer),
      external: !domains.has(domainOf(email))
    });
  }
  return suggestions;
}

/** Every domain the owner demonstrably belongs to, used only to label suggestions. */
export function ownDomains({ owner, accounts = [] }) {
  const emails = [owner?.email, ...accounts.map((account) => account.email)];
  return new Set(emails.map((email) => domainOf(normalize(email))).filter(Boolean));
}

/**
 * Validate a client-supplied recipient list. Returns `{ok:false, error}` rather than
 * throwing so the route can answer 400 with something a person can act on.
 */
export function parseRecipientList(value, { allowEmpty = true } = {}) {
  if (!Array.isArray(value)) return { ok: false, error: "Recipients must be an array of email addresses." };
  if (value.length > MAX_RECIPIENTS) {
    return { ok: false, error: `Send to at most ${MAX_RECIPIENTS} recipients.` };
  }
  const invalid = value.filter((item) => typeof item !== "string" || !isEmail(normalize(item)));
  if (invalid.length) {
    return { ok: false, error: `Not a valid email address: ${String(invalid[0]).slice(0, 80)}` };
  }
  const recipients = dedupe(value.map(normalize));
  if (!allowEmpty && !recipients.length) return { ok: false, error: "Add at least one recipient." };
  return { ok: true, value: recipients };
}

function sanitizeEmails(value) {
  if (!Array.isArray(value)) return [];
  return dedupe(value.map(normalize).filter(isEmail));
}

function dedupe(emails) {
  return [...new Set(emails)];
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function isEmail(value) {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(value);
}

function domainOf(email) {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1);
}
