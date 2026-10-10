import { useCallback, useEffect, useState } from "react";
import { describeError, listTransactions, type Transaction } from "../api";
import { ErrorBanner } from "../components/ErrorBanner";
import { formatPrice, formatEpochUtc, formatStatus } from "../lib/format";

type StatusFilter = "all" | "pending" | "approved" | "rejected";

/**
 * Pure history screen — filter, table, and pagination (ISSUE-91: every
 * piece of screen markup lives in the view; the container owns data and
 * handlers only). Control props are optional so render tests can exercise
 * the table alone.
 *
 * @param props.transactions rows to render (empty → the empty state).
 * @param props.status current status filter (default `"all"`).
 * @param props.error stored fetch error, rendered as an announced banner.
 * @param props.loading disables Load more while a page is in flight.
 * @param props.cursor keyset cursor — non-null shows the Load more button.
 * @param props.onStatusChange filter change handler.
 * @param props.onLoadMore next-page handler.
 */
export function HistoryView(props: {
  transactions: Transaction[];
  status?: StatusFilter;
  error?: string | null;
  loading?: boolean;
  cursor?: string | null;
  onStatusChange?: (status: StatusFilter) => void;
  onLoadMore?: () => void;
}): JSX.Element {
  const status = props.status ?? "all";
  const loading = props.loading ?? false;
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
          onChange={(e): void => props.onStatusChange?.(e.target.value as StatusFilter)}
        >
          <option value="all">All</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>
      {props.error !== null && props.error !== undefined && (
        <ErrorBanner message={props.error} />
      )}
      {props.transactions.length === 0 ? (
        <p className="muted">No transactions yet.</p>
      ) : (
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
            {props.transactions.map((t) => (
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
      )}
      <div className="inline-actions mt-14">
        {props.cursor !== null && props.cursor !== undefined && (
          <button
            type="button"
            className="secondary"
            disabled={loading}
            onClick={(): void => props.onLoadMore?.()}
          >
            Load more
          </button>
        )}
      </div>
    </>
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
    <HistoryView
      transactions={rows}
      status={status}
      error={error}
      loading={loading}
      cursor={cursor}
      onStatusChange={setStatus}
      onLoadMore={(): void => load(true, cursor ?? undefined)}
    />
  );
}
