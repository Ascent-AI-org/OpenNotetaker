import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const loadedEnv = new Set();

export function loadDotEnv(cwd = process.cwd()) {
  const envPath = resolve(cwd, ".env");
  if (!existsSync(envPath)) return;

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
      loadedEnv.add(key);
    }
  }
}

export function readConfig() {
  loadDotEnv();

  const port = Number.parseInt(process.env.PORT || "5173", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }

  const host = process.env.HOST || "127.0.0.1";
  const baseUrl = process.env.OPENNOTETAKER_BASE_URL || `http://${host}:${port}`;
  const transcriptRecipients = sanitizeEmailList(process.env.TRANSCRIPT_EMAIL_TO || "");
  const transcriptSender = sanitizeEmail(process.env.TRANSCRIPT_EMAIL_FROM || transcriptRecipients[0] || "");

  return {
    rootDir: process.cwd(),
    server: {
      host,
      port
    },
    auth: {
      allowSignups: parseBoolean(process.env.AUTH_ALLOW_SIGNUPS, true),
      sessionTtlDays: parsePositiveInt(process.env.AUTH_SESSION_TTL_DAYS, 14),
      // Secure cookies require TLS; default on when the public base URL is https.
      secureCookies: parseBoolean(process.env.AUTH_SECURE_COOKIES, baseUrl.startsWith("https://"))
    },
    bot: {
      provider: process.env.BOT_PROVIDER || "demo"
    },
    runner: {
      token: process.env.RUNNER_TOKEN || "",
      baseUrl,
      // Fleet mode: how long a worker's claim stays valid without a renewing API call,
      // and how often the server sweeps for expired leases.
      leaseSeconds: parsePositiveInt(process.env.RUNNER_LEASE_SECONDS, 120),
      scriptPath: process.env.BOT_RUNNER_SCRIPT || resolve(process.cwd(), "src", "bot-runner", "runner.js"),
      displayName: process.env.BOT_DISPLAY_NAME || "OpenNotetaker - Recording",
      chromeChannel: process.env.BOT_CHROME_CHANNEL || "chrome",
      chromeExecutablePath: process.env.BOT_CHROME_EXECUTABLE_PATH || "",
      chromeUserDataDir: process.env.BOT_CHROME_USER_DATA_DIR || resolve(process.cwd(), ".bot-profile"),
      chromeLaunchMode: process.env.BOT_CHROME_LAUNCH_MODE || "rawcdp",
      chromeExtraArgs: splitArgs(process.env.BOT_CHROME_EXTRA_ARGS || ""),
      headless: parseBoolean(process.env.BOT_HEADLESS, false),
      maxDurationMinutes: parsePositiveInt(process.env.BOT_MAX_DURATION_MINUTES, 120),
      aloneTimeoutSeconds: parsePositiveInt(process.env.BOT_ALONE_TIMEOUT_SECONDS, 45),
      ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
      audioCaptureDriver: process.env.AUDIO_CAPTURE_DRIVER || "pulse",
      audioCaptureSource: process.env.AUDIO_CAPTURE_SOURCE || "default"
    },
    stt: {
      provider: process.env.STT_PROVIDER || "deepgram",
      deepgram: {
        apiKey: process.env.DEEPGRAM_API_KEY || "",
        model: process.env.DEEPGRAM_MODEL || "nova-3",
        language: process.env.DEEPGRAM_LANGUAGE || "multi",
        keyterms: splitList(process.env.DEEPGRAM_KEYTERMS || ""),
        extraParams: parseQueryParams(process.env.DEEPGRAM_EXTRA_PARAMS || "")
      }
    },
    llm: {
      provider: process.env.LLM_PROVIDER || "mock",
      openai: {
        apiKey: process.env.OPENAI_API_KEY || "",
        model: process.env.OPENAI_MODEL || "gpt-5.4-mini"
      },
      gemini: {
        apiKey: process.env.GEMINI_API_KEY || "",
        model: process.env.GEMINI_MODEL || "gemini-3-flash-preview",
        normalizeChunkSize: parsePositiveInt(process.env.GEMINI_NORMALIZE_CHUNK_SIZE, 18),
        reconstructChunkSize: parsePositiveInt(process.env.GEMINI_RECONSTRUCT_CHUNK_SIZE, 48),
        notesChunkSize: parsePositiveInt(process.env.GEMINI_NOTES_CHUNK_SIZE, 200),
        requestTimeoutMs: parsePositiveInt(process.env.GEMINI_REQUEST_TIMEOUT_MS, 90_000),
        maxRetries: parseNonNegativeInt(process.env.GEMINI_MAX_RETRIES, 2)
      }
    },
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
      redirectUri: process.env.GOOGLE_REDIRECT_URI || `${baseUrl}/api/gmail/oauth/callback`,
      gmailTokenPath: resolve(process.cwd(), process.env.GOOGLE_GMAIL_TOKEN_PATH || "data/google-gmail-token.json"),
      // Multi-user: one Google OAuth token file per user lives in this directory.
      tokenDir: resolve(process.cwd(), process.env.GOOGLE_TOKEN_DIR || "data/google-tokens"),
      calendar: {
        enabled: parseBoolean(process.env.GOOGLE_CALENDAR_SYNC_ENABLED, false),
        autoStart: parseBoolean(process.env.GOOGLE_CALENDAR_AUTOSTART_ENABLED, false),
        calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
        pollSeconds: parsePositiveInt(process.env.GOOGLE_CALENDAR_POLL_SECONDS, 60),
        lookaheadMinutes: parsePositiveInt(process.env.GOOGLE_CALENDAR_LOOKAHEAD_MINUTES, 120),
        autoStartLeadMinutes: parsePositiveInt(process.env.GOOGLE_CALENDAR_AUTOSTART_LEAD_MINUTES, 2),
        autoStartLateMinutes: parsePositiveInt(process.env.GOOGLE_CALENDAR_AUTOSTART_LATE_MINUTES, 30),
        retentionDays: parsePositiveInt(process.env.GOOGLE_CALENDAR_RETENTION_DAYS, 30)
      }
    },
    email: {
      transcript: {
        enabled: parseBoolean(process.env.TRANSCRIPT_EMAIL_ENABLED, false),
        recipient: transcriptRecipients[0] || "",
        recipients: transcriptRecipients,
        from: transcriptSender
      }
    }
  };
}

export function assertProviderSecrets(config) {
  if (config.llm.provider === "openai" && !config.llm.openai.apiKey) {
    throw new Error("OPENAI_API_KEY is required when LLM_PROVIDER=openai.");
  }
  if (config.llm.provider === "gemini" && !config.llm.gemini.apiKey) {
    throw new Error("GEMINI_API_KEY is required when LLM_PROVIDER=gemini.");
  }
  if (["external", "fleet"].includes(config.bot.provider) && !config.runner.token) {
    throw new Error(`RUNNER_TOKEN is required when BOT_PROVIDER=${config.bot.provider}.`);
  }
  if (
    config.stt.provider === "deepgram" &&
    !["demo", "fleet"].includes(config.bot.provider) &&
    !config.stt.deepgram.apiKey
  ) {
    // Fleet workers hold their own DEEPGRAM_API_KEY; the web server does not need it.
    throw new Error("DEEPGRAM_API_KEY is required for non-demo Deepgram transcription.");
  }
  if (config.email.transcript.enabled) {
    if (!config.email.transcript.recipients.length) {
      throw new Error("TRANSCRIPT_EMAIL_TO must include at least one valid email when TRANSCRIPT_EMAIL_ENABLED=true.");
    }
    if (!config.google.clientId || !config.google.clientSecret) {
      throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required when TRANSCRIPT_EMAIL_ENABLED=true.");
    }
  }
  if (config.google.calendar.enabled || config.google.calendar.autoStart) {
    if (!config.google.clientId || !config.google.clientSecret) {
      throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required when Google Calendar sync is enabled.");
    }
  }
}

export function loadedEnvKeys() {
  return [...loadedEnv];
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function splitArgs(value) {
  return String(value)
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitList(value) {
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseQueryParams(value) {
  const params = new URLSearchParams(String(value).replace(/^\?/, ""));
  const parsed = {};
  for (const [key, item] of params) {
    if (!key || item === "") continue;
    if (parsed[key]) {
      parsed[key] = Array.isArray(parsed[key]) ? [...parsed[key], item] : [parsed[key], item];
    } else {
      parsed[key] = item;
    }
  }
  return parsed;
}

function sanitizeEmail(value) {
  const email = String(value || "").replace(/[\r\n]+/g, " ").trim();
  if (!email) return "";
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(email) ? email : "";
}

function sanitizeEmailList(value) {
  const seen = new Set();
  const emails = [];
  for (const item of String(value || "").split(",")) {
    const email = sanitizeEmail(item);
    const key = email.toLowerCase();
    if (!email || seen.has(key)) continue;
    seen.add(key);
    emails.push(email);
  }
  return emails;
}
