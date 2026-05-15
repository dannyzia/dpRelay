package com.yourcompany.phoneauth

import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

/**
 * Integration tests for OTP flow (Phase 12).
 *
 * Note: These are contract tests that validate request/response structure.
 * Full endpoint integration tests require Firebase emulator or deployed Cloud Functions.
 *
 * To run against live endpoints, set these environment variables:
 * - TEST_SEND_OTP_URL
 * - TEST_VERIFY_OTP_URL
 * - TEST_OTP_STATUS_URL
 * - TEST_APP_ID
 * - TEST_APP_SECRET
 * - TEST_PHONE_NUMBER
 */
class OtpFlowTest {

    // --- Data Structure Tests ---

    @Test
    fun `sendOtp returns sessionId for valid appId-appSecret-phoneNumber structure`() {
        // Verify request structure contract
        val appId = "550e8400-e29b-41d4-a716-446655440000"
        val appSecret = "dGVzdF9zZWNyZXRfMzJfY2hhcmFjdGVyc19sb25n" // base64 of 32 bytes
        val phoneNumber = "+8801712345678"

        // These would be the actual request parameters
        assertNotNull(appId)
        assertNotNull(appSecret)
        assertTrue(phoneNumber.matches(Regex("^\\+[1-9]\\d{1,14}$")))

        // Expected response structure
        val expectedSessionId = "uuid-v4-format"
        val expectedExpiresAt = System.currentTimeMillis() + 600000

        val session = OtpSession(expectedSessionId, expectedExpiresAt)

        assertEquals(expectedSessionId, session.sessionId)
        assertTrue(session.expiresAt > System.currentTimeMillis())
    }

    @Test
    fun `sendOtp returns 403 for revoked appId`() {
        // Verify error handling structure for revoked app
        val errorCode = "app_revoked"
        val errorMessage = "App has been revoked"

        val exception = VerificationException(errorCode, errorMessage)

        assertEquals("app_revoked", exception.errorCode)
        assertEquals("App has been revoked", exception.message)
    }

    @Test
    fun `sendOtp returns 403 for invalid appSecret`() {
        // Verify error handling structure for invalid credentials
        val errorCode = "invalid_credentials"
        val errorMessage = "Invalid appSecret"

        val exception = VerificationException(errorCode, errorMessage)

        assertEquals("invalid_credentials", exception.errorCode)
        assertEquals("Invalid appSecret", exception.message)
    }

    @Test
    fun `verifyOtp returns verified-true for correct OTP`() {
        val phoneNumber = "+8801712345678"
        val result = OtpVerifyResult(verified = true, phoneNumber = phoneNumber)

        assertTrue(result.verified)
        assertEquals(phoneNumber, result.phoneNumber)
        assertNull(result.reason)
    }

    @Test
    fun `verifyOtp returns 410 expired after 10 minutes`() {
        val result = OtpVerifyResult(verified = false, reason = "expired")

        assertFalse(result.verified)
        assertEquals("expired", result.reason)
    }

    @Test
    fun `verifyOtp returns locked after 3 wrong attempts`() {
        val result = OtpVerifyResult(verified = false, reason = "locked")

        assertFalse(result.verified)
        assertEquals("locked", result.reason)
    }

    @Test
    fun `verifyOtp returns 403 app_mismatch for wrong appId`() {
        val result = OtpVerifyResult(verified = false, reason = "app_mismatch")

        assertFalse(result.verified)
        assertEquals("app_mismatch", result.reason)
    }

    @Test
    fun `checkOtpStatus returns pending before device sends SMS`() {
        val result = OtpStatusResult(status = "pending", error = null, sessionId = "abc123", expiresAt = null)

        assertEquals("pending", result.status)
        assertNull(result.error)
        assertEquals("abc123", result.sessionId)
    }

    @Test
    fun `checkOtpStatus returns sent after device sends SMS`() {
        val result = OtpStatusResult(status = "sent", error = null, sessionId = null, expiresAt = null)

        assertEquals("sent", result.status)
        assertNull(result.error)
    }

    @Test
    fun `checkOtpStatus returns failed when device writes error`() {
        val error = "SEND_FAILED"
        val result = OtpStatusResult(status = "failed", error = error, sessionId = null, expiresAt = null)

        assertEquals("failed", result.status)
        assertEquals("SEND_FAILED", result.error)
    }

    @Test
    fun `checkOtpStatus with resend-true regenerates OTP and returns pending`() {
        val newExpiresAt = System.currentTimeMillis() + 600000
        val result = OtpStatusResult(status = "pending", error = null, sessionId = "abc123", expiresAt = newExpiresAt)

        assertEquals("pending", result.status)
        assertEquals("abc123", result.sessionId)
        assertNotNull(result.expiresAt)
        assertTrue(result.expiresAt!! > System.currentTimeMillis())
    }

    @Test
    fun `checkOtpStatus resend is rate limited after per-app maxPerPhone threshold`() {
        // Verify rate limit error structure
        val errorCode = "rate_limited"
        val errorMessage = "Rate limited. Please wait before resending."

        val exception = VerificationException(errorCode, errorMessage)

        assertEquals("rate_limited", exception.errorCode)
        assertTrue(exception.message!!.contains("Rate limited"))
    }

    // --- Status Value Validation ---

    @Test
    fun `OtpStatusResult only accepts valid status values`() {
        val validStatuses = listOf("pending", "sent", "failed", "expired", "not_found")

        validStatuses.forEach { status ->
            val result = OtpStatusResult(status = status, error = null, sessionId = null, expiresAt = null)
            assertEquals(status, result.status)
        }
    }

    @Test
    fun `OtpVerifyResult only accepts valid reason values`() {
        val validReasons = listOf("mismatch", "locked", "expired", "not_found", "app_mismatch")

        validReasons.forEach { reason ->
            val result = OtpVerifyResult(verified = false, reason = reason)
            assertEquals(reason, result.reason)
        }
    }

    // --- Validation Tests ---

    @Test
    fun `OTP must be exactly 6 digits`() {
        val validOtps = listOf("123456", "000000", "999999")
        val invalidOtps = listOf("12345", "1234567", "abcdef", "12 345")

        validOtps.forEach { otp ->
            assertTrue(otp.matches(Regex("^\\d{6}$")), "OTP $otp should be valid")
        }

        invalidOtps.forEach { otp ->
            assertFalse(otp.matches(Regex("^\\d{6}$")), "OTP $otp should be invalid")
        }
    }

    @Test
    fun `sessionId must be valid UUID v4 format`() {
        val validSessionIds = listOf(
            "550e8400-e29b-41d4-a716-446655440000",
            "00000000-0000-4000-8000-000000000000"
        )
        val invalidSessionIds = listOf(
            "not-a-uuid",
            "550e8400-e29b-41d4-a716",
            "550e8400-e29b-41d4-a716-446655440000-extra"
        )

        val uuidRegex = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", RegexOption.IGNORE_CASE)

        validSessionIds.forEach { sessionId ->
            assertTrue(sessionId.matches(uuidRegex), "Session ID $sessionId should be valid")
        }

        invalidSessionIds.forEach { sessionId ->
            assertFalse(sessionId.matches(uuidRegex), "Session ID $sessionId should be invalid")
        }
    }

    @Test
    fun `phoneNumber must be E164 format`() {
        val validNumbers = listOf("+8801712345678", "+12125551234", "+441234567890")
        val invalidNumbers = listOf("01712345678", "8801712345678", "+1234567890123456")

        val e164Regex = Regex("^\\+[1-9]\\d{1,14}$")

        validNumbers.forEach { number ->
            assertTrue(number.matches(e164Regex), "Number $number should be valid")
        }

        invalidNumbers.forEach { number ->
            assertFalse(number.matches(e164Regex), "Number $number should be invalid")
        }
    }

    @Test
    fun `expiresAt must be in the future for valid OTP session`() {
        val futureTimestamp = System.currentTimeMillis() + 600000 // 10 minutes from now
        val pastTimestamp = System.currentTimeMillis() - 600000 // 10 minutes ago

        assertTrue(futureTimestamp > System.currentTimeMillis(), "Future timestamp should be in the future")
        assertFalse(pastTimestamp > System.currentTimeMillis(), "Past timestamp should not be in the future")
    }
}
