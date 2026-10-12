/**
 * ISSUE-96 — Unlimited BYOD plan screen. Shows the connected app's active
 * plan ("Devices: 1 / 1 active"), its bound devices with a confirmed delete
 * (the only way to free a slot), any pending purchase awaiting operator
 * approval, and the tier catalog with the bKash → TrxID checkout.
 *
 * Every stateful piece is a pure exported view for render tests; this file's
 * default export only owns fetching and the delete-confirmation state machine.
 */
import { useCallback, useEffect, useState } from "react";
import {
  deleteDevice,
  describeError,
  getSubscription,
  listDevices,
  listPlans,
  purchasePlan,
  submitPlanTrx,
  type BoundDevice,
  type PlanPurchaseAccepted,
  type PlanTier,
  type SubscriptionInfo,
} from "../api";
import { ErrorBanner } from "../components/ErrorBanner";
import { formatEpochUtc } from "../lib/format";

/** "Devices: 1 / 1 active" — the slot usage line; null limit = no plan. */
export function DeviceSlotsView(props: { active: number; limit: number | null }): JSX.Element {
  return (
    <p className="stat" data-testid="device-slots">
      Devices: {props.active} / {props.limit ?? "—"} active
    </p>
  );
}

/** Pure subscription card — plan name, expiry, slot usage. */
export function PlanStatusView(props: {
  subscription: SubscriptionInfo["subscription"];
  devices: SubscriptionInfo["devices"];
}): JSX.Element {
  const sub = props.subscription;
  return (
    <section className="card" data-testid="plan-status">
      <h2>Current plan</h2>
      {sub === null ? (
        <>
          <p className="muted">
            No unlimited plan — every send draws from your credit balance. Pick a tier below to
            cover sends from your own phones.
          </p>
          <DeviceSlotsView active={props.devices.active} limit={props.devices.limit} />
        </>
      ) : (
        <>
          <p className="stat">{sub.name}</p>
          <DeviceSlotsView active={props.devices.active} limit={props.devices.limit} />
          <p className="muted">
            {sub.active ? (
              <>
                Active until {formatEpochUtc(sub.expiresAt)}
              </>
            ) : (
              // Fail-closed state mirrors the server: expired plans charge
              // credits again until renewed.
              <>
                Expired on {formatEpochUtc(sub.expiresAt)} — sends now use credits until renewed.
              </>
            )}
          </p>
        </>
      )}
    </section>
  );
}

/**
 * Pure device list with an inline delete confirmation — no modal, no
 * window.confirm: the confirmation replaces the row's action area so the
 * destructive step is explicit and keyboard-reachable.
 */
export function DeviceListView(props: {
  devices: BoundDevice[];
  confirmingId: string | null;
  busyId: string | null;
  onConfirmDelete: (deviceId: string) => void;
  onAsk: (deviceId: string) => void;
  onCancel: () => void;
}): JSX.Element {
  if (props.devices.length === 0) {
    return (
      <section className="card">
        <h2>Devices</h2>
        <p className="muted">
          No phones enrolled yet. Enroll one with your app's device enrollment secret — it must be
          live before plan sends bypass credits.
        </p>
      </section>
    );
  }
  return (
    <section className="card">
      <h2>Devices</h2>
      {props.devices.map((device) => (
        <div className="pkg-row" key={device.deviceId} data-testid="device-row">
          <div>
            <strong>{device.label}</strong> {!device.active && <span className="chip">deleted</span>}
            <div className="pkg-meta">
              {device.phoneNumber ?? "no number"} · last seen{" "}
              {device.lastSeenAt === null ? "never" : formatEpochUtc(device.lastSeenAt)}
            </div>
          </div>
          {device.active &&
            (props.confirmingId === device.deviceId ? (
              <div className="inline-actions">
                <span className="muted">Delete this device? Its slot frees up.</span>
                <button
                  type="button"
                  data-testid={`confirm-delete-${device.deviceId}`}
                  disabled={props.busyId === device.deviceId}
                  onClick={(): void => props.onConfirmDelete(device.deviceId)}
                >
                  {props.busyId === device.deviceId ? "Deleting…" : "Yes, delete"}
                </button>
                <button type="button" className="secondary" onClick={props.onCancel}>
                  Keep
                </button>
              </div>
            ) : (
              <div className="inline-actions">
                <button
                  type="button"
                  data-testid={`delete-${device.deviceId}`}
                  onClick={(): void => props.onAsk(device.deviceId)}
                >
                  Delete device
                </button>
              </div>
            ))}
        </div>
      ))}
    </section>
  );
}

/** Pure tier catalog (mirrors BuyCredits' package list shape). */
export function PlanCatalogView(props: {
  plans: PlanTier[];
  onBuy: (plan: PlanTier) => void;
}): JSX.Element {
  return (
    <section className="card">
      <h2>Unlimited BYOD plans</h2>
      <p className="muted">
        Plans cover sends routed through <strong>your own phones</strong>. Dedicated Bangladesh
        numbers always use credit rates. Pay with bKash; the operator activates after approving
        your TrxID.
      </p>
      {props.plans.map((plan) => (
        <div className="pkg-row" key={plan.planCode} data-testid={`plan-${plan.planCode}`}>
          <div>
            <strong>{plan.name}</strong>
            <div className="pkg-meta">
              {plan.maxDevices} device{plan.maxDevices === 1 ? "" : "s"} · {plan.validityDays} days
              · code {plan.planCode}
            </div>
          </div>
          <div className="inline-actions">
            <span className="price">${plan.priceUsd}/mo</span>
            <button type="button" onClick={(): void => props.onBuy(plan)}>
              Buy
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}

/** Pure checkout: bKash destination + TrxID form (same flow as BuyCredits). */
export function PlanCheckoutView(props: {
  purchase: PlanPurchaseAccepted;
  note: string | null;
  error: string | null;
  onSubmitTrx: (trxId: string) => void;
  onBack: () => void;
}): JSX.Element {
  return (
    <div className="callout" data-testid="plan-checkout">
      <h2>Pay with bKash</h2>
      <p>
        Send <span className="big">${props.purchase.priceUsd}</span> ({props.purchase.bkashNote}) to{" "}
        <span className="big mono">{props.purchase.bkashNumber}</span>
      </p>
      <p className="muted">
        Purchase <code>{props.purchase.subscriptionId}</code> stays pending until the operator
        approves your TrxID.
      </p>
      {props.note !== null && <p className="ok-note">{props.note}</p>}
      {props.error !== null && <ErrorBanner message={props.error} />}
      <form
        onSubmit={(e): void => {
          e.preventDefault();
          const trxId = String(new FormData(e.currentTarget).get("trxId") ?? "").trim();
          if (trxId !== "") props.onSubmitTrx(trxId);
        }}
      >
        <label htmlFor="planTrxId">bKash TrxID</label>
        <input id="planTrxId" name="trxId" required spellCheck={false} placeholder="e.g. 9F2K7QX1M" />
        <div className="inline-actions mt-14">
          <button type="submit">Submit TrxID</button>
          <button type="button" className="secondary" onClick={props.onBack}>
            Back to plans
          </button>
        </div>
      </form>
    </div>
  );
}

/** Plan screen container: slots, devices + confirmed delete, purchase flow. */
export function Plan(): JSX.Element {
  const [info, setInfo] = useState<SubscriptionInfo | null>(null);
  const [devices, setDevices] = useState<BoundDevice[]>([]);
  const [plans, setPlans] = useState<PlanTier[]>([]);
  const [checkout, setCheckout] = useState<PlanPurchaseAccepted | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const load = useCallback((): void => {
    setLoading(true);
    Promise.all([getSubscription(), listDevices(), listPlans()])
      .then(([infoRes, deviceRows, planRows]) => {
        setInfo(infoRes);
        setDevices(deviceRows);
        setPlans(planRows);
        setError(null);
      })
      .catch((err: unknown) => setError(describeError(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const ask = (deviceId: string): void => {
    setError(null);
    setConfirmingId(deviceId);
  };

  const confirmDelete = (deviceId: string): void => {
    setBusyId(deviceId);
    deleteDevice(deviceId)
      .then(() => {
        setConfirmingId(null);
        load();
      })
      .catch((err: unknown) => setError(describeError(err)))
      .finally(() => setBusyId(null));
  };

  const buy = (plan: PlanTier): void => {
    setError(null);
    setNote(null);
    purchasePlan(plan.planCode)
      .then(setCheckout)
      .catch((err: unknown) => setError(describeError(err)));
  };

  const submitTrxId = (trxId: string): void => {
    if (checkout === null) return;
    setError(null);
    submitPlanTrx(checkout.subscriptionId, trxId)
      .then((message) => {
        setNote(message);
        setCheckout(null);
        load();
      })
      .catch((err: unknown) => setError(describeError(err)));
  };

  return (
    <>
      <div className="page-head">
        <h1>Unlimited plan</h1>
        <button type="button" onClick={load} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {error !== null && <ErrorBanner message={error} />}
      {info !== null && (
        <>
          <PlanStatusView subscription={info.subscription} devices={info.devices} />
          {info.pending !== null && (
            <p className="muted" data-testid="plan-pending">
              Purchase of {info.pending.planCode} awaiting approval
              {info.pending.trxId === null ? " — submit its TrxID below." : ` (TrxID ${info.pending.trxId}).`}
            </p>
          )}
        </>
      )}
      {checkout !== null ? (
        <PlanCheckoutView
          purchase={checkout}
          note={note}
          error={error}
          onSubmitTrx={submitTrxId}
          onBack={(): void => setCheckout(null)}
        />
      ) : (
        <PlanCatalogView plans={plans} onBuy={buy} />
      )}
      <DeviceListView
        devices={devices}
        confirmingId={confirmingId}
        busyId={busyId}
        onConfirmDelete={confirmDelete}
        onAsk={ask}
        onCancel={(): void => setConfirmingId(null)}
      />
    </>
  );
}
