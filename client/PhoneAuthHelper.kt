package com.yourcompany.phoneauth

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONException
import org.json.JSONObject
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * Client-side helper for phone number verification and OTP authentication.
 *
 * This is a standalone library used by third-party client apps to talk to the
 * dP Relay v5 REST API. All requests authenticate with app-plane HTTP headers
 * (`X-App-Id` / `X-App-Secret`) against the live API — the deprecated Firebase
 * v4 Cloud Function URLs and their generated build-constants are gone.
 *
 * Three operations are exposed:
 *  1. [sendOtp]      — `POST /v5/otp/send`    → 201 with sessionId + expiresAt
 *  2. [verifyOtp]    — `POST /v5/otp/verify`  → 200 with verified + retry metadata
 *  3. [getOtpStatus] — `GET  /v5/otp/status`  → 200 with the latest session for a phone
 *
 * Every call dispatches on [Dispatchers.IO] and returns a typed [OtpResult];
 * transport, HTTP and parse failures are values in the result, never swallowed
 * exceptions. The documented precondition failures (bad phone / bad OTP shape)
 * are returned before any network I/O happens.
 *
 * SECURITY: `appSecret` is an app-plane credential and must NEVER be
 * hardcoded in a shipped APK, committed to VCS, or logged. Inject it from your
 * build configuration, or — for apps that must keep the secret server-side —
 * proxy these three calls through your own backend.
 */
object PhoneAuthHelper {

    /** Default dP Relay v5 REST API base URL (production). */
    const val DEFAULT_BASE_URL: String = "https://api.dprelay.digital-papyrus.com"

    /** Path of the OTP send endpoint (v5). */
    private const val PATH_SEND = "/v5/otp/send"

    /** Path of the OTP verify endpoint (v5). */
    private const val PATH_VERIFY = "/v5/otp/verify"

    /** Path of the OTP status endpoint (v5). */
    private const val PATH_STATUS = "/v5/otp/status"

    /**
     * Base URL used for every request. Configurable so staging/self-hosted
     * deployments do not require a code change; always override via build
     * configuration rather than editing source.
     */
    @Volatile
    var baseUrl: String = DEFAULT_BASE_URL
        set(value) {
            field = value.trim().trimEnd('/')
        }

    /** Connection timeout in milliseconds for every request. */
    @Volatile
    var connectTimeoutMs: Int = 30_000

    /** Read timeout in milliseconds for every request. */
    @Volatile
    var readTimeoutMs: Int = 30_000

    /** Strict E.164: an international number with a leading plus, no separators. */
    private val E164_REGEX = Regex("^\\+[1-9]\\d{7,14}$")

    /** OTP shape enforced by the v5 contract: exactly six digits. */
    private val OTP_REGEX = Regex("^\\d{6}$")

    /** Separators commonly pasted along with a phone number before validation. */
    private val SEPARATOR_REGEX = Regex("[\\s\\-()]")

    // ---------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------

    /**
     * Requests an OTP for [phoneNumber] via `POST /v5/otp/send`.
     *
     * @param appId     app-plane id sent as the `X-App-Id` header.
     * @param appSecret app-plane secret sent as the `X-App-Secret` header.
     * @param phoneNumber raw number; normalized and validated as strict E.164
     *        (`^\+[1-9]\d{7,14}$`) before any network I/O.
     * @param mode      optional delivery route (`byod` or `managed`); omitted
     *        from the request body when null so the server default applies.
     * @return [OtpResult.Success] with an [OtpSendReceipt] on HTTP 201, or
     *         [OtpResult.Error] carrying a typed [OtpFailure] (invalid phone,
     *         rate limit, insufficient credits, kill switch, auth, transport).
     */
    suspend fun sendOtp(
        appId: String,
        appSecret: String,
        phoneNumber: String,
        mode: OtpMode? = null,
    ): OtpResult<OtpSendReceipt> {
        val phone = normalizePhone(phoneNumber)
            ?: return OtpResult.Error(OtpFailure.InvalidPhone(INVALID_PHONE_MESSAGE))
        val spec = buildSendRequest(appId, appSecret, phone, mode, baseUrl)
        return when (val transport = execute(spec)) {
            is Transport.Failed -> OtpResult.Error(transport.toFailure())
            is Transport.Ok -> parseSendResponse(transport.response)
        }
    }

    /**
     * Verifies a six-digit OTP for [phoneNumber] via `POST /v5/otp/verify`.
     *
     * @param appId     app-plane id sent as the `X-App-Id` header.
     * @param appSecret app-plane secret sent as the `X-App-Secret` header.
     * @param phoneNumber raw number; normalized and validated as strict E.164.
     * @param otp       the code the user received; must be exactly six digits.
     * @param sessionId optional session id returned by [sendOtp]; forwarded in
     *        the body when the caller has it (the server resolves the session
     *        by phone number).
     * @return [OtpResult.Success] with an [OtpVerification] on HTTP 200 (both
     *         `verified = true` and a well-formed retry payload), or
     *         [OtpResult.Error] with a typed [OtpFailure] such as
     *         [OtpFailure.WrongOtp], [OtpFailure.Locked] or
     *         [OtpFailure.SessionExpired].
     */
    suspend fun verifyOtp(
        appId: String,
        appSecret: String,
        phoneNumber: String,
        otp: String,
        sessionId: String? = null,
    ): OtpResult<OtpVerification> {
        val phone = normalizePhone(phoneNumber)
            ?: return OtpResult.Error(OtpFailure.InvalidPhone(INVALID_PHONE_MESSAGE))
        if (!OTP_REGEX.matches(otp)) {
            return OtpResult.Error(OtpFailure.InvalidOtpFormat(INVALID_OTP_MESSAGE))
        }
        val spec = buildVerifyRequest(appId, appSecret, phone, otp, sessionId, baseUrl)
        return when (val transport = execute(spec)) {
            is Transport.Failed -> OtpResult.Error(transport.toFailure())
            is Transport.Ok -> parseVerifyResponse(transport.response)
        }
    }

    /**
     * Reads the latest OTP session for [phoneNumber] via `GET /v5/otp/status`.
     *
     * @param appId     app-plane id sent as the `X-App-Id` header.
     * @param appSecret app-plane secret sent as the `X-App-Secret` header.
     * @param phoneNumber raw number; normalized and validated as strict E.164
     *        and URL-encoded into the `phone` query parameter.
     * @return [OtpResult.Success] whose [OtpStatus.session] is null when the
     *         server reports no session for the number (v5 `404 not_found` is
     *         the expected "nothing pending" state for pollers, so it is
     *         surfaced as `session = null` rather than as an error), or
     *         [OtpResult.Error] for auth, rate limit, or transport failures.
     */
    suspend fun getOtpStatus(
        appId: String,
        appSecret: String,
        phoneNumber: String,
    ): OtpResult<OtpStatus> {
        val phone = normalizePhone(phoneNumber)
            ?: return OtpResult.Error(OtpFailure.InvalidPhone(INVALID_PHONE_MESSAGE))
        val spec = buildStatusRequest(appId, appSecret, phone, baseUrl)
        return when (val transport = execute(spec)) {
            is Transport.Failed -> OtpResult.Error(transport.toFailure())
            is Transport.Ok -> parseStatusResponse(transport.response)
        }
    }

    // ---------------------------------------------------------------------
    // Request building (pure — exercised directly by the contract tests)
    // ---------------------------------------------------------------------

    /**
     * Builds the `POST /v5/otp/send` request: app-plane auth headers plus a
     * `{"phone", "mode?"}` JSON body. `mode` is omitted when null.
     *
     * @param phone already-validated strict E.164 number.
     */
    internal fun buildSendRequest(
        appId: String,
        appSecret: String,
        phone: String,
        mode: OtpMode?,
        baseUrl: String,
    ): RequestSpec {
        val payload = JSONObject().apply {
            put("phone", phone)
            if (mode != null) put("mode", mode.wire)
        }
        return RequestSpec(
            method = "POST",
            url = baseUrl + PATH_SEND,
            headers = jsonHeaders(appId, appSecret),
            body = payload.toString(),
        )
    }

    /**
     * Builds the `POST /v5/otp/verify` request: app-plane auth headers plus a
     * `{"phone", "otp", "sessionId?"}` JSON body.
     *
     * @param phone already-validated strict E.164 number.
     * @param otp   already-validated six-digit code.
     */
    internal fun buildVerifyRequest(
        appId: String,
        appSecret: String,
        phone: String,
        otp: String,
        sessionId: String?,
        baseUrl: String,
    ): RequestSpec {
        val payload = JSONObject().apply {
            put("phone", phone)
            put("otp", otp)
            if (sessionId != null) put("sessionId", sessionId)
        }
        return RequestSpec(
            method = "POST",
            url = baseUrl + PATH_VERIFY,
            headers = jsonHeaders(appId, appSecret),
            body = payload.toString(),
        )
    }

    /**
     * Builds the `GET /v5/otp/status` request: app-plane auth headers and the
     * strict E.164 number URL-encoded into the `phone` query parameter.
     *
     * @param phone already-validated strict E.164 number.
     */
    internal fun buildStatusRequest(
        appId: String,
        appSecret: String,
        phone: String,
        baseUrl: String,
    ): RequestSpec {
        return RequestSpec(
            method = "GET",
            url = baseUrl + PATH_STATUS + "?phone=" + URLEncoder.encode(phone, "UTF-8"),
            headers = mapOf(
                HEADER_APP_ID to appId,
                HEADER_APP_SECRET to appSecret,
            ),
            body = null,
        )
    }

    /** App-plane credential headers plus the JSON content type. */
    private fun jsonHeaders(appId: String, appSecret: String): Map<String, String> = mapOf(
        HEADER_APP_ID to appId,
        HEADER_APP_SECRET to appSecret,
        "Content-Type" to "application/json",
    )

    /**
     * Normalizes a caller-supplied number into strict E.164 form.
     *
     * Surrounding whitespace, spaces, dashes and parentheses are removed and a
     * leading `00` international prefix is rewritten to `+`. Nothing else is
     * rewritten: the result must still match `^\+[1-9]\d{7,14}$`.
     *
     * @return the normalized number, or null when it cannot be strict E.164.
     */
    internal fun normalizePhone(raw: String): String? {
        val trimmed = raw.trim()
        val withPlus = if (trimmed.startsWith("00")) "+" + trimmed.substring(2) else trimmed
        val candidate = withPlus.replace(SEPARATOR_REGEX, "")
        return candidate.takeIf { E164_REGEX.matches(it) }
    }

    // ---------------------------------------------------------------------
    // Transport
    // ---------------------------------------------------------------------

    /**
     * Executes a [RequestSpec] on [Dispatchers.IO].
     *
     * @return the raw HTTP status/body, or a [Transport.Failed] carrying the
     *         [IOException] instead of throwing it at the call site.
     */
    private suspend fun execute(spec: RequestSpec): Transport = withContext(Dispatchers.IO) {
        try {
            val connection = URL(spec.url).openConnection() as HttpURLConnection
            try {
                connection.requestMethod = spec.method
                spec.headers.forEach { (name, value) -> connection.setRequestProperty(name, value) }
                connection.connectTimeout = connectTimeoutMs
                connection.readTimeout = readTimeoutMs

                val payload = spec.body
                if (payload != null) {
                    connection.doOutput = true
                    connection.outputStream.use { out ->
                        out.write(payload.toByteArray(Charsets.UTF_8))
                    }
                }

                val status = connection.responseCode
                val stream = if (status >= 400) connection.errorStream else connection.inputStream
                val body = stream?.use { input ->
                    BufferedReader(InputStreamReader(input, Charsets.UTF_8)).use { reader -> reader.readText() }
                } ?: ""
                val retryAfterSec = connection.getHeaderField("Retry-After")?.toLongOrNull()

                Transport.Ok(RawResponse(status, body, retryAfterSec))
            } finally {
                connection.disconnect()
            }
        } catch (io: IOException) {
            Transport.Failed(io)
        }
    }

    // ---------------------------------------------------------------------
    // Response parsing (pure — exercised directly by the contract tests)
    // ---------------------------------------------------------------------

    /**
     * Maps the `POST /v5/otp/send` response onto a typed result.
     *
     * @param response raw status/body from [execute].
     * @return success for HTTP 201 (`sessionId`, `expiresAt`), otherwise an
     *         error mapped by [failureFor].
     */
    internal fun parseSendResponse(response: RawResponse): OtpResult<OtpSendReceipt> {
        if (response.status != 201) {
            return OtpResult.Error(failureFor(response))
        }
        val json = parseJson(response.body)
            ?: return OtpResult.Error(OtpFailure.MalformedResponse("send response was not JSON"))
        val sessionId = json.optStringOrNull("sessionId")
            ?: return OtpResult.Error(OtpFailure.MalformedResponse("send response missing sessionId"))
        val expiresAt = json.optLongOrNull("expiresAt")
            ?: return OtpResult.Error(OtpFailure.MalformedResponse("send response missing expiresAt"))
        return OtpResult.Success(OtpSendReceipt(sessionId = sessionId, expiresAt = expiresAt))
    }

    /**
     * Maps the `POST /v5/otp/verify` response onto a typed result.
     *
     * Accepts both the v5 contract envelope (`verified`, `reason`,
     * `attemptsRemaining`, `lockedUntil`) and the live server's field alias
     * (`attemptsLeft`), so either side of the contract parses correctly.
     *
     * @param response raw status/body from [execute].
     */
    internal fun parseVerifyResponse(response: RawResponse): OtpResult<OtpVerification> {
        if (response.status != 200) {
            return OtpResult.Error(failureFor(response))
        }
        val json = parseJson(response.body)
            ?: return OtpResult.Error(OtpFailure.MalformedResponse("verify response was not JSON"))
        if (!json.has("verified")) {
            return OtpResult.Error(OtpFailure.MalformedResponse("verify response missing verified"))
        }
        return OtpResult.Success(
            OtpVerification(
                verified = json.optBoolean("verified", false),
                reason = json.optStringOrNull("reason"),
                attemptsRemaining = json.optIntOrNull("attemptsRemaining")
                    ?: json.optIntOrNull("attemptsLeft"),
                lockedUntil = json.optLongOrNull("lockedUntil"),
            ),
        )
    }

    /**
     * Maps the `GET /v5/otp/status` response onto a typed result.
     *
     * Accepts the v5 contract envelope (`session: {...}`) and the live
     * server's flat envelope (`status`, `expiresAt`, `attemptsLeft`,
     * `lockedUntil`, `verifiedAt`); a `404 not_found` becomes
     * `Success(OtpStatus(session = null))`.
     *
     * @param response raw status/body from [execute].
     */
    internal fun parseStatusResponse(response: RawResponse): OtpResult<OtpStatus> {
        if (response.status == 404 && parseJson(response.body)?.optStringOrNull("code") == "not_found") {
            return OtpResult.Success(OtpStatus(session = null))
        }
        if (response.status != 200) {
            return OtpResult.Error(failureFor(response))
        }
        val json = parseJson(response.body)
            ?: return OtpResult.Error(OtpFailure.MalformedResponse("status response was not JSON"))

        val session = json.optJSONObject("session")
        if (session != null) {
            val status = session.optStringOrNull("status")
                ?: return OtpResult.Error(OtpFailure.MalformedResponse("status session missing status"))
            return OtpResult.Success(
                OtpStatus(
                    session = OtpSessionInfo(
                        id = session.optStringOrNull("id"),
                        phone = session.optStringOrNull("phone"),
                        status = status,
                        attempts = session.optIntOrNull("attempts"),
                        attemptsRemaining = session.optIntOrNull("attemptsRemaining"),
                        expiresAt = session.optLongOrNull("expiresAt"),
                        createdAt = session.optLongOrNull("createdAt"),
                        verifiedAt = session.optLongOrNull("verifiedAt"),
                        lockedUntil = session.optLongOrNull("lockedUntil"),
                    ),
                ),
            )
        }

        // Flat (live-server) envelope: no `session` object, status at the root.
        val status = json.optStringOrNull("status")
            ?: return OtpResult.Error(OtpFailure.MalformedResponse("status response missing status"))
        return OtpResult.Success(
            OtpStatus(
                session = OtpSessionInfo(
                    id = json.optStringOrNull("id"),
                    phone = json.optStringOrNull("phone"),
                    status = status,
                    attempts = json.optIntOrNull("attempts"),
                    attemptsRemaining = json.optIntOrNull("attemptsLeft"),
                    expiresAt = json.optLongOrNull("expiresAt"),
                    createdAt = json.optLongOrNull("createdAt"),
                    verifiedAt = json.optLongOrNull("verifiedAt"),
                    lockedUntil = json.optLongOrNull("lockedUntil"),
                ),
            ),
        )
    }

    /**
     * Maps a non-success HTTP response onto a typed [OtpFailure].
     *
     * The v5 contract codes are matched first (`invalid_phone`,
     * `insufficient_credits`, `rate_limited`, `sms_paused` /
     * `kill_switch_active`), then the HTTP status, so unknown future codes
     * still surface as a diagnosable [OtpFailure.Unexpected] instead of being
     * dropped.
     */
    internal fun failureFor(response: RawResponse): OtpFailure {
        val json = parseJson(response.body)
        val code = json?.optStringOrNull("code")
        val message = json?.optStringOrNull("error")
            ?: "dP Relay request failed (HTTP ${response.status})"

        return when (response.status) {
            400 -> when (code) {
                "invalid_phone" -> OtpFailure.InvalidPhone(message)
                "invalid_otp_format" -> OtpFailure.InvalidOtpFormat(message)
                "otp_expired" -> OtpFailure.SessionExpired(message)
                else -> OtpFailure.Unexpected(response.status, code, message)
            }

            401 -> when (code) {
                "invalid_otp" -> OtpFailure.WrongOtp(
                    attemptsRemaining = json?.optIntOrNull("attemptsLeft")
                        ?: json?.optIntOrNull("attemptsRemaining"),
                    message = message,
                )

                else -> OtpFailure.AuthRejected(code ?: "unauthorized", message)
            }

            402 -> OtpFailure.InsufficientCredits(message)

            403 -> OtpFailure.AuthRejected(code ?: "forbidden", message)

            404 -> OtpFailure.NotFound(message)

            423 -> OtpFailure.Locked(
                retryAfterSec = response.retryAfterSec ?: json?.optLongOrNull("retryAfterSec"),
                lockedUntil = json?.optLongOrNull("lockedUntil"),
                message = message,
            )

            429 -> OtpFailure.RateLimited(
                code = code ?: "rate_limited",
                retryAfterSec = response.retryAfterSec ?: json?.optLongOrNull("retryAfterSec"),
                message = message,
            )

            503 -> OtpFailure.ServicePaused(code ?: "kill_switch_active", message)

            else -> OtpFailure.Unexpected(response.status, code, message)
        }
    }

    /** Parses a response body, returning null instead of throwing on bad JSON. */
    private fun parseJson(body: String): JSONObject? = try {
        JSONObject(body)
    } catch (broken: JSONException) {
        null
    }

    /** Reads a present, non-null JSON string field or null when absent/blank. */
    private fun JSONObject.optStringOrNull(name: String): String? =
        if (has(name) && !isNull(name)) optString(name).takeIf { it.isNotEmpty() } else null

    /** Reads a present, non-null JSON int field or null when absent. */
    private fun JSONObject.optIntOrNull(name: String): Int? =
        if (has(name) && !isNull(name)) optInt(name) else null

    /** Reads a present, non-null JSON long field or null when absent. */
    private fun JSONObject.optLongOrNull(name: String): Long? =
        if (has(name) && !isNull(name)) optLong(name) else null

    private fun Transport.Failed.toFailure(): OtpFailure =
        OtpFailure.Network(exception.message ?: "network error", exception)

    /** Message returned when a number cannot be strict E.164. */
    private const val INVALID_PHONE_MESSAGE = "phone must be strict E.164, e.g. +8801XXXXXXXXX"

    /** Message returned when the OTP is not six digits. */
    private const val INVALID_OTP_MESSAGE = "otp must be 6 digits"

    /** Header carrying the app-plane id on every v5 request. */
    private const val HEADER_APP_ID = "X-App-Id"

    /** Header carrying the app-plane secret on every v5 request. */
    private const val HEADER_APP_SECRET = "X-App-Secret"
}

/** Delivery route advertised by `POST /v5/otp/send`; null selects the server default. */
enum class OtpMode(val wire: String) {
    /** BYOD route: an enrolled gateway phone sends the OTP SMS. */
    BYOD("byod"),

    /** Managed route: dP Relay sends the OTP SMS on the operator's behalf. */
    MANAGED("managed"),
}

/**
 * Outcome of a v5 call: either a typed [Success] payload or a typed [Error]
 * carrying an [OtpFailure]. Nothing is thrown across the public API.
 *
 * @param T payload type of the successful branch.
 */
sealed class OtpResult<out T> {

    /** The request succeeded and the payload parsed against the v5 contract. */
    data class Success<T>(val value: T) : OtpResult<T>()

    /** The request failed in a way the caller should branch on. */
    data class Error(val failure: OtpFailure) : OtpResult<Nothing>()
}

/**
 * Typed failure reasons for v5 OTP calls. [code] is the machine-readable
 * dP Relay error code (or a synthetic `network_error` / `malformed_response` /
 * `http_<status>` when the server did not supply one).
 */
sealed class OtpFailure {

    /** Machine-readable error code. */
    abstract val code: String

    /** Human-readable message; safe to log, never contains the app secret. */
    abstract val message: String

    /** HTTP 400 `invalid_phone`: the number is not strict E.164. */
    data class InvalidPhone(override val message: String) : OtpFailure() {
        override val code: String get() = "invalid_phone"
    }

    /** HTTP 400 `invalid_otp_format`: the OTP is not six digits. */
    data class InvalidOtpFormat(override val message: String) : OtpFailure() {
        override val code: String get() = "invalid_otp_format"
    }

    /** HTTP 400 `otp_expired`: no active session remains for the number. */
    data class SessionExpired(override val message: String) : OtpFailure() {
        override val code: String get() = "otp_expired"
    }

    /** HTTP 401 `invalid_otp`: wrong code; [attemptsRemaining] reports how many tries are left. */
    data class WrongOtp(val attemptsRemaining: Int?, override val message: String) : OtpFailure() {
        override val code: String get() = "invalid_otp"
    }

    /** HTTP 423 `otp_locked`: too many failed attempts; [retryAfterSec] is the lockout window. */
    data class Locked(
        val retryAfterSec: Long?,
        val lockedUntil: Long?,
        override val message: String,
    ) : OtpFailure() {
        override val code: String get() = "otp_locked"
    }

    /**
     * HTTP 429: per-app session limit (`rate_limited`) or per-number resend
     * cooldown (`resend_cooldown`). [retryAfterSec] mirrors the `Retry-After`
     * header when the server sent one.
     */
    data class RateLimited(
        override val code: String,
        val retryAfterSec: Long?,
        override val message: String,
    ) : OtpFailure()

    /** HTTP 402 `insufficient_credits`: the account balance cannot cover the send. */
    data class InsufficientCredits(override val message: String) : OtpFailure() {
        override val code: String get() = "insufficient_credits"
    }

    /**
     * HTTP 503: the global SMS pause is active (`sms_paused` on the live
     * server, `kill_switch_active` in the contract). Sends are rejected while
     * verification keeps working.
     */
    data class ServicePaused(override val code: String, override val message: String) : OtpFailure()

    /** HTTP 401/403 on app-plane auth: missing/invalid credentials or a revoked app. */
    data class AuthRejected(override val code: String, override val message: String) : OtpFailure()

    /** HTTP 404 `not_found` on an endpoint where absence is not a normal state. */
    data class NotFound(override val message: String) : OtpFailure() {
        override val code: String get() = "not_found"
    }

    /** Socket/DNS/TLS failure; [cause] is the underlying [IOException]. */
    data class Network(override val message: String, val cause: Throwable?) : OtpFailure() {
        override val code: String get() = "network_error"
    }

    /** The server answered with a body that does not match the v5 contract. */
    data class MalformedResponse(override val message: String) : OtpFailure() {
        override val code: String get() = "malformed_response"
    }

    /** Any other HTTP status, kept diagnosable via [status] and [rawCode]. */
    data class Unexpected(val status: Int, val rawCode: String?, override val message: String) : OtpFailure() {
        override val code: String get() = rawCode ?: "http_$status"
    }
}

/** Receipt from `POST /v5/otp/send` (HTTP 201). */
data class OtpSendReceipt(
    /** Server-generated session id for the pending OTP. */
    val sessionId: String,

    /** Epoch milliseconds at which the session stops being verifiable. */
    val expiresAt: Long,
)

/**
 * Outcome of `POST /v5/otp/verify` (HTTP 200).
 *
 * @property verified whether the OTP matched the pending session.
 * @property reason machine-readable reason when the server attaches one.
 * @property attemptsRemaining tries left before lockout, when reported.
 * @property lockedUntil epoch milliseconds until which verifying is blocked.
 */
data class OtpVerification(
    val verified: Boolean,
    val reason: String? = null,
    val attemptsRemaining: Int? = null,
    val lockedUntil: Long? = null,
)

/** Outcome of `GET /v5/otp/status` (HTTP 200); null [session] means no session exists. */
data class OtpStatus(
    val session: OtpSessionInfo?,
)

/**
 * Snapshot of the latest OTP session for a number.
 *
 * v5 advertises `pending` / `verified` / `expired` as the status values; every
 * field except [status] is optional because the contract envelope and the live
 * flat envelope do not carry the same keys.
 */
data class OtpSessionInfo(
    val id: String?,
    val phone: String?,
    val status: String,
    val attempts: Int?,
    val attemptsRemaining: Int?,
    val expiresAt: Long?,
    val createdAt: Long?,
    val verifiedAt: Long?,
    val lockedUntil: Long?,
)

/** A fully built HTTP request, kept pure so contract tests can assert on it. */
internal data class RequestSpec(
    val method: String,
    val url: String,
    val headers: Map<String, String>,
    val body: String?,
)

/** Raw server answer: HTTP status, body text, and the optional `Retry-After`. */
internal data class RawResponse(
    val status: Int,
    val body: String,
    val retryAfterSec: Long? = null,
)

/** Result of transport: a parsed response, or the I/O failure that prevented one. */
private sealed class Transport {
    data class Ok(val response: RawResponse) : Transport()
    data class Failed(val exception: IOException) : Transport()
}
