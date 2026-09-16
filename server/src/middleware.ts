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
        "SELECT d.id, d.user_id, d.label, d.api_key_hash, d.revocable, d.revoked_at " +
          "FROM devices d WHERE d.api_key_hash = ?",
      )
      .get(digest) as
      | {
          id: string;
          user_id: string;
          label: string;
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
    };
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
        "SELECT id, app_id, app_secret_hash, name, webhook_url, webhook_secret_hash, " +
          "rate_max_per_phone, rate_window_sec, revoked_at FROM apps WHERE app_id = ?",
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
