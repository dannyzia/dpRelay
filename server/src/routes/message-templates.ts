/**
 * Message-template routes (M4 pass 3, PLAN §10). v4 stored messageTemplates
 * in Firestore (web client wrote directly — no server CRUD functions); v5
 * makes them first-class per-app entities behind the standard REST plane.
 *
 * Auth model (single choke point per plan §5): every route gates via
 * requireApp — v4 scoped templates to a Firebase uid; the v5 app credential
 * is the tenant scope.
 *
 * Template bodies are storage-only here: charset/length enforcement happens
 * when a body is actually sent, in the campaign-create path (v4 parity — the
 * web UI copied template.body into the message field and the campaign
 * validator checked it). The storage cap only guards against abuse.
 */
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { asRecord, asString } from "../services/parse.js";
import { newId } from "../services/crypto.js";

const TEMPLATE_NAME_MAX = 100;
/** Storage cap for a template body (enforcement lives in campaign create). */
const TEMPLATE_BODY_MAX = 1024;
/** List pagination cap (campaigns parity). */
const LIST_MAX = 100;
const LIST_DEFAULT = 20;

/** Rejects with the structured envelope. */
function fail(reply: FastifyReply, code: number, codeName: string, message: string): FastifyReply {
  return reply.code(code).send({ ok: false, error: message, code: codeName });
}

interface TemplateRow {
  id: string;
  name: string;
  body: string;
  created_at: number;
  updated_at: number;
}

function publicTemplate(row: TemplateRow) {
  return {
    templateId: row.id,
    name: row.name,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const messageTemplateRoutes: FastifyPluginAsync = async (app) => {
  const db = app.db;

  /**
   * Validates and returns template fields from a body, or null after sending
   * the structured error. At least one of name/body must be present.
   */
  function parseFields(
    reply: FastifyReply,
    body: Record<string, unknown>,
    requireAll: boolean,
  ): { name: string; body: string } | null {
    const hasName = body.name !== undefined;
    const hasBody = body.body !== undefined;
    if (requireAll && (!hasName || !hasBody)) {
      fail(reply, 400, "invalid_template", "name and body are required");
      return null;
    }
    if (!requireAll && !hasName && !hasBody) {
      fail(reply, 400, "invalid_template", "Provide name or body to update");
      return null;
    }
    let name = "";
    let bodyText = "";
    if (hasName) {
      const parsed = asString(body.name, TEMPLATE_NAME_MAX);
      if (parsed === null) {
        fail(reply, 400, "invalid_template_name", "name is required (max 100 chars)");
        return null;
      }
      name = parsed;
    }
    if (hasBody) {
      const parsed = asString(body.body, TEMPLATE_BODY_MAX);
      if (parsed === null) {
        fail(reply, 400, "invalid_template_body", `body is required (max ${TEMPLATE_BODY_MAX} chars)`);
        return null;
      }
      bodyText = parsed;
    }
    return { name, body: bodyText };
  }

  /** Creates a template (v4 web parity: {name, body}). Name is unique per app. */
  app.post("/v5/message-templates", { preHandler: [app.requireApp] }, async (request, reply) => {
    const body = asRecord(request.body) ?? {};
    const fields = parseFields(reply, body, true);
    if (fields === null) return;

    const nowSec = Math.floor(Date.now() / 1000);
    const templateId = newId();
    const create = db.transaction((): string | null => {
      const dup = db
        .prepare("SELECT 1 FROM message_templates WHERE app_id = ? AND name = ?")
        .get(request.appRow!.id, fields.name);
      if (dup) return "template_name_exists";
      db.prepare(
        "INSERT INTO message_templates (id, app_id, name, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(templateId, request.appRow!.id, fields.name, fields.body, nowSec, nowSec);
      return null;
    });
    const conflict = create();
    if (conflict !== null) {
      return fail(reply, 409, conflict, `A template named "${fields.name}" already exists for this app`);
    }

    app.log.info({ appId: request.appRow!.appId, templateId }, "message template created");
    return reply.code(201).send({ ok: true, templateId, name: fields.name });
  });

  /** List the app's templates, newest first, keyset-paginated (created_at:id cursor). */
  app.get("/v5/message-templates", { preHandler: [app.requireApp] }, async (request) => {
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
        "SELECT id, name, body, created_at, updated_at FROM message_templates WHERE app_id = ? " +
          "AND (? IS NULL OR created_at < ? OR (created_at = ? AND id > ?)) " +
          "ORDER BY created_at DESC, id ASC LIMIT ?",
      )
      .all(request.appRow!.id, cursorAt, cursorAt, cursorAt, cursorId, limit + 1) as TemplateRow[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      ok: true,
      templates: page.map(publicTemplate),
      nextCursor: hasMore
        ? `${page[page.length - 1]?.created_at ?? 0}:${page[page.length - 1]?.id ?? ""}`
        : null,
    };
  });

  /** Loads one template owned by the given app row, or null (404 at call site). */
  function loadOwnedTemplate(appRowId: string, templateId: string): TemplateRow | null {
    return (
      (db
        .prepare(
          "SELECT id, name, body, created_at, updated_at FROM message_templates WHERE id = ? AND app_id = ?",
        )
        .get(templateId, appRowId) as TemplateRow | undefined) ?? null
    );
  }

  /** Template detail. */
  app.get("/v5/message-templates/:id", { preHandler: [app.requireApp] }, async (request, reply) => {
    const params = asRecord(request.params) ?? {};
    const templateId = asString(params.id, 64);
    if (templateId === null) return fail(reply, 400, "invalid_template_id", "templateId is required");
    const row = loadOwnedTemplate(request.appRow!.id, templateId);
    if (!row) return fail(reply, 404, "template_not_found", "Message template not found");
    return { ok: true, template: publicTemplate(row) };
  });

  /** Rename and/or replace the body (v4 web parity). Name conflicts are 409. */
  app.patch("/v5/message-templates/:id", { preHandler: [app.requireApp] }, async (request, reply) => {
    const params = asRecord(request.params) ?? {};
    const templateId = asString(params.id, 64);
    if (templateId === null) return fail(reply, 400, "invalid_template_id", "templateId is required");
    const row = loadOwnedTemplate(request.appRow!.id, templateId);
    if (!row) return fail(reply, 404, "template_not_found", "Message template not found");

    const body = asRecord(request.body) ?? {};
    const fields = parseFields(reply, body, false);
    if (fields === null) return;

    const name = fields.name || row.name;
    const bodyText = fields.body || row.body;
    const update = db.transaction((): string | null => {
      const dup = db
        .prepare("SELECT 1 FROM message_templates WHERE app_id = ? AND name = ? AND id != ?")
        .get(request.appRow!.id, name, templateId);
      if (dup) return "template_name_exists";
      db.prepare("UPDATE message_templates SET name = ?, body = ?, updated_at = ? WHERE id = ?").run(
        name,
        bodyText,
        Math.floor(Date.now() / 1000),
        templateId,
      );
      return null;
    });
    const conflict = update();
    if (conflict !== null) {
      return fail(reply, 409, conflict, `A template named "${name}" already exists for this app`);
    }
    return { ok: true, templateId, name };
  });

  /** Delete. Campaigns keep their materialized message text (snapshot at create). */
  app.delete("/v5/message-templates/:id", { preHandler: [app.requireApp] }, async (request, reply) => {
    const params = asRecord(request.params) ?? {};
    const templateId = asString(params.id, 64);
    if (templateId === null) return fail(reply, 400, "invalid_template_id", "templateId is required");
    const row = loadOwnedTemplate(request.appRow!.id, templateId);
    if (!row) return fail(reply, 404, "template_not_found", "Message template not found");
    db.prepare("DELETE FROM message_templates WHERE id = ?").run(templateId);
    return { ok: true, templateId };
  });
};

export default messageTemplateRoutes;
