<!--
AI: This is the complete list of all environment variables. Never hardcode any of these values.
Read first: 03-TECH-STACK.md (for which services this project uses)
You must: Read every required variable from the environment at startup. Generate .env.example from this table.
You must not: Commit real values to source control. Use default values for required variables in production.
Human reviews this: NO — but every variable must be accounted for here before deployment.
-->

# Environment Variables
**Project:** Authenticator

## Rules
- Never commit real secrets to source control. Use `BuildConfig` for non-secret build config (e.g. `CF_URL`); use `EncryptedSharedPreferences` (first-run prompt) for the authenticator enrollment secret; use Firebase Secrets Manager for Cloud Functions secrets.
- Public client apps must not contain a long-lived verification signing secret.
- Validate all variables at startup. Fail fast if any required variable is missing.

## Authenticator App> The only `BuildConfig` fields in the authenticator APK are the non-secret URLs/toggles: `CF_URL` (v4), `V5_API_BASE_URL`, and `V5_API_ENABLED` (v5, M2 parallel-run toggle, default false). All secrets — `AUTHENTICATOR_ENROLLMENT_SECRET`, the v5 `DEVICE_API_KEY` — live in `EncryptedSharedPreferences`, never compiled into the APK (ADR-016 / T-09).


| Variable | Where | Required | Description | How to get it |
|----------|-------|----------|-------------|---------------|
| CF_URL | `BuildConfig` | yes | Base Cloud Functions URL used for `registerAuthenticator`, `startVerification`, and `checkAuth`. | `firebase deploy` output |
| V5_API_BASE_URL | `BuildConfig` | yes (M2+) | dP Relay v5 server base URL (non-secret; device plane REST). | Deployed server URL (e.g. Render service) |
| V5_API_ENABLED | `BuildConfig` | no (default false) | M2 parallel-run toggle: false = legacy Firebase plane only; true = also enroll + heartbeat + outstanding/results + payment-SMS via REST. | Flip in `app/build.gradle` for the cutover build |
| AUTHENTICATOR_ENROLLMENT_SECRET | `EncryptedSharedPreferences` (first-run prompt) | yes | Authenticator-only bootstrap secret used to obtain a Firebase custom token. Min 32 chars. Never in `buildConfigField`. | `openssl rand -base64 32` |
| DEVICE_API_KEY (v5) | `EncryptedSharedPreferences` (via POST /v5/device/enroll) | M2+ | v5 device API key minted by the server; raw key shown/returned once, never logged. | Server-issued at enrollment |
| V5_FCM_TOKEN (v5) | `EncryptedSharedPreferences`-adjacent (device → POST /v5/device/fcm-token) | M2+ | FCM registration token registered with the v5 server for wake+fetch. | Firebase SDK at runtime |

## Cloud Functions (Environment Variables - Spark Plan Compatible)
| Variable | Required | Default | Description | How to get it |
|----------|----------|---------|-------------|---------------|
| VERIFICATION_SIGNING_SECRET | yes | — | Server-only secret used to mint and validate SMS challenge tokens and poll tokens. | `openssl rand -base64 32` |
| AUTHENTICATOR_ENROLLMENT_SECRET | yes | — | Same authenticator bootstrap secret as above. | `openssl rand -base64 32` |
| HEALTH_ADMIN_SECRET | yes | — | Secret protecting the `/health` endpoint. | `openssl rand -base64 32` |
| ACTIVE_DEDICATED_NUMBER | yes | — | Active SIM number returned by `startVerification`. | Your dedicated SIM number |

## Client App (BuildConfig or Remote Config)
| Variable | Required | Default | Description | How to get it |
|----------|----------|---------|-------------|---------------|
| CF_URL | yes | — | Cloud Function checkAuth URL. | `firebase deploy` output |

## dP Relay v5 Server (server/ — Modification 6, M1+)
| Variable | Required | Default | Description | How to get it |
|----------|----------|---------|-------------|---------------|
| PORT | no | 3000 | HTTP port (0 = ephemeral, tests). | — |
| HOST | no | 0.0.0.0 | Bind address (Render needs 0.0.0.0). | — |
| LOG_LEVEL | no | info | pino level. | — |
| DB_PATH | no | ./data/dprelay.db | SQLite file path (Litestream-managed). | — |
| JWT_SECRET | yes | — | HS256 signing secret for access tokens. Min 32 chars; server refuses to boot without it. | `openssl rand -base64 32` |
| JWT_ACCESS_TTL_SEC | no | 900 | Access-token lifetime (seconds). | — |
| JWT_REFRESH_TTL_SEC | no | 2592000 | Refresh-token lifetime (seconds, default 30 days). | — |
| WATCHDOG_STALE_SEC | no | 900 | Devices stale when last_seen_at is older than this (default 15 min). | — |
| WATCHDOG_CRON | no | */5 * * * * | Watchdog schedule (node-cron). | — |
| CATCH_UP_CRON | no | */10 * * * * | Catch-up sweep schedule (node-cron). | — |
| ALERT_WEBHOOK_URL | no | — (empty = log-only) | Watchdog alert delivery endpoint. | Your webhook receiver (e.g. Discord/Slack-compatible) |
| ALERT_WEBHOOK_SECRET | no | — | Sent as `Authorization: Bearer` on alert webhooks. | `openssl rand -base64 32` |
| TELEGRAM_BOT_TOKEN | no | — (empty = sink disabled) | Telegram Bot API token; with TELEGRAM_CHAT_ID this is the preferred alert sink (HTML sendMessage), falling back to ALERT_WEBHOOK_URL on failure. | Token from @BotFather |
| TELEGRAM_CHAT_ID | no | — | Telegram chat id receiving alerts; only used when TELEGRAM_BOT_TOKEN is set. | Chat id from the target chat (negative for groups/channels) |
| WAKE_IDLE_THRESHOLD_SEC | no | 900 | Idle seconds before the next request counts as a wake (R5 catch-up sweep). | — |
| DEVICE_ENROLLMENT_SECRET | for M2 | — (empty = enrollment disabled) | Enrollment secret for `POST /v5/device/enroll` (ADR-016 exchange → device API key). Compared in constant time. | `openssl rand -base64 32` |
| OUTSTANDING_REQUEUE_SEC | no | 120 | Claimed `pending_sms` older than this are re-offered to the next fetch (at-least-once delivery). | — |
| ENROLL_RATE_MAX_PER_HOUR | no | 10 | Max `/v5/device/enroll` attempts per client IP inside the sliding window (brute-force guard; counts failures too). | server |
| ENROLL_RATE_WINDOW_SEC | no | 3600 | Sliding window for the enrollment rate limiter, in seconds. | server |
| APP_PROVISIONING_SECRET | for M4 | — (empty = provisioning disabled) | Operator secret for `POST /v5/apps/register` — registers appId/appSecret and mints `webhook_secret` once (returned only in that response). Compared in constant time. Operator-only: never expose to clients. | `openssl rand -base64 32` |
| APP_PROVISIONING_RATE_MAX_PER_HOUR | no | 10 | Max `/v5/apps/register` attempts per client IP inside the sliding window (brute-force guard; counts failures too). | server |
| APP_PROVISIONING_RATE_WINDOW_SEC | no | 3600 | Sliding window for the provisioning rate limiter, in seconds. | server |
| OTP_TTL_SEC | no | 300 | OTP session lifetime, in seconds. | server |
| OTP_MAX_ATTEMPTS | no | 5 | Failed verify attempts before an OTP session locks. | server |
| OTP_LOCKOUT_SEC | no | 900 | Lockout duration after hitting OTP_MAX_ATTEMPTS, in seconds. | server |
| FCM_SERVICE_ACCOUNT_JSON | no* | — | Stringified Firebase service-account JSON; enables the FCM wake sender. Empty = wake disabled (reconcile fetch covers delivery). *Required in production once M3 OTP traffic is live. | server |
| WEBHOOK_TIMEOUT_MS | no | 5000 | Hard timeout per OTP webhook delivery attempt, in milliseconds. | server |
| WEBHOOK_EXHAUSTION_ALERT_THRESHOLD | no | 3 | Consecutive exhausted webhook dispatches per app before the alert channel (`ALERT_WEBHOOK_URL`) fires a `webhook_exhaustion` alert. Any successful delivery resets the count. | server |
| WEBHOOK_EXHAUSTION_DAMPING_SEC | no | 3600 | Minimum seconds between exhaustion alerts for the SAME app (dead-receiver damping; default caps re-alerts at ~1/hour per dead receiver). 0 disables damping. Any successful delivery re-arms instantly. | server |
| OTP_RESEND_COOLDOWN_SEC | no | 60 | Minimum seconds between OTP sends to the SAME phone per app (resend cooldown on POST /v5/otp/send; 429 `resend_cooldown` with Retry-After). 0 disables. Sits alongside the per-app session rate limit (`rate_max_per_phone`/`rate_window_sec`). | server |
| CORS_ALLOWED_ORIGINS | no | — | Comma-separated dashboard origins allowed by CORS (browser SPA on Cloudflare Pages). Empty/unset = no cross-origin browser access (fail-closed); API-only consumers (curl, mobile) are unaffected by CORS either way. | server |
| WEBHOOK_RETRY_DELAYS_MS | no | 30000,120000 | Comma-separated backoff delays (ms) between OTP webhook retry attempts (last value repeats; 3 attempts total). | server |
| LITESTREAM_ENABLED | no | false | start-server.mjs flag: false = serve without litestream supervision. | — |
| R2_ACCOUNT_ID | for litestream | — | Cloudflare account ID (R2 endpoint). | Cloudflare dashboard → R2 |
| R2_ENDPOINT | for litestream | — | S3-compatible endpoint. | `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` |
| R2_ACCESS_KEY_ID | for litestream | — | R2 token access key (see SETUP-R2.md §4). | Cloudflare R2 API token |
| R2_SECRET_ACCESS_KEY | for litestream | — | R2 token secret (never in git). | Cloudflare R2 API token |
| R2_BUCKET_LITESTREAM | for litestream | dprelay-litestream | Backup bucket for Litestream. | Created per SETUP-R2.md §3 |
| R2_BUCKET_ATTACHMENTS | for litestream | dprelay-attachments | MMS attachments bucket (M5). | Created per SETUP-R2.md §3 |

### Firebase Project Configuration
- **Project ID**: `authenticator-15fb7`
- **Region**: `asia-southeast1`
- **Cloud Functions URL**: `https://asia-southeast1-authenticator-15fb7.cloudfunctions.net`

## Firebase Console Configuration
| Setting | Where | Value |
|---------|-------|-------|
| Custom auth support | Authentication → Sign-in method | Enabled via Admin SDK token issuance |
| RTDB rules | Realtime Database → Rules | See `03-Firebase-Setup.md` |
| Cloud Functions region | Functions deploy | Choose closest to users (e.g. `asia-southeast1`) |
| Blaze plan | Billing | Required for Cloud Functions v2 |

## Per-environment overrides
| Variable | Local | Staging | Production |
|----------|-------|---------|------------|
| VERIFICATION_SIGNING_SECRET | Any 32+ char string | Separate staging secret | Production secret (server only) |
| AUTHENTICATOR_ENROLLMENT_SECRET | Any 32+ char string (runtime-entered) | Separate staging secret (runtime-entered) | Production secret (rotate on device re-enrollment; entered via first-run screen, not BuildConfig) |
| HEALTH_ADMIN_SECRET | Any 32+ char string | Separate staging secret | Production secret |
| ACTIVE_DEDICATED_NUMBER | Test SIM number | Staging SIM number | Production SIM number |
| CF_URL | `http://10.0.2.2:5001/...` (emulator) | `https://{region}-{project}-dev.cloudfunctions.net/checkAuth` | `https://{region}-{project}.cloudfunctions.net/checkAuth` |
| LOG_LEVEL | debug | info | warn |
| RATE_LIMIT_MAX | 1000 | 60 | 30 |
| CF_TIMEOUT_SEC | 60 | 30 | 10 |

## Secret Rotation Procedure

### Planned Rotation (Every 6 Months)

1. **Generate new secret:**
   ```bash
   NEW_SECRET=$(openssl rand -base64 32)
   echo "New secret generated (length: ${#NEW_SECRET})"
   ```

2. **Update Cloud Function (staging first):**
   ```bash
  # Update .env file with new secret
  firebase deploy --only functions --project authenticator-15fb7
   ```

3. **Verify no authenticator rebuild is required:**
  - `VERIFICATION_SIGNING_SECRET` is server-only.
  - No client app rebuild required.
  - No authenticator APK rebuild required unless `AUTHENTICATOR_ENROLLMENT_SECRET` is also rotated.

4. **Verify staging works:**
   ```bash
   curl -H "Authorization: Bearer $STAGING_SECRET" $STAGING_CF_URL/health
   # Test full verification flow
   ```

5. **Repeat for production:**
   - Update Firebase Secrets Manager (production)
   - Deploy Cloud Functions (production)
   - Verify health endpoint

6. **Grace period:**
   - Old secret valid for 24 hours after rotation
   - Monitor for failures using old secret

### Emergency Rotation (Security Incident)

If `VERIFICATION_SIGNING_SECRET` is compromised:

1. **Immediate (5 minutes):**
   ```bash
   # Generate and deploy new secret
   NEW_SECRET=$(openssl rand -base64 32)
   # Update .env file with new secret
   firebase deploy --only functions
   ```

2. **Short-term (30 minutes):**
  - Verify `startVerification` and `checkAuth` return healthy responses
  - No client app update required
  - No dedicated phone re-enrollment required unless the authenticator bootstrap secret is also compromised

3. **Long-term (24 hours):**
   - Rotate any related secrets
   - Review logs for misuse of compromised secret
   - Post-incident review

## Environment Validation Script

Create `scripts/validate-env.sh`:

```bash
#!/bin/bash
# Validate environment variables before deployment

ERRORS=0

check_required() {
  if [ -z "$1" ]; then
    echo "❌ Missing required variable: $2"
    ERRORS=$((ERRORS + 1))
  else
    echo "✅ $2 is set"
  fi
}

check_length() {
  if [ "${#1}" -lt "$3" ]; then
    echo "❌ $2 is too short (min $3 chars, got ${#1})"
    ERRORS=$((ERRORS + 1))
  else
    echo "✅ $2 meets length requirement ($3+ chars)"
  fi
}

echo "Validating environment variables..."

# Check required variables
check_required "$VERIFICATION_SIGNING_SECRET" "VERIFICATION_SIGNING_SECRET"
check_required "$AUTHENTICATOR_ENROLLMENT_SECRET" "AUTHENTICATOR_ENROLLMENT_SECRET"
check_required "$ACTIVE_DEDICATED_NUMBER" "ACTIVE_DEDICATED_NUMBER"
check_required "$CF_URL" "CF_URL"

# Check length requirements
check_length "$VERIFICATION_SIGNING_SECRET" "VERIFICATION_SIGNING_SECRET" 32
check_length "$AUTHENTICATOR_ENROLLMENT_SECRET" "AUTHENTICATOR_ENROLLMENT_SECRET" 32

# Validate phone number format
if [[ ! "$ACTIVE_DEDICATED_NUMBER" =~ ^\+[0-9]{7,15}$ ]]; then
  echo "❌ ACTIVE_DEDICATED_NUMBER invalid format (must be E.164)"
  ERRORS=$((ERRORS + 1))
else
  echo "✅ ACTIVE_DEDICATED_NUMBER format valid"
fi

# Check for common mistakes
if echo "$VERIFICATION_SIGNING_SECRET" | grep -q "example\|test\|secret\|password"; then
  echo "⚠️  WARNING: VERIFICATION_SIGNING_SECRET appears to be a placeholder"
fi

if [ $ERRORS -eq 0 ]; then
  echo ""
  echo "✅ All environment variables valid!"
  exit 0
else
  echo ""
  echo "❌ $ERRORS validation error(s) found. Fix before deploying."
  exit 1
fi
```

## Production Readiness Checklist

Before deploying to production, verify:

- [ ] All required environment variables set
- [ ] `VERIFICATION_SIGNING_SECRET` is 32+ characters and cryptographically random
- [ ] `VERIFICATION_SIGNING_SECRET` is NOT the staging or local development secret
- [ ] `AUTHENTICATOR_ENROLLMENT_SECRET` has been entered via the first-run screen on the dedicated phone (not present in APK)
- [ ] `ACTIVE_DEDICATED_NUMBER` matches the production authenticator phone
- [ ] `CF_URL` points to production Cloud Functions (not staging)
- [ ] Firebase project is on Spark or Blaze plan
- [ ] Cloud Functions region closest to users
- [ ] Environment variables set in .env file or deployment environment
- [ ] .env file not committed to git
