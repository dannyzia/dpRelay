# End-to-end suites

Two Playwright suites live under this directory, and they deliberately do not
run the same way.

## CI suite (every PR, no credentials)

Specs directly in `e2e/*.spec.*` are run by the `dashboard-e2e` job in
`.github/workflows/pr-checks.yml` as plain `npx playwright test` from the repo
root, using the root [playwright.config.ts](../playwright.config.ts). That job
boots its OWN throwaway API server and dashboard dev server on loopback and
sets `DASHBOARD_URL` to them, so nothing in this suite can reach a shared
environment.

## Manual production-origin gate (STAGE F12 / ISSUE-121)

`e2e/production/customer-login.spec.ts` drives the real customer origin
(`https://app.dprelay.digital-papyrus.com`) against the real API
(`https://api.dprelay.digital-papyrus.com`). It creates a real account and
spends the production per-IP auth rate budget, so it is **never** wired into CI:

- the root config excludes it (`testIgnore: ["**/production/**"]`), and
- it only runs through its own config, `playwright.production.config.ts`.

Run it in two passes — the first pass registers the account, the second pass
completes the verify-email flip once you have the token out of that mailbox:

```bash
# Pass 1 — register → signed-in #/apps → session cookie present and sent →
# verify-email gate shown → logout → /me 401
export E2E_EMAIL=f12-check@example.com     # fresh throwaway address
export E2E_PASSWORD                        # paste a 10+ char throwaway
npx playwright test --config playwright.production.config.ts

# Pass 2 — paste the token from …/#/verify/<token> in that message:
export E2E_VERIFY_TOKEN
npx playwright test --config playwright.production.config.ts
```

The account values live in your shell for the duration of the run and are
deliberately never written down in this repository (the secret gate enforces
exactly that, and it greps these docs too).

Pass 1 is repeatable with the same address: an already-registered account
falls back to sign-in instead of failing, and the gate assertion follows the
account's real verification state.

Optional overrides: `DASHBOARD_URL` (a staging build of the same SPA) and
`API_URL` (the API that build should call) — both default to production.

If either variable is missing the tests report themselves as **skipped** with
the reason, rather than failing — a skipped manual gate must never be mistaken
for a green one.
