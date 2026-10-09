# Payment Reader (STAGE F8, ISSUE-90)

A second, deliberately tiny APK for the money phone. The gateway APK
(`authenticator-app/`) over-permissions that device (OTP + FCM + RTDB); this
app has exactly one job — **read bKash/Nagad confirmation SMS and upload the
parsed fields** to the dP Relay server.

- Permissions: `RECEIVE_SMS` + `INTERNET` only. No contacts, no location, no
  `SEND_SMS`, no FCM, no OTP, no heartbeat, no outstanding-fetch.
- Onboarding: one screen — server URL (pre-filled with the production
  default from `BuildConfig.DEFAULT_SERVER_URL`) + `PAYMENT_READER_SECRET`,
  persisted in EncryptedSharedPreferences (ADR-016: never BuildConfig).
- Upload: `POST /v5/payments/ingest` with `Authorization: Bearer <secret>`.
  Idempotent server-side on the unique TrxID, so the offline queue retries
  freely: unsent items persist in app-private storage and retry with
  exponential backoff (30 s → 30 min, WorkManager), across reboots.
- Sender filter lives in ONE constant: `PaymentParser.BKASH_SENDERS`
  (`bKash`, `BKASH`, `16247`, …). Malformed SMS is ignored-with-log
  (`Log.w`, never the body, never the full TrxID).

## Layout

| File | Role |
| --- | --- |
| `MainActivity.kt` | onboarding screen + `RECEIVE_SMS` runtime request |
| `PaymentParser.kt` | pure sender classification + TrxID/amount parsing (fixtures mirror the gateway `SmsReceiverTest` and the server's ingest validation) |
| `PaymentSmsReceiver.kt` | `SMS_RECEIVED` broadcast → parse → enqueue → schedule |
| `PendingUpload.kt` | queue item model + `QueueCodec` persistence format |
| `UploadQueue.kt` | dedupe-by-TrxID, injected clock, exponential backoff |
| `PaymentApiClient.kt` | HttpURLConnection transport + payload/classification (unit-tested against a loopback server) |
| `UploadWorker.kt` | WorkManager drain: accepted → remove, 400 → drop loudly, anything else → back off and keep |
| `ReaderConfig.kt` | EncryptedSharedPreferences settings + durable `PrefsQueueStore` |

## Build / test

```bash
cd payment-reader
./gradlew lintDebug        # Android lint (CI: payment-reader-lint)
./gradlew ktlintCheck      # ktlint, no baseline (CI: payment-reader-ktlint)
./gradlew testDebugUnitTest  # JVM unit tests (CI: payment-reader-unit-tests)
./gradlew assembleDebug    # installable debug APK
```

Requires JDK 17 and an Android SDK (same as the gateway app).

## Server side

- Route: `POST /v5/payments/ingest` (`server/src/routes/payments.ts`).
- Env: `PAYMENT_READER_SECRET` (empty = route 403s, fail-closed).
- Rows land in the same `payment_sms` pipeline as the gateway route, tagged
  `source: 'reader'` — the operator Payments panel shows the column.
