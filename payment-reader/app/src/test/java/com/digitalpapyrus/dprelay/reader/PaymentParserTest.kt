package com.digitalpapyrus.dprelay.reader

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Parser-parity suite (F8 AC: "Kotlin tests mirror the server's ingest tests
 * so parity is provable"). The fixtures below are copied verbatim from the
 * gateway's SmsReceiverTest — same bodies, same expected TrxIDs, same paisa
 * amounts — and the TrxID/amount rules match the server's ingest validation
 * (TXN_ID_PATTERN `^[A-Z0-9]{10}$`). A divergence between parser, gateway and
 * server fails HERE first.
 */
class PaymentParserTest {

    @Test
    fun `isPaymentSms returns true for all bKash sender variants`() {
        assertTrue(PaymentParser.isPaymentSms("bKash"))
        assertTrue(PaymentParser.isPaymentSms("BKASH"))
        assertTrue(PaymentParser.isPaymentSms("16247"))
    }

    @Test
    fun `isPaymentSms returns true for all Nagad sender variants`() {
        assertTrue(PaymentParser.isPaymentSms("Nagad"))
        assertTrue(PaymentParser.isPaymentSms("NAGAD"))
        assertTrue(PaymentParser.isPaymentSms("16167"))
    }

    @Test
    fun `isPaymentSms returns false for OTP and unknown senders`() {
        assertFalse(PaymentParser.isPaymentSms("+8801712345678"))
        assertFalse(PaymentParser.isPaymentSms("DPRELAY"))
        assertFalse(PaymentParser.isPaymentSms(""))
    }

    @Test
    fun `parse extracts txnId and amount from bKash format 1`() {
        val body = "TrxID 8AC3K2L9P1 received from 01712345678. Tk 500.00 paid. " +
            "Fee Tk 0.00. Balance Tk 1000.00"
        val parsed = PaymentParser.parse("bKash", body)

        assertNotNull(parsed)
        assertEquals("8AC3K2L9P1", parsed?.txnId)
        assertEquals(50000, parsed?.amountPaisa)
        assertEquals("bkash", parsed?.provider)
    }

    @Test
    fun `parse extracts txnId and amount from bKash format 2`() {
        val body = "You have received Tk 1200.50 from 01712345678. TrxID: 3F7E9A1B2C. " +
            "Fee: Tk 0.00. Balance: Tk 2200.75"
        val parsed = PaymentParser.parse("BKASH", body)

        assertNotNull(parsed)
        assertEquals("3F7E9A1B2C", parsed?.txnId)
        assertEquals(120050, parsed?.amountPaisa)
        assertEquals("bkash", parsed?.provider)
    }

    @Test
    fun `parse extracts txnId and amount from Nagad format`() {
        val body = "You have received Tk 750.00 from 01712345678 at your Nagad account. " +
            "TrxID: 4D5E6F7A8B. Fee: Tk 0.00."
        val parsed = PaymentParser.parse("NAGAD", body)

        assertNotNull(parsed)
        assertEquals("4D5E6F7A8B", parsed?.txnId)
        assertEquals(75000, parsed?.amountPaisa)
        assertEquals("nagad", parsed?.provider)
    }

    @Test
    fun `parse returns null for an unrecognised body — malformed SMS is ignored`() {
        assertNull(PaymentParser.parse("bKash", "This is not a payment confirmation message"))
    }

    @Test
    fun `parse returns null without a TrxID or without an amount`() {
        assertNull(PaymentParser.parse("bKash", "Tk 500.00 paid. No transaction id here."))
        assertNull(PaymentParser.parse("bKash", "TrxID ABCDE12345 but no amount mentioned."))
    }

    @Test
    fun `parse returns null for a non-payment sender even with a parseable body`() {
        // Defence in depth: classification gates the upload path, so an OTP
        // sender's body can never become a queued payment.
        assertNull(PaymentParser.parse("DPRELAY", "TrxID ABCDE12345. Tk 500.00 paid."))
    }

    @Test
    fun `amount converts correctly to paisa`() {
        val parsedA = PaymentParser.parse("bKash", "TrxID ABCDE12345. Tk 500.00 paid.")
        val parsedB = PaymentParser.parse(
            "NAGAD",
            "You have received Tk 1200.50. TrxID: ZYXWV98765.",
        )

        assertNotNull(parsedA)
        assertEquals(50000, parsedA?.amountPaisa)

        assertNotNull(parsedB)
        assertEquals(120050, parsedB?.amountPaisa)
    }
}
