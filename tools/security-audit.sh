#!/bin/bash
# Security audit: scans Kotlin/JS for common security anti-patterns.

echo "=== Security Audit ==="

echo ""
echo "--- Log.d/v calls (use Log.i/w/e only) ---"
LOG_FINDINGS=$(grep -rn "Log\.d\|Log\.v" --include="*.kt" . 2>/dev/null | grep -v "/build/" | grep -v "/test/" || true)
echo "${LOG_FINDINGS:-  None found (good)}" | head -20

echo ""
echo "--- Non-constant-time comparisons ---"
grep -rn "\.equals\|Arrays\.equals\|===.*challengeToken\|===.*pollToken\|===.*hmac\|===.*signature" --include="*.kt" --include="*.js" --include="*.jsx" . 2>/dev/null | grep -v "/build/" | grep -v "node_modules" | head -10 || echo "  None found"

echo ""
echo "--- Hardcoded credential patterns ---"
for pattern in apiKey API_KEY secret SECRET password PASSWORD credential; do
    FINDINGS=$(grep -rn "\"$pattern\"\s*:" --include="*.kt" --include="*.js" --include="*.json" . 2>/dev/null | grep -v "/build/" | grep -v "node_modules" | grep -v "package.json" | head -5 || true)
    [ -n "$FINDINGS" ] && echo "  $pattern: found" || echo "  $pattern: not found"
done

echo ""
echo "--- BuildConfig secrets (should use EncryptedSharedPreferences) ---"
grep -rn "BuildConfig\.\(VERIFICATION\|AUTHENTICATOR\|ENROLLMENT\)" --include="*.kt" . 2>/dev/null | grep -v "/build/" || echo "  None found (good)"
