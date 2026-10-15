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

# Resolve the Node this repo targets BEFORE judging it.
#
# A git hook runs in a non-login, non-interactive shell, so nvm's PATH shim is
# never sourced and `node` falls back to whatever the system ships (18.x) or to
# an unrelated nvm default (22.x). server/node_modules/better-sqlite3 is built
# for exactly one NODE_MODULE_VERSION, so the wrong Node makes every DB-backed
# test die with "Module did not self-register" — 383 failures that read as
# broken code and are only a PATH problem. Resolving here is what makes this
# gate mean something during `git push`, not just in a shell someone remembered
# to `nvm use` in first.
#
# `.nvmrc` is tracked and authoritative (20.9.0). The repo root's `.node-version`
# is an untracked EMPTY stray file, and `server/.node-version` only helps
# someone already sitting inside server/ — so all three are consulted in order
# and the first one that actually carries a version wins.
REQUIRED_MAJOR=""
REQUIRED_VERSION=""
NODE_VERSION_SOURCE=""
for VF in .nvmrc .node-version server/.node-version; do
  [ -f "$VF" ] || continue
  CAND="$(tr -d '[:space:]' < "$VF" 2>/dev/null || true)"
  [ -n "$CAND" ] || continue
  REQUIRED_MAJOR="$(printf '%s' "$CAND" | cut -d. -f1)"
  REQUIRED_VERSION="$CAND"
  NODE_VERSION_SOURCE="$VF"
  break
done

# Ask nvm for the binary in an isolated subshell rather than sourcing nvm.sh
# here: this script runs under `set -u`, and an nvm release that touches an
# unset variable would abort the whole suite mid-run instead of merely failing
# one check. No PATH edit survives a subshell, so the bin dir is prepended
# explicitly — guarded by a -d test so a missing version degrades to the clear
# mismatch message below instead of silently running the wrong Node.
if [ -n "$REQUIRED_VERSION" ] && [ -f "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  NVMBIN="$(NVM_DIR="${NVM_DIR:-$HOME/.nvm}" bash -c \
    '. "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || exit 1; nvm which "$1" 2>/dev/null' \
    nvm-which "$REQUIRED_VERSION" 2>/dev/null || true)"
  NVMDIR="$(dirname "$NVMBIN" 2>/dev/null || true)"
  if [ -n "$NVMBIN" ] && [ -d "$NVMDIR" ]; then
    PATH="$NVMDIR:$PATH"
    export PATH
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  NODE_MAJOR_OK=0
  fail "node available on PATH"
elif [ -z "$NODE_VERSION_SOURCE" ]; then
  # Fatal on purpose, not a pass. The previous check read ONLY the repo root's
  # .node-version and fell through to `pass` when that file was empty or absent
  # — which is exactly how an empty stray file let Node 18 drive a Node 20 tree
  # while printing a green "node major matches".
  NODE_MAJOR_OK=0
  fail "node version source (.nvmrc / .node-version) — nothing to validate against"
else
  CURRENT_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo '')"
  if [ "$CURRENT_MAJOR" != "$REQUIRED_MAJOR" ]; then
    echo "  node $CURRENT_MAJOR != $NODE_VERSION_SOURCE major $REQUIRED_MAJOR — native modules (better-sqlite3/argon2) will mismatch"
    NODE_MAJOR_OK=0
    fail "node major matches $NODE_VERSION_SOURCE ($REQUIRED_MAJOR)"
  else
    pass "node major matches $NODE_VERSION_SOURCE ($REQUIRED_MAJOR, $(node -v 2>/dev/null || echo '?'))"
  fi
fi

# Install the tracked pre-commit hook. `core.hooksPath` is repo-LOCAL config and
# cannot be committed, so without this a fresh clone silently runs no hook at
# all until someone remembers the one-liner. Idempotent, and never fatal: it is
# a convenience for whoever just cloned, not a correctness check, so a non-git
# directory or an absent hook is skipped rather than failed.
#
# Two things the original version did not do, both deliberate:
#
#   - It reported the condition BEFORE fixing it. Auto-setting silently and then
#     printing PASS hid the fact that this clone's secret gate was never wired
#     up, which is the exact gap the block exists to close.
#   - It read the config back instead of assuming the write worked. `git config`
#     can fail without a non-zero exit being visible here (protected config,
#     safe.directory, a read-only repo), and a PASS in that case would be a lie
#     about the pre-commit secret gate rather than a green check.
#
# The warning is gated on the hook being TRACKED, not merely on disk: an
# untracked .githooks/pre-commit is a local file that no clone will ever
# receive, so nothing is lost by leaving core.hooksPath alone for it — the hook
# would not exist elsewhere to run.
if git rev-parse --git-dir >/dev/null 2>&1 && [ -f .githooks/pre-commit ]; then
  CURRENT_HOOKS_PATH="$(git config --get core.hooksPath || echo '')"
  # `git ls-files --` prints the path when it is in the index (staged or
  # committed) and nothing at all otherwise, so a non-empty result means tracked.
  HOOK_TRACKED=""
  if [ -n "$(git ls-files -- .githooks/pre-commit 2>/dev/null)" ]; then
    HOOK_TRACKED="yes"
  fi

  # Report the condition first, while it is still observable. Once the write
  # below has run, `git config --get` no longer returns empty and the state that
  # prompted this message is gone — which is how the original version managed to
  # hide the very gap it existed to close.
  if [ -z "$CURRENT_HOOKS_PATH" ] && [ -n "$HOOK_TRACKED" ]; then
    echo "  WARN: core.hooksPath is unset while .githooks/pre-commit is tracked — no pre-commit secret gate would run until it is configured"
  fi

  # Unchanged from before: correct ANY value that is not exactly .githooks, not
  # only an unset one, so a hook path pointing elsewhere still gets redirected.
  if [ "$CURRENT_HOOKS_PATH" != ".githooks" ]; then
    git config core.hooksPath .githooks
  fi

  # Read back rather than assume. `git config` writes can be refused (protected
  # config, safe.directory, a read-only repo) and a PASS there would be a lie
  # about the pre-commit secret gate.
  if [ "$(git config --get core.hooksPath || echo '')" = ".githooks" ]; then
    pass "git hooksPath -> .githooks (pre-commit secret gate active)"
  else
    fail "git hooksPath -> .githooks (config did not take; run: git config core.hooksPath .githooks)"
  fi
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
echo -n "  ktlint (payment-reader)... "
if [ -n "$JDK17" ] && (cd payment-reader && ./gradlew ktlintCheck > /dev/null 2>&1); then
  pass "ktlint (payment-reader)"
else
  fail "ktlint (payment-reader)"
fi
if [ "$NODE_MAJOR_OK" = "1" ]; then
  if [ -f functions/package.json ]; then
    echo -n "  ESLint... "
    (cd functions && npm run lint > /dev/null 2>&1) && pass "ESLint (functions)" || fail "ESLint (functions)"
  else
    # v4 Firebase plane removed at decommission (06980de, owner-approved):
    # nothing left to lint — an explicit skip, not a pass and not a failure.
    echo "  SKIP: ESLint (functions) — functions/ plane decommissioned"
  fi
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
echo -n "  secret gate... "
# Unlike agpl-grep, the secret gate's output is surfaced on failure: "a secret
# was found" is useless without knowing WHICH rule and WHICH file tripped.
SECRET_SCAN_OUT=$(bash scripts/secret-scan.sh 2>&1) && pass "secret-scan" || {
  fail "secret-scan"
  printf '%s\n' "$SECRET_SCAN_OUT" | sed 's/^/    /'
}

# Dashboard (v5 SPA)
echo ""
echo "--- Dashboard (v5) ---"
if [ "$NODE_MAJOR_OK" = "1" ]; then
  echo -n "  build (tsc strict + vite)... "
  (cd dashboard && npm ci --silent > /dev/null 2>&1 && npm run build > /dev/null 2>&1) \
    && pass "dashboard build" || fail "dashboard build"
fi

# Client SDK + v5 SPA (ISSUE-117): local parity with the pr-checks gates —
# typecheck + test + build for each tree, pinned to the committed lockfile.
# (ISSUE-116's "16 passed" count predates these two checks; expect 18.)
echo ""
echo "--- Client SDK + Web v5 ---"
if [ "$NODE_MAJOR_OK" = "1" ]; then
  echo -n "  client-node (typecheck + test + build)... "
  (cd client-node && npm ci --silent > /dev/null 2>&1 && npm run typecheck > /dev/null 2>&1 && npm test > /dev/null 2>&1 && npm run build > /dev/null 2>&1) && pass "client-node (typecheck + test + build)" || fail "client-node (typecheck + test + build)"
  echo -n "  web-v5 (typecheck + test + build)... "
  (cd web-v5 && npm ci --silent > /dev/null 2>&1 && npm run typecheck > /dev/null 2>&1 && npm test > /dev/null 2>&1 && npm run build > /dev/null 2>&1) && pass "web-v5 (typecheck + test + build)" || fail "web-v5 (typecheck + test + build)"
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
  if [ -f functions/package.json ]; then
    (cd functions && npm run test:unit > /dev/null 2>&1) && pass "Functions tests (test:unit)" || fail "Functions tests (test:unit)"
  else
    # v4 plane decommissioned (06980de): no functions tests exist to run.
    echo "  SKIP: Functions tests — functions/ plane decommissioned"
  fi
fi
echo -n "  Android unit tests... "
if [ -n "$JDK17" ] && (cd authenticator-app && ./gradlew test > /dev/null 2>&1); then
  pass "Android tests"
else
  fail "Android tests"
fi
echo -n "  Payment Reader tests... "
if [ -n "$JDK17" ] && (cd payment-reader && ./gradlew test > /dev/null 2>&1); then
  pass "Payment Reader tests"
else
  fail "Payment Reader tests"
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
