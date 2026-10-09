/**
 * ISSUE-91 — FRONTEND QUALITY STANDARD, codified as the AC's "cheap vitest
 * assertions": form labels, accessible button names, semantic landmarks,
 * and nav ↔ route-table parity (zero dead links, every hash route
 * deep-linkable). Contrast and keyboard walkthroughs are visual checks —
 * they live in the web-v5/README.md checklist the reviewer runs, per the
 * issue's own split of automated vs visual.
 */
import { describe, expect, it } from "vitest";
import { renderToString as renderToRawString } from "react-dom/server";
import indexHtml from "../index.html?raw";
import type { BulkCreateResult, BulkPreview, Company, SessionUser, Wallet } from "../src/api";
import { Shell } from "../src/components/Shell";
import { hrefFor, parseHash } from "../src/lib/router";
import { CUSTOMER_TABS, NAV, PUBLIC_SECTIONS, isKnownSection, navHref } from "../src/lib/routes";
import { AppsView } from "../src/screens/Apps";
import { BulkView, type BulkViewProps } from "../src/screens/Bulk";
import { CheckoutView, PackageListView } from "../src/screens/BuyCredits";
import { CredentialsView } from "../src/screens/Credentials";
import { Docs } from "../src/screens/Docs";
import { FaqView } from "../src/screens/Faq";
import { ForgotPasswordView } from "../src/screens/ForgotPassword";
import { History } from "../src/screens/History";
import { LinkAppView } from "../src/screens/LinkApp";
import { LoginView } from "../src/screens/Login";
import { MailSettingsView, PaymentsView, SettingsView } from "../src/screens/Operator";
import { PaymentView } from "../src/screens/Payment";
import { ResetPasswordView } from "../src/screens/ResetPassword";
import { Credits } from "../src/screens/Credits";
import { BuyCredits } from "../src/screens/BuyCredits";
import { VerifyEmailView } from "../src/screens/VerifyEmail";

/** Strip React's `<!-- -->` text separators (see screens.test.tsx). */
const render = (el: JSX.Element): string =>
  renderToRawString(el).replace(/<!-- -->/g, "");

const NOOP = (): void => undefined;

/** Form controls with no accessible name (label[for], aria-label, aria-labelledby). */
function unlabeledControls(html: string): string[] {
  const labelled = new Set(
    Array.from(html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g), (m) => m[1]),
  );
  const problems: string[] = [];
  for (const match of html.matchAll(/<(input|select|textarea)\b[^>]*>/g)) {
    const tag = match[0];
    if (/\baria-label="/.test(tag) || /\baria-labelledby="/.test(tag)) continue;
    const id = /\bid="([^"]+)"/.exec(tag)?.[1];
    if (id !== undefined && labelled.has(id)) continue;
    problems.push(tag);
  }
  return problems;
}

/** Buttons whose only content is decoration and that carry no aria-label. */
function namelessButtons(html: string): string[] {
  const problems: string[] = [];
  for (const match of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    if (/\baria-label="/.test(match[1])) continue;
    const text = match[2].replace(/<[^>]*>/g, "").replace(/<!-- -->/g, "");
    if (text.trim().length > 0) continue;
    problems.push(match[0].slice(0, 120));
  }
  return problems;
}

/** The two cheap a11y assertions applied to one rendered screen. */
function expectAccessible(screen: string, html: string): void {
  expect(unlabeledControls(html), `${screen}: form controls need label[for] or aria-label`).toEqual([]);
  expect(namelessButtons(html), `${screen}: icon-only buttons need aria-label`).toEqual([]);
}

// ── Fixtures (mirrors of screens.test.tsx / bulk-screen.test.tsx) ──────────

const USER: SessionUser = { id: "u-1", email: "owner@example.test", createdAt: 1791400000 };

const WALLET: Wallet = {
  otpSmsRemaining: 20,
  bulkSmsRemaining: 13,
  otpExpiresAt: null,
  bulkExpiresAt: null,
  lastTransactionId: null,
  purchasedAt: null,
};

const COMPANY: Company = {
  id: "co-1",
  name: "My shop",
  disabled: false,
  createdAt: 1791500000,
  gatewayNumber: "+8801711112233",
  app: { appId: "app_alpha", name: "My shop", revoked: false },
};

const APPS_PROPS = {
  wallet: WALLET,
  walletHistory: null,
  showHistory: false,
  linkedApps: [],
  emailVerified: true,
  error: null,
  busy: false,
  freshSecret: null,
  verifyBanner: "hidden" as const,
  companies: [COMPANY],
  onResend: NOOP,
  onOpen: NOOP,
  onCreate: NOOP,
  onRename: NOOP,
  onDisable: NOOP,
  onAcknowledgeSecret: NOOP,
  onLinkExisting: NOOP,
  onToggleHistory: NOOP,
};

const BULK_PREVIEW: BulkPreview = {
  total: 3,
  sampleFirst5: ["+8801711000001"],
  invalidRows: [],
  checksum: "abc123",
  headerSkipped: true,
  perCampaignLimit: 10_000,
};

const BULK_PROPS: BulkViewProps = {
  fileName: "list.csv",
  previewing: false,
  preview: BULK_PREVIEW,
  previewError: null,
  name: "Spring sale",
  message: "Hello",
  submitting: false,
  submitError: null,
  created: null as BulkCreateResult | null,
  onFileChosen: NOOP,
  onName: NOOP,
  onMessage: NOOP,
  onSubmit: NOOP,
};

describe("a11y: every form control has an accessible name", () => {
  const screens: Array<[string, string]> = [
    ["LoginView", render(<LoginView mode="login" error={null} busy={false} onSubmit={NOOP} onToggleMode={NOOP} />)],
    ["LoginView signup", render(<LoginView mode="signup" error={null} busy={false} onSubmit={NOOP} onToggleMode={NOOP} />)],
    [
      "ForgotPasswordView",
      render(<ForgotPasswordView sent={false} error={null} busy={false} mailConfigured onSubmit={NOOP} />),
    ],
    [
      "ResetPasswordView",
      render(<ResetPasswordView hasToken done={false} error={null} busy={false} onSubmit={NOOP} />),
    ],
    ["VerifyEmailView", render(<VerifyEmailView state="failed" error="bad token" />)],
    [
      "LinkAppView",
      render(<LinkAppView appId="haven-app" error={null} busy={false} onLink={NOOP} onBack={NOOP} />),
    ],
    [
      "CheckoutView",
      render(
        <CheckoutView
          request={{ transactionId: "txn-42", bkashNumber: "01700000000", bkashNote: "Send Money", amountBdt: 50 }}
          note={null}
          error={null}
          onSubmitTrx={NOOP}
          onBack={NOOP}
        />,
      ),
    ],
    ["PackageListView", render(<PackageListView packages={[]} onBuy={NOOP} />)],
    ["AppsView", render(<AppsView {...APPS_PROPS} />)],
    ["BulkView", render(<BulkView {...BULK_PROPS} />)],
    ["History container", render(<History />)],
    ["BuyCredits container", render(<BuyCredits />)],
    ["Credits container", render(<Credits />)],
    ["CredentialsView", render(<CredentialsView appId="demo" appSecret="s3cret" revealed={false} onToggleReveal={NOOP} />)],
    [
      "MailSettingsView",
      render(
        <MailSettingsView
          config={{ configured: true, host: "smtp.example.test", port: 465, fromAddress: "f@example.test", passwordMasked: "••••", updatedAt: 1 }}
          error={null}
          note={null}
          busy={false}
          onSave={NOOP}
          onTest={NOOP}
        />,
      ),
    ],
    ["Docs", render(<Docs />)],
    ["FaqView", render(<FaqView />)],
    ["PaymentView", render(<PaymentView />)],
    [
      "PaymentsView (operator filters + actions)",
      render(
        <PaymentsView
          payments={[]}
          pending={[]}
          filters={{ status: "all", from: "", to: "" }}
          error={null}
          note={null}
          busy={false}
          onFilter={NOOP}
          onApprove={NOOP}
          onReject={NOOP}
          onAttach={NOOP}
        />,
      ),
    ],
    [
      "SettingsView (operator match parameters)",
      render(
        <SettingsView
          values={{ windowMin: 30, toleranceBdt: 0 }}
          error={null}
          note={null}
          busy={false}
          onSave={NOOP}
        />,
      ),
    ],
  ];

  for (const [name, html] of screens) {
    it(`${name} renders labelled controls and named buttons`, () => {
      expectAccessible(name, html);
    });
  }
});

describe("a11y: error announcement contract", () => {
  it("ErrorBanner is a stable, screen-reader-announced landmark", () => {
    const html = render(<LoginView mode="login" error="Invalid credentials (invalid_credentials)" busy={false} onSubmit={NOOP} onToggleMode={NOOP} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('id="form-error"');
  });

  it("the canonical login form points its inputs at the banner while it shows", () => {
    const html = render(<LoginView mode="login" error="Invalid credentials" busy={false} onSubmit={NOOP} onToggleMode={NOOP} />);
    const inputs = Array.from(html.matchAll(/<input\b[^>]*>/g), (m) => m[0]);
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect(input, `input missing aria-describedby: ${input}`).toContain('aria-describedby="form-error"');
    }
  });
});

describe("a11y: semantic landmarks and lang", () => {
  it("index.html declares the document language", () => {
    expect(indexHtml).toContain('<html lang="en">');
  });

  it("Shell renders header/nav/main around every screen state", () => {
    const html = render(
      <Shell user={USER} connected section="credits" signOut={NOOP}>
        <p>screen</p>
      </Shell>,
    );
    expect(html).toContain("<header");
    expect(html).toContain('<nav class="nav"');
    expect(html).toContain('<main class="content"');
    expect(html).toContain("owner@example.test");
    expect(html).toContain("Sign out");
  });

  it("the loading state carries the same landmarks", () => {
    const html = render(
      <Shell user={undefined} connected={false} section="" signOut={NOOP}>
        <p className="muted">Loading…</p>
      </Shell>,
    );
    expect(html).toContain("<header");
    expect(html).toContain('<nav class="nav"');
    expect(html).toContain('<main class="content"');
  });

  it("signed-out nav shows only the public sections", () => {
    const html = render(
      <Shell user={null} connected={false} section="docs" signOut={NOOP}>
        <p>docs</p>
      </Shell>,
    );
    expect(html).toContain("Docs");
    expect(html).toContain("FAQ");
    expect(html).toContain("Operator");
    expect(html).not.toContain("Balance");
    expect(html).not.toContain("Companies");
    expect(html).not.toContain("Sign out");
  });
});

describe("connected: nav ↔ route-table parity", () => {
  it("the signed-out-in + connected Shell renders exactly the NAV table", () => {
    const html = render(
      <Shell user={USER} connected section="credits" signOut={NOOP}>
        <p>screen</p>
      </Shell>,
    );
    const hrefs = Array.from(html.matchAll(/<a[^>]*\bhref="([^"]+)"/g), (m) => m[1]);
    expect(hrefs).toEqual(NAV.map((item) => navHref(item)));
  });

  it("every nav href round-trips through the parser (deep-linkable)", () => {
    for (const item of NAV) {
      expect(parseHash(navHref(item)), item.id).toEqual(item.segments);
    }
  });

  it("every nav target is a section the shell can render (zero dead links)", () => {
    for (const item of NAV) {
      expect(isKnownSection(item.segments[0] ?? ""), `nav item ${item.id}`).toBe(true);
    }
  });

  it("nav ids are unique and labels are non-empty", () => {
    const ids = NAV.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of NAV) expect(item.label.length).toBeGreaterThan(0);
  });

  it("public sections are known routes; the email-link ones stay out of the nav", () => {
    for (const section of PUBLIC_SECTIONS) {
      expect(isKnownSection(section), section).toBe(true);
    }
    // docs/faq are public AND nav entries; payment/forgot/reset/verify are
    // reached from flows and email links, never from the top nav.
    for (const section of ["payment", "forgot", "reset", "verify"]) {
      expect(NAV.some((item) => item.id === section), section).toBe(false);
    }
    expect(NAV.some((item) => item.id === "docs")).toBe(true);
    expect(NAV.some((item) => item.id === "faq")).toBe(true);
  });

  it("customer tabs are exactly the connected nav subset", () => {
    expect(CUSTOMER_TABS.every((tab) => NAV.some((item) => item.id === tab.id))).toBe(true);
    expect(CUSTOMER_TABS.map((tab) => tab.id)).toEqual(["credits", "buy", "bulk", "history", "credentials"]);
  });

  it("hrefFor is the only hash builder the table relies on", () => {
    expect(navHref(NAV[0])).toBe(hrefFor(NAV[0].segments));
  });
});
