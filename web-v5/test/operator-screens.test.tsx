import { describe, expect, it } from "vitest";
import { renderToString as renderToRawString } from "react-dom/server";
import type { AdminApp, AdminMetrics, OversightCampaign, PendingTransaction } from "../src/api";
import {
  AppsView,
  BillingQueueView,
  CampaignsView,
  MetricsView,
  UnlockView,
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
