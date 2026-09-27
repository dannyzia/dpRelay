#!/bin/sh
# Post-deploy smoke for the Cloudflare Pages dashboard (ISSUE-30).
# Mirrors the server deploy-status guard philosophy: a deploy is not "done"
# when the upload returns success — it is done when the SPA verifiably serves.
#
# Usage: pages-smoke.sh URL [URL ...]
#   URL 1: the per-deployment URL from wrangler (checked briefly)
#   URL 2: the production alias https://<project>.pages.dev (full retry
#          budget — the new deployment is still propagating to the alias)
# Env:
#   PAGES_SMOKE_MARKER     content asserted in the served page
#                          (default: the SPA mount marker from dashboard/index.html;
#                          both id="root" and the title survive vite's minification)
#   PAGES_SMOKE_TRIES      attempts per URL (default 10)
#   PAGES_SMOKE_SLEEP_SEC  seconds between attempts (default 12 → ~2 min budget)
# Exits 1 (with a GitHub Actions ::error:: annotation) on failure.
set -u

MARKER="${PAGES_SMOKE_MARKER:-<div id=\"root\">}"
TRIES="${PAGES_SMOKE_TRIES:-10}"
SLEEP_SEC="${PAGES_SMOKE_SLEEP_SEC:-12}"
TMP="$(mktemp)"

trap 'rm -f "$TMP"' EXIT

if [ "$#" -eq 0 ]; then
  echo "::error::pages-smoke: no URL supplied"
  exit 1
fi

for url in "$@"; do
  i=1
  while [ "$i" -le "$TRIES" ]; do
    status="$(curl -s -o "$TMP" -w '%{http_code}' --max-time 15 "$url" || echo 000)"
    if [ "$status" = "200" ] && grep -qF "$MARKER" "$TMP"; then
      echo "pages-smoke: OK — $url serves the SPA (attempt $i)"
      break
    fi
    echo "pages-smoke: attempt $i/$TRIES for $url → HTTP $status (waiting for deploy to settle)"
    i=$((i + 1))
    [ "$i" -le "$TRIES" ] && sleep "$SLEEP_SEC"
  done
  if [ "$i" -gt "$TRIES" ]; then
    echo "::error::pages-smoke: $url did not serve HTTP 200 with the SPA marker within budget ($TRIES tries x ${SLEEP_SEC}s)"
    exit 1
  fi
done

echo "pages-smoke: all URLs verified"
