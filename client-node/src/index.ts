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

export {
  DecryptionError,
  decryptMessage,
  deriveE2eeKey,
  E2EE_IV_BYTES,
  E2EE_KEY_BYTES,
  E2EE_PBKDF2_ITERATIONS,
  E2EE_PBKDF2_SALT,
  E2EE_PREFIX,
  E2EE_TAG_BYTES,
  encryptMessage,
  isE2eeEnvelope,
} from "./crypto.js";

export type { E2eeKeyInput } from "./crypto.js";
