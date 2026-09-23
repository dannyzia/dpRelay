/**
 * Contact-group routes (M4 pass 3, PLAN §10). v4 stored contactGroups in
 * Firestore (web client wrote directly — there were no server CRUD functions);
 * v5 makes them first-class per-app entities behind the standard REST plane.
 *
 * Auth model (single choke point per plan §5): every route gates via
 * requireApp (X-App-Id/X-App-Secret) — v4 scoped groups to a Firebase uid;
 * the v5 app credential is the tenant scope (same re-scope as billing and
 * campaigns).
 *
 * Phone ingestion is validated E.164 here so the campaign-creation path can
 * trust group contents (v4 parity: the UI pre-validated, the create function
 * did not re-check). Groups may be edited freely between campaigns — campaign
 * recipients are materialized at create time, so edits never mutate a running
 * or historical campaign.
 */
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { asRecord, asString } from "../services/parse.js";
import { newId } from "../services/crypto.js";
import {
  deduplicatePhones,
  isValidE164,
} from "../services/bulk.js";

const GROUP_NAME_MAX = 100;
/** List pagination cap (campaigns parity). */
const LIST_MAX = 100;
const LIST_DEFAULT = 20;

/** Rejects with the structured envelope. */
function fail(reply: FastifyReply, code: number, codeName: string, message: string): FastifyReply {
  return reply.code(code).send({ ok: false, error: message, code: codeName });
}

interface GroupRow {
  id: string;
  name: string;
  phone_count: number;
  created_at: number;
  updated_at: number;
}

function publicGroup(row: GroupRow) {
  return {
    groupId: row.id,
    name: row.name,
    phoneCount: row.phone_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const contactGroupRoutes: FastifyPluginAsync = async (app) => {
  const db = app.db;

  /**
   * Creates a group (v4 web parity: {name} + phones subcollection). Phones are
   * deduplicated (first-seen kept, duplicateCount reported) and must all be
   * strict E.164. The group is rejected empty — an empty group can never feed
   * a campaign.
   */
  app.post("/v5/contact-groups", { preHandler: [app.requireApp] }, async (request, reply) => {
    const body = asRecord(request.body) ?? {};
    const name = asString(body.name, GROUP_NAME_MAX);
    if (name === null) {
      return fail(reply, 400, "invalid_group_name", "name is required (max 100 chars)");
    }
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
    const { unique, duplicateCount } = deduplicatePhones(phones as string[]);

    const nowSec = Math.floor(Date.now() / 1000);
    const groupId = newId();

    // name is UNIQUE per app — surface the conflict explicitly instead of a 500.
    const create = db.transaction((): string | null => {
      const dup = db
        .prepare("SELECT 1 FROM contact_groups WHERE app_id = ? AND name = ?")
        .get(request.appRow!.id, name);
      if (dup) return "group_name_exists";
      db.prepare(
        "INSERT INTO contact_groups (id, app_id, name, phone_count, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?)",
      ).run(groupId, request.appRow!.id, name, unique.length, nowSec, nowSec);
      const insertPhone = db.prepare(
        "INSERT INTO contact_group_phones (group_id, phone, added_at) VALUES (?, ?, ?)",
      );
      for (const phone of unique) insertPhone.run(groupId, phone, nowSec);
      return null;
    });
    const conflict = create();
    if (conflict !== null) {
      return fail(reply, 409, conflict, `A contact group named "${name}" already exists for this app`);
    }

    app.log.info({ appId: request.appRow!.appId, groupId, phoneCount: unique.length }, "contact group created");
    const response: Record<string, unknown> = {
      ok: true,
      groupId,
      name,
      phoneCount: unique.length,
    };
    if (duplicateCount > 0) response.duplicateCount = duplicateCount;
    return reply.code(201).send(response);
  });

  /** List the app's groups, newest first, keyset-paginated (created_at:id cursor). */
  app.get("/v5/contact-groups", { preHandler: [app.requireApp] }, async (request) => {
    const query = asRecord(request.query) ?? {};
    const limitRaw = query.limit;
    const limitNum =
      typeof limitRaw === "number"
        ? limitRaw
        : typeof limitRaw === "string" && /^\d+$/.test(limitRaw)
          ? Number.parseInt(limitRaw, 10)
          : NaN;
    const limit = Number.isInteger(limitNum) && limitNum >= 1 ? Math.min(limitNum, LIST_MAX) : LIST_DEFAULT;
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
        "SELECT id, name, phone_count, created_at, updated_at FROM contact_groups WHERE app_id = ? " +
          "AND (? IS NULL OR created_at < ? OR (created_at = ? AND id > ?)) " +
          "ORDER BY created_at DESC, id ASC LIMIT ?",
      )
      .all(
        request.appRow!.id,
        cursorAt,
        cursorAt,
        cursorAt,
        cursorId,
        limit + 1,
      ) as GroupRow[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      ok: true,
      groups: page.map(publicGroup),
      nextCursor: hasMore
        ? `${page[page.length - 1]?.created_at ?? 0}:${page[page.length - 1]?.id ?? ""}`
        : null,
    };
  });

  /** Loads one group owned by the given app row, or null (404 at call site). */
  function loadOwnedGroup(appRowId: string, groupId: string): GroupRow | null {
    return (
      (db
        .prepare(
          "SELECT id, name, phone_count, created_at, updated_at FROM contact_groups WHERE id = ? AND app_id = ?",
        )
        .get(groupId, appRowId) as GroupRow | undefined) ?? null
    );
  }

  /** Group detail (members listed in E.164, insertion order). */
  app.get("/v5/contact-groups/:id", { preHandler: [app.requireApp] }, async (request, reply) => {
    const params = asRecord(request.params) ?? {};
    const groupId = asString(params.id, 64);
    if (groupId === null) return fail(reply, 400, "invalid_group_id", "groupId is required");
    const row = loadOwnedGroup(request.appRow!.id, groupId);
    if (!row) return fail(reply, 404, "group_not_found", "Contact group not found");
    const phones = db
      .prepare("SELECT phone FROM contact_group_phones WHERE group_id = ? ORDER BY added_at ASC, phone ASC")
      .all(groupId) as { phone: string }[];
    return { ok: true, group: { ...publicGroup(row), phones: phones.map((p) => p.phone) } };
  });

  /** Rename (v4 web parity). Renaming onto an existing name conflicts (409). */
  app.patch("/v5/contact-groups/:id", { preHandler: [app.requireApp] }, async (request, reply) => {
    const params = asRecord(request.params) ?? {};
    const groupId = asString(params.id, 64);
    if (groupId === null) return fail(reply, 400, "invalid_group_id", "groupId is required");
    const row = loadOwnedGroup(request.appRow!.id, groupId);
    if (!row) return fail(reply, 404, "group_not_found", "Contact group not found");

    const body = asRecord(request.body) ?? {};
    const name = asString(body.name, GROUP_NAME_MAX);
    if (name === null) {
      return fail(reply, 400, "invalid_group_name", "name is required (max 100 chars)");
    }
    const update = db.transaction((): string | null => {
      const dup = db
        .prepare("SELECT 1 FROM contact_groups WHERE app_id = ? AND name = ? AND id != ?")
        .get(request.appRow!.id, name, groupId);
      if (dup) return "group_name_exists";
      db.prepare("UPDATE contact_groups SET name = ?, updated_at = ? WHERE id = ?").run(
        name,
        Math.floor(Date.now() / 1000),
        groupId,
      );
      return null;
    });
    const conflict = update();
    if (conflict !== null) {
      return fail(reply, 409, conflict, `A contact group named "${name}" already exists for this app`);
    }
    return { ok: true, groupId, name };
  });

  /** Delete (phones cascade by FK). Campaigns keep their materialized recipients. */
  app.delete("/v5/contact-groups/:id", { preHandler: [app.requireApp] }, async (request, reply) => {
    const params = asRecord(request.params) ?? {};
    const groupId = asString(params.id, 64);
    if (groupId === null) return fail(reply, 400, "invalid_group_id", "groupId is required");
    const row = loadOwnedGroup(request.appRow!.id, groupId);
    if (!row) return fail(reply, 404, "group_not_found", "Contact group not found");
    db.prepare("DELETE FROM contact_groups WHERE id = ?").run(groupId);
    return { ok: true, groupId };
  });

  /**
   * Adds phones (v4 web "Manage Group"). Deduplicates against the group's
   * existing members and within the request; invalid E.164 is rejected.
   */
  app.post("/v5/contact-groups/:id/phones", { preHandler: [app.requireApp] }, async (request, reply) => {
    const params = asRecord(request.params) ?? {};
    const groupId = asString(params.id, 64);
    if (groupId === null) return fail(reply, 400, "invalid_group_id", "groupId is required");
    const row = loadOwnedGroup(request.appRow!.id, groupId);
    if (!row) return fail(reply, 404, "group_not_found", "Contact group not found");

    const body = asRecord(request.body) ?? {};
    if (!Array.isArray(body.phones)) {
      return fail(reply, 400, "invalid_phones", "phones must be an array of E.164 strings");
    }
    const phones = body.phones as unknown[];
    if (phones.length < 1) {
      return fail(reply, 400, "invalid_phones", "phones must contain at least 1 entry");
    }
    const invalid = phones.filter((p) => !isValidE164(p));
    if (invalid.length > 0) {
      return fail(reply, 400, "invalid_phones", "One or more phone numbers are not valid E.164 format");
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const add = db.transaction((): number => {
      const existing = new Set(
        (
          db
            .prepare("SELECT phone FROM contact_group_phones WHERE group_id = ?")
            .all(groupId) as { phone: string }[]
        ).map((r) => r.phone),
      );
      const { unique } = deduplicatePhones(phones as string[]);
      const insert = db.prepare(
        "INSERT OR IGNORE INTO contact_group_phones (group_id, phone, added_at) VALUES (?, ?, ?)",
      );
      let added = 0;
      for (const phone of unique) {
        if (existing.has(phone)) continue;
        insert.run(groupId, phone, nowSec);
        added += 1;
      }
      db.prepare(
        "UPDATE contact_groups SET phone_count = (SELECT COUNT(*) FROM contact_group_phones WHERE group_id = ?), " +
          "updated_at = ? WHERE id = ?",
      ).run(groupId, nowSec, groupId);
      return added;
    });
    const added = add();

    const duplicateCount = phones.length - added;
    const response: Record<string, unknown> = { ok: true, groupId, addedCount: added };
    if (duplicateCount > 0) response.duplicateCount = duplicateCount;
    return response;
  });

  /** Removes phones (unknown numbers are ignored — idempotent removal). */
  app.delete("/v5/contact-groups/:id/phones", { preHandler: [app.requireApp] }, async (request, reply) => {
    const params = asRecord(request.params) ?? {};
    const groupId = asString(params.id, 64);
    if (groupId === null) return fail(reply, 400, "invalid_group_id", "groupId is required");
    const row = loadOwnedGroup(request.appRow!.id, groupId);
    if (!row) return fail(reply, 404, "group_not_found", "Contact group not found");

    const body = asRecord(request.body) ?? {};
    if (!Array.isArray(body.phones)) {
      return fail(reply, 400, "invalid_phones", "phones must be an array of E.164 strings");
    }
    const phones = (body.phones as unknown[]).filter((p) => typeof p === "string");
    if (phones.length < 1) {
      return fail(reply, 400, "invalid_phones", "phones must contain at least 1 entry");
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const remove = db.transaction((): number => {
      let removed = 0;
      const del = db.prepare("DELETE FROM contact_group_phones WHERE group_id = ? AND phone = ?");
      for (const phone of phones) removed += del.run(groupId, phone).changes;
      db.prepare(
        "UPDATE contact_groups SET phone_count = (SELECT COUNT(*) FROM contact_group_phones WHERE group_id = ?), " +
          "updated_at = ? WHERE id = ?",
      ).run(groupId, nowSec, groupId);
      return removed;
    });
    const removed = remove();
    return { ok: true, groupId, removedCount: removed };
  });
};

export default contactGroupRoutes;
