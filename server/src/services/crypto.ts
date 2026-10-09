/**
 * Cryptographic primitives for M1 auth — clean-room implementation using Node's
 * crypto module and the argon2 package only. Security-sensitive: comparison must
 * always be constant-time (mirrors AuthCrypto.constantTimeEquals() policy).
 */
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
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
 * Generates a new app webhook secret.
 * 32 random bytes, hex-encoded — same entropy policy as device API keys.
 * @returns Raw secret for the provisioning response ONLY; the server also
 *          persists the plaintext (it signs HMAC deliveries — migration 005)
 *          plus its SHA-256 hash for verifier-side comparison.
 */
export function generateWebhookSecret(): string {
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
 * HMAC-SHA256 signature over a webhook raw body.
 * @param secret The app's plaintext webhook secret (apps.webhook_secret).
 * @param body The exact request body bytes that will be sent.
 * @returns Hex-encoded digest for the X-DP-Signature header.
 */
export function hmacSha256Hex(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
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

// ---------------------------------------------------------------------------
// STAGE F3 (ISSUE-81): customer-dashboard password hashing + app credentials.
// scrypt is the owner-ordered primitive (node:crypto, no new dependency).
// ---------------------------------------------------------------------------

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** OWASP Password Storage Cheat Sheet scrypt minimums: N=2^15, r=8, p=1. */
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
/** Node's default maxmem (32 MiB) sits exactly at 128*N*r — give it headroom. */
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2;
/** Encoded form: scrypt:N=<n>,r=<r>,p=<p>:<saltHex>:<hashHex>. */
const SCRYPT_RE = /^scrypt:N=(\d+),r=(\d+),p=(\d+):([0-9a-f]+):([0-9a-f]+)$/;

/**
 * Hashes a password with scrypt (F3 customer auth). Argon2id remains valid for
 * hashes minted by the M1 flow — verification dispatches on the stored format.
 * @param password Plain-text password (never logged, never persisted).
 * @returns Format-prefixed string for storage in users.password_hash.
 */
export async function hashPasswordScrypt(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt:N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}:${salt.toString("hex")}:${derived.toString("hex")}`;
}

/**
 * Verifies a password against a stored scrypt hash. The stored parameters are
 * honored (bounded to sane limits) so future cost bumps verify old hashes.
 * @param stored Format-prefixed scrypt string from users.password_hash.
 * @param password Plain-text candidate password.
 */
export async function verifyPasswordScrypt(stored: string, password: string): Promise<boolean> {
  const match = SCRYPT_RE.exec(stored);
  if (!match) return false;
  const n = Number(match[1]);
  const r = Number(match[2]);
  const p = Number(match[3]);
  // Reject absurd stored parameters (a tampered row must not become a DoS lever).
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (n < 1024 || n > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;
  const expected = Buffer.from(match[5], "hex");
  if (expected.length === 0 || expected.length > 128) return false;
  const actual = await scryptAsync(password, Buffer.from(match[4], "hex"), expected.length, {
    N: n,
    r,
    p,
    maxmem: 128 * n * r * 2,
  });
  return timingSafeEqual(expected, actual);
}

/**
 * Dispatches password verification on the stored hash format: `scrypt:` →
 * scrypt, anything else → the M1 Argon2id verifier (PHC). Both paths are
 * constant-time at the comparison layer.
 * @param stored users.password_hash (Argon2 PHC or format-prefixed scrypt).
 * @param password Plain-text candidate password.
 */
export async function verifyStoredPassword(stored: string, password: string): Promise<boolean> {
  if (stored.startsWith("scrypt:")) return verifyPasswordScrypt(stored, password);
  return verifyPassword(stored, password);
}

/**
 * Generates self-serve app credentials (F3). Same entropy policy as device
 * API keys / webhook secrets (32 random bytes, hex) for the secret; the appId
 * is a public identifier matching the operator route's [A-Za-z0-9_-]{3,64} rule.
 * @returns Raw credentials for the ONE response that ever carries them — the
 *          server persists only sha256(appSecret).
 */
export function generateAppCredentials(): { appId: string; appSecret: string } {
  return {
    appId: `app_${randomBytes(16).toString("base64url")}`,
    appSecret: randomBytes(DEVICE_KEY_BYTES).toString("hex"),
  };
}
