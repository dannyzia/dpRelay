import React, { useEffect, useState } from "react";
import { getTransactions, approveCredit } from "../../utils/firebase";
import Button from "../../components/ui/Button";

export default function ApproveTransactions() {
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);

  const loadTransactions = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await getTransactions({ status: "pending", limit: 100 });
      setTransactions(response.data.transactions || []);
    } catch (err) {
      setError(err.message || "Unable to load pending transactions");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTransactions();
    const interval = setInterval(loadTransactions, 15000);
    return () => clearInterval(interval);
  }, []);

  const handleApprove = async (transactionId) => {
    if (!window.confirm("Approve this transaction and add credits to the app?"))
      return;
    setActionLoading(transactionId);
    setError(null);
    try {
      await approveCredit({ transactionId, approve: true });
      await loadTransactions();
    } catch (err) {
      setError(err.message || "Failed to approve transaction");
    } finally {
      setActionLoading(null);
    }
  };

  const handleReject = async (transactionId) => {
    const reason = window.prompt("Enter a reason for rejection (optional):");
    if (reason === null) return;
    setActionLoading(transactionId);
    setError(null);
    try {
      await approveCredit({
        transactionId,
        approve: false,
        rejectReason: reason || undefined,
      });
      await loadTransactions();
    } catch (err) {
      setError(err.message || "Failed to reject transaction");
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">
            Pending Transactions
          </h1>
          <p className="mt-1 text-sm text-gray-400">
            Review and approve bKash credit purchase requests.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={loadTransactions}
          disabled={loading}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-red-500 bg-red-900/50 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-gray-700">
        <table className="min-w-full divide-y divide-gray-700">
          <thead className="bg-gray-800">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-400">
                App
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-400">
                Package
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-400">
                Amount
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-400">
                TrxID
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-400">
                Requested
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-400">
                Status
              </th>
              <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-400">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-700 bg-gray-800">
            {loading && transactions.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-6 py-12 text-center text-sm text-gray-400"
                >
                  Loading pending transactions…
                </td>
              </tr>
            ) : transactions.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-6 py-12 text-center text-sm text-gray-400"
                >
                  No pending transactions.
                </td>
              </tr>
            ) : (
              transactions.map((tx) => (
                <tr key={tx.id}>
                  <td className="px-6 py-4 text-sm text-gray-100">
                    {tx.appId}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-300">
                    {tx.packageName || tx.package_id}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-100">
                    ৳{tx.amount_bdt?.toLocaleString() ?? "0"}
                  </td>
                  <td className="px-6 py-4 text-sm font-mono text-gray-300">
                    {tx.trx_id || "—"}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-300">
                    {tx.requested_at
                      ? new Date(tx.requested_at).toLocaleString()
                      : "N/A"}
                  </td>
                  <td className="px-6 py-4">
                    <span className="inline-flex rounded-full bg-yellow-900 px-2 py-1 text-xs font-semibold text-yellow-200">
                      {tx.status || "pending"}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right space-x-2">
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => handleApprove(tx.id)}
                      disabled={actionLoading === tx.id}
                    >
                      {actionLoading === tx.id ? "Processing…" : "Approve"}
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => handleReject(tx.id)}
                      disabled={actionLoading === tx.id}
                    >
                      Reject
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
