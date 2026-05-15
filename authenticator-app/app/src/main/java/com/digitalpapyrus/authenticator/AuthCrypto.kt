package com.digitalpapyrus.authenticator

import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Cryptographic utilities for the Authenticator system.
 * 
 * This class provides:
 * - HMAC-SHA256 signature generation and verification
 * - Constant-time comparison to prevent timing attacks
 * - Cryptographically secure session code generation
 * - Clock skew validation
 */
object AuthCrypto {
    
    private const val HMAC_ALGORITHM = "HmacSHA256"
    private const val SESSION_CODE_LENGTH = 10
    private const val SESSION_CODE_CHARS = "0123456789ABCDEF"
    
    /**
     * Clock skew tolerance in milliseconds (5 minutes).
     * Both authenticator and Cloud Functions must use this exact value.
     */
    const val CLOCK_SKEW_MS = 300000L
    
    private val secureRandom = SecureRandom()
    
    /**
     * Generates a cryptographically secure session code.
     * Format: 10 uppercase hexadecimal characters (e.g., "A3F1B9C2E4").
     * 
     * Uses SecureRandom instead of UUID.randomUUID() for better entropy.
     * 
     * @return A 10-character uppercase hex string
     */
    fun generateSessionCode(): String {
        val bytes = ByteArray(SESSION_CODE_LENGTH)
        secureRandom.nextBytes(bytes)
        val sb = StringBuilder(SESSION_CODE_LENGTH)
        for (byte in bytes) {
            // Convert byte to unsigned int and map to hex char
            val index = (byte.toInt() and 0xFF) % SESSION_CODE_CHARS.length
            sb.append(SESSION_CODE_CHARS[index])
        }
        return sb.toString()
    }
    
    /**
     * Generates an HMAC-SHA256 signature.
     * 
     * @param secret The secret key (must be 32+ characters)
     * @param data The data to sign
     * @return Base64-encoded HMAC signature
     */
    fun generateHmac(secret: String, data: String): String {
        val mac = Mac.getInstance(HMAC_ALGORITHM)
        val secretKey = SecretKeySpec(secret.toByteArray(), HMAC_ALGORITHM)
        mac.init(secretKey)
        val signature = mac.doFinal(data.toByteArray())
        return Base64.getEncoder().encodeToString(signature)
    }
    
    /**
     * Constant-time comparison of two byte arrays.
     * 
     * This prevents timing attacks where an attacker measures response time
     * to guess the correct HMAC byte-by-byte.
     * 
     * @param a First byte array
     * @param b Second byte array
     * @return true if arrays are equal, false otherwise
     */
    fun constantTimeEquals(a: ByteArray, b: ByteArray): Boolean {
        if (a.size != b.size) {
            return false
        }
        
        var result = 0
        for (i in a.indices) {
            result = result or (a[i].toInt() xor b[i].toInt())
        }
        return result == 0
    }
    
    /**
     * Constant-time comparison of two Base64-encoded strings.
     * 
     * @param a First Base64 string
     * @param b Second Base64 string
     * @return true if decoded arrays are equal, false otherwise
     */
    fun constantTimeEquals(a: String, b: String): Boolean {
        return constantTimeEquals(
            Base64.getDecoder().decode(a),
            Base64.getDecoder().decode(b)
        )
    }
    
    /**
     * Validates that a timestamp is within the acceptable clock skew window.
     * 
     * @param timestamp The timestamp to validate (Unix milliseconds)
     * @param currentTime The current time (Unix milliseconds)
     * @return true if timestamp is within CLOCK_SKEW_MS of currentTime
     */
    fun isWithinClockSkew(timestamp: Long, currentTime: Long = System.currentTimeMillis()): Boolean {
        val diff = kotlin.math.abs(currentTime - timestamp)
        return diff <= CLOCK_SKEW_MS
    }
    
    /**
     * Checks if a verification request has expired.
     * 
     * @param expiresAt The expiry timestamp (Unix milliseconds)
     * @param currentTime The current time (Unix milliseconds)
     * @return true if the request has expired
     */
    fun isExpired(expiresAt: Long, currentTime: Long = System.currentTimeMillis()): Boolean {
        return currentTime > expiresAt
    }
}
