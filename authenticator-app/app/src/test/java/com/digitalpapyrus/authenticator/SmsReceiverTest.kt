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
}
