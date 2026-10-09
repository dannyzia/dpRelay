# landing — dP Relay marketing site

Static, build-free HTML/CSS: no package.json, no framework, no bundler
(contract — the `landing-checks` CI job and `scripts/check-landing.mjs` run
on bare Node). Directory-style clean URLs (`/pricing/` → `pricing/index.html`).

## Page inventory

| URL | File | Purpose |
| --- | --- | --- |
| `/` | `index.html` | home: product pitch + CTAs to the app |
| `/pricing/` | `pricing/index.html` | package pricing |
| `/payment/` | `payment/index.html` | remittance guides (owner-verbatim — see below) |
| `/faq/` | `faq/index.html` | FAQ (SMTP-free rule — infrastructure details never appear) |
| `/docs/` | `docs/index.html` | API docs entry point |

Shared: `styles.css` (design tokens in `:root`), `robots.txt`, `sitemap.xml`.

## How to edit a page

1. Edit the page's `index.html` directly — keep exactly one `<h1>`, the
   per-page `<title>` and meta `description`, and `lang="en"` (the checker
   enforces all three).
2. Style through `styles.css` tokens (`--ink`, `--muted`, `--accent`,
   `--surface`…) — do not inline colors or add a framework.
3. Internal links use root-relative paths (`/pricing/`) so the site works
   from any host; app CTAs are absolute to `https://app.dprelay…` (the
   checker pins the exact app URL).
4. Run `node scripts/check-landing.mjs` — it verifies page existence,
   internal link resolution, SEO tags, single-h1, clean URLs, absolute CTAs,
   owner-verbatim remittance guides (payment page), the SMTP-free FAQ rule,
   and the AGPL pattern gate. CI runs the same script (`landing-checks`).

## How to add a page

1. Create `landing/<name>/index.html` (copy an existing page as the frame).
2. Register it in `PAGES` inside `scripts/check-landing.mjs`.
3. Add it to `sitemap.xml`, link it from the site nav/footer, and re-run the
   checker until exit 0.

**Owner-verbatim content**: the payment page's remittance guides
(TapTap Send / Remitly / Wise / Western Union / WorldRemit) are pinned
word-for-word (hub event 1243) and asserted by the checker — do not
paraphrase them.

## Accessibility checklist (visual checks — reviewer runs these)

Automated today: `scripts/check-landing.mjs` covers structure (lang, title,
single h1, links). Contrast/keyboard are checked by hand:

- [ ] Contrast ≥ 4.5:1. Measured pairs (WCAG AA — all pass):
  | Pair | Ratio |
  | --- | --- |
  | `--ink #16202c` on `--bg #f7f8fa` | 15.47 |
  | `--muted #55627a` on `--bg` / on `--surface #ffffff` | 5.79 / 6.15 |
  | `--accent-ink #ffffff` on `--accent #0b6bcb` (CTA buttons) | 5.28 |
  | `--accent #0b6bcb` on `--bg` (links) | 4.97 |

  Re-check if any token changes. *(The issue named a "Kalam-on-pastel" audit
  — `grep -r Kalam` finds no such font anywhere in the repo; the landing is
  system-ui on the light tokens above, and those are the pairs audited.)*
- [ ] Every page: keyboard-reachable nav and CTAs with a visible focus ring;
  headings run h1 → h2 in order; images (if any) have alt text.
- [ ] 200% zoom: no clipped text or horizontal scrolling on `/` and
  `/pricing/`.
