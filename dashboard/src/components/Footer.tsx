/**
 * STAGE F15 (ISSUE-125) — the dashboard SPA's site footer, on the same
 * owner's spec as the web-v5 one: three columns (Product / Support / Legal),
 * the brand line and a status dot. No Operator link, no account links, no
 * social placeholders, no company registration block (that lives only on the
 * marketing site's /terms/ + /privacy/ — owner's burial rule).
 *
 * This SPA has no docs/faq screens of its own, so every link points at the
 * marketing site, which also owns the canonical /help/payments/ guides.
 */
import { API_BASE } from "../api.js";

const LANDING_BASE = "https://dprelay.digital-papyrus.com";

/** The fixed three-column link sets the footer spec pins. */
const COLUMNS: Array<{ heading: string; links: Array<{ label: string; href: string }> }> = [
  {
    heading: "Product",
    links: [
      { label: "Pricing", href: `${LANDING_BASE}/pricing/` },
      { label: "Docs", href: `${LANDING_BASE}/docs/` },
      { label: "BYOD guide", href: `${LANDING_BASE}/docs/byod/` },
    ],
  },
  {
    heading: "Support",
    links: [
      { label: "Help", href: `${LANDING_BASE}/help/` },
      { label: "Payments help", href: `${LANDING_BASE}/help/payments/` },
      { label: "FAQ", href: `${LANDING_BASE}/faq/` },
      { label: "Contact", href: `${LANDING_BASE}/contact/` },
    ],
  },
  {
    heading: "Legal",
    links: [
      { label: "Terms", href: `${LANDING_BASE}/terms/` },
      { label: "Privacy", href: `${LANDING_BASE}/privacy/` },
      { label: "Acceptable use", href: `${LANDING_BASE}/acceptable-use/` },
    ],
  },
];

/** Footer landmark rendered below the dashboard's `<main>`. */
export function SiteFooter() {
  return (
    <footer data-testid="site-footer" className="border-t border-slate-800 bg-slate-900/60 px-4 py-8 text-sm text-slate-400">
      <div className="mx-auto grid max-w-5xl grid-cols-1 gap-8 sm:grid-cols-3">
        {COLUMNS.map((column) => (
          <div key={column.heading}>
            <p className="mb-3 font-semibold uppercase tracking-wide text-slate-200">{column.heading}</p>
            <ul className="space-y-2">
              {column.links.map((link) => (
                <li key={link.href}>
                  <a className="text-slate-400 hover:text-slate-100" href={link.href}>
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <p className="mx-auto mt-6 flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-1">
        <span>
          dP Relay — OTP &amp; bulk SMS API · © Digital Papyrus
        </span>
        <a className="text-slate-400 hover:text-slate-100" href={`${API_BASE}/health`}>
          <span aria-hidden="true" className="mr-1 inline-block h-2 w-2 rounded-full bg-emerald-400" />
          All systems operational
        </a>
      </p>
    </footer>
  );
}
