package com.yourcompany.phoneauth

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import javax.net.ssl.HttpsURLConnection

/**
 * Client-side helper for phone number verification and OTP authentication.
 *
 * This is a library used by client apps (e.g., HaatBazar) to interact with the
 * Phone Authenticator v4 Cloud Functions.
 *
 * Two verification modes are supported:
 * 1. Inbound SMS (legacy): startVerification / checkAuth — user sends AUTH: SMS
 * 2. Outbound OTP (new): sendOtp / verifyOtp / checkOtpStatus — system sends OTP SMS
 *
 * All requests are POST-only.
 *
 * SECURITY: appSecret must NEVER be embedded in mobile app code.
 * sendOtp calls must be routed through a backend server that holds the appSecret.
 */
object PhoneAuthHelper {

    private const val TAG = "PhoneAuthHelper"

    // --- Inbound (Legacy) ---

    suspend fun startVerification(context: Context, phoneNumber: String): VerificationResponse {
        return withContext(Dispatchers.IO) {
            val clientTimestamp = System.currentTimeMillis()
            val url = URL(BuildConfig.CF_START_VERIFICATION_URL)
            val connection = url.openConnection() as HttpsURLConnection

            try {
                connection.requestMethod = "POST"
                connection.setRequestProperty("Content-Type", "application/json")
                connection.doOutput = true
                connection.connectTimeout = 30000
                connection.readTimeout = 30000

                val requestBody = JSONObject().apply {
                    put("phoneNumber", phoneNumber)
                    put("clientTimestamp", clientTimestamp)
                }

                connection.outputStream.use { os ->
                    os.write(requestBody.toString().toByteArray())
                }

                val responseCode = connection.responseCode
                val responseBody = connection.inputStream.use { inputStream ->
                    BufferedReader(InputStreamReader(inputStream)).use { it.readText() }
                }

                when (responseCode) {
                    200 -> {
                        val json = JSONObject(responseBody)
                        VerificationResponse(
                            sessionCode = json.getString("sessionCode"),
                            smsBody = json.getString("smsBody"),
                            dedicatedNumber = json.getString("dedicatedNumber"),
                            expiresAt = json.getLong("expiresAt"),
                            pollToken = json.getString("pollToken")
                        )
                    }
                    400 -> {
                        val err = JSONObject(responseBody)
                        throw VerificationException(
                            err.getString("error"),
                            err.optString("message", "Invalid request")
                        )
                    }
                    429 -> throw VerificationException(
                        "RATE_LIMIT_EXCEEDED",
                        "Too many verification attempts. Please wait before trying again."
                    )
                    else -> throw VerificationException(
                        "HTTP_ERROR",
                        "startVerification failed with HTTP $responseCode"
                    )
                }
            } finally {
                connection.disconnect()
            }
        }
    }

    suspend fun checkAuth(context: Context, sessionCode: String, pollToken: String): CheckAuthResponse {
        return withContext(Dispatchers.IO) {
            val url = URL(BuildConfig.CF_CHECK_AUTH_URL)
            val connection = url.openConnection() as HttpsURLConnection

            try {
                connection.requestMethod = "POST"
                connection.setRequestProperty("Content-Type", "application/json")
                connection.doOutput = true
                connection.connectTimeout = 30000
                connection.readTimeout = 30000

                val requestBody = JSONObject().apply {
                    put("sessionCode", sessionCode)
                    put("pollToken", pollToken)
                }

                connection.outputStream.use { os ->
                    os.write(requestBody.toString().toByteArray())
                }

                val responseCode = connection.responseCode
                val responseBody = connection.inputStream.use { inputStream ->
                    BufferedReader(InputStreamReader(inputStream)).use { it.readText() }
                }

                when (responseCode) {
                    200 -> {
                        val json = JSONObject(responseBody)
                        if (json.optBoolean("verified", false)) {
                            CheckAuthResponse(
                                verified = true,
                                sender = json.getString("sender"),
                                sessionCode = json.getString("sessionCode"),
                                processedAt = json.getLong("processedAt")
                            )
                        } else {
                            CheckAuthResponse(
                                verified = false,
                                reason = json.optString("reason", "pending"),
                                sessionCode = json.optString("sessionCode", null)
                            )
                        }
                    }
                    403 -> {
                        val err = JSONObject(responseBody)
                        throw VerificationException(
                            err.getString("error"),
                            err.optString("message", "")
                        )
                    }
                    429 -> throw VerificationException(
                        "rate_limited",
                        "Too many requests. Please wait before trying again."
                    )
                    else -> throw VerificationException(
                        "HTTP_ERROR",
                        "checkAuth failed with HTTP $responseCode"
                    )
                }
            } finally {
                connection.disconnect()
            }
        }
    }

    suspend fun pollForVerification(
        context: Context,
        sessionCode: String,
        pollToken: String
    ): CheckAuthResponse {
        val maxAttempts = 15
        val pollInterval = 2000L
        repeat(maxAttempts) { attempt ->
            val response = checkAuth(context, sessionCode, pollToken)
            if (response.verified) return response
            if (response.reason == "mismatch" || response.reason == "expired") return response
            if (attempt < maxAttempts - 1) delay(pollInterval)
        }
        return CheckAuthResponse(verified = false, reason = "pending", sessionCode = sessionCode)
    }

    // --- Outbound OTP (New) ---

    /**
     * Initiates an OTP verification. SECURITY: MUST be called from a backend server,
     * never directly from a mobile app. appSecret must never be embedded in client code.
     */
    suspend fun sendOtp(appId: String, appSecret: String, phoneNumber: String): OtpSession {
        return withContext(Dispatchers.IO) {
            val url = URL(BuildConfig.CF_SEND_OTP_URL)
            val connection = url.openConnection() as HttpsURLConnection

            try {
                connection.requestMethod = "POST"
                connection.setRequestProperty("Content-Type", "application/json")
                connection.doOutput = true
                connection.connectTimeout = 30000
                connection.readTimeout = 30000

                val requestBody = JSONObject().apply {
                    put("appId", appId)
                    put("appSecret", appSecret)
                    put("phoneNumber", phoneNumber)
                }

                connection.outputStream.use { os ->
                    os.write(requestBody.toString().toByteArray())
                }

                val responseCode = connection.responseCode
                val es = connection.errorStream
                val responseBody = if (es != null) {
                    BufferedReader(InputStreamReader(es)).use { it.readText() }
                } else {
                    connection.inputStream.use { inputStream ->
                        BufferedReader(InputStreamReader(inputStream)).use { it.readText() }
                    }
                }

                when (responseCode) {
                    200 -> {
                        val json = JSONObject(responseBody)
                        OtpSession(
                            sessionId = json.getString("sessionId"),
                            expiresAt = json.getLong("expiresAt")
                        )
                    }
                    403 -> {
                        val json = JSONObject(responseBody)
                        throw VerificationException(
                            json.optString("error", "forbidden"),
                            json.optString("message", "")
                        )
                    }
                    429 -> throw VerificationException(
                        "rate_limited",
                        "Too many OTP requests. Please try again later."
                    )
                    else -> throw VerificationException(
                        "HTTP_ERROR",
                        "sendOtp failed with HTTP $responseCode"
                    )
                }
            } finally {
                connection.disconnect()
            }
        }
    }

    /**
     * Verifies an OTP code.
     */
    suspend fun verifyOtp(appId: String, sessionId: String, otp: String): OtpVerifyResult {
        return withContext(Dispatchers.IO) {
            val url = URL(BuildConfig.CF_VERIFY_OTP_URL)
            val connection = url.openConnection() as HttpsURLConnection

            try {
                connection.requestMethod = "POST"
                connection.setRequestProperty("Content-Type", "application/json")
                connection.doOutput = true
                connection.connectTimeout = 30000
                connection.readTimeout = 30000

                val requestBody = JSONObject().apply {
                    put("appId", appId)
                    put("sessionId", sessionId)
                    put("otp", otp)
                }

                connection.outputStream.use { os ->
                    os.write(requestBody.toString().toByteArray())
                }

                val responseCode = connection.responseCode
                val es = connection.errorStream
                val responseBody = if (es != null) {
                    BufferedReader(InputStreamReader(es)).use { it.readText() }
                } else {
                    connection.inputStream.use { inputStream ->
                        BufferedReader(InputStreamReader(inputStream)).use { it.readText() }
                    }
                }

                when (responseCode) {
                    200 -> {
                        val json = JSONObject(responseBody)
                        if (json.optBoolean("verified", false)) {
                            OtpVerifyResult(verified = true, phoneNumber = json.optString("phoneNumber", null))
                        } else {
                            OtpVerifyResult(
                                verified = false,
                                reason = json.optString("reason", "unknown")
                            )
                        }
                    }
                    403 -> OtpVerifyResult(verified = false, reason = "app_mismatch")
                    404 -> OtpVerifyResult(verified = false, reason = "not_found")
                    410 -> OtpVerifyResult(verified = false, reason = "expired")
                    423 -> OtpVerifyResult(verified = false, reason = "locked")
                    else -> throw VerificationException(
                        "HTTP_ERROR",
                        "verifyOtp failed with HTTP $responseCode"
                    )
                }
            } finally {
                connection.disconnect()
            }
        }
    }

    /**
     * Checks OTP delivery status. Set resend=true to trigger a resend on failure.
     */
    suspend fun checkOtpStatus(sessionId: String, resend: Boolean = false): OtpStatusResult {
        return withContext(Dispatchers.IO) {
            val url = URL(BuildConfig.CF_OTP_STATUS_URL)
            val connection = url.openConnection() as HttpsURLConnection

            try {
                connection.requestMethod = "POST"
                connection.setRequestProperty("Content-Type", "application/json")
                connection.doOutput = true
                connection.connectTimeout = 30000
                connection.readTimeout = 30000

                val requestBody = JSONObject().apply {
                    put("appId", BuildConfig.CF_APP_ID)
                    put("sessionId", sessionId)
                    put("resend", resend)
                }

                connection.outputStream.use { os ->
                    os.write(requestBody.toString().toByteArray())
                }

                val responseCode = connection.responseCode
                val es = connection.errorStream
                val responseBody = if (es != null) {
                    BufferedReader(InputStreamReader(es)).use { it.readText() }
                } else {
                    connection.inputStream.use { inputStream ->
                        BufferedReader(InputStreamReader(inputStream)).use { it.readText() }
                    }
                }

                when (responseCode) {
                    200 -> {
                        val json = JSONObject(responseBody)
                        OtpStatusResult(
                            status = json.getString("status"),
                            error = json.optString("error", null),
                            sessionId = json.optString("sessionId", null),
                            expiresAt = if (json.has("expiresAt")) json.getLong("expiresAt") else null
                        )
                    }
                    429 -> throw VerificationException(
                        "rate_limited",
                        "Rate limited. Please wait before resending."
                    )
                    else -> throw VerificationException(
                        "HTTP_ERROR",
                        "checkOtpStatus failed with HTTP $responseCode"
                    )
                }
            } finally {
                connection.disconnect()
            }
        }
    }
}

// --- Data Classes ---

data class VerificationResponse(
    val sessionCode: String,
    val smsBody: String,
    val dedicatedNumber: String,
    val expiresAt: Long,
    val pollToken: String
)

data class CheckAuthResponse(
    val verified: Boolean,
    val sender: String? = null,
    val sessionCode: String? = null,
    val processedAt: Long? = null,
    val reason: String? = null
)

data class OtpSession(
    val sessionId: String,
    val expiresAt: Long
)

data class OtpVerifyResult(
    val verified: Boolean,
    val reason: String? = null,
    val phoneNumber: String? = null
)

data class OtpStatusResult(
    val status: String,
    val error: String? = null,
    val sessionId: String? = null,
    val expiresAt: Long? = null
)

class VerificationException(
    val errorCode: String,
    message: String
) : Exception(message)
