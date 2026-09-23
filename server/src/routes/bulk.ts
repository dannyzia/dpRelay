/**
 * Bulk campaign routes (M4 pass 2, PLAN §10). Port of v4 sendBulkSms /
 * createBulkCampaign / getBulkStatus / listCampaigns / pauseCampaign /
 * resumeCampaign / cancelCampaign / retryFailedJobs / listFailedRecipients
 * to v5 REST.
 *
 * Auth model (single choke point per plan §5): every route gates via
 * requireApp (X-App-Id/X-App-Secret) — v4 checked Firebase ownerUid/admin,
 * but v5 apps have no owner until the self-serve onboarding milestone, so
 * the app credential IS the tenant scope (same re-scope as the billing plane).
 *
 * Money correctness (Addendum #1 spirit):
 * - Credits are deducted once per recipient inside the SAME transaction that
 *   inserts the campaign, its recipients, and the bulk_usage audit rows
 *   (phone hashed — no PII in the audit trail).
 * - Cancellation refunds each unprocessed recipient exactly once (v4
 *   double-counted queued recipients via its in-flight entry sum).
 * - Retrying failed recipients re-deducts fresh credits atomically.
 */
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { asRecord, asString } from "../services/parse.js";
import { newId, sha256Hex } from "../services/crypto.js";
import {
  dailyUsageCount,
  deductBulkCredits,
  deduplicatePhones,
  isValidE164,
  refundBulkCredits,
  reserveBulkCredits,
  validateBulkMessage,
} from "../services/bulk.js";

const CAMPAIGN_NAME_MAX = 100;
/** Failed-recipients listing cap (v4 parity). */
const FAILED_RECIPIENTS_MAX = 500;

/** Rejects with the structured envelope. */
function fail(reply: FastifyReply, code: number, codeName: string, message: string): FastifyReply {
  return reply.code(code).send({ ok: false, error: message, code: codeName });
}

interface CampaignRow {
  id: string;
  name: string;
  message: string;
  status: string;
  total_recipients: number;
  sent_count: number;
  failed_count: number;
  queued_count: number;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  source_type: string;
  source_group_ids: string | null;
}

function publicCampaign(row: CampaignRow, includeMessage: boolean) {
  const base: Record<string, unknown> = {
    campaignId: row.id,
    name: row.name,
    status: row.status,
    sourceType: row.source_type,
    totalRecipients: row.total_recipients,
    sentCount: row.sent_count,
    failedCount: row.failed_count,
    queuedCount: Math.max(0, row.total_recipients - row.sent_count - row.failed_count),
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
  if (includeMessage) {
    base.message = row.message;
    base.sourceGroupIds = row.source_group_ids
      ? (JSON.parse(row.source_group_ids) as string[])
      : null;
  }
  return base;
}

const bulkRoutes: FastifyPluginAsync = async (app) => {
  const db = app.db;

  /**
   * Create a campaign (v4 sendBulkSms + createBulkCampaign). sourceType=csv
   * takes body.phones; sourceType=contactGroups takes sourceGroupIds (max 10,
   * v4 parity) and materializes the groups' members as recipients at create
   * time — later group edits never mutate a running campaign.
   */
  app.post("/v5/bulk/campaigns", { preHandler: [app.requireApp] }, async (request, reply) => {
    if (!app.config.bulkEnabled) {
      return fail(reply, 403, "bulk_not_enabled", "Bulk campaigns are not enabled");
    }
    const body = asRecord(request.body) ?? {};
    const sourceType = body.sourceType === undefined ? "csv" : body.sourceType;
    if (sourceType !== "csv" && sourceType !== "contactGroups") {
      return fail(reply, 400, "invalid_source_type", "sourceType must be 'csv' or 'contactGroups'");
    }

    /** v4 parity (createBulkCampaign): at most 10 groups per campaign. */
    const MAX_SOURCE_GROUPS = 10;

    let resolvedPhones: string[] = [];
    let sourceGroupIds: string[] = [];
    if (sourceType === "contactGroups") {
      if (!Array.isArray(body.sourceGroupIds) || body.sourceGroupIds.length === 0) {
        return fail(
          reply,
          400,
          "invalid_source_groups",
          "sourceGroupIds is required when sourceType is 'contactGroups'",
        );
      }
      if (body.sourceGroupIds.length > MAX_SOURCE_GROUPS) {
        return fail(
          reply,
          400,
          "invalid_source_groups",
          `Maximum ${MAX_SOURCE_GROUPS} contact groups allowed`,
        );
      }
      sourceGroupIds = (body.sourceGroupIds as unknown[]).filter(
        (id): id is string => typeof id === "string" && id.length > 0 && id.length <= 64,
      );
      if (sourceGroupIds.length !== body.sourceGroupIds.length) {
        return fail(reply, 400, "invalid_source_groups", "sourceGroupIds must be groupId strings");
      }
      // Resolve every group within THIS app's scope (404 on any miss, v4
      // parity) and union the member phones — the Set dedupes across groups
      // exactly like v4's phoneSet. Members were validated E.164 at group
      // ingestion (every group write path validates), so no re-validation
      // here — v4's "contact groups are pre-validated" contract.
      const phoneSet = new Set<string>();
      const groupExists = db.prepare("SELECT 1 FROM contact_groups WHERE id = ? AND app_id = ?");
      const groupPhones = db.prepare(
        "SELECT phone FROM contact_group_phones WHERE group_id = ? ORDER BY added_at ASC, phone ASC",
      );
      for (const groupId of sourceGroupIds) {
        if (!groupExists.get(groupId, request.appRow!.id)) {
          return fail(reply, 404, "group_not_found", `Contact group not found: ${groupId}`);
        }
        for (const p of groupPhones.all(groupId) as { phone: string }[]) phoneSet.add(p.phone);
      }
      resolvedPhones = [...phoneSet];
    }

    const campaignName = asString(body.campaignName, CAMPAIGN_NAME_MAX);
    if (campaignName === null) {
      return fail(reply, 400, "invalid_campaign_name", "campaignName is required (max 100 chars)");
    }
    const messageVerdict = validateBulkMessage(
      body.message,
      app.config.bulkMaxCharsGsm,
      app.config.bulkMaxCharsUcs2,
    );
    if (!messageVerdict.valid) {
      return fail(reply, 400, "invalid_message", messageVerdict.error ?? "Invalid message");
    }
    let unique: string[];
    let duplicateCount = 0;
    if (sourceType === "csv") {
      if (!Array.isArray(body.phones)) {
        return fail(reply, 400, "invalid_phones", "phones must be an array of E.164 strings");
      }
      const phones = body.phones as unknown[];
      if (phones.length < 1 || phones.length > app.config.bulkPerCampaignLimit) {
        return fail(
          reply,
          400,
          "invalid_phones",
          `phones must contain between 1 and ${app.config.bulkPerCampaignLimit} entries`,
        );
      }
      const invalid = phones.filter((p) => !isValidE164(p));
      if (invalid.length > 0) {
        return fail(reply, 400, "invalid_phones", "One or more phone numbers are not valid E.164 format");
      }
      const deduped = deduplicatePhones(phones as string[]);
      unique = deduped.unique;
      duplicateCount = deduped.duplicateCount;
    } else {
      // contactGroups: the union across resolved groups (already deduped).
      // The per-campaign cap applies equally — v4 had no cap on this path;
      // v5 enforces it so group sources can't bypass bulkPerCampaignLimit.
      if (resolvedPhones.length === 0) {
        return fail(reply, 400, "invalid_source_groups", "Selected contact groups contain no phone numbers");
      }
      if (resolvedPhones.length > app.config.bulkPerCampaignLimit) {
        return fail(
          reply,
          400,
          "invalid_source_groups",
          `Selected groups contain ${resolvedPhones.length} numbers; the per-campaign cap is ${app.config.bulkPerCampaignLimit}`,
        );
      }
      unique = resolvedPhones;
    }
    const uniqueCount = unique.length;

    // Daily quota (v4): recipients created for this app today (UTC).
    const usedToday = dailyUsageCount(app, request.appRow!.id);
    if (usedToday + uniqueCount > app.config.bulkDailyAppLimit) {
      return fail(
        reply,
        429,
        "daily_quota_exceeded",
        `Daily bulk quota exceeded. Remaining: ${Math.max(0, app.config.bulkDailyAppLimit - usedToday)}, Requested: ${uniqueCount}`,
      );
    }

    const campaignId = newId();
    const nowSec = Math.floor(Date.now() / 1000);

    // ONE transaction: deduct credits + campaign + recipients + audit rows.
    const create = app.db.transaction((): string | null =>
      reserveBulkCredits(app, request.appRow!.id, uniqueCount),
    );
    const creditError = create();
    if (creditError !== null) {
      const status = creditError === "no_credits_row" ? 402 : 402;
      return fail(
        reply,
        status,
        creditError,
        creditError === "credits_expired"
          ? "Bulk credits expired. Purchase a new package."
          : "Not enough bulk credits.",
      );
    }

    const insertCampaign = db.prepare(
      "INSERT INTO bulk_campaigns (id, app_id, name, message, charset, status, total_recipients, created_at, " +
        "source_type, source_group_ids) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)",
    );
    const insertRecipient = db.prepare(
      "INSERT INTO bulk_recipients (id, campaign_id, phone, idx, status) VALUES (?, ?, ?, ?, 'pending')",
    );
    const insertUsage = db.prepare(
      "INSERT INTO bulk_usage (id, campaign_id, phone_hash, deducted_at) VALUES (?, ?, ?, ?)",
    );
    insertCampaign.run(
      campaignId,
      request.appRow!.id,
      campaignName,
      body.message,
      messageVerdict.charset,
      uniqueCount,
      nowSec,
      sourceType,
      sourceType === "contactGroups" ? JSON.stringify(sourceGroupIds) : null,
    );
    for (let i = 0; i < unique.length; i++) {
      insertRecipient.run(newId(), campaignId, unique[i], i);
      insertUsage.run(newId(), campaignId, sha256Hex(unique[i]), nowSec);
    }

    app.log.info(
      { appId: request.appRow!.appId, campaignId, totalRecipients: uniqueCount },
      "bulk campaign created",
    );
    const response: Record<string, unknown> = {
      ok: true,
      campaignId,
      totalRecipients: uniqueCount,
      creditsReserved: uniqueCount,
      charset: messageVerdict.charset,
      status: "queued",
      sourceType,
    };
    if (duplicateCount > 0) response.duplicateCount = duplicateCount;
    return reply.code(201).send(response);
  });

  /** List the app's campaigns, newest first, keyset-paginated (created_at:id cursor). */
  app.get("/v5/bulk/campaigns", { preHandler: [app.requireApp] }, async (request) => {
    const query = asRecord(request.query) ?? {};
    const statusRaw = query.status;
    const status =
      statusRaw === "queued" || statusRaw === "sending" || statusRaw === "paused" ||
      statusRaw === "completed" || statusRaw === "cancelled"
        ? statusRaw
        : null;
    const limitRaw = query.limit;
    const limitNum =
      typeof limitRaw === "number"
        ? limitRaw
        : typeof limitRaw === "string" && /^\d+$/.test(limitRaw)
          ? Number.parseInt(limitRaw, 10)
          : NaN;
    const limit = Number.isInteger(limitNum) && limitNum >= 1 ? Math.min(limitNum, 100) : 20;
    const cursorRaw = query.cursor;
    let cursorAt: number | null = null;
    let cursorId: string | null = null;
    if (typeof cursorRaw === "string") {
      const sep = cursorRaw.indexOf(":");
      const at = sep > 0 ? Number.parseInt(cursorRaw.slice(0, sep), 10) : NaN;
      const id = sep > 0 ? cursorRaw.slice(sep + 1) : "";
      if (Number.isInteger(at) && at >= 0 && id.length > 0) {
        cursorAt = at;
        cursorId = id;
      }
    }

    const rows = db
      .prepare(
        "SELECT id, name, message, status, total_recipients, sent_count, failed_count, queued_count, " +
          "created_at, started_at, completed_at, source_type, source_group_ids FROM bulk_campaigns WHERE app_id = ? " +
          "AND (? IS NULL OR status = ?) " +
          "AND (? IS NULL OR created_at < ? OR (created_at = ? AND id > ?)) " +
          "ORDER BY created_at DESC, id ASC LIMIT ?",
      )
      .all(
        request.appRow!.id,
        status,
        status,
        cursorAt,
        cursorAt,
        cursorAt,
        cursorId,
        limit + 1,
      ) as CampaignRow[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      ok: true,
      campaigns: page.map((row) => publicCampaign(row, false)),
      nextCursor: hasMore
        ? `${page[page.length - 1]?.created_at ?? 0}:${page[page.length - 1]?.id ?? ""}`
        : null,
    };
  });

  /** Loads one campaign owned by the authenticated app, or null (404 at call site). */
  function loadOwnedCampaign(request: { appRow?: { id: string } }, campaignId: string): CampaignRow | null {
    return (
      (db
        .prepare(
          "SELECT id, name, message, status, total_recipients, sent_count, failed_count, queued_count, " +
            "created_at, started_at, completed_at, source_type, source_group_ids " +
            "FROM bulk_campaigns WHERE id = ? AND app_id = ?",
        )
        .get(campaignId, request.appRow!.id) as CampaignRow | undefined) ?? null
    );
  }

  /** Campaign status (v4 getBulkStatus). */
  app.get("/v5/bulk/campaigns/:id", { preHandler: [app.requireApp] }, async (request, reply) => {
    const params = asRecord(request.params) ?? {};
    const campaignId = asString(params.id, 64);
    if (campaignId === null) return fail(reply, 400, "invalid_campaign_id", "campaignId is required");
    const row = loadOwnedCampaign(request, campaignId);
    if (!row) return fail(reply, 404, "campaign_not_found", "Campaign not found");
    return { ok: true, campaign: publicCampaign(row, true) };
  });

  /** Failed recipients for the operator dashboard / retry UI (v4 listFailedRecipients). */
  app.get("/v5/bulk/campaigns/:id/recipients/failed", { preHandler: [app.requireApp] }, async (request, reply) => {
    const params = asRecord(request.params) ?? {};
    const campaignId = asString(params.id, 64);
    if (campaignId === null) return fail(reply, 400, "invalid_campaign_id", "campaignId is required");
    const row = loadOwnedCampaign(request, campaignId);
    if (!row) return fail(reply, 404, "campaign_not_found", "Campaign not found");

    const query = asRecord(request.query) ?? {};
    const limitRaw = query.limit;
    const limitNum =
      typeof limitRaw === "number"
        ? limitRaw
        : typeof limitRaw === "string" && /^\d+$/.test(limitRaw)
          ? Number.parseInt(limitRaw, 10)
          : NaN;
    const limit = Number.isInteger(limitNum) && limitNum >= 1 ? Math.min(limitNum, FAILED_RECIPIENTS_MAX) : 200;

    const failed = db
      .prepare(
        "SELECT id, phone, attempts, error_message, last_attempt_at FROM bulk_recipients " +
          "WHERE campaign_id = ? AND status = 'failed' ORDER BY last_attempt_at DESC LIMIT ?",
      )
      .all(campaignId, limit) as {
      id: string;
      phone: string;
      attempts: number;
      error_message: string | null;
      last_attempt_at: number | null;
    }[];
    return {
      ok: true,
      failedRecipients: failed.map((r) => ({
        id: r.id,
        phone: r.phone,
        attempts: r.attempts,
        errorMessage: r.error_message ?? "Unknown error",
        lastAttemptAt: r.last_attempt_at,
      })),
    };
  });

  /** Pause (v4): queued|sending → paused; queue tick skips paused campaigns. */
  app.post("/v5/bulk/campaigns/:id/pause", { preHandler: [app.requireApp] }, async (request, reply) => {
    const params = asRecord(request.params) ?? {};
    const campaignId = asString(params.id, 64);
    if (campaignId === null) return fail(reply, 400, "invalid_campaign_id", "campaignId is required");
    const row = loadOwnedCampaign(request, campaignId);
    if (!row) return fail(reply, 404, "campaign_not_found", "Campaign not found");
    if (row.status !== "queued" && row.status !== "sending") {
      return fail(reply, 409, "invalid_state", "Campaign cannot be paused in its current state");
    }
    db.prepare("UPDATE bulk_campaigns SET status = 'paused' WHERE id = ?").run(campaignId);
    return { ok: true, status: "paused" };
  });

  /** Resume (v4): paused → sending. */
  app.post("/v5/bulk/campaigns/:id/resume", { preHandler: [app.requireApp] }, async (request, reply) => {
    const params = asRecord(request.params) ?? {};
    const campaignId = asString(params.id, 64);
    if (campaignId === null) return fail(reply, 400, "invalid_campaign_id", "campaignId is required");
    const row = loadOwnedCampaign(request, campaignId);
    if (!row) return fail(reply, 404, "campaign_not_found", "Campaign not found");
    if (row.status !== "paused") {
      return fail(reply, 409, "invalid_state", "Campaign is not paused");
    }
    db.prepare("UPDATE bulk_campaigns SET status = 'sending' WHERE id = ?").run(campaignId);
    return { ok: true, status: "sending" };
  });

  /**
   * Cancel (v4): queued|sending|paused → cancelled, refunding every
   * unprocessed recipient EXACTLY once (v4 double-counted queued recipients
   * via its in-flight entry sum) and voiding their in-flight queue rows so
   * the phone never sends them.
   */
  app.post("/v5/bulk/campaigns/:id/cancel", { preHandler: [app.requireApp] }, async (request, reply) => {
    const params = asRecord(request.params) ?? {};
    const campaignId = asString(params.id, 64);
    if (campaignId === null) return fail(reply, 400, "invalid_campaign_id", "campaignId is required");
    const row = loadOwnedCampaign(request, campaignId);
    if (!row) return fail(reply, 404, "campaign_not_found", "Campaign not found");
    if (row.status !== "queued" && row.status !== "sending" && row.status !== "paused") {
      return fail(reply, 409, "invalid_state", "Campaign cannot be cancelled in its current state");
    }

    const cancel = db.transaction((): number => {
      const unprocessed = (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM bulk_recipients WHERE campaign_id = ? AND status IN ('pending', 'queued')",
          )
          .get(campaignId) as { n: number }
      ).n;
      // Void in-flight queue rows (pending or claimed) so the phone never
      // sends them; terminal rows stay as history.
      db.prepare(
        "DELETE FROM pending_sms WHERE status IN ('pending', 'claimed') AND id IN " +
          "(SELECT pending_sms_id FROM bulk_recipients WHERE campaign_id = ? AND status = 'queued')",
      ).run(campaignId);
      db.prepare(
        "UPDATE bulk_recipients SET status = 'cancelled' WHERE campaign_id = ? AND status IN ('pending', 'queued')",
      ).run(campaignId);
      db.prepare(
        "UPDATE bulk_campaigns SET status = 'cancelled', completed_at = ? WHERE id = ?",
      ).run(Math.floor(Date.now() / 1000), campaignId);
      if (unprocessed > 0) {
        refundBulkCredits(app, request.appRow!.id, unprocessed);
      }
      return unprocessed;
    });
    const refunded = cancel();

    app.log.info({ appId: request.appRow!.appId, campaignId, creditsRefunded: refunded }, "bulk campaign cancelled");
    return { ok: true, status: "cancelled", creditsRefunded: refunded };
  });

  /**
   * Retry failed recipients (v4 retryFailedJobs): re-deducts fresh credits
   * atomically, resets the recipients to pending, and reopens the campaign.
   * v4 also grew totalRecipients by the retry count — kept, since queuedCount
   * reporting derives from total - sent - failed.
   */
  app.post("/v5/bulk/campaigns/:id/retry-failed", { preHandler: [app.requireApp] }, async (request, reply) => {
    const params = asRecord(request.params) ?? {};
    const campaignId = asString(params.id, 64);
    if (campaignId === null) return fail(reply, 400, "invalid_campaign_id", "campaignId is required");
    const row = loadOwnedCampaign(request, campaignId);
    if (!row) return fail(reply, 404, "campaign_not_found", "Campaign not found");
    if (row.status === "cancelled") {
      return fail(reply, 409, "invalid_state", "Cancelled campaigns cannot be retried");
    }

    const failedCount = (
      db
        .prepare("SELECT COUNT(*) AS n FROM bulk_recipients WHERE campaign_id = ? AND status = 'failed'")
        .get(campaignId) as { n: number }
    ).n;
    if (failedCount === 0) {
      return { ok: true, retryCount: 0, creditsDeducted: 0 };
    }

    const deduct = db.transaction((): string | null => deductBulkCredits(app, request.appRow!.id, failedCount));
    const creditError = deduct();
    if (creditError !== null) {
      return fail(reply, 402, creditError, "Not enough bulk credits.");
    }

    db.prepare(
      "UPDATE bulk_recipients SET status = 'pending', attempts = 0, error_message = NULL " +
        "WHERE campaign_id = ? AND status = 'failed'",
    ).run(campaignId);
    db.prepare(
      "UPDATE bulk_campaigns SET status = 'sending', total_recipients = total_recipients + ? WHERE id = ?",
    ).run(failedCount, campaignId);

    app.log.info({ appId: request.appRow!.appId, campaignId, retryCount: failedCount }, "bulk failed recipients retried");
    return { ok: true, retryCount: failedCount, creditsDeducted: failedCount };
  });
};

export default bulkRoutes;
