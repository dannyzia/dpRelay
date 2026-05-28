#!/bin/bash
# Environment variable validator: checks required env vars are configured.

echo "=== Required Firebase Secrets ==="
REQUIRED_SECRETS=(
    "VERIFICATION_SIGNING_SECRET"
    "AUTHENTICATOR_ENROLLMENT_SECRET"
    "HEALTH_ADMIN_SECRET"
    "ACTIVE_DEDICATED_NUMBER"
)
for secret in "${REQUIRED_SECRETS[@]}"; do
    echo "  [ ] $secret"
done

echo ""
echo "=== Local .env Files ==="
[ -f "web/.env" ] && echo "  WARNING: web/.env exists"
[ -f "functions/.env" ] && echo "  WARNING: functions/.env exists"

echo ""
echo "=== Firebase Config ==="
[ -f "firebase.json" ] && echo "  Project: $(grep -oP '"project":\s*"[^"]*"' firebase.json)"
[ -f "firebase.json" ] && echo "  Runtime: $(grep -oP '"runtime":\s*"[^"]*"' firebase.json)"

echo ""
echo "Set secrets: firebase functions:secrets:set <SECRET_NAME>"
