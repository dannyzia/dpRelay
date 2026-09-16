/**
 * Device plane routes (M1): registration (JWT-authenticated) and heartbeat
 * (device-key-authenticated). The raw API key is returned exactly once at
 * registration; only its SHA-256 hash is ever stored.
 */
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { newId } from "../services/crypto.js";

interface DeviceRegisterBody {
  label?: unknown;
}

const deviceRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Registers a device for the JWT-authenticated caller and issues its API key.
   * The raw key appears in this response ONLY — the DB stores the SHA-256 hash.
   */
  app.post("/v5/device/register", { onRequest: [app.requireAuth] }, async (request, reply) => {
    const body = (request.body ?? {}) as DeviceRegisterBody;
    const label =
      typeof body.label === "string" && body.label.trim().length > 0
        ? body.label.trim().slice(0, 128)
        : "unnamed device";

    const user = (request as FastifyRequest & { user?: { id: string; email: string } }).user;
    if (!user) {
      // Unreachable: requireAuth guarantees the JWT subject, but keep the invariant explicit.
      return reply.code(401).send({ ok: false, error: "Authentication required", code: "missing_bearer_token" });
    }

    const rawKey = app.generateDeviceApiKey();
    const deviceId = newId();
    app.db
      .prepare(
        "INSERT INTO devices (id, user_id, label, api_key_hash, last_seen_at, revocable, revoked_at, created_at) " +
          "VALUES (?, ?, ?, ?, NULL, 1, NULL, unixepoch())",
      )
      .run(deviceId, user.id, label, app.sha256Hex(rawKey));

    return reply.code(201).send({ ok: true, deviceId, apiKey: rawKey });
  });

  /**
   * Phone heartbeat (R1): updates devices.last_seen_at; the watchdog job reads it.
   * Authenticated via device API key through the requireDevice choke point.
   */
  app.post("/v5/device/heartbeat", { onRequest: [app.requireDevice] }, async (request, reply) => {
    app.db
      .prepare("UPDATE devices SET last_seen_at = unixepoch() WHERE id = ?")
      .run(request.device!.id);
    return reply.code(200).send({ ok: true, heartbeat: "received" });
  });
};

export default deviceRoutes;
