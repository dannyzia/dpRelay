import { useCallback, useEffect, useState } from "react";
import { describeError, getCredits, type Credits } from "../api";
import { formatEpochUtc, formatSms } from "../format";
import { ErrorBanner } from "../components/ErrorBanner";

/** Pure balance view — exported for render tests with fixture data. */
export function CreditsView({ credits }: { credits: Credits }): JSX.Element {
  return (
    <div className="grid two">
      <section className="card" data-testid="otp-bucket">
        <h2>OTP credits</h2>
        <p className="stat">{formatSms(credits.otpSmsRemaining)}</p>
        <p className="muted">Expires: {formatEpochUtc(credits.otpExpiresAt)}</p>
      </section>
      <section className="card" data-testid="bulk-bucket">
        <h2>Bulk credits</h2>
        <p className="stat">{formatSms(credits.bulkSmsRemaining)}</p>
        <p className="muted">Expires: {formatEpochUtc(credits.bulkExpiresAt)}</p>
      </section>
      <section className="card span2">
        <h2>Purchase</h2>
        <p className="muted">
          Last purchase: {formatEpochUtc(credits.purchasedAt)}
          {credits.lastTransactionId !== null && (
            <>
              {" "}
              · transaction <code>{credits.lastTransactionId}</code>
            </>
          )}
        </p>
      </section>
    </div>
  );
}

/** Container: fetches the balance and supports manual refresh. */
export function Credits(): JSX.Element {
  const [credits, setCredits] = useState<Credits | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const load = useCallback((): void => {
    setLoading(true);
    getCredits()
      .then((c) => {
        setCredits(c);
        setError(null);
      })
      .catch((err: unknown) => setError(describeError(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <>
      <div className="page-head">
        <h1>Credit balance</h1>
        <button type="button" onClick={load} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {error !== null && <ErrorBanner message={error} />}
      {credits !== null && <CreditsView credits={credits} />}
      {!loading && credits === null && error === null && <p className="muted">No balance data.</p>}
    </>
  );
}
