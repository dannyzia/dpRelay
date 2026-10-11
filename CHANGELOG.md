# Changelog

Notable changes to dP Relay, newest first. The server `package.json` version
is the source of truth — it is what `/health` and `/healthz` report, and what
`docs/Plan/27-OPENAPI-SPEC.json` declares.

## Unreleased

The marketing site and dashboard now tell the product's true dual-mode story:
BYOD gateways (any Android phone, worldwide) and the Bangladesh dedicated SIM
pool, under one API and one credit balance.

### Added

- **landing/** — VoltAgent-style retheme (white canvas, hairline cards, electric-green CTA fills, zero JS) and dual-track
  copy: home tier toggle (Global ⇄ Bangladesh, CSS-only via `:has()`),
  country-wise coverage & rates matrix on pricing, BYOD pairing guide with the
  `POST /v5/device/enroll` contract and device-plane error codes on docs,
  three BYOD questions appended to the FAQ (ids `q-byod-*` keep the pinned
  five-question gate intact). Payment page content untouched (owner-verbatim).
- **web-v5/** — device pairing panel on the Apps screen: QR + copyable
  enrollment payload + manual-entry steps rendered from the one-time
  `deviceEnrollmentSecret` (vendored MIT QR encoder, no npm dependency).
  Styles: gap-fill rules for `.badge`, `.app-list`, `.app-row`, `.app-name`,
  `.button-link`, `.dropzone`, `.card.nested`, plus the pairing panel.
- **Tests** — `web-v5/test/device-pairing.test.tsx` (5 tests): enrollment-URI
  encoding, server-base fallback, deterministic QR SVG, and both pairing
  variants.

### Changed

- landing README contrast table re-measured for the final tokens (all pairs
  ≥ 6.5:1, WCAG AA+); web-v5 README table extended for the new classes.
