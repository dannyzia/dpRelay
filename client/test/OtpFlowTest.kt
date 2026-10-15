package com.yourcompany.phoneauth

import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

/**
 * Contract tests for the dP Relay v5 OTP client SDK.
 *
 * These are offline contract tests: they assert the exact request structure the
 * live API expects (method, URL, `X-App-Id` / `X-App-Secret` headers, JSON
 * body), strict E.164 normalization, and how v5 responses and error codes map
 * onto the sealed [OtpResult] / [OtpFailure] types. No test opens a socket
 * except the one that asserts transport failures are surfaced as
 * [OtpFailure.Network] against a closed loopback port.
 *
 * Run with JUnit 4 on a JVM classpath that contains `kotlin-stdlib`,
 * `kotlinx-coroutines-core`, `org.json` and `junit` (the `client/` directory
 * has no Gradle module of its own; see docs/Plan/20-TEST-PLAN.md).
 *
 * All timestamps are fixed literals so results are repeatable — no
 * `System.currentTimeMillis()` dependency in the assertions.
 */
class OtpFlowTest {

    private val appId = "550e8400-e29b-41d4-a716-446655440000"
    private val appSecret = "dGVzdF9zZWNyZXRfMzJfY2hhcmFjdGVyc19sb25n"
    private val phone = "+8801712345678"
    private val base = PhoneAuthHelper.DEFAULT_BASE_URL

    // ------------------------------------------------------------------
    // v5 request structure: URLs, headers, bodies
    // ------------------------------------------------------------------

    @Test
    fun `default base URL points at the live dP Relay v5 API`() {
        assertEquals("https://api.dprelay.digital-papyrus.com", PhoneAuthHelper.DEFAULT_BASE_URL)
        assertEquals(PhoneAuthHelper.DEFAULT_BASE_URL, PhoneAuthHelper.baseUrl)
    }

    @Test
    fun `sendOtp targets POST v5 otp send with app-plane header auth`() {
        val spec = PhoneAuthHelper.buildSendRequest(appId, appSecret, phone, null, base)

        assertEquals("POST", spec.method)
        assertEquals("$base/v5/otp/send", spec.url)
        assertEquals(appId, spec.headers["X-App-Id"])
        assertEquals(appSecret, spec.headers["X-App-Secret"])
        assertEquals("application/json", spec.headers["Content-Type"])
    }

    @Test
    fun `sendOtp body carries phone and mode but never the credentials`() {
        val spec = PhoneAuthHelper.buildSendRequest(appId, appSecret, phone, OtpMode.BYOD, base)
        val body = JSONObject(spec.body)

        assertEquals(phone, body.getString("phone"))
        assertEquals("byod", body.getString("mode"))
        assertFalse("appId must never travel in the body", body.has("appId"))
        assertFalse("appSecret must never travel in the body", body.has("appSecret"))
        assertFalse(spec.body!!.contains(appSecret))
    }

    @Test
    fun `sendOtp omits mode when the caller does not pick a route`() {
        val body = JSONObject(
            PhoneAuthHelper.buildSendRequest(appId, appSecret, phone, null, base).body,
        )

        assertTrue(body.has("phone"))
        assertFalse("mode must be absent so the server default applies", body.has("mode"))
    }

    @Test
    fun `OtpMode wires to the contract literals`() {
        assertEquals("byod", OtpMode.BYOD.wire)
        assertEquals("managed", OtpMode.MANAGED.wire)
    }

    @Test
    fun `verifyOtp targets POST v5 otp verify with phone otp and optional sessionId`() {
        val withSession = PhoneAuthHelper.buildVerifyRequest(
            appId, appSecret, phone, "482910", "01J0SESSION", base,
        )
        assertEquals("POST", withSession.method)
        assertEquals("$base/v5/otp/verify", withSession.url)
        assertEquals(appId, withSession.headers["X-App-Id"])
        assertEquals(appSecret, withSession.headers["X-App-Secret"])
        assertEquals("application/json", withSession.headers["Content-Type"])

        val body = JSONObject(withSession.body)
        assertEquals(phone, body.getString("phone"))
        assertEquals("482910", body.getString("otp"))
        assertEquals("01J0SESSION", body.getString("sessionId"))

        val withoutSession = JSONObject(
            PhoneAuthHelper.buildVerifyRequest(appId, appSecret, phone, "482910", null, base).body,
        )
        assertFalse(withoutSession.has("sessionId"))
        assertFalse(withSession.body!!.contains(appSecret))
    }

    @Test
    fun `getOtpStatus targets GET v5 otp status with the phone URL-encoded`() {
        val spec = PhoneAuthHelper.buildStatusRequest(appId, appSecret, phone, base)

        assertEquals("GET", spec.method)
        assertEquals("$base/v5/otp/status?phone=%2B8801712345678", spec.url)
        assertEquals(appId, spec.headers["X-App-Id"])
        assertEquals(appSecret, spec.headers["X-App-Secret"])
        assertNull("GET carries no body", spec.body)
        assertNull("GET carries no JSON content type", spec.headers["Content-Type"])
    }

    @Test
    fun `base URL is configurable and trailing slashes are normalized`() {
        val original = PhoneAuthHelper.baseUrl
        try {
            PhoneAuthHelper.baseUrl = "https://staging.example.com/"
            assertEquals("https://staging.example.com", PhoneAuthHelper.baseUrl)

            val spec = PhoneAuthHelper.buildSendRequest(
                appId, appSecret, phone, OtpMode.MANAGED, PhoneAuthHelper.baseUrl,
            )
            assertEquals("https://staging.example.com/v5/otp/send", spec.url)
        } finally {
            PhoneAuthHelper.baseUrl = original
        }
    }

    // ------------------------------------------------------------------
    // Strict E.164 normalization
    // ------------------------------------------------------------------

    @Test
    fun `normalizePhone accepts strict E164 numbers unchanged`() {
        listOf(
            "+8801712345678",
            "+12125551234",
            "+441234567890",
            "+12345678", // shortest legal under ^\+[1-9]\d{7,14}$: 8 digits total
            "+123456789012345", // longest legal: 15 digits total
        ).forEach { number ->
            assertEquals(number, PhoneAuthHelper.normalizePhone(number))
        }
    }

    @Test
    fun `normalizePhone strips pasted separators and the 00 prefix`() {
        assertEquals("+8801712345678", PhoneAuthHelper.normalizePhone(" +880 1712-345678 "))
        assertEquals("+8801712345678", PhoneAuthHelper.normalizePhone("+880 (1712) 345678"))
        assertEquals("+8801712345678", PhoneAuthHelper.normalizePhone("008801712345678"))
    }

    @Test
    fun `normalizePhone rejects anything that is not strict E164`() {
        listOf(
            "",
            "01712345678",      // no country code
            "8801712345678",    // no plus
            "+012345678",       // leading zero
            "+1234567",         // one digit short of the mandated minimum
            "+1234567890123456", // 16 digits: longer than E.164 allows
            "+8801712345678abc",
            "not a phone",
        ).forEach { raw ->
            assertNull("'$raw' must not normalize to E.164", PhoneAuthHelper.normalizePhone(raw))
        }
    }

    @Test
    fun `sendOtp returns typed invalid_phone without touching the network`() {
        val result = runBlocking {
            PhoneAuthHelper.sendOtp(appId, appSecret, "01712345678")
        }

        val failure = (result as OtpResult.Error).failure
        assertTrue(failure is OtpFailure.InvalidPhone)
        assertEquals("invalid_phone", failure.code)
    }

    @Test
    fun `verifyOtp rejects a non six-digit OTP before any request is built`() {
        val result = runBlocking {
            PhoneAuthHelper.verifyOtp(appId, appSecret, phone, "12 345")
        }

        val failure = (result as OtpResult.Error).failure
        assertTrue(failure is OtpFailure.InvalidOtpFormat)
        assertEquals("invalid_otp_format", failure.code)
    }

    @Test
    fun `OTP must be exactly six digits`() {
        val otpRegex = Regex("^\\d{6}$")

        listOf("123456", "000000", "999999").forEach { otp ->
            assertTrue("OTP $otp should be valid", otp.matches(otpRegex))
        }
        listOf("12345", "1234567", "abcdef", "12 345", "").forEach { otp ->
            assertFalse("OTP $otp should be invalid", otp.matches(otpRegex))
        }
    }

    // ------------------------------------------------------------------
    // v5 response parsing
    // ------------------------------------------------------------------

    @Test
    fun `send parses the 201 contract envelope`() {
        val result = PhoneAuthHelper.parseSendResponse(
            RawResponse(201, """{"ok":true,"sessionId":"01J0SESSION","expiresAt":1700000000000}"""),
        )

        val receipt = (result as OtpResult.Success).value
        assertEquals("01J0SESSION", receipt.sessionId)
        assertEquals(1700000000000L, receipt.expiresAt)
    }

    @Test
    fun `send surfaces malformed 201 bodies instead of guessing`() {
        val missingExpiresAt = PhoneAuthHelper.parseSendResponse(
            RawResponse(201, """{"ok":true,"sessionId":"01J0SESSION"}"""),
        )
        assertEquals(
            "malformed_response",
            (missingExpiresAt as OtpResult.Error).failure.code,
        )

        val notJson = PhoneAuthHelper.parseSendResponse(RawResponse(201, "<html>gateway</html>"))
        assertTrue((notJson as OtpResult.Error).failure is OtpFailure.MalformedResponse)
    }

    @Test
    fun `verify parses the contract success envelope`() {
        val result = PhoneAuthHelper.parseVerifyResponse(
            RawResponse(
                200,
                """{"ok":true,"verified":true,"reason":null,"attemptsRemaining":3,"lockedUntil":1700000060000}""",
            ),
        )

        val verification = (result as OtpResult.Success).value
        assertTrue(verification.verified)
        assertNull(verification.reason)
        assertEquals(3, verification.attemptsRemaining)
        assertEquals(1700000060000L, verification.lockedUntil)
    }

    @Test
    fun `verify parses the live server envelope`() {
        val result = PhoneAuthHelper.parseVerifyResponse(
            RawResponse(200, """{"ok":true,"verified":true}"""),
        )

        val verification = (result as OtpResult.Success).value
        assertTrue(verification.verified)
        assertNull(verification.reason)
        assertNull(verification.attemptsRemaining)
        assertNull(verification.lockedUntil)
    }

    @Test
    fun `verify reports a verified-false payload when the contract sends one`() {
        val result = PhoneAuthHelper.parseVerifyResponse(
            RawResponse(200, """{"ok":true,"verified":false,"reason":"mismatch"}"""),
        )

        val verification = (result as OtpResult.Success).value
        assertFalse(verification.verified)
        assertEquals("mismatch", verification.reason)
    }

    @Test
    fun `verify 200 without a verified flag is a contract violation`() {
        val result = PhoneAuthHelper.parseVerifyResponse(RawResponse(200, """{"ok":true}"""))

        assertEquals(
            "malformed_response",
            (result as OtpResult.Error).failure.code,
        )
    }

    @Test
    fun `status parses the contract session envelope`() {
        val body = """
            {"ok":true,"session":{"id":"01J0SESSION","phone":"$phone","status":"pending",
            "attempts":1,"expiresAt":1700000000000,"createdAt":1699999400000,"verifiedAt":null}}
        """.trimIndent()

        val result = PhoneAuthHelper.parseStatusResponse(RawResponse(200, body))

        val session = (result as OtpResult.Success).value.session
        assertNotNull(session)
        assertEquals("01J0SESSION", session!!.id)
        assertEquals(phone, session.phone)
        assertEquals("pending", session.status)
        assertEquals(1, session.attempts)
        assertEquals(1700000000000L, session.expiresAt)
        assertEquals(1699999400000L, session.createdAt)
        assertNull(session.verifiedAt)
    }

    @Test
    fun `status parses the live server flat envelope`() {
        val body =
            """{"ok":true,"status":"verified","expiresAt":1700000000000,""" +
                """"attemptsLeft":2,"lockedUntil":null,"verifiedAt":1699999900000}"""

        val result = PhoneAuthHelper.parseStatusResponse(RawResponse(200, body))

        val session = (result as OtpResult.Success).value.session
        assertNotNull(session)
        assertEquals("verified", session!!.status)
        assertEquals(2, session.attemptsRemaining)
        assertEquals(1700000000000L, session.expiresAt)
        assertEquals(1699999900000L, session.verifiedAt)
        assertNull(session.id)
        assertNull(session.attempts)
    }

    @Test
    fun `status reports no session when the server answers 404 not_found`() {
        val result = PhoneAuthHelper.parseStatusResponse(
            RawResponse(404, """{"ok":false,"error":"No OTP session for this number","code":"not_found"}"""),
        )

        val status = (result as OtpResult.Success).value
        assertNull("nothing pending is a normal state, not an error", status.session)
    }

    @Test
    fun `status 200 without a status field is a contract violation`() {
        val result = PhoneAuthHelper.parseStatusResponse(RawResponse(200, """{"ok":true}"""))

        assertEquals("malformed_response", (result as OtpResult.Error).failure.code)
    }

    // ------------------------------------------------------------------
    // v5 error-code mapping
    // ------------------------------------------------------------------

    @Test
    fun `send maps 400 invalid_phone`() {
        val failure = sendFailure(
            RawResponse(400, """{"ok":false,"error":"phone must be strict E.164","code":"invalid_phone"}"""),
        )

        assertTrue(failure is OtpFailure.InvalidPhone)
        assertEquals("invalid_phone", failure.code)
    }

    @Test
    fun `send maps 402 insufficient_credits`() {
        val failure = sendFailure(
            RawResponse(402, """{"ok":false,"error":"Insufficient credits","code":"insufficient_credits"}"""),
        )

        assertTrue(failure is OtpFailure.InsufficientCredits)
        assertEquals("insufficient_credits", failure.code)
    }

    @Test
    fun `send maps 429 rate_limited with its Retry-After window`() {
        val failure = sendFailure(
            RawResponse(
                429,
                """{"ok":false,"error":"Too many OTP requests for this number","code":"rate_limited"}""",
                retryAfterSec = 60,
            ),
        ) as OtpFailure.RateLimited

        assertEquals("rate_limited", failure.code)
        assertEquals(60L, failure.retryAfterSec)
    }

    @Test
    fun `send maps 429 resend_cooldown as its own rate limit`() {
        val failure = sendFailure(
            RawResponse(
                429,
                """{"ok":false,"error":"Please wait 42s before requesting another code","code":"resend_cooldown"}""",
                retryAfterSec = 42,
            ),
        ) as OtpFailure.RateLimited

        assertEquals("resend_cooldown", failure.code)
        assertEquals(42L, failure.retryAfterSec)
    }

    @Test
    fun `send maps 503 kill switch from both contract and live codes`() {
        val live = sendFailure(
            RawResponse(503, """{"ok":false,"error":"SMS sending is paused","code":"sms_paused"}"""),
        ) as OtpFailure.ServicePaused
        assertEquals("sms_paused", live.code)

        val contract = sendFailure(
            RawResponse(503, """{"ok":false,"error":"Kill switch active","code":"kill_switch_active"}"""),
        ) as OtpFailure.ServicePaused
        assertEquals("kill_switch_active", contract.code)
    }

    @Test
    fun `app-plane auth failures are typed, not HTTP boilerplate`() {
        val missing = sendFailure(
            RawResponse(401, """{"ok":false,"error":"X-App-Id and X-App-Secret headers required","code":"missing_app_credentials"}"""),
        )
        assertEquals("missing_app_credentials", missing.code)
        assertTrue(missing is OtpFailure.AuthRejected)

        val revoked = sendFailure(
            RawResponse(403, """{"ok":false,"error":"This app has been revoked","code":"app_revoked"}"""),
        )
        assertEquals("app_revoked", revoked.code)
        assertTrue(revoked is OtpFailure.AuthRejected)
    }

    @Test
    fun `verify maps 401 invalid_otp including attemptsLeft as attemptsRemaining`() {
        val failure = PhoneAuthHelper.parseVerifyResponse(
            RawResponse(401, """{"ok":false,"error":"Invalid verification code","code":"invalid_otp","attemptsLeft":2}"""),
        ) as OtpResult.Error

        val wrongOtp = failure.failure as OtpFailure.WrongOtp
        assertEquals("invalid_otp", wrongOtp.code)
        assertEquals(2, wrongOtp.attemptsRemaining)
    }

    @Test
    fun `verify maps 423 otp_locked with the lockout window`() {
        val failure = PhoneAuthHelper.parseVerifyResponse(
            RawResponse(
                423,
                """{"ok":false,"error":"Too many failed attempts","code":"otp_locked","retryAfterSec":300}""",
                retryAfterSec = 300,
            ),
        ) as OtpResult.Error

        val locked = failure.failure as OtpFailure.Locked
        assertEquals("otp_locked", locked.code)
        assertEquals(300L, locked.retryAfterSec)
    }

    @Test
    fun `verify maps 400 otp_expired`() {
        val failure = PhoneAuthHelper.parseVerifyResponse(
            RawResponse(400, """{"ok":false,"error":"No active OTP session","code":"otp_expired"}"""),
        ) as OtpResult.Error

        assertTrue(failure.failure is OtpFailure.SessionExpired)
        assertEquals("otp_expired", failure.failure.code)
    }

    @Test
    fun `verify maps 400 invalid_otp_format`() {
        val failure = PhoneAuthHelper.parseVerifyResponse(
            RawResponse(400, """{"ok":false,"error":"otp must be 6 digits","code":"invalid_otp_format"}"""),
        ) as OtpResult.Error

        assertTrue(failure.failure is OtpFailure.InvalidOtpFormat)
    }

    @Test
    fun `unknown error codes and statuses stay diagnosable`() {
        val unrecognisedCode = sendFailure(
            RawResponse(418, """{"ok":false,"error":"teapot","code":"i_am_a_teapot"}"""),
        )
        assertEquals("i_am_a_teapot", unrecognisedCode.code)
        assertTrue(unrecognisedCode is OtpFailure.Unexpected)

        val noBody = sendFailure(RawResponse(500, ""))
        assertEquals("http_500", noBody.code)
        assertTrue(noBody is OtpFailure.Unexpected)
    }

    @Test
    fun `non-JSON error bodies do not throw`() {
        val failure = sendFailure(RawResponse(502, "<html>bad gateway</html>"))

        assertTrue(failure is OtpFailure.Unexpected)
        assertEquals("http_502", failure.code)
        assertNotNull(failure.message)
    }

    // ------------------------------------------------------------------
    // Transport failure typing
    // ------------------------------------------------------------------

    @Test
    fun `transport failures surface as typed network errors`() {
        val original = PhoneAuthHelper.baseUrl
        try {
            // Closed loopback port: refuses the connection immediately, no external I/O.
            PhoneAuthHelper.baseUrl = "http://127.0.0.1:1"
            val result = runBlocking {
                PhoneAuthHelper.sendOtp(appId, appSecret, phone)
            }

            val failure = (result as OtpResult.Error).failure
            assertTrue("expected a network failure, got $failure", failure is OtpFailure.Network)
            assertEquals("network_error", failure.code)
            assertTrue(failure is OtpFailure.Network && failure.cause is IOException)
        } finally {
            PhoneAuthHelper.baseUrl = original
        }
    }

    // ------------------------------------------------------------------
    // Legacy v4 surface must be gone
    // ------------------------------------------------------------------

    @Test
    fun `no legacy v4 data types remain in the SDK`() {
        val legacyNames = listOf(
            "VerificationResponse",
            "CheckAuthResponse",
            "OtpStatusResult",
            "VerificationException",
        )
        legacyNames.forEach { legacy ->
            val type = runCatching {
                Class.forName("com.yourcompany.phoneauth.$legacy")
            }.getOrNull()
            assertNull("v4 type $legacy must not ship in the v5 SDK", type)
        }
    }

    /** Runs [PhoneAuthHelper.parseSendResponse] on a non-201 and returns the typed failure. */
    private fun sendFailure(response: RawResponse): OtpFailure {
        val result = PhoneAuthHelper.parseSendResponse(response)
        assertTrue("expected an error for HTTP ${response.status}", result is OtpResult.Error)
        return (result as OtpResult.Error).failure
    }
}
