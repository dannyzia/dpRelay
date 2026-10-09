# web-v5 — dP Relay dashboard

React 18 + Vite 5 + TypeScript SPA. Hash routing (deep links work on any
static host without rewrite rules), zero state-management dependencies, tests
in vitest's **node** environment via `react-dom/server` (no jsdom).

Run: `npm ci && npm run typecheck && npm test && npx vite build`.

## Architecture map (directory law — ISSUE-91)

| Directory | Holds | Rule |
| --- | --- | --- |
| `src/api/` | the ONE typed client (`index.ts`) | no raw `fetch(` anywhere else; one exported function per endpoint; screens never hand-build URLs |
| `src/screens/` | one route component per file | each screen = **container** (state + handlers, calls the client) + **pure view** (`XView`, props → JSX, exported for tests) |
| `src/components/` | reusable, props-typed pieces | `Shell` (landmarks + nav), `ErrorBanner` (announced errors) |
| `src/hooks/` | React hooks | `useRoute` (hash state) |
| `src/lib/` | pure logic, no React components | `router.ts` (parseHash/hrefFor), `routes.ts` (NAV table + known sections), `format.ts` (deterministic display helpers) |
| `src/styles.css` | ALL shared tokens + utility classes | no inline `style=` except computed values; static margins use `.mt-6/.mt-14/.mt-18` |

### Routes: hash → screen → API calls

| Hash | Screen (container → view) | API calls |
| --- | --- | --- |
| `#` / unknown | redirect → `#/login`, `#/apps` or `#/credits` per session | — |
| `#/login` | `Login` → `LoginView` | `registerAccount`, `loginAccount`, `getCurrentUser` |
| `#/apps` | `Apps` → `AppsView` | `listOwnedApps`, `listCompanies`, `getWallet`, `getWalletTransactions`, `getMailStatus`, `resendVerification`, `createCompany`, `renameCompany`, `disableCompany` |
| `#/link/:appId` | `LinkApp` → `LinkAppView` | `linkOwnedApp`, `connectApp` (client-side storage) |
| `#/credits` | `Credits` → `CreditsView` | `getCredits` |
| `#/buy` | `BuyCredits` → `PackageListView`/`CheckoutView` | `listPackages`, `requestWalletCredits`, `submitWalletTrx` |
| `#/bulk` | `Bulk` → `BulkView` | `previewBulkCsv`, `createBulkCampaign` |
| `#/history` | `History` → `HistoryView` | `listTransactions` |
| `#/credentials` | `Credentials` → `CredentialsView` | none (session storage + `effectiveApiBase()`) |
| `#/docs` | `Docs` | none (static) |
| `#/faq` | `Faq` → `FaqView` | none (static) |
| `#/payment` | `Payment` → `PaymentView` | none (static) |
| `#/forgot` | `ForgotPassword` → `ForgotPasswordView` | `getMailStatus`, `forgotPassword` |
| `#/reset/:token` | `ResetPassword` → `ResetPasswordView` | `resetPassword` |
| `#/verify/:token` | `VerifyEmail` → `VerifyEmailView` | `verifyEmail` |
| `#/operator` | `Operator` (unlock gate → sub-tab) | `operatorFetch` → `/v5/admin/*` |

Operator sub-tabs (`#/operator/<tab>`, table in `screens/Operator.tsx`):
`billing` (Billing queue), `payments`, `packages`, `users`, `reports`,
`settings`, `apps`, `devices`, `metrics`, `campaigns`, `mail` (Mail Settings).
The nav itself is rendered **from** `src/lib/routes.ts` —
`test/standards.test.tsx` asserts the rendered nav equals that table (zero
dead links, every href round-trips through `parseHash`).

## Session model (three planes, deliberately separate)

1. **User session** — HttpOnly cookie (`dp_session`). Probed once on mount
   with `getCurrentUser()`; JS never reads the cookie.
2. **App credentials** — `X-App-Id`/`X-App-Secret` in **sessionStorage**
   (per tab, never persisted): `connectApp`/`disconnectApp`; a 401 drops the
   tab back to sign-in via `setAppUnauthorizedHandler`.
3. **Operator secret** — `OPERATOR_SECRET` in sessionStorage, attached by
   `operatorFetch`; a 401 clears it and returns to the unlock form via
   `setOperatorRejectedHandler`.

The session cookie identifies the **user**; the app secret authorizes the
**app**; the operator secret unlocks the **admin plane**. Never collapse them.

## Cross-screen flows

- **First run**: `#/login` (signup) → `#/apps` → create a company (shows the
  one-time app secret) → company row connects the app → `#/credits`.
- **Buy**: `#/credits` → `#/buy` → pick package → bKash send-money → paste
  TrxID (`submitWalletTrx`) → operator approves → balance updates.
- **Email links**: verify (`#/verify/:token`), forgot → reset
  (`#/reset/:token`) — all reachable signed-out.
- **Operator**: `#/operator` → unlock → sub-tab; Lock clears the secret.

## Add a screen (recipe)

1. `src/screens/X.tsx`: export `XView` (pure, props → JSX, JSDoc'd) and `X`
   (container: `useState` + client calls, returns the view — no business
   logic inside JSX).
2. Add the client function in `src/api/index.ts` (typed request; never
   `fetch(` in a screen).
3. Register the route: add a `NavItem` in `src/lib/routes.ts` (if it belongs
   in the nav) and wire the dispatch branch in `src/App.tsx`.
4. Markup rules: `<label htmlFor>` for every control, `aria-label` on
   icon-only buttons, `ErrorBanner` for errors (+ `aria-describedby="form-error"`
   on the form's inputs while shown), no inline styles, tokens/classes only.
5. Tests: view assertions in `test/screens.test.tsx`, and add the screen to
   the render list in `test/standards.test.tsx` so the label/button checks
   cover it.
6. Gate: `npx tsc --noEmit && npx vitest run && npx vite build`.

## Test conventions

- **Environment**: node (no DOM). Render with `renderToString` and strip
  React's `<!-- -->` separators (see the `render` helper in each suite).
- **Determinism**: no `Date.now()`/`Math.random()` — fixtures use literal
  epochs; sessionStorage is a memory polyfill from `test/setup.ts`.
- **Layout**: `screens.test.tsx` (customer views), `operator-screens.test.tsx`
  (admin views/panels), `*-api.test.ts` (client contract), `standards.test.tsx`
  (a11y + nav/route parity), `router.test.ts`/`format.test.ts` (pure lib).
- Assert on what a user sees (strings, `data-testid`, attributes) — not on
  implementation details.

## Accessibility — automated vs visual

Codified in `test/standards.test.tsx` (these run in CI): every control has
`label[for]`/`aria-label`; icon-only buttons carry `aria-label`; `ErrorBanner`
is `role="alert"` + `id="form-error"` and the login form points
`aria-describedby` at it; `<html lang="en">`; `header`/`nav`/`main` landmarks
(including the loading state); nav ↔ route parity.

**Reviewer checklist (visual checks — contrast and keyboard):**

- [ ] Contrast ≥ 4.5:1. Measured pairs (WCAG AA — all pass):
  | Pair | Ratio |
  | --- | --- |
  | `--text #d9e1ec` on `--bg #0e1116` | 14.35 |
  | `--muted #8b96a7` on `--bg` / on `--bg-raised #161b23` | 6.32 / 5.78 |
  | `--accent #4cc2ff` on `--bg` | 9.43 |
  | button text `#04121c` on `--accent-strong #1f9ee8` | 6.42 |
  | `--error-text #ff9ba3` on `--error-bg #2a1417` / on `--bg` | 8.65 / 9.43 |
  | `--ok #57d38c` on `--bg` / on `--bg-raised` | 10.00 / 9.14 |

  Re-check these if any token changes, and check any new color pair the same
  way. *(The issue named a "Kalam-on-pastel" audit — `grep -r Kalam` finds no
  such font in web-v5 or landing; the actual token pairs above are the ones
  in the product.)*
- [ ] Keyboard: logical tab order on every screen; visible `:focus-visible`
  ring on inputs, selects, buttons and links; forms submit on Enter; the
  company-create and TrxID forms are fully keyboard-operable.
- [ ] No modal dialogs exist today (the attach picker is inline). If one is
  added, it must close on Escape and return focus to its trigger.
- [ ] Zoom 200%: no clipped controls or horizontal scrollbars on `#/credits`,
  `#/buy` checkout, and `#/operator/payments`.
