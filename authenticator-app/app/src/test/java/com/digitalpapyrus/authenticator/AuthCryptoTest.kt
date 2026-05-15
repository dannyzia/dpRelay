package com.digitalpapyrus.authenticator

import org.junit.Assert.*
import org.junit.Test

/**
 * Unit tests for AuthCrypto.
 * 
 * Tests cover:
 * - Session code generation (format, uniqueness)
 * - HMAC-SHA256 generation (correctness, consistency)
 * - Constant-time comparison (timing attack prevention)
 * - Clock skew validation
 * - Expiry checking
 */
class AuthCryptoTest {
    
    @Test
    fun `generateSessionCode returns 10-character uppercase hex string`() {
        val code = AuthCrypto.generateSessionCode()
        assertEquals(10, code.length)
        assertTrue(code.matches(Regex("^[0-9A-F]{10}$")))
    }
    
    @Test
    fun `generateSessionCode produces unique codes`() {
        val codes = mutableSetOf<String>()
        repeat(100) {
            codes.add(AuthCrypto.generateSessionCode())
        }
        // With 10 hex characters, there are 16^10 possible values
        // 100 generations should almost certainly be unique
        assertEquals(100, codes.size)
    }
    
    @Test
    fun `generateHmac produces consistent signatures`() {
        val secret = "test_secret_32_characters_long"
        val data = "test_data"
        
        val signature1 = AuthCrypto.generateHmac(secret, data)
        val signature2 = AuthCrypto.generateHmac(secret, data)
        
        assertEquals(signature1, signature2)
    }
    
    @Test
    fun `generateHmac produces different signatures for different data`() {
        val secret = "test_secret_32_characters_long"
        
        val signature1 = AuthCrypto.generateHmac(secret, "data1")
        val signature2 = AuthCrypto.generateHmac(secret, "data2")
        
        assertNotEquals(signature1, signature2)
    }
    
    @Test
    fun `generateHmac produces different signatures for different secrets`() {
        val data = "test_data"
        
        val signature1 = AuthCrypto.generateHmac("secret1_32_characters_long", data)
        val signature2 = AuthCrypto.generateHmac("secret2_32_characters_long", data)
        
        assertNotEquals(signature1, signature2)
    }
    
    @Test
    fun `constantTimeEquals returns true for equal byte arrays`() {
        val a = byteArrayOf(1, 2, 3, 4, 5)
        val b = byteArrayOf(1, 2, 3, 4, 5)
        
        assertTrue(AuthCrypto.constantTimeEquals(a, b))
    }
    
    @Test
    fun `constantTimeEquals returns false for different byte arrays`() {
        val a = byteArrayOf(1, 2, 3, 4, 5)
        val b = byteArrayOf(1, 2, 3, 4, 6)
        
        assertFalse(AuthCrypto.constantTimeEquals(a, b))
    }
    
    @Test
    fun `constantTimeEquals returns false for different length arrays`() {
        val a = byteArrayOf(1, 2, 3)
        val b = byteArrayOf(1, 2, 3, 4)
        
        assertFalse(AuthCrypto.constantTimeEquals(a, b))
    }
    
    @Test
    fun `constantTimeEquals returns true for equal Base64 strings`() {
        val a = "SGVsbG8gV29ybGQ="
        val b = "SGVsbG8gV29ybGQ="
        
        assertTrue(AuthCrypto.constantTimeEquals(a, b))
    }
    
    @Test
    fun `constantTimeEquals returns false for different Base64 strings`() {
        val a = "SGVsbG8gV29ybGQ="
        val b = "SGVsbG8gV29ybGQh"
        
        assertFalse(AuthCrypto.constantTimeEquals(a, b))
    }
    
    @Test
    fun `isWithinClockSkew returns true for timestamp within tolerance`() {
        val currentTime = System.currentTimeMillis()
        val timestamp = currentTime + 200000 // 200 seconds within 5 minutes
        
        assertTrue(AuthCrypto.isWithinClockSkew(timestamp, currentTime))
    }
    
    @Test
    fun `isWithinClockSkew returns true for timestamp exactly at tolerance`() {
        val currentTime = System.currentTimeMillis()
        val timestamp = currentTime + AuthCrypto.CLOCK_SKEW_MS // Exactly 5 minutes
        
        assertTrue(AuthCrypto.isWithinClockSkew(timestamp, currentTime))
    }
    
    @Test
    fun `isWithinClockSkew returns false for timestamp beyond tolerance`() {
        val currentTime = System.currentTimeMillis()
        val timestamp = currentTime + AuthCrypto.CLOCK_SKEW_MS + 1000 // 5 minutes + 1 second
        
        assertFalse(AuthCrypto.isWithinClockSkew(timestamp, currentTime))
    }
    
    @Test
    fun `isWithinClockSkew returns true for past timestamp within tolerance`() {
        val currentTime = System.currentTimeMillis()
        val timestamp = currentTime - 200000 // 200 seconds in the past
        
        assertTrue(AuthCrypto.isWithinClockSkew(timestamp, currentTime))
    }
    
    @Test
    fun `isExpired returns false for future timestamp`() {
        val currentTime = System.currentTimeMillis()
        val expiresAt = currentTime + 60000 // 1 minute in the future
        
        assertFalse(AuthCrypto.isExpired(expiresAt, currentTime))
    }
    
    @Test
    fun `isExpired returns true for past timestamp`() {
        val currentTime = System.currentTimeMillis()
        val expiresAt = currentTime - 60000 // 1 minute in the past
        
        assertTrue(AuthCrypto.isExpired(expiresAt, currentTime))
    }
    
    @Test
    fun `isExpired returns false for timestamp exactly at current time`() {
        val currentTime = System.currentTimeMillis()
        
        assertFalse(AuthCrypto.isExpired(currentTime, currentTime))
    }
    
    @Test
    fun `CLOCK_SKEW_MS is exactly 300000 (5 minutes)`() {
        assertEquals(300000L, AuthCrypto.CLOCK_SKEW_MS)
    }
}
