/**
 * ISSUE-96 — Unlimited BYOD plan screen render tests (node environment,
 * react-dom/server, same normalization as screens.test.tsx). Covers: the
 * "Devices: X / Y active" slot line, expired-plan fail-closed copy, the
 * inline delete confirmation state machine, the tier catalog, and the
 * bKash → TrxID checkout.
 */
import { describe, expect, it } from "vitest";
import { renderToString as renderToRawString } from "react-dom/server";
import type { BoundDevice, PlanPurchaseAccepted, PlanTier, SubscriptionInfo } from "../src/api";
import {
  DeviceListView,
  DeviceSlotsView,
  PlanCatalogView,
  PlanCheckoutView,
  PlanStatusView,
} from "../src/screens/Plan";

/** Strip React's `<!-- -->` text separators (see screens.test.tsx). */
const render = (el: JSX.Element): string => renderToRawString(el).replace(/<!-- -->/g, "");

const NOOP = (): void => undefined;

const ACTIVE_SUB: NonNullable<SubscriptionInfo["subscription"]> = {
  subscriptionId: "sub-1",
  planCode: "unlimited_1",
  name: "Unlimited BYOD 1 phone",
  maxDevices: 1,
  priceUsd: 16,
  startsAt: 1790000000,
  expiresAt: 1792592000,
  active: true,
};

const TIERS: PlanTier[] = [
  { planCode: "unlimited_1", name: "Unlimited BYOD 1 phone", maxDevices: 1, priceUsd: 16, validityDays: 30 },
  { planCode: "unlimited_5", name: "Unlimited BYOD 5 phones", maxDevices: 5, priceUsd: 49, validityDays: 30 },
];

const LIVE_DEVICE: BoundDevice = {
  deviceId: "dev-1",
  label: "Pixel 7",
  phoneNumber: "+8801711000001",
  lastSeenAt: 1790000500,
  enrolledAt: 1789990000,
  active: true,
};

const PURCHASE: PlanPurchaseAccepted = {
  subscriptionId: "sub-9",
  planCode: "unlimited_1",
  priceUsd: 16,
  bkashNumber: "+8801711000000",
  bkashNote: "Send Money",
};

describe("DeviceSlotsView", () => {
  it("renders the exact slots line the spec asks for", () => {
    const html = render(<DeviceSlotsView active={1} limit={1} />);
    expect(html).toContain("Devices: 1 / 1 active");
  });

  it("renders an em-dash limit when no plan caps the slots", () => {
    const html = render(<DeviceSlotsView active={3} limit={null} />);
    expect(html).toContain("Devices: 3 / — active");
  });
});

describe("PlanStatusView", () => {
  it("shows the plan name, slots and expiry for an active plan", () => {
    const html = render(
      <PlanStatusView subscription={ACTIVE_SUB} devices={{ active: 1, limit: 1 }} />,
    );
    expect(html).toContain("Unlimited BYOD 1 phone");
    expect(html).toContain("Devices: 1 / 1 active");
    expect(html).toContain("Active until");
    expect(html).not.toContain("Expired on");
  });

  it("shows the fail-closed copy for an expired plan", () => {
    const html = render(
      <PlanStatusView
        subscription={{ ...ACTIVE_SUB, active: false }}
        devices={{ active: 1, limit: 1 }}
      />,
    );
    expect(html).toContain("Expired on");
    expect(html).toContain("sends now use credits until renewed");
  });

  it("explains the no-plan state", () => {
    const html = render(<PlanStatusView subscription={null} devices={{ active: 0, limit: null }} />);
    expect(html).toContain("No unlimited plan");
    expect(html).toContain("Devices: 0 / — active");
  });
});

describe("DeviceListView", () => {
  it("lists live devices and does NOT show delete confirmations until asked", () => {
    const html = render(
      <DeviceListView
        devices={[LIVE_DEVICE]}
        confirmingId={null}
        busyId={null}
        onConfirmDelete={NOOP}
        onAsk={NOOP}
        onCancel={NOOP}
      />,
    );
    expect(html).toContain("Pixel 7");
    expect(html).toContain('data-testid="delete-dev-1"');
    // The destructive button must not exist before the ask — one click never deletes.
    expect(html).not.toContain("Yes, delete");
    expect(html).not.toContain("Delete this device?");
  });

  it("replaces the action area with the confirmation when asking", () => {
    const html = render(
      <DeviceListView
        devices={[LIVE_DEVICE]}
        confirmingId="dev-1"
        busyId={null}
        onConfirmDelete={NOOP}
        onAsk={NOOP}
        onCancel={NOOP}
      />,
    );
    expect(html).toContain("Delete this device? Its slot frees up.");
    expect(html).toContain('data-testid="confirm-delete-dev-1"');
    expect(html).toContain("Keep");
    // The plain delete button is replaced, not stacked.
    expect(html).not.toContain('data-testid="delete-dev-1"');
  });

  it("marks deleted devices and hides their actions", () => {
    const html = render(
      <DeviceListView
        devices={[{ ...LIVE_DEVICE, active: false }]}
        confirmingId={null}
        busyId={null}
        onConfirmDelete={NOOP}
        onAsk={NOOP}
        onCancel={NOOP}
      />,
    );
    expect(html).toContain("deleted");
    expect(html).not.toContain('data-testid="delete-dev-1"');
    expect(html).not.toContain("Yes, delete");
  });

  it("renders the empty state with enrollment guidance", () => {
    const html = render(
      <DeviceListView
        devices={[]}
        confirmingId={null}
        busyId={null}
        onConfirmDelete={NOOP}
        onAsk={NOOP}
        onCancel={NOOP}
      />,
    );
    expect(html).toContain("No phones enrolled yet");
    expect(html).toContain("device enrollment secret");
  });
});

describe("PlanCatalogView", () => {
  it("renders each tier with price and max devices", () => {
    const html = render(<PlanCatalogView plans={TIERS} onBuy={NOOP} />);
    expect(html).toContain('data-testid="plan-unlimited_1"');
    expect(html).toContain('data-testid="plan-unlimited_5"');
    expect(html).toContain("$16/mo");
    expect(html).toContain("$49/mo");
    expect(html).toContain("1 device · 30 days");
    expect(html).toContain("5 devices · 30 days");
    // Route separation copy: BD numbers always pay credits.
    expect(html).toContain("Dedicated Bangladesh numbers always use credit rates");
  });
});

describe("PlanCheckoutView", () => {
  it("renders the bKash destination, amount and the TrxID form", () => {
    const html = render(
      <PlanCheckoutView purchase={PURCHASE} note={null} error={null} onSubmitTrx={NOOP} onBack={NOOP} />,
    );
    expect(html).toContain("$16");
    expect(html).toContain("Send Money");
    expect(html).toContain("+8801711000000");
    expect(html).toContain('id="planTrxId"');
    expect(html).toContain("stays pending until the operator");
  });

  it("surfaces the submission note when the TrxID was accepted", () => {
    const html = render(
      <PlanCheckoutView
        purchase={PURCHASE}
        note="TrxID submitted. Awaiting operator approval."
        error={null}
        onSubmitTrx={NOOP}
        onBack={NOOP}
      />,
    );
    expect(html).toContain("TrxID submitted. Awaiting operator approval.");
  });
});
