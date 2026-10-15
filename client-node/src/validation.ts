/**
 * Fail-fast client-side validation, mirroring the v5 server's rules exactly so
 * a bad request is rejected before any network round-trip (and before any
 * error the server could produce is reachable). Accepted inputs are returned
 * NORMALIZED — formatting noise users paste in never reaches the wire, which
 * also keeps the bulk preview checksum computed over the same string the
 * server will re-parse at create time.
 */

/** Server's E164_PATTERN: `+`, first digit 1-9, then 7-14 more digits. */
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

/** Server's OTP_PATTERN: exactly 6 digits. */
const OTP_PATTERN = /^\d{6}$/;

/** Formatting noise carriers and users paste in: whitespace and dashes. */
const FORMATTING_NOISE = /[\s-]+/g;

/**
 * Normalize a phone number to strict E.164, or return null when it cannot be.
 * Accepts `unknown` so a JavaScript caller passing a non-string gets a typed
 * `null` instead of a `TypeError`.
 *
 * @param raw - Candidate phone number in any human formatting.
 * @returns The cleaned E.164 string (e.g. `"+8801712345678"`), or null.
 */
export function normalizePhoneNumber(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const candidate = raw.replace(FORMATTING_NOISE, "");
  return E164_PATTERN.test(candidate) ? candidate : null;
}

/**
 * True when a value is a strict E.164 phone number (whitespace/dashes allowed).
 *
 * @param raw - Candidate phone number.
 */
export function isValidE164(raw: unknown): boolean {
  return normalizePhoneNumber(raw) !== null;
}

/**
 * Normalize an OTP code to its 6-digit form, or return null when invalid.
 * Surrounding whitespace is trimmed (pasted codes) but internal characters are
 * not — anything other than exactly six digits is rejected.
 *
 * @param raw - Candidate OTP code.
 * @returns The trimmed 6-digit code, or null.
 */
export function normalizeOtp(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const candidate = raw.trim();
  return OTP_PATTERN.test(candidate) ? candidate : null;
}

/**
 * True when a value is exactly a 6-digit OTP code.
 *
 * @param raw - Candidate OTP code.
 */
export function isValidOtp(raw: unknown): boolean {
  return normalizeOtp(raw) !== null;
}
