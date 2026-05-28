#!/bin/bash
# Schema checker: compares database.rules.json paths against functions/index.js RTDB references.

DB_RULES="database.rules.json"
FUNCTIONS_FILE="functions/index.js"

if [ ! -f "$DB_RULES" ]; then
    echo "ERROR: $DB_RULES not found"; exit 1
fi
if [ ! -f "$FUNCTIONS_FILE" ]; then
    echo "ERROR: $FUNCTIONS_FILE not found"; exit 1
fi

echo "=== RTDB Paths in database.rules.json ==="
DB_PATHS=$(grep -oP '^\s+"[a-z_]+":\s*\{' "$DB_RULES" | grep -oP '"[a-z_]+"' | tr -d '"' | sort)
echo "$DB_PATHS" | while read -r path; do echo "  /$path"; done

echo ""
echo "=== RTDB References in functions/index.js ==="
FUNCTIONS_REFS=$(grep -oP "ref\([^)]+\)|child\([^)]+\)" "$FUNCTIONS_FILE" | grep -oP '["'"'"'][a-z_/]+["'"'"']' | tr -d '"' | sort -u)
echo "$FUNCTIONS_REFS" | while read -r ref; do echo "  $ref"; done

echo ""
echo "=== Mismatches ==="
FUNCTIONS_TOP=$(echo "$FUNCTIONS_REFS" | grep -v "^/" | cut -d'/' -f1 | sort -u)
while IFS= read -r ref; do
    [ -z "$ref" ] && continue
    if ! echo "$DB_PATHS" | grep -q "^${ref}$"; then
        echo "  WARNING: '$ref' used in functions but not defined in database.rules.json"
    fi
done <<< "$FUNCTIONS_TOP"
