import { describe, expect, it } from "vitest";
import { renderToString as renderToRawString } from "react-dom/server";
import type { CreditPackage, Credits, OwnedApp, Transaction } from "../src/api";
import { AppsView } from "../src/screens/Apps";
import { CheckoutView, PackageListView } from "../src/screens/BuyCredits";
import { CredentialsView } from "../src/screens/Credentials";
import { CreditsView } from "../src/screens/Credits";
import { Docs } from "../src/screens/Docs";
import { FaqView } from "../src/screens/Faq";
import { ForgotPasswordView } from "../src/screens/ForgotPassword";
import { HistoryView } from "../src/screens/History";
import { LinkAppView } from "../src/screens/LinkApp";
import { LoginView } from "../src/screens/Login";
import { MailSettingsView } from "../src/screens/Operator";
import { PaymentView } from "../src/screens/Payment";
import { ResetPasswordView } from "../src/screens/ResetPassword";
import { VerifyEmailView } from "../src/screens/VerifyEmail";

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
        verifyBanner="hidden"
        onResend={(): void => undefined}
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
        verifyBanner="hidden"
        onResend={(): void => undefined}
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
        verifyBanner="hidden"
        onResend={(): void => undefined}
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

  it("offers the verification banner only when unverified and mail is configured", () => {
    const base = {
      apps: OWNED,
      error: null,
      busy: false,
      freshSecret: null,
      onResend: (): void => undefined,
      onOpen: (): void => undefined,
      onCreate: (): void => undefined,
      onAcknowledgeSecret: (): void => undefined,
      onLinkExisting: (): void => undefined,
    };
    const offer = render(<AppsView {...base} verifyBanner="offer" />);
    expect(offer).toContain("Confirm your email");
    expect(offer).toContain("Send verification email");
    const sent = render(<AppsView {...base} verifyBanner="sent" />);
    expect(sent).toContain("Verification email sent");
    const hidden = render(<AppsView {...base} verifyBanner="hidden" />);
    expect(hidden).not.toContain("Confirm your email");
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

describe("F3 amendment screens (email + payment + FAQ)", () => {
  it("PaymentView lists the five remittance methods and the bKash number", () => {
    const html = render(<PaymentView />);
    for (const name of ["TapTap Send", "Remitly", "Wise", "Western Union", "WorldRemit"]) {
      expect(html).toContain(name);
    }
    expect(html).toContain("01613249520");
    expect(html).toContain("+8801613249520");
    expect(html).toContain("MTCN");
  });

  it("PaymentView carries the owner's five verbatim remittance guides (hub 1243)", () => {
    const html = render(<PaymentView />);
    // Owner headings, composed as one text node per heading (React splits
    // adjacent text children with <!-- --> in renderToString).
    for (const name of ["TapTap Send", "Remitly", "Wise", "Western Union", "WorldRemit"]) {
      expect(html).toContain(`How to Send Using ${name}`);
    }
    // Verbatim taglines (chosen without apostrophes/ampersands — those get
    // entity-escaped by renderToString).
    expect(html).toContain("Best for users in the US, UK, Canada, UAE, and Europe.");
    expect(html).toContain("Best for competitive exchange rates and promotional offers.");
    expect(html).toContain("Best for getting the mid-market exchange rate with low, transparent fees.");
    expect(html).toContain("Best for sending online or paying with cash at a brick-and-mortar location.");
    expect(html).toContain("Available in over 50 countries for fast mobile wallet routing.");
    // One verbatim step from each of the five guides.
    expect(html).toContain("Open the App: Download the TapTap Send app, log in, or set up your account.");
    expect(html).toContain("Select Mobile Money and click on bKash.");
    expect(html).toContain("Type the complete phone number: +8801613249520.");
    expect(html).toContain("The funds will route directly into the mobile wallet in minutes.");
    expect(html).toContain("Put in your international card details to authorize the transaction.");
    // Western Union keeps the owner's two route labels.
    expect(html).toContain("Option A: Via the Western Union App/Website");
    expect(html).toContain("Option B: In-Person at an Agent Location (Cash Payment)");
    // Placeholder notes from the pre-ANSWER scaffold are gone.
    expect(html).not.toContain("Send money to a Bangladesh bKash number from the TapTap Send app");
  });

  it("FaqView renders the owner-approved safe question set and no SMTP details", () => {
    const html = render(<FaqView />);
    expect(html).toContain("How do I pay?");
    expect(html).toContain("How do I get API keys?");
    expect(html).toContain("How do I reset my password?");
    expect(html).toContain("What does an OTP cost?");
    // React escapes the apostrophe in renderToString — assert without it.
    expect(html).toContain("my SMS arrived");
    // Owner flag: infrastructure details never appear on customer pages.
    expect(html).not.toContain("smtp");
    expect(html).not.toContain("stackmail");
  });

  it("ForgotPasswordView shows the clean-disable hint when mail is unconfigured", () => {
    const unconfigured = render(
      <ForgotPasswordView sent={false} error={null} busy={false} mailConfigured={false} onSubmit={(): void => undefined} />,
    );
    expect(unconfigured).toContain("Email is not enabled");
    const sent = render(
      <ForgotPasswordView sent error={null} busy={false} mailConfigured onSubmit={(): void => undefined} />,
    );
    expect(sent).toContain("reset link is on its way");
  });

  it("ResetPasswordView handles missing token, form, and success states", () => {
    const noToken = render(
      <ResetPasswordView hasToken={false} done={false} error={null} busy={false} onSubmit={(): void => undefined} />,
    );
    expect(noToken).toContain("link is incomplete");
    const form = renderToString(
      <ResetPasswordView hasToken done={false} error={null} busy onSubmit={(): void => undefined} />,
    );
    expect(form).toContain("minLength=\"10\"");
    expect(form).toContain("Saving…");
    const done = render(
      <ResetPasswordView hasToken done error={null} busy={false} onSubmit={(): void => undefined} />,
    );
    expect(done).toContain("Password updated");
  });

  it("VerifyEmailView renders pending/verified/failed states", () => {
    expect(render(<VerifyEmailView state="pending" error={null} />)).toContain("Verifying…");
    expect(render(<VerifyEmailView state="verified" error={null} />)).toContain("Your email is verified");
    const failed = render(<VerifyEmailView state="failed" error="Invalid or expired token (invalid_token)" />);
    expect(failed).toContain("invalid_token");
  });

  it("MailSettingsView masks the password and disables test-send when unconfigured", () => {
    const html = render(
      <MailSettingsView
        config={{ configured: true, host: "smtp.example.test", port: 465, fromAddress: "f@example.test", passwordMasked: "••••", updatedAt: 1 }}
        error={null}
        note={null}
        busy={false}
        onSave={(): void => undefined}
        onTest={(): void => undefined}
      />,
    );
    expect(html).toContain("smtp.example.test");
    expect(html).toContain("••••");
    expect(html).toContain("Send test");
    expect(html).not.toContain('name="password" value');

    const unconfigured = render(
      <MailSettingsView
        config={{ configured: false, host: null, port: null, fromAddress: null, passwordMasked: null, updatedAt: null }}
        error={null}
        note={null}
        busy={false}
        onSave={(): void => undefined}
        onTest={(): void => undefined}
      />,
    );
    expect(unconfigured).toContain("Not configured yet");
    expect(unconfigured).toContain("disabled");
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
