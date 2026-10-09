import { useEffect, useState } from "react";
import {
  describeError,
  listPackages,
  requestWalletCredits,
  submitWalletTrx,
  type CreditPackage,
  type CreditRequestAccepted,
} from "../api";
import { ErrorBanner } from "../components/ErrorBanner";
import { formatPrice } from "../format";

/** Pure package list — exported for render tests. */
export function PackageListView(props: {
  packages: CreditPackage[];
  onBuy: (pkg: CreditPackage) => void;
}): JSX.Element {
  return (
    <div className="card">
      <h1>
        Buy credits <span className="muted">— pay with bKash</span>
      </h1>
      <p className="muted">
        Purchases top up your <strong>wallet</strong> — the one balance every company you own
        sends from.
      </p>
      <p className="muted">
        Sending money from abroad? See the <a href="#/payment">payment guide</a> (TapTap Send,
        Remitly, Wise, Western Union, WorldRemit).
      </p>
      {props.packages.length === 0 ? (
        <p className="muted">No active packages — ask the operator to publish one.</p>
      ) : (
        props.packages.map((pkg) => (
          <div className="pkg-row" key={pkg.packageCode}>
            <div>
              <strong>{pkg.name}</strong>{" "}
              <span className="chip">{pkg.type}</span>
              <div className="pkg-meta">
                {pkg.smsQuota} SMS · valid {pkg.validityDays} days · code {pkg.packageCode}
              </div>
            </div>
            <div className="inline-actions">
              <span className="price">{formatPrice(pkg.priceBdt, pkg.currency)}</span>
              <button type="button" onClick={(): void => props.onBuy(pkg)}>
                Buy
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

/**
 * Pure checkout view: the bKash destination + amount returned by
 * POST /v5/billing/credits/request, then the TrxID form for submit-trx.
 */
export function CheckoutView(props: {
  request: CreditRequestAccepted;
  note: string | null;
  error: string | null;
  /** ISSUE-89: selected package's price currency; defaults to BDT when unknown. */
  currency?: string;
  onSubmitTrx: (trxId: string) => void;
  onBack: () => void;
}): JSX.Element {
  return (
    <div className="callout" data-testid="checkout">
      <h2>Pay with bKash</h2>
      <p>
        Send <span className="big">{formatPrice(props.request.amountBdt, props.currency ?? "BDT")}</span> (
        {props.request.bkashNote}) to{" "}
        <span className="big mono">{props.request.bkashNumber}</span>
      </p>
      <p className="muted">
        Transaction <code>{props.request.transactionId}</code> stays pending until the operator
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
        <label htmlFor="trxId">bKash TrxID</label>
        <input id="trxId" name="trxId" required spellCheck={false} placeholder="e.g. 9F2K7QX1M" />
        <div className="inline-actions" style={{ marginTop: 14 }}>
          <button type="submit">Submit TrxID</button>
          <button type="button" className="secondary" onClick={props.onBack}>
            Back to packages
          </button>
        </div>
      </form>
    </div>
  );
}

/** Buy-credits flow: packages → bKash destination → TrxID submission. */
export function BuyCredits(): JSX.Element {
  const [packages, setPackages] = useState<CreditPackage[] | null>(null);
  const [checkout, setCheckout] = useState<CreditRequestAccepted | null>(null);
  // ISSUE-89: the checkout amount only makes sense next to its currency —
  // the request response does not carry one, so the selected package does.
  const [checkoutCurrency, setCheckoutCurrency] = useState<string>("BDT");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listPackages()
      .then(setPackages)
      .catch((err: unknown) => setError(describeError(err)));
  }, []);

  // STAGE F9 (ISSUE-88): the buy flow is SESSION-authenticated — the
  // purchase lands on the user wallet, no connected app required.
  const buy = (pkg: CreditPackage): void => {
    setError(null);
    setNote(null);
    setCheckoutCurrency(pkg.currency);
    requestWalletCredits(pkg.packageCode)
      .then((accepted) => setCheckout(accepted))
      .catch((err: unknown) => setError(describeError(err)));
  };

  const submitTrxId = (trxId: string): void => {
    if (checkout === null) return;
    setError(null);
    submitWalletTrx(checkout.transactionId, trxId)
      .then((message) => setNote(message))
      .catch((err: unknown) => setError(describeError(err)));
  };

  return (
    <>
      <div className="page-head">
        <h1>Buy credits</h1>
      </div>
      {error !== null && checkout === null && <ErrorBanner message={error} />}
      {checkout !== null ? (
        <CheckoutView
          request={checkout}
          note={note}
          error={error}
          currency={checkoutCurrency}
          onSubmitTrx={submitTrxId}
          onBack={(): void => {
            setCheckout(null);
            setNote(null);
            setError(null);
          }}
        />
      ) : (
        <PackageListView packages={packages ?? []} onBuy={buy} />
      )}
    </>
  );
}
