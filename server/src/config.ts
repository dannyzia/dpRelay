/**
 * Central config for the dP Relay v5 server.
 * All environment-specific values come from env vars — nothing hardcoded here.
 * Fails fast on missing/invalid values (see docs/Plan/11-ENV-VARS.md).
 */

/** Secrets below this length are brute-forceable; policy constant, not env-tunable. */
export const MIN_SECRET_LENGTH = 32;

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
  /** Telegram Bot API token; with telegramChatId, the preferred alert sink. */
  telegramBotToken: string;
  /** Telegram chat id receiving alerts; only used when telegramBotToken is set. */
  telegramChatId: string;
  /**
   * Consecutive failures of ONE alert sink before it is reported degraded via
   * the `alert_sink_degraded` log event. Keeps a dead receiver from looking
   * identical to a healthy one in the log stream.
   */
  alertSinkFailureThreshold: number;
  /**
   * Re-alert interval for an UNCHANGED stale-device set. Without it, dedupe
   * would mean "alert once then never again", so a device dead for a month
   * would be announced once and forgotten.
   */
  watchdogAlertRepeatSec: number;
  /**
   * Consecutive FCM wake failures before an operator alert fires — for the
   * transient and token classes. A credential-class failure ignores this and
   * alerts immediately, because a revoked key does not fix itself on retry.
   * The wake runs on every OTP send, so without a threshold a single network
   * blip would page someone.
   */
  fcmWakeAlertThreshold: number;
  /**
   * Re-alert interval while FCM wake keeps failing. Without it, a credential
   * broken at 03:00 is announced once and then never again, which is the same
   * silence in slower motion.
   */
  fcmWakeAlertRepeatSec: number;
  /**
   * Age (seconds since creation) after which a device that has NEVER
   * heartbeaten is silently quarantined. Quarantine hides it from the stale set
   * and from alerting without revoking it, so a phone that was merely never
   * brought online stops generating alerts but keeps working, and any heartbeat
   * clears the quarantine. Revoking would be irreversible.
   */
  deviceQuarantineSec: number;
  /** Idle seconds after which the next request counts as a wake (Render guard). */
  wakeIdleThresholdSec: number;
  /** Shared secret for phone enrollment (POST /v5/device/enroll). Empty = enrollment disabled. */
  deviceEnrollmentSecret: string;
  /** Shared secret for operator app provisioning (POST /v5/apps/register). Empty = provisioning disabled. */
  appProvisioningSecret: string;
  /** Max provisioning attempts per client IP inside the sliding window (brute-force guard). */
  appProvisioningRateMaxPerHour: number;
  /** Sliding window for the provisioning rate limiter, in seconds. */
  appProvisioningRateWindowSec: number;
  /**
   * Dashboard session-cookie lifetime in seconds (STAGE F3 customer auth).
   * Applies to the HttpOnly `dp_session` cookie set by register/login; logout
   * deletes the row immediately, so this is the maximum exposure of a stolen
   * cookie that was never logged out.
   */
  sessionTtlSec: number;
  /**
   * Max customer-auth attempts (register/login/link) per client IP inside the
   * sliding window — brute-force guard for the shared email+password surface.
   */
  authRateMaxPerHour: number;
  /** Sliding window for the customer-auth rate limiter, in seconds. */
  authRateWindowSec: number;
  /**
   * STAGE F3 amendment (ISSUE-82): TTL for email-verification tokens, in
   * seconds (default 24h). SMTP itself is operator-configured in the DB —
   * deliberately NOT an env var (owner decision, hub event 1210).
   */
  emailVerifyTtlSec: number;
  /** TTL for password-reset tokens, in seconds (default 30min — short by design). */
  emailResetTtlSec: number;
  /**
   * Base URL of the customer dashboard used to build emailed verification/
   * reset links (e.g. https://dprelay-dashboard.onrender.com). Empty = emails
   * degrade to no-link instructions (feature disables cleanly, ordered).
   */
  dashboardBaseUrl: string;
  /**
   * One-time trial credits granted atomically with each successful
   * POST /v5/apps/register (ISSUE-77). 0 = trial disabled (no grant, no
   * app_credits row — a fresh app fails closed on send exactly as before).
   */
  trialSmsCount: number;
  /** Days until granted trial credits expire (both buckets), from registration. */
  trialSmsTtlDays: number;
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
  /**
   * Consecutive exhausted webhook dispatches per app before the watchdog alert
   * channel fires. Any successful delivery resets the count. 1 = alert on first.
   */
  webhookExhaustionAlertThreshold: number;
  /**
   * Minimum seconds between webhook-exhaustion alerts for the SAME app (dead-
   * receiver damping). Default 900 ⇒ at most 4 re-alerts per hour per dead
   * receiver (the handoff's stated default) while it stays dead; any
   * successful delivery re-arms instantly.
   */
  webhookExhaustionDampingSec: number;
  /** Shared secret for operator/admin routes (requireOperator). Empty = admin routes disabled. */
  operatorSecret: string;
  /** bKash destination shown to customers on credit request. Empty = requests fail fast. */
  bkashPersonalNumber: string;

  /** Bulk campaigns master switch (v4 config/bulk_enabled parity). Default off. */
  bulkEnabled: boolean;
  /** How often the bulk queue tick runs (node-cron pattern). */
  bulkQueueCron: string;
  /** Max recipients enqueued per minute across all active campaigns. */
  bulkSmsRatePerMinute: number;
  /** Global backpressure: skip enqueueing when this many bulk rows are pending/claimed. */
  bulkMaxPendingQueue: number;
  /** Failed-delivery attempts per recipient before it counts as terminal failure. */
  bulkRetryMaxAttempts: number;
  /** Max recipients per campaign. */
  bulkPerCampaignLimit: number;
  /** Max recipients an app may create campaigns for per UTC day. */
  bulkDailyAppLimit: number;
  /** Message length cap for GSM-7 charset. */
  bulkMaxCharsGsm: number;
  /** Message length cap for UCS-2 charset. */
  bulkMaxCharsUcs2: number;
  /** Seconds after a confirmed bulk delivery before the same phone gets another. */
  bulkPostSendCooldownSec: number;
  /** Minimum seconds between OTP sends to the SAME phone per app (resend cooldown). */
  otpResendCooldownSec: number;
  /**
   * Comma-separated list of dashboard origins allowed by CORS. Empty = no
   * cross-origin browser access (API-only deployments, curl/mobile clients
   * are unaffected by CORS either way). Example:
   * https://dprelay-dashboard.pages.dev,http://localhost:5173
   */
  corsAllowedOrigins: string;
  /** How often the aggregate-stats snapshot refreshes (node-cron pattern). */
  statsCron: string;
  /**
   * Daily synthetic alert canary. OFF by default: it sends a real message into
   * the real ops channel, and a deployment must opt in to that rather than
   * discover it after a deploy. With the Telegram sink unconfigured the canary
   * is inert regardless.
   */
  alertCanaryEnabled: boolean;
  /** How often the canary runs (node-cron pattern). Daily by default. */
  alertCanaryCron: string;
  /**
   * Age of the last delivery receipt beyond which the canary reports itself
   * overdue. Default 26h = one daily run plus slack, so a single missed run is
   * tolerated and two is a real signal.
   */
  alertCanaryMaxAgeSec: number;
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

/** Parses a boolean env value; returns fallback when unset, throws when malformed. */
function parseBoolean(value: string | undefined, name: string, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw new Error(`Invalid env var ${name}: must be true or false, got "${value}"`);
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
    alertCanaryEnabled: parseBoolean(env.ALERT_CANARY_ENABLED, "ALERT_CANARY_ENABLED", false),
    alertCanaryCron: env.ALERT_CANARY_CRON ?? "0 9 * * *",
    alertCanaryMaxAgeSec: parsePositiveInt(
      env.ALERT_CANARY_MAX_AGE_SEC,
      "ALERT_CANARY_MAX_AGE_SEC",
      26 * 60 * 60,
    ),
    alertWebhookUrl: env.ALERT_WEBHOOK_URL ?? "",
    alertWebhookSecret: env.ALERT_WEBHOOK_SECRET ?? "",
    telegramBotToken: env.TELEGRAM_BOT_TOKEN ?? "",
    telegramChatId: env.TELEGRAM_CHAT_ID ?? "",
    alertSinkFailureThreshold: parsePositiveInt(
      env.ALERT_SINK_FAILURE_THRESHOLD,
      "ALERT_SINK_FAILURE_THRESHOLD",
      3,
    ),
    watchdogAlertRepeatSec: parsePositiveInt(
      env.WATCHDOG_ALERT_REPEAT_SEC,
      "WATCHDOG_ALERT_REPEAT_SEC",
      3600,
    ),
    fcmWakeAlertThreshold: parsePositiveInt(
      env.FCM_WAKE_ALERT_THRESHOLD,
      "FCM_WAKE_ALERT_THRESHOLD",
      3,
    ),
    fcmWakeAlertRepeatSec: parsePositiveInt(
      env.FCM_WAKE_ALERT_REPEAT_SEC,
      "FCM_WAKE_ALERT_REPEAT_SEC",
      3600,
    ),
    deviceQuarantineSec: parsePositiveInt(
      env.DEVICE_QUARANTINE_SEC,
      "DEVICE_QUARANTINE_SEC",
      86400,
    ),
    wakeIdleThresholdSec: parsePositiveInt(
      env.WAKE_IDLE_THRESHOLD_SEC,
      "WAKE_IDLE_THRESHOLD_SEC",
      15 * 60,
    ),
    deviceEnrollmentSecret: env.DEVICE_ENROLLMENT_SECRET ?? "",
    appProvisioningSecret: env.APP_PROVISIONING_SECRET ?? "",
    appProvisioningRateMaxPerHour: parsePositiveInt(
      env.APP_PROVISIONING_RATE_MAX_PER_HOUR,
      "APP_PROVISIONING_RATE_MAX_PER_HOUR",
      10,
    ),
    appProvisioningRateWindowSec: parsePositiveInt(
      env.APP_PROVISIONING_RATE_WINDOW_SEC,
      "APP_PROVISIONING_RATE_WINDOW_SEC",
      3600,
    ),
    sessionTtlSec: parsePositiveInt(env.SESSION_TTL_SEC, "SESSION_TTL_SEC", 7 * 24 * 60 * 60),
    authRateMaxPerHour: parsePositiveInt(env.AUTH_RATE_MAX_PER_HOUR, "AUTH_RATE_MAX_PER_HOUR", 30),
    authRateWindowSec: parsePositiveInt(env.AUTH_RATE_WINDOW_SEC, "AUTH_RATE_WINDOW_SEC", 3600),
    emailVerifyTtlSec: parsePositiveInt(env.EMAIL_VERIFY_TTL_SEC, "EMAIL_VERIFY_TTL_SEC", 24 * 60 * 60),
    emailResetTtlSec: parsePositiveInt(env.EMAIL_RESET_TTL_SEC, "EMAIL_RESET_TTL_SEC", 30 * 60),
    dashboardBaseUrl: env.DASHBOARD_BASE_URL ?? "",
    trialSmsCount: parsePositiveInt(env.TRIAL_SMS_COUNT, "TRIAL_SMS_COUNT", 20, true),
    trialSmsTtlDays: parsePositiveInt(env.TRIAL_SMS_TTL_DAYS, "TRIAL_SMS_TTL_DAYS", 30),
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
    webhookExhaustionAlertThreshold: parsePositiveInt(
      env.WEBHOOK_EXHAUSTION_ALERT_THRESHOLD,
      "WEBHOOK_EXHAUSTION_ALERT_THRESHOLD",
      3,
    ),
    webhookExhaustionDampingSec: parsePositiveInt(
      env.WEBHOOK_EXHAUSTION_DAMPING_SEC,
      "WEBHOOK_EXHAUSTION_DAMPING_SEC",
      900, // handoff default: caps re-alerts at 4/hour per dead receiver
      true, // 0 is a documented value: damping disabled
    ),
    operatorSecret: env.OPERATOR_SECRET ?? "",
    bkashPersonalNumber: env.BKASH_PERSONAL_NUMBER ?? "",

    // Bulk campaign plane: defaults mirror v4 (functions/src/bulk/*).
    bulkEnabled: parseBoolean(env.BULK_ENABLED, "BULK_ENABLED", false),
    bulkQueueCron: env.BULK_QUEUE_CRON ?? "*/1 * * * *",
    bulkSmsRatePerMinute: parsePositiveInt(env.BULK_SMS_RATE_PER_MINUTE, "BULK_SMS_RATE_PER_MINUTE", 30),
    bulkMaxPendingQueue: parsePositiveInt(env.BULK_MAX_PENDING_QUEUE, "BULK_MAX_PENDING_QUEUE", 100),
    bulkRetryMaxAttempts: parsePositiveInt(env.BULK_RETRY_MAX_ATTEMPTS, "BULK_RETRY_MAX_ATTEMPTS", 3),
    bulkPerCampaignLimit: parsePositiveInt(env.BULK_SMS_PER_CAMPAIGN_LIMIT, "BULK_SMS_PER_CAMPAIGN_LIMIT", 10_000),
    bulkDailyAppLimit: parsePositiveInt(env.BULK_DAILY_APP_LIMIT, "BULK_DAILY_APP_LIMIT", 50_000),
    bulkMaxCharsGsm: parsePositiveInt(env.BULK_MAX_MESSAGE_CHARS_GSM, "BULK_MAX_MESSAGE_CHARS_GSM", 160),
    bulkMaxCharsUcs2: parsePositiveInt(env.BULK_MAX_MESSAGE_CHARS_UCS2, "BULK_MAX_MESSAGE_CHARS_UCS2", 70),
    bulkPostSendCooldownSec: parsePositiveInt(env.BULK_POST_SEND_COOLDOWN_SEC, "BULK_POST_SEND_COOLDOWN_SEC", 120),
    otpResendCooldownSec: parsePositiveInt(
      env.OTP_RESEND_COOLDOWN_SEC,
      "OTP_RESEND_COOLDOWN_SEC",
      60,
      true, // 0 is a documented value: cooldown disabled
    ),
    corsAllowedOrigins: env.CORS_ALLOWED_ORIGINS ?? "",
    statsCron: env.STATS_CRON ?? "*/15 * * * *",
  };
}
