import React, { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  getCampaignStatus,
  listFailedRecipients,
  pauseCampaign,
  resumeCampaign,
  cancelCampaign,
  retryFailedJobs,
} from "../../utils/firebase";
import { onValue, ref } from "firebase/database";
import { rtdb } from "../../utils/firebase";
import Button from "../../components/ui/Button";
import CampaignStats from "../../components/bulk/CampaignStats";

export default function BulkCampaignDetail() {
  const { campaignId } = useParams();
  const navigate = useNavigate();
  const [campaign, setCampaign] = useState(null);
  const [failedRecipients, setFailedRecipients] = useState([]);
  const [progress, setProgress] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [downloadingReport, setDownloadingReport] = useState(false);

  const loadCampaign = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await getCampaignStatus({ campaignId });
      setCampaign(response.data);
    } catch (err) {
      setError(err.message || "Unable to load campaign details.");
    } finally {
      setLoading(false);
    }
  };

  const loadFailedRecipients = async () => {
    if (!campaignId) {
      return;
    }

    try {
      const response = await listFailedRecipients({ campaignId, limit: 200 });
      setFailedRecipients(response.data.failedRecipients || []);
    } catch (err) {
      // Do not fail the entire page if failed recipient list is unavailable.
      console.error("Unable to load failed recipients", err);
    }
  };

  useEffect(() => {
    if (!campaignId) {
      return undefined;
    }

    const progressRef = ref(rtdb, `bulk_progress/${campaignId}`);
    const unsubscribe = onValue(progressRef, (snapshot) => {
      if (snapshot.exists()) {
        setProgress(snapshot.val());
      }
    });

    return () => unsubscribe();
  }, [campaignId]);

  useEffect(() => {
    if (campaignId) {
      loadCampaign();
      loadFailedRecipients();
    }
  }, [campaignId]);

  const handleDownloadReport = async () => {
    if (!campaign) {
      return;
    }
    setDownloadingReport(true);
    setError(null);
    try {
      // Collect all failed recipients (paginate up to 5 pages = 50k)
      const allFailed = [];
      let pageToken = null;
      let pagesFetched = 0;
      const MAX_PAGES = 5;

      do {
        const response = await listFailedRecipients({
          campaignId,
          limit: 10000,
          pageToken: pageToken || undefined,
        });
        const data = response.data;
        const failed = data.failedRecipients || [];
        allFailed.push(...failed);
        pageToken = data.nextPageToken || null;
        pagesFetched++;
      } while (pageToken && pagesFetched < MAX_PAGES);

      // Build CSV
      const sentCount =
        (campaign.totalRecipients || 0) -
        (campaign.failedCount || allFailed.length);
      const rows = [];
      rows.push("phone,status,errorMessage,attemptedAt");

      // We don't have individual sent recipient records, so we only include failures
      // Sent count is informational only — the CSV focuses on actual per-recipient data
      for (const recipient of allFailed) {
        const phone = recipient.phone || "";
        const errMsg = (recipient.errorMessage || "").replace(/"/g, '""');
        const attemptedAt = recipient.lastAttemptAt
          ? formatTimestamp(recipient.lastAttemptAt)
          : "";
        rows.push(`"${phone}",failed,"${errMsg}",${attemptedAt}`);
      }

      if (pageToken && pagesFetched >= MAX_PAGES) {
        rows.push("");
        rows.push("# Report truncated — exceeded 50,000 failed recipients.");
      }

      const csvString = rows.join("\n");
      const blob = new Blob([csvString], { type: "text/csv" });
      const url = URL.createObjectURL(blob);

      // Sanitize campaign name for filename
      const safeName = (campaign.campaignName || "campaign").replace(
        /[^a-zA-Z0-9_-]/g,
        "_",
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `${safeName}-report.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError("Unable to generate report. Try again.");
    } finally {
      setDownloadingReport(false);
    }
  };

  const handleAction = async (action) => {
    if (!campaignId) return;
    setSaving(true);
    setError(null);
    try {
      if (action === "pause") await pauseCampaign({ campaignId });
      if (action === "resume") await resumeCampaign({ campaignId });
      if (action === "cancel") await cancelCampaign({ campaignId });
      if (action === "retry") await retryFailedJobs({ campaignId });
      await loadCampaign();
      await loadFailedRecipients();
    } catch (err) {
      setError(err.message || "Action failed.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="text-sm text-gray-500">Loading campaign details…</div>
    );
  }

  const progressData = progress || campaign.progress || {};
  const sentCount = progressData.sentCount ?? campaign.sentCount ?? 0;
  const failedCount = progressData.failedCount ?? campaign.failedCount ?? 0;
  const totalCount = progressData.totalCount ?? campaign.totalRecipients ?? 0;
  const completedPercent =
    totalCount > 0 ? Math.round((sentCount / totalCount) * 100) : 0;
  const statusLabel = progressData.status || campaign.status;

  if (!campaign) {
    return <div className="text-sm text-gray-500">Campaign not found.</div>;
  }

  const formatTimestamp = (value) => {
    if (!value) return "N/A";
    if (typeof value.toDate === "function") {
      return value.toDate().toLocaleString();
    }
    if (typeof value === "object" && value._seconds != null) {
      return new Date(
        value._seconds * 1000 + (value._nanoseconds || 0) / 1e6,
      ).toLocaleString();
    }
    return new Date(value).toLocaleString();
  };

  const progressWidth = `${Math.min(100, Math.max(0, completedPercent))}%`;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {campaign.campaignName}
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Manage campaign progress and recipient delivery details.
          </p>
        </div>
        <div className="flex gap-2">
          {["completed", "cancelled", "failed"].includes(
            campaign?.status || progressData?.status,
          ) && (
            <Button
              variant="secondary"
              size="sm"
              onClick={handleDownloadReport}
              disabled={downloadingReport}
            >
              {downloadingReport ? "Preparing…" : "Download Report"}
            </Button>
          )}
          <Button variant="outline" onClick={() => navigate("/dashboard/bulk")}>
            Back to campaigns
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <h2 className="text-lg font-semibold text-gray-900">Summary</h2>
          <div className="mt-4 space-y-3 text-sm text-gray-700">
            <div>
              <span className="font-semibold text-gray-900">Campaign ID:</span>{" "}
              {campaign.id}
            </div>
            <div>
              <span className="font-semibold text-gray-900">Recipients:</span>{" "}
              {campaign.totalRecipients}
            </div>
            <div>
              <span className="font-semibold text-gray-900">Status:</span>{" "}
              {statusLabel}
            </div>
            <div>
              <span className="font-semibold text-gray-900">Created at:</span>{" "}
              {formatTimestamp(campaign.createdAt)}
            </div>
          </div>

          <div className="mt-6 space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-gray-900">Progress</h3>
              <div className="mt-3 rounded-full bg-gray-100 overflow-hidden">
                <div
                  className="h-3 rounded-full bg-brand-600"
                  style={{ width: progressWidth }}
                />
              </div>
              <p className="mt-2 text-xs text-gray-500">
                {sentCount} sent · {failedCount} failed ·{" "}
                {totalCount - sentCount - failedCount} remaining
              </p>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-gray-900">Message</h3>
              <p className="mt-2 text-sm text-gray-700 whitespace-pre-line">
                {campaign.message}
              </p>
            </div>
          </div>

          <div className="mt-6">
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">
                    Failed recipients
                  </h3>
                  <p className="text-sm text-gray-500">
                    Review failed SMS deliveries for this campaign.
                  </p>
                </div>
                <span className="text-xs font-semibold uppercase tracking-wide text-red-600">
                  {failedRecipients.length} failed
                </span>
              </div>

              {failedRecipients.length === 0 ? (
                <div className="mt-4 rounded-lg border border-dashed border-gray-200 bg-white p-6 text-sm text-gray-500">
                  No failed recipients have been recorded.
                </div>
              ) : (
                <div className="mt-4 overflow-hidden rounded-lg border border-gray-200 bg-white">
                  <table className="min-w-full divide-y divide-gray-200 text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">
                          Phone
                        </th>
                        <th className="px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">
                          Last error
                        </th>
                        <th className="px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">
                          Last attempt
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 bg-white">
                      {failedRecipients.map((recipient) => (
                        <tr key={recipient.id}>
                          <td className="px-4 py-3 text-gray-900">
                            {recipient.phone}
                          </td>
                          <td className="px-4 py-3 text-gray-700">
                            {recipient.errorMessage}
                          </td>
                          <td className="px-4 py-3 text-gray-700">
                            {formatTimestamp(recipient.lastAttemptAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {error && (
            <div className="mt-6 rounded-md bg-red-50 p-4 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="mt-6 flex flex-wrap gap-3">
            {statusLabel === "sending" && (
              <Button
                variant="outline"
                onClick={() => handleAction("pause")}
                disabled={saving}
              >
                Pause
              </Button>
            )}
            {campaign.status === "paused" && (
              <Button
                variant="primary"
                onClick={() => handleAction("resume")}
                disabled={saving}
              >
                Resume
              </Button>
            )}
            {["queued", "sending", "paused"].includes(campaign.status) && (
              <Button
                variant="danger"
                onClick={() => handleAction("cancel")}
                disabled={saving}
              >
                Cancel
              </Button>
            )}
            {campaign.status === "failed" && (
              <Button
                variant="primary"
                onClick={() => handleAction("retry")}
                disabled={saving}
              >
                Retry Campaign
              </Button>
            )}
          </div>
        </div>

        <CampaignStats campaign={campaign} />
      </div>
    </div>
  );
}
