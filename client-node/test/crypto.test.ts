/**
 * ISSUE-120 — E2EE AES-256-GCM wire contract (client-node side).
 *
 * Covers round-trips (passphrase + raw key), wrong-key rejection, corrupt-tag
 * detection, and every malformed-envelope branch (the suite runs under 100%
 * coverage thresholds, so each branch below maps to a construct in crypto.ts).
 *
 * The two VECTOR_* constants are cross-platform fixtures: the same envelope
 * must decrypt in `E2eeDecryptorTest` on the gateway with the same
 * passphrase / raw key. They were generated once with encryptMessage and are
 * asserted byte-for-byte, so any wire-format drift breaks loudly on both
 * sides instead of silently forking the envelopes.
 */
import { describe, expect, it } from "vitest";
import {
  DecryptionError,
  decryptMessage,
  deriveE2eeKey,
  DpRelayError,
  E2EE_PREFIX,
  encryptMessage,
  isE2eeEnvelope,
  ValidationError,
} from "../src/index.js";

/** Passphrase vector: generated once, shared with the Kotlin suite. */
const VECTOR_PASSPHRASE = "dprelay-e2ee-vector-passphrase";
const VECTOR_PLAINTEXT = "The quick brown fox jumps over 13 lazy dogs. +8801712345678 ñ";
const VECTOR_ENVELOPE =
  "e2ee:v1:sAmiUjSdaYVYQa8P2rnaq/PwzKs/i7yT7Le4BHEZ7mBg0Iy/hGvpeIW8axPs3Xeq6btdgMc/x5VP1pPMRQ+eDBFI9ftUgFXjyfr8cAcwPD0fCR2sscIuNKgO";

/** Raw-key vector: key bytes are 0..31, shared with the Kotlin suite. */
const VECTOR_RAW_KEY = new Uint8Array(32).map((_, i) => i);
const VECTOR_RAW_ENVELOPE =
  "e2ee:v1:kQ2KSbR1z9dRhXq6fy7+wZdIYRt0c8c0kpo6sc2aVI1bvz7nnkDW+nNXnfBBAYhKAYPLkQ==";

function corruptTagByte(envelope: string): string {
  const raw = Buffer.from(envelope.slice(E2EE_PREFIX.length), "base64");
  // Flip a bit inside the 16-byte auth-tag window (bytes 12..27).
  const tampered = Buffer.from(raw);
  const tagByte = tampered[20];
  if (tagByte === undefined) throw new Error("test vector shorter than the tag window");
  tampered[20] = tagByte ^ 0x01;
  return `${E2EE_PREFIX}${tampered.toString("base64")}`;
}

describe("E2EE envelope shape", () => {
  it("prefixes envelopes and detects them", () => {
    const envelope = encryptMessage("hello", "passphrase");
    expect(envelope.startsWith(E2EE_PREFIX)).toBe(true);
    expect(isE2eeEnvelope(envelope)).toBe(true);
    expect(isE2eeEnvelope("hello")).toBe(false);
    expect(isE2eeEnvelope("e2ee:v0:abcd")).toBe(false);
  });

  it("uses a fresh random IV per encryption", () => {
    const first = encryptMessage("same text", "passphrase");
    const second = encryptMessage("same text", "passphrase");
    expect(first).not.toBe(second);
    expect(decryptMessage(first, "passphrase")).toBe("same text");
    expect(decryptMessage(second, "passphrase")).toBe("same text");
  });
});

describe("E2EE round-trips", () => {
  it("round-trips a passphrase-encrypted message, including unicode", () => {
    const text = "OTP bypass note: café ☕ +8801712345678";
    expect(decryptMessage(encryptMessage(text, "s3cr3t-pass"), "s3cr3t-pass")).toBe(text);
  });

  it("round-trips empty plaintext", () => {
    expect(decryptMessage(encryptMessage("", "passphrase"), "passphrase")).toBe("");
  });

  it("round-trips a raw 32-byte key (Buffer and Uint8Array)", () => {
    const raw = new Uint8Array(32).map((_, i) => (i * 7) & 0xff);
    expect(decryptMessage(encryptMessage("raw key ok", raw), raw)).toBe("raw key ok");
    expect(decryptMessage(encryptMessage("raw key ok", Buffer.from(raw)), Buffer.from(raw))).toBe("raw key ok");
  });

  it("derives a 32-byte key from a passphrase via PBKDF2", () => {
    const key = deriveE2eeKey("passphrase");
    expect(key.byteLength).toBe(32);
    expect(deriveE2eeKey("passphrase").equals(key)).toBe(true);
    expect(deriveE2eeKey("different").equals(key)).toBe(false);
  });
});

describe("E2EE cross-platform vectors (shared with E2eeDecryptorTest)", () => {
  it("decrypts the passphrase vector byte-for-byte", () => {
    expect(decryptMessage(VECTOR_ENVELOPE, VECTOR_PASSPHRASE)).toBe(VECTOR_PLAINTEXT);
  });

  it("decrypts the raw-key vector byte-for-byte", () => {
    expect(decryptMessage(VECTOR_RAW_ENVELOPE, VECTOR_RAW_KEY)).toBe("raw-key vector plaintext");
  });
});

describe("E2EE failure modes (fail closed)", () => {
  it("rejects a wrong passphrase with DecryptionError, never partial plaintext", () => {
    const envelope = encryptMessage("secret", "right-key");
    try {
      decryptMessage(envelope, "wrong-key");
      expect.unreachable("wrong passphrase must not decrypt");
    } catch (err) {
      expect(err).toBeInstanceOf(DecryptionError);
      expect(err).toBeInstanceOf(DpRelayError);
      expect((err as DecryptionError).code).toBe("decryption_failed");
      expect((err as DecryptionError).statusCode).toBeNull();
    }
  });

  it("rejects a corrupt auth tag with DecryptionError", () => {
    const envelope = encryptMessage("secret", "passphrase");
    expect(() => decryptMessage(corruptTagByte(envelope), "passphrase")).toThrowError(DecryptionError);
  });

  it("rejects envelopes without the v1 prefix", () => {
    try {
      decryptMessage("plain text, no envelope", "passphrase");
      expect.unreachable("prefix-less input must not decrypt");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe("invalid_envelope");
    }
  });

  it("rejects non-base64, empty, and mis-padded payloads", () => {
    expect(() => decryptMessage(`${E2EE_PREFIX}!!!not-base64!!!`, "passphrase")).toThrowError(ValidationError);
    expect(() => decryptMessage(E2EE_PREFIX, "passphrase")).toThrowError(ValidationError);
    expect(() => decryptMessage(`${E2EE_PREFIX}abc`, "passphrase")).toThrowError(ValidationError);
  });

  it("rejects a truncated payload that is valid base64", () => {
    const short = `${E2EE_PREFIX}${Buffer.alloc(10).toString("base64")}`;
    expect(() => decryptMessage(short, "passphrase")).toThrowError(ValidationError);
  });

  it("rejects raw keys that are not exactly 32 bytes", () => {
    expect(() => encryptMessage("x", new Uint8Array(16))).toThrowError(ValidationError);
    try {
      decryptMessage(VECTOR_RAW_ENVELOPE, new Uint8Array(31));
      expect.unreachable("short raw key must not decrypt");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe("invalid_key_length");
    }
  });
});
