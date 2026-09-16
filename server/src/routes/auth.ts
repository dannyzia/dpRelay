/**
 * User-plane auth routes (M1): register, login, refresh.
 * All failures return the structured { ok: false, error, code } envelope.
 */
import type { FastifyPluginAsync } from "fastify";
import { newId, hashPassword } from "../services/crypto.js";

/** RFC 5322-lite email shape: local@domain.tld, no spaces. Full validation is deliverability, not syntax. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** NIST SP 800-63B: min 8; we cap at 128 to bound Argon2 work per request. */
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

interface RegisterBody {
  email?: unknown;
  password?: unknown;
}
interface LoginBody {
  email?: unknown;
  password?: unknown;
}
interface RefreshBody {
  refreshToken?: unknown;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

const authRoutes: FastifyPluginAsync = async (app) => {
  app.post("/v5/auth/register", async (request, reply) => {
    const body = (request.body ?? {}) as RegisterBody;
    const { email, password } = body;

    if (!isNonEmptyString(email) || !EMAIL_RE.test(email.trim())) {
      return reply.code(400).send({ ok: false, error: "Valid email required", code: "invalid_email" });
    }
    if (!isNonEmptyString(password) || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
      return reply.code(400).send({
        ok: false,
        error: `Password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters`,
        code: "invalid_password",
      });
    }

    const normalized = email.trim().toLowerCase();
    const existing = app.db.prepare("SELECT id FROM users WHERE email = ?").get(normalized);
    if (existing) {
      return reply.code(409).send({ ok: false, error: "Email already registered", code: "email_taken" });
    }

    const passwordHash = await hashPassword(password);
    app.db
      .prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, unixepoch())")
      .run(newId(), normalized, passwordHash);

    return reply.code(201).send({ ok: true });
  });

  app.post("/v5/auth/login", async (request, reply) => {
    const body = (request.body ?? {}) as LoginBody;
    const { email, password } = body;
    if (!isNonEmptyString(email) || !isNonEmptyString(password)) {
      return reply.code(400).send({
        ok: false,
        error: "email and password are required",
        code: "invalid_request",
      });
    }

    const user = await app.authenticateUser(email, password);
    if (!user) {
      return reply.code(401).send({ ok: false, error: "Invalid credentials", code: "invalid_credentials" });
    }

    const accessToken = app.mintAccessToken({ id: user.id, email: user.email });
    const refreshToken = app.createRefreshToken(user.id, app.config.refreshTokenTtlSec);
    return reply.code(200).send({ ok: true, accessToken, refreshToken });
  });

  app.post("/v5/auth/refresh", async (request, reply) => {
    const body = (request.body ?? {}) as RefreshBody;
    const { refreshToken } = body;
    if (!isNonEmptyString(refreshToken)) {
      return reply.code(400).send({
        ok: false,
        error: "refreshToken is required",
        code: "invalid_request",
      });
    }

    const row = app.peekRefreshToken(refreshToken);
    if (!row) {
      return reply.code(401).send({
        ok: false,
        error: "Invalid, expired, or revoked refresh token",
        code: "invalid_refresh_token",
      });
    }

    // Rotation: the presented token is single-use — revoke it, issue a fresh pair.
    app.revokeRefreshToken(row.id);

    const user = app.db.prepare("SELECT id, email FROM users WHERE id = ?").get(row.user_id) as
      | { id: string; email: string }
      | undefined;
    if (!user) {
      return reply.code(401).send({
        ok: false,
        error: "User no longer exists",
        code: "invalid_refresh_token",
      });
    }

    const accessToken = app.mintAccessToken(user);
    const newRefreshToken = app.createRefreshToken(user.id, app.config.refreshTokenTtlSec);
    return reply.code(200).send({ ok: true, accessToken, refreshToken: newRefreshToken });
  });
};

export default authRoutes;
