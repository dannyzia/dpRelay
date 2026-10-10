# Changelog

Notable changes to dP Relay, newest first. The server `package.json` version
is the source of truth — it is what `/health` and `/healthz` report, and what
`docs/Plan/27-OPENAPI-SPEC.json` declares.

## 5.4.0 — 2026-10-10

The final build cut of the v1 scope: tenancy and wallet, the admin operations
suite, device identity, the payment reader, and a release chain that is
signed end to end.

### Added

- **Tenancy + user wallet (STAGE F9, ISSUE-88).** Companies and a dual-path
  wallet: a purchase can settle on the company wallet or on the user wallet,
  with the ownership rules enforced server-side.
- **Multi-currency credit packages (ISSUE-89).** A package carries a
  `currency` (`BDT` | `USD` | `EUR`, default `BDT`); price display and
  settlement are dimensioned by it, so a USD price is never rendered as taka.
- **Admin operations suite (STAGE F5, ISSUE-83).** Payment-SMS surfacing and
  matching, credit-package CRUD, per-user and per-app withhold, and the
  reporting plane behind the operator panel.
- **Device identity + app-scoped binding (STAGE F7).** The gateway phone has
  a phone-number identity and devices bind to a specific app rather than to
  the deployment, so one device can serve several apps without cross-talk.
- **Payment Reader app (STAGE F8, ISSUE-90).** A deliberately tiny second APK
  for the money phone: `RECEIVE_SMS` + `INTERNET` only, it parses bKash/Nagad
  confirmation SMS and uploads the parsed fields to `POST /v5/payments/ingest`
  with an idempotent, backoff-retrying offline queue.
- **Static marketing site (STAGE F6).** Zero-dependency landing site with
  pricing, FAQ, payment guides and docs, published through a CI-gated Pages
  workflow.
- **Customer auth (STAGE F3).** Email/password sessions, self-serve app
  registration, and one-time trial credits granted on app registration.

### Security

- **Fail-closed release signing (ISSUE-49, ISSUE-93).** Both APKs — payment
  reader and gateway — sign release builds from the private dP Relay keystore
  (PKCS12, RSA 4096, `CN=dP Relay`, alias `dprelay-release`), which exists
  only in the OS keyring (ADR-016: never the repo, never chat). A missing
  env var aborts the build naming the **variable names**, never the values.
  There is no debug-signed or unsigned fallback; the gateway no longer signs
  releases with the public Android debug keystore.
- **Credential rotation.** The FCM service-account key was rotated and the
  leaked key retired; `JWT_SECRET`, `OPERATOR_SECRET`,
  `DEVICE_ENROLLMENT_SECRET` and `APP_PROVISIONING_SECRET` were rotated after
  a transcript exposure. The keyring snapshot now mirrors the live Render
  environment, which removes the stale-snapshot restore path that caused the
  previous revert.
- **Alerting hardening.** Telegram is now the sole alert sink (the webhook
  sink was removed after Render persistently dropped its secret);
  `/health/alerts` reports sink reachability, and the server fails loud at
  boot when alerting is unarmed.

### Changed

- **Custom-domain split.** The site and app surfaces are served from their
  own subdomains of the project's custom domain; `api.dprelay.digital-papyrus.com`
  completes the set (site / app / api) immediately after this cut.
- **Frontend quality standard (ISSUE-91).** web-v5 retrofitted to the shared
  component/testing standard.
- **Version cut.** server, web-v5, gateway (`authenticator-app`) and reader
  (`payment-reader`) all report `5.4.0`.

### Fixed

- The server test suite no longer leaks `/tmp` scratch directories; every run
  asserts zero survivors (ISSUE-50).
- `/v5/otp/send` enforces `otp_expires_at` instead of only recording it.
