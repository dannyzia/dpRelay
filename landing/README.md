# landing — dP Relay marketing site

Static, build-free HTML/CSS: no package.json, no framework, no bundler
(contract — the `landing-checks` CI job and `scripts/check-landing.mjs` run
on bare Node). Directory-style clean URLs (`/pricing/` → `pricing/index.html`).

## Page inventory

| URL | File | Purpose |
| --- | --- | --- |
| `/` | `index.html` | home: what it is, how it differs, who it's for, how it works |
| `/pricing/` | `pricing/index.html` | tracks & rates, unlimited plans, credit packages, comparison |
| `/docs/` | `docs/index.html` | API docs: quickstart through credits & billing (sticky sidebar) |
| `/docs/byod/` | `docs/byod/index.html` | connect your own Android phone as the gateway |
| `/docs/payments/` | `docs/payments/index.html` | how to pay: bKash + remittance guides (owner-verbatim — see below) |
| `/faq/` | `faq/index.html` | FAQ, four categories (SMTP-free rule — infrastructure details never appear) |
| `/contact/` | `contact/index.html` | how to reach a person |
| `/terms/` | `terms/index.html` | terms of service (draft — owner notes mark the open facts) |
| `/privacy/` | `privacy/index.html` | privacy policy (draft — owner notes mark the open facts) |
| `/acceptable-use/` | `acceptable-use/index.html` | acceptable use + fair-use rules |

`/payment/` is retired: `landing/_redirects` 301s it to `/docs/payments/`, and
the checker's `PAGES` registry + `sitemap.xml` list exactly the ten live pages.

Shared: `styles.css` (design tokens in `:root`), `site.js` (the only script —
code tabs + copy buttons, no framework, no bundler), `robots.txt`, `sitemap.xml`.

**Owner notes**: `[bracketed]` items from the copy doc are facts only the owner
can supply. They render as visible amber `.owner-note` elements containing the
bracket text verbatim — never as invented values. "Research sources" lines
render as `.internal-note` blocks labelled "Internal — remove before
publishing".

## How to edit a page

1. Edit the page's `index.html` directly — keep exactly one `<h1>`, the
   per-page `<title>` and meta `description`, and `lang="en"` (the checker
   enforces all three).
2. Style through `styles.css` tokens (`--ink`, `--mute`, `--green`, `--sky`,
   `--code-bg`…) — do not inline colors or add a framework. New tokens since
   the light redesign: `--sky`/`--sky-ink`/`--sky-soft` (the Bangladesh /
   dedicated track, secondary to green) and `--code-bg`/`--code-ink`/
   `--code-mute` (dark code panels on the light page).
3. Internal links use root-relative paths (`/pricing/`) so the site works
   from any host; app CTAs are absolute to `https://app.dprelay…` (the
   checker pins the exact app URL).
4. Run `node scripts/check-landing.mjs` — it verifies page existence,
   internal link resolution, SEO tags, single-h1, clean URLs, absolute CTAs,
   owner-verbatim remittance guides (`/docs/payments/`), the four-category /
   14-question FAQ shape, the SMTP-free FAQ rule, and the AGPL pattern gate.
   CI runs the same script (`landing-checks`).

## How to add a page

1. Create `landing/<name>/index.html` (copy an existing page as the frame).
2. Register it in `PAGES` inside `scripts/check-landing.mjs`.
3. Add it to `sitemap.xml`, link it from the site nav/footer, and re-run the
   checker until exit 0.

**Owner-verbatim content**: the payment guides on `/docs/payments/`
(TapTap Send / Remitly / Wise / Western Union / WorldRemit) are pinned
word-for-word (hub event 1243) and asserted by the checker — do not
paraphrase them. When the guides moved from `/payment/`, the checker's pin
*path* was retargeted; the pin *text* was never touched.

## Accessibility checklist (visual checks — reviewer runs these)

Automated today: `scripts/check-landing.mjs` covers structure (lang, title,
single h1, links). Contrast/keyboard are checked by hand:

- [ ] Contrast ≥ 4.5:1. Measured pairs (WCAG AA — all pass):
  | Pair | Ratio |
  | --- | --- |
  | `--ink-strong #0b1220` on `--canvas #ffffff` | 18.72 |
  | `--ink #16202c` on `--surface #ffffff` (cards/tables) | 16.44 |
  | `--body-text #3a4657` on `--canvas` | 9.57 |
  | `--mute #667085` on `--canvas` | 4.97 |
  | `--green-soft #047857` on `--canvas` / `--canvas-soft` (eyebrow/chips/code) | 5.48 / 5.14 |
  | `--on-green #101010` on `--green #00d992` (CTA fills) | 10.28 |
  | link hover `#065f46` on `--canvas` | 7.68 |
  | `--sky-ink #0369a1` on `--sky-soft #e0f2fe` / `--canvas` (BD badges) | 5.17 / 5.93 |
  | `--code-ink #e2e8f0` on `--code-bg #0f172a` (code panels) | 14.48 |
  | `--code-mute #94a3b8` on `--code-bg #0f172a` (code panel chrome) | 6.96 |
  | `--note-amber-ink #92400e` on `--note-amber-bg #fef3c7` (owner notes) | 6.37 |
  | `--note-internal-ink #475569` on `--note-internal-bg #f1f5f9` (internal notes) | 6.92 |

  Re-check if any token changes. *(The issue named a "Kalam-on-pastel" audit
  — `grep -r Kalam` finds no such font anywhere in the repo; the landing is
  the spec pair of system-ui headings and an Inter-first body stack, on the tokens above, and those are the pairs audited.)*
- [ ] Every page: keyboard-reachable nav and CTAs with a visible focus ring;
  headings run h1 → h2 in order; images (if any) have alt text.
- [ ] 200% zoom: no clipped text or horizontal scrolling on `/` and
  `/pricing/`.
