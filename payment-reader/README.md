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

### Release signing (ISSUE-49) — fail-closed, keyring-backed

Release builds are signed with the private **dP Relay** release keystore
(PKCS12, RSA 4096, CN=dP Relay). The keystore file and its password live
**only in the OS keyring** (ADR-016: never the repo, never chat, never
BuildConfig); `assembleRelease` needs four env vars and **fails closed** if
any are missing — it never falls back to debug-signed or unsigned output
(the installed reader holds `PAYMENT_READER_SECRET`).

| Env var | Source (keyring, `service dprelay`) |
| --- | --- |
| `READER_RELEASE_STORE_FILE` | `account release-keystore-b64` (base64 PKCS12), decoded to a 0600 temp file |
| `READER_RELEASE_STORE_PASSWORD` | `account release-keystore-password` |
| `READER_RELEASE_KEY_ALIAS` | `account release-keystore-alias` (`dprelay-release`) |
| `READER_RELEASE_KEY_PASSWORD` | same value as the store password |

Building a signed release APK from the keyring (no secret ever touches disk
permanently or the shell history):

```bash
cd payment-reader
umask 077
KS=$(mktemp -d /tmp/dprelay-ks-XXXXXX)/release.p12
secret-tool lookup service dprelay account release-keystore-b64 | base64 -d > "$KS"
export READER_RELEASE_STORE_FILE="$KS"
export READER_RELEASE_STORE_PASSWORD="$(secret-tool lookup service dprelay account release-keystore-password)"
export READER_RELEASE_KEY_ALIAS="$(secret-tool lookup service dprelay account release-keystore-alias)"
export READER_RELEASE_KEY_PASSWORD="$READER_RELEASE_STORE_PASSWORD"
./gradlew assembleRelease   # -> app/build/outputs/apk/release/app-release.apk (SIGNED)
shred -u "$KS"
```

The signing certificate's **SHA-1 must stay registered on the Firebase
Android API key** (`androidKeyRestrictions`, alongside the debug-keystore
SHA-1) — owner console step per ISSUE-49; rotate-then-register before
changing keys.

## Server side

- Route: `POST /v5/payments/ingest` (`server/src/routes/payments.ts`).
- Env: `PAYMENT_READER_SECRET` (empty = route 403s, fail-closed).
- Rows land in the same `payment_sms` pipeline as the gateway route, tagged
  `source: 'reader'` — the operator Payments panel shows the column.
