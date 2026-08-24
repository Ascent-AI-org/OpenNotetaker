// One OpenNotetaker account can hold several connected Google accounts — a founder with
// sanya@company.com and sanya@side-project.com, or a shared instance where one person
// watches two calendars. Each connection is a separate OAuth grant with its own token
// file, its own calendar, and its own ability to send mail.
//
// This module is the pure bookkeeping for that list: the HTTP layer supplies the user
// record and the OAuth result, so every decision here is unit-testable. Token files
// themselves live on disk and are handled by src/providers/gmail.js.

import { GMAIL_SEND_SCOPE, CALENDAR_READONLY_SCOPE } from "../providers/gmail.js";

// A ceiling rather than a considered limit: each connected account costs a calendar poll
// every sync, so an unbounded list quietly multiplies Google API traffic.
export const MAX_GOOGLE_ACCOUNTS = 10;

const DEFAULT_ACCOUNT_SETTINGS = {
  calendarSyncEnabled: true,
  calendarAutoStart: false,
  receivesNotes: true
};

/** Normalized list of a user's connected Google accounts. Always an array. */
export function listGoogleAccounts(user) {
  const accounts = Array.isArray(user?.googleAccounts) ? user.googleAccounts : [];
  return accounts.filter((account) => account?.id).map(normalizeAccount);
}

export function findGoogleAccount(user, accountId) {
  return listGoogleAccounts(user).find((account) => account.id === accountId) || null;
}

/**
 * Which account a reconnect belongs to. Google's `sub` is the stable identifier — an
 * address can be renamed, and matching on email alone would strand the old token file
 * and silently create a duplicate connection.
 */
export function matchGoogleAccount(accounts, { googleSub, email }) {
  const sub = String(googleSub || "").trim();
  const address = normalizeEmail(email);
  return (
    accounts.find((account) => sub && account.googleSub === sub) ||
    accounts.find((account) => address && account.email === address) ||
    null
  );
}

/**
 * Add a new connection or refresh an existing one, returning a new array.
 *
 * Reconnecting must not reset the account's own settings: someone who turned calendar
 * sync off for a personal address and then re-granted access to fix an expired token
 * would otherwise find their calendar quietly importing again.
 */
export function upsertGoogleAccount(accounts, entry, { now = new Date().toISOString() } = {}) {
  const existing = matchGoogleAccount(accounts, entry);
  if (existing) {
    return accounts.map((account) =>
      account.id === existing.id
        ? normalizeAccount({
            ...account,
            email: normalizeEmail(entry.email) || account.email,
            name: entry.name ?? account.name,
            googleSub: entry.googleSub || account.googleSub,
            scopes: entry.scopes || account.scopes,
            reconnectedAt: now
          })
        : account
    );
  }

  if (accounts.length >= MAX_GOOGLE_ACCOUNTS) {
    throw new Error(`Connect at most ${MAX_GOOGLE_ACCOUNTS} Google accounts.`);
  }

  return [
    ...accounts,
    normalizeAccount({
      ...DEFAULT_ACCOUNT_SETTINGS,
      id: entry.id,
      email: normalizeEmail(entry.email),
      name: entry.name || "",
      googleSub: String(entry.googleSub || ""),
      scopes: entry.scopes || [],
      connectedAt: now,
      reconnectedAt: now,
      // The first account connected is the one mail sends from unless a meeting points
      // somewhere more specific.
      isDefault: accounts.length === 0
    })
  ];
}

export function updateGoogleAccount(accounts, accountId, patch) {
  return accounts.map((account) =>
    account.id === accountId ? normalizeAccount({ ...account, ...sanitizeSettings(patch) }) : account
  );
}

/**
 * Remove a connection. If it was the default, promote another one — leaving no default
 * would strand outgoing mail with nothing to send from.
 */
export function removeGoogleAccount(accounts, accountId) {
  const remaining = accounts.filter((account) => account.id !== accountId);
  if (remaining.length && !remaining.some((account) => account.isDefault)) {
    return remaining.map((account, index) => normalizeAccount({ ...account, isDefault: index === 0 }));
  }
  return remaining;
}

export function setDefaultGoogleAccount(accounts, accountId) {
  if (!accounts.some((account) => account.id === accountId)) return accounts;
  return accounts.map((account) => normalizeAccount({ ...account, isDefault: account.id === accountId }));
}

/**
 * The account a message should be sent from.
 *
 * Preference order: the account explicitly asked for (normally the one whose calendar
 * the meeting came from, so replies land in the right inbox), then the default, then any
 * account that can actually send. Accounts without gmail.send are skipped rather than
 * attempted — a grant that never included the scope will not start working on retry.
 */
export function pickSendingAccount(accounts, { preferAccountIds = [] } = {}) {
  const senders = accounts.filter((account) => account.scopes.includes(GMAIL_SEND_SCOPE));
  if (!senders.length) return null;
  for (const accountId of preferAccountIds) {
    const match = senders.find((account) => account.id === accountId);
    if (match) return match;
  }
  return senders.find((account) => account.isDefault) || senders[0];
}

/** Accounts whose calendar should be polled. */
export function calendarSyncAccounts(accounts) {
  return accounts.filter(
    (account) => account.calendarSyncEnabled && account.scopes.includes(CALENDAR_READONLY_SCOPE)
  );
}

/**
 * The addresses that receive a copy of a meeting's notes by virtue of being connected.
 * Opt-out is per account (`receivesNotes`), so connecting a calendar you only want to
 * watch does not also sign that inbox up for every transcript.
 */
export function noteRecipientEmails(accounts) {
  return unique(accounts.filter((account) => account.receivesNotes && account.email).map((account) => account.email));
}

/** Safe to hand to the browser: no tokens are stored on the account record, but be explicit. */
export function publicGoogleAccount(account) {
  return {
    id: account.id,
    email: account.email,
    name: account.name,
    isDefault: account.isDefault,
    calendarSyncEnabled: account.calendarSyncEnabled,
    calendarAutoStart: account.calendarAutoStart,
    receivesNotes: account.receivesNotes,
    canSendMail: account.scopes.includes(GMAIL_SEND_SCOPE),
    canReadCalendar: account.scopes.includes(CALENDAR_READONLY_SCOPE),
    connectedAt: account.connectedAt,
    reconnectedAt: account.reconnectedAt
  };
}

function normalizeAccount(account) {
  return {
    id: String(account.id),
    email: normalizeEmail(account.email),
    name: String(account.name || "").slice(0, 120),
    googleSub: String(account.googleSub || ""),
    scopes: Array.isArray(account.scopes) ? account.scopes.filter((scope) => typeof scope === "string") : [],
    connectedAt: account.connectedAt || null,
    reconnectedAt: account.reconnectedAt || null,
    isDefault: Boolean(account.isDefault),
    calendarSyncEnabled: toBoolean(account.calendarSyncEnabled, DEFAULT_ACCOUNT_SETTINGS.calendarSyncEnabled),
    calendarAutoStart: toBoolean(account.calendarAutoStart, DEFAULT_ACCOUNT_SETTINGS.calendarAutoStart),
    receivesNotes: toBoolean(account.receivesNotes, DEFAULT_ACCOUNT_SETTINGS.receivesNotes)
  };
}

// Only the per-account switches are patchable from the client; email, scopes, and the
// Google identity are derived from the OAuth grant and must never be client-settable.
function sanitizeSettings(patch) {
  const settings = {};
  for (const key of ["calendarSyncEnabled", "calendarAutoStart", "receivesNotes"]) {
    if (typeof patch?.[key] === "boolean") settings[key] = patch[key];
  }
  return settings;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function toBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function unique(values) {
  return [...new Set(values)];
}
