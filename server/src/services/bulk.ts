/**
 * Bulk campaign service (M4 pass 2, PLAN §10). Port of v4 functions/src/bulk
 * helpers + credit primitives to synchronous SQLite, with the money paths
 * (deduct/refund) made atomic by better-sqlite3 transactions.
 *
 * Money correctness (Addendum #1 spirit, applied to usage):
 * - Credits are deducted exactly once per recipient, at campaign creation,
 *   with an audit row (bulk_usage, phone hashed — no PII) in the SAME
 *   transaction.
 * - Cancellation refunds each unprocessed recipient exactly ONCE. v4's
 *   cancelCampaign double-counted (recipient-status sum + in-flight pending
 *   entries overlap); v5 counts recipient rows only.
 * - The queue tick is idempotent: every phase re-derives its work from
 *   durable row states, so a crash between phases is recoverable (R5
 *   at-least-once).
 */
import type { FastifyInstance } from "fastify";
import { newId } from "./crypto.js";

/** GSM 03.38 basic charset — v4 parity (functions/src/bulk/bulkHelpers.js). */
const GSM_7BIT_CHARSET = new Set([
  ..."@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\\\"¤%&'()*+,-./0123456789:;<=>?".split(""),
  ..." ¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà".split(""),
]);

/** E.164: + followed by 7–15 digits, first digit 1–9. */
export function isValidE164(phone: unknown): phone is string {
  return typeof phone === "string" && /^\+[1-9]\d{6,14}$/.test(phone);
}

export function isGsm7Bit(text: string): boolean {
  for (const char of text) {
    if (!GSM_7BIT_CHARSET.has(char)) return false;
  }
  return true;
}

export interface BulkMessageVerdict {
  valid: boolean;
  charset: "gsm" | "ucs2";
  maxChars: number;
  error?: string;
}

/** Validates a bulk message body against charset-specific length caps (v4 parity). */
export function validateBulkMessage(
  message: unknown,
  maxCharsGsm: number,
  maxCharsUcs2: number,
): BulkMessageVerdict {
  if (typeof message !== "string" || message.trim().length === 0) {
    return { valid: false, charset: "gsm", maxChars: maxCharsGsm, error: "Message cannot be empty" };
  }
  const charset = isGsm7Bit(message) ? "gsm" : "ucs2";
  const maxChars = charset === "gsm" ? maxCharsGsm : maxCharsUcs2;
  if (message.length > maxChars) {
    return {
      valid: false,
      charset,
      maxChars,
      error: `Message exceeds ${maxChars} chars for ${charset.toUpperCase()}`,
    };
  }
  return { valid: true, charset, maxChars };
}

/** Deduplicates phones preserving first-seen order; reports the dropped count. */
export function deduplicatePhones(phones: string[]): { unique: string[]; duplicateCount: number } {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const phone of phones) {
    if (seen.has(phone)) continue;
    seen.add(phone);
    unique.push(phone);
  }
  return { unique, duplicateCount: phones.length - unique.length };
}

/** Recipients created for this app since the current UTC-day start (quota input). */
export function dailyUsageCount(app: FastifyInstance, appRowId: string): number {
  const now = new Date();
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000;
  const row = app.db
    .prepare(
      "SELECT COALESCE(SUM(total_recipients), 0) AS n FROM bulk_campaigns " +
        "WHERE app_id = ? AND created_at >= ?",
    )
    .get(appRowId, todayStart) as { n: number };
  return row.n;
}

export type CreditError = "insufficient_bulk_credits" | "credits_expired" | "no_credits_row";

/**
 * Atomically reserves `count` bulk credits (v4 createBulkCampaign): fails on
 * missing row, expired bulk credits (bulk_expires_at in the past), or an
 * insufficient balance. Runs in one transaction with the campaign insert at
 * the call site.
 */
export function reserveBulkCredits(
  app: FastifyInstance,
  appRowId: string,
  count: number,
): CreditError | null {
  const nowSec = Math.floor(Date.now() / 1000);
  const reserve = app.db.transaction((): CreditError | null => {
    const row = app.db
      .prepare("SELECT bulk_sms_remaining, bulk_expires_at FROM app_credits WHERE app_id = ?")
      .get(appRowId) as { bulk_sms_remaining: number; bulk_expires_at: number | null } | undefined;
    if (!row) return "no_credits_row";
    if (row.bulk_expires_at !== null && row.bulk_expires_at <= nowSec) return "credits_expired";
    if (row.bulk_sms_remaining < count) return "insufficient_bulk_credits";
    app.db
      .prepare(
        "UPDATE app_credits SET bulk_sms_remaining = bulk_sms_remaining - ?, updated_at = ? WHERE app_id = ?",
      )
      .run(count, nowSec, appRowId);
    return null;
  });
  return reserve();
}

/** Re-deducts credits for retried recipients — v4 retryFailedJobs parity: balance checked, expiry NOT re-checked. */
export function deductBulkCredits(
  app: FastifyInstance,
  appRowId: string,
  count: number,
): CreditError | null {
  const deduct = app.db.transaction((): CreditError | null => {
    const row = app.db
      .prepare("SELECT bulk_sms_remaining FROM app_credits WHERE app_id = ?")
      .get(appRowId) as { bulk_sms_remaining: number } | undefined;
    if (!row || row.bulk_sms_remaining < count) return "insufficient_bulk_credits";
    app.db
      .prepare("UPDATE app_credits SET bulk_sms_remaining = bulk_sms_remaining - ?, updated_at = ? WHERE app_id = ?")
      .run(count, Math.floor(Date.now() / 1000), appRowId);
    return null;
  });
  return deduct();
}

/** Returns `count` bulk credits (cancellation refund). Creates the row if absent. */
export function refundBulkCredits(app: FastifyInstance, appRowId: string, count: number): void {
  app.db
    .prepare(
      "INSERT INTO app_credits (app_id, bulk_sms_remaining, updated_at) VALUES (?, ?, unixepoch()) " +
        "ON CONFLICT(app_id) DO UPDATE SET " +
        "bulk_sms_remaining = bulk_sms_remaining + excluded.bulk_sms_remaining, updated_at = excluded.updated_at",
    )
    .run(appRowId, count);
}

interface RecipientResolution {
  recipientId: string;
  campaignId: string;
  appRowId: string;
  phone: string;
  pendingStatus: "sent" | "failed";
  pendingError: string | null;
}

/**
 * Reconcile phase: recipients marked 'queued' whose pending_sms row reached a
 * terminal state. 'sent' closes the recipient and arms the post-send cooldown;
 * 'failed' either returns the recipient to 'pending' for another attempt or
 * terminates it (campaign failed_count), per BULK_RETRY_MAX_ATTEMPTS.
 */
function reconcileResults(app: FastifyInstance): number {
  const rows = app.db
    .prepare(
      "SELECT r.id AS recipientId, r.campaign_id AS campaignId, c.app_id AS appRowId, r.phone, " +
        "r.attempts, p.status AS pendingStatus, p.error AS pendingError " +
        "FROM bulk_recipients r " +
        "JOIN pending_sms p ON p.id = r.pending_sms_id " +
        "JOIN bulk_campaigns c ON c.id = r.campaign_id " +
        "WHERE r.status = 'queued' AND p.status IN ('sent', 'failed')",
    )
    .all() as (RecipientResolution & { attempts: number })[];

  const nowSec = Math.floor(Date.now() / 1000);
  let resolved = 0;
  for (const row of rows) {
    const attempts = row.attempts + 1;
    const apply = app.db.transaction((): void => {
      if (row.pendingStatus === "sent") {
        app.db
          .prepare(
            "UPDATE bulk_recipients SET status = 'sent', attempts = ?, last_attempt_at = ? WHERE id = ?",
          )
          .run(attempts, nowSec, row.recipientId);
        app.db
          .prepare("UPDATE bulk_campaigns SET sent_count = sent_count + 1 WHERE id = ?")
          .run(row.campaignId);
        app.db
          .prepare(
            "INSERT INTO bulk_phone_cooldowns (phone, expires_at) VALUES (?, ?) " +
              "ON CONFLICT(phone) DO UPDATE SET expires_at = excluded.expires_at",
          )
          .run(row.phone, nowSec + app.config.bulkPostSendCooldownSec);
      } else if (attempts < app.config.bulkRetryMaxAttempts) {
        // Back to 'pending': the next enqueue phase re-picks it (oldest idx first).
        app.db
          .prepare(
            "UPDATE bulk_recipients SET status = 'pending', attempts = ?, last_attempt_at = ?, " +
              "error_message = ? WHERE id = ?",
          )
          .run(attempts, nowSec, row.pendingError, row.recipientId);
      } else {
        app.db
          .prepare(
            "UPDATE bulk_recipients SET status = 'failed', attempts = ?, last_attempt_at = ?, " +
              "error_message = ? WHERE id = ?",
          )
          .run(attempts, nowSec, row.pendingError, row.recipientId);
        app.db
          .prepare("UPDATE bulk_campaigns SET failed_count = failed_count + 1 WHERE id = ?")
          .run(row.campaignId);
      }
    });
    apply();
    resolved += 1;
  }
  return resolved;
}

/** Campaigns whose recipients have all reached a terminal state. */
interface FinalizableCampaign {
  id: string;
  app_row_id: string;
  public_app_id: string;
  sent_count: number;
  failed_count: number;
  total_recipients: number;
  webhook_url: string | null;
  webhook_secret: string | null;
}

function findFinalizableCampaigns(app: FastifyInstance): FinalizableCampaign[] {
  return app.db
    .prepare(
      "SELECT c.id, c.app_id AS app_row_id, a.app_id AS public_app_id, c.sent_count, c.failed_count, " +
        "c.total_recipients, a.webhook_url, a.webhook_secret " +
        "FROM bulk_campaigns c JOIN apps a ON a.id = c.app_id " +
        "WHERE c.status = 'sending' AND NOT EXISTS (" +
        "  SELECT 1 FROM bulk_recipients r WHERE r.campaign_id = c.id AND r.status IN ('pending', 'queued'))",
    )
    .all() as FinalizableCampaign[];
}

/**
 * Full queue tick: reconcile resolved deliveries → finalize completed
 * campaigns (completion webhook) → enqueue pending recipients under the rate
 * budget. Exported for tests (startCron=false) and the wake sweep.
 * @returns summary counters for logging/tests.
 */
export async function runBulkQueueTick(
  app: FastifyInstance,
): Promise<{ reconciled: number; enqueued: number; finalized: number }> {
  const reconciled = reconcileResults(app);

  // ── Finalize ────────────────────────────────────────────────────────────
  const finalizable = findFinalizableCampaigns(app);
  for (const campaign of finalizable) {
    app.db
      .prepare("UPDATE bulk_campaigns SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'sending'")
      .run(Math.floor(Date.now() / 1000), campaign.id);
    // Webhook after the status flip: a crash between them re-runs nothing
    // (finalize no longer matches), so completion notifications are
    // at-most-once — same trade-off v4 made; the app can also poll status.
    if (campaign.webhook_url && campaign.webhook_secret) {
      try {
        // Dynamic import breaks the module cycle jobs.ts → bulk.ts → webhooks.ts → jobs.ts
        // (webhooks.ts needs jobs.ts for the alert channel; jobs.ts needs this tick).
        const { dispatchBulkCampaignWebhook } = await import("./webhooks.js");
        await dispatchBulkCampaignWebhook(
          app,
          {
            campaignId: campaign.id,
            appId: campaign.public_app_id,
            appRowId: campaign.app_row_id,
            webhookUrl: campaign.webhook_url,
            webhookSecret: campaign.webhook_secret,
          },
          {
            sentCount: campaign.sent_count,
            failedCount: campaign.failed_count,
            totalRecipients: campaign.total_recipients,
          },
        );
      } catch (err) {
        // Never let a notification problem fail the tick — the completion
        // state is already durable and the failure is logged inside dispatch.
        app.log.error({ err, campaignId: campaign.id }, "bulk completion webhook threw");
      }
    }
  }

  // ── Enqueue ─────────────────────────────────────────────────────────────
  const nowSec = Math.floor(Date.now() / 1000);
  const inFlight = (
    app.db
      .prepare(
        "SELECT COUNT(*) AS n FROM pending_sms p WHERE p.status IN ('pending', 'claimed') " +
          "AND EXISTS (SELECT 1 FROM bulk_recipients r WHERE r.pending_sms_id = p.id)",
      )
      .get() as { n: number }
  ).n;
  const budget = Math.max(0, app.config.bulkSmsRatePerMinute - inFlight);
  let enqueued = 0;

  if (budget > 0) {
    const campaigns = app.db
      .prepare(
        "SELECT c.id, c.app_id AS app_row_id, a.app_id AS public_app_id, c.message " +
          "FROM bulk_campaigns c JOIN apps a ON a.id = c.app_id " +
          "WHERE c.status IN ('queued', 'sending') ORDER BY c.created_at ASC, c.id ASC",
      )
      .all() as { id: string; app_row_id: string; public_app_id: string; message: string }[];
    // v4 fair share: at least 1 per active campaign when budget allows.
    const perCampaign = Math.max(1, Math.floor(budget / Math.max(1, campaigns.length)));

    for (const campaign of campaigns) {
      if (enqueued >= budget) break;
      const remaining = budget - enqueued;
      const campaignBudget = Math.min(perCampaign, remaining);
      const enqueue = app.db.transaction((): number => {
        // Activate queued campaigns on their first enqueue.
        app.db
          .prepare(
            "UPDATE bulk_campaigns SET status = 'sending', started_at = ? " +
              "WHERE id = ? AND status = 'queued'",
          )
          .run(nowSec, campaign.id);

        const recipients = app.db
          .prepare(
            "SELECT r.id, r.phone FROM bulk_recipients r " +
              "WHERE r.campaign_id = ? AND r.status = 'pending' " +
              "AND NOT EXISTS (SELECT 1 FROM bulk_phone_cooldowns cd WHERE cd.phone = r.phone AND cd.expires_at > ?) " +
              "ORDER BY r.idx ASC LIMIT ?",
          )
          .all(campaign.id, nowSec, campaignBudget) as { id: string; phone: string }[];

        const insertPending = app.db.prepare(
          "INSERT INTO pending_sms (id, app_id, to_addr, message, status, created_at) " +
            "VALUES (?, ?, ?, ?, 'pending', ?)",
        );
        const markQueued = app.db.prepare(
          "UPDATE bulk_recipients SET status = 'queued', pending_sms_id = ? WHERE id = ?",
        );
        for (const recipient of recipients) {
          const pendingId = newId();
          insertPending.run(pendingId, campaign.public_app_id, recipient.phone, campaign.message, nowSec);
          markQueued.run(pendingId, recipient.id);
        }
        if (recipients.length > 0) {
          app.db
            .prepare("UPDATE bulk_campaigns SET queued_count = queued_count + ? WHERE id = ?")
            .run(recipients.length, campaign.id);
        }
        return recipients.length;
      });
      enqueued += enqueue();
    }
  }

  if (reconciled > 0 || enqueued > 0 || finalizable.length > 0) {
    app.log.info(
      { reconciled, enqueued, finalized: finalizable.length },
      "bulk queue tick",
    );
  }
  return { reconciled, enqueued, finalized: finalizable.length };
}
