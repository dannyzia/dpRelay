# Authenticator — Project Overview

## Purpose
Production-grade SMS-based phone number verification system using Firebase Cloud Functions and a dedicated Android authenticator device. Targets Bangladesh carrier formats (E.164 normalization).

## Architecture
- **Authenticator App** (`authenticator-app/`): Kotlin Android app, runs as a foreground service on a dedicated phone, receives SMS and writes receipts to Firebase RTDB.
- **Cloud Functions** (`functions/`): Node.js 20, handles startVerification, checkAuth, registerAuthenticator, health, cleanupOldRequests.
- **Firebase RTDB**: Stores verification requests and receipts with security rules enforcing role=authenticator.

## Current State
All implementation phases (1-7) are marked complete. Remaining blockers are deployment steps: setting Firebase secrets, adding google-services.json, integrating Crashlytics, deploying functions, and running lints.

## Key Documents
- `docs/Plan/13-CONVENTIONS.md` — naming, code style, git conventions
- `docs/Plan/03-TECH-STACK.md` — approved deps, off-limits patterns
- `docs/Plan/11-ENV-VARS.md` — environment variables
- `docs/Plan/18-KNOWN-ISSUES.md` — active tech debt
- `docs/Plan/14-DEV-CHECKLIST.md` — development checklist
- `IMPLEMENTATION_SUMMARY.md` — what has been built
- `AUDIT_FIXES_SUMMARY.md` — audit fixes applied
- `README.md` — project overview and setup
