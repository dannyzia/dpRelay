import { useCallback, useEffect, useState } from "react";
import { describeError, listTransactions, type Transaction } from "../api";
import { ErrorBanner } from "../components/ErrorBanner";
import { formatPrice, formatEpochUtc, formatStatus } from "../format";

type StatusFilter = "all" | "pending" | "approved" | "rejected";

/** Pure history table — exported for render tests. */
export function HistoryView({ transactions }: { transactions: Transaction[] }): JSX.Element {
  if (transactions.length === 0) {
    return <p className="muted">No transactions yet.</p>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>Requested</th>
          <th>Package</th>
          <th>Amount</th>
          <th>TrxID</th>
          <th>Status</th>
          <th>Resolved</th>
        </tr>
      </thead>
      <tbody>
        {transactions.map((t) => (
          <tr key={t.transactionId}>
            <td>{formatEpochUtc(t.requestedAt)}</td>
            <td>
              {t.packageCode} <span className="chip">{t.packageType}</span>
            </td>
            <td className="num">{formatPrice(t.amountBdt, t.currency)}</td>
            <td className="mono">{t.trxId ?? "—"}</td>
            <td>
              <span className={`chip ${t.status}`}>{formatStatus(t.status)}</span>
            </td>
            <td>{formatEpochUtc(t.resolvedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Container: status filter + keyset "load more" pagination. */
export function History(): JSX.Element {
  const [rows, setRows] = useState<Transaction[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const load = useCallback(
    (append: boolean, nextCursor?: string): void => {
      setLoading(true);
      listTransactions({
        status: status === "all" ? undefined : status,
        cursor: nextCursor,
      })
        .then((page) => {
          setRows((prev) => (append ? [...prev, ...page.transactions] : page.transactions));
          setCursor(page.nextCursor);
          setError(null);
        })
        .catch((err: unknown) => setError(describeError(err)))
        .finally(() => setLoading(false));
    },
    [status],
  );

  useEffect(() => {
    load(false);
  }, [load]);

  return (
    <>
      <div className="page-head">
        <h1>Transaction history</h1>
      </div>
      <div className="filterbar">
        <label htmlFor="statusFilter" className="muted">
          Status
        </label>
        <select
          id="statusFilter"
          value={status}
          onChange={(e): void => setStatus(e.target.value as StatusFilter)}
        >
          <option value="all">All</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>
      {error !== null && <ErrorBanner message={error} />}
      <HistoryView transactions={rows} />
      <div className="inline-actions" style={{ marginTop: 14 }}>
        {cursor !== null && (
          <button
            type="button"
            className="secondary"
            disabled={loading}
            onClick={(): void => load(true, cursor ?? undefined)}
          >
            Load more
          </button>
        )}
      </div>
    </>
  );
}
