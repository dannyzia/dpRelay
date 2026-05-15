#!/bin/bash
# Pre-commit hook for Authenticator project
# Runs ktlint, unit tests, and function tests before allowing commit

set -e

echo "Running pre-commit checks..."

# Run ktlint
echo "Running ktlint..."
cd authenticator-app
./gradlew ktlintCheck || exit 1

# Run unit tests
echo "Running Android unit tests..."
./gradlew test || exit 1

# Run function tests
echo "Running Cloud Functions tests..."
cd ../functions
npm test || exit 1

echo "All pre-commit checks passed!"
