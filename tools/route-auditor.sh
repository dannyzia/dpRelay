#!/bin/bash
# Route auditor: scans Cloud Functions and web frontend for endpoint definitions.

FUNCTIONS_FILE="functions/index.js"
WEB_APP="web/src/App.jsx"
DOCS_API="docs/Plan/06-API.md"

echo "=== Cloud Functions Routes ==="
if [ -f "$FUNCTIONS_FILE" ]; then
    grep -n "exports\." "$FUNCTIONS_FILE" | grep -oP "exports\.\w+" | sort | while read -r fn; do
        echo "  $fn"
    done
else
    echo "  (functions/index.js not found)"
fi

echo ""
echo "=== Web Frontend Routes ==="
if [ -f "$WEB_APP" ]; then
    grep -n "path=" "$WEB_APP" | grep -oP 'path="[^"]*"' | sort | while read -r route; do
        echo "  $route"
    done
else
    echo "  (web/src/App.jsx not found)"
fi

echo ""
echo "=== Documented API Endpoints (from docs/Plan/06-API.md) ==="
if [ -f "$DOCS_API" ]; then
    grep -n "POST\|GET\|PUT\|DELETE\|/v4/\|/health" "$DOCS_API" | head -20 | while read -r line; do
        echo "  $line"
    done
else
    echo "  (docs/Plan/06-API.md not found)"
fi

echo ""
echo "Review for undocumented or orphaned endpoints."
