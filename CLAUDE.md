# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Phone Authenticator v4** — A production-grade SMS-based phone number verification system using Firebase Cloud Functions, a React web dashboard, and a dedicated Android authenticator device.

- **Web Dashboard** (`web/`): React + Vite + TailwindCSS app with marketing pages, auth, client dashboard (apps, credits, transactions, bulk campaigns, playground), and admin panel (package management, metrics, approvals).
- **Cloud Functions** (`functions/`): Node.js 20, handles `startVerification`, `checkAuth`, `registerAuthenticator`, `health`, `cleanupOldRequests`.
- **Authenticator App** (`authenticator-app/`): Kotlin Android app that runs as a foreground service on a dedicated phone, receives SMS and writes receipts to Firebase RTDB.
- **Client Library** (`client/`): `PhoneAuthHelper.kt` — client-side library for integration into ecommerce/medical apps.
- **Firebase RTDB**: Stores verification requests, receipts, registered apps, pending SMS, OTP requests, and health pings with security rules enforcing `role=authenticator`.

The system targets Bangladesh carrier formats with E.164 normalization (`+880` prefix handling).

## Common Development Commands

### Android (Authenticator App)
```bash
cd authenticator-app

# Build
./gradlew assembleDebug

# Run tests
./gradlew testDebugUnitTest

# Linting
./gradlew ktlintCheck          # Format check
./gradlew ktlintFormat         # Auto-fix formatting
./gradlew lintDebug            # Android Lint

# Test coverage (Jacoco)
./gradlew jacocoTestReport     # Generate coverage report (outputs to app/build/reports/jacoco/)

# Install to device
./gradlew installDebug
```

### Web Dashboard
```bash
cd web

# Install dependencies
npm install

# Dev server (localhost:5173)
npm run dev

# Production build
npm run build

# Preview production build
npm run preview
```

### Cloud Functions
```bash
cd functions

# Install dependencies
npm install

# Run tests
npm test

# Linting
npm run lint
npm run lint:fix

# Local development (emulator)
firebase emulators:start --only functions

# Deploy
firebase deploy --only functions
```

### Firebase
```bash
# Set secrets (required before deployment)
firebase functions:secrets:set VERIFICATION_SIGNING_SECRET
firebase functions:secrets:set AUTHENTICATOR_ENROLLMENT_SECRET
firebase functions:secrets:set HEALTH_ADMIN_SECRET
firebase functions:secrets:set ACTIVE_DEDICATED_NUMBER

# Deploy database rules
firebase deploy --only database

# Deploy hosting (web dashboard)
firebase deploy --only hosting

# Deploy everything
firebase deploy
```

### Local Emulators
```bash
# Start all emulators (functions, database, firestore, auth)
firebase emulators:start

# Start with specific services only
firebase emulators:start --only functions,database,auth
```

The UI is available at http://localhost:4000, Functions at port 5001, RTDB at 9000, Firestore at 8080, Auth at 9099.

## High-Level Architecture

### Security Model (Server-Issued Challenge)
The v4 security model uses **server-issued challenges** — public clients never hold a long-lived verification secret:

1. Client calls `POST /v4/startVerification` with `{ userPhone }`
2. Cloud Function mints a `challengeToken` and `pollToken` using `VERIFICATION_SIGNING_SECRET`
3. Client sends SMS: `AUTH:{sessionCode}:{expiresAt}:{challengeToken}` to the dedicated number
4. Authenticator phone receives SMS, validates shape, writes receipt to `/verification_requests/{sessionCode}/receipt`
5. Client polls `POST /v4/checkAuth` with `{ sessionCode, pollToken }`
6. Cloud Function verifies poll token, validates challenge, matches sender, atomically deletes record

### Key Security Boundaries
- **Authenticator device writes**: Require Firebase custom auth with `auth.token.role == 'authenticator'`
- **Challenge tokens**: Server-only secret, never exposed to client apps
- **Enrollment secret**: Entered at first-run via prompt, stored in `EncryptedSharedPreferences` (never in `BuildConfig` — see TD-13/ADR-016)
- **HMAC comparison**: Must use constant-time comparison (`crypto.timingSafeEqual()` in Node, `AuthCrypto.constantTimeEquals()` in Kotlin)

### Data Flow
```
Web Dashboard / Client Apps     Cloud Functions          Authenticator Phone       Firebase
┌──────────────────┐          ┌──────────────────┐      ┌──────────────────┐     ┌──────────────────┐
│ startVerification│─ HTTPS ─>│  Mint challenge  │      │                  │     │                  │
│ checkAuth        │<── resp ─│  Verify receipt  │      │  SmsReceiver     │     │  RTDB            │
└──────────────────┘          └──────────────────┘      │  ↓ validate SMS  │     │  ├ verification_ │
                                                         │  ↓ write receipt │─>───>│  │  requests/     │
                                                         └──────────────────┘     │  ├ health/        │
                                                                                  │  ├ registered_   │
                                                                                  │  │  apps/         │
                                                                                  │  ├ pending_sms/   │
                                                                                  │  └ otp_requests/  │
                                                                                  └──────────────────┘
```

## Code Structure

### Authenticator App (`authenticator-app/app/src/main/java/com/digitalpapyrus/authenticator/`)
- `MainActivity.kt` — Permissions + battery + auto-start UI
- `AuthenticatorService.kt` — Foreground service + Firebase custom auth + wakelock
- `SmsReceiver.kt` — SMS challenge parsing + RTDB receipt write (includes E.164 normalization)
- `AuthCrypto.kt` — Constant-time helpers + token utilities
- `AuthFcmService.kt` — FCM backup wake-up + health reporting
- `DeviceRegistrationClient.kt` — `registerAuthenticator` bootstrap client
- `AlarmKeepAlive.kt` — Exact alarm scheduler (5 min)
- `KeepAliveReceiver.kt` — Alarm receiver + service restart
- `ServiceKeepAliveWorker.kt` — WorkManager keep-alive (15 min)
- `BootReceiver.kt` — Auto-start on boot
- `EncryptedPrefsHelper.kt` — Secure storage for enrollment secret

> ⚠️ **NOTE:** `PhoneAuthHelper.kt` exists in this directory but is misplaced. It is a client-side library for verification requests (used by ecommerce/medical apps). Do not reference it from authenticator app code.

### Web Dashboard (`web/`)
- `App.jsx` — Router setup with marketing, auth, client dashboard, and admin routes
- `pages/marketing/` — Home, Pricing, Docs, Contact
- `pages/auth/` — Login, Register
- `pages/dashboard/` — Apps, Credits, Transactions, Playground, Bulk Campaigns, Settings
- `pages/admin/` — Packages, Transactions, Metrics, Bulk Campaigns
- `components/` — Layout, navigation, shared UI components

### Cloud Functions (`functions/`)
- `index.js` — All Cloud Functions endpoints (`startVerification`, `checkAuth`, `registerAuthenticator`, `health`, `cleanupOldRequests`)
- `package.json` — Dependencies (firebase-admin, firebase-functions)

### Client Library (`client/`)
- `PhoneAuthHelper.kt` — Kotlin SDK for integrating verification into client apps
- `test/OtpFlowTest.kt` — Integration test simulating the OTP flow

### E2E Tests (`e2e/`)
- `full-test.spec.js` — Playwright-based full-system test

## Important Conventions

### Naming
| Thing | Convention | Example |
|-------|------------|---------|
| Kotlin files | PascalCase matching class name | `AuthCrypto.kt`, `SmsReceiver.kt` |
| Kotlin classes | PascalCase | `AuthenticatorService` |
| Kotlin functions | camelCase | `generateSignature()`, `pushToFirebase()` |
| Kotlin constants | SCREAMING_SNAKE_CASE in companion object | `VERIFICATION_ENROLLMENT_SECRET`, `CLOCK_SKEW_MS` |
| JavaScript functions | camelCase | `checkRateLimit()`, `verifyPollToken()` |
| Firebase RTDB paths | snake_case | `verification_requests`, `health` |

### Import Ordering
**Kotlin:** Android/Platform → Third-party → Project (alphabetically within groups)
**JavaScript:** Node built-ins → firebase-* → local modules

### Error Handling
- **Kotlin**: Never catch and swallow exceptions silently. Use `Result<T>` or sealed classes for operation results.
- **JavaScript**: All async operations must be wrapped in try/catch. Return structured error responses, never throw.

### Security Hard Rules
1. **Never** log secrets (only log their lengths)
2. **Never** store SMS body text in database (only `receivedAt`, `sender`, `challengeToken`, `device`)
3. **Never** use `===` for HMAC comparison — use constant-time comparison
4. **Never** compile `AUTHENTICATOR_ENROLLMENT_SECRET` into `BuildConfig` — use `EncryptedSharedPreferences`
5. **Never** use `Log.d` or `Log.v` in committed Kotlin — use `Log.i`/`Log.w`/`Log.e` only

### Build Configuration Notes
- `build.gradle` includes workarounds for AAR metadata validation issues (`checkAarMetadata` task disabled, `--warn-manifest-validation` flag)
- Cloud Functions URLs are in `BuildConfig` (acceptable); only `AUTHENTICATOR_ENROLLMENT_SECRET` must be runtime-only per ADR-016
- Jacoco is configured for code coverage but reports are not generated by default — run `jacocoTestReport` explicitly

## Known Issues & Tech Debt

See `docs/Plan/18-KNOWN-ISSUES.md` for full list. Key blockers:
- **TD-04**: No Firebase Crashlytics integration yet (required before production)
- **TD-09**: Missing automated integration tests for Cloud Functions crypto paths
- **TD-13**: `AUTHENTICATOR_ENROLLMENT_SECRET` must NOT be in BuildConfig (use runtime prompt)
- **TD-10**: E.164 normalization in `SmsReceiver` (handles Bangladesh carrier formats like `017...` → `+88017...`)

## Environment Variables

All secrets managed via Firebase Secrets Manager:
- `VERIFICATION_SIGNING_SECRET` — Server-only, for minting challenges
- `AUTHENTICATOR_ENROLLMENT_SECRET` — Authenticator-only bootstrap (runtime entry, NOT BuildConfig)
- `HEALTH_ADMIN_SECRET` — Protects `/health` endpoint
- `ACTIVE_DEDICATED_NUMBER` — Current SMS target number

See `docs/Plan/11-ENV-VARS.md` for full details.

## Key Documentation

| File | Purpose |
|------|---------|
| `docs/Plan/02-ARCHITECTURE.md` | System architecture and request lifecycle |
| `docs/Plan/03-TECH-STACK.md` | Approved dependencies and off-limits patterns |
| `docs/Plan/04-ADR.md` | Architecture Decision Records |
| `docs/Plan/05-DATA-MODEL.md` | Firebase RTDB schema |
| `docs/Plan/06-API.md` | API contract for all endpoints |
| `docs/Plan/10-DEV-SETUP.md` | Local development setup |
| `docs/Plan/13-CONVENTIONS.md` | Coding conventions |
| `docs/Plan/18-KNOWN-ISSUES.md` | Active tech debt |

## Pre-Commit Checklist

Before committing, run:
```bash
./gradlew ktlintCheck              # Kotlin format check
cd functions && npm run lint       # ESLint
./gradlew testDebugUnitTest        # Android unit tests
cd functions && npm test           # Function tests
```

Or run the full validation suite:
```bash
bash scripts/run-all-checks.sh     # Linters, audits, schema checks, security, tests
```

A pre-commit hook is available at `scripts/pre-commit.sh` — it runs ktlint, route audit, schema check, security audit, Android unit tests, and Cloud Functions tests. To install:
```bash
cp scripts/pre-commit.sh .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

## AI Engineering System

The repository includes a modular multi-agent engineering system in `.claude/`:
- **Agents** (`.claude/agents/`): 8 specialized agents (Orchestrator, Architect, Builder, Code Skeptic, Security, Testing, Documentation, DevOps)
- **Rules** (`.claude/rules/`): 12 category-separated rule files covering architecture, security, testing, API, and more
- **Workflows** (`.claude/workflows/`): 7 defined workflows with validation gates and approval conditions
- **Memory** (`.claude/memory/`): Operational lessons, pitfalls, anti-patterns, and standards
- **Tools** (`tools/`): 6 validation scripts (PRD drift, route audit, schema check, dependency analysis, env validation, security audit)
- **Evaluations** (`evaluations/`): 7 quality checklists for reviews

The old monolithic `Agent Prompts.md` has been archived to `docs/archive/`.

## Testing

### Android Unit Tests
```bash
./gradlew testDebugUnitTest                    # Run all unit tests
./gradlew test --tests "AuthCryptoTest"        # Run specific test class
./gradlew test --tests "*Crypto*constantTime*" # Run specific test method
./gradlew jacocoTestReport                     # Generate coverage report
```

### Cloud Functions Tests
```bash
cd functions && npm test
```

### E2E Tests (Playwright)
```bash
cd e2e
npx playwright test               # Run all E2E tests
npx playwright test full-test.spec.js  # Run specific test file
```

### Client Library Tests
```bash
cd client/test
# Run OtpFlowTest.kt via Android Studio or gradle
```

### Integration Tests
```bash
./gradlew connectedAndroidTest  # Requires emulator/device
```

## Deployment

- **Staging**: Auto-deploys on merge to `develop` branch
- **Production**: Manual deploy only; requires team lead authorization
- See `docs/Plan/15-RUNBOOK-DEPLOY.md` for complete deployment runbook

## Project-Specific Rules from Cursor/Copilot

The project uses universal AI coding rules defined in `.cursorrules` and `.github/copilot-instructions.md`. Key points:
- Provide complete file paths with every edit suggestion
- No truncation or `// rest of file`
- Ask for clarification before changes touching >3 files
- Never assume — ask questions with options (a/b/c/d)
- No hardcoded values (use environment variables)
- All new public functions need docblocks

## Graph Maintenance

After modifying any code files, run:
- `code-review-graph update` — always (fast, <2s)
- `graphify update .` — after large batches of changes only
