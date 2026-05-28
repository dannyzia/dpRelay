# PRD Drift Checklist

**Purpose:** Compare implementation against PRD requirements — feature completeness, behavior match, scope boundaries, and edge case handling.

## Feature Completeness
- [ ] All PRD-required endpoints exist (`startVerification`, `checkAuth`, `registerAuthenticator`, `health`, `cleanupOldRequests`)
- [ ] All required data model fields present in RTDB (see `docs/Plan/05-DATA-MODEL.md`)
- [ ] Authenticator app runs as a foreground service (not background, not activity-only)
- [ ] SMS receipt writing flow is complete (SmsReceiver -> RTDB write)
- [ ] Client library (`PhoneAuthHelper.kt`) exposes required public API

## Behavior Match
- [ ] Challenge token format matches PRD specification
- [ ] Server-issued challenge flow implemented correctly (not a shared-secret model)
- [ ] Polling mechanism uses `pollToken`, not the original `challengeToken`
- [ ] Receipt validation matches sender `+880` number against `ACTIVE_DEDICATED_NUMBER`
- [ ] Atomic delete of verification record on successful check
- [ ] Health pings sent at the specified interval (5 min alarm, 15 min WorkManager)

## Scope Boundaries
- [ ] No feature creep — implementation does not add unrequested functionality
- [ ] `PhoneAuthHelper.kt` lives in `client/` (not referenced from authenticator app)
- [ ] No UI beyond what was specified (authenticator app is headless service)
- [ ] Rate limits match PRD values

## Edge Case Handling
- [ ] Duplicate SMS receipts are identified and ignored
- [ ] Expired verification requests are cleaned up (`cleanupOldRequests`)
- [ ] Authenticator re-connects to Firebase after network loss
- [ ] Multiple verification requests for same phone handled correctly
- [ ] Session timeout tracker for pending SMS
- [ ] Clock skew between devices is handled (SKEW tolerance constants)

## Deviations
- [ ] List any deviations from PRD with justification
- [ ] All deviations documented in `docs/Plan/18-KNOWN-ISSUES.md`
- [ ] ADR created for any significant architectural deviations
- [ ] Team lead notified of any behavior changes from original spec
