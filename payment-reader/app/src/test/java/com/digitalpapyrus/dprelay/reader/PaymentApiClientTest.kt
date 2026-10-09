package com.digitalpapyrus.dprelay.reader

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicReference

/**
 * Wire contract for POST /v5/payments/ingest (F8 AC): exact payload shape,
 * Bearer header, and outcome classification (the retry queue's input).
 *
 * The send() tests run a loopback HTTP server on an ephemeral port — real
 * bytes, no framework. Deliberately plain java.net rather than
 * com.sun.net.httpserver: the Android unit-test compile classpath is
 * android.jar, which has no com.sun.* types (CI caught this — see PR #69).
 */
class PaymentApiClientTest {

    /** Captures what the loopback server actually received. */
    private class LoopbackServer(private val status: Int) {

        private val serverSocket = ServerSocket(0)
        private val thread = Thread { serve() }

        val auth = AtomicReference<String>("")
        val body = AtomicReference<String>("")

        val baseUrl: String
            get() = "http://127.0.0.1:${serverSocket.localPort}"

        init {
            thread.isDaemon = true
            thread.start()
        }

        /** Waits for the single request/response exchange to finish. */
        fun await() {
            thread.join(5_000)
        }

        fun shutdown() {
            try {
                serverSocket.close()
            } catch (_: Exception) {
                // already closed
            }
        }

        private fun serve() {
            try {
                serverSocket.accept().use { socket ->
                    val input = socket.getInputStream().buffered()
                    val header = readHeaders(input)
                    val lines = header.split("\r\n")
                    for (line in lines) {
                        if (line.startsWith("Authorization:", ignoreCase = true)) {
                            auth.set(line.substringAfter(':').trim())
                        }
                    }
                    val length = lines
                        .firstOrNull { it.startsWith("Content-Length:", ignoreCase = true) }
                        ?.substringAfter(':')
                        ?.trim()
                        ?.toIntOrNull() ?: 0
                    body.set(readExactly(input, length))

                    val reason = REASON_PHRASES[status] ?: "Status"
                    val response =
                        "HTTP/1.1 $status $reason\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    socket.getOutputStream().write(response.toByteArray(Charsets.ISO_8859_1))
                    socket.getOutputStream().flush()
                }
            } catch (_: Exception) {
                // Client gave up first — the test's assertion will show it.
            }
        }

        /** Reads bytes until CRLF CRLF (start of the HTTP message body). */
        private fun readHeaders(input: InputStream): String {
            val out = ByteArrayOutputStream()
            var state = 0
            while (state < 4) {
                val b = input.read()
                if (b < 0) break
                out.write(b)
                state = when (state) {
                    0 -> if (b == CR) 1 else 0
                    1 -> if (b == LF) 2 else if (b == CR) 1 else 0
                    2 -> if (b == CR) 3 else 0
                    else -> if (b == LF) 4 else if (b == CR) 3 else 0
                }
            }
            return out.toString("ISO-8859-1")
        }

        /** Reads exactly [length] body bytes (Content-Length framing). */
        private fun readExactly(input: InputStream, length: Int): String {
            val out = ByteArrayOutputStream()
            val buffer = ByteArray(4096)
            while (out.size() < length) {
                val read = input.read(buffer, 0, minOf(buffer.size, length - out.size()))
                if (read < 0) break
                out.write(buffer, 0, read)
            }
            return out.toString("ISO-8859-1")
        }

        companion object {
            private const val CR = '\r'.code
            private const val LF = '\n'.code

            private val REASON_PHRASES = mapOf(
                200 to "OK",
                201 to "Created",
                400 to "Bad Request",
                401 to "Unauthorized",
            )
        }
    }

    private var server: LoopbackServer? = null

    @After
    fun tearDown() {
        server?.shutdown()
        server = null
    }

    private fun item(
        rawBody: String = "TrxID 8AC3K2L9P1. Tk 500.00 paid.",
        amountBdt: Double = 500.0,
    ): PendingUpload =
        PendingUpload(
            id = "q1",
            sender = "16247",
            provider = "bkash",
            trxId = "8AC3K2L9P1",
            amountBdt = amountBdt,
            receivedAtMs = 1_760_000_123_456L,
            rawBody = rawBody,
        )

    private fun start(status: Int): LoopbackServer =
        LoopbackServer(status).also { server = it }

    @Test
    fun `classify maps statuses onto accepted, rejected and failed outcomes`() {
        assertTrue(PaymentApiClient.classify(200) is PaymentApiClient.Outcome.Accepted)
        assertTrue(PaymentApiClient.classify(201) is PaymentApiClient.Outcome.Accepted)
        assertTrue(PaymentApiClient.classify(400) is PaymentApiClient.Outcome.Rejected)
        // Wrong/disabled secret and outages must KEEP the payment queued:
        assertTrue(PaymentApiClient.classify(401) is PaymentApiClient.Outcome.Failed)
        assertTrue(PaymentApiClient.classify(403) is PaymentApiClient.Outcome.Failed)
        assertTrue(PaymentApiClient.classify(500) is PaymentApiClient.Outcome.Failed)
        assertTrue(PaymentApiClient.classify(null) is PaymentApiClient.Outcome.Failed)
    }

    @Test
    fun `buildPayload is the exact spec JSON with escaped rawBody`() {
        val payload = PaymentApiClient.buildPayload(item(rawBody = "line1\n\"line2\""))
        assertEquals(
            "{" +
                "\"sender\":\"16247\"," +
                "\"amountBdt\":500.0," +
                "\"trxId\":\"8AC3K2L9P1\"," +
                "\"receivedAt\":1760000123456," +
                "\"rawBody\":\"line1\\n\\\"line2\\\"\"" +
                "}",
            payload,
        )
    }

    @Test
    fun `send posts the payload with the Bearer secret and classifies 201 as accepted`() {
        val srv = start(201)

        val outcome = PaymentApiClient.send(srv.baseUrl, "reader-secret", item())
        srv.await()

        assertTrue(outcome is PaymentApiClient.Outcome.Accepted)
        assertEquals("Bearer reader-secret", srv.auth.get())
        assertEquals(PaymentApiClient.buildPayload(item()), srv.body.get())
        assertTrue(srv.body.get().contains("\"trxId\":\"8AC3K2L9P1\""))
        assertTrue(srv.body.get().contains("\"amountBdt\":500.0"))
    }

    @Test
    fun `send classifies 400 as rejected and 401 as failed (payment stays queued)`() {
        val rejected = start(400)
        val rejectedOutcome = PaymentApiClient.send(rejected.baseUrl, "s", item())
        rejected.await()
        assertTrue(rejectedOutcome is PaymentApiClient.Outcome.Rejected)

        val refused = start(401)
        val refusedOutcome = PaymentApiClient.send(refused.baseUrl, "s", item())
        refused.await()
        assertTrue(refusedOutcome is PaymentApiClient.Outcome.Failed)
    }
}
