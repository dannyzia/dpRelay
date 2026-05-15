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

## Authenticator App

> **`CF_URL` is the only `BuildConfig` field in the authenticator APK.** `AUTHENTICATOR_ENROLLMENT_SECRET` is entered at first run and stored in `EncryptedSharedPreferences` — never compiled into the APK (ADR-016 / T-09).

| Variable | Where | Required | Description | How to get it |
|----------|-------|----------|-------------|---------------|
| CF_URL | `BuildConfig` | yes | Base Cloud Functions URL used for `registerAuthenticator`, `startVerification`, and `checkAuth`. | `firebase deploy` output |
| AUTHENTICATOR_ENROLLMENT_SECRET | `EncryptedSharedPreferences` (first-run prompt) | yes | Authenticator-only bootstrap secret used to obtain a Firebase custom token. Min 32 chars. Never in `buildConfigField`. | `openssl rand -base64 32` |

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
