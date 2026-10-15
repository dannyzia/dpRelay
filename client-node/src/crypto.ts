/**
 * End-to-end payload encryption (ISSUE-120) for the general / bulk SMS plane.
 *
 * The server is a pass-through here: it relays the envelope opaquely and the
 * Android gateway decrypts before handing plaintext to SmsManager. The OTP
 * plane is structurally excluded — the server must read OTP challenges to
 * verify them and meter credits.
 *
 * Wire specification (shared with `E2eeDecryptor` on the gateway):
 * - Algorithm: AES-256-GCM, 12-byte IV, 16-byte auth tag.
 * - Envelope: `e2ee:v1:<base64(iv + tag + ciphertext)>`.
 * - Key: PBKDF2-HMAC-SHA256, 100,000 iterations, salt `dprelay:e2ee:salt`,
 *   32-byte output for string passphrases — or a caller-supplied 32-byte raw
 *   key (Uint8Array). Strings always derive; bytes are never stretched.
 *
 * Only `node:crypto` is used, so the SDK keeps its zero-runtime-dependency
 * guarantee.
 */
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";

import { DpRelayError, ValidationError } from "./errors.js";

/** Envelope prefix identifying an E2EE v1 payload on the wire. */
export const E2EE_PREFIX = "e2ee:v1:";

/** PBKDF2-HMAC-SHA256 iteration count from the wire spec. */
export const E2EE_PBKDF2_ITERATIONS = 100_000;

/** PBKDF2 salt from the wire spec (UTF-8 bytes). */
export const E2EE_PBKDF2_SALT = "dprelay:e2ee:salt";

/** AES-256-GCM nonce length in bytes. */
export const E2EE_IV_BYTES = 12;

/** AES-256-GCM auth tag length in bytes. */
export const E2EE_TAG_BYTES = 16;

/** AES-256 key length in bytes. */
export const E2EE_KEY_BYTES = 32;

/**
 * Authentication failure while opening an envelope: corrupt tag, wrong key,
 * or truncated payload. `statusCode` is null — the failure is local, no
 * server was involved, so a retry with the same key cannot help but a retry
 * with the correct key can.
 */
export class DecryptionError extends DpRelayError {
  constructor(message: string) {
    super(message, "decryption_failed", null);
    this.name = "DecryptionError";
  }
}

/**
 * A passphrase (string, stretched with PBKDF2) or a raw 32-byte key.
 * Strings always derive — a string is never used as key material directly —
 * so `"correct horse"` on the backend matches the same passphrase on the
 * gateway's `E2eeDecryptor`, which only accepts strings.
 */
export type E2eeKeyInput = string | Uint8Array;

/**
 * Resolves caller key material to a 32-byte AES key.
 *
 * @throws {ValidationError} when a byte key is not exactly 32 bytes.
 */
export function deriveE2eeKey(keyOrPassphrase: E2eeKeyInput): Buffer {
  if (typeof keyOrPassphrase === "string") {
    return pbkdf2Sync(
      keyOrPassphrase,
      E2EE_PBKDF2_SALT,
      E2EE_PBKDF2_ITERATIONS,
      E2EE_KEY_BYTES,
      "sha256",
    );
  }
  if (keyOrPassphrase.byteLength !== E2EE_KEY_BYTES) {
    throw new ValidationError(
      `raw E2EE key must be exactly ${E2EE_KEY_BYTES} bytes, got ${keyOrPassphrase.byteLength}`,
      "invalid_key_length",
      null,
    );
  }
  return Buffer.from(keyOrPassphrase);
}

/** True when `body` carries an E2EE v1 envelope (gateway pre-check). */
export function isE2eeEnvelope(body: string): boolean {
  return body.startsWith(E2EE_PREFIX);
}

/**
 * Encrypts a plaintext message into a transmittable E2EE v1 envelope.
 * A fresh random IV per call means identical plaintexts encrypt differently.
 */
export function encryptMessage(plaintext: string, keyOrPassphrase: E2eeKeyInput): string {
  const key = deriveE2eeKey(keyOrPassphrase);
  const iv = randomBytes(E2EE_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${E2EE_PREFIX}${Buffer.concat([iv, tag, ciphertext]).toString("base64")}`;
}

/**
 * Opens an E2EE v1 envelope back to plaintext.
 *
 * @throws {ValidationError} when the envelope prefix, base64, or framing is malformed.
 * @throws {DecryptionError} when authentication fails (wrong key, corrupt tag,
 * truncated payload) — fail closed, never partial plaintext.
 */
export function decryptMessage(envelope: string, keyOrPassphrase: E2eeKeyInput): string {
  if (!isE2eeEnvelope(envelope)) {
    throw new ValidationError(
      `E2EE envelope must start with ${JSON.stringify(E2EE_PREFIX)}`,
      "invalid_envelope",
      null,
    );
  }
  // Buffer.from(x, "base64") silently skips invalid characters instead of
  // throwing, so strictness has to be explicit — otherwise a corrupt payload
  // decodes to short garbage and misreports as truncation.
  const payload = envelope.slice(E2EE_PREFIX.length);
  if (payload.length === 0 || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) {
    throw new ValidationError("E2EE envelope payload is not valid base64", "invalid_envelope", null);
  }
  const raw = Buffer.from(payload, "base64");
  if (raw.byteLength < E2EE_IV_BYTES + E2EE_TAG_BYTES) {
    throw new ValidationError("E2EE envelope payload is truncated", "invalid_envelope", null);
  }
  const key = deriveE2eeKey(keyOrPassphrase);
  const iv = raw.subarray(0, E2EE_IV_BYTES);
  const tag = raw.subarray(E2EE_IV_BYTES, E2EE_IV_BYTES + E2EE_TAG_BYTES);
  const ciphertext = raw.subarray(E2EE_IV_BYTES + E2EE_TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new DecryptionError("E2EE authentication failed: wrong key or corrupt payload");
  }
}
