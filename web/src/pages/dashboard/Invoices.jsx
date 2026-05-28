import React, { useCallback, useEffect, useState } from "react";
import { getInvoiceHistory, listApps } from "../../utils/firebase";
import Button from "../../components/ui/Button";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Formats an ISO date string (or null) to a human-readable local date string.
 * @param {string|null} iso
 * @returns {string}
 */
function fmtDate(iso) {
  if (!iso) return "N/A";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Returns a default date string suitable for <input type="date">.
 * @param {number} offsetDays - Negative = past, positive = future
 * @returns {string} YYYY-MM-DD
 */
function defaultDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/**
 * Builds a status badge className based on a status string.
 * @param {string} status
 * @returns {string}
 */
function statusClass(status) {
  switch ((status || "").toLowerCase()) {
    case "approved":
    case "completed":
      return "bg-green-100 text-green-800";
    case "pending":
    case "running":
    case "paused":
      return "bg-yellow-100 text-yellow-800";
    case "rejected":
    case "cancelled":
    case "failed":
      return "bg-red-100 text-red-800";
    default:
      return "bg-gray-100 text-gray-700";
  }
}

// ── CSV Export ────────────────────────────────────────────────────────────────

/**
 * Converts an array of flat objects to a CSV data-URL and triggers a download.
 * @param {string} filename
 * @param {object[]} rows
 */
function downloadCsv(filename, rows) {
  if (!rows || rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const escape = (v) => {
    const s = v == null ? "" : String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  const csvContent = [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(",")),
  ].join("\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  link.click();
  URL.revokeObjectURL(url);
}

// ── Summary Card ─────────────────────────────────────────────────────────────

function SummaryCard({ label, value, sub }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">
        {label}
      </p>
      <p className="mt-2 text-3xl font-bold text-gray-900">{value}</p>
      {sub && <p className="mt-1 text-sm text-gray-500">{sub}</p>}
    </div>
  );
}

// ── Tab button ────────────────────────────────────────────────────────────────

function TabBtn({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
        active
          ? "bg-brand-600 text-white shadow-sm"
          : "bg-white text-gray-600 border border-gray-200 hover:bg-gray-50"
      }`}
    >
      {children}
    </button>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function Invoices() {
  // Filter state
  const [apps, setApps] = useState([]);
  const [selectedAppId, setSelectedAppId] = useState("");
  const [startDate, setStartDate] = useState(defaultDate(-30));
  const [endDate, setEndDate] = useState(defaultDate(0));

  // Data state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null); // { purchases, otpUsage, bulkCampaigns, summary }

  // UI state
  const [activeTab, setActiveTab] = useState("purchases");

  // Load app list for filter dropdown (fail silently — not critical)
  useEffect(() => {
    listApps()
      .then((res) => setApps(res.data.apps || []))
      .catch(() => {});
  }, []);

  /**
   * Fetches invoice history from the Cloud Function using current filter values.
   */
  const fetchHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = {
        startDate: new Date(startDate).toISOString(),
        endDate: new Date(endDate + "T23:59:59").toISOString(),
      };
      if (selectedAppId) payload.appId = selectedAppId;

      const res = await getInvoiceHistory(payload);
      setData(res.data);
    } catch (err) {
      setError(
        err.message || "Failed to load invoice history. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  }, [selectedAppId, startDate, endDate]);

  // Auto-fetch on mount with default filters
  useEffect(() => {
    fetchHistory();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Render helpers ──────────────────────────────────────────────────────────

  const renderPurchases = () => {
    const rows = data?.purchases ?? [];
    if (rows.length === 0) {
      return (
        <div className="py-12 text-center text-sm text-gray-400">
          No approved credit purchases in this period.
        </div>
      );
    }
    return (
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              {[
                "Date",
                "App ID",
                "Package",
                "Credits",
                "Amount (BDT)",
                "Status",
              ].map((h) => (
                <th
                  key={h}
                  className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white">
            {rows.map((row) => (
              <tr key={row.id} className="hover:bg-gray-50 transition-colors">
                <td className="px-5 py-3 text-gray-700 whitespace-nowrap">
                  {fmtDate(row.requested_at)}
                </td>
                <td className="px-5 py-3 font-mono text-xs text-gray-600 max-w-[160px] truncate">
                  {row.appId}
                </td>
                <td className="px-5 py-3 text-gray-700">
                  {row.packageId ?? "—"}
                </td>
                <td className="px-5 py-3 text-right font-semibold text-gray-900">
                  {(row.sms_quota ?? 0).toLocaleString()}
                </td>
                <td className="px-5 py-3 text-right text-gray-700">
                  ৳{(row.amount_bdt ?? 0).toLocaleString()}
                </td>
                <td className="px-5 py-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${statusClass(row.status)}`}
                  >
                    {row.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  const renderOtpUsage = () => {
    const rows = data?.otpUsage ?? [];
    if (rows.length === 0) {
      return (
        <div className="py-12 text-center text-sm text-gray-400">
          No OTP usage records in this period.
          {!selectedAppId && (
            <span className="block mt-1 text-xs text-gray-400">
              Select a specific app to see per-OTP deduction records.
            </span>
          )}
        </div>
      );
    }
    return (
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              {["Date", "Session ID", "Phone (hashed)"].map((h) => (
                <th
                  key={h}
                  className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white">
            {rows.map((row) => (
              <tr key={row.id} className="hover:bg-gray-50 transition-colors">
                <td className="px-5 py-3 text-gray-700 whitespace-nowrap">
                  {fmtDate(row.deducted_at)}
                </td>
                <td className="px-5 py-3 font-mono text-xs text-gray-600">
                  {row.session_id ?? "—"}
                </td>
                <td className="px-5 py-3 font-mono text-xs text-gray-500">
                  {row.phone_number_hash ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  const renderBulkCampaigns = () => {
    const rows = data?.bulkCampaigns ?? [];
    if (rows.length === 0) {
      return (
        <div className="py-12 text-center text-sm text-gray-400">
          No bulk campaigns in this period.
        </div>
      );
    }
    return (
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              {[
                "Date",
                "Campaign",
                "App ID",
                "Total",
                "Sent",
                "Failed",
                "Credits Used",
                "Status",
              ].map((h) => (
                <th
                  key={h}
                  className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white">
            {rows.map((row) => (
              <tr key={row.id} className="hover:bg-gray-50 transition-colors">
                <td className="px-5 py-3 text-gray-700 whitespace-nowrap">
                  {fmtDate(row.createdAt)}
                </td>
                <td className="px-5 py-3 text-gray-900 font-medium">
                  {row.campaignName ?? "—"}
                </td>
                <td className="px-5 py-3 font-mono text-xs text-gray-600 max-w-[120px] truncate">
                  {row.appId}
                </td>
                <td className="px-5 py-3 text-right text-gray-700">
                  {(row.totalRecipients ?? 0).toLocaleString()}
                </td>
                <td className="px-5 py-3 text-right text-green-700 font-semibold">
                  {(row.sentCount ?? 0).toLocaleString()}
                </td>
                <td className="px-5 py-3 text-right text-red-600">
                  {(row.failedCount ?? 0).toLocaleString()}
                </td>
                <td className="px-5 py-3 text-right text-gray-700">
                  {(row.bulkCreditCost ?? 0).toLocaleString()}
                </td>
                <td className="px-5 py-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${statusClass(row.status)}`}
                  >
                    {row.status ?? "—"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  // ── CSV export for the active tab ───────────────────────────────────────────

  const handleExportCsv = () => {
    if (!data) return;
    const dateTag = `${startDate}_${endDate}`;
    if (activeTab === "purchases") {
      downloadCsv(`purchases_${dateTag}.csv`, data.purchases);
    } else if (activeTab === "otp") {
      downloadCsv(`otp_usage_${dateTag}.csv`, data.otpUsage);
    } else {
      downloadCsv(`bulk_campaigns_${dateTag}.csv`, data.bulkCampaigns);
    }
  };

  // ── Tab counts ──────────────────────────────────────────────────────────────

  const purchaseCount = data?.purchases?.length ?? 0;
  const otpCount = data?.otpUsage?.length ?? 0;
  const bulkCount = data?.bulkCampaigns?.length ?? 0;

  // ── JSX ─────────────────────────────────────────────────────────────────────

  return (
    <div>
      {/* Page header */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Invoice History</h1>
          <p className="mt-1 text-sm text-gray-500">
            Credit purchases, OTP usage, and bulk campaign activity for your
            apps.
          </p>
        </div>
        {data && (
          <Button variant="secondary" onClick={handleExportCsv}>
            Export CSV
          </Button>
        )}
      </div>

      {/* Filter bar */}
      <div className="mb-6 flex flex-wrap gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        {/* App filter */}
        <div className="flex flex-col gap-1 min-w-[180px]">
          <label className="text-xs font-semibold uppercase tracking-wider text-gray-500">
            App
          </label>
          <select
            value={selectedAppId}
            onChange={(e) => setSelectedAppId(e.target.value)}
            className="rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="">All apps</option>
            {apps.map((a) => (
              <option key={a.appId} value={a.appId}>
                {a.name || a.appId}
              </option>
            ))}
          </select>
        </div>

        {/* Start date */}
        <div className="flex flex-col gap-1">
          <label className="text-xs font-semibold uppercase tracking-wider text-gray-500">
            From
          </label>
          <input
            type="date"
            value={startDate}
            max={endDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        {/* End date */}
        <div className="flex flex-col gap-1">
          <label className="text-xs font-semibold uppercase tracking-wider text-gray-500">
            To
          </label>
          <input
            type="date"
            value={endDate}
            min={startDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        {/* Apply button */}
        <div className="flex items-end">
          <Button variant="primary" onClick={fetchHistory} disabled={loading}>
            {loading ? "Loading…" : "Apply"}
          </Button>
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="animate-pulse space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-24 rounded-xl bg-gray-100" />
            ))}
          </div>
          <div className="h-64 rounded-xl bg-gray-100" />
        </div>
      )}

      {/* Data */}
      {!loading && data && (
        <>
          {/* Summary cards */}
          <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryCard
              label="Credit Purchases"
              value={data.summary.totalPurchases}
              sub="Approved in range"
            />
            <SummaryCard
              label="Total Spent"
              value={`৳${data.summary.totalAmountBdt.toLocaleString()}`}
              sub="BDT (approved only)"
            />
            <SummaryCard
              label="OTP Sent"
              value={data.summary.totalOtpUsed.toLocaleString()}
              sub="Credits deducted"
            />
            <SummaryCard
              label="Bulk Delivered"
              value={data.summary.totalBulkSent.toLocaleString()}
              sub="Across all campaigns"
            />
          </div>

          {/* Tabs */}
          <div className="mb-4 flex gap-2 flex-wrap">
            <TabBtn
              active={activeTab === "purchases"}
              onClick={() => setActiveTab("purchases")}
            >
              Purchases ({purchaseCount})
            </TabBtn>
            <TabBtn
              active={activeTab === "otp"}
              onClick={() => setActiveTab("otp")}
            >
              OTP Usage ({otpCount})
            </TabBtn>
            <TabBtn
              active={activeTab === "bulk"}
              onClick={() => setActiveTab("bulk")}
            >
              Bulk Campaigns ({bulkCount})
            </TabBtn>
          </div>

          {/* Table panel */}
          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
            {activeTab === "purchases" && renderPurchases()}
            {activeTab === "otp" && renderOtpUsage()}
            {activeTab === "bulk" && renderBulkCampaigns()}
          </div>

          {/* Note about OTP usage records */}
          {activeTab === "otp" && !selectedAppId && otpCount === 0 && (
            <p className="mt-3 text-center text-xs text-gray-400">
              OTP usage records are stored per-app. Select an app from the
              filter above to see deduction records.
            </p>
          )}
        </>
      )}

      {/* Initial empty state (before first load) */}
      {!loading && !data && !error && (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white p-16 text-center">
          <p className="text-gray-400">
            Press <strong>Apply</strong> to load invoice history.
          </p>
        </div>
      )}
    </div>
  );
}
