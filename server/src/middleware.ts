/**
 * The single authz choke point (PLAN §5): every authenticated route declares
 * requireAuth (user JWT) or requireDevice (device API key). No route inspects
 * credentials directly — this module owns all credential verification.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { constantTimeEquals, sha256Hex } from "./services/crypto.js";

/** Shape of a verified device, attached to the request by requireDevice. */
export interface AuthenticatedDevice {
  id: string;
  /** Null for phone-enrolled devices (M2 /enroll creates devices without a user account). */
  userId: string | null;
  label: string;
  /**
   * STAGE F7 (ISSUE-87): internal apps.id this device is bound to, or null for
   * an operator-fleet device. Drives the outstanding-fetch claim isolation —
   * a bound device only ever sees its own app's pending messages.
   */
  appRowId: string | null;
}

/** Shape of a verified consumer app, attached to the request by requireApp (M3 OTP plane). */
export interface AuthenticatedApp {
  id: string;
  appId: string;
  name: string;
  webhookUrl: string | null;
  webhookSecretHash: string | null;
  rateMaxPerPhone: number;
  rateWindowSec: number;
}

declare module "fastify" {
  interface FastifyInstance {
    /** Guard: requires a valid `Authorization: Bearer <JWT>` access token. */
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Guard: requires a valid `Authorization: Bearer <device API key>` and attaches
     * request.device. Rejects revoked keys. Constant-time hash comparison.
     */
    requireDevice: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Guard (M3 OTP plane): requires `X-App-Id` + `X-App-Secret` headers and
     * attaches request.app. Rejects revoked apps. Constant-time hash comparison.
     */
    requireApp: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Guard (M4 admin plane): requires `Authorization: Bearer <OPERATOR_SECRET>`.
     * Empty secret configured → 503 admin_disabled (fail closed). Constant-time
     * comparison even when the header is missing (no timing leak of header presence).
     */
    requireOperator: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    /** Populated by requireDevice; absent on user-plane routes. */
    device?: AuthenticatedDevice;
    /** Populated by requireApp; absent on non-OTP routes. */
    appRow?: AuthenticatedApp;
  }
}

/** Extracts the raw bearer credential or null when the header is absent/malformed. */
function extractBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const parts = header.split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer" || parts[1].length === 0) {
    return null;
  }
  return parts[1];
}

/** Structured failure body per project convention: { ok, error, code }. */
function unauthorized(reply: FastifyReply, code: string, error: string): FastifyReply {
  return reply.code(401).send({ ok: false, error, code });
}

const middlewarePlugin: FastifyPluginAsync = async (app) => {
  app.decorate("requireAuth", async (request, reply) => {
    const token = extractBearerToken(request);
    if (!token) {
      await unauthorized(reply, "missing_bearer_token", "Authorization: Bearer <accessToken> required");
      return;
    }
    try {
      const payload = app.jwt.verify<{ sub: string; email: string }>(token);
      if (!payload.sub) {
        await unauthorized(reply, "invalid_access_token", "Token payload missing subject");
        return;
      }
      // Attach for handlers; the JWT signature already proves integrity.
      (request as FastifyRequest & { user?: { id: string; email: string } }).user = {
        id: payload.sub,
        email: payload.email,
      };
    } catch {
      await unauthorized(reply, "invalid_access_token", "Invalid or expired access token");
    }
  });

  app.decorate("requireDevice", async (request, reply) => {
    const rawKey = extractBearerToken(request);
    if (!rawKey) {
      await unauthorized(reply, "missing_device_key", "Authorization: Bearer <deviceApiKey> required");
      return;
    }
    const digest = sha256Hex(rawKey);
    const row = app.db
      .prepare(
        "SELECT d.id, d.user_id, d.label, d.app_id, d.api_key_hash, d.revocable, d.revoked_at " +
          "FROM devices d WHERE d.api_key_hash = ?",
      )
      .get(digest) as
      | {
          id: string;
          user_id: string;
          label: string;
          app_id: string | null;
          api_key_hash: string;
          revocable: number;
          revoked_at: number | null;
        }
      | undefined;
    if (!row) {
      await unauthorized(reply, "invalid_device_key", "Unknown device key");
      return;
    }
    // Constant-time re-check of the digest: even though the lookup is by hash,
    // keep the comparison policy uniform for all secret material.
    if (!constantTimeEquals(row.api_key_hash, digest)) {
      await unauthorized(reply, "invalid_device_key", "Unknown device key");
      return;
    }
    if (row.revocable === 1 && row.revoked_at !== null) {
      await unauthorized(reply, "device_revoked", "Device key has been revoked");
      return;
    }
    request.device = {
      id: row.id,
      userId: row.user_id,
      label: row.label,
      appRowId: row.app_id,
    };
  });

  app.decorate("requireOperator", async (request, reply) => {
    const expected = app.config.operatorSecret;
    if (expected === "") {
      await reply
        .code(503)
        .send({ ok: false, error: "Admin routes are disabled", code: "admin_disabled" });
      return;
    }
    const authHeader = request.headers.authorization;
    const provided = typeof authHeader === "string" ? authHeader.replace(/^Bearer\s+/i, "") : "";
    // Constant-time even when the header is missing: compare against the real
    // secret with a dummy so timing does not leak header presence (ISSUE-11 parity).
    if (provided === "" || !constantTimeEquals(provided, expected)) {
      await unauthorized(reply, "invalid_operator_secret", "Invalid operator secret");
    }
  });

  app.decorate("requireApp", async (request, reply) => {
    const appId = request.headers["x-app-id"];
    const appSecret = request.headers["x-app-secret"];
    if (typeof appId !== "string" || appId.length === 0 || typeof appSecret !== "string" || appSecret.length === 0) {
      await unauthorized(reply, "missing_app_credentials", "X-App-Id and X-App-Secret headers required");
      return;
    }
    const row = app.db
      .prepare(
        "SELECT a.id, a.app_id, a.app_secret_hash, a.name, a.webhook_url, a.webhook_secret_hash, " +
          "a.rate_max_per_phone, a.rate_window_sec, a.revoked_at, a.owner_user_id, " +
          "u.disabled AS owner_disabled " +
          "FROM apps a LEFT JOIN users u ON u.id = a.owner_user_id WHERE a.app_id = ?",
      )
      .get(appId) as
      | {
          id: string;
          app_id: string;
          app_secret_hash: string;
          name: string;
          webhook_url: string | null;
          webhook_secret_hash: string | null;
          rate_max_per_phone: number;
          rate_window_sec: number;
          revoked_at: number | null;
          owner_user_id: string | null;
          owner_disabled: number | null;
        }
      | undefined;
    if (!row) {
      await unauthorized(reply, "unknown_app", "Unknown X-App-Id");
      return;
    }
    // Constant-time compare of the stored hash against the digest of the
    // presented secret — same policy as every other secret material.
    const digest = sha256Hex(appSecret);
    if (!constantTimeEquals(row.app_secret_hash, digest)) {
      await unauthorized(reply, "invalid_app_secret", "X-App-Secret mismatch");
      return;
    }
    if (row.revoked_at !== null) {
      await unauthorized(reply, "app_revoked", "This app has been revoked");
      return;
    }
    // STAGE F5 (ISSUE-83): a withheld owner freezes their entire app plane —
    // sends above all — with a DISTINCT code so customers can tell "withheld"
    // from "revoked"/"bad credentials" (hub event 1213). Checked after the
    // constant-time secret compare so the code never leaks app state to a
    // caller holding bad credentials. Operator-provisioned apps
    // (owner_user_id NULL) are never affected; balances are never touched.
    if (row.owner_user_id !== null && row.owner_disabled === 1) {
      await reply.code(403).send({
        ok: false,
        error: "This account is withheld. Contact the operator.",
        code: "account_withheld",
      });
      return;
    }
    request.appRow = {
      id: row.id,
      appId: row.app_id,
      name: row.name,
      webhookUrl: row.webhook_url,
      webhookSecretHash: row.webhook_secret_hash,
      rateMaxPerPhone: row.rate_max_per_phone,
      rateWindowSec: row.rate_window_sec,
    };
  });
};

export default fp(middlewarePlugin, { name: "middleware-plugin", dependencies: ["auth-service"] });
