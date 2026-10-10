import { describe, expect, it } from "vitest";
import { renderToString as renderToRawString } from "react-dom/server";
import type {
  AdminApp,
  AdminDeviceItem,
  AdminDeviceList,
  AdminMetrics,
  AdminPackage,
  AdminUserItem,
  LedgerReport,
  OversightCampaign,
  PackageReport,
  PaymentSmsItem,
  PendingTransaction,
  SendLogRow,
} from "../src/api";
import {
  AppsView,
  BillingQueueView,
  CampaignsView,
  DevicesView,
  MetricsView,
  PackagesView,
  PaymentsView,
  ReportsView,
  SettingsView,
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
      currency: "BDT",
      trxId: "TRXABC",
      requestedAt: 1791400000,
    },
  ];

  it("renders a non-BDT pending row in its own currency, never ৳ (ISSUE-89)", () => {
    const usdPending: PendingTransaction[] = [
      {
        transactionId: "txn-usd",
        appId: "customer-app",
        packageCode: "usd-50",
        smsQuota: 50,
        amountBdt: 20,
        packageType: "otp",
        currency: "USD",
        trxId: null,
        requestedAt: 1791400000,
      },
    ];
    const html = renderToString(
      <BillingQueueView
        pending={usdPending}
        onApprove={(): void => undefined}
        onReject={(): void => undefined}
      />,
    );
    expect(html).toContain("20 USD");
    expect(html).not.toContain("৳20");
  });

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

describe("PaymentsView (F5b spec)", () => {
  const pendingQueue: PendingTransaction[] = [
    {
      transactionId: "txn-c",
      appId: "app_1",
      packageCode: "otp100",
      smsQuota: 100,
      amountBdt: 200,
      packageType: "otp",
      currency: "BDT",
      trxId: "TRXSEARCH1",
      requestedAt: 1791400000,
    },
  ];
  const candidate = (transactionId: string) => ({
    transactionId,
    appId: "app_1",
    packageCode: "otp100",
    amountBdt: 200,
    requestedAt: 1791400000,
    deltaBdt: 0,
    timeDeltaSec: 10,
  });
  const approved: PaymentSmsItem = {
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
  const ambiguous: PaymentSmsItem = {
    ...approved,
    id: "p2",
    txnId: "TRXAMB00002",
    status: "unmatched",
    matched: null,
    candidates: [candidate("txn-a"), candidate("txn-b")],
    ambiguous: true,
  };
  const single: PaymentSmsItem = {
    ...approved,
    id: "p3",
    txnId: "TRXSING0003",
    status: "matched",
    matched: null,
    candidates: [candidate("txn-c")],
    ambiguous: false,
  };
  const rejected: PaymentSmsItem = {
    ...approved,
    id: "p4",
    txnId: "TRXREJ00004",
    status: "rejected",
    reason: "duplicate ingestion",
    matched: null,
    candidates: [],
    ambiguous: false,
  };
  const base = {
    pending: pendingQueue,
    filters: { status: "all", from: "", to: "" },
    error: null,
    note: null,
    busy: false,
  };
  const noop = {
    onFilter: (): void => undefined,
    onApprove: (): void => undefined,
    onReject: (): void => undefined,
    onAttach: (): void => undefined,
  };

  it("renders the spec filters (status + received window) and the empty state", () => {
    const html = renderToString(<PaymentsView payments={[]} {...base} {...noop} />);
    expect(html).toContain('id="payStatus"');
    expect(html).toContain('value="matched"');
    expect(html).toContain("Matched (proposed)");
    expect(html).toContain('id="payFrom"');
    expect(html).toContain('id="payTo"');
    expect(html).toContain("Apply");
    expect(html).toContain("No payment SMS ingested yet.");
    // The match-parameter editor moved to the Settings tab.
    expect(html).toContain("Settings");
    expect(html).not.toContain("Save parameters");
  });

  it("shows spec match states, stored reasons, and per-status actions", () => {
    const html = renderToString(
      <PaymentsView payments={[approved, ambiguous, single, rejected]} {...base} {...noop} />,
    );
    // matched (proposed) → one-click Approve + Reject; unmatched → Reject + attach picker.
    expect(html).toContain('data-testid="pay-approve-p3"');
    expect(html).toContain('data-testid="pay-reject-p3"');
    expect(html).toContain('data-testid="pay-reject-p2"');
    // Terminal rows (approved/rejected) carry no actions.
    expect(html).not.toContain('data-testid="pay-approve-p1"');
    expect(html).not.toContain('data-testid="pay-reject-p4"');
    // The stored reject reason is shown on the row (spec).
    expect(html).toContain("duplicate ingestion");
    expect(html).toContain("Matched (proposed)");
    expect(html).toContain("candidates, choose explicitly");
    expect(html).toContain("TRXPAID0001");
    expect(html).toContain("+8801613000000");
    // Attach picker: search by TrxID + candidate list, no implicit pick.
    expect(html).toContain('aria-label="search-trx-TRXAMB00002"');
    expect(html).toContain("Choose…");
    expect(html).toContain("txn-a");
    expect(html).toContain("txn-b");
    expect(html).toContain("Confirm");
  });

  it("renders an error banner and disables actions while busy", () => {
    const html = renderToString(
      <PaymentsView payments={[single]} {...base} error="payment_rejected" busy {...noop} />,
    );
    expect(html).toContain("payment_rejected");
    expect(html).toContain("disabled");
  });

  it("renders the STAGE F8 source column for gateway and reader rows", () => {
    const reader: PaymentSmsItem = {
      ...approved,
      id: "p5",
      source: "reader",
      txnId: "TRXREAD005",
      status: "unmatched",
      matched: null,
      candidates: [],
      ambiguous: false,
    };
    const html = renderToString(
      <PaymentsView payments={[approved, reader]} {...base} {...noop} />,
    );
    expect(html).toContain("<th>Source</th>");
    expect(html).toContain(">gateway<");
    expect(html).toContain(">reader<");
  });
});

describe("SettingsView (F5b spec)", () => {
  it("renders the two whitelisted keys with their current values", () => {
    const html = renderToString(
      <SettingsView
        values={{ windowMin: 30, toleranceBdt: 0 }}
        error={null}
        note={null}
        busy={false}
        onSave={(): void => undefined}
      />,
    );
    expect(html).toContain("Payment matching");
    expect(html).toContain('id="setWindow"');
    expect(html).toContain('value="30"');
    expect(html).toContain('id="setTolerance"');
    expect(html).toContain("payment_match_window_min");
    expect(html).toContain("payment_match_tolerance_bdt");
    expect(html).toContain("Save settings");
  });

  it("keeps save disabled until the keys have loaded", () => {
    const html = renderToString(
      <SettingsView
        values={{ windowMin: null, toleranceBdt: null }}
        error={null}
        note={null}
        busy={false}
        onSave={(): void => undefined}
      />,
    );
    expect(html).toContain("disabled");
  });
});

describe("PackagesView (F5)", () => {
  const packages: AdminPackage[] = [
    { packageCode: "otp100", name: "OTP 100", smsQuota: 100, priceBdt: 200, validityDays: 30, type: "otp", isActive: true, currency: "BDT" },
    { packageCode: "old50", name: "Old 50", smsQuota: 50, priceBdt: 100, validityDays: 30, type: "bulk", isActive: false, currency: "USD" },
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

  it("states the price currency on every row and in the create form (ISSUE-89)", () => {
    const html = renderToString(
      <PackagesView packages={packages} error={null} note={null} busy={false} {...noop} />,
    );
    // Create form: a currency selector defaulting to BDT, not a BDT-hardcoded price.
    expect(html).toContain('id="pkgCurrency"');
    expect(html).toContain('<option value="BDT">BDT</option>');
    expect(html).toContain('<option value="USD">USD</option>');
    expect(html).toContain('<option value="EUR">EUR</option>');
    // Per-row select reflects the stored currency (old50 is priced in USD).
    expect(html).toContain('aria-label="currency-old50"');
    expect(html).toContain("Currency");
    // The old "Price (BDT)" hard label is gone.
    expect(html).not.toContain("Price (BDT)");
  });

  it("emits a package-code pattern that compiles under the regex v flag (ISSUE-89)", () => {
    const html = renderToString(
      <PackagesView packages={[]} error={null} note={null} busy={false} {...noop} />,
    );
    const match = html.match(/pattern="([^"]*)"/);
    expect(match).not.toBeNull();
    const source = (match as RegExpMatchArray)[1];

    // Chromium compiles the HTML pattern attribute with the `v` (unicodeSets)
    // flag since v112: an unescaped `-` inside the class made the attribute a
    // SyntaxError — the console logged an error and client-side validation
    // silently never ran. The escaped hyphen keeps the class valid under v.
    // HTML anchors the expression implicitly: ^(?:pattern)$ against the value.
    const compile = (): RegExp => new RegExp(`^(?:${source})$`, "v");
    expect(compile).not.toThrow();
    const re = compile();

    // Same acceptance set as the server's PACKAGE_CODE_PATTERN.
    expect(re.test("otp100")).toBe(true);
    expect(re.test("a_B-9")).toBe(true);
    expect(re.test("UPPER-1")).toBe(true);
    expect(re.test("ab cd")).toBe(false);
    expect(re.test("bad!chars")).toBe(false);
    expect(re.test("a")).toBe(false);
    expect(re.test("x".repeat(65))).toBe(false);
    expect(re.test("")).toBe(false);
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
  const noop = { onToggle: (): void => undefined };

  it("shows withhold state with the stored reason, owned apps, and the distinct send code note", () => {
    const html = renderToString(<UsersView users={users} error={null} note={null} busy={false} {...noop} />);
    expect(html).toContain("held@example.test");
    expect(html).toContain("fine@example.test");
    expect(html).toContain("Withheld");
    expect(html).toContain("Active");
    expect(html).toContain("account_withheld");
    expect(html).toContain("Credits are never touched");
    expect(html).toContain("My app");
    // Spec: badge + reason tooltip/text on the withheld row.
    expect(html).toContain("chargeback investigation");
    expect(html).toContain('title="chargeback investigation"');
    // Withheld row gets Enable; active row gets Withhold.
    expect(html).toContain(">Enable<");
    expect(html).toContain(">Withhold<");
  });

  it("shows the empty state", () => {
    const html = renderToString(<UsersView users={[]} error={null} note={null} busy={false} {...noop} />);
    expect(html).toContain("No users yet.");
  });
});

describe("ReportsView (F5b spec)", () => {
  const ledger: LedgerReport = {
    from: 1791000000,
    to: 1791500000,
    rows: [
      {
        id: "row-1",
        timestamp: 1791400000,
        appId: "app_owned",
        appName: "App One",
        ownerEmail: "cust@example.test",
        kind: "purchase",
        packageCode: "otp100",
        qty: 100,
        amountBdt: 200,
        currency: "BDT",
        trxId: "TRXLEDGER1",
      },
      {
        id: "app_owned:spend-otp:1791300000",
        timestamp: 1791300000,
        appId: "app_owned",
        appName: "App One",
        ownerEmail: null,
        kind: "spend-otp",
        packageCode: "",
        qty: 3,
        amountBdt: 0.6000000000000001,
        currency: "BDT",
        trxId: null,
      },
    ],
    nextCursor: "1791300000:row-1",
    totals: [{ packageType: "otp", status: "approved", currency: "BDT", count: 1, amountBdt: 200, grantedSms: 100 }],
  };
  const sendRows: SendLogRow[] = [
    {
      timestamp: 1791400000,
      messageId: "m1",
      appId: "app_owned",
      appName: "App One",
      kind: "otp",
      recipient: "+8801711111111",
      ref: "s1",
      status: "sent",
      campaignName: null,
      error: null,
      resultAt: 1791400050,
    },
    {
      timestamp: 1791390000,
      messageId: "m2",
      appId: "app_owned",
      appName: "App One",
      kind: "bulk",
      recipient: "+8801712222222",
      ref: "c9",
      status: "failed",
      campaignName: "October blast",
      error: "carrier_rejected",
      resultAt: null,
    },
  ];
  const noop = {
    onLedgerLoad: (): void => undefined,
    onLedgerMore: (): void => undefined,
    // ISSUE-89 package-aggregate report: unloaded by default (like the ledger).
    pkgReport: null as PackageReport | null,
    onPkgLoad: (): void => undefined,
    onSendLoad: (): void => undefined,
    onSendMore: (): void => undefined,
    onLedgerCsv: (): void => undefined,
    onSendCsv: (): void => undefined,
  };

  it("renders the ledger with spec columns (kind/qty), totals, cursor paging, and the CSV action", () => {
    const html = renderToString(
      <ReportsView ledger={ledger} sendRows={null} sendNextCursor={null} error={null} {...noop} />,
    );
    expect(html).toContain("Per-customer ledger");
    // Customer identity rides the app-cell tooltip (spec columns stay exact).
    expect(html).toContain("cust@example.test");
    expect(html).toContain("TRXLEDGER1");
    expect(html).toContain("purchase");
    expect(html).toContain("spend-otp");
    expect(html).toContain("otp/approved BDT: 1");
    expect(html).toContain("Download CSV");
    // Spec filter: appId alongside the date range.
    expect(html).toContain('id="ledgerApp"');
    // nextCursor present → Load more (cursor pagination, max 100/page server-side).
    expect(html).toContain("Load more");
  });

  it("prices ledger rows and totals in their own currency (ISSUE-89)", () => {
    const usdLedger: LedgerReport = {
      ...ledger,
      rows: [{ ...ledger.rows[0], packageCode: "usd-pack", amountBdt: 20, currency: "USD" }],
      totals: [{ packageType: "otp", status: "approved", currency: "USD", count: 1, amountBdt: 20, grantedSms: 50 }],
    };
    const html = renderToString(
      <ReportsView ledger={usdLedger} sendRows={null} sendNextCursor={null} error={null} {...noop} />,
    );
    expect(html).toContain("20 USD");
    expect(html).not.toContain("৳20");
    // Totals are currency-dimensioned: the bucket names its unit.
    expect(html).toContain("otp/approved USD: 1 (20 USD, 50 SMS granted)");
  });

  it("hides Load more when the report is exhausted", () => {
    const html = renderToString(
      <ReportsView
        ledger={{ ...ledger, nextCursor: null }}
        sendRows={null}
        sendNextCursor={null}
        error={null}
        {...noop}
      />,
    );
    expect(html).not.toContain("Load more");
  });

  it("renders the send log with spec columns (kind/ref/campaign), PII note, and status chip", () => {
    const html = renderToString(
      <ReportsView ledger={null} sendRows={sendRows} sendNextCursor="1791390000:m2" error={null} {...noop} />,
    );
    expect(html).toContain("Item-wise send log");
    expect(html).toContain("Recipient numbers are PII");
    expect(html).toContain("CSV is the only export");
    expect(html).toContain("+8801711111111");
    expect(html).toContain("October blast");
    expect(html).toContain("c9");
    // formatStatus capitalizes — assert the exact chip rendering.
    expect(html).toContain('<span class="chip approved">Sent</span>');
    // Failed row surfaces its error as the chip tooltip (column set is the spec's).
    expect(html).toContain('title="carrier_rejected"');
    expect(html).toContain("Load more");
  });

  it("offers both CSV downloads", () => {
    const html = renderToString(
      <ReportsView ledger={ledger} sendRows={sendRows} sendNextCursor={null} error={null} {...noop} />,
    );
    expect(html.match(/Download CSV/g)).toHaveLength(2);
  });

  it("renders the package-aggregate report currency-dimensioned (ISSUE-89)", () => {
    const pkgReport: PackageReport = {
      from: 1791000000,
      to: 1791500000,
      rows: [
        {
          packageCode: "bdt-pack",
          name: "BDT Pack",
          currency: "BDT",
          countSold: 2,
          totalAmount: 400,
          smsSold: 200,
          firstSoldAt: 1791100000,
          lastSoldAt: 1791400000,
        },
        {
          packageCode: "usd-pack",
          name: "USD Pack",
          currency: "USD",
          countSold: 1,
          totalAmount: 20,
          smsSold: 50,
          firstSoldAt: 1791200000,
          lastSoldAt: 1791200000,
        },
      ],
      totalsByCurrency: [
        { currency: "BDT", countSold: 2, totalAmount: 400 },
        { currency: "USD", countSold: 1, totalAmount: 20 },
      ],
    };
    const html = renderToString(
      <ReportsView ledger={null} sendRows={null} sendNextCursor={null} error={null} {...noop} pkgReport={pkgReport} />,
    );
    expect(html).toContain("Package sales (aggregated)");
    expect(html).toContain('id="pkgReportForm"');
    // Per-currency rows: a USD total must never render with the taka symbol.
    expect(html).toContain(">bdt-pack<");
    expect(html).toContain(">usd-pack<");
    expect(html).toContain(">৳400<");
    expect(html).toContain(">20 USD<");
    // Rollup line keeps currencies separate (never summed across).
    expect(html).toContain("BDT: 2 sold · ৳400");
    expect(html).toContain("USD: 1 sold · 20 USD");
  });

  it("shows the empty state for a window with no approved sales", () => {
    const html = renderToString(
      <ReportsView
        ledger={null}
        sendRows={null}
        sendNextCursor={null}
        error={null}
        {...noop}
        pkgReport={{ from: 1, to: 2, rows: [], totalsByCurrency: [] }}
      />,
    );
    expect(html).toContain("No approved sales in this window.");
  });
});

describe("DevicesView (STAGE F7)", () => {
  const device: AdminDeviceItem = {
    id: "dev-1",
    label: "Redmi 9",
    userId: null,
    createdAt: 1791400000,
    lastSeenAt: 1791403600,
    secondsSinceSeen: 60,
    neverSeen: false,
    stale: false,
    revocable: true,
    revokedAt: null,
    quarantined: false,
    quarantinedAt: null,
    phoneNumber: "+8801613249520",
    boundAppId: "app_money",
    boundAppName: "Money app",
  };
  const fleetDevice: AdminDeviceItem = {
    ...device,
    id: "dev-2",
    label: "Spare",
    lastSeenAt: null,
    neverSeen: true,
    stale: true,
    phoneNumber: null,
    boundAppId: null,
    boundAppName: null,
  };
  const list: AdminDeviceList = {
    staleThresholdSec: 900,
    total: 2,
    staleCount: 1,
    neverSeenCount: 1,
    quarantinedCount: 0,
    devices: [device, fleetDevice],
  };
  const apps: AdminApp[] = [
    {
      id: "row-1",
      appId: "app_money",
      name: "Money app",
      webhookUrl: null,
      rateMaxPerPhone: 3,
      rateWindowSec: 3600,
      createdAt: 1791400000,
      revokedAt: null,
    },
  ];
  const noop = { error: null, note: null, busy: false, onBind: (): void => undefined };

  it("renders the ordered identity columns: number | bound-app | last-seen", () => {
    const html = renderToString(<DevicesView list={list} apps={apps} {...noop} />);
    expect(html).toContain("+8801613249520");
    expect(html).toContain("app_money");
    expect(html).toContain("2026-10-07"); // lastSeenAt formatted UTC
    expect(html).toContain("fleet (unbound)");
    expect(html).toContain("never"); // dev-2 has no heartbeat
    expect(html).toContain("2 devices · 1 stale · 1 never seen · 0 quarantined");
    // Bound device select carries the app as an option plus the sr-only label.
    expect(html).toContain("— fleet (unbound) —");
    expect(html).toContain("app_money (Money app)");
    expect(html).toContain("Bind device Redmi 9 to an app");
  });

  it("marks revoked/stale state distinctly and shows the empty state", () => {
    const html = renderToString(<DevicesView list={list} apps={apps} {...noop} />);
    // Stale chip carries the seconds-since-heartbeat tooltip.
    expect(html).toContain('<span class="chip rejected" title="60s since last heartbeat">stale</span>');

    const empty = renderToString(
      <DevicesView list={{ ...list, devices: [] }} apps={apps} {...noop} />,
    );
    expect(empty).toContain("No devices enrolled yet.");
  });
});
