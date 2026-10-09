package com.digitalpapyrus.dprelay.reader

import com.sun.net.httpserver.HttpServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetSocketAddress
import java.util.concurrent.atomic.AtomicReference

/**
 * Wire contract for POST /v5/payments/ingest (F8 AC): exact payload shape,
 * Bearer header, and outcome classification (the retry queue's input).
 * The send() tests run a loopback HTTP server — real bytes, no framework.
 */
class PaymentApiClientTest {

    /** Captures what the loopback server actually received. */
    private class Captured {
        val auth = AtomicReference<String>("")
        val body = AtomicReference<String>("")
    }

    private var server: HttpServer? = null

    @After
    fun tearDown() {
        server?.stop(0)
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

    /**
     * Starts a loopback server answering [status] on the ingest endpoint and
     * recording the Authorization header + body. Returns the base URL; read
     * `captured` AFTER the client call.
     */
    private fun startServer(status: Int, captured: Captured): String {
        val httpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        httpServer.createContext(PaymentApiClient.ENDPOINT) { exchange ->
            captured.auth.set(exchange.requestHeaders.getFirst("Authorization") ?: "")
            captured.body.set(exchange.requestBody().readBytes().toString(Charsets.UTF_8))
            exchange.sendResponseHeaders(status, -1)
            exchange.close()
        }
        httpServer.start()
        server = httpServer
        return "http://127.0.0.1:${httpServer.address.port}"
    }

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
        val captured = Captured()
        val baseUrl = startServer(201, captured)

        val outcome = PaymentApiClient.send(baseUrl, "reader-secret", item())

        assertTrue(outcome is PaymentApiClient.Outcome.Accepted)
        assertEquals("Bearer reader-secret", captured.auth.get())
        assertEquals(PaymentApiClient.buildPayload(item()), captured.body.get())
        assertTrue(captured.body.get().contains("\"trxId\":\"8AC3K2L9P1\""))
        assertTrue(captured.body.get().contains("\"amountBdt\":500.0"))
    }

    @Test
    fun `send classifies 400 as rejected and 401 as failed (payment stays queued)`() {
        val rejected = Captured()
        val rejectedUrl = startServer(400, rejected)
        val rejectedOutcome = PaymentApiClient.send(rejectedUrl, "s", item())
        assertTrue(rejectedOutcome is PaymentApiClient.Outcome.Rejected)
        // Stop the first server before binding the second (teardown stops the last).
        server?.stop(0)
        server = null

        val refused = Captured()
        val refusedUrl = startServer(401, refused)
        val refusedOutcome = PaymentApiClient.send(refusedUrl, "s", item())
        assertTrue(refusedOutcome is PaymentApiClient.Outcome.Failed)
    }
}
