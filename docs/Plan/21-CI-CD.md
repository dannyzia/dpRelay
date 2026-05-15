<!--
AI: This document defines the CI/CD pipeline and deployment automation.
Read first: 15-RUNBOOK-DEPLOY.md (deployment procedures), 10-DEV-SETUP.md (local setup)
You must: Configure all workflows listed. Enforce quality gates before deployment.
You must not: Deploy without all quality gates passing. Skip manual approval for production.
Human reviews this: NO — AI maintains CI config. Human reviews during initial setup.
-->

# CI/CD Pipeline
**Project:** Authenticator

## Overview
Continuous integration and deployment for the Authenticator phone verification system.

---

## GitHub Actions Workflows

### 1. PR Checks (`.github/workflows/pr-checks.yml`)
```yaml
name: PR Checks
on:
  pull_request:
    branches: [develop, main]

jobs:
  android-lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v3
        with:
          java-version: '17'
          distribution: 'temurin'
      - name: Run Android Lint
        run: ./gradlew lintDebug
      - name: Upload Lint Report
        uses: actions/upload-artifact@v3
        with:
          name: lint-report
          path: app/build/reports/lint-results-debug.html

  ktlint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run ktlint
        uses: ScaCap/action-ktlint@master
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          reporter: github-pr-review

  android-unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v3
        with:
          java-version: '17'
          distribution: 'temurin'
      - name: Cache Gradle
        uses: actions/cache@v3
        with:
          path: ~/.gradle/caches
          key: ${{ runner.os }}-gradle-${{ hashFiles('**/*.gradle') }}
      - name: Run Unit Tests
        run: ./gradlew testDebugUnitTest
      - name: Upload Coverage
        uses: codecov/codecov-action@v3
        with:
          files: app/build/reports/jacoco/testDebugUnitTestCoverage.xml
          fail_ci_if_error: true
          verbose: true

  cloud-function-tests:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: functions
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install Dependencies
        run: npm ci
      - name: Run ESLint
        run: npm run lint
      - name: Run Tests
        run: npm test
      - name: Upload Coverage
        uses: codecov/codecov-action@v3
        with:
          files: functions/coverage/lcov.info

  security-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run npm audit
        working-directory: functions
        run: npm audit --audit-level=moderate
      - name: Run dependency check
        uses: dependency-check/Dependency-Check_Action@main
        with:
          project: 'Authenticator'
          path: '.'
          format: 'ALL'

  integration-tests:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v3
        with:
          java-version: '17'
          distribution: 'temurin'
      - name: Cache Gradle
        uses: actions/cache@v3
        with:
          path: ~/.gradle/caches
          key: ${{ runner.os }}-gradle-${{ hashFiles('**/*.gradle') }}
      - name: Install Firebase CLI
        run: npm install -g firebase-tools
      - name: Start Firebase Emulator
        run: firebase emulators:start --only functions,database,auth &
      - name: AVD Cache
        uses: actions/cache@v3
        id: avd-cache
        with:
          path: |
            ~/.android/avd/*
            ~/.android/adb*
          key: avd-${{ runner.os }}-${{ hashFiles('**/*.gradle') }}
      - name: Create AVD and Generate Snapshot
        if: steps.avd-cache.outputs.cache-hit != 'true'
        uses: reactivecircus/android-emulator-runner@v2
        with:
          api-level: 34
          target: google_apis
          arch: x86_64
          force-avd-creation: false
          emulator-options: -no-window -gpu swiftshader_indirect -noaudio -no-boot-anim
          disable-animations: false
          script: echo "Generated AVD snapshot"
      - name: Run Integration Tests
        uses: reactivecircus/android-emulator-runner@v2
        with:
          api-level: 34
          target: google_apis
          arch: x86_64
          force-avd-creation: false
          emulator-options: -no-window -gpu swiftshader_indirect -noaudio -no-boot-anim
          disable-animations: true
          script: ./gradlew connectedAndroidTest
```

### 2. Staging Deploy (`.github/workflows/staging-deploy.yml`)
```yaml
name: Staging Deploy
on:
  push:
    branches: [develop]

jobs:
  deploy-functions:
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install Firebase CLI
        run: npm install -g firebase-tools
      - name: Deploy to Staging
        working-directory: functions
        run: firebase deploy --only functions --project PhoneAuthService-dev
        env:
          FIREBASE_TOKEN: ${{ secrets.FIREBASE_TOKEN_STAGING }}
      - name: Verify Deploy
        run: |
          sleep 30
          curl -H "Authorization: Bearer ${{ secrets.STAGING_SECRET }}" \
            # TODO: Replace {region} with actual Firebase region (e.g., asia-southeast1)
            https://{region}-PhoneAuthService-dev.cloudfunctions.net/health
```

### 3. Production Deploy (`.github/workflows/production-deploy.yml`)
```yaml
name: Production Deploy
on:
  push:
    branches: [main]
  workflow_dispatch:  # Manual trigger option

jobs:
  quality-gates:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Check Test Coverage
        run: |
          COVERAGE=$(./gradlew jacocoTestReport | grep -oP 'Total.*?\K[0-9]+' | head -1)
          if [ "$COVERAGE" -lt 80 ]; then
            echo "Coverage $COVERAGE% is below 80% threshold"
            exit 1
          fi
      - name: Check Secrets Not in Code
        run: |
          if git log --all --full-history -- '*.kt' '*.js' | grep -i "shared.*secret\|password"; then
            echo "Potential secret found in git history!"
            exit 1
          fi

  deploy-functions:
    needs: quality-gates
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      - name: Install Firebase CLI
        run: npm install -g firebase-tools
      - name: Deploy to Production
        working-directory: functions
        run: firebase deploy --only functions --project PhoneAuthService
        env:
          FIREBASE_TOKEN: ${{ secrets.FIREBASE_TOKEN_PRODUCTION }}
      - name: Verify Deploy
        run: |
          sleep 30
          curl -H "Authorization: Bearer ${{ secrets.PRODUCTION_SECRET }}" \
            # TODO: Replace {region} with actual Firebase region (e.g., asia-southeast1)
            https://{region}-PhoneAuthService.cloudfunctions.net/health
      - name: Notify Slack
        if: always()
        uses: 8398a7/action-slack@v3
        with:
          status: ${{ job.status }}
          channel: '#deployments'
          text: 'Production deploy ${{ job.status }}'
        env:
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK }}
```

---

## Quality Gates

### Pre-Deployment Requirements
| Gate | Threshold | Enforced By |
|------|-----------|-------------|
| Unit test coverage | >= 80% (100% crypto) | CI (codecov) |
| Android Lint | 0 warnings | CI (gradlew lint) |
| ktlint | 0 formatting issues | CI (ktlint action) |
| ESLint | 0 warnings | CI (npm run lint) |
| npm audit | 0 high/critical | CI (audit step) |
| Secrets scan | 0 secrets detected | CI (git log check) |
| Staging health | healthy for 24h | Manual verification |

### Deployment Approval Flow
```
Developer pushes to develop
    |
PR Checks (auto)
    |
Staging Deploy (auto on merge)
    |
24-hour burn-in period
    |
PR to main (requires 2 approvals)
    |
Quality Gates (auto)
    |
Production Deploy (manual approval required)
    |
Health verification + Slack notification
```

---

## Firebase Deployment Automation

### Functions Deployment
```bash
# Deploy all functions
firebase deploy --only functions

# Deploy specific function
firebase deploy --only functions:checkAuth

# Deploy with secrets (handled automatically)
firebase deploy --only functions --token "$FIREBASE_TOKEN"
```

### Security Rules Deployment
```bash
# Deploy RTDB rules
firebase deploy --only database

# Rules stored in firebase.json or database.rules.json
```

### Index Configuration
```bash
# Deploy indexes
firebase deploy --only firestore:indexes
```

---

## Secret Management

### GitHub Secrets Required
| Secret | Purpose | Set By |
|--------|---------|--------|
| `FIREBASE_TOKEN_STAGING` | Deploy to staging | Admin |
| `FIREBASE_TOKEN_PRODUCTION` | Deploy to production | Admin |
| `STAGING_SECRET` | Health check auth | Admin |
| `PRODUCTION_SECRET` | Health check auth | Admin |
| `SLACK_WEBHOOK` | Deployment notifications | Admin |

### Firebase Secrets (not in GitHub)
| Secret | Location | Rotation |
|--------|----------|----------|
| `VERIFICATION_SIGNING_SECRET` | Firebase Secrets Manager | Manual, 6 months |
| `AUTHENTICATOR_ENROLLMENT_SECRET` | Firebase Secrets Manager | Manual, on device re-enrollment |
| `HEALTH_ADMIN_SECRET` | Firebase Secrets Manager | Manual, 6 months |

### Secret Rotation Procedure
```bash
# 1. Generate new secret
NEW_SECRET=$(openssl rand -base64 32)

# 2. Update Firebase Secrets Manager
firebase functions:secrets:set VERIFICATION_SIGNING_SECRET <<< "$NEW_SECRET"

# 3. Update GitHub Secrets (if applicable)
gh secret set PRODUCTION_SECRET -b "$NEW_SECRET"

# 4. Deploy Cloud Functions with new secret
firebase deploy --only functions

# 5. Verify health endpoint and a fresh startVerification flow
```

---

## Rollback Strategy

### Automatic Rollback Criteria
| Condition | Action | Time Limit |
|-----------|--------|------------|
| Health endpoint degraded | Auto-rollback functions | 5 minutes |
| Error rate > 10% | Alert + manual decision | 15 minutes |
| Deploy verification fails | Block production deploy | Immediate |

### Rollback Commands
```bash
# Rollback to previous function version by deploying from a known-good commit
# Note: Firebase Cloud Functions do not support version-based rollback like Hosting.
# The correct approach is to deploy from the previous stable commit.

# Or redeploy from previous commit
git checkout <stable-commit>
firebase deploy --only functions
git checkout main
```

---

## Environment Management

### Environment Variables per Branch
| Variable | develop | main | local |
|----------|---------|------|-------|
| `CF_URL` | staging-URL | prod-URL | emulator |
| `VERIFICATION_SIGNING_SECRET` | staging-secret | prod-secret | test-secret |
| `LOG_LEVEL` | debug | warn | debug |
| `RATE_LIMIT_MAX` | 60 | 30 | 1000 |

### Environment Configuration
```javascript
// functions/config.js
const functions = require('firebase-functions');

const config = {
  environment: process.env.NODE_ENV || 'development',
  logLevel: functions.config().app?.log_level || 'info',
  rateLimitMax: parseInt(functions.config().app?.rate_limit_max) || 30,
};

module.exports = config;
```

---

## Monitoring & Alerting

### CI/CD Alerts
| Event | Channel | Severity |
|-------|---------|----------|
| Deploy failed | #deployments | P2 |
| Quality gate failed | #dev-team | P3 |
| Coverage dropped below 80% | #dev-team | P3 |
| Security audit failed | #security + #dev-team | P1 |

### Deployment Notifications
```yaml
# Slack notification template
- title: "Production Deploy Complete"
  fields:
    - Commit: ${{ github.sha }}
    - Branch: ${{ github.ref }}
    - Status: ${{ job.status }}
    - Health: ${{ steps.health.outputs.status }}
```

---

## Local Development CI Simulation

### Pre-commit Hooks (`.git/hooks/pre-commit`)
```bash
#!/bin/bash
# Run ktlint
./gradlew ktlintCheck || exit 1

# Run unit tests
./gradlew test || exit 1

# Run function tests
cd functions && npm test || exit 1

echo "All checks passed"
```

### Local CI Runner (act)
```bash
# Install act: https://github.com/nektos/act
# Run workflows locally
act -j android-unit-tests
act -j cloud-function-tests
```
