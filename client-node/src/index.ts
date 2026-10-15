/**
 * Public surface of the dP Relay Node/TypeScript client SDK.
 *
 * Everything an integrator needs is re-exported here; the internal helpers
 * (envelope parsing, HTTP mapping) deliberately stay private so the wire
 * contract can change without breaking callers.
 */

export {
  AuthenticationError,
  DpRelayError,
  InsufficientCreditsError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from "./errors.js";

export { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS, DpRelayClient } from "./client.js";

export type {
  BulkCreateParams,
  BulkCreateResult,
  BulkCampaignStatusResult,
  BulkInvalidRow,
  BulkPreviewParams,
  BulkPreviewResult,
  DpRelayClientOptions,
  OtpMode,
  OtpSendReceipt,
  OtpSessionStatus,
  OtpStatusResult,
  OtpVerifyResult,
  SendOtpParams,
  VerifyOtpParams,
} from "./client.js";

export { isValidE164, isValidOtp, normalizeOtp, normalizePhoneNumber } from "./validation.js";
