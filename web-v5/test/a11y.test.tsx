// @vitest-environment happy-dom
/**
 * ISSUE-114 — automated WCAG 2.1 AA audit with axe-core.
 *
 * The hand-rolled label/name regexes in standards.test.tsx stay (they assert
 * this repo's specific contracts); this file adds the industry-standard
 * engine on top: axe evaluates the REAL rendered DOM for ARIA validity,
 * landmark structure, accessible names, duplicate ids and form associations
 * across every customer + operator screen.
 *
 * Rendering: react-dom/server's static markup injected into a clean
 * container inside the happy-dom document (effects never run, so no network
 * I/O — same convention as the rest of this repo's component tests).
 * Assertion: `violations` must be an EMPTY list; failures print rule id,
 * impact, help and the offending selector targets.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as axeModule from "axe-core";
import type {
  AdminApp,
  AdminMetrics,
  AdminPackage,
  AdminUserItem,
  BulkCampaignStatus,
  BulkCreateResult,
  BulkPreview,
  Company,
  CreditPackage,
  Credits,
  OversightCampaign,
  PaymentSmsItem,
  PendingTransaction,
  SessionUser,
  Transaction,
  Wallet,
  WalletTransaction,
} from "../src/api";
import { Shell } from "../src/components/Shell";
import { AppsView } from "../src/screens/Apps";
import { BulkView } from "../src/screens/Bulk";
import { CheckoutView, PackageListView } from "../src/screens/BuyCredits";
import { CredentialsView } from "../src/screens/Credentials";
import { CreditsView } from "../src/screens/Credits";
import { Docs } from "../src/screens/Docs";
import { FaqView } from "../src/screens/Faq";
import { ForgotPasswordView } from "../src/screens/ForgotPassword";
import { HistoryView } from "../src/screens/History";
import { LoginView } from "../src/screens/Login";
import {
  AppsView as OperatorAppsView,
  BillingQueueView,
  CampaignsView,
  MailSettingsView,
  MetricsView,
  PackagesView,
  PaymentsView,
  SettingsView,
  UnlockView,
  UsersView,
} from "../src/screens/Operator";
import { PaymentView } from "../src/screens/Payment";
import { ResetPasswordView } from "../src/screens/ResetPassword";
import { VerifyEmailView } from "../src/screens/VerifyEmail";

/**
 * axe-core is CommonJS (`export = axe`): depending on the bundler's interop
 * the import is either the module object itself or a `default` wrapper —
 * normalize once here instead of guessing at every call site.
 */
const axe: typeof axeModule = ((axeModule as unknown as { default?: typeof axeModule }).default ??
  axeModule) as typeof axeModule;

const NOOP = (): void => undefined;

/** WCAG 2.1 AA tag set the order mandates (2.0 A/AA + 2.1 A/AA). */
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] as const;

/** Structural slice of `axe.Result` we assert on (avoids interop type names). */
type AxeViolation = {
  id: string;
  impact?: string | null;
  help: string;
  nodes: Array<{ target: unknown[] }>;
};

/** One readable line per violation: rule id, impact, help, selector targets. */
function summarize(violations: readonly AxeViolation[]): string[] {
  return violations.map(
    (v) =>
      `${v.id} [${v.impact ?? "unknown"}] ${v.help} — ${v.nodes
        .slice(0, 3)
        .map((n) => JSON.stringify(n.target))
        .join(" | ")}`,
  );
}

/**
 * Mount one element in a fresh container, audit it, tear it down.
 *
 * @param el screen to render (static markup — effects never execute).
 * @returns one human-readable string per violation (empty = pass).
 */
async function axeViolations(el: JSX.Element): Promise<string[]> {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(el);
  document.body.appendChild(container);
  try {
    const results = await axe.run(container, {
      runOnly: { type: "tag", values: [...WCAG_TAGS] },
    });
    return summarize(results.violations);
  } finally {
    container.remove();
  }
}

/**
 * Full-document audit: page-level WCAG rules (`html-has-lang`,
 * `document-title`, `bypass`, …) cannot match inside an element-scoped
 * context, so one run targets the whole document with index.html's
 * `lang`/`<title>` mirrored — the same shape the real page ships.
 *
 * @returns one human-readable string per violation (empty = pass).
 */
async function axePageViolations(): Promise<string[]> {
  document.documentElement.setAttribute("lang", "en"); // index.html ships <html lang="en">
  document.title = "dP Relay — dashboard"; // index.html ships a non-empty <title>
  document.body.innerHTML = renderToStaticMarkup(
    <Shell user={USER} connected section="credits" signOut={NOOP} wallet={WALLET}>
      <p>Credit balance</p>
    </Shell>,
  );
  try {
    const results = await axe.run(document, {
      runOnly: { type: "tag", values: [...WCAG_TAGS] },
    });
    return summarize(results.violations);
  } finally {
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("lang");
    document.title = "";
  }
}

// ── Shared fixtures (mirror the values the render tests already assert) ─────

const USER: SessionUser = { id: "u-1", email: "owner@example.test", createdAt: 1791400000 };

const WALLET: Wallet = {
  otpSmsRemaining: 20,
  bulkSmsRemaining: 13,
  otpExpiresAt: null,
  bulkExpiresAt: null,
  lastTransactionId: null,
  purchasedAt: null,
};

const WALLET_HISTORY: WalletTransaction[] = [
  {
    transactionId: "trx-1",
    packageCode: "otp-100",
    smsQuota: 100,
    amountBdt: 20,
    packageType: "otp",
    currency: "USD",
    status: "approved",
    trxId: "BK1",
    requestedAt: 1791500000,
    resolvedAt: 1791500500,
  },
];

const COMPANIES: Company[] = [
  {
    id: "co-1",
    name: "My shop",
    disabled: false,
    createdAt: 1791500000,
    gatewayNumber: "+8801711112233",
    app: { appId: "app_alpha", name: "My shop", revoked: false },
  },
  {
    id: "co-2",
    name: "Old shop",
    disabled: true,
    createdAt: 1791400000,
    gatewayNumber: null,
    app: { appId: "app_dead", name: "Old shop", revoked: false },
  },
];

const APPS_PROPS = {
  wallet: WALLET,
  walletHistory: WALLET_HISTORY,
  showHistory: true,
  linkedApps: [],
  emailVerified: true,
  error: null,
  busy: false,
  freshSecret: null,
  verifyBanner: "hidden" as const,
  companies: COMPANIES,
  onResend: NOOP,
  onOpen: NOOP,
  onCreate: NOOP,
  onRename: NOOP,
  onDisable: NOOP,
  onAcknowledgeSecret: NOOP,
  onLinkExisting: NOOP,
  onToggleHistory: NOOP,
};

const CREDITS: Credits = {
  otpSmsRemaining: 20,
  bulkSmsRemaining: 20,
  otpExpiresAt: 1794080036,
  bulkExpiresAt: 1794080036,
  lastTransactionId: null,
  purchasedAt: null,
};

const PACKAGES: CreditPackage[] = [
  {
    packageCode: "OTP-20",
    name: "OTP Starter",
    smsQuota: 20,
    priceBdt: 50,
    validityDays: 30,
    type: "otp",
    currency: "BDT",
  },
  {
    packageCode: "BULK-100",
    name: "Bulk Pack",
    smsQuota: 100,
    priceBdt: 0.2,
    validityDays: 30,
    type: "both",
    currency: "BDT",
  },
];

const BULK_PREVIEW: BulkPreview = {
  total: 3,
  sampleFirst5: ["+8801711000001"],
  invalidRows: [],
  checksum: "abc123",
  headerSkipped: true,
  perCampaignLimit: 10_000,
};

const BULK_CREATED: BulkCreateResult = {
  ok: true,
  campaignId: "camp-9",
  totalRecipients: 42,
  creditsReserved: 42,
  charset: "gsm",
  status: "queued",
};

const BULK_STATUS: BulkCampaignStatus = {
  campaignId: "camp-9",
  name: "Spring sale",
  status: "sending",
  sourceType: "csv",
  totalRecipients: 100,
  sentCount: 40,
  failedCount: 10,
  queuedCount: 50,
  createdAt: 1791500000,
  startedAt: 1791500010,
  completedAt: null,
  unlimitedPass: false,
};

const HISTORY_ROWS: Transaction[] = [
  {
    transactionId: "txn-1",
    packageCode: "OTP-20",
    smsQuota: 20,
    validityDays: 30,
    amountBdt: 50,
    packageType: "otp",
    currency: "BDT",
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
    currency: "BDT",
    trxId: null,
    status: "pending",
    adminNotes: null,
    requestedAt: 1791410000,
    resolvedAt: null,
  },
];

const OPERATOR_APPS: AdminApp[] = [
  {
    id: "row-1",
    appId: "live-app",
    name: "Live customer",
    webhookUrl: null,
    rateMaxPerPhone: 5,
    rateWindowSec: 3600,
    createdAt: 1791400000,
    revokedAt: null,
  },
  {
    id: "row-2",
    appId: "dead-app",
    name: "Revoked customer",
    webhookUrl: null,
    rateMaxPerPhone: 5,
    rateWindowSec: 3600,
    createdAt: 1791400000,
    revokedAt: 1791405000,
  },
];

const METRICS: AdminMetrics = {
  generatedAt: 1791400000,
  apps: { total: 7, revoked: 2 },
  users: { total: 3, devices: 4 },
  otp: { sessionsTotal: 120, sessionsPending: 5, sessionsVerified: 100, sessionsLast24h: 12 },
  bulk: {
    campaignsTotal: 6,
    campaignsActive: 1,
    recipientsSent: 500,
    recipientsFailed: 3,
    recipientsQueued: 40,
  },
  billing: { transactionsPending: 2, transactionsApproved: 9, transactionsRejected: 1, creditsRows: 7 },
  webhooks: { deliveriesLast24h: 48, deliveredLast24h: 46, failedLast24h: 2 },
};

const CAMPAIGNS: OversightCampaign[] = [
  {
    campaignId: "camp-1",
    appId: "customer-app",
    name: "October promo",
    status: "sending",
    totalRecipients: 1000,
    sentCount: 400,
    failedCount: 4,
    queuedCount: 596,
    createdAt: 1791400000,
    startedAt: 1791400100,
    completedAt: null,
  },
];

const PENDING: PendingTransaction[] = [
  {
    transactionId: "txn-1",
    appId: "customer-app",
    packageCode: "OTP-20",
    smsQuota: 20,
    amountBdt: 50,
    packageType: "otp",
    currency: "BDT",
    trxId: "TRXABC",
    requestedAt: 1791400000,
  },
];

const PAYMENT_ROW: PaymentSmsItem = {
  id: "p1",
  sender: "+8801613000000",
  provider: "bkash",
  source: "gateway",
  txnId: "TRXPAID0001",
  amountBdt: 200,
  receivedAt: 1791400000,
  createdAt: 1791400000,
  status: "approved",
  reason: null,
  matched: { transactionId: "txn-1", status: "approved", appId: "app_1" },
  candidates: [],
  ambiguous: false,
};

const AMBIGUOUS_ROW: PaymentSmsItem = {
  ...PAYMENT_ROW,
  id: "p2",
  txnId: "TRXAMB00002",
  status: "unmatched",
  matched: null,
  candidates: [
    {
      transactionId: "txn-a",
      appId: "app_1",
      packageCode: "otp100",
      amountBdt: 200,
      requestedAt: 1791400000,
      deltaBdt: 0,
      timeDeltaSec: 10,
    },
  ],
  ambiguous: true,
};

const ADMIN_PACKAGES: AdminPackage[] = [
  {
    packageCode: "otp100",
    name: "OTP 100",
    smsQuota: 100,
    priceBdt: 200,
    validityDays: 30,
    type: "otp",
    isActive: true,
    currency: "BDT",
  },
  {
    packageCode: "old50",
    name: "Old 50",
    smsQuota: 50,
    priceBdt: 100,
    validityDays: 30,
    type: "bulk",
    isActive: false,
    currency: "BDT",
  },
];

const ADMIN_USERS: AdminUserItem[] = [
  {
    id: "u1",
    email: "held@example.test",
    disabled: true,
    disabledReason: "chargeback investigation",
    disabledAt: 1791400100,
    createdAt: 1791400000,
    appCount: 1,
    apps: [{ id: "app-row", appId: "app_1", name: "My app", revoked: false }],
  },
  {
    id: "u2",
    email: "fine@example.test",
    disabled: false,
    disabledReason: null,
    disabledAt: null,
    createdAt: 1791400500,
    appCount: 0,
    apps: [],
  },
];

// ── The audit table: every screen the order lists (plus its rich states) ────

const SCREENS: Array<[string, JSX.Element]> = [
  // 1 — Auth views
  ["LoginView (sign in)", <LoginView mode="login" error={null} busy={false} onSubmit={NOOP} onToggleMode={NOOP} />],
  ["LoginView (sign up)", <LoginView mode="signup" error={null} busy={false} onSubmit={NOOP} onToggleMode={NOOP} />],
  [
    "LoginView (error banner)",
    <LoginView
      mode="login"
      error="Invalid credentials (invalid_credentials)"
      busy={false}
      onSubmit={NOOP}
      onToggleMode={NOOP}
    />,
  ],
  ["ForgotPasswordView", <ForgotPasswordView sent={false} error={null} busy={false} mailConfigured onSubmit={NOOP} />],
  ["ResetPasswordView", <ResetPasswordView hasToken done={false} error={null} busy={false} onSubmit={NOOP} />],
  ["VerifyEmailView (failed)", <VerifyEmailView state="failed" error="Invalid or expired token (invalid_token)" />],
  ["VerifyEmailView (pending)", <VerifyEmailView state="pending" error={null} />],

  // 2 — Customer views
  [
    "AppsView (companies + pairing + rotated QR)",
    <AppsView {...APPS_PROPS} pairingCompanyId="co-1" rotatedSecrets={{ "co-1": "fresh-enroll-secret" }} />,
  ],
  [
    "AppsView (fresh-secret card)",
    <AppsView
      {...APPS_PROPS}
      companies={[]}
      freshSecret={{
        companyId: "co-new",
        appId: "app_new1",
        appSecret: "s3cret-value",
        deviceEnrollmentSecret: "dev-enroll-value",
        trialSms: 20,
      }}
    />,
  ],
  ["CreditsView", <CreditsView credits={CREDITS} />],
  ["PackageListView", <PackageListView packages={PACKAGES} onBuy={NOOP} />],
  [
    "CheckoutView",
    <CheckoutView
      request={{ transactionId: "txn-42", bkashNumber: "01700000000", bkashNote: "Send Money", amountBdt: 50 }}
      note={null}
      error={null}
      onSubmitTrx={NOOP}
      onBack={NOOP}
    />,
  ],
  [
    "BulkView (ready flow)",
    <BulkView
      fileName="list.csv"
      previewing={false}
      preview={BULK_PREVIEW}
      previewError={null}
      name="Spring sale"
      message="Hello {{name}}"
      submitting={false}
      submitError={null}
      created={null}
      pasted="+8801711000001"
      onFileChosen={NOOP}
      onName={NOOP}
      onMessage={NOOP}
      onSubmit={NOOP}
      onPasted={NOOP}
      onPreviewPasted={NOOP}
      onInsertVariable={NOOP}
      campaignStatus={null}
      campaignStatusError={null}
      onRefreshStatus={NOOP}
    />,
  ],
  [
    "BulkView (both error banners)",
    <BulkView
      fileName="list.csv"
      previewing={false}
      preview={BULK_PREVIEW}
      previewError="Could not read list.xlsx (unreadable_file)"
      name="Spring sale"
      message="Hello"
      submitting={false}
      submitError="Recipient list changed since preview (checksum_mismatch)"
      created={null}
      onFileChosen={NOOP}
      onName={NOOP}
      onMessage={NOOP}
      onSubmit={NOOP}
    />,
  ],
  [
    "BulkView (created + broadcast status)",
    <BulkView
      fileName={null}
      previewing={false}
      preview={null}
      previewError={null}
      name=""
      message=""
      submitting={false}
      submitError={null}
      created={BULK_CREATED}
      onFileChosen={NOOP}
      onName={NOOP}
      onMessage={NOOP}
      onSubmit={NOOP}
      campaignStatus={BULK_STATUS}
      campaignStatusError={null}
      onRefreshStatus={NOOP}
    />,
  ],
  ["CredentialsView (masked)", <CredentialsView appId="app_demo" appSecret="s3cret" revealed={false} onToggleReveal={NOOP} />],
  ["CredentialsView (revealed)", <CredentialsView appId="app_demo" appSecret="s3cret" revealed onToggleReveal={NOOP} />],
  ["Docs", <Docs />],
  ["FaqView", <FaqView />],
  ["PaymentView", <PaymentView />],
  ["HistoryView", <HistoryView transactions={HISTORY_ROWS} />],

  // 3 — Operator views
  ["Operator UnlockView", <UnlockView error={null} busy={false} onSubmit={NOOP} />],
  ["BillingQueueView", <BillingQueueView pending={PENDING} onApprove={NOOP} onReject={NOOP} />],
  ["Operator AppsView", <OperatorAppsView apps={OPERATOR_APPS} onRevoke={NOOP} onUnrevoke={NOOP} />],
  ["MetricsView", <MetricsView metrics={METRICS} />],
  ["CampaignsView", <CampaignsView campaigns={CAMPAIGNS} />],
  [
    "MailSettingsView (configured)",
    <MailSettingsView
      config={{
        configured: true,
        host: "smtp.example.test",
        port: 465,
        fromAddress: "f@example.test",
        passwordMasked: "••••",
        updatedAt: 1,
      }}
      error={null}
      note={null}
      busy={false}
      onSave={NOOP}
      onTest={NOOP}
    />,
  ],
  [
    "MailSettingsView (unconfigured)",
    <MailSettingsView
      config={{ configured: false, host: null, port: null, fromAddress: null, passwordMasked: null, updatedAt: null }}
      error={null}
      note={null}
      busy={false}
      onSave={NOOP}
      onTest={NOOP}
    />,
  ],
  [
    "PaymentsView (all match states)",
    <PaymentsView
      payments={[PAYMENT_ROW, AMBIGUOUS_ROW]}
      pending={PENDING}
      filters={{ status: "all", from: "", to: "" }}
      error={null}
      note={null}
      busy={false}
      onFilter={NOOP}
      onApprove={NOOP}
      onReject={NOOP}
      onAttach={NOOP}
    />,
  ],
  [
    "SettingsView",
    <SettingsView values={{ windowMin: 30, toleranceBdt: 0 }} error={null} note={null} busy={false} onSave={NOOP} />,
  ],
  [
    "PackagesView",
    <PackagesView
      packages={ADMIN_PACKAGES}
      error={null}
      note={null}
      busy={false}
      onCreate={NOOP}
      onPatch={NOOP}
      onToggleActive={NOOP}
    />,
  ],
  ["UsersView", <UsersView users={ADMIN_USERS} error={null} note={null} busy={false} onToggle={NOOP} />],

  // 4 — App shell (landmarks)
  [
    "Shell (signed in, connected, balance chip)",
    <Shell user={USER} connected section="credits" signOut={NOOP} wallet={WALLET}>
      <p>screen</p>
    </Shell>,
  ],
  [
    "Shell (signed out)",
    <Shell user={null} connected={false} section="docs" signOut={NOOP}>
      <p>docs</p>
    </Shell>,
  ],
  [
    "Shell (loading)",
    <Shell user={undefined} connected={false} section="" signOut={NOOP}>
      <p className="muted">Loading…</p>
    </Shell>,
  ],
];

describe("axe-core WCAG 2.1 AA audit (ISSUE-114)", () => {
  it(
    "negative control: the harness flags a deliberately broken fragment",
    async () => {
      // Without this, every `[]` assertion above could be a vacuous pass
      // (rules not running, engine not attached). An unlabeled input and a
      // nameless button MUST come back as violations.
      const container = document.createElement("div");
      container.innerHTML =
        '<input type="text" /><button></button><div role="checkbox"></div>';
      document.body.appendChild(container);
      try {
        const results = await axe.run(container, {
          runOnly: { type: "tag", values: [...WCAG_TAGS] },
        });
        const ids = results.violations.map((v) => v.id);
        expect(ids).toContain("label"); // form association
        expect(ids).toContain("button-name"); // accessible name
        expect(ids).toContain("aria-required-attr"); // ARIA validity
      } finally {
        container.remove();
      }
    },
    30_000,
  );

  it(
    "full page (document-scoped rules): html lang, title, bypass",
    async () => {
      expect(await axePageViolations()).toEqual([]);
    },
    30_000,
  );

  for (const [name, element] of SCREENS) {
    it(
      `${name} has zero violations`,
      async () => {
        expect(await axeViolations(element)).toEqual([]);
      },
      30_000,
    );
  }
});
