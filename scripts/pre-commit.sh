#!/bin/bash
# Pre-commit hook for Authenticator project
# Runs linters, security audits, schema checks, and unit tests

set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

echo "=== Pre-Commit Checks ==="

# Run ktlint
echo "[1/6] Running ktlint..."
cd authenticator-app
./gradlew ktlintCheck || exit 1
cd "$PROJECT_DIR"

# Route audit (warn only, not blocking)
echo "[2/6] Running route audit..."
bash tools/route-auditor.sh || true

# Schema check (warn only, not blocking)
echo "[3/6] Running schema check..."
bash tools/schema-checker.sh || true

# Security audit
echo "[4/6] Running security audit..."
bash tools/security-audit.sh || exit 1

# Android unit tests
echo "[5/6] Running Android unit tests..."
cd authenticator-app
./gradlew test || exit 1
cd "$PROJECT_DIR"

# Cloud Functions tests
echo "[6/6] Running Cloud Functions tests..."
cd functions
npm test || exit 1
cd "$PROJECT_DIR"

echo "All pre-commit checks passed!"
