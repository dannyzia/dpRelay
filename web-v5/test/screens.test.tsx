import { describe, expect, it } from "vitest";
import { renderToString as renderToRawString } from "react-dom/server";
import type { CreditPackage, Credits, OwnedApp, Transaction } from "../src/api";
import { AppsView } from "../src/screens/Apps";
import { CheckoutView, PackageListView } from "../src/screens/BuyCredits";
import { CredentialsView } from "../src/screens/Credentials";
import { CreditsView } from "../src/screens/Credits";
import { Docs } from "../src/screens/Docs";
import { HistoryView } from "../src/screens/History";
import { LinkAppView } from "../src/screens/LinkApp";
import { LoginView } from "../src/screens/Login";

/**
 * renderToString + normalization: React inserts `<!-- -->` separators between
 * adjacent text and expression nodes, which would break literal substring
 * assertions on otherwise-correct markup. Strip them so tests assert what a
 * user actually sees. Both names are provided so every call site normalizes.
 */
const renderToString = (el: JSX.Element): string =>
  renderToRawString(el).replace(/<!-- -->/g, "");
const render = renderToString;

const FIXTURE_CREDITS: Credits = {
  otpSmsRemaining: 20,
  bulkSmsRemaining: 20,
  otpExpiresAt: 1794080036,
  bulkExpiresAt: 1794080036,
  lastTransactionId: null,
  purchasedAt: null,
};

describe("LoginView (F3 email/password)", () => {
  it("renders the email/password sign-in form", () => {
    const html = render(
      <LoginView mode="login" error={null} busy={false} onSubmit={(): void => undefined} onToggleMode={(): void => undefined} />,
    );
    expect(html).toContain('id="email"');
    expect(html).toContain('id="password"');
    expect(html).toContain("Sign in");
    expect(html).toContain("Create one");
    // The raw credential gate is gone: no app-plane fields on the front door.
    expect(html).not.toContain('id="appId"');
    expect(html).not.toContain('id="appSecret"');
  });

  it("renders the signup variant with the 10-char hint", () => {
    const html = render(
      <LoginView mode="signup" error={null} busy={false} onSubmit={(): void => undefined} onToggleMode={(): void => undefined} />,
    );
    expect(html).toContain("Create your account");
    expect(html).toContain("At least 10 characters");
    // renderToString emits the camelCase React attribute verbatim.
    expect(html).toContain("minLength=\"10\"");
    expect(html).toContain("Create account");
  });

  it("surfaces the server rejection and disables while busy", () => {
    const html = renderToString(
      <LoginView
        mode="login"
        error="Invalid credentials (invalid_credentials)"
        busy
        onSubmit={(): void => undefined}
        onToggleMode={(): void => undefined}
      />,
    );
    expect(html).toContain("invalid_credentials");
    expect(html).toContain("Checking…");
    expect(html).toContain("disabled");
  });
});

describe("AppsView (F3 owned apps)", () => {
  const OWNED: OwnedApp[] = [
    { appId: "app_alpha", name: "My shop", revoked: false, createdAt: 1791500000 },
    { appId: "app_dead", name: "Old shop", revoked: true, createdAt: 1791400000 },
  ];

  it("lists owned apps with per-app actions and the revoked badge", () => {
    const html = render(
      <AppsView
        apps={OWNED}
        error={null}
        busy={false}
        freshSecret={null}
        onOpen={(): void => undefined}
        onCreate={(): void => undefined}
        onAcknowledgeSecret={(): void => undefined}
        onLinkExisting={(): void => undefined}
      />,
    );
    expect(html).toContain("My shop");
    expect(html).toContain("app_alpha");
    expect(html).toContain("revoked");
    expect(html).toContain("Register a new app");
    expect(html).toContain("Link existing app");
  });

  it("shows the empty state and the one-time secret panel", () => {
    const empty = render(
      <AppsView
        apps={[]}
        error={null}
        busy={false}
        freshSecret={null}
        onOpen={(): void => undefined}
        onCreate={(): void => undefined}
        onAcknowledgeSecret={(): void => undefined}
        onLinkExisting={(): void => undefined}
      />,
    );
    expect(empty).toContain("No apps yet");

    const withSecret = render(
      <AppsView
        apps={[]}
        error={null}
        busy={false}
        freshSecret={{ appId: "app_new1", appSecret: "s3cret-value", trialSms: 20 }}
        onOpen={(): void => undefined}
        onCreate={(): void => undefined}
        onAcknowledgeSecret={(): void => undefined}
        onLinkExisting={(): void => undefined}
      />,
    );
    expect(withSecret).toContain("only time the server will show it");
    expect(withSecret).toContain("app_new1");
    expect(withSecret).toContain("s3cret-value");
    expect(withSecret).toContain("20 OTP + 20 bulk SMS");
  });
});

describe("LinkAppView (F3 link existing app)", () => {
  it("prefills the appId, hides the secret, surfaces errors", () => {
    const html = renderToString(
      <LinkAppView
        appId="haven-app"
        error="Invalid app credentials (invalid_app_credentials)"
        busy
        onLink={(): void => undefined}
        onBack={(): void => undefined}
      />,
    );
    expect(html).toContain('value="haven-app"');
    expect(html).toContain('type="password"');
    expect(html).toContain("invalid_app_credentials");
    expect(html).toContain("Checking…");
  });
});

describe("CreditsView", () => {
  it("renders both buckets with the exact trial numbers and expiry", () => {
    const html = render(<CreditsView credits={FIXTURE_CREDITS} />);
    expect(html).toContain("20 SMS");
    expect(html).toContain("Expires: 2026-11-07 19:33 UTC");
    expect(html).toContain("OTP credits");
    expect(html).toContain("Bulk credits");
  });

  it("renders a null expiry as a dash", () => {
    const html = renderToString(
      <CreditsView credits={{ ...FIXTURE_CREDITS, otpExpiresAt: null, bulkExpiresAt: null }} />,
    );
    expect(html).toContain("Expires: —");
  });
});

describe("PackageListView", () => {
  const packages: CreditPackage[] = [
    {
      packageCode: "OTP-20",
      name: "OTP Starter",
      smsQuota: 20,
      priceBdt: 50,
      validityDays: 30,
      type: "otp",
    },
    {
      packageCode: "BULK-100",
      name: "Bulk Pack",
      smsQuota: 100,
      priceBdt: 0.2,
      validityDays: 30,
      type: "both",
    },
  ];

  it("renders package rows with prices and quota", () => {
    const html = renderToString(
      <PackageListView packages={packages} onBuy={(): void => undefined} />,
    );
    expect(html).toContain("OTP Starter");
    expect(html).toContain("৳50");
    expect(html).toContain("Bulk Pack");
    expect(html).toContain("৳0.20");
    expect(html).toContain("100 SMS · valid 30 days · code BULK-100");
  });

  it("renders the empty-catalog message", () => {
    const html = render(<PackageListView packages={[]} onBuy={(): void => undefined} />);
    expect(html).toContain("No active packages");
  });
});

describe("CheckoutView", () => {
  it("renders the bKash destination, amount, and pending note", () => {
    const html = renderToString(
      <CheckoutView
        request={{
          transactionId: "txn-42",
          bkashNumber: "01700000000",
          bkashNote: "Send Money",
          amountBdt: 50,
        }}
        note={null}
        error={null}
        onSubmitTrx={(): void => undefined}
        onBack={(): void => undefined}
      />,
    );
    expect(html).toContain("৳50");
    expect(html).toContain("01700000000");
    expect(html).toContain("txn-42");
    expect(html).toContain('id="trxId"');
    expect(html).toContain("Send Money");
  });

  it("shows the submit confirmation message", () => {
    const html = renderToString(
      <CheckoutView
        request={{
          transactionId: "txn-42",
          bkashNumber: "01700000000",
          bkashNote: "Send Money",
          amountBdt: 50,
        }}
        note="TrxID submitted. Awaiting operator approval."
        error={null}
        onSubmitTrx={(): void => undefined}
        onBack={(): void => undefined}
      />,
    );
    expect(html).toContain("Awaiting operator approval");
  });
});

describe("HistoryView", () => {
  const rows: Transaction[] = [
    {
      transactionId: "txn-1",
      packageCode: "OTP-20",
      smsQuota: 20,
      validityDays: 30,
      amountBdt: 50,
      packageType: "otp",
      trxId: "TRX123",
      status: "approved",
      adminNotes: null,
      requestedAt: 1791400000,
      resolvedAt: 1791405000,
    },
    {
      transactionId: "txn-2",
      packageCode: "BULK-100",
      smsQuota: 100,
      validityDays: 30,
      amountBdt: 0.2,
      packageType: "both",
      trxId: null,
      status: "pending",
      adminNotes: null,
      requestedAt: 1791410000,
      resolvedAt: null,
    },
  ];

  it("renders rows with status chips, TrxIDs, and formatted dates", () => {
    const html = render(<HistoryView transactions={rows} />);
    expect(html).toContain("TRX123");
    expect(html).toContain("chip approved");
    expect(html).toContain("chip pending");
    expect(html).toContain("৳0.20");
    expect(html).toContain("2026-10-07"); // formatted requestedAt (both fixture rows)
    expect(html).toContain("—"); // pending row's null TrxID / resolved date
  });

  it("renders the empty-state message", () => {
    const html = render(<HistoryView transactions={[]} />);
    expect(html).toContain("No transactions yet.");
  });
});

describe("CredentialsView", () => {
  it("masks the secret until revealed", () => {
    const masked = renderToString(
      <CredentialsView
        appId="demo-app"
        appSecret="super-secret-value"
        revealed={false}
        onToggleReveal={(): void => undefined}
      />,
    );
    expect(masked).toContain("demo-app");
    expect(masked).not.toContain("super-secret-value");
    expect(masked).toContain("•".repeat(24));

    const revealed = renderToString(
      <CredentialsView
        appId="demo-app"
        appSecret="super-secret-value"
        revealed
        onToggleReveal={(): void => undefined}
      />,
    );
    expect(revealed).toContain("super-secret-value");
  });
});

describe("Docs", () => {
  it("documents the send/verify/status contract", () => {
    const html = render(<Docs />);
    expect(html).toContain("POST /v5/otp/send");
    expect(html).toContain("POST /v5/otp/verify");
    expect(html).toContain("GET /v5/otp/status");
    expect(html).toContain("X-App-Id");
    expect(html).toContain("402 insufficient_credits");
    expect(html).toContain("423 otp_locked");
    expect(html).toContain("POST /v5/billing/credits/submit-trx");
  });
});
