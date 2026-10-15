/**
 * Typed error hierarchy for the dP Relay client SDK.
 *
 * Every failure surfaces as a `DpRelayError` subclass so callers branch on
 * `instanceof` (or the stable `code`) instead of re-parsing status codes and
 * response bodies. `statusCode === null` marks a failure that never received
 * an HTTP response — client-side validation, connection refusal or timeout —
 * which is exactly the information a caller needs to decide whether a retry
 * can help (a null status means the server said nothing at all).
 */

/** Base class for every error the SDK throws. */
export class DpRelayError extends Error {
  /** Stable machine-readable reason: the server's `code`, or a client-side code. */
  readonly code: string;
  /** HTTP status of the failing response, or null when no response was received. */
  readonly statusCode: number | null;

  constructor(message: string, code: string, statusCode: number | null) {
    super(message);
    this.name = "DpRelayError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** 401 — the X-App-Id / X-App-Secret pair was rejected (or the token is invalid). */
export class AuthenticationError extends DpRelayError {
  constructor(message: string, code: string, statusCode: number | null) {
    super(message, code, statusCode);
    this.name = "AuthenticationError";
  }
}

/**
 * 400 — the request was rejected before any work happened (non-E.164 phone,
 * malformed payload). Also thrown for client-side pre-validation, where
 * `statusCode` is null because the request never left the process.
 */
export class ValidationError extends DpRelayError {
  constructor(message: string, code: string, statusCode: number | null) {
    super(message, code, statusCode);
    this.name = "ValidationError";
  }
}

/** 402 — the app's OTP/bulk credit bucket is empty or expired. */
export class InsufficientCreditsError extends DpRelayError {
  constructor(message: string, code: string, statusCode: number | null) {
    super(message, code, statusCode);
    this.name = "InsufficientCreditsError";
  }
}

/** 429 — per-number/per-app rate window, resend cooldown, or daily quota. */
export class RateLimitError extends DpRelayError {
  constructor(message: string, code: string, statusCode: number | null) {
    super(message, code, statusCode);
    this.name = "RateLimitError";
  }
}

/** 404 — the OTP session or bulk campaign does not exist for this app. */
export class NotFoundError extends DpRelayError {
  constructor(message: string, code: string, statusCode: number | null) {
    super(message, code, statusCode);
    this.name = "NotFoundError";
  }
}

/**
 * Transport-level failure: the request never produced a usable response
 * (connection error, DNS failure, aborted body stream, or timeout).
 * `code` is `"timeout"` when the configured timeout fired, `"network_error"`
 * otherwise; `cause` carries the original rejection for logging.
 */
export class NetworkError extends DpRelayError {
  /** The underlying transport error or abort reason. */
  override readonly cause: unknown;

  constructor(message: string, code: string, statusCode: number | null, cause: unknown) {
    super(message, code, statusCode);
    this.name = "NetworkError";
    this.cause = cause;
  }
}
