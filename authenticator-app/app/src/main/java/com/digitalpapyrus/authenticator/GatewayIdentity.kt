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

  /** ISSUE-97 first-launch wizard input verdicts (AC2/AC3). */
  enum class OnboardingError { EMPTY_NUMBER, INVALID_NUMBER, EMPTY_SECRET }

  /**
   * Validates the first-launch wizard inputs BEFORE any network call (AC3),
   * enforcing the two mandatory fields of AC2. Fields are trimmed first so a
   * copy-paste with stray whitespace still matches the E.164 rule.
   *
   * @param number Raw gateway phone number field
   * @param secret Raw app enrollment secret field
   * @return null when both fields are usable, otherwise the first problem found
   */
  fun validateOnboarding(number: String, secret: String): OnboardingError? {
    val trimmedNumber = number.trim()
    if (trimmedNumber.isEmpty()) return OnboardingError.EMPTY_NUMBER
    if (!isValidE164(trimmedNumber)) return OnboardingError.INVALID_NUMBER
    if (secret.trim().isEmpty()) return OnboardingError.EMPTY_SECRET
    return null
  }

  /**
   * Exact human error for a rejected identity call (ISSUE-97 AC5/AC7).
   *
   * The server's own `error` string wins verbatim — that is the "exact human
   * error" the dialog must display. The code table below mirrors
   * server/src/routes/device.ts so a body-less rejection (or one that carries
   * only a `code`) still reads correctly; note the AC's shorthand differs
   * from the deployed contract in two places: the server sends 409 (not 403)
   * for device_limit_reached, 429 (not 403) for device_churn_limited, and
   * invalid_enrollment_secret (not invalid_secret) — both spellings are
   * accepted here so either shape renders human text.
   *
   * @param httpCode HTTP status of the rejection
   * @param code Machine-readable `code` field from the response body (may be empty)
   * @param serverError Human-readable `error` field from the response body (may be blank)
   * @return The message to display, or null when nothing usable is available
   */
  fun serverFailureMessage(httpCode: Int, code: String, serverError: String): String? =
    serverError.trim().takeIf { it.isNotEmpty() }
      ?: when (code) {
        "phone_number_exists" -> "Phone number is already registered to another device"
        "device_limit_reached" -> "Device slot limit reached for your plan — delete or unenroll a device first"
        "device_churn_limited" -> "Too many devices enrolled for this plan in the last 24 hours"
        "invalid_enrollment_secret", "invalid_secret" -> "Invalid enrollment secret"
        "enrollment_disabled" -> "Device enrollment is disabled"
        // No code to go on: a bare 401 can only be the secret being refused.
        else -> if (httpCode == 401) "Invalid enrollment secret" else null
      }

  /**
   * ISSUE-16: the enrollment gate shared by first launch (MainActivity
   * onCreate) and the in-app credential reset — no stored device API key
   * means (re-)enrollment must run before anything else. Pure so the JVM
   * tests pin the reprompt contract.
   *
   * @param deviceApiKey Stored v5 device API key, or null after a reset.
   * @return true when the onboarding wizard must be shown.
   */
  fun needsEnrollment(deviceApiKey: String?): Boolean = deviceApiKey == null
}
