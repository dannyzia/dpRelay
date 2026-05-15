<!--
AI: These are the exact steps to deploy this project. Execute them in sequence. Do not improvise.
Read first: 11-ENV-VARS.md (for prod secrets), 05-DATA-MODEL.md (for pending migrations)
You must: Complete the pre-deploy checklist before starting. Verify health check after deploy.
You must not: Skip the pre-deploy checklist. Proceed if any checklist item fails. Run migrations out of order.
Human reviews this: NO — but a human must authorize production deploys. AI runs the steps, human approves.
-->

# Deployment Runbook
**Project:** Authenticator

## Environments
| Name | URL | Branch | Auto-deploy | Who can deploy |
|------|-----|--------|-------------|----------------|
| local | http://localhost (Android emulator) | any | — | anyone |
| staging | Firebase project `PhoneAuthService-dev` | develop | yes, on merge | CI |
| production | Firebase project `PhoneAuthService` | main | NO — manual only | Team lead |

## Staging deploy
Automatic on merge to `develop`. No manual action needed.
Verify: `curl -H "Authorization: Bearer {SECRET}" https://{region}-{project}-dev.cloudfunctions.net/health`

## Staging → Production Promotion Workflow

### Promotion criteria
All must pass before production deploy:
1. Staging deployed for minimum 24 hours with no critical alerts
2. All automated tests pass (unit, integration, e2e)
3. Manual smoke test completed (see below)
4. Security review if any auth/crypto code changed
5. Team lead approval (via GitHub PR review)

### Smoke test checklist (staging)
```bash
# 1. Health check
curl -H "Authorization: Bearer {STAGING_SECRET}" https://{region}-{project}-dev.cloudfunctions.net/health

# 2. Invalid poll token rejection
curl -X POST https://{region}-{project}-dev.cloudfunctions.net/v4/checkAuth \
  -H "Content-Type: application/json" \
   -d '{"sessionCode":"TEST123456","pollToken":"invalid"}'
# Expected: 403 invalid_poll_token

# 3. Rate limiting
curl -X POST https://{region}-{project}-dev.cloudfunctions.net/v4/checkAuth \
  -H "Content-Type: application/json" \
   -d '{"sessionCode":"TEST123456","pollToken":"invalid"}'
# Repeat 31 times, expect 429 on 31st request
```

### Promotion command
```bash
# Merge develop → main (triggers prod deploy approval)
git checkout main
git merge develop --no-ff -m "Promote to production: v{X.Y.Z}"
git push origin main

# Then manually approve in GitHub Actions or run:
firebase deploy --only functions --project PhoneAuthService
```

## Production deploy

### Pre-deploy checklist

#### Code Quality
- [ ] All tests pass on CI for the commit being deployed (100% required)
- [ ] Code coverage ≥ 80% for all HMAC/crypto logic
- [ ] Android Lint passes with zero warnings
- [ ] ktlint passes with zero formatting issues
- [ ] ESLint passes for Cloud Functions with zero warnings
- [ ] No `console.log` or `Log.d` statements in production code

#### Security
- [ ] `VERIFICATION_SIGNING_SECRET` is set in Firebase Secrets Manager (32+ chars)
- [ ] `AUTHENTICATOR_ENROLLMENT_SECRET` is set in Firebase Secrets Manager (32+ chars)
- [ ] `HEALTH_ADMIN_SECRET` is set in Firebase Secrets Manager (32+ chars)
- [ ] Firebase RTDB rules are updated and tested (see `03-Firebase-Setup.md`)
- [ ] `.indexOn` rules configured for `createdAt` and `lastPing` fields
- [ ] Authenticator-role custom auth flow tested end-to-end
- [ ] No secrets in source control (verify with `git log --all --full-history -- '*.kt' '*.js'`)

#### Configuration
- [ ] Client apps have correct `CF_URL` for production environment
- [ ] `ACTIVE_DEDICATED_NUMBER` matches authenticator phone SIM
- [ ] Cloud Functions region closest to users (e.g., `asia-southeast1`)
- [ ] Firebase Blaze plan enabled (required for Functions v2)

#### Testing
- [ ] Staging environment verified with exact build being deployed
- [ ] End-to-end verification flow tested on staging
- [ ] Health endpoint returns `healthy` on staging
- [ ] Rate limiting tested (verify 429 response)
- [ ] Invalid poll token rejected (verify 403 response)

### Deploy steps
1. Set Firebase Secret (first time only):
   ```bash
   firebase functions:secrets:set VERIFICATION_SIGNING_SECRET
   firebase functions:secrets:set AUTHENTICATOR_ENROLLMENT_SECRET
   firebase functions:secrets:set HEALTH_ADMIN_SECRET
   firebase functions:secrets:set ACTIVE_DEDICATED_NUMBER
   ```
2. Deploy Cloud Functions:
   ```bash
   cd functions && npm install && firebase deploy --only functions
   ```
3. Note the base Cloud Functions URL from deploy output
4. Build authenticator APK with `CF_URL` in `build.gradle`. The `AUTHENTICATOR_ENROLLMENT_SECRET` is **not** in `build.gradle` — it is entered on the phone at first launch (ADR-016).
5. Install APK on dedicated phone
6. Follow first-time setup (permissions, battery optimization, auto-start, exact alarm permission)
7. Verify health endpoint:
   ```bash
   curl -H "Authorization: Bearer {SECRET}" https://{region}-{project}.cloudfunctions.net/health
   ```
8. Test full verification flow from a client app

### Rollback decision matrix

| Trigger | Rollback Action | Timeline | Who |
|---------|-----------------|----------|-----|
| Health endpoint degraded | Rollback Cloud Functions | < 5 min | On-call engineer |
| Verification failure rate > 10% | Rollback + investigate | < 15 min | On-call engineer |
| Firebase quota exceeded | No rollback needed; upgrade plan | — | Team lead |
| Security incident | Immediate rollback + secret rotation | < 2 min | Team lead |

### Rollback procedure

#### Cloud Functions rollback
```bash
# List previous versions
firebase functions:list --only startVerification,checkAuth,registerAuthenticator,health,cleanupOldRequests

# Rollback to specific version (if supported by Firebase)
firebase deploy --only functions --force

# Alternative: deploy from previous git commit
git checkout <previous-commit>
cd functions && npm install && firebase deploy --only functions
git checkout main
```

#### Secret rotation rollback (emergency only)
1. Revert `VERIFICATION_SIGNING_SECRET` in Firebase Secrets Manager:
   ```bash
   firebase functions:secrets:set VERIFICATION_SIGNING_SECRET
   # Enter previous secret value
   ```
2. Redeploy Cloud Functions with previous secret
3. No client update required unless the authenticator enrollment secret was also rotated
4. Verify health endpoint and a fresh `startVerification` flow

#### Database state recovery
- **Scenario:** Invalid entries in `/verification_requests` due to bug
- **Action:** Manually delete specific entries via Firebase Console
- **Command:**
  ```bash
   firebase database:remove /verification_requests/{sessionCode}
  ```

#### Verification post-rollback
- [ ] Health endpoint returns `healthy` within 5 minutes
- [ ] Test verification succeeds end-to-end
- [ ] Error rate returns to baseline (< 1%)
- [ ] No new alerts in Firebase Console

## Post-deploy
- [ ] Health endpoint returns `healthy`: `curl -H "Authorization: Bearer {SECRET}" /health`
- [ ] Test verification succeeds end-to-end from client app
- [ ] Monitor Firebase Function logs for 15 minutes: `firebase functions:log`
- [ ] Confirm no P1/P2 alerts

---

## Panic Button — Lost or Stolen Authenticator Phone

Execute these steps immediately if the dedicated phone is lost, stolen, or believed to be physically compromised. **Time matters — complete Step 1 within 5 minutes.**

### Step 1: Revoke the authenticator Firebase identity (< 5 min)

The authenticator phone writes to RTDB using a Firebase custom token bound to its `androidId`. Revoking the token prevents the compromised device from writing any further receipts.

```bash
# Identify the androidId of the compromised phone from the health node
firebase database:get /health --project PhoneAuthService

# Disable the corresponding Firebase Auth user
# (The custom token is issued to a UID derived from androidId)
firebase auth:export users.json --project PhoneAuthService
# Find the UID whose displayName or customClaims.androidId matches the device
# Then:
firebase auth:delete {UID} --project PhoneAuthService
```

> After deletion, any RTDB write attempt from the compromised device with the old token will be rejected by Firebase Auth rules.

### Step 2: Rotate the enrollment secret (< 15 min)

The enrollment secret is the credential used to register a new device. Rotating it prevents the attacker from re-enrolling using any secret they may have extracted from the stolen phone.

```bash
# Generate a new enrollment secret
NEW_SECRET=$(openssl rand -base64 32)
echo "New enrollment secret length: ${#NEW_SECRET}"

# Update in Firebase Secrets Manager
firebase functions:secrets:set AUTHENTICATOR_ENROLLMENT_SECRET --project PhoneAuthService
# Enter the new secret when prompted

# Redeploy Cloud Functions with the new secret
firebase deploy --only functions --project PhoneAuthService
```

### Step 3: Provision the replacement phone (< 1 hour)

```bash
# On the replacement phone, install the authenticator APK
# At first launch, enter the NEW enrollment secret when prompted
# Verify the replacement phone appears in /health
firebase database:get /health --project PhoneAuthService

# Confirm verification works end-to-end
curl -X POST https://{region}-{project}.cloudfunctions.net/v4/startVerification \
  -H "Content-Type: application/json" \
  -d '{"userPhone":"+{your_test_number}"}'
```

### Step 4: Update ACTIVE_DEDICATED_NUMBER if the SIM changed

If the stolen phone's SIM card is also lost and a new SIM is used:

```bash
firebase functions:secrets:set ACTIVE_DEDICATED_NUMBER --project PhoneAuthService
# Enter the new SIM's E.164 number
firebase deploy --only functions --project PhoneAuthService
```

### Step 5: Post-incident review

- [ ] Review Firebase Auth logs for any verification receipts written after loss was detected
- [ ] Check `/audit/registrations` (if audit logging is implemented) for unexpected enrollments
- [ ] Confirm no sessions were verified using the compromised device after loss was detected
- [ ] Rotate `VERIFICATION_SIGNING_SECRET` if there is any reason to believe it was exposed
- [ ] Document the incident timeline and update this runbook if the procedure revealed gaps
