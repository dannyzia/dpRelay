/**
 * STAGE F15 (ISSUE-125) — the app footer, on the owner's spec: three columns
 * (Product / Support / Legal), the brand line, and a status dot. Deliberately
 * NOT a nav surface: no Operator link, no account links, no social
 * placeholders, and no company registration block — that lives only on the
 * marketing site's /terms/ + /privacy/ (owner's burial rule).
 *
 * In-app destinations (Docs, FAQ) use the hash router; everything else points
 * at the marketing site, which owns the canonical /help/payments/ guides.
 */
import { API_BASE } from "../api";
import { hrefFor } from "../lib/router";
import { LANDING_BASE } from "../lib/routes";

/** One footer column: heading + link list. */
function FooterColumn(props: { heading: string; links: Array<{ label: string; href: string }> }): JSX.Element {
  return (
    <div className="footer-col">
      <p className="footer-heading">{props.heading}</p>
      <ul>
        {props.links.map((link) => (
          <li key={link.href}>
            <a href={link.href}>{link.label}</a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The fixed three-column link sets the footer-content test pins (F15). */
export function SiteFooter(): JSX.Element {
  return (
    <footer className="site-footer" data-testid="site-footer">
      <div className="footer-cols">
        <FooterColumn
          heading="Product"
          links={[
            { label: "Pricing", href: `${LANDING_BASE}/pricing/` },
            { label: "Docs", href: hrefFor(["docs"]) },
            { label: "BYOD guide", href: `${LANDING_BASE}/docs/byod/` },
          ]}
        />
        <FooterColumn
          heading="Support"
          links={[
            { label: "Help", href: `${LANDING_BASE}/help/` },
            { label: "Payments help", href: `${LANDING_BASE}/help/payments/` },
            { label: "FAQ", href: hrefFor(["faq"]) },
            { label: "Contact", href: `${LANDING_BASE}/contact/` },
          ]}
        />
        <FooterColumn
          heading="Legal"
          links={[
            { label: "Terms", href: `${LANDING_BASE}/terms/` },
            { label: "Privacy", href: `${LANDING_BASE}/privacy/` },
            { label: "Acceptable use", href: `${LANDING_BASE}/acceptable-use/` },
          ]}
        />
      </div>
      <p className="footer-line">
        dP Relay — OTP &amp; bulk SMS API · © Digital Papyrus{" "}
        <a className="footer-status" href={`${API_BASE}/health`}>
          <span className="status-dot" aria-hidden="true" /> All systems operational
        </a>
      </p>
    </footer>
  );
}
