import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

// scrypt is built into Node and memory-hard; parameters are stored alongside each hash
// so they can be raised later without invalidating existing passwords.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

export const SESSION_COOKIE_NAME = "opennotetaker_session";

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(String(password), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P
  });
  return ["scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString("base64"), derived.toString("base64")].join("$");
}

export async function verifyPassword(password, stored) {
  try {
    const [scheme, nRaw, rRaw, pRaw, saltRaw, hashRaw] = String(stored || "").split("$");
    if (scheme !== "scrypt") return false;
    const salt = Buffer.from(saltRaw, "base64");
    const expected = Buffer.from(hashRaw, "base64");
    if (!salt.length || !expected.length) return false;
    const derived = await scrypt(String(password), salt, expected.length, {
      N: Number(nRaw),
      r: Number(rRaw),
      p: Number(pRaw)
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    // Malformed hash or bad parameters: fail closed.
    return false;
  }
}

// Used to equalize login timing when the email does not exist: verifying against this
// hash costs the same scrypt work as a real password check.
export const DUMMY_PASSWORD_HASH_PROMISE = hashPassword(randomUUID());

export function generateSessionToken() {
  return randomBytes(32).toString("base64url");
}

// Only the SHA-256 of the session token is stored; a leaked store file does not yield
// usable session cookies.
export function hashSessionToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

export function validateEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!email || email.length > 254) return "";
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(email) ? email : "";
}

export function validatePassword(value) {
  const password = typeof value === "string" ? value : "";
  if (password.length < 8) return { ok: false, error: "Use a password of at least 8 characters." };
  if (password.length > 200) return { ok: false, error: "Use a password of at most 200 characters." };
  return { ok: true };
}

export function validateName(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 80);
}

export function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) cookies[key] = decodeURIComponentSafe(value);
  }
  return cookies;
}

export function buildSessionCookie(token, { maxAgeSeconds, secure }) {
  return [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    secure ? "Secure" : ""
  ]
    .filter(Boolean)
    .join("; ");
}

export function buildClearSessionCookie({ secure }) {
  return buildSessionCookie("", { maxAgeSeconds: 0, secure });
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
