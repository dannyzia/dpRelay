import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  createBulkCampaign,
  listApps,
  listContactGroups,
  listMessageTemplates,
} from "../../utils/firebase";
import { useAuth } from "../../contexts/AuthContext";
import Button from "../../components/ui/Button";
import CsvUploader from "../../components/bulk/CsvUploader";
import MessageInput from "../../components/bulk/MessageInput";
import PhonePreviewTable from "../../components/bulk/PhonePreviewTable";
import {
  detectCharset,
  estimateSegments,
  parseCsvPhones,
} from "../../utils/bulkUtils";

const initialForm = {
  campaignName: "",
  appId: "",
  message: "",
  recipientsCsv: "",
};

export default function CreateBulkCampaign() {
  const [form, setForm] = useState(initialForm);
  const [step, setStep] = useState(1);
  const [apps, setApps] = useState([]);
  const [loadingApps, setLoadingApps] = useState(true);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(null);
  const { bulkEnabled } = useAuth();
  const [statusMessage, setStatusMessage] = useState(null);
  const navigate = useNavigate();

  // Contact Groups state (Step 2)
  const [recipientTab, setRecipientTab] = useState("csv"); // 'csv' | 'contactGroups'
  const [contactGroups, setContactGroups] = useState([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState([]);
  const [loadingGroups, setLoadingGroups] = useState(false);

  // Message Templates state (Step 3)
  const [templates, setTemplates] = useState([]);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);

  useEffect(() => {
    const loadApps = async () => {
      setLoadingApps(true);
      setError(null);
      try {
        const response = await listApps();
        const appList = response.data.apps || [];
        setApps(appList);
        if (appList.length === 1) {
          setForm((prev) => ({ ...prev, appId: appList[0].appId }));
        }
      } catch (err) {
        setError(err.message || "Unable to load apps");
      } finally {
        setLoadingApps(false);
      }
    };

    loadApps();
  }, []);

  // Load contact groups when entering Step 2
  useEffect(() => {
    if (step === 2 && contactGroups.length === 0) {
      const loadGroups = async () => {
        setLoadingGroups(true);
        try {
          const response = await listContactGroups();
          setContactGroups(response.data.groups || []);
        } catch (err) {
          // Groups are optional — don't block the user
          console.error("Unable to load contact groups", err);
        } finally {
          setLoadingGroups(false);
        }
      };
      loadGroups();
    }
  }, [step, contactGroups.length]);

  // Load templates when entering Step 3
  useEffect(() => {
    if (step === 3 && templates.length === 0) {
      const loadTemplates = async () => {
        try {
          const response = await listMessageTemplates();
          setTemplates(response.data.templates || []);
        } catch (err) {
          // Templates are optional
          console.error("Unable to load templates", err);
        }
      };
      loadTemplates();
    }
  }, [step, templates.length]);

  const parsedCsv = useMemo(
    () => parseCsvPhones(form.recipientsCsv),
    [form.recipientsCsv],
  );
  const charset = detectCharset(form.message);
  const segmentCount = estimateSegments(form.message);
  const validCount = parsedCsv.validPhones.length;
  const tooManyRows = parsedCsv.truncatedCount > 0;

  // Compute selected groups total phone count
  const selectedGroupPhoneCount = useMemo(() => {
    return contactGroups
      .filter((g) => selectedGroupIds.includes(g.groupId))
      .reduce((sum, g) => sum + g.phoneCount, 0);
  }, [contactGroups, selectedGroupIds]);

  const canProceedToCsv = form.campaignName.trim().length > 0 && form.appId;
  const canProceedToMessage =
    recipientTab === "csv"
      ? validCount > 0 && parsedCsv.invalidCount === 0
      : selectedGroupIds.length > 0;
  const canSubmit =
    form.message.trim().length > 0 &&
    (recipientTab === "csv" ? validCount > 0 : selectedGroupIds.length > 0);

  const stepTitles = {
    1: "Campaign Details",
    2: "Recipients Upload",
    3: "Message Content",
    4: "Review & Confirm",
  };

  const handleToggleGroup = (groupId) => {
    setSelectedGroupIds((prev) =>
      prev.includes(groupId)
        ? prev.filter((id) => id !== groupId)
        : [...prev, groupId],
    );
  };

  const handleLoadTemplate = (template) => {
    setForm((prev) => ({ ...prev, message: template.body }));
    setShowTemplatePicker(false);
  };

  const handleNext = () => {
    setError(null);
    if (!bulkEnabled) {
      setError("Bulk SMS is currently disabled. Please contact support.");
      return;
    }
    if (step === 1 && !canProceedToCsv) {
      setError("Please choose an app and add a campaign name.");
      return;
    }
    if (step === 2 && !canProceedToMessage) {
      if (recipientTab === "csv") {
        setError(
          "Please upload at least one valid recipient and fix invalid rows.",
        );
      } else {
        setError("Please select at least one contact group.");
      }
      return;
    }
    if (step === 3 && !canSubmit) {
      setError("Please add a message before continuing.");
      return;
    }
    setStep((prev) => Math.min(prev + 1, 4));
  };

  const handleBack = () => {
    setError(null);
    setStep((prev) => Math.max(prev - 1, 1));
  };

  const handleSubmit = async () => {
    setError(null);
    setStatusMessage(null);

    if (!bulkEnabled) {
      setError("Bulk SMS is currently disabled. Please contact support.");
      return;
    }

    setSubmitting(true);

    try {
      const payload = {
        appId: form.appId,
        campaignName: form.campaignName.trim(),
        message: form.message.trim(),
      };

      if (recipientTab === "contactGroups") {
        payload.sourceType = "contactGroups";
        payload.sourceGroupIds = selectedGroupIds;
      } else {
        payload.phones = parsedCsv.validPhones;
      }

      const response = await createBulkCampaign(payload);

      setSuccess("Campaign created successfully.");
      navigate(`/dashboard/bulk/${response.data.campaignId}`);
    } catch (err) {
      const messageText = err.message || "Unable to create campaign.";
      if (
        err.code === "permission-denied" &&
        messageText.includes("bulk_not_enabled")
      ) {
        setStatusMessage(
          "Bulk SMS is not yet available. Please contact support.",
        );
      } else if (messageText.includes("insufficient_bulk_credits")) {
        setStatusMessage(
          "Insufficient bulk credits. Please purchase more credits before continuing.",
        );
      }
      setError(messageText);
    } finally {
      setSubmitting(false);
    }
  };

  const recipientCount =
    recipientTab === "csv" ? validCount : selectedGroupPhoneCount;

  return (
    <div>
      <div className="mb-8 flex flex-col gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            Create Bulk SMS Campaign
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Upload your recipient list, preview the CSV, and confirm the bulk
            SMS campaign.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs uppercase tracking-wide text-gray-500">
          {Object.entries(stepTitles).map(([key, title]) => (
            <span
              key={key}
              className={`rounded-full border px-3 py-1 ${Number(key) === step ? "border-brand-600 bg-brand-50 text-brand-700" : "border-gray-200 bg-white text-gray-500"}`}
            >
              {title}
            </span>
          ))}
        </div>
      </div>

      <div className="space-y-6 rounded-lg border border-gray-200 bg-white p-6">
        {step === 1 && (
          <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
            <div className="space-y-6">
              <label className="block">
                <span className="text-sm font-medium text-gray-700">
                  Campaign Name
                </span>
                <input
                  type="text"
                  value={form.campaignName}
                  onChange={(event) =>
                    setForm({ ...form, campaignName: event.target.value })
                  }
                  className="mt-2 w-full rounded-md border border-gray-300 px-3 py-2"
                  placeholder="Summer sale announcement"
                />
              </label>

              <label className="block">
                <span className="text-sm font-medium text-gray-700">App</span>
                <select
                  value={form.appId}
                  onChange={(event) =>
                    setForm({ ...form, appId: event.target.value })
                  }
                  className="mt-2 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900"
                  disabled={loadingApps || apps.length === 0}
                >
                  <option value="">Select an app</option>
                  {apps.map((app) => (
                    <option key={app.appId} value={app.appId}>
                      {app.name}
                    </option>
                  ))}
                </select>
                {loadingApps && (
                  <p className="mt-2 text-sm text-gray-500">Loading apps…</p>
                )}
                {!loadingApps && apps.length === 0 && (
                  <p className="mt-2 text-sm text-red-600">
                    No registered apps found. Create an app first.
                  </p>
                )}
              </label>
            </div>

            <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
              <p className="text-sm font-semibold text-gray-900">
                What you need
              </p>
              <ul className="mt-3 space-y-2 text-sm text-gray-600">
                <li>1. Select an app to send bulk SMS from.</li>
                <li>2. Upload a CSV list or use a saved contact group.</li>
                <li>3. Compose a single SMS message template.</li>
                <li>4. Confirm recipient count and send.</li>
              </ul>
              {!bulkEnabled && (
                <p className="mt-4 rounded-md bg-yellow-50 p-3 text-sm text-yellow-700">
                  Bulk SMS is currently disabled. Please contact support or try
                  again later.
                </p>
              )}
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">
                  Recipients
                </h2>
                <p className="mt-1 text-sm text-gray-500">
                  Upload a CSV or select saved contact groups.
                </p>
              </div>
            </div>

            {/* Tab switcher */}
            <div className="inline-flex rounded-lg bg-gray-100 p-1">
              <button
                onClick={() => setRecipientTab("csv")}
                className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                  recipientTab === "csv"
                    ? "bg-white text-gray-900 shadow-sm"
                    : "text-gray-600 hover:text-gray-900"
                }`}
              >
                Upload CSV
              </button>
              <button
                onClick={() => setRecipientTab("contactGroups")}
                className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                  recipientTab === "contactGroups"
                    ? "bg-white text-gray-900 shadow-sm"
                    : "text-gray-600 hover:text-gray-900"
                }`}
              >
                Use Contact Groups
              </button>
            </div>

            {/* CSV tab content */}
            {recipientTab === "csv" && (
              <>
                <div className="flex items-center justify-end">
                  <div className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-700">
                    Total rows: {parsedCsv.totalCount}
                  </div>
                </div>

                <CsvUploader
                  value={form.recipientsCsv}
                  onChange={(value) =>
                    setForm({ ...form, recipientsCsv: value })
                  }
                  onFileUpload={(text) =>
                    setForm({ ...form, recipientsCsv: text })
                  }
                />

                {tooManyRows && (
                  <div className="rounded-lg border border-yellow-300 bg-yellow-50 p-4 text-sm text-yellow-800">
                    Only the first 10,000 rows are included in this campaign.
                    Remove extra rows to continue.
                  </div>
                )}

                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="rounded-xl border border-gray-200 bg-white p-4">
                    <p className="text-xs uppercase tracking-wide text-gray-500">
                      Valid recipients
                    </p>
                    <p className="mt-2 text-2xl font-semibold text-gray-900">
                      {validCount}
                    </p>
                  </div>
                  <div className="rounded-xl border border-gray-200 bg-white p-4">
                    <p className="text-xs uppercase tracking-wide text-gray-500">
                      Invalid rows
                    </p>
                    <p className="mt-2 text-2xl font-semibold text-red-700">
                      {parsedCsv.invalidCount}
                    </p>
                  </div>
                  <div className="rounded-xl border border-gray-200 bg-white p-4">
                    <p className="text-xs uppercase tracking-wide text-gray-500">
                      Duplicates removed
                    </p>
                    <p className="mt-2 text-2xl font-semibold text-yellow-700">
                      {parsedCsv.duplicateCount}
                    </p>
                  </div>
                </div>

                <PhonePreviewTable rows={parsedCsv.rows} />
              </>
            )}

            {/* Contact Groups tab content */}
            {recipientTab === "contactGroups" && (
              <div className="space-y-4">
                {loadingGroups && (
                  <p className="text-sm text-gray-500">Loading your groups…</p>
                )}

                {!loadingGroups && contactGroups.length === 0 && (
                  <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-8 text-center">
                    <p className="text-sm text-gray-500">No saved groups.</p>
                    <button
                      onClick={() => navigate("/dashboard/contact-groups")}
                      className="mt-3 text-sm font-medium text-brand-600 hover:text-brand-700"
                    >
                      Create one &rarr;
                    </button>
                  </div>
                )}

                {!loadingGroups && contactGroups.length > 0 && (
                  <div className="space-y-2">
                    {contactGroups.map((group) => {
                      const isSelected = selectedGroupIds.includes(
                        group.groupId,
                      );
                      return (
                        <label
                          key={group.groupId}
                          className={`flex cursor-pointer items-center gap-3 rounded-lg border p-4 transition-colors ${
                            isSelected
                              ? "border-brand-500 bg-brand-50"
                              : "border-gray-200 bg-white hover:bg-gray-50"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => handleToggleGroup(group.groupId)}
                            className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                          />
                          <div className="flex-1">
                            <p className="font-medium text-gray-900">
                              {group.name}
                            </p>
                            <p className="text-xs text-gray-500">
                              {group.phoneCount.toLocaleString()} numbers
                            </p>
                          </div>
                        </label>
                      );
                    })}

                    {selectedGroupIds.length > 0 && (
                      <p className="text-sm text-gray-500">
                        {selectedGroupIds.length} group
                        {selectedGroupIds.length !== 1 ? "s" : ""} selected
                        {" · "}
                        {selectedGroupPhoneCount.toLocaleString()} total
                        recipients
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">
                  Message Content
                </h2>
                <p className="mt-1 text-sm text-gray-500">
                  Write the SMS body for the campaign. Message length and
                  charset are calculated automatically.
                </p>
              </div>
              {templates.length > 0 && (
                <div className="relative">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowTemplatePicker(!showTemplatePicker)}
                  >
                    Load Template
                  </Button>
                  {showTemplatePicker && (
                    <div className="absolute right-0 top-full z-10 mt-2 w-80 max-h-64 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-xl">
                      {templates.map((template) => (
                        <button
                          key={template.templateId}
                          onClick={() => handleLoadTemplate(template)}
                          className="w-full px-4 py-3 text-left hover:bg-gray-50 border-b border-gray-100 last:border-b-0"
                        >
                          <p className="font-medium text-gray-900 text-sm">
                            {template.name}
                          </p>
                          <p className="mt-0.5 truncate text-xs text-gray-500">
                            {template.body.slice(0, 80)}
                            {template.body.length > 80 ? "…" : ""}
                          </p>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <MessageInput
              value={form.message}
              onChange={(value) => setForm({ ...form, message: value })}
            />

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <p className="text-xs uppercase tracking-wide text-gray-500">
                  Charset
                </p>
                <p className="mt-2 text-lg font-semibold text-gray-900">
                  {charset}
                </p>
              </div>
              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <p className="text-xs uppercase tracking-wide text-gray-500">
                  Segments
                </p>
                <p className="mt-2 text-lg font-semibold text-gray-900">
                  {segmentCount}
                </p>
              </div>
              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <p className="text-xs uppercase tracking-wide text-gray-500">
                  Length
                </p>
                <p className="mt-2 text-lg font-semibold text-gray-900">
                  {form.message.length}
                </p>
              </div>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-6">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">
                Review & Confirm
              </h2>
              <p className="mt-1 text-sm text-gray-500">
                Confirm campaign details before submission.
              </p>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-xl border border-gray-200 bg-white p-6">
                <p className="text-xs uppercase tracking-wide text-gray-500">
                  Campaign
                </p>
                <h3 className="mt-2 text-lg font-semibold text-gray-900">
                  {form.campaignName}
                </h3>
                <p className="mt-3 text-sm text-gray-600">
                  App ID: {form.appId}
                </p>
                <p className="mt-1 text-sm text-gray-600">
                  Recipients: {recipientCount}
                  {recipientTab === "contactGroups" && (
                    <span className="ml-2 text-xs text-gray-400">
                      (from {selectedGroupIds.length} group
                      {selectedGroupIds.length !== 1 ? "s" : ""})
                    </span>
                  )}
                </p>
                <p className="mt-1 text-sm text-gray-600">Charset: {charset}</p>
                <p className="mt-1 text-sm text-gray-600">
                  Segments: {segmentCount}
                </p>
                <p className="mt-1 text-sm text-gray-600">
                  Credits reserved: {recipientCount}
                </p>
              </div>

              <div className="rounded-xl border border-gray-200 bg-white p-6">
                <p className="text-xs uppercase tracking-wide text-gray-500">
                  Message preview
                </p>
                <p className="mt-3 whitespace-pre-line text-sm text-gray-700">
                  {form.message || "No message provided yet."}
                </p>
              </div>
            </div>

            <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
              <p className="font-medium text-gray-900">Reminder</p>
              {recipientTab === "csv" ? (
                <p className="mt-2">
                  Only valid E.164 numbers will be submitted. Invalid rows must
                  be corrected before sending.
                </p>
              ) : (
                <p className="mt-2">
                  Phone numbers from selected groups will be de-duplicated
                  server-side before dispatch.
                </p>
              )}
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">
            {error}
          </div>
        )}
        {statusMessage && (
          <div className="rounded-md bg-yellow-50 p-4 text-sm text-yellow-700">
            {statusMessage}
          </div>
        )}
        {success && (
          <div className="rounded-md bg-green-50 p-4 text-sm text-green-700">
            {success}
          </div>
        )}

        <div className="flex flex-col gap-3 border-t border-gray-200 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-3">
            {step > 1 && (
              <Button
                variant="outline"
                onClick={handleBack}
                disabled={submitting}
              >
                Back
              </Button>
            )}
            {step < 4 && (
              <Button variant="primary" onClick={handleNext}>
                Continue
              </Button>
            )}
          </div>

          <div className="flex gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate("/dashboard/bulk")}
            >
              Cancel
            </Button>
            {step === 4 && (
              <Button
                type="button"
                disabled={submitting || !canSubmit}
                variant="primary"
                onClick={handleSubmit}
              >
                {submitting ? "Submitting…" : "Submit Campaign"}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
