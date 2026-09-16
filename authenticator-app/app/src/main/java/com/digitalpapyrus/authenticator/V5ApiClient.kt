package com.digitalpapyrus.authenticator

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

/**
 * Message handed out by GET /v5/device/outstanding (server-side claim).
 */
data class V5OutstandingMessage(
    val id: String,
    val to: String,
    val message: String,
    val createdAt: Long,
)

/**
 * Terminal delivery result posted back by POST /v5/device/results.
 */
data class V5MessageResult(
    val id: String,
    val status: String, // "sent" | "failed"
    val error: String? = null,
)

/**
 * REST client for the dP Relay v5 server device plane (M2, PLAN §7).
 *
 * Clean-room implementation on HttpURLConnection + org.json — no new runtime
 * dependencies. Auth: device API key (Bearer) issued by /v5/device/enroll and
 * stored only in EncryptedSharedPreferences (ADR-016). The v4 RTDB plane keeps
 * running in parallel (PLAN §9); this client is additive, never a replacement
 * during the parallel-run window.
 */
object V5ApiClient {

    private const val TAG = "V5ApiClient"
    private const val CONNECT_TIMEOUT_MS = 30_000
    private const val READ_TIMEOUT_MS = 30_000

    private fun baseUrl(): String = BuildConfig.V5_API_BASE_URL.trimEnd('/')

    /** v5 plane toggle (parallel run, PLAN §9). Compiled in, off by default. */
    fun isEnabled(): Boolean = BuildConfig.V5_API_ENABLED

    private fun deviceKey(context: Context): String? =
        EncryptedPrefsHelper.getDeviceApiKey(context)

    /**
     * Exchanges the enrollment secret for a device API key and stores it in
     * EncryptedSharedPreferences. Idempotent per server (each call mints a NEW
     * key), so only call when no key is stored.
     */
    suspend fun enrollIfNeeded(context: Context): Boolean = withContext(Dispatchers.IO) {
        if (deviceKey(context) != null) return@withContext true
        val enrollmentSecret = EncryptedPrefsHelper.getEnrollmentSecret(context)
        if (enrollmentSecret == null) {
            Log.w(TAG, "v5 enroll skipped: no enrollment secret configured")
            return@withContext false
        }

        val body = JSONObject().put("label", android.os.Build.MODEL)
        val response = request(
            context,
            path = "/v5/device/enroll",
            method = "POST",
            body = body,
            bearer = enrollmentSecret,
        ) ?: return@withContext false

        if (!response.isSuccessful) {
            Log.e(TAG, "v5 enroll failed: HTTP ${response.code}")
            return@withContext false
        }

        val json = JSONObject(response.body)
        if (!json.optBoolean("ok", false)) {
            Log.e(TAG, "v5 enroll rejected: ${json.optString("code", "unknown")}")
            return@withContext false
        }
        val apiKey = json.optString("apiKey", "")
        if (apiKey.isEmpty()) {
            Log.e(TAG, "v5 enroll response missing apiKey")
            return@withContext false
        }
        EncryptedPrefsHelper.storeDeviceApiKey(context, apiKey)
        Log.i(TAG, "v5 device enrolled")
        true
    }

    /** POST /v5/device/heartbeat — feeds the watchdog, doubles as keep-alive (R1). */
    suspend fun heartbeat(context: Context): Boolean = withContext(Dispatchers.IO) {
        val key = deviceKey(context) ?: return@withContext false
        val response = request(context, "/v5/device/heartbeat", "POST", JSONObject(), key)
        response != null && response.isSuccessful
    }

    /** GET /v5/device/outstanding — claims pending messages (at-least-once server-side). */
    suspend fun fetchOutstanding(context: Context): List<V5OutstandingMessage>? = withContext(Dispatchers.IO) {
        val key = deviceKey(context) ?: return@withContext null
        val response = request(context, "/v5/device/outstanding", "GET", null, key)
        if (response == null || !response.isSuccessful) {
            Log.e(TAG, "v5 outstanding fetch failed${response?.let { ": HTTP ${it.code}" } ?: " (no response)"}")
            return@withContext null
        }
        try {
            val json = JSONObject(response.body)
            val messages = mutableListOf<V5OutstandingMessage>()
            val arr = json.optJSONArray("messages") ?: JSONArray()
            for (i in 0 until arr.length()) {
                val m = arr.getJSONObject(i)
                messages.add(
                    V5OutstandingMessage(
                        id = m.getString("id"),
                        to = m.getString("to"),
                        message = m.getString("message"),
                        createdAt = m.optLong("createdAt", 0L),
                    ),
                )
            }
            messages
        } catch (e: Exception) {
            Log.e(TAG, "v5 outstanding parse failed: ${e.javaClass.simpleName}")
            null
        }
    }

    /** POST /v5/device/results — terminal sent/failed reports for claimed messages. */
    suspend fun postResults(context: Context, results: List<V5MessageResult>): Boolean = withContext(Dispatchers.IO) {
        val key = deviceKey(context) ?: return@withContext false
        val arr = JSONArray()
        for (r in results) {
            val item = JSONObject().put("id", r.id).put("status", r.status)
            if (r.error != null) item.put("error", r.error)
            arr.put(item)
        }
        val response = request(context, "/v5/device/results", "POST", JSONObject().put("results", arr), key)
        response != null && response.isSuccessful
    }

    /** POST /v5/device/payment-sms — bKash/Nagad ingest; server validates v4-parity fields. */
    suspend fun postPaymentSms(
        context: Context,
        sender: String,
        provider: String,
        txnId: String,
        amountPaisa: Int,
        receivedAtMs: Long,
    ): Boolean = withContext(Dispatchers.IO) {
        val key = deviceKey(context) ?: return@withContext false
        val body = JSONObject()
            .put("sender", sender)
            .put("provider", provider)
            .put("txnId", txnId)
            .put("amountPaisa", amountPaisa)
            .put("receivedAt", receivedAtMs)
        val response = request(context, "/v5/device/payment-sms", "POST", body, key)
        response != null && response.isSuccessful
    }

    /** POST /v5/device/fcm-token — registers the FCM token for M3 server-side wake. */
    suspend fun postFcmToken(context: Context, token: String): Boolean = withContext(Dispatchers.IO) {
        val key = deviceKey(context) ?: return@withContext false
        val response = request(context, "/v5/device/fcm-token", "POST", JSONObject().put("token", token), key)
        response != null && response.isSuccessful
    }

    private data class ApiResponse(val isSuccessful: Boolean, val code: Int, val body: String)

    /**
     * Core HTTP call. Returns null on transport failure; never throws. Response
     * bodies are not logged — they may echo request-derived data.
     */
    private fun request(
        context: Context,
        path: String,
        method: String,
        body: JSONObject?,
        bearer: String,
    ): ApiResponse? {
        var connection: HttpURLConnection? = null
        return try {
            val url = URL(baseUrl() + path)
            connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = method
                setRequestProperty("Authorization", "Bearer $bearer")
                setRequestProperty("Accept", "application/json")
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = READ_TIMEOUT_MS
                if (body != null) {
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                }
            }
            if (body != null) {
                connection.outputStream.use { os ->
                    os.write(body.toString().toByteArray(StandardCharsets.UTF_8))
                }
            }
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.let {
                BufferedReader(InputStreamReader(it, StandardCharsets.UTF_8)).use { reader -> reader.readText() }
            } ?: ""
            ApiResponse(code in 200..299, code, text)
        } catch (e: Exception) {
            Log.e(TAG, "v5 $method $path failed: ${e.javaClass.simpleName}: ${e.message}")
            null
        } finally {
            connection?.disconnect()
        }
    }
}
