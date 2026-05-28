# Implementation Quality Checklist

**Purpose:** Evaluate error handling, logging, test coverage, documentation, code organization, and performance considerations.

## Error Handling
- [ ] Kotlin: uses `Result<T>` or sealed classes for operation results (never silent catch)
- [ ] JavaScript: all async operations wrapped in try/catch with structured error responses
- [ ] Network failures in AuthenticatorService handled with retry logic
- [ ] Firebase auth token expiry triggers re-authentication, not crash
- [ ] SMS parsing errors do not crash SmsReceiver (malformed SMS ignored gracefully)
- [ ] Wakelock released in all exit paths (try/finally or use() block)
- [ ] Timeout on all network calls (no indefinite waits)

## Logging
- [ ] Kotlin: uses `Log.i`/`Log.w`/`Log.e` only (no `Log.d`/`Log.v`)
- [ ] No secrets logged (only log lengths when needed for debugging)
- [ ] No SMS body text in logs
- [ ] Log messages are meaningful and include context
- [ ] Firebase Function logs include request IDs for traceability
- [ ] Error logs include stack traces for debugging
- [ ] No excessive logging in hot paths (health pings, poll loops)

## Test Coverage
- [ ] `AuthCrypto.kt` has unit test coverage for all public methods
- [ ] `SmsReceiver` has test coverage for SMS parsing (including carrier variations)
- [ ] `PhoneAuthHelper.kt` has integration test (`OtpFlowTest.kt`)
- [ ] Cloud Functions have test coverage for all endpoints
- [ ] Edge case tests exist: malformed tokens, expired requests, duplicate receipts
- [ ] Rate limiting behavior tested
- [ ] E2E test (`e2e/full-test.spec.js`) covers full verification flow

## Documentation
- [ ] Public functions have docblocks (Kotlin: KDoc, JS: JSDoc)
- [ ] Complex logic has inline comments explaining WHY (not what)
- [ ] ADR referenced for architectural decisions
- [ ] RTDB schema documented in `docs/Plan/05-DATA-MODEL.md`
- [ ] API endpoints documented in `docs/Plan/06-API.md`
- [ ] Known issues tracked in `docs/Plan/18-KNOWN-ISSUES.md`

## Code Organization
- [ ] Single responsibility per file/class
- [ ] No duplicate code — extract shared logic into utility functions
- [ ] File names match class names (PascalCase for Kotlin)
- [ ] Import ordering consistent
- [ ] Configuration values are constants, not magic numbers
- [ ] Constants in companion objects for Kotlin classes

## Performance
- [ ] No blocking calls on main thread in AuthenticatorService
- [ ] RTDB reads minimized (cache where possible)
- [ ] Health pings are lightweight single-write operations
- [ ] `cleanupOldRequests` does not lock database
- [ ] No N+1 query patterns
- [ ] Firebase Function cold start time considered (minimal dependencies)

## Approval
- [ ] All quality criteria met or waived
- [ ] Waived items documented with rationale
- [ ] Tech debt items filed in known issues
