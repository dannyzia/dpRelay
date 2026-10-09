import { describe, expect, it } from "vitest";
import { renderToString as renderToRawString } from "react-dom/server";
import type {
  AdminApp,
  AdminMetrics,
  AdminPackage,
  AdminUserItem,
  LedgerReport,
  MatchConfig,
  OversightCampaign,
  PaymentSmsItem,
  PendingTransaction,
  SendLogRow,
} from "../src/api";
import {
  AppsView,
  BillingQueueView,
  CampaignsView,
  MetricsView,
  PackagesView,
  PaymentsView,
  ReportsView,
  UnlockView,
  UsersView,
} from "../src/screens/Operator";

/** Strip React's `<!-- -->` text separators (see screens.test.tsx). */
const renderToString = (el: JSX.Element): string =>
  renderToRawString(el).replace(/<!-- -->/g, "");

describe("UnlockView", () => {
  it("renders the operator secret form", () => {
    const html = renderToString(
      <UnlockView error={null} busy={false} onSubmit={(): void => undefined} />,
    );
    expect(html).toContain('id="operatorSecret"');
    expect(html).toContain("Operator unlock");
  });

  it("shows a rejection and disables the button while verifying", () => {
    const html = renderToString(
      <UnlockView
        error="Unlock rejected: Invalid operator secret (invalid_operator_secret)"
        busy
        onSubmit={(): void => undefined}
      />,
    );
    expect(html).toContain("invalid_operator_secret");
    expect(html).toContain("Verifying…");
    expect(html).toContain("disabled");
  });
});

describe("BillingQueueView", () => {
  const pending: PendingTransaction[] = [
    {
      transactionId: "txn-1",
      appId: "customer-app",
      packageCode: "OTP-20",
      smsQuota: 20,
      amountBdt: 50,
      packageType: "otp",
      trxId: "TRXABC",
      requestedAt: 1791400000,
    },
  ];

  it("renders a pending row with amount, TrxID, and both actions", () => {
    const html = renderToString(
      <BillingQueueView
        pending={pending}
        onApprove={(): void => undefined}
        onReject={(): void => undefined}
      />,
    );
    expect(html).toContain("customer-app");
    expect(html).toContain("৳50");
    expect(html).toContain("TRXABC");
    expect(html).toContain('data-testid="approve-txn-1"');
    expect(html).toContain('data-testid="reject-txn-1"');
    expect(html).toContain("2026-10-07"); // requestedAt formatted UTC
  });

  it("renders the empty-queue message", () => {
    const html = renderToString(
      <BillingQueueView pending={[]} onApprove={(): void => undefined} onReject={(): void => undefined} />,
    );
    expect(html).toContain("Queue is empty");
  });
});

describe("AppsView", () => {
  const apps: AdminApp[] = [
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

  it("renders active vs revoked state with the matching action", () => {
    const html = renderToString(
      <AppsView apps={apps} onRevoke={(): void => undefined} onUnrevoke={(): void => undefined} />,
    );
    expect(html).toContain("live-app");
    expect(html).toContain("dead-app");
    expect(html).toContain('data-testid="revoke-row-1"');
    expect(html).toContain('data-testid="unrevoke-row-2"');
    expect(html).toContain("Active");
    expect(html).toContain("Revoked");
  });
});

describe("MetricsView", () => {
  const metrics: AdminMetrics = {
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
    billing: {
      transactionsPending: 2,
      transactionsApproved: 9,
      transactionsRejected: 1,
      creditsRows: 7,
    },
    webhooks: { deliveriesLast24h: 48, deliveredLast24h: 46, failedLast24h: 2 },
  };

  it("renders every metric group with exact numbers", () => {
    const html = renderToString(<MetricsView metrics={metrics} />);
    expect(html).toContain("Total: 7");
    expect(html).toContain("Revoked: 2");
    expect(html).toContain("Sessions: 120");
    expect(html).toContain("Campaigns: 6 (1 active)");
    expect(html).toContain("Sent: 500");
    expect(html).toContain("Pending: 2");
    expect(html).toContain("Approved: 9");
    expect(html).toContain("Delivered: 46");
    expect(html).toContain("Failed: 2");
  });
});

describe("CampaignsView", () => {
  const campaigns: OversightCampaign[] = [
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

  it("renders oversight rows with counts and status chip", () => {
    const html = renderToString(<CampaignsView campaigns={campaigns} />);
    expect(html).toContain("October promo");
    expect(html).toContain("customer-app");
    expect(html).toContain("chip sending");
    expect(html).toContain("1000");
    expect(html).toContain("400");
  });

  it("renders the empty-state message", () => {
    const html = renderToString(<CampaignsView campaigns={[]} />);
    expect(html).toContain("No campaigns.");
  });
});

describe("PaymentsView (F5)", () => {
  const config: MatchConfig = { toleranceBdt: 100, windowSec: 604800 };
  const candidate = (transactionId: string) => ({
    transactionId,
    appId: "app_1",
    packageCode: "otp100",
    amountBdt: 200,
    requestedAt: 1791400000,
    deltaBdt: 0,
    timeDeltaSec: 10,
  });
  const matched: PaymentSmsItem = {
    id: "p1",
    sender: "+8801613000000",
    provider: "bkash",
    txnId: "TRXPAID0001",
    amountBdt: 200,
    receivedAt: 1791400000,
    createdAt: 1791400000,
    matched: { transactionId: "txn-1", status: "approved", appId: "app_1" },
    candidates: [],
    ambiguous: false,
  };
  const ambiguous: PaymentSmsItem = {
    ...matched,
    id: "p2",
    txnId: "TRXAMB00002",
    matched: null,
    candidates: [candidate("txn-a"), candidate("txn-b")],
    ambiguous: true,
  };
  const single: PaymentSmsItem = {
    ...matched,
    id: "p3",
    txnId: "TRXSING0003",
    matched: null,
    candidates: [candidate("txn-c")],
    ambiguous: false,
  };
  const noop = {
    onConfigSave: (): void => undefined,
    onAttach: (): void => undefined,
  };

  it("renders the tunable parameters with their current values", () => {
    const html = renderToString(
      <PaymentsView config={config} payments={[]} error={null} note={null} busy={false} {...noop} />,
    );
    expect(html).toContain("Match parameters");
    expect(html).toContain('value="100"');
    expect(html).toContain('value="604800"');
    expect(html).toContain("Save parameters");
    expect(html).toContain("No payment SMS ingested yet.");
    expect(html).toContain("nothing about matching is hardcoded");
  });

  it("shows matched / ambiguous / single-candidate states with the explicit-choice guard", () => {
    const html = renderToString(
      <PaymentsView
        config={config}
        payments={[matched, ambiguous, single]}
        error={null}
        note={null}
        busy={false}
        {...noop}
      />,
    );
    expect(html).toContain("Matched → approved");
    expect(html).toContain("Ambiguous — 2 candidates");
    expect(html).toContain("1 candidate");
    expect(html).toContain("TRXPAID0001");
    expect(html).toContain("+8801613000000");
    // The ambiguous row's select starts on a disabled placeholder — no implicit pick.
    expect(html).toContain("Choose…");
    expect(html).toContain("txn-a");
    expect(html).toContain("txn-b");
    expect(html).toContain("Confirm");
  });

  it("renders an error banner and disables confirms while busy", () => {
    const html = renderToString(
      <PaymentsView
        config={config}
        payments={[single]}
        error="amount_out_of_tolerance"
        note={null}
        busy
        {...noop}
      />,
    );
    expect(html).toContain("amount_out_of_tolerance");
    expect(html).toContain("disabled");
  });
});

describe("PackagesView (F5)", () => {
  const packages: AdminPackage[] = [
    { packageCode: "otp100", name: "OTP 100", smsQuota: 100, priceBdt: 200, validityDays: 30, type: "otp", isActive: true },
    { packageCode: "old50", name: "Old 50", smsQuota: 50, priceBdt: 100, validityDays: 30, type: "bulk", isActive: false },
  ];
  const noop = {
    onCreate: (): void => undefined,
    onPatch: (): void => undefined,
    onToggleActive: (): void => undefined,
  };

  it("lists active and retired rows with edit fields and both lifecycle buttons", () => {
    const html = renderToString(
      <PackagesView packages={packages} error={null} note={null} busy={false} {...noop} />,
    );
    expect(html).toContain("Create package");
    expect(html).toContain("otp100");
    expect(html).toContain("old50");
    expect(html).toContain("Retired");
    expect(html).toContain("Active");
    expect(html).toContain("Retire");
    expect(html).toContain("Reactivate");
    expect(html).toContain('aria-label="price-old50"');
    expect(html).toContain('name="packageCode"');
  });

  it("shows the empty state", () => {
    const html = renderToString(
      <PackagesView packages={[]} error={null} note={null} busy={false} {...noop} />,
    );
    expect(html).toContain("No packages yet.");
  });
});

describe("UsersView (F5 withhold)", () => {
  const users: AdminUserItem[] = [
    {
      id: "u1",
      email: "held@example.test",
      disabled: true,
      createdAt: 1791400000,
      appCount: 1,
      apps: [{ id: "app-row", appId: "app_1", name: "My app", revoked: false }],
    },
    {
      id: "u2",
      email: "fine@example.test",
      disabled: false,
      createdAt: 1791400500,
      appCount: 0,
      apps: [],
    },
  ];
  const noop = { onToggle: (): void => undefined };

  it("shows withhold state, owned apps, and the distinct send code note", () => {
    const html = renderToString(<UsersView users={users} error={null} note={null} busy={false} {...noop} />);
    expect(html).toContain("held@example.test");
    expect(html).toContain("fine@example.test");
    expect(html).toContain("Withheld");
    expect(html).toContain("Active");
    expect(html).toContain("account_withheld");
    expect(html).toContain("Credits are never touched");
    expect(html).toContain("My app");
    // Withheld row gets Enable; active row gets Withhold.
    expect(html).toContain(">Enable<");
    expect(html).toContain(">Withhold<");
  });

  it("shows the empty state", () => {
    const html = renderToString(<UsersView users={[]} error={null} note={null} busy={false} {...noop} />);
    expect(html).toContain("No users yet.");
  });
});

describe("ReportsView (F5)", () => {
  const ledger: LedgerReport = {
    from: 1791000000,
    to: 1791500000,
    rows: [
      {
        transactionId: "t1",
        appId: "app_1",
        appName: "App One",
        ownerEmail: "cust@example.test",
        packageCode: "otp100",
        packageType: "otp",
        smsQuota: 100,
        amountBdt: 200,
        status: "approved",
        trxId: "TRXLEDGER1",
        requestedAt: 1791400000,
        resolvedAt: 1791400100,
        resolvedBy: "operator",
      },
    ],
    totals: [{ packageType: "otp", status: "approved", count: 1, amountBdt: 200, grantedSms: 100 }],
  };
  const sendRows: SendLogRow[] = [
    {
      messageId: "m1",
      appId: "app_1",
      appName: "App One",
      recipient: "+8801711111111",
      status: "sent",
      error: null,
      createdAt: 1791400000,
      resultAt: 1791400050,
      source: "otp",
      sourceId: "s1",
    },
  ];
  const noop = {
    onLedgerLoad: (): void => undefined,
    onSendLoad: (): void => undefined,
    onLedgerCsv: (): void => undefined,
    onSendCsv: (): void => undefined,
  };

  it("renders the ledger with customer identity, totals, and the CSV action", () => {
    const html = renderToString(
      <ReportsView ledger={ledger} sendRows={null} error={null} {...noop} />,
    );
    expect(html).toContain("Per-customer ledger");
    expect(html).toContain("cust@example.test");
    expect(html).toContain("TRXLEDGER1");
    expect(html).toContain("otp/approved: 1");
    expect(html).toContain("Download CSV");
  });

  it("renders the send log with recipient PII, source linkage, and the PII note", () => {
    const html = renderToString(
      <ReportsView ledger={null} sendRows={sendRows} error={null} {...noop} />,
    );
    expect(html).toContain("Item-wise send log");
    expect(html).toContain("Recipient numbers are PII");
    expect(html).toContain("CSV is the only export");
    expect(html).toContain("+8801711111111");
    expect(html).toContain("otp (s1)");
    // formatStatus capitalizes — assert the exact chip rendering.
    expect(html).toContain('<span class="chip approved">Sent</span>');
  });

  it("offers both CSV downloads", () => {
    const html = renderToString(
      <ReportsView ledger={ledger} sendRows={sendRows} error={null} {...noop} />,
    );
    expect(html.match(/Download CSV/g)).toHaveLength(2);
  });
});
