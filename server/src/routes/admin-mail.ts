/**
 * STAGE F3 amendment (ISSUE-82): operator-configured SMTP settings.
 * Owner decision (hub event 1210): the panel owns ALL mail details — stored
 * in the DB, never env vars. The password is WRITE-ONLY: PUT accepts it,
 * GET masks it (`••••`, only host/port/from visible), and the ciphertext is
 * the only form that ever touches disk.
 */
import type { FastifyPluginAsync } from "fastify";
import { encryptMailSecret, getMailConfigView, isMailConfigured, sendMail } from "../services/mailer.js";

/** RFC 5322-lite (same rule as the auth routes). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface MailConfigPutBody {
  host?: unknown;
  port?: unknown;
  username?: unknown;
  password?: unknown;
  fromAddress?: unknown;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

const adminMailRoutes: FastifyPluginAsync = async (app) => {
  /** GET: masked view — never username, never the password (ordered). */
  app.get("/v5/admin/mail-config", { preHandler: [app.requireOperator] }, async () => {
    return { ok: true, ...getMailConfigView(app.db) };
  });

  /**
   * PUT: upsert the config. `password` omitted/empty KEEPS the stored one
   * (write-only semantics: the panel cannot read it back, only replace it).
   */
  app.put("/v5/admin/mail-config", { preHandler: [app.requireOperator] }, async (request, reply) => {
    const body = (request.body ?? {}) as MailConfigPutBody;
    if (!isNonEmptyString(body.host) || body.host.trim().length === 0 || body.host.length > 255) {
      return reply.code(400).send({ ok: false, error: "host is required (max 255 chars)", code: "invalid_mail_config" });
    }
    const port = body.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      return reply.code(400).send({ ok: false, error: "port must be 1-65535", code: "invalid_mail_config" });
    }
    if (!isNonEmptyString(body.username) || body.username.length > 255) {
      return reply.code(400).send({ ok: false, error: "username is required", code: "invalid_mail_config" });
    }
    if (!isNonEmptyString(body.fromAddress) || !EMAIL_RE.test(body.fromAddress.trim())) {
      return reply.code(400).send({ ok: false, error: "fromAddress must be an email", code: "invalid_mail_config" });
    }

    const existing = app.db
      .prepare("SELECT password_encrypted FROM mail_config WHERE id = 1")
      .get() as { password_encrypted: string } | undefined;
    const nextPassword =
      isNonEmptyString(body.password) && body.password.length > 0 ? body.password : existing?.password_encrypted;
    if (nextPassword === undefined) {
      return reply.code(400).send({ ok: false, error: "password is required on first save", code: "invalid_mail_config" });
    }
    const encrypted =
      typeof nextPassword === "string" && nextPassword === existing?.password_encrypted
        ? nextPassword
        : encryptMailSecret(nextPassword, app.config.jwtSecret);

    app.db
      .prepare(
        "INSERT INTO mail_config (id, host, port, username, password_encrypted, from_address, updated_at) " +
          "VALUES (1, ?, ?, ?, ?, ?, unixepoch()) " +
          "ON CONFLICT(id) DO UPDATE SET host = excluded.host, port = excluded.port, " +
          "username = excluded.username, password_encrypted = excluded.password_encrypted, " +
          "from_address = excluded.from_address, updated_at = excluded.updated_at",
      )
      .run(body.host.trim(), port, body.username.trim(), encrypted, body.fromAddress.trim());

    app.log.info({ host: body.host.trim(), port, from: body.fromAddress.trim() }, "mail config saved");
    return reply.code(200).send({ ok: true, ...getMailConfigView(app.db) });
  });

  /** POST: the operator's "does it work" button — one real email to the given address. */
  app.post("/v5/admin/mail-config/test", { preHandler: [app.requireOperator] }, async (request, reply) => {
    const body = (request.body ?? {}) as { to?: unknown };
    if (!isNonEmptyString(body.to) || !EMAIL_RE.test(body.to.trim())) {
      return reply.code(400).send({ ok: false, error: "to must be an email address", code: "invalid_request" });
    }
    if (!isMailConfigured(app.db)) {
      return reply.code(409).send({
        ok: false,
        error: "Save the mail settings first — nothing is configured yet",
        code: "mail_not_configured",
      });
    }
    try {
      await sendMail(
        app.db,
        app.config.jwtSecret,
        body.to.trim(),
        "dP Relay — mail settings test",
        "This is a test email from the dP Relay operator panel. If you can read this, SMTP works.",
      );
    } catch (err) {
      app.log.warn({ err }, "mail test send failed");
      return reply.code(502).send({
        ok: false,
        error: "SMTP send failed — check the settings and try again",
        code: "mail_send_failed",
      });
    }
    return reply.code(200).send({ ok: true });
  });
};

export default adminMailRoutes;
