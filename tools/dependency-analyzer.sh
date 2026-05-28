#!/bin/bash
# Dependency analyzer: checks package.json and build.gradle for version consistency.

echo "=== Cloud Functions Dependencies ==="
[ -f "functions/package.json" ] && grep -A 100 '"dependencies"' functions/package.json | grep -m 20 ':' | grep -v '"dependencies"' || echo "  (not found)"

echo ""
echo "=== Web Dashboard Dependencies ==="
[ -f "web/package.json" ] && grep -A 100 '"dependencies"' web/package.json | grep -m 30 ':' | grep -v '"dependencies"' || echo "  (not found)"

echo ""
echo "=== Android Dependencies ==="
[ -f "authenticator-app/app/build.gradle" ] && grep "implementation\|testImplementation" authenticator-app/app/build.gradle | head -30 || echo "  (not found)"

echo ""
echo "=== Cross-Package Firebase Version Check ==="
FUNCTIONS_FB=$(grep -oP '"firebase-admin": "[^"]*"' functions/package.json 2>/dev/null)
WEB_FB=$(grep -oP '"firebase": "[^"]*"' web/package.json 2>/dev/null)
echo "  Functions: $FUNCTIONS_FB"
echo "  Web: $WEB_FB"
