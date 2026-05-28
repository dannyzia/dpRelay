# Deployment Checklist

**Purpose:** Pre- and post-deployment validation — environment vars, secrets, emulator tests, rollback preparedness, and monitoring.

## Pre-Deployment

### Environment & Secrets
- [ ] `VERIFICATION_SIGNING_SECRET` set in Firebase Secrets Manager
- [ ] `AUTHENTICATOR_ENROLLMENT_SECRET` set in Firebase Secrets Manager
- [ ] `HEALTH_ADMIN_SECRET` set in Firebase Secrets Manager
- [ ] `ACTIVE_DEDICATED_NUMBER` set in Firebase Secrets Manager
- [ ] All secrets accessible from target Cloud Functions region (`asia-southeast1`)
- [ ] No hardcoded secrets in `BuildConfig` or environment config files
- [ ] Functions use the correct Node.js version (20)

### Build Verification
- [ ] Android app builds clean (`./gradlew assembleDebug`)
- [ ] Web dashboard builds clean (`cd web && npm run build`)
- [ ] Cloud Functions deploy dry-run succeeds (`firebase deploy --only functions --dry-run`)

### Emulator Test
- [ ] `firebase emulators:start` starts all required services without errors
- [ ] `startVerification` endpoint responds correctly on emulator
- [ ] `checkAuth` endpoint validates tokens on emulator
- [ ] `registerAuthenticator` endpoint works on emulator
- [ ] `health` endpoint accessible on emulator
- [ ] Test with a full E2E flow on emulator

### Rollback Preparation
- [ ] Previous production version tagged in Git
- [ ] Rollback script verified
- [ ] Firebase Function version pinned for immediate rollback
- [ ] Database rules backup taken (current production rules saved)

## Post-Deployment

### Verification
- [ ] All Cloud Functions deployed successfully
- [ ] Functions respond to HTTPS requests
- [ ] Authenticator device health ping received (check `/health` endpoint)
- [ ] Test verification request completes end-to-end
- [ ] Web dashboard loads and authenticates

### Monitoring (First Hour)
- [ ] Firebase Function logs show no errors
- [ ] Error rate at or below pre-deployment baseline
- [ ] Verification request completion rate normal
- [ ] No unusual spikes in function execution time
- [ ] Authenticator health pings arriving on schedule

### Monitoring (24 Hours)
- [ ] No delayed error patterns emerged
- [ ] Memory usage stable across functions
- [ ] Cold start times acceptable
- [ ] Rate limits not exceeded
- [ ] `cleanupOldRequests` running on schedule

### Communication
- [ ] Deployment recorded in team channel
- [ ] Known issues doc updated with any deployment notes
- [ ] Stakeholders notified of release completion
