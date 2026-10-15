# @digital-papyrus/dprelay-client

Zero-dependency TypeScript/Node.js client for the **dP Relay v5 REST API** —
OTP verification and bulk SMS from any Node backend (e-commerce, web apps,
medical systems).

- **Zero runtime dependencies** — uses the global `fetch` that ships with Node 18+.
- **Dual distribution** — CommonJS + ESM + type declarations from one source tree.
- **Fail fast** — phone numbers, OTP codes and required fields are validated in
  process, so a malformed call rejects *without* issuing a request.
- **Typed errors** — every failure is a `DpRelayError` subclass with a stable
  `code` and the HTTP `statusCode` (or `null` when no response was received).

> Not yet published to npm (`private: true`). Install it from the repository
> path (see below).

## Requirements

| | |
|---|---|
| Node | `>= 18` (global `fetch`, `AbortSignal.timeout`) |
| Credentials | `appId` + `appSecret` from the dP Relay dashboard (Apps → credentials) |

## Install

```bash
# from a checkout of this repository
npm install /path/to/repo/client-node
```

```jsonc
// or in package.json
"dependencies": { "@digital-papyrus/dprelay-client": "file:../client-node" }
```

## Quickstart — OTP

```ts
import { DpRelayClient } from "@digital-papyrus/dprelay-client";

const client = new DpRelayClient({
  appId: process.env.DPRELAY_APP_ID ?? "",
  appSecret: process.env.DPRELAY_APP_SECRET ?? "",
  // baseUrl / timeoutMs optional: production origin, 30s per request
});

// 1. Send — the number is normalized to strict E.164 first (spaces/dashes stripped)
const { sessionId, expiresAt } = await client.sendOtp({
  phoneNumber: "+880 1712-345678",
});

// 2. Verify — a wrong code does NOT throw; it reports attempts left
const result = await client.verifyOtp({
  phoneNumber: "+8801712345678",
  otp: userEnteredCode, // exactly 6 digits
  sessionId,            // optional; the server resolves the active session
});

if (result.verified) {
  grantAccess();
} else {
  console.log("attempts left:", result.attemptsRemaining);
  if (result.lockoutUntil) console.log("locked until (unix s):", result.lockoutUntil);
}

// 3. Inspect the latest session state (404 → no session for this number)
const status = await client.getOtpStatus("+8801712345678");
// { status, expiresAt, attemptsLeft, lockedUntil, verifiedAt }
```

## Quickstart — Bulk SMS

The v5 API is a two-step submit: **preview first** (spends nothing), then
create with the preview's checksum — a list that changed since preview can
never spend credits.

```ts
import { DpRelayClient } from "@digital-papyrus/dprelay-client";

const client = new DpRelayClient({ appId: "...", appSecret: "..." });

// Step 1 — validate the list. Send raw CSV …
const preview = await client.previewBulk({ csvData: csvText });
// … or an explicit list + the campaign message
const preview2 = await client.previewBulk({
  recipients: ["+8801712345678", "+8801722222222"],
  message: "Flash sale — 20% off today!",
});

if (preview.invalidCount > 0) {
  console.log("rejected rows:", preview.invalidRows); // [{ line, reason }]
}
console.log(preview.validCount, preview.estimatedCredits, preview.checksum);

// Step 2 — create with the SAME list and its checksum
const campaign = await client.createBulkCampaign({
  name: "Flash sale",
  message: "Flash sale — 20% off today!",
  recipients: ["+8801712345678", "+8801722222222"], // must match the previewed list
  checksum: preview.checksum,
});
// { campaignId, status, enqueuedCount, totalRecipients, creditsReserved, … }

// Step 3 — poll the counters
const status = await client.getCampaignStatus(campaign.campaignId);
// { status, totalRecipients, sentCount, failedCount, queuedCount, … }
```

## Error handling

```ts
import {
  DpRelayError,
  ValidationError,
  AuthenticationError,
  InsufficientCreditsError,
  RateLimitError,
  NotFoundError,
  NetworkError,
} from "@digital-papyrus/dprelay-client";

try {
  await client.sendOtp({ phoneNumber });
} catch (err) {
  if (err instanceof ValidationError) {
    // bad input — fix the call (statusCode === null when rejected client-side)
  } else if (err instanceof AuthenticationError) {
    // 401 — wrong appId/appSecret
  } else if (err instanceof InsufficientCreditsError) {
    // 402 — wallet empty or credits expired: buy a package
  } else if (err instanceof RateLimitError) {
    // 429 — resend cooldown / per-number rate window / daily bulk quota
  } else if (err instanceof NotFoundError) {
    // 404 — unknown session or campaign
  } else if (err instanceof NetworkError) {
    // transport failure: err.code is "timeout" or "network_error"
  } else if (err instanceof DpRelayError) {
    // any other server failure (400, 403, 423, 5xx): err.code, err.statusCode
  }
}
```

| HTTP | Error class | Typical `code` |
|---|---|---|
| 400 | `ValidationError` | `invalid_phone`, `invalid_otp_format`, `checksum_mismatch`, `otp_expired` |
| 401 | `AuthenticationError` | `unknown_app`, `invalid_app_secret`, `missing_app_credentials` |
| 402 | `InsufficientCreditsError` | `insufficient_credits`, `no_credits_row`, `credits_expired` |
| 404 | `NotFoundError` | `not_found`, `campaign_not_found` |
| 429 | `RateLimitError` | `rate_limited`, `resend_cooldown`, `daily_quota_exceeded` |
| other | `DpRelayError` | server `code`, or `http_<status>` |
| — | `NetworkError` | `timeout`, `network_error` |

## API

```ts
new DpRelayClient(options: {
  appId: string;
  appSecret: string;
  baseUrl?: string;    // default https://api.dprelay.digital-papyrus.com
  timeoutMs?: number;  // default 30000, enforced with AbortSignal.timeout
})

client.sendOtp(params: { phoneNumber: string; mode?: "byod" | "managed" }): Promise<OtpSendReceipt>
client.verifyOtp(params: { phoneNumber: string; otp: string; sessionId?: string }): Promise<OtpVerifyResult>
client.getOtpStatus(phoneNumber: string): Promise<OtpStatusResult>
client.previewBulk(params: { csvData: string } | { recipients: string[]; message: string }): Promise<BulkPreviewResult>
client.createBulkCampaign(params: { name: string; message: string; recipients: string[]; checksum: string }): Promise<BulkCreateResult>
client.getCampaignStatus(campaignId: string): Promise<BulkCampaignStatusResult>
```

Helpers are exported too: `normalizePhoneNumber`, `isValidE164`,
`normalizeOtp`, `isValidOtp`, plus `DEFAULT_BASE_URL` / `DEFAULT_TIMEOUT_MS`.

### Validation rules (client side, before any request)

- **Phone**: formatting noise (whitespace, dashes) is stripped, then the value
  must match strict E.164 — `/^\+[1-9]\d{7,14}$/`. Recipients in a bulk list
  are normalized the same way, so the checksum the server re-computes at create
  time matches what you previewed.
- **OTP**: exactly six digits after trimming — `/^\d{6}$/`.
- **Required fields** (name, message, checksum, campaign id, credentials,
  `timeoutMs`) are checked up front and raise `ValidationError` with
  `statusCode === null`.

### Behavior notes

- `verifyOtp` is **fail-closed**: only a body with `verified: true` returns
  `verified: true`. A wrong code (`401 invalid_otp`) and a lockout
  (`423 otp_locked`) are *results*, not exceptions; an expired session
  (`400 otp_expired`) throws `ValidationError` so the caller knows to resend.
- `mode` and `sessionId` are validated and forwarded; the v5 server currently
  derives delivery mode from your app's own configuration and resolves the OTP
  session from `(app, phone)`.
- `BulkPreviewResult.estimatedCredits` is an **upper bound** (1 per valid
  recipient before de-duplication). `createBulkCampaign().creditsReserved` is
  what actually moved.
- Timestamps (`expiresAt`, `lockoutUntil`, `createdAt`, …) are Unix seconds.

## Development

```bash
npm install
npm test            # vitest run --coverage (thresholds pinned at 100%)
npm run typecheck   # tsc --noEmit
npm run build       # dist/esm (ESM) + dist/cjs (CommonJS) + .d.ts
```

The package is `"type": "module"`; `dist/cjs/package.json` declares
`"type": "commonjs"` (written by `scripts/finalize-build.mjs`) so both halves
of the `exports` map load correctly.

Runtime `dependencies` are intentionally **empty** — keep it that way: any
requirement a consumer cannot satisfy with Node 18+ belongs in the app, not
here.
