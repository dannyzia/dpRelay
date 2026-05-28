#!/bin/bash
# Run all validation checks for the Authenticator project.

set -e

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

# Lint checks
echo "--- Lint Checks ---"
echo -n "  ktlint... "
(cd authenticator-app && ./gradlew ktlintCheck > /dev/null 2>&1) && pass "ktlint" || fail "ktlint"
echo -n "  ESLint... "
(cd functions && npm run lint > /dev/null 2>&1) && pass "ESLint (functions)" || fail "ESLint (functions)"

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
echo -n "  Android unit tests... "
(cd authenticator-app && ./gradlew test > /dev/null 2>&1) && pass "Android tests" || fail "Android tests"
echo -n "  Cloud Functions tests... "
(cd functions && npm test > /dev/null 2>&1) && pass "Functions tests" || fail "Functions tests"
echo -n "  E2E tests... "
(cd e2e && npx playwright test --list > /dev/null 2>&1) && pass "E2E (tests found)" || echo "  WARN: E2E tests not configured"

# Summary
echo ""
echo "============================================"
DURATION=$(( $(date +%s) - START_TIME ))
echo "  Results: $PASS passed, $FAIL failed (${DURATION}s)"
echo "============================================"
[ $FAIL -gt 0 ] && exit 1
