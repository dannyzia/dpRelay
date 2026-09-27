#!/bin/bash
# Run all validation checks for the Authenticator project.
# 2026-09-27 modernization (ISSUE-34): covers the v5 surface (server tsc/vitest,
# AGPL identifier gate, dashboard build), scopes functions tests to test:unit
# (bare `npm test` needs Firebase emulators and cannot pass off-CI — same
# decision pr-checks.yml documents), pins JDK 17 for all Gradle tasks
# (JdkImageTransform fails under 21 — verified live), validates the Node major
# against .node-version instead of hardcoding, and fixes the green-exit bug
# (the old last line returned 1 even when everything passed).

set -u

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"
START_TIME=$(date +%s)
PASS=0
FAIL=0

pass() { PASS=$((PASS+1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

echo "============================================"
echo "  Full Validation Suite"
echo "============================================"
echo ""

# Environment gates — wrong toolchain here means every later result lies.
echo "--- Environment ---"
NODE_MAJOR_OK=1
if command -v node >/dev/null 2>&1; then
  REQUIRED_MAJOR="$(cut -d. -f1 .node-version 2>/dev/null || echo '')"
  CURRENT_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo '')"
  if [ -n "$REQUIRED_MAJOR" ] && [ "$CURRENT_MAJOR" != "$REQUIRED_MAJOR" ]; then
    echo "  node $CURRENT_MAJOR != .node-version major $REQUIRED_MAJOR — native modules (better-sqlite3/argon2) will mismatch"
    NODE_MAJOR_OK=0
    fail "node major matches .node-version ($REQUIRED_MAJOR)"
  else
    pass "node major matches .node-version${REQUIRED_MAJOR:+ ($REQUIRED_MAJOR)}"
  fi
else
  NODE_MAJOR_OK=0
  fail "node available on PATH"
fi

# Resolve a JDK 17 for Gradle (CI pins 17; ambient JDK 21 breaks the
# android-34 JdkImageTransform). Respects an already-correct JAVA_HOME.
JDK17=""
jdk_ok() { [ -x "$1/bin/java" ] && "$1/bin/java" -version 2>&1 | grep -q 'version "17'; }
if [ -n "${JAVA_HOME:-}" ] && jdk_ok "$JAVA_HOME"; then
  JDK17="$JAVA_HOME"
else
  if command -v /usr/libexec/java_home >/dev/null 2>&1; then
    CAND="$(/usr/libexec/java_home -v 17 2>/dev/null || true)"
    jdk_ok "$CAND" && JDK17="$CAND"
  fi
  if [ -z "$JDK17" ]; then
    for CAND in /usr/lib/jvm/java-17-openjdk-amd64 /usr/lib/jvm/java-17-openjdk-arm64 /usr/lib/jvm/java-17-openjdk /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home; do
      if jdk_ok "$CAND"; then JDK17="$CAND"; break; fi
    done
  fi
fi
if [ -n "$JDK17" ]; then
  export JAVA_HOME="$JDK17"
  export PATH="$JAVA_HOME/bin:$PATH"
  pass "JDK 17 resolved (${JDK17})"
else
  echo "  no JDK 17 found — set JAVA_HOME to a 17 install (Gradle tasks will be skipped as FAIL)"
  fail "JDK 17 available (set JAVA_HOME)"
fi

# Lint checks
echo ""
echo "--- Lint Checks ---"
echo -n "  ktlint... "
if [ -n "$JDK17" ] && (cd authenticator-app && ./gradlew ktlintCheck > /dev/null 2>&1); then
  pass "ktlint"
else
  fail "ktlint"
fi
if [ "$NODE_MAJOR_OK" = "1" ]; then
  echo -n "  ESLint... "
  (cd functions && npm run lint > /dev/null 2>&1) && pass "ESLint (functions)" || fail "ESLint (functions)"
fi

# Server (v5 core)
echo ""
echo "--- Server (v5) ---"
if [ "$NODE_MAJOR_OK" = "1" ]; then
  echo -n "  tsc --noEmit... "
  (cd server && npx tsc --noEmit > /dev/null 2>&1) && pass "server typecheck" || fail "server typecheck"
  echo -n "  vitest... "
  (cd server && npx vitest run > /dev/null 2>&1) && pass "server tests" || fail "server tests"
fi
echo -n "  AGPL identifier gate... "
bash scripts/agpl-grep.sh > /dev/null 2>&1 && pass "agpl-grep" || fail "agpl-grep"

# Dashboard (v5 SPA)
echo ""
echo "--- Dashboard (v5) ---"
if [ "$NODE_MAJOR_OK" = "1" ]; then
  echo -n "  build (tsc strict + vite)... "
  (cd dashboard && npm ci --silent > /dev/null 2>&1 && npm run build > /dev/null 2>&1) \
    && pass "dashboard build" || fail "dashboard build"
fi

# Security
echo ""
echo "--- Security ---"
echo -n "  Security scan... "
bash tools/security-audit.sh > /dev/null 2>&1 && pass "security-audit" || fail "security-audit"

# Validation
echo ""
echo "--- Validation ---"
echo -n "  Route audit... "
bash tools/route-auditor.sh > /dev/null 2>&1 && pass "route-audit" || echo "  WARN: route-audit (non-fatal)"
echo -n "  Schema check... "
bash tools/schema-checker.sh > /dev/null 2>&1 && pass "schema-check" || echo "  WARN: schema-check (non-fatal)"
echo -n "  Env validation... "
bash tools/env-validator.sh > /dev/null 2>&1 && pass "env-validator" || echo "  WARN: env-validator (non-fatal)"
echo -n "  Dependency analysis... "
bash tools/dependency-analyzer.sh > /dev/null 2>&1 && echo "  INFO: dependency analysis complete"

# Tests
echo ""
echo "--- Tests ---"
if [ "$NODE_MAJOR_OK" = "1" ]; then
  echo -n "  Cloud Functions tests... "
  # test:unit = no-emulator scope (index.test.js). Bare `npm test` needs
  # Firebase emulators and cannot pass off-CI (see pr-checks.yml).
  (cd functions && npm run test:unit > /dev/null 2>&1) && pass "Functions tests (test:unit)" || fail "Functions tests (test:unit)"
fi
echo -n "  Android unit tests... "
if [ -n "$JDK17" ] && (cd authenticator-app && ./gradlew test > /dev/null 2>&1); then
  pass "Android tests"
else
  fail "Android tests"
fi
if [ "$NODE_MAJOR_OK" = "1" ]; then
  echo -n "  E2E tests... "
  (cd e2e && npx playwright test --list > /dev/null 2>&1) && pass "E2E (tests found)" || echo "  WARN: E2E tests not configured"
fi

# Summary
echo ""
echo "============================================"
DURATION=$(( $(date +%s) - START_TIME ))
echo "  Results: $PASS passed, $FAIL failed (${DURATION}s)"
echo "============================================"
# Deliberate if/else: the old `[ $FAIL -gt 0 ] && exit 1` exited 1 even on a
# fully green run (failed test with no else branch).
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
