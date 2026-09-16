/**
 * Central config for the dP Relay v5 server.
 * All environment-specific values come from env vars — nothing hardcoded here.
 * Fails fast on missing/invalid values (see docs/Plan/11-ENV-VARS.md).
 */

/** Secrets below this length are brute-forceable; policy constant, not env-tunable. */
const MIN_SECRET_LENGTH = 32;

export interface Config {
  port: number;
  host: string;
  logLevel: string;
  dbPath: string;

  /** HS256 signing secret for access-token JWTs. Required, min 32 chars. */
  jwtSecret: string;
  /** Access-token lifetime in seconds (JWT `exp`). */
  accessTokenTtlSec: number;
  /** Refresh-token lifetime in seconds (refresh_tokens.expires_at). */
  refreshTokenTtlSec: number;

  /** Devices with last_seen_at older than this are reported by the watchdog job. */
  watchdogStaleSec: number;
  /** How often the watchdog runs (node-cron pattern). */
  watchdogCron: string;
  /** How often the catch-up sweep runs (node-cron pattern). */
  catchUpCron: string;
  /** Webhook endpoint that receives watchdog alerts; empty = log-only. */
  alertWebhookUrl: string;
  /** Shared secret sent as `Authorization: Bearer` on watchdog webhook alerts. */
  alertWebhookSecret: string;
  /** Idle seconds after which the next request counts as a wake (Render guard). */
  wakeIdleThresholdSec: number;
  /** Shared secret for phone enrollment (POST /v5/device/enroll). Empty = enrollment disabled. */
  deviceEnrollmentSecret: string;
  /** Claimed pending_sms older than this are re-offered to the next fetch (at-least-once). */
  outstandingRequeueSec: number;
  /** Max enrollment attempts per client IP inside the sliding window (brute-force guard). */
  enrollRateMaxPerHour: number;
  /** Sliding window for the enrollment rate limiter, in seconds. */
  enrollRateWindowSec: number;
  /** OTP session lifetime, in seconds. */
  otpTtlSec: number;
  /** Failed verify attempts before an OTP session locks. */
  otpMaxAttempts: number;
  /** Lockout duration after hitting otpMaxAttempts, in seconds. */
  otpLockoutSec: number;
  /** Firebase service-account JSON (stringified) — FCM wake sender only. Empty = wake disabled. */
  fcmServiceAccountJson: string;
  /** Per-attempt timeout for webhook dispatch POSTs, in ms. */
  webhookTimeoutMs: number;
  /** Comma-separated backoff delays (ms) between webhook retry attempts. */
  webhookRetryDelaysMs: string;
}

/**
 * Parses a positive integer env value; returns fallback when unset, throws when
 * malformed. PORT may legitimately be 0 (ephemeral port, used by tests). Other
 * knobs have no zero-meaning and stay strictly positive.
 */
function parsePositiveInt(
  value: string | undefined,
  name: string,
  fallback: number,
  allowZero = false,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  const min = allowZero ? 0 : 1;
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(
      `Invalid env var ${name}: must be a positive integer${allowZero ? " or 0" : ""}, got "${value}"`,
    );
  }
  return parsed;
}

/** Reads a required secret env var and enforces the minimum length policy. */
function requireSecret(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length < MIN_SECRET_LENGTH) {
    throw new Error(
      `Missing/short env var ${name}: required, min ${MIN_SECRET_LENGTH} chars ` +
        `(generate with: openssl rand -base64 32)`,
    );
  }
  return value;
}

/**
 * Loads config from the given env. Throws on any missing/invalid required value —
 * per docs/Plan/11-ENV-VARS.md the server must fail fast rather than boot with defaults.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: parsePositiveInt(env.PORT, "PORT", 3000, true),
    host: env.HOST ?? "0.0.0.0",
    logLevel: env.LOG_LEVEL ?? "info",
    dbPath: env.DB_PATH ?? "./data/dprelay.db",

    jwtSecret: requireSecret(env.JWT_SECRET, "JWT_SECRET"),
    accessTokenTtlSec: parsePositiveInt(env.JWT_ACCESS_TTL_SEC, "JWT_ACCESS_TTL_SEC", 900),
    refreshTokenTtlSec: parsePositiveInt(
      env.JWT_REFRESH_TTL_SEC,
      "JWT_REFRESH_TTL_SEC",
      30 * 24 * 60 * 60,
    ),

    watchdogStaleSec: parsePositiveInt(env.WATCHDOG_STALE_SEC, "WATCHDOG_STALE_SEC", 900),
    watchdogCron: env.WATCHDOG_CRON ?? "*/5 * * * *",
    catchUpCron: env.CATCH_UP_CRON ?? "*/10 * * * *",
    alertWebhookUrl: env.ALERT_WEBHOOK_URL ?? "",
    alertWebhookSecret: env.ALERT_WEBHOOK_SECRET ?? "",
    wakeIdleThresholdSec: parsePositiveInt(
      env.WAKE_IDLE_THRESHOLD_SEC,
      "WAKE_IDLE_THRESHOLD_SEC",
      15 * 60,
    ),
    deviceEnrollmentSecret: env.DEVICE_ENROLLMENT_SECRET ?? "",
    outstandingRequeueSec: parsePositiveInt(
      env.OUTSTANDING_REQUEUE_SEC,
      "OUTSTANDING_REQUEUE_SEC",
      120,
    ),
    enrollRateMaxPerHour: parsePositiveInt(env.ENROLL_RATE_MAX_PER_HOUR, "ENROLL_RATE_MAX_PER_HOUR", 10),
    enrollRateWindowSec: parsePositiveInt(env.ENROLL_RATE_WINDOW_SEC, "ENROLL_RATE_WINDOW_SEC", 3600),
    otpTtlSec: parsePositiveInt(env.OTP_TTL_SEC, "OTP_TTL_SEC", 300),
    otpMaxAttempts: parsePositiveInt(env.OTP_MAX_ATTEMPTS, "OTP_MAX_ATTEMPTS", 5),
    otpLockoutSec: parsePositiveInt(env.OTP_LOCKOUT_SEC, "OTP_LOCKOUT_SEC", 900),
    fcmServiceAccountJson: env.FCM_SERVICE_ACCOUNT_JSON ?? "",
    webhookTimeoutMs: parsePositiveInt(env.WEBHOOK_TIMEOUT_MS, "WEBHOOK_TIMEOUT_MS", 5_000),
    webhookRetryDelaysMs: env.WEBHOOK_RETRY_DELAYS_MS ?? "30000,120000",
  };
}
