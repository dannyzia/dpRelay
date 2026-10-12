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

  @Test
  fun `onboarding wizard enforces both mandatory fields before any network call`() {
    // AC2/AC3: valid input passes, trimmed of copy-paste whitespace.
    assertNull(GatewayIdentity.validateOnboarding("+8801613249520", "secret-from-dashboard"))
    assertNull(GatewayIdentity.validateOnboarding("  +14155552671  ", " x "))
    // Mandatory number (AC2).
    assertEquals(
      GatewayIdentity.OnboardingError.EMPTY_NUMBER,
      GatewayIdentity.validateOnboarding("", "s"),
    )
    assertEquals(
      GatewayIdentity.OnboardingError.EMPTY_NUMBER,
      GatewayIdentity.validateOnboarding("   ", "s"),
    )
    // Client-side E.164 gate (AC3): the +880 prefill alone is not valid yet,
    // and a national-format number is refused before any server round-trip.
    assertEquals(
      GatewayIdentity.OnboardingError.INVALID_NUMBER,
      GatewayIdentity.validateOnboarding("+880", "s"),
    )
    assertEquals(
      GatewayIdentity.OnboardingError.INVALID_NUMBER,
      GatewayIdentity.validateOnboarding("01613249520", "s"),
    )
    // Mandatory secret (AC2).
    assertEquals(
      GatewayIdentity.OnboardingError.EMPTY_SECRET,
      GatewayIdentity.validateOnboarding("+8801613249520", ""),
    )
    assertEquals(
      GatewayIdentity.OnboardingError.EMPTY_SECRET,
      GatewayIdentity.validateOnboarding("+8801613249520", "   "),
    )
    // A bad number is reported before the missing secret (first problem wins).
    assertEquals(
      GatewayIdentity.OnboardingError.INVALID_NUMBER,
      GatewayIdentity.validateOnboarding("nope", ""),
    )
  }

  @Test
  fun `server failure messages show the exact human error first, code table second`() {
    // AC5: the server's own `error` text wins VERBATIM on any status code —
    // including a body that disagrees with the mirror table below.
    assertEquals(
      "Invalid enrollment secret",
      GatewayIdentity.serverFailureMessage(401, "invalid_secret", "Invalid enrollment secret"),
    )
    assertEquals(
      "Rejected by policy",
      GatewayIdentity.serverFailureMessage(403, "device_limit_reached", "Rejected by policy"),
    )

    // No usable `error` text: the table mirrors server/src/routes/device.ts,
    // covering BOTH the deployed codes and the AC's shorthand spellings
    // (the AC says 403 device_limit_reached / 403 device_churn_limited, while
    // the server actually answers 409 / 429 — the code, not the status, is
    // what the table keys on).
    assertEquals(
      "Device slot limit reached for your plan — delete or unenroll a device first",
      GatewayIdentity.serverFailureMessage(409, "device_limit_reached", ""),
    )
    assertEquals(
      "Too many devices enrolled for this plan in the last 24 hours",
      GatewayIdentity.serverFailureMessage(429, "device_churn_limited", ""),
    )
    assertEquals(
      "Phone number is already registered to another device",
      GatewayIdentity.serverFailureMessage(409, "phone_number_exists", "   "),
    )
    // Deployed spelling (device.ts) and the AC's `invalid_secret` shorthand.
    assertEquals(
      "Invalid enrollment secret",
      GatewayIdentity.serverFailureMessage(401, "invalid_enrollment_secret", ""),
    )
    assertEquals(
      "Invalid enrollment secret",
      GatewayIdentity.serverFailureMessage(401, "invalid_secret", ""),
    )
    assertEquals(
      "Device enrollment is disabled",
      GatewayIdentity.serverFailureMessage(403, "enrollment_disabled", ""),
    )
    // A bare 401 with no body can only be the secret being refused.
    assertEquals("Invalid enrollment secret", GatewayIdentity.serverFailureMessage(401, "", ""))
    // Unmapped, non-401 rejection: null tells the caller to use its own
    // generic fallback (with the raw code) instead of inventing a verdict.
    assertNull(GatewayIdentity.serverFailureMessage(500, "internal_error", "  "))
  }

  @Test
  fun `needsEnrollment gates on a missing device API key only (ISSUE-16 reprompt contract)`() {
    // After clearDeviceCredentials the key is gone → the wizard reopens.
    assertTrue(GatewayIdentity.needsEnrollment(null))
    // Any stored key (enrolled, or mid re-enrollment) keeps the gate shut.
    assertFalse(GatewayIdentity.needsEnrollment("0123456789abcdef"))
    assertFalse(GatewayIdentity.needsEnrollment("a".repeat(64)))
  }
}
