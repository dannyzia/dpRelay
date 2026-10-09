package com.digitalpapyrus.authenticator

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * STAGE F7 (ISSUE-87): pins the client-side identity rules against the exact
 * server contract (device.ts PHONE_NUMBER_PATTERN + enroll/phone-number
 * routes). Pure JVM — no Android runtime involved.
 */
class GatewayIdentityTest {

  @Test
  fun `accepts bangladeshi and generic international e164 numbers`() {
    // Owner's own gateway number format from the orders.
    assertTrue(GatewayIdentity.isValidE164("+8801613249520"))
    assertTrue(GatewayIdentity.isValidE164("+8801712345678"))
    // Generic international: + and 8..15 digits.
    assertTrue(GatewayIdentity.isValidE164("+14155552671"))
    assertTrue(GatewayIdentity.isValidE164("+12345678"))
    assertTrue(GatewayIdentity.isValidE164("+123456789012345"))
  }

  @Test
  fun `rejects local formats and malformed numbers`() {
    assertFalse(GatewayIdentity.isValidE164("01613249520")) // national format
    assertFalse(GatewayIdentity.isValidE164("8801613249520")) // missing +
    // NOTE (matches the server's own pattern): the OR-rule is a LENGTH rule —
    // `+880…` with 8–15 total digits also satisfies the generic branch, so only
    // sub-8-digit and over-15-digit inputs are rejected.
    assertFalse(GatewayIdentity.isValidE164("+880")) // prefix only, under 8 digits
    assertFalse(GatewayIdentity.isValidE164("+1234567")) // 7 digits < 8
    assertFalse(GatewayIdentity.isValidE164("+1234567890123456")) // 16 digits > 15
    assertFalse(GatewayIdentity.isValidE164(""))
    assertFalse(GatewayIdentity.isValidE164("+88016A3249520"))
    assertFalse(GatewayIdentity.isValidE164("+ 8801613249520"))
  }

  @Test
  fun `app enrollment secret wins over the global secret, blanks fall back to global`() {
    assertEquals(
      "app-secret",
      GatewayIdentity.selectEnrollmentBearer(appSecret = "app-secret", globalSecret = "global-secret"),
    )
    assertEquals(
      "global-secret",
      GatewayIdentity.selectEnrollmentBearer(appSecret = null, globalSecret = "global-secret"),
    )
    assertEquals(
      "global-secret",
      GatewayIdentity.selectEnrollmentBearer(appSecret = "   ", globalSecret = "global-secret"),
    )
    assertNull(GatewayIdentity.selectEnrollmentBearer(appSecret = null, globalSecret = null))
    assertNull(GatewayIdentity.selectEnrollmentBearer(appSecret = "", globalSecret = ""))
  }

  @Test
  fun `enroll payload always carries the label and only a valid phone number`() {
    assertEquals(
      mapOf("label" to "Redmi 9", "phoneNumber" to "+8801613249520"),
      GatewayIdentity.enrollFields("Redmi 9", "+8801613249520"),
    )
    // Absent / blank / malformed numbers are OMITTED (server treats missing
    // as "no number" — enrollment must never fail because of the phone).
    assertEquals(mapOf("label" to "Redmi 9"), GatewayIdentity.enrollFields("Redmi 9", null))
    assertEquals(mapOf("label" to "Redmi 9"), GatewayIdentity.enrollFields("Redmi 9", ""))
    assertEquals(mapOf("label" to "Redmi 9"), GatewayIdentity.enrollFields("Redmi 9", "01613249520"))
  }
}
