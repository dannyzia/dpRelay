/**
 * dP Relay v5 REST client — zero runtime dependencies (Node 18+ global fetch).
 *
 * Design rules:
 *  - Fail fast: every phone number, OTP and required field is validated in
 *    process, so a malformed call rejects without issuing a request.
 *  - Type every failure: the server's `{ ok:false, error, code }` envelope is
 *    mapped onto the errors.ts hierarchy; transport failures become NetworkError.
 *  - Trust nothing on the way back: success payloads are read field by field,
 *    and a payload that does not match the v5 contract raises a typed
 *    `invalid_response` error instead of yielding `undefined` at the call site.
 */

import {
  AuthenticationError,
  DpRelayError,
  InsufficientCreditsError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from "./errors.js";
import { normalizeOtp, normalizePhoneNumber } from "./validation.js";

/** Default API origin used when no `baseUrl` is supplied. */
export const DEFAULT_BASE_URL = "https://api.dprelay.digital-papyrus.com";

/** Default per-request budget enforced with `AbortSignal.timeout`. */
export const DEFAULT_TIMEOUT_MS = 30000;

/** Constructor options for {@link DpRelayClient}. */
export interface DpRelayClientOptions {
  /** Public app identifier sent as the `X-App-Id` header. */
  appId: string;
  /** App secret sent as the `X-App-Secret` header (never logged, never stored beyond the client). */
  appSecret: string;
  /** API origin override; defaults to {@link DEFAULT_BASE_URL}. A trailing slash is tolerated. */
  baseUrl?: string;
  /** Per-request timeout in milliseconds; defaults to {@link DEFAULT_TIMEOUT_MS}. Must be > 0. */
  timeoutMs?: number;
}

/** OTP delivery mode. The v5 server currently derives the mode from the app's own configuration; the value is validated and forwarded for forward compatibility. */
export type OtpMode = "byod" | "managed";

/** Lifecycle state of an OTP session as reported by `GET /v5/otp/status`. */
export type OtpSessionStatus = "pending" | "verified" | "expired";

/** Parameters for `DpRelayClient.sendOtp`. */
export interface SendOtpParams {
  /** Destination in strict E.164 (formatting noise is stripped before sending). */
  phoneNumber: string;
  /** Optional delivery mode. */
  mode?: OtpMode;
}

/** Parameters for `DpRelayClient.verifyOtp`. */
export interface VerifyOtpParams {
  /** Number the OTP was sent to, in strict E.164. */
  phoneNumber: string;
  /** The 6-digit code entered by the user. */
  otp: string;
  /** Optional session hint. The v5 server resolves the active session from (app, phone); the value is forwarded for forward compatibility. */
  sessionId?: string;
}

/** Result of a successful `POST /v5/otp/send`. */
export interface OtpSendReceipt {
  sessionId: string;
  /** Expiry as a Unix timestamp in SECONDS. */
  expiresAt: number;
}

/** Result of `POST /v5/otp/verify`. */
export interface OtpVerifyResult {
  /** True only when the server explicitly confirmed the code. Fail-closed: any payload without `verified: true` yields false. */
  verified: boolean;
  /** Wrong-code attempts left before lockout, when the server reported it. */
  attemptsRemaining?: number;
  /** Lockout expiry as a Unix timestamp in SECONDS, when locked out. */
  lockoutUntil?: number;
}

/** Result of `GET /v5/otp/status`. */
export interface OtpStatusResult {
  status: OtpSessionStatus;
  /** Session expiry as a Unix timestamp in SECONDS. */
  expiresAt: number;
  /** Attempts left while the session is pending (0 once resolved). */
  attemptsLeft: number;
  /** Lockout expiry as a Unix timestamp in SECONDS, or null when not locked. */
  lockedUntil: number | null;
  /** Verification time as a Unix timestamp in SECONDS, or null when unverified. */
  verifiedAt: number | null;
}

/** A recipient row the server rejected, with its line number in the submitted list. */
export interface BulkInvalidRow {
  line: number;
  reason: string;
}

/** Parameters for `DpRelayClient.previewBulk`: raw CSV, or an explicit recipient list. */
export type BulkPreviewParams = { csvData: string } | { recipients: string[]; message: string };

/** Result of `POST /v5/bulk/campaigns/preview` (spends nothing, stores nothing). */
export interface BulkPreviewResult {
  /** Rows read: valid + invalid. */
  count: number;
  /** Rows that parsed as strict E.164. */
  validCount: number;
  /** Rows the server rejected (line-numbered). */
  invalidCount: number;
  /** Upper-bound credit cost: 1 per valid recipient BEFORE de-duplication. The create response's `creditsReserved` is authoritative. */
  estimatedCredits: number;
  /** Binding checksum: `createBulkCampaign` must submit it unchanged. */
  checksum: string;
  invalidRows: BulkInvalidRow[];
  /** First five valid numbers, for eyeballing the list before spending. */
  sampleFirst5: string[];
  /** True when the CSV's first line was treated as a header and skipped. */
  headerSkipped: boolean;
  /** Per-campaign recipient cap enforced at create time. */
  perCampaignLimit: number;
}

/** Parameters for `DpRelayClient.createBulkCampaign`. */
export interface BulkCreateParams {
  name: string;
  message: string;
  /** Must match the list the preview checksum was computed over, in the same order. */
  recipients: string[];
  /** Checksum returned by `previewBulk`. */
  checksum: string;
}

/** Result of `POST /v5/bulk/campaigns`. */
export interface BulkCreateResult {
  campaignId: string;
  status: string;
  /** Recipients enqueued (equals `totalRecipients`). */
  enqueuedCount: number;
  totalRecipients: number;
  /** Credits actually moved: 0 for a campaign riding an unlimited BYOD pass. */
  creditsReserved: number;
  unlimitedPass: boolean;
  /** Charset the server picked for the message: `"gsm7"` or `"ucs2"`. */
  charset: string;
  /** Duplicates the server dropped, when any were present. */
  duplicateCount?: number;
}

/** Result of `GET /v5/bulk/campaigns/:id`. */
export interface BulkCampaignStatusResult {
  campaignId: string;
  name: string;
  status: string;
  sourceType: string;
  totalRecipients: number;
  sentCount: number;
  failedCount: number;
  queuedCount: number;
  /** Unix timestamp in SECONDS. */
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  unlimitedPass: boolean;
}

type HttpMethod = "GET" | "POST";

interface RawResponse {
  status: number;
  ok: boolean;
  parsed: unknown;
}

interface ErrorEnvelope {
  code: string;
  message: string;
}

/** Narrow to a JSON object; arrays, scalars and null are not envelopes. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Require a JSON object where the contract says one exists, else typed invalid_response. */
function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new DpRelayError(`Malformed ${label} response: expected a JSON object`, "invalid_response", null);
  }
  return value;
}

/**
 * Best-effort object view of a body for ERROR handling: a non-object or empty
 * body still has to produce a typed error, so it degrades to an empty envelope
 * (message falls back to the status) rather than throwing a second error while
 * reporting the first one.
 */
function asBody(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") {
    throw new DpRelayError(`Malformed response: "${key}" must be a string`, "invalid_response", null);
  }
  return value;
}

function requireNumber(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number") {
    throw new DpRelayError(`Malformed response: "${key}" must be a number`, "invalid_response", null);
  }
  return value;
}

function requireArray<T>(body: Record<string, unknown>, key: string): T[] {
  const value = body[key];
  if (!Array.isArray(value)) {
    throw new DpRelayError(`Malformed response: "${key}" must be an array`, "invalid_response", null);
  }
  return value as T[];
}

/** Optional number field: present-and-numeric becomes a value, anything else stays undefined. */
function numField(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  return typeof value === "number" ? value : undefined;
}

/** Nullable number field: present-and-numeric becomes a value, anything else becomes null. */
function nullableNumber(body: Record<string, unknown>, key: string): number | null {
  const value = body[key];
  return typeof value === "number" ? value : null;
}

/** Required non-empty string argument (client-side, before any request). */
function requireArgString(value: unknown, label: string, code: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${label} is required`, code, null);
  }
  return value;
}

/**
 * Validate and normalize a recipient list: must be a non-empty array whose
 * entries all become strict E.164. Normalization here is what lets a caller
 * paste human-formatted numbers and still produce a checksum the server
 * reproduces at create time.
 */
function requireE164List(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidationError(`${label} must be a non-empty array of E.164 numbers`, "invalid_recipients", null);
  }
  const cleaned: string[] = [];
  for (const entry of value) {
    const phone = normalizePhoneNumber(entry);
    if (phone === null) {
      throw new ValidationError(`${label}: ${String(entry)} is not strict E.164`, "invalid_phone", null);
    }
    cleaned.push(phone);
  }
  return cleaned;
}

/** Parse a response body, treating unparseable text as "no payload". */
function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * Read the `{ code, error }` fields out of a server error envelope, falling
 * back to status-derived defaults so an empty or non-JSON error body still
 * yields a typed, distinguishable error.
 */
function envelope(status: number, body: Record<string, unknown>): ErrorEnvelope {
  const code = typeof body.code === "string" ? body.code : `http_${status}`;
  const message = typeof body.error === "string" ? body.error : `HTTP ${status}`;
  return { code, message };
}

/** Map an HTTP failure status onto the typed hierarchy. */
function errorFrom(status: number, body: Record<string, unknown>): DpRelayError {
  const { code, message } = envelope(status, body);
  switch (status) {
    case 400:
      return new ValidationError(message, code, status);
    case 401:
      return new AuthenticationError(message, code, status);
    case 402:
      return new InsufficientCreditsError(message, code, status);
    case 404:
      return new NotFoundError(message, code, status);
    case 429:
      return new RateLimitError(message, code, status);
    default:
      return new DpRelayError(message, code, status);
  }
}

/** Classify a fetch rejection: `AbortSignal.timeout` rejects with TimeoutError. */
function toNetworkError(err: unknown, timeoutMs: number): NetworkError {
  if (err instanceof Error && err.name === "TimeoutError") {
    return new NetworkError(`Request timed out after ${timeoutMs}ms`, "timeout", null, err);
  }
  const detail = err instanceof Error ? err.message : String(err);
  return new NetworkError(`Network request failed: ${detail}`, "network_error", null, err);
}

/**
 * Typed client for the dP Relay v5 REST API.
 *
 * One instance holds one app credential pair and can be shared across
 * requests; it keeps no mutable state.
 */
export class DpRelayClient {
  /** App identifier, also sent as `X-App-Id`. */
  readonly appId: string;
  private readonly appSecret: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: DpRelayClientOptions) {
    this.appId = requireCredential(options.appId, "appId", "invalid_app_id");
    this.appSecret = requireCredential(options.appSecret, "appSecret", "invalid_app_secret");
    // Trailing slashes are a common copy/paste artifact; normalize once so no
    // request URL can end up as "...com//v5/...".
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new ValidationError("timeoutMs must be a positive, finite number of milliseconds", "invalid_timeout", null);
    }
    this.timeoutMs = timeoutMs;
  }

  /**
   * Send an OTP to a phone number.
   *
   * @param params - Destination number (strict E.164 after normalization) and optional mode.
   * @returns The created session id and its expiry (Unix seconds).
   * @throws ValidationError - pre-validation failed (nothing was sent).
   * @throws AuthenticationError | InsufficientCreditsError | RateLimitError | NetworkError - see errors.ts.
   */
  async sendOtp(params: SendOtpParams): Promise<OtpSendReceipt> {
    const phone = this.requirePhone(params.phoneNumber, "sendOtp");
    if (params.mode !== undefined && params.mode !== "byod" && params.mode !== "managed") {
      throw new ValidationError('sendOtp: mode must be "byod" or "managed"', "invalid_mode", null);
    }
    const body = await this.send("POST", "/v5/otp/send", { phone, mode: params.mode });
    return {
      sessionId: requireString(body, "sessionId"),
      expiresAt: requireNumber(body, "expiresAt"),
    };
  }

  /**
   * Verify a code the user received.
   *
   * A wrong code, a lockout and an expired session are different outcomes, so
   * only genuinely server-level failures throw: `401 invalid_otp` becomes
   * `{ verified:false, attemptsRemaining }` and `423 otp_locked` becomes
   * `{ verified:false, lockoutUntil }`, while `400 otp_expired` throws
   * ValidationError with code `otp_expired` (the caller must resend).
   *
   * @param params - Number, 6-digit code, optional session hint.
   * @returns Whether the code matched, plus attempts/lockout detail when known.
   */
  async verifyOtp(params: VerifyOtpParams): Promise<OtpVerifyResult> {
    const phone = this.requirePhone(params.phoneNumber, "verifyOtp");
    const otp = normalizeOtp(params.otp);
    if (otp === null) {
      throw new ValidationError("verifyOtp: otp must be exactly 6 digits", "invalid_otp_format", null);
    }
    const response = await this.raw("POST", "/v5/otp/verify", { phone, otp, sessionId: params.sessionId });
    const body = asBody(response.parsed);
    if (response.ok) {
      return { verified: body.verified === true };
    }
    const { code } = envelope(response.status, body);
    if (code === "invalid_otp") {
      return { verified: false, attemptsRemaining: numField(body, "attemptsLeft") };
    }
    if (code === "otp_locked") {
      const retryAfterSec = numField(body, "retryAfterSec");
      return retryAfterSec === undefined
        ? { verified: false }
        : { verified: false, lockoutUntil: Math.floor(Date.now() / 1000) + retryAfterSec };
    }
    throw errorFrom(response.status, body);
  }

  /**
   * Read the latest OTP session state for a number.
   *
   * @param phoneNumber - Number in strict E.164.
   * @returns Session status, expiry, attempts left and lockout/verification timestamps.
   * @throws NotFoundError - the app has no session for this number.
   */
  async getOtpStatus(phoneNumber: string): Promise<OtpStatusResult> {
    const phone = this.requirePhone(phoneNumber, "getOtpStatus");
    const body = await this.send("GET", `/v5/otp/status?phone=${encodeURIComponent(phone)}`);
    return {
      status: requireString(body, "status") as OtpSessionStatus,
      expiresAt: requireNumber(body, "expiresAt"),
      attemptsLeft: requireNumber(body, "attemptsLeft"),
      lockedUntil: nullableNumber(body, "lockedUntil"),
      verifiedAt: nullableNumber(body, "verifiedAt"),
    };
  }

  /**
   * Validate a recipient list without spending credits or storing anything.
   * The returned `checksum` binds the list to a later `createBulkCampaign`.
   *
   * @param params - Either raw CSV text, or recipients + the campaign message.
   * @returns Counts, line-numbered rejects, sample, checksum and the create cap.
   */
  async previewBulk(params: BulkPreviewParams): Promise<BulkPreviewResult> {
    const payload: Record<string, unknown> = {};
    if ("csvData" in params) {
      payload.csv = requireArgString(params.csvData, "previewBulk.csvData", "invalid_recipients");
    } else {
      payload.phones = requireE164List(params.recipients, "previewBulk.recipients");
      // The v5 preview endpoint parses recipients only; the message is
      // validated here so an empty message fails before the create round-trip,
      // and forwarded for forward compatibility.
      payload.message = requireArgString(params.message, "previewBulk.message", "invalid_message");
    }
    const body = await this.send("POST", "/v5/bulk/campaigns/preview", payload);
    const total = requireNumber(body, "total");
    const invalidRows = requireArray<BulkInvalidRow>(body, "invalidRows");
    return {
      count: total + invalidRows.length,
      validCount: total,
      invalidCount: invalidRows.length,
      estimatedCredits: total,
      checksum: requireString(body, "checksum"),
      invalidRows,
      sampleFirst5: requireArray<string>(body, "sampleFirst5"),
      headerSkipped: Boolean(body.headerSkipped),
      perCampaignLimit: requireNumber(body, "perCampaignLimit"),
    };
  }

  /**
   * Create and enqueue a campaign from a previewed recipient list.
   *
   * @param params - Name, message, recipients (same list the checksum covers) and the preview checksum.
   * @returns The new campaign id, status, enqueued count and credits actually reserved.
   * @throws ValidationError - `checksum_mismatch` (list changed since preview) or invalid field.
   */
  async createBulkCampaign(params: BulkCreateParams): Promise<BulkCreateResult> {
    const name = requireArgString(params.name, "createBulkCampaign.name", "invalid_campaign_name");
    const message = requireArgString(params.message, "createBulkCampaign.message", "invalid_message");
    const recipients = requireE164List(params.recipients, "createBulkCampaign.recipients");
    const checksum = requireArgString(params.checksum, "createBulkCampaign.checksum", "checksum_required");
    const body = await this.send("POST", "/v5/bulk/campaigns", {
      name,
      message,
      phones: recipients,
      checksum,
      sourceType: "csv",
    });
    const totalRecipients = requireNumber(body, "totalRecipients");
    return {
      campaignId: requireString(body, "campaignId"),
      status: requireString(body, "status"),
      enqueuedCount: totalRecipients,
      totalRecipients,
      creditsReserved: requireNumber(body, "creditsReserved"),
      unlimitedPass: Boolean(body.unlimitedPass),
      charset: requireString(body, "charset"),
      duplicateCount: numField(body, "duplicateCount"),
    };
  }

  /**
   * Poll one campaign's delivery counters.
   *
   * @param campaignId - Id returned by `createBulkCampaign`.
   * @returns Status plus total/sent/failed/queued counters.
   * @throws NotFoundError - unknown id, or an id belonging to another app.
   */
  async getCampaignStatus(campaignId: string): Promise<BulkCampaignStatusResult> {
    const id = requireArgString(campaignId, "getCampaignStatus.campaignId", "invalid_campaign_id");
    const body = await this.send("GET", `/v5/bulk/campaigns/${encodeURIComponent(id)}`);
    const campaign = expectRecord(body.campaign, "campaign");
    return {
      campaignId: requireString(campaign, "campaignId"),
      name: requireString(campaign, "name"),
      status: requireString(campaign, "status"),
      sourceType: requireString(campaign, "sourceType"),
      totalRecipients: requireNumber(campaign, "totalRecipients"),
      sentCount: requireNumber(campaign, "sentCount"),
      failedCount: requireNumber(campaign, "failedCount"),
      queuedCount: requireNumber(campaign, "queuedCount"),
      createdAt: requireNumber(campaign, "createdAt"),
      startedAt: nullableNumber(campaign, "startedAt"),
      completedAt: nullableNumber(campaign, "completedAt"),
      unlimitedPass: Boolean(campaign.unlimitedPass),
    };
  }

  /** Validate a phone number against the E.164 contract, or throw before any request. */
  private requirePhone(raw: unknown, method: string): string {
    const phone = normalizePhoneNumber(raw);
    if (phone === null) {
      throw new ValidationError(
        `${method}: phoneNumber must be strict E.164, e.g. +8801712345678`,
        "invalid_phone",
        null,
      );
    }
    return phone;
  }

  /**
   * Issue a request and return the parsed envelope of a 2xx response.
   * Non-2xx responses throw the mapped typed error.
   */
  private async send(method: HttpMethod, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const response = await this.raw(method, path, body);
    if (!response.ok) {
      throw errorFrom(response.status, asBody(response.parsed));
    }
    return expectRecord(response.parsed, path);
  }

  /**
   * Transport layer: authenticated fetch with the configured timeout, then
   * parse. Returns the raw payload so `verifyOtp` can interpret its domain
   * outcomes without every other caller paying for that distinction.
   */
  private async raw(method: HttpMethod, path: string, body?: unknown): Promise<RawResponse> {
    const init: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-App-Id": this.appId,
        "X-App-Secret": this.appSecret,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    // JSON.stringify drops undefined, so an optional field is simply absent
    // on the wire; GET requests must not carry a body at all.
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(this.baseUrl + path, init);
    } catch (err) {
      throw toNetworkError(err, this.timeoutMs);
    }

    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      // The connection can die between headers and body; that is still a
      // transport failure, not a typed API error.
      throw toNetworkError(err, this.timeoutMs);
    }

    return {
      status: response.status,
      ok: response.ok,
      parsed: text.length > 0 ? safeParse(text) : null,
    };
  }
}

/** Credential constructor guard: required, non-empty, non-whitespace. */
function requireCredential(value: unknown, field: string, code: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${field} is required`, code, null);
  }
  return value;
}
