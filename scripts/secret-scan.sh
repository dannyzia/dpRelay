#!/usr/bin/env bash
# Secret gate: fail if a credential can reach the index.
#
# Scopes to the git INDEX, not the working tree, because the question is "can
# this be committed", and `git commit` commits the index. A secret staged and
# then edited out of the working tree is still caught; a secret sitting in an
# untracked scratch file is not (that is `.gitignore`'s job, and git already
# refuses it).
#
# Filenames are checked too: a tracked `service-account.json` or `id_rsa` is
# almost always a mistake even when its contents are placeholders, and the
# filename is the thing a reviewer skims past.
#
# Allowlist: scripts/secret-scan-allowlist.txt (globs + required justification).
# An allowlisted path is exempt from BOTH the filename and content rules.
#
# No new dependencies — grep + git only, matching the agpl-grep.sh precedent.
#
# Exit codes:
#   0  clean
#   1  findings (a credential could be committed)
#   2  the gate itself failed to run — NOT a pass. A scan error is treated as
#      loudly as a finding, because a gate that fails open is worse than no
#      gate: it reports "clean" while checking nothing.
set -euo pipefail
cd "$(dirname "$0")/.."

ALLOWLIST="scripts/secret-scan-allowlist.txt"

# --- allowlist-filtered tracked paths -------------------------------------------------
# NUL-delimited so paths with spaces survive.
mapfile -d '' TRACKED < <(
  git ls-files -z | node scripts/filter-allowlist.cjs "$ALLOWLIST"
)
if [ "${#TRACKED[@]}" -eq 0 ]; then
  echo "secret gate: nothing to scan (no tracked files outside the allowlist)"
  exit 0
fi

FAILED=0

# Runs git grep and refuses to treat its own failure as a clean pass.
# git grep exits 1 for "no matches" (fine) and >1 for a real error (not fine).
# `-e` is mandatory, not stylistic: a pattern starting with "-" is parsed as an
# option otherwise, and the secret rules here begin with "-----BEGIN".
grep_index() { # <label> <regex> [skip-regex]
  # The optional third argument drops candidate lines whose ENTIRE match sits
  # on a line also matching a known-fixture idiom (rule 2c). It filters LINES,
  # not files: no class here can exempt a whole path the way the allowlist can,
  # so a real credential still trips the rule unless it wears a fixture costume.
  # Case-insensitive because fixtures spell their markers in every case.
  local label="$1" regex="$2" skip="${3-}" out rc
  set +e
  out=$(git grep -I -n -E -e "$regex" -- "${TRACKED[@]}" 2>&1)
  rc=$?
  set -e
  if [ "$rc" -gt 1 ]; then
    echo "secret gate ERROR — the content scan did not run (git grep rc=$rc)."
    echo "This is NOT a pass. Fix the gate before trusting its verdict."
    printf '%s\n' "$out" | head -5 | sed 's/^/  /'
    exit 2
  fi
  if [ -n "$out" ] && [ -n "$skip" ]; then
    out=$(printf '%s\n' "$out" | grep -viE -e "$skip" || true)
  fi
  if [ -n "$out" ]; then
    echo "secret gate FAILED — $label:"
    # Truncate the matched line: the point is to name the file and the rule,
    # never to echo a credential into a CI log.
    printf '%s\n' "$out" | cut -c1-160 | sed 's/^/  /'
    FAILED=1
  fi
}

# --- 1. Credential-shaped filenames ---------------------------------------------------
NAME_RE='(^|/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$'
NAME_RE+='|(^|/)[^/]*service[-_]account[^/]*\.json$'
NAME_RE+='|(^|/)[^/]*-firebase-adminsdk-[^/]*\.json$'
NAME_RE+='|(^|/)[^/]*(credentials?|secrets?)[^/]*\.(json|ya?ml|txt)$'
NAME_RE+='|\.(pem|key|p12|pfx|jks|keystore)$'
NAME_RE+='|(^|/)\.env$'
NAME_RE+='|(^|/)\.env\.(local|production|prod|dev|development)$'

# .env.example / .env.sample / .env.template are documentation, not secrets.
NAME_HITS=$(printf '%s\n' "${TRACKED[@]}" | grep -E -e "$NAME_RE" \
  | grep -vE -e '\.env\.(example|sample|template)$' || true)
if [ -n "$NAME_HITS" ]; then
  echo "secret gate FAILED — credential-shaped filenames are tracked:"
  printf '%s\n' "$NAME_HITS" | sed 's/^/  /'
  FAILED=1
fi

# --- 2. High-confidence secret material ------------------------------------------------
# Each pattern is specific enough that a match is a defect, not a guess: real
# key formats with fixed prefixes, or PEM headers. Deliberately does NOT try to
# detect "any high-entropy string" — that false-positives on hashes, ids and
# fixtures, and a gate people disable is a gate that is off.
#
# No \b word boundaries: git grep's regex engine does not reliably support them,
# and the prefixes below are distinctive enough without them.
SECRET_RE='-----BEGIN ([A-Z]+ )?PRIVATE KEY-----'
SECRET_RE+='|"private_key"[[:space:]]*:[[:space:]]*"-----BEGIN'
SECRET_RE+='|AIza[0-9A-Za-z_-]{35}'
SECRET_RE+='|gh[pousr]_[A-Za-z0-9]{36,}'
SECRET_RE+='|github_pat_[A-Za-z0-9_]{22,}'
SECRET_RE+='|xox[baprs]-[A-Za-z0-9-]{10,}'
SECRET_RE+='|AKIA[0-9A-Z]{16}'
SECRET_RE+='|rnd_[A-Za-z0-9]{20,}'
SECRET_RE+='|sk_live_[0-9a-zA-Z]{16,}'
SECRET_RE+='|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'

grep_index "secret-shaped content in tracked files" "$SECRET_RE"

# --- 2b. Credentials embedded in URL userinfo -------------------------------------
# scheme://user:pass@host — the credential hides in plain sight inside an
# ordinary-looking URL, so no key-format prefix gives it away and rule 2 can
# never see it (ISSUE-102: this shape slipped past the gate in an e2e spec).
# The colon between user and pass is mandatory: without it the "userinfo" is
# just a username, and requiring it keeps port numbers (localhost:5173) and
# bare email-ish URLs from tripping the rule — verified against the full
# tracked tree before this rule shipped.
USERINFO_RE='[a-zA-Z][a-zA-Z0-9+.-]*://[^/[:space:]@]+:[^/[:space:]@]+@'
grep_index "credentials embedded in URL userinfo (user:pass@host)" "$USERINFO_RE"

# --- 2c. Plaintext credential constants -------------------------------------------------
# ISSUE-102's incident shape: `const ADMIN_PASSWORD = "..."` committed in an
# e2e spec. No key-format prefix and no URL, so rules 2 and 2b are blind to it;
# the only signal is the NAME screaming that the value is a credential.
#
# Candidate: a SCREAMING_CASE name containing PASSWORD/SECRET/TOKEN bound to a
# quoted value of >=6 chars. A naive version of this rule flagged 84 lines on
# the tracked tree — so the skip regex carves out exactly the fixture idioms
# this repo uses by convention, each class verified against the full tree:
#   1. values with no digit — prose placeholders ("dev-enroll-value"), not
#      generated credentials;
#   2. names ending _KEY — storage-key identifiers ("webv5.appSecret");
#   3. values truncated with "..." — documentation placeholders;
#   4. fixture markers in the value (test/fake/0123456789abcdef/correct-horse…)
#      — the synthetic secrets this suite mints by convention;
#   5. fixture role prefixes on the name (TEST_JWT_SECRET, FAKE_TOKEN, …).
# Measured result: zero lines on master trip this rule, while mod4's
# `ADMIN_PASSWORD = "@DELL123dell#"` still trips it. A skip can hide a real
# credential — that is the accepted cost of any non-firing rule — so each
# class is a documented convention, never a path exemption; anything novel
# gets an allowlist entry with a reason instead of a wider skip.
# Both quote chars in one variable: inside double quotes ' is literal and "
# needs one backslash — far harder to mis-nest than the '\'' idiom (an early
# version of this block was one "'" pair short and failed bash -n loudly,
# which is exactly how it should fail).
QUOTE="\"'"
PASSCONST_RE="[A-Z0-9_]*(PASSWORD|SECRET|TOKEN)[A-Z0-9_]*[[:space:]]*=[[:space:]]*[${QUOTE}][^${QUOTE}]{6,}[${QUOTE}]"
PASSCONST_SKIP="(PASSWORD|SECRET|TOKEN)[A-Z0-9_]*[[:space:]]*=[[:space:]]*[${QUOTE}][^${QUOTE}0-9]*[${QUOTE}]"
PASSCONST_SKIP+="|(PASSWORD|SECRET|TOKEN)[A-Z0-9_]*_KEY[[:space:]]*="
PASSCONST_SKIP+="|(PASSWORD|SECRET|TOKEN)[A-Z0-9_]*[[:space:]]*=[[:space:]]*[${QUOTE}][^${QUOTE}]*\.\.\.[${QUOTE}]"
PASSCONST_SKIP+="|(PASSWORD|SECRET|TOKEN)[A-Z0-9_]*[[:space:]]*=[[:space:]]*[${QUOTE}][^${QUOTE}]*(test|fake|mock|sample|placeholder|do-not-use|not-a-credential|0123456789abcdef|correct-horse)[^${QUOTE}]*[${QUOTE}]"
PASSCONST_SKIP+="|(TEST|FAKE|MOCK|DUMMY|SAMPLE|EXAMPLE|KEY|PLACEHOLDER)[A-Z0-9_]*(PASSWORD|SECRET|TOKEN)"
grep_index "plaintext password/secret/token constant" "$PASSCONST_RE" "$PASSCONST_SKIP"

# --- 3. Entropy backstop ----------------------------------------------------------------
# A PEM header can be stripped or reformatted. A >=512-char run of base64 with
# no spaces is almost never prose and almost always key material.
if [ "$FAILED" -eq 0 ]; then
  grep_index "long base64 run (possible key material)" '[A-Za-z0-9+/]{512,}={0,2}'
fi

if [ "$FAILED" -ne 0 ]; then
  echo ""
  echo "If a finding is a false positive, allowlist the exact path in"
  echo "$ALLOWLIST with a reason. Do not widen the patterns above."
  exit 1
fi

echo "secret gate: clean (${#TRACKED[@]} tracked file(s) scanned)"