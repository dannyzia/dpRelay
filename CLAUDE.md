# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> ⚠️ **MANDATORY FIRST READ:** This project uses **rhizome-mcp** for all task tracking. **Do not start work without `open_project` + `get_planning_graph` or `list_issues`.** See the "Rhizome Task Coordination" section at the bottom of this file. No work is silent — if it isn't in Rhizome, it didn't happen.

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

---

## 🧠 Rhizome Task Coordination (MANDATORY)

This project uses **rhizome-mcp** as the single source of truth for task tracking. Every coding agent session (Claude Code, Kilo, Codex, etc.) MUST use it. **No work is silent** — if it isn't in Rhizome, it didn't happen.

The server is installed (`~/.local/bin/rhizome-mcp`, project DB at `~/.local/share/rhizome-mcp/projects/<id>/tasks.db`) and registered in `.kilo/kilo.jsonc`. CLI: `npx rhizome-mcp <command>`.

### 0. Boot — orient every session

**First call in every session, before any other tool:**

```
rhizome-mcp open_project  (project_root = absolute repo path)
```

Retain the returned `project_ref` and pass it on every subsequent project-scoped call. The server is stateless; omitting `project_ref` only works if a default project is configured.

Then call `get_project` with that `project_ref` to load project-level instructions, supported values, limits, and the latest event ID. Use `get_changes(since_event_id=N)` to pick up what other sessions did while you were offline.

**Attribution (optional but recommended):** `create_agent_session` once → returns an `agent_session_handle` → pass it to every mutating call → `end_agent_session` at the end. Omitting it is supported; it just records `NULL` attribution.

### 1. Find work — never invent it

| Tool | Use when |
|---|---|
| `get_planning_graph(project_ref)` | You need to see dependencies, blockers, and the entry-point queue. |
| `list_issues(project_ref, is_claimable=true)` | You want a narrow "ready" queue with no graph reasoning. |
| `search(query)` | You're looking for historical knowledge, not current state. |

**Do not** use `list_issues` without filters and pick the first row. **Do not** start work on a blocked issue. **Do not** open two issues for the same intent.

If you have an idea that's not yet in Rhizome, **create an issue first** (`create_issue`) with type `task` or `bug`, acceptance criteria, and labels — then claim it. Don't start coding the idea and file the issue later; that loses the audit trail.

### 2. Load context — every claim

Before `claim_issue`, call `get_work_context(issue_id)` with the **default compact** context, then request only the additional sections you need:

```
get_work_context(issue_id, include=[
  "parent_epic", "relations", "related_issue_summaries",
  "recent_comments", "recent_attempt_notes", "decision_content",
  "attempt_history", "artifacts", "project_instructions",
  "changes_since_previous_attempt", "resource_reservations",
  "reservation_conflicts"
])
```

- Read **active decisions** and **acceptance criteria** as durable constraints. They override your assumptions.
- If the criteria are missing or contradictory, **add a comment or record a decision** before guessing.
- For an epic, request `parent_epic` and `related_issue_summaries`.

### 3. Claim — atomic, with a lease

```
claim_issue(issue_id, resources=[...], lease_seconds=1800)
```

- Only `ready` or `review` are claimable. Never `in_progress` (derived, not stored).
- **Keep `attempt_id` and `lease_token` private and reusable** until the attempt ends.
- For long work, call `renew_attempt` before expiry. A lost lease is NOT ownership.
- **Always pass `resources`** if the work edits specific files, modules, or has logical dependencies. Reservation is all-or-nothing; a conflict fails the whole claim with `RESOURCE_RESERVATION_CONFLICT`.

**Resource conventions for this repo:**

| Task type | Reserve |
|---|---|
| Modify `functions/index.js` | `{"kind":"file","path":"functions/index.js"}` |
| Modify `authenticator-app/app/src/main/java/com/digitalpapyrus/authenticator/SmsReceiver.kt` | `{"kind":"file","path":"..."}` |
| Edit Cloud Functions security rules | `{"kind":"file","path":"firestore.rules"}` and/or `{"kind":"file","path":"database.rules.json"}` |
| Deploy to Firebase | `{"kind":"logical","namespace":"deploy","name":"authenticator-15fb7"}` |
| Edit a whole subtree | `{"kind":"directory","path":"functions/"}` |

### 4. Execute — durably, with checkpoints

**Checkpoint cadence:** every 10–15 minutes of active work, or before any risky operation (deploy, schema change, secret rotation).

```
save_attempt_note(
  attempt_id, lease_token,
  kind="checkpoint",   # or "progress" / "finding" / "warning"
  content="""
    Done: ...    ## Self-contained, what is done
    Remaining: ...  ## What is left
    Verify: ...   ## How a successor can check
  """,
  artifacts=[...]
)
```

Other rules:

- **Use comments for collaboration** (`add_comment`).
- **Use decisions for durable choices** (`record_decision`). Decisions are supersedable; mark old ones `superseded`.
- **Use `update_issue`** with the current `expected_version`. On `VERSION_CONFLICT`, refetch, reconcile, retry.
- **Validate multi-issue plans** with `validate_issue_plan` before `apply_issue_plan`. Atomic = all-or-nothing.

### 5. Review — request, approve, supersede

When work completes, call `finish_attempt(attempt_id, lease_token, outcome="completed", target_issue_status="review" | "done", result_summary, verification, artifacts)`.

Then, **separately**, open a review request:

```
create_review_request(
  issue_id, target_issue_version=N, target_event_id=<from finish_attempt>,
  purposes=["implementation", ...]
)
```

`target_issue_version` and `target_event_id` freeze what the reviewer verifies. Stale approvals are structurally impossible.

To supersede an open request whose target has moved: `replace_review_request(predecessor_request_id, ...)`. Resolved requests cannot be replaced.

Reviewers complete with `finish_attempt(outcome="completed", review_outcome="approved" | "changes_requested" | "blocked")`. `changes_requested` returns the issue to `ready`; a re-review needs a fresh `create_review_request` against the new target.

### 6. Handoff — never leave an attempt active

**Every attempt MUST end with `finish_attempt` — exactly once.** No silent abandonment, no leaving the lease to expire.

| Outcome | Use |
|---|---|
| `completed` | Work done. `target_issue_status` to `review` (default) or `done`. |
| `failed` | Could not complete. `failure_reason_code` + `reason_details`. |
| `interrupted` | Handing off. `interruption_reason_code: handoff` + `next_steps`. |
| `blocked` | External blocker. `blocked_reason`. |

`finish_attempt` returns the new `latest_event_id` and `target_issue_version` for the review request.

### 7. The "I died mid-task" guarantee

This is the whole point of Rhizome. If a session crashes, times out, or hits a context limit:

- The lease expires (default 60 min, renewable up to 60 min).
- The issue becomes claimable again.
- A new session claims it, calls `get_work_context(include=["changes_since_previous_attempt"])`, reads the last `checkpoint`, and resumes.

**This works only if checkpoints are written.** If you do checkpoint-less work for 90 minutes and die, your successor has nothing to resume from. Treat `save_attempt_note(kind="checkpoint")` as a 10-minute alarm.

---

### Quick reference card

```
BOOT:
  open_project(project_root=<abs>)
  get_project(project_ref)

FIND:
  get_planning_graph(project_ref)
  list_issues(project_ref, is_claimable=true)

LOAD:
  get_work_context(issue_id, include=[...])

CLAIM:
  claim_issue(issue_id, resources=[...], lease_seconds=1800)
  -> keeps attempt_id, lease_token private

EXECUTE:
  save_attempt_note(attempt_id, lease_token, kind="checkpoint", content=...)
  add_comment(issue_id, content=...)
  record_decision(issue_id, title, summary, content, status="active")

FINISH:
  finish_attempt(attempt_id, lease_token, outcome="completed", target_issue_status="review", ...)
  create_review_request(issue_id, target_issue_version, target_event_id, purposes=[...])
```

---

## 🌿 House style for this project

- **Open a Rhizome issue before touching code** for any non-trivial change (>1 file, >10 lines, or anything that ships). The issue title becomes the commit subject.
- **Cross-reference commits to issues** in the commit body: `Refs: ISSUE-12` or `Closes: ISSUE-12`.
- **Never edit a file another agent has reserved.** Run `get_work_context(include=["resource_reservations"])` first if unsure.
- **End every session with `finish_attempt`** — no exceptions, no "I'll do it next time."
- **If you discover out-of-scope work**, create a separate Rhizome issue and link it (`blocks`/`related_to`), don't expand the current one.
- **Pre-merge gate**: lint + tests + Rhizome-linked commits. The CI run-script is `bash scripts/run-all-checks.sh`.
