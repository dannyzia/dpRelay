package com.digitalpapyrus.authenticator

/**
 * STAGE F7 (ISSUE-87): gateway phone-number identity + app-scoped enrollment.
 *
 * Deliberately pure Kotlin — no Android imports — so the JVM unit tests can
 * pin the exact rules the server enforces without Robolectric or org.json
 * (the android.jar stubs are untestable here).
 *
 * The E.164 rule mirrors server-side `PHONE_NUMBER_PATTERN` in
 * server/src/routes/device.ts EXACTLY: `+880` plus 11 national digits, or a
 * generic `+` with 8–15 digits.
 */
object GatewayIdentity {

  /** Same pattern as the server: `/^\+880\d{10}$|^\+\d{8,15}$/`. */
  private val E164 = Regex("^\\+880\\d{10}$|^\\+\\d{8,15}$")

  /**
   * Validates a gateway phone number against the shared E.164 rule.
   *
   * @param number Candidate number (must be in international format).
   * @return true when the server would accept and store it.
   */
  fun isValidE164(number: String): Boolean = E164.matches(number)

  /**
   * Picks the bearer secret for POST /v5/device/enroll.
   *
   * A configured per-app secret wins (device binds to that app); otherwise
   * the global enrollment secret keeps the operator-fleet behavior of older
   * builds. Blank strings count as unset.
   *
   * @param appSecret The optional "App enrollment secret" from Settings.
   * @param globalSecret The deployment's global enrollment secret, if present.
   * @return The bearer to send, or null when neither is configured (enroll must be skipped).
   */
  fun selectEnrollmentBearer(appSecret: String?, globalSecret: String?): String? =
    appSecret?.takeIf { it.isNotBlank() } ?: globalSecret?.takeIf { it.isNotBlank() }

  /**
   * Builds the POST /v5/device/enroll field set: `label` always, plus
   * `phoneNumber` only when it passes the E.164 rule (the server ignores an
   * invalid number rather than failing enrollment — pre-validating here just
   * avoids shipping garbage over the wire).
   *
   * @param label Device label (Build.MODEL).
   * @param phoneNumber Stored gateway number, or null/blank when unknown.
   * @return Ordered field map for the JSON body.
   */
  fun enrollFields(label: String, phoneNumber: String?): Map<String, String> = buildMap {
    put("label", label)
    if (phoneNumber != null && phoneNumber.isNotBlank() && isValidE164(phoneNumber)) {
      put("phoneNumber", phoneNumber)
    }
  }
}
