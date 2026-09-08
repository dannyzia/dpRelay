#!/usr/bin/env bash
# G7 enforcement (Modification 6 plan): fail if AGPL-derived identifiers from
# the httpSMS audit leak into proprietary code. Docs under
# docs/httpsms vs dprelay/ legitimately mention these names and are excluded.
set -euo pipefail
cd "$(dirname "$0")/.."

PATTERN='com\.httpsms|NdoleStudio|HttpSms|httpsms-go|httpsms-node'
DIRS=(server/src server/test client web/src functions authenticator-app/app/src)

HITS=$(grep -rInE "$PATTERN" "${DIRS[@]}" 2>/dev/null || true)
if [ -n "$HITS" ]; then
  echo "AGPL identifier gate FAILED — remove copied identifiers:"
  echo "$HITS"
  exit 1
fi
echo "AGPL identifier gate: clean"
