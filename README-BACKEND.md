# Backend Implementation Guide

This document provides deployment and setup instructions for the backend components of the Authenticator Service.

## Prerequisites

- Node.js 20 or later
- Firebase CLI (`npm install -g firebase-tools`)
- Firebase project configured with: Authentication, RTDB, Firestore, Cloud Functions, Hosting

## Environment Variables

Copy `functions/.env.example` to `functions/.env` and fill in all required variables:

```bash
# Core secrets
VERIFICATION_SIGNING_SECRET=          # Generate: openssl rand -base64 32
AUTHENTICATOR_ENROLLMENT_SECRET=      # Generate: openssl rand -base64 32
HEALTH_ADMIN_SECRET=                  # Generate: openssl rand -base64 32
ACTIVE_DEDICATED_NUMBER=              # Your dedicated phone number

# App registry master secret (protects registerApp, revokeApp, setAdminClaim)
APP_MASTER_SECRET=                    # Generate: openssl rand -base64 48

# Billing variables
BKASH_PERSONAL_NUMBER=               # bKash Send Money number (placeholder in example)
BKASH_MIN_TOPUP_AMOUNT=500           # Minimum BDT per top-up
```

## Deployment Steps

### 1. Deploy Firestore Security Rules

```bash
firebase deploy --only firestore:rules
```

This deploys `firestore.rules` which defines read/write restrictions for:
- `packages`: Read by any authenticated user, write by Cloud Functions only
- `app_credits`: Read by owner only (`ownerUid` match), write by Cloud Functions only
- `app_credits/{appId}/usage`: Read by owner, write by Cloud Functions only
- `transactions`: Read by admin or owner, write by Cloud Functions only

### 2. Deploy Firestore Indexes

```bash
firebase deploy --only firestore:indexes
```

This deploys `firestore.indexes.json` which creates composite indexes for:
- `transactions` queries (by appId + date, by status + date)
- `packages` queries (by active status + price)
- `app_credits` queries (by appId + date)
- `usage` sub-collection queries (by date + session)

### 3. Seed Initial Packages

After deploying Firestore indexes, seed the initial credit packages:

```bash
cd functions
node src/billing/seedPackages.js
```

This creates three packages in Firestore:
- **Starter**: 500 SMS, 500 BDT, 30 days validity
- **Pro**: 2000 SMS, 1800 BDT, 60 days validity
- **Enterprise**: 10000 SMS, 8000 BDT, 90 days validity

The script is **idempotent** - running it multiple times will not create duplicates.

### 4. Deploy Cloud Functions

```bash
firebase deploy --only functions
```

This deploys all Cloud Functions:

**Authenticator Device Functions (Phase 1):**
- `startVerification` - Initiates phone verification
- `checkAuth` - Checks verification status
- `registerAuthenticator` - Registers an authenticator device
- `health` - Health check endpoint

**App Management Functions:**
- `setAdminClaim` - Assigns admin custom claim to a user (protected by APP_MASTER_SECRET)
- `registerApp` - Creates app in RTDB, returns appId + plaintext appSecret
- `revokeApp` - Soft deletes an app (sets active: false)
- `updateAppWebhook` - Updates webhook URL and optionally regenerates secret
- `regenerateAppSecret` - Generates new secret, returns once, updates hash

**OTP Functions (with credit check + webhooks):**
- `sendOtp` - Sends OTP with credit check (CR-01), deduction (CR-02), audit (CR-03), webhook data (WH-01)
- `verifyOtp` - Verifies an OTP code
- `otpStatus` - Checks OTP delivery status, fires webhooks (WH-03)

**Billing Functions:**
- `getCredits` - Returns credit balance for an authenticated app
- `upsertPackage` - Admin creates/updates a package (callable, admin claim required)
- `requestCredit` - Client initiates credit purchase, returns bKash instructions
- `submitTrxId` - Client attaches bKash TrxID to pending transaction
- `approveCredit` - Admin approves/rejects transaction (callable, idempotent)

**Scheduled Jobs:**
- `cleanupOldRequests` - Daily cleanup of expired OTP requests and old webhook failure logs (WH-04)
- `aggregateStats` - Aggregates statistics every minute, writes to RTDB `/stats`

## Local Development with Emulator

1. Install dependencies:
```bash
cd functions
npm install
```

2. Set up local environment:
```bash
cp .env.example .env
# Edit .env with test values
```

3. Start the emulator:
```bash
firebase emulators:start
```

4. Run tests:
```bash
cd functions
npm test
```

## Testing

Run the full test suite:
```bash
cd functions
npm test
```

Individual test files:
```bash
npm test -- creditCheck.test.js      # Credit check and deduction tests (CR-05)
npm test -- approveCredit.test.js     # bKash approval flow tests (BK-04)
npm test -- upsertPackage.test.js     # Package management tests (BK-05)
npm test -- e2e-billing.test.js       # End-to-end billing cycle (TEST-E2E)
```

Run against the emulator:
```bash
firebase emulators:exec --only auth,functions,firestore,database 'cd functions && npm test'
```

## Verification

After deployment, verify the backend:

1. **Set up first admin:**
   ```bash
   curl -X POST https://asia-southeast1-your-project.cloudfunctions.net/setAdminClaim \
     -H "Content-Type: application/json" \
     -d '{"masterSecret":"YOUR_MASTER_SECRET","uid":"firebase-user-uid"}'
   ```

2. **Check Firestore indexes:**
   - Go to Firebase Console → Firestore → Indexes
   - Verify all indexes are "Enabled"

3. **Check packages:**
   - Go to Firebase Console → Firestore → packages
   - Verify Starter, Pro, and Enterprise packages exist

4. **Test credit check:**
   ```bash
   curl -X POST https://asia-southeast1-your-project.cloudfunctions.net/sendOtp \
     -H "Content-Type: application/json" \
     -d '{"appId":"test","appSecret":"test","phoneNumber":"+8801712345678"}'
   ```
   Expected: 402 `no_credits`

5. **Test getCredits:**
   ```bash
   curl -X POST https://asia-southeast1-your-project.cloudfunctions.net/getCredits \
     -H "Content-Type: application/json" \
     -d '{"appId":"your-app-id","appSecret":"your-app-secret"}'
   ```
   Expected: 200 with `sms_remaining` and `expires_at`

## Architecture Notes

### Credit Flow
1. Admin creates packages via `upsertPackage` (Firestore packages collection)
2. Client calls `requestCredit` → creates pending `transactions` document
3. Client calls `submitTrxId` → attaches bKash transaction ID
4. Admin calls `approveCredit` → Firestore transaction adds credits to `app_credits`
5. `sendOtp` checks credits before sending, decrements after queuing

### Webhook Flow
1. `registerApp` stores optional webhookUrl and webhookSecretHash
2. `sendOtp` copies webhook data into `/pending_sms/{sessionId}` (WH-01)
3. `otpStatus` fires webhook on status transitions (WH-03)
4. `sendWebhook` retries up to 3 times with exponential backoff (WH-02)
5. `cleanupOldRequests` cleans up webhook failure logs older than 7 days (WH-04)

### Security
- App secrets are stored as SHA-256 hashes (never plaintext)
- All `app_credits` modifications use Firestore transactions
- `approveCredit` is idempotent (409 on already-resolved transactions)
- Admin functions require Firebase Auth admin custom claim
- bKash number read from environment variable (never hardcoded)

## Troubleshooting

### Firestore indexes missing
```bash
firebase deploy --only firestore:indexes
```

### Packages not seeded
```bash
cd functions && node src/billing/seedPackages.js
```

### Functions not deploying
```bash
firebase --version  # Update: npm install -g firebase-tools@latest
```

### Environment variables missing
```bash
firebase functions:secrets:set APP_MASTER_SECRET
firebase functions:secrets:set BKASH_PERSONAL_NUMBER
firebase functions:secrets:set BKASH_MIN_TOPUP_AMOUNT
```

## Monitoring

1. Go to Firebase Console → Functions
2. Check logs for errors
3. Monitor execution times
4. Review Firestore read/write usage
5. Check `/stats` node in RTDB for aggregated metrics
