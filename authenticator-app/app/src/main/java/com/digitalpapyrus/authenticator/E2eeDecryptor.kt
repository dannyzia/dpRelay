package com.digitalpapyrus.authenticator

import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * Gateway-side E2EE opening (ISSUE-120) for the general / bulk SMS plane.
 *
 * Mirrors `client-node/src/crypto.ts` exactly: AES-256-GCM, envelope
 * `e2ee:v1:<base64(iv + tag + ciphertext)>`, PBKDF2-HMAC-SHA256 with 100,000
 * iterations and salt `dprelay:e2ee:salt` for passphrase keys. The OTP plane
 * is structurally excluded — the server must read OTP challenges — so this
 * decryptor is only consulted for `e2ee:v1:`-prefixed outstanding bodies.
 *
 * Pure JVM (java.util.Base64 + javax.crypto, never android.util.Base64) so
 * the contract stays unit-testable without Robolectric, with cross-platform
 * vectors shared against the TypeScript suite.
 */
object E2eeDecryptor {

  /** Envelope prefix identifying an E2EE v1 payload on the wire. */
  const val PREFIX = "e2ee:v1:"

  /** PBKDF2-HMAC-SHA256 iteration count from the wire spec. */
  const val PBKDF2_ITERATIONS = 100_000

  /** PBKDF2 salt from the wire spec. */
  const val PBKDF2_SALT = "dprelay:e2ee:salt"

  /** AES-256-GCM nonce length in bytes. */
  const val IV_BYTES = 12

  /** AES-256-GCM auth tag length in bytes. */
  const val TAG_BYTES = 16

  /** AES-256 key length in bytes. */
  const val KEY_BYTES = 32

  /** GCM auth tag length in bits, as GCMParameterSpec requires. */
  private const val TAG_BITS = 128

  /**
   * True when [body] carries an E2EE v1 envelope.
   *
   * @param body Outstanding message body as claimed from the server
   */
  fun isEnvelope(body: String): Boolean = body.startsWith(PREFIX)

  /**
   * Opens an envelope with a passphrase-derived key.
   *
   * @param envelope Wire envelope starting with [PREFIX]
   * @param passphrase Same passphrase the customer backend encrypted with
   * @return Decrypted UTF-8 plaintext, ready for SmsManager
   * @throws IllegalArgumentException when framing is malformed
   * @throws javax.crypto.AEADBadTagException on wrong key / corrupt payload
   */
  fun decryptToString(envelope: String, passphrase: String): String =
    decryptToString(envelope, deriveKey(passphrase))

  /**
   * Opens an envelope with a raw 32-byte key.
   *
   * @param envelope Wire envelope starting with [PREFIX]
   * @param rawKey Exactly [KEY_BYTES] bytes of key material, never stretched
   * @return Decrypted UTF-8 plaintext, ready for SmsManager
   * @throws IllegalArgumentException when framing is malformed or the key
   * is not exactly [KEY_BYTES] bytes
   * @throws javax.crypto.AEADBadTagException on wrong key / corrupt payload
   */
  fun decryptToString(envelope: String, rawKey: ByteArray): String {
    require(rawKey.size == KEY_BYTES) {
      "raw E2EE key must be exactly $KEY_BYTES bytes, got ${rawKey.size}"
    }
    val raw = decodePayload(envelope)
    // JCE wants ciphertext || tag; the wire carries iv || tag || ciphertext.
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(
      Cipher.DECRYPT_MODE,
      SecretKeySpec(rawKey, "AES"),
      GCMParameterSpec(TAG_BITS, raw, 0, IV_BYTES),
    )
    val ciphertext = raw.copyOfRange(IV_BYTES + TAG_BYTES, raw.size)
    val tag = raw.copyOfRange(IV_BYTES, IV_BYTES + TAG_BYTES)
    return cipher.doFinal(ciphertext + tag).toString(Charsets.UTF_8)
  }

  /**
   * Stretches a passphrase to a 32-byte AES key (PBKDF2-HMAC-SHA256).
   *
   * @param passphrase Operator-configured app E2EE passphrase
   */
  fun deriveKey(passphrase: String): ByteArray {
    val spec = PBEKeySpec(
      passphrase.toCharArray(),
      PBKDF2_SALT.toByteArray(Charsets.UTF_8),
      PBKDF2_ITERATIONS,
      KEY_BYTES * 8,
    )
    return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
  }

  /**
   * Strips the prefix, strict-decodes base64, and enforces the minimum
   * framing (IV + tag) so short garbage misreports as malformed, never as
   * an authentication failure.
   */
  private fun decodePayload(envelope: String): ByteArray {
    require(isEnvelope(envelope)) { "E2EE envelope must start with \"$PREFIX\"" }
    val payload = envelope.removePrefix(PREFIX)
    val raw = try {
      Base64.getDecoder().decode(payload)
    } catch (e: IllegalArgumentException) {
      throw IllegalArgumentException("E2EE envelope payload is not valid base64", e)
    }
    require(raw.size >= IV_BYTES + TAG_BYTES) { "E2EE envelope payload is truncated" }
    return raw
  }
}
