package com.digitalpapyrus.authenticator

import android.content.Context
import com.digitalpapyrus.authenticator.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import javax.net.ssl.HttpsURLConnection

/**
 * Client-side helper for phone number verification.
 * 
 * This is used by the client app (ecommerce/medical) to initiate verification
 * and poll for results. All requests are POST-only.
 * 
 * Provides retry guidance for SMS failures (ADR-007).
 */
object PhoneAuthHelper {
    
    private const val TAG = "PhoneAuthHelper"
    
    /**
     * Starts a phone number verification.
     * 
     * @param context Application context
     * @param phoneNumber Phone number in E.164 format (e.g., "+8801712345678")
     * @return VerificationResponse with sessionCode, expiresAt, and pollToken
     * @throws Exception if verification fails
     */
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
                    BufferedReader(InputStreamReader(inputStream)).use { reader ->
                        reader.readText()
                    }
                }
                
                when (responseCode) {
                    200 -> {
                        val jsonResponse = JSONObject(responseBody)
                        VerificationResponse(
                            sessionCode = jsonResponse.getString("sessionCode"),
                            smsBody = jsonResponse.getString("smsBody"),
                            dedicatedNumber = jsonResponse.getString("dedicatedNumber"),
                            expiresAt = jsonResponse.getLong("expiresAt"),
                            pollToken = jsonResponse.getString("pollToken")
                        )
                    }
                    400 -> {
                        val errorJson = JSONObject(responseBody)
                        val error = errorJson.getString("error")
                        val message = errorJson.getString("message")
                        
                        when (error) {
                            "INVALID_PHONE_NUMBER" -> throw VerificationException(
                                "INVALID_PHONE_NUMBER",
                                "Please enter a valid phone number in E.164 format (e.g., +8801712345678)"
                            )
                            "CLOCK_SKEW_EXCEEDED" -> throw VerificationException(
                                "CLOCK_SKEW_EXCEEDED",
                                "Your device time is incorrect. Please check your time settings and try again."
                            )
                            else -> throw VerificationException(error, message)
                        }
                    }
                    429 -> {
                        val errorJson = JSONObject(responseBody)
                        throw VerificationException(
                            "RATE_LIMIT_EXCEEDED",
                            "Too many verification attempts. Please wait 15 minutes before trying again."
                        )
                    }
                    else -> throw VerificationException(
                        "HTTP_ERROR",
                        "Verification failed with HTTP $responseCode"
                    )
                }
            } finally {
                connection.disconnect()
            }
        }
    }
    
    /**
     * Checks if verification is complete.
     * 
     * @param context Application context
     * @param sessionCode The session code from startVerification
     * @param pollToken The poll token from startVerification
     * @return CheckAuthResponse with status and sender (if verified)
     * @throws Exception if check fails
     */
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
                    BufferedReader(InputStreamReader(inputStream)).use { reader ->
                        reader.readText()
                    }
                }
                
                when (responseCode) {
                    200 -> {
                        val jsonResponse = JSONObject(responseBody)
                        val verified = jsonResponse.optBoolean("verified", false)
                        
                        if (verified) {
                            CheckAuthResponse(
                                verified = true,
                                sender = jsonResponse.getString("sender"),
                                sessionCode = jsonResponse.getString("sessionCode"),
                                processedAt = jsonResponse.getLong("processedAt")
                            )
                        } else {
                            val reason = jsonResponse.optString("reason", "pending")
                            CheckAuthResponse(
                                verified = false,
                                reason = reason,
                                sessionCode = if (jsonResponse.has("sessionCode")) jsonResponse.getString("sessionCode") else null
                            )
                        }
                    }
                    400 -> {
                        val errorJson = JSONObject(responseBody)
                        val error = errorJson.getString("error")
                        
                        when (error) {
                            "bad_request" -> throw VerificationException(
                                "bad_request",
                                "Invalid request format or missing required fields"
                            )
                            else -> throw VerificationException(error, "Invalid request")
                        }
                    }
                    403 -> {
                        val errorJson = JSONObject(responseBody)
                        val error = errorJson.getString("error")
                        
                        when (error) {
                            "invalid_poll_token" -> throw VerificationException(
                                "invalid_poll_token",
                                "Invalid poll token. Please start a new verification."
                            )
                            "invalid_challenge" -> throw VerificationException(
                                "invalid_challenge",
                                "Verification failed. The challenge token does not match."
                            )
                            else -> throw VerificationException(error, "Authentication failed")
                        }
                    }
                    429 -> {
                        throw VerificationException(
                            "rate_limited",
                            "Too many requests. Please wait before trying again."
                        )
                    }
                    500 -> {
                        throw VerificationException(
                            "integrity_error",
                            "Internal server error. Please try again later."
                        )
                    }
                    else -> throw VerificationException(
                        "HTTP_ERROR",
                        "Check failed with HTTP $responseCode"
                    )
                }
            } finally {
                connection.disconnect()
            }
        }
    }
    
    /**
     * Gets retry guidance for SMS failures.
     * 
     * Per ADR-007, this provides user-friendly guidance when SMS fails.
     * 
     * @return User-facing message with retry instructions
     */
    fun getSmsFailureRetryGuidance(): String {
        return "SMS could not be sent. Please try again in 30 seconds.\n\n" +
               "If the problem persists:\n" +
               "1. Check your phone signal\n" +
               "2. Ensure the phone number is correct\n" +
               "3. Contact support if the issue continues"
    }
    
    /**
     * Polls for verification completion.
     * 
     * Polls every 2 seconds for up to 30 seconds (15 attempts).
     * 
     * @param context Application context
     * @param sessionCode The session code from startVerification
     * @param pollToken The poll token from startVerification
     * @return CheckAuthResponse with status and sender (if verified)
     * @throws VerificationException if verification fails or times out
     */
    suspend fun pollForVerification(
        context: Context,
        sessionCode: String,
        pollToken: String
    ): CheckAuthResponse {
        val maxAttempts = 15 // 30 seconds / 2 seconds
        val pollInterval = 2000L // 2 seconds
        
        repeat(maxAttempts) { attempt ->
            val response = checkAuth(context, sessionCode, pollToken)
            
            if (response.verified) {
                return response
            }
            
            // If reason is mismatch or expired, return immediately
            if (response.reason == "mismatch" || response.reason == "expired") {
                return response
            }
            
            // Wait before next poll (except on last attempt)
            if (attempt < maxAttempts - 1) {
                kotlinx.coroutines.delay(pollInterval)
            }
        }
        
        // Timeout after 30 seconds - return pending response
        return CheckAuthResponse(
            verified = false,
            reason = "pending",
            sessionCode = sessionCode
        )
    }
}

/**
 * Response from startVerification.
 */
data class VerificationResponse(
    val sessionCode: String,
    val smsBody: String,
    val dedicatedNumber: String,
    val expiresAt: Long,
    val pollToken: String
)

/**
 * Response from checkAuth.
 */
data class CheckAuthResponse(
    val verified: Boolean,
    val sender: String? = null,
    val sessionCode: String? = null,
    val processedAt: Long? = null,
    val reason: String? = null
)

/**
 * Verification exception with error code and user-facing message.
 */
class VerificationException(
    val errorCode: String,
    message: String
) : Exception(message)
