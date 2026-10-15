#!/usr/bin/env bash
# G7 enforcement (Modification 6 plan): fail if AGPL-derived identifiers from
# the httpSMS audit leak into proprietary code. Docs under
# docs/httpsms vs dprelay/ legitimately mention these names and are excluded.
set -euo pipefail
cd "$(dirname "$0")/.."

PATTERN='com\.httpsms|NdoleStudio|HttpSms|httpsms-go|httpsms-node'
# ISSUE-116: covers the v5 dashboard SPA (web-v5), the Node SDK (client-node)
# and the Payment Reader app. Legacy web/src dropped — dead tree since #23,
# superseded by web-v5/, unreferenced by every workflow and script.
DIRS=(server/src server/test server/scripts client client-node/src client-node/test web-v5/src web-v5/test dashboard payment-reader authenticator-app/app/src)

HITS=$(grep -rInE "$PATTERN" "${DIRS[@]}" 2>/dev/null || true)
if [ -n "$HITS" ]; then
  echo "AGPL identifier gate FAILED — remove copied identifiers:"
  echo "$HITS"
  exit 1
fi
echo "AGPL identifier gate: clean"
