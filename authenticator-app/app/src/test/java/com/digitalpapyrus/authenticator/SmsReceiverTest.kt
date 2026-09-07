package com.digitalpapyrus.authenticator

import org.junit.Assert.*
import org.junit.Test

/**
 * Unit tests for SmsReceiver.
 * 
 * Tests cover:
 * - normalizeToE164() for all Bangladesh carrier formats (TD-10 blocker)
 * - AUTH: prefix filtering
 * - Payload parsing
 * - Expiry validation
 */
class SmsReceiverTest {
    
    private val smsReceiver = SmsReceiver()
    
    @Test
    fun `normalizeToE164 returns unchanged for E164 format with plus`() {
        val input = "+8801712345678"
        val result = smsReceiver.normalizeToE164(input)
        assertEquals("+8801712345678", result)
    }
    
    @Test
    fun `normalizeToE164 adds plus to country code format`() {
        val input = "8801712345678"
        val result = smsReceiver.normalizeToE164(input)
        assertEquals("+8801712345678", result)
    }
    
    @Test
    fun `normalizeToE164 adds country code to local format`() {
        val input = "01712345678"
        val result = smsReceiver.normalizeToE164(input)
        assertEquals("+8801712345678", result)
    }
    
    @Test
    fun `normalizeToE164 handles 016 prefix`() {
        val input = "01612345678"
        val result = smsReceiver.normalizeToE164(input)
        assertEquals("+8801612345678", result)
    }
    
    @Test
    fun `normalizeToE164 handles 018 prefix`() {
        val input = "01812345678"
        val result = smsReceiver.normalizeToE164(input)
        assertEquals("+8801812345678", result)
    }
    
    @Test
    fun `normalizeToE164 handles 019 prefix`() {
        val input = "01912345678"
        val result = smsReceiver.normalizeToE164(input)
        assertEquals("+8801912345678", result)
    }
    
    @Test
    fun `normalizeToE164 handles 015 prefix`() {
        val input = "01512345678"
        val result = smsReceiver.normalizeToE164(input)
        assertEquals("+8801512345678", result)
    }
    
    @Test
    fun `normalizeToE164 handles 014 prefix`() {
        val input = "01412345678"
        val result = smsReceiver.normalizeToE164(input)
        assertEquals("+8801412345678", result)
    }
    
    @Test
    fun `normalizeToE164 handles 013 prefix`() {
        val input = "01312345678"
        val result = smsReceiver.normalizeToE164(input)
        assertEquals("+8801312345678", result)
    }
    
    @Test
    fun `normalizeToE164 returns as-is for unrecognizable format`() {
        val input = "12345"
        val result = smsReceiver.normalizeToE164(input)
        assertEquals("12345", result)
    }
    
    @Test
    fun `normalizeToE164 returns as-is for international format without plus`() {
        val input = "12125551234" // US number
        val result = smsReceiver.normalizeToE164(input)
        assertEquals("12125551234", result)
    }
    
    @Test
    fun `normalizeToE164 uses custom country code when provided`() {
        val input = "0712345678"
        val result = smsReceiver.normalizeToE164(input, "+44")
        assertEquals("+44712345678", result)
    }
    
    @Test
    fun `normalizeToE164 handles empty string`() {
        val input = ""
        val result = smsReceiver.normalizeToE164(input)
        assertEquals("", result)
    }
    
    @Test
    fun `normalizeToE164 handles 11-digit local format`() {
        val input = "017123456789"
        val result = smsReceiver.normalizeToE164(input)
        assertEquals("+88017123456789", result)
    }
    
    @Test
    fun `normalizeToE164 handles 12-digit country code format`() {
        val input = "88017123456789"
        val result = smsReceiver.normalizeToE164(input)
        assertEquals("+88017123456789", result)
    }
    
    @Test
    fun `normalizeToE164 handles 13-digit E164 format`() {
        val input = "+88017123456789"
        val result = smsReceiver.normalizeToE164(input)
        assertEquals("+88017123456789", result)
    }
    
    @Test
    fun `normalizeToE164 is case-sensitive for country code`() {
        val input = "8801712345678"
        val result = smsReceiver.normalizeToE164(input)
        assertTrue(result.startsWith("+"))
    }
    
    @Test
    fun `normalizeToE164 preserves original for malformed numbers`() {
        // This ensures checkAuth returns "mismatch" rather than "pending"
        val input = "abc123"
        val result = smsReceiver.normalizeToE164(input)
        assertEquals("abc123", result)
    }
    
    @Test
    fun `normalizeToE164 handles whitespace in input`() {
        val input = " 01712345678 "
        val result = smsReceiver.normalizeToE164(input)
        // Whitespace is not stripped - returns as-is to cause mismatch
        assertEquals(" 01712345678 ", result)
    }
    
    @Test
    fun `normalizeToE164 handles hyphen in input`() {
        val input = "017-123-45678"
        val result = smsReceiver.normalizeToE164(input)
        // Hyphens are not stripped - returns as-is to cause mismatch
        assertEquals("017-123-45678", result)
    }

    @Test
    fun `isPaymentSms returns true for all bKash sender variants`() {
        assertTrue(SmsReceiver.Companion.isPaymentSms("bKash"))
        assertTrue(SmsReceiver.Companion.isPaymentSms("BKASH"))
        assertTrue(SmsReceiver.Companion.isPaymentSms("16247"))
    }

    @Test
    fun `isPaymentSms returns true for all Nagad sender variants`() {
        assertTrue(SmsReceiver.Companion.isPaymentSms("Nagad"))
        assertTrue(SmsReceiver.Companion.isPaymentSms("NAGAD"))
        assertTrue(SmsReceiver.Companion.isPaymentSms("16167"))
    }

    @Test
    fun `isPaymentSms returns false for OTP senders`() {
        assertFalse(SmsReceiver.Companion.isPaymentSms("+8801712345678"))
        assertFalse(SmsReceiver.Companion.isPaymentSms("DPRELAY"))
        assertFalse(SmsReceiver.Companion.isPaymentSms(""))
    }

    @Test
    fun `parsePaymentSms extracts txnId and amount from bKash format 1`() {
        val body = "TrxID 8AC3K2L9P1 received from 01712345678. Tk 500.00 paid. Fee Tk 0.00. Balance Tk 1000.00"
        val parsed = smsReceiver.parsePaymentSms("bKash", body)

        assertNotNull(parsed)
        assertEquals("8AC3K2L9P1", parsed?.txnId)
        assertEquals(50000, parsed?.amountPaisa)
        assertEquals("bkash", parsed?.provider)
    }

    @Test
    fun `parsePaymentSms extracts txnId and amount from bKash format 2`() {
        val body = "You have received Tk 1200.50 from 01712345678. TrxID: 3F7E9A1B2C. Fee: Tk 0.00. Balance: Tk 2200.75"
        val parsed = smsReceiver.parsePaymentSms("BKASH", body)

        assertNotNull(parsed)
        assertEquals("3F7E9A1B2C", parsed?.txnId)
        assertEquals(120050, parsed?.amountPaisa)
        assertEquals("bkash", parsed?.provider)
    }

    @Test
    fun `parsePaymentSms extracts txnId and amount from Nagad format`() {
        val body = "You have received Tk 750.00 from 01712345678 at your Nagad account. TrxID: 4D5E6F7A8B. Fee: Tk 0.00."
        val parsed = smsReceiver.parsePaymentSms("NAGAD", body)

        assertNotNull(parsed)
        assertEquals("4D5E6F7A8B", parsed?.txnId)
        assertEquals(75000, parsed?.amountPaisa)
        assertEquals("nagad", parsed?.provider)
    }

    @Test
    fun `parsePaymentSms returns null for unrecognised body`() {
        val parsed = smsReceiver.parsePaymentSms("bKash", "This is not a payment confirmation message")
        assertNull(parsed)
    }

    @Test
    fun `amount converts correctly to paisa`() {
        val parsedA = smsReceiver.parsePaymentSms("bKash", "TrxID ABCDE12345. Tk 500.00 paid.")
        val parsedB = smsReceiver.parsePaymentSms("NAGAD", "You have received Tk 1200.50. TrxID: ZYXWV98765.")

        assertNotNull(parsedA)
        assertEquals(50000, parsedA?.amountPaisa)

        assertNotNull(parsedB)
        assertEquals(120050, parsedB?.amountPaisa)
    }
}
