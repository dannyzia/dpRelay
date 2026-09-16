import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import jwt from "@fastify/jwt";
import type { Config } from "../config.js";
import { generateDeviceApiKey, constantTimeEquals, sha256Hex, verifyPassword } from "./crypto.js";

/** Row shape of refresh_tokens used for rotation/validation. */
export interface RefreshTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: number;
  revoked_at: number | null;
}

declare module "fastify" {
  interface FastifyInstance {
    /** Mints a signed access-token JWT for the given user. */
    mintAccessToken(user: { id: string; email: string }): string;
    /**
     * Creates a refresh-token session row (hashed) and returns the raw token.
     * Raw token is returned exactly once; only its SHA-256 digest is persisted.
     */
    createRefreshToken(userId: string, ttlSec: number): string;
    /**
     * Validates a raw refresh token: checks hash, expiry, and revocation.
     * @returns The token row when valid, null when unknown/expired/revoked.
     */
    peekRefreshToken(rawToken: string): RefreshTokenRow | null;
    /** Revokes a refresh-token session by row id (used on rotation). */
    revokeRefreshToken(tokenId: string): void;
    /**
     * Verifies an email/password pair against users (Argon2).
     * @returns The user row when credentials match; null otherwise.
     */
    authenticateUser(
      email: string,
      password: string,
    ): Promise<{ id: string; email: string; password_hash: string } | null>;
    /** Constant-time digest comparison (see services/crypto.ts). */
    constantTimeEquals(a: string, b: string): boolean;
    /** SHA-256 hex digest for secret material (see services/crypto.ts). */
    sha256Hex(secret: string): string;
    /** Generates a new 32-byte device API key (hex); raw value never persisted. */
    generateDeviceApiKey(): string;
  }
}

/**
 * Registers @fastify/jwt and exposes token/session helpers on the instance.
 * Wrapped in fastify-plugin so the decorators land in the same encapsulation
 * context as the routes and middleware that need them.
 */
const authServicePlugin: FastifyPluginAsync<{ config: Config }> = async (app, opts) => {
  const { config } = opts;

  await app.register(jwt, {
    secret: config.jwtSecret,
    sign: { expiresIn: config.accessTokenTtlSec },
  });

  app.decorate("mintAccessToken", (user: { id: string; email: string }): string =>
    app.jwt.sign({ sub: user.id, email: user.email }),
  );

  app.decorate("createRefreshToken", (userId: string, ttlSec: number): string => {
    // 48 random bytes ≈ 384 bits of entropy — no dictionary/guessability concerns.
    const raw = randomBytes(48).toString("hex");
    app.db
      .prepare(
        "INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at) " +
          "VALUES (?, ?, ?, ?, unixepoch())",
      )
      .run(randomUUID(), userId, sha256Hex(raw), Math.floor(Date.now() / 1000) + ttlSec);
    return raw;
  });

  app.decorate("peekRefreshToken", (rawToken: string): RefreshTokenRow | null => {
    const row = app.db
      .prepare("SELECT id, user_id, token_hash, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = ?")
      .get(sha256Hex(rawToken)) as RefreshTokenRow | undefined;
    if (!row) return null;
    const nowSec = Date.now() / 1000;
    if (row.revoked_at !== null || row.expires_at <= nowSec) return null;
    return row;
  });

  app.decorate("revokeRefreshToken", (tokenId: string): void => {
    app.db
      .prepare("UPDATE refresh_tokens SET revoked_at = unixepoch() WHERE id = ? AND revoked_at IS NULL")
      .run(tokenId);
  });

  app.decorate("authenticateUser", async (
    email: string,
    password: string,
  ): Promise<{ id: string; email: string; password_hash: string } | null> => {
    const row = app.db
      .prepare("SELECT id, email, password_hash FROM users WHERE email = ?")
      .get(email.trim().toLowerCase()) as
      | { id: string; email: string; password_hash: string }
      | undefined;
    if (!row) {
      // Burn a verification against a dummy hash to flatten the user-enumeration timing oracle.
      await verifyPassword(
        "$argon2id$v=19$m=19456,t=2,p=1$fakefakefakefakefake$fakefakefakefakefakefakefake",
        password,
      ).catch(() => false);
      return null;
    }
    const ok = await verifyPassword(row.password_hash, password);
    return ok ? row : null;
  });

  app.decorate("constantTimeEquals", constantTimeEquals);
  app.decorate("sha256Hex", sha256Hex);
  app.decorate("generateDeviceApiKey", generateDeviceApiKey);
};

export default fp(authServicePlugin, { name: "auth-service" });
