/**
 * Cryptographic primitives for M1 auth — clean-room implementation using Node's
 * crypto module and the argon2 package only. Security-sensitive: comparison must
 * always be constant-time (mirrors AuthCrypto.constantTimeEquals() policy).
 */
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import argon2 from "argon2";

/** Argon2id parameters: OWASP-recommended min configuration for interactive logins. */
const ARGON2_PARAMS = {
  type: argon2.argon2id,
  memoryCost: 19456, // KiB (~19 MiB)
  timeCost: 2,
  parallelism: 1,
} as const;

/** Device API keys are 32 random bytes, hex-encoded (64 chars). */
const DEVICE_KEY_BYTES = 32;

/**
 * Hashes a password with Argon2id.
 * @param password Plain-text password (never logged, never persisted).
 * @returns PHC-format encoded hash for storage in users.password_hash.
 */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_PARAMS);
}

/**
 * Verifies a password against a stored Argon2 hash in constant time (library-side).
 * @param hash PHC-format encoded hash from users.password_hash.
 * @param password Plain-text candidate password.
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password);
}

/**
 * Generates a new device API key.
 * @returns Hex-encoded key; must be returned to the caller exactly once and never persisted raw.
 */
export function generateDeviceApiKey(): string {
  return randomBytes(DEVICE_KEY_BYTES).toString("hex");
}

/**
 * SHA-256 hex digest used to store device keys and refresh tokens.
 * @param secret Raw secret material (device key, refresh token).
 */
export function sha256Hex(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * Constant-time equality check for secret material or its digests.
 * Never use === / equals() for HMACs, keys, or token comparisons.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Still burn a comparison on unequal lengths to flatten the length-oracle.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * @returns A fresh UUID (RFC 4122 v4) for row primary keys.
 */
export function newId(): string {
  return randomUUID();
}
