package com.digitalpapyrus.dprelay.reader

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * Upload transport for POST /v5/payments/ingest (STAGE F8).
 *
 * Minimal by design: HttpURLConnection, no client library, no retries here —
 * retry policy lives in [UploadQueue]/[UploadWorker] where it is unit-tested.
 * The Bearer secret is attached per request and never logged.
 */
object PaymentApiClient {

    /** Endpoint path appended to the configured server URL. */
    const val ENDPOINT = "/v5/payments/ingest"

    /** Operational timeouts: the queue owns retry timing, the socket must not hang. */
    private const val CONNECT_TIMEOUT_MS = 10_000
    private const val READ_TIMEOUT_MS = 15_000

    /** Classified upload outcome. */
    sealed class Outcome {

        /** 2xx — accepted (created or idempotent duplicate; both are wins). */
        object Accepted : Outcome()

        /** 400 — the server will never accept this payload; drop it loudly. */
        object Rejected : Outcome()

        /** Anything else (network error, 401/403, 5xx) — keep it and back off. */
        data class Failed(val detail: String) : Outcome()
    }

    /**
     * Maps an HTTP status to an outcome (null = network-level failure).
     * Deliberately narrow on permanence: only 400 drops an item — a wrong or
     * unset secret (401/403) must keep the payment queued until the operator
     * fixes the configuration, never discard a real payment.
     */
    fun classify(httpCode: Int?): Outcome =
        when {
            httpCode == null -> Outcome.Failed("network error")
            httpCode == 200 || httpCode == 201 -> Outcome.Accepted
            httpCode == 400 -> Outcome.Rejected
            else -> Outcome.Failed("http $httpCode")
        }

    /**
     * Builds the exact JSON body the spec defines:
     * `{ sender, amountBdt, trxId, receivedAt, rawBody }`.
     * Pure and unit-tested — this is the wire contract with the server route.
     */
    fun buildPayload(item: PendingUpload): String =
        "{" +
            "\"sender\":\"${escapeJson(item.sender)}\"," +
            "\"amountBdt\":${item.amountBdt}," +
            "\"trxId\":\"${escapeJson(item.trxId)}\"," +
            "\"receivedAt\":${item.receivedAtMs}," +
            "\"rawBody\":\"${escapeJson(item.rawBody)}\"" +
            "}"

    /**
     * POSTs one item. Blocking I/O — call only from a worker thread
     * (WorkManager's [UploadWorker] runs off the main thread by contract).
     *
     * @param baseUrl configured server URL (scheme + host, maybe a path prefix).
     * @param secret PAYMENT_READER_SECRET, sent as the Bearer token.
     * @param item the payment to upload.
     */
    fun send(baseUrl: String, secret: String, item: PendingUpload): Outcome {
        val url = baseUrl.trimEnd('/') + ENDPOINT
        return try {
            val connection = URL(url).openConnection() as HttpURLConnection
            try {
                connection.connectTimeout = CONNECT_TIMEOUT_MS
                connection.readTimeout = READ_TIMEOUT_MS
                connection.requestMethod = "POST"
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.setRequestProperty("Authorization", "Bearer $secret")
                connection.outputStream.use { stream ->
                    stream.write(buildPayload(item).toByteArray(Charsets.UTF_8))
                }
                classify(connection.responseCode)
            } finally {
                connection.disconnect()
            }
        } catch (e: IOException) {
            Outcome.Failed("network: ${e.javaClass.simpleName}")
        }
    }

    /** JSON string escaping for the five fields that can carry arbitrary text. */
    private fun escapeJson(value: String): String =
        buildString {
            for (ch in value) {
                when (ch) {
                    '"' -> append("\\\"")
                    '\\' -> append("\\\\")
                    '\n' -> append("\\n")
                    '\r' -> append("\\r")
                    '\t' -> append("\\t")
                    else ->
                        if (ch < ' ') {
                            append("\\u")
                            append(ch.code.toString(16).padStart(4, '0'))
                        } else {
                            append(ch)
                        }
                }
            }
        }
}
