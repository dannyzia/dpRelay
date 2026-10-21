/**
 * STAGE F15 (ISSUE-125) — the owner's nav + footer + payment-help spec,
 * pinned as cheap vitest assertions:
 *
 * 1. public top nav order (signed-out shell): Pricing · Docs · FAQ · Help with
 *    Sign in + Get started (→ pricing) on the right, no Operator;
 * 2. signed-in customer nav order: Companies · Balance · Buy credits · Bulk ·
 *    History · Credentials · Docs · FAQ (no Plan, no Operator, no marketing
 *    entries);
 * 3. the three-column footer (Product / Support / Legal) on the app SPA —
 *    no operator link, no street address anywhere outside terms/ + privacy/;
 * 4. the F15 payment-help amendment: the checkout step carries the bKash
 *    number, the amount in its currency and the condensed remittance list
 *    with links to the canonical guides — never an amount without context.
 *
 * The landing side of the same spec is pinned by scripts/check-landing.mjs
 * (nav order, footer columns, the /pricing/ "How to pay" links).
 */
import { describe, expect, it } from "vitest";
import { renderToString as renderToRawString } from "react-dom/server";
import type { CreditPackage } from "../src/api";
import { SiteFooter } from "../src/components/Footer";
import { Shell } from "../src/components/Shell";
import { LANDING_BASE, NAV, isKnownSection, navHref, navVisible } from "../src/lib/routes";
import { CheckoutView, PackageListView } from "../src/screens/BuyCredits";
import { PAYMENT_GUIDES_URL, REMITTANCE_SERVICES } from "../src/screens/Payment";
import type { SessionUser } from "../src/api";

/** Strip React's `<!-- -->` text separators (see screens.test.tsx). */
const render = (el: JSX.Element): string =>
  renderToRawString(el).replace(/<!-- -->/g, "");

const NOOP = (): void => undefined;
const USER: SessionUser = { id: "u-1", email: "owner@example.test", createdAt: 1791400000 };

/** Anchor hrefs, in document order, of one rendered string. */
function hrefsIn(html: string): string[] {
  return Array.from(html.matchAll(/<a[^>]*\bhref="([^"]+)"/g), (m) => m[1]);
}

/** Link labels, in document order, of one rendered string. */
function labelsIn(html: string): string[] {
  return Array.from(html.matchAll(/<a[^>]*>([^<]+)<\/a>/g), (m) => m[1].trim());
}

describe("F15: public top nav (signed-out shell)", () => {
  const html = render(
    <Shell user={null} connected={false} section="docs" signOut={NOOP}>
      <p>docs</p>
    </Shell>,
  );
  const nav = /<nav class="nav">[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";

  it("is exactly Pricing · Docs · FAQ · Help, in that order", () => {
    expect(labelsIn(nav)).toEqual(["Pricing", "Docs", "FAQ", "Help"]);
  });

  it("carries no Operator entry and no account links", () => {
    expect(nav).not.toContain("Operator");
    expect(nav).not.toContain("Companies");
    expect(nav).not.toContain("Balance");
    expect(nav).not.toContain("Sign out");
  });

  it("offers exactly two CTAs — Sign in and Get started (→ pricing)", () => {
    const ctas = html.match(/data-testid="nav-ctas"[\s\S]*?<\/div>/)?.[0] ?? "";
    expect(labelsIn(ctas)).toEqual(["Sign in", "Get started"]);
    expect(hrefsIn(ctas)).toEqual([hrefForLogin(), `${LANDING_BASE}/pricing/`]);
  });

  it("renders the marketing entries as absolute landing-site links", () => {
    expect(hrefsIn(nav)).toEqual([
      `${LANDING_BASE}/pricing/`,
      "#/docs",
      "#/faq",
      `${LANDING_BASE}/help/`,
    ]);
  });
});

/** Hash href for #/login without importing the router twice in assertions. */
function hrefForLogin(): string {
  return "#/login";
}

describe("F15: signed-in customer nav", () => {
  const html = render(
    <Shell user={USER} connected section="credits" signOut={NOOP}>
      <p>credits</p>
    </Shell>,
  );
  const nav = /<nav class="nav">[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";

  it("is exactly Companies · Balance · Buy credits · Bulk · History · Credentials · Docs · FAQ", () => {
    expect(labelsIn(nav)).toEqual([
      "Companies",
      "Balance",
      "Buy credits",
      "Bulk",
      "History",
      "Credentials",
      "Docs",
      "FAQ",
    ]);
  });

  it("drops the Plan tab and the marketing entries for a signed-in customer", () => {
    expect(nav).not.toContain("Plan");
    expect(nav).not.toContain("Pricing");
    expect(nav).not.toContain("Help");
    expect(nav).not.toContain("Operator");
  });

  it("offers no signed-out CTAs to a signed-in user", () => {
    expect(html).not.toContain('data-testid="nav-ctas"');
  });
});

describe("F15: the nav table behind both orders", () => {
  it("renders each visibility state from one table", () => {
    const signedOut = NAV.filter((item) => navVisible(item, { hasUser: false, connected: false }));
    const signedIn = NAV.filter((item) => navVisible(item, { hasUser: true, connected: true }));
    expect(signedOut.map((item) => item.label)).toEqual(["Pricing", "Docs", "FAQ", "Help"]);
    expect(signedIn.map((item) => item.label)).toEqual([
      "Companies",
      "Balance",
      "Buy credits",
      "Bulk",
      "History",
      "Credentials",
      "Docs",
      "FAQ",
    ]);
  });

  it("keeps #/operator and #/plan routable even though neither is a nav entry", () => {
    expect(NAV.some((item) => item.id === "operator")).toBe(false);
    expect(NAV.some((item) => item.id === "plan")).toBe(false);
    expect(isKnownSection("operator")).toBe(true);
    expect(isKnownSection("plan")).toBe(true);
  });

  it("no nav entry points at the operator panel", () => {
    for (const item of NAV) {
      expect(navHref(item)).not.toContain("operator");
    }
  });
});

describe("F15: app footer (three columns, no address, no operator)", () => {
  const html = render(<SiteFooter />);

  it("carries the exact Product / Support / Legal link sets", () => {
    const cols = Array.from(
      html.matchAll(/<p class="footer-heading">([^<]+)<\/p>[\s\S]*?<ul>([\s\S]*?)<\/ul>/g),
    );
    expect(cols.map((c) => c[1])).toEqual(["Product", "Support", "Legal"]);
    const linksOf = (col: RegExpMatchArray): Array<[string, string]> =>
      Array.from(col[2].matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g), (m) => [m[1], m[2]]);
    expect(linksOf(cols[0])).toEqual([
      [`${LANDING_BASE}/pricing/`, "Pricing"],
      ["#/docs", "Docs"],
      [`${LANDING_BASE}/docs/byod/`, "BYOD guide"],
    ]);
    expect(linksOf(cols[1])).toEqual([
      [`${LANDING_BASE}/help/`, "Help"],
      [`${LANDING_BASE}/help/payments/`, "Payments help"],
      ["#/faq", "FAQ"],
      [`${LANDING_BASE}/contact/`, "Contact"],
    ]);
    expect(linksOf(cols[2])).toEqual([
      [`${LANDING_BASE}/terms/`, "Terms"],
      [`${LANDING_BASE}/privacy/`, "Privacy"],
      [`${LANDING_BASE}/acceptable-use/`, "Acceptable use"],
    ]);
  });

  it("shows the brand line and a status link to the health endpoint", () => {
    expect(html).toContain("dP Relay — OTP &amp; bulk SMS API · © Digital Papyrus");
    expect(html).toContain("All systems operational");
    expect(html).toMatch(/href="[^"]*\/health"/);
  });

  it("carries no operator link and no registered address", () => {
    expect(html).not.toContain("operator");
    expect(html).not.toContain("7/1-D");
    expect(html).not.toContain("Mission Road");
  });
});

describe("F15 amendment: the checkout step embeds the payment-help context", () => {
  const html = render(
    <CheckoutView
      request={{ transactionId: "txn-42", bkashNumber: "01613249520", bkashNote: "Send Money", amountBdt: 1200 }}
      note={null}
      error={null}
      currency="USD"
      onSubmitTrx={NOOP}
      onBack={NOOP}
    />,
  );

  it("shows the bKash number and the amount in the selected currency", () => {
    expect(html).toContain("01613249520");
    // formatPrice(1200, "USD") — the amount renders with the package currency.
    expect(html).toContain("1200 USD");
    expect(html).toContain("Send Money");
  });

  it("lists all five remittance services, one line each", () => {
    const list = html.match(/<ul class="remittance-list"[^>]*>([\s\S]*?)<\/ul>/)?.[0] ?? "";
    expect(REMITTANCE_SERVICES).toEqual([
      "TapTap Send",
      "Remitly",
      "Wise",
      "Western Union",
      "WorldRemit",
    ]);
    const items = Array.from(list.matchAll(/<li>([^<]+)<\/li>/g), (m) => m[1]);
    expect(items).toEqual(REMITTANCE_SERVICES);
    expect(list.match(/<li>/g)?.length).toBe(5);
  });

  it("links the canonical full guides and the in-app payment help", () => {
    expect(hrefsIn(html)).toContain(PAYMENT_GUIDES_URL);
    expect(hrefsIn(html)).toContain("#/payment");
    expect(PAYMENT_GUIDES_URL).toBe(`${LANDING_BASE}/help/payments/`);
    expect(html).toContain("Read the full payment guides");
    expect(html).toContain("in-app payment help");
  });

  it("the package list never shows prices without how-to-pay context", () => {
    const pkg: CreditPackage = {
      packageCode: "pkg_1",
      name: "Starter",
      type: "otp",
      smsQuota: 1000,
      validityDays: 30,
      priceBdt: 500,
      currency: "BDT",
    };
    const packages = render(<PackageListView packages={[pkg]} onBuy={NOOP} />);
    expect(packages).toContain("৳500");
    expect(hrefsIn(packages)).toContain("#/payment");
    expect(hrefsIn(packages)).toContain(PAYMENT_GUIDES_URL);
  });
});
