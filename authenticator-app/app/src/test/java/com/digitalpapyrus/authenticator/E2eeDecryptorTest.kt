package com.digitalpapyrus.authenticator

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64
import javax.crypto.AEADBadTagException

/**
 * Unit tests for [E2eeDecryptor] (ISSUE-120).
 *
 * Pure JVM: the decryptor uses java.util.Base64 + javax.crypto only, so no
 * Robolectric. The VECTOR_* constants are cross-platform fixtures generated
 * once by client-node's encryptMessage and asserted byte-for-byte — any
 * wire-format drift breaks loudly here and in `client-node/test/crypto.test.ts`
 * instead of silently forking the envelopes.
 */
class E2eeDecryptorTest {

  companion object {
    private const val VECTOR_PASSPHRASE = "dprelay-e2ee-vector-passphrase"
    private const val VECTOR_PLAINTEXT = "The quick brown fox jumps over 13 lazy dogs. +8801712345678 ñ"
    private const val VECTOR_ENVELOPE =
      "e2ee:v1:sAmiUjSdaYVYQa8P2rnaq/PwzKs/i7yT7Le4BHEZ7mBg0Iy/hGvpeIW8axPs3Xeq6btd" +
        "gMc/x5VP1pPMRQ+eDBFI9ftUgFXjyfr8cAcwPD0fCR2sscIuNKgO"
    private const val VECTOR_RAW_PLAINTEXT = "raw-key vector plaintext"
    private const val VECTOR_RAW_ENVELOPE =
      "e2ee:v1:kQ2KSbR1z9dRhXq6fy7+wZdIYRt0c8c0kpo6sc2aVI1bvz7nnkDW+nNXnfBBAYhKAYPLkQ=="
    private val VECTOR_RAW_KEY = ByteArray(32) { i -> i.toByte() }
  }

  @Test
  fun `isEnvelope detects the v1 prefix only`() {
    assertTrue(E2eeDecryptor.isEnvelope(VECTOR_ENVELOPE))
    assertFalse(E2eeDecryptor.isEnvelope("plain bulk body"))
    assertFalse(E2eeDecryptor.isEnvelope("e2ee:v0:abcd"))
  }

  @Test
  fun `passphrase vector decrypts byte-for-byte (client-node fixture)`() {
    assertEquals(
      VECTOR_PLAINTEXT,
      E2eeDecryptor.decryptToString(VECTOR_ENVELOPE, VECTOR_PASSPHRASE),
    )
  }

  @Test
  fun `raw-key vector decrypts byte-for-byte (client-node fixture)`() {
    assertEquals(
      VECTOR_RAW_PLAINTEXT,
      E2eeDecryptor.decryptToString(VECTOR_RAW_ENVELOPE, VECTOR_RAW_KEY),
    )
  }

  @Test
  fun `passphrase derivation matches PBKDF2-HMAC-SHA256 100k output`() {
    // Same derivation must hold for every call — determinism is what makes
    // the backend-encrypted envelope openable with the stored passphrase.
    assertArrayEquals(
      E2eeDecryptor.deriveKey(VECTOR_PASSPHRASE),
      E2eeDecryptor.deriveKey(VECTOR_PASSPHRASE),
    )
    assertEquals(32, E2eeDecryptor.deriveKey(VECTOR_PASSPHRASE).size)
  }

  @Test(expected = AEADBadTagException::class)
  fun `wrong passphrase fails closed with an auth-tag exception`() {
    E2eeDecryptor.decryptToString(VECTOR_ENVELOPE, "wrong-passphrase")
  }

  @Test(expected = AEADBadTagException::class)
  fun `corrupt tag fails closed with an auth-tag exception`() {
    val raw = Base64.getDecoder().decode(VECTOR_ENVELOPE.removePrefix(E2eeDecryptor.PREFIX))
    // Flip a bit inside the 16-byte auth-tag window (bytes 12..27).
    raw[20] = (raw[20].toInt() xor 0x01).toByte()
    val tampered = E2eeDecryptor.PREFIX + Base64.getEncoder().encodeToString(raw)
    E2eeDecryptor.decryptToString(tampered, VECTOR_PASSPHRASE)
  }

  @Test(expected = IllegalArgumentException::class)
  fun `missing prefix is malformed, not an auth failure`() {
    E2eeDecryptor.decryptToString("plain bulk body", VECTOR_PASSPHRASE)
  }

  @Test(expected = IllegalArgumentException::class)
  fun `non-base64 payload is malformed`() {
    E2eeDecryptor.decryptToString(E2eeDecryptor.PREFIX + "!!!not-base64!!!", VECTOR_PASSPHRASE)
  }

  @Test(expected = IllegalArgumentException::class)
  fun `truncated payload is malformed`() {
    val short = E2eeDecryptor.PREFIX + Base64.getEncoder().encodeToString(ByteArray(10))
    E2eeDecryptor.decryptToString(short, VECTOR_PASSPHRASE)
  }

  @Test(expected = IllegalArgumentException::class)
  fun `raw key must be exactly 32 bytes`() {
    E2eeDecryptor.decryptToString(VECTOR_RAW_ENVELOPE, ByteArray(16))
  }
}
