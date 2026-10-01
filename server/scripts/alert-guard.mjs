// Alert-channel boot guard (ISSUE-41): refuse to start when alerting is
// silently unarmed. dispatchAlert() degrades to log-only when no sink is
// configured — correct for the job runner, catastrophic at boot: production
// can run for days with the watchdog "alerting" into nowhere (the §1.4
// incident class, ISSUE-37). This guard converts that silent state into a
// loud boot failure. Kept as a pure module so tests assert the real logic.
//
// Default is fail-loud. ALERTING_REQUIRED=false opts out explicitly — local
// dev only — mirroring the LITESTREAM_ENABLED=false convention.

/**
 * Result of the boot-time alerting check.
 *
 * @param {boolean} armed  A complete sink is configured; alerts will leave the process.
 * @param {boolean} optOut ALERTING_REQUIRED=false was set explicitly (dev mode).
 */
export function assertAlertingArmed(env = process.env) {
  const required = (env.ALERTING_REQUIRED ?? 'true').trim().toLowerCase() !== 'false';
  if (!required) {
    return { armed: false, optOut: true };
  }

  // A Telegram sink is armed only when BOTH halves are non-empty: dispatchAlert
  // treats token-without-chat-id as unconfigured and stays log-only.
  const telegramArmed =
    isSet(env.TELEGRAM_BOT_TOKEN) && isSet(env.TELEGRAM_CHAT_ID);
  const webhookArmed = isSet(env.ALERT_WEBHOOK_URL);

  if (telegramArmed || webhookArmed) {
    return { armed: true, optOut: false };
  }

  const halfTelegram = isSet(env.TELEGRAM_BOT_TOKEN) !== isSet(env.TELEGRAM_CHAT_ID);
  const halfNote = halfTelegram
    ? ' TELEGRAM_* is HALF-configured (one of token/chat id set) — that stays log-only.'
    : '';
  throw new Error(
    'alerting is unarmed — no complete sink configured.' + halfNote +
    ' Watchdog and webhook-exhaustion alerts would be log-only, which is the' +
    ' exact failure class behind ISSUE-37 (§1.4). Fix: set TELEGRAM_BOT_TOKEN +' +
    ' TELEGRAM_CHAT_ID (or ALERT_WEBHOOK_URL) in Render → Environment, or set' +
    ' ALERTING_REQUIRED=false to opt out explicitly (local dev only).',
  );
}

function isSet(v) {
  return typeof v === 'string' && v.trim() !== '';
}
