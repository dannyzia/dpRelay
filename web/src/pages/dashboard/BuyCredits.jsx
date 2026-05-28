import React, { useEffect, useMemo, useState } from "react";
import {
  listApps,
  requestCredit,
  submitTrxId,
  listPackages,
} from "../../utils/firebase";
import Button from "../../components/ui/Button";

/**
 * Returns the credit label for a package based on its own type,
 * not the active tab. This ensures type:"both" packages are never
 * mislabelled as purely OTP or purely Bulk credits.
 *
 * @param {object} pkg - Normalised package object
 * @returns {string} e.g. "OTP credits", "Bulk credits", "OTP + Bulk credits"
 */
const packageCreditLabel = (pkg) => {
  const t = (pkg.type || "otp").toLowerCase();
  if (t === "both") return "OTP + Bulk credits";
  if (t === "bulk") return "Bulk credits";
  return "OTP credits";
};

/**
 * Normalises a package object from Firestore so the UI always has
 * consistent field names regardless of how the document was created.
 * Handles legacy field names (credits → sms_quota, price → price_bdt).
 *
 * @param {object} pkg - Raw package document
 * @returns {object} Normalised package
 */
const normalisePackage = (pkg) => ({
  ...pkg,
  sms_quota: pkg.sms_quota ?? pkg.credits ?? 0,
  price_bdt: pkg.price_bdt ?? pkg.price ?? 0,
  name: pkg.name || "Unnamed Package",
  type: (pkg.type || "otp").toLowerCase(),
});

export default function BuyCredits() {
  const [apps, setApps] = useState([]);
  const [selectedAppId, setSelectedAppId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [remotePackages, setRemotePackages] = useState(null);

  const [paymentModal, setPaymentModal] = useState(null);
  const [trxId, setTrxId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [successMsg, setSuccessMsg] = useState(null);
  const [buyingId, setBuyingId] = useState(null);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const [appRes, pkgRes] = await Promise.all([
          listApps(),
          // Log the actual error instead of swallowing it silently,
          // so we can diagnose permission-denied or index-missing issues.
          listPackages().catch((err) => {
            console.error(
              "[BuyCredits] listPackages failed:",
              err?.message || err,
            );
            return null;
          }),
        ]);
        const appList = appRes.data.apps || [];
        setApps(appList);
        if (appList.length === 1) {
          setSelectedAppId(appList[0].appId);
        }
        if (pkgRes?.data?.packages?.length) {
          setRemotePackages(pkgRes.data.packages.map(normalisePackage));
        }
      } catch (err) {
        setError(err.message || "Unable to load data.");
      } finally {
        setLoading(false);
      }
    };

    load();
  }, []);

  const selectedApp = useMemo(
    () => apps.find((app) => app.appId === selectedAppId) || apps[0] || null,
    [apps, selectedAppId],
  );

  const packages = useMemo(() => {
    if (!remotePackages) return [];
    const typeOrder = { otp: 0, bulk: 1, both: 2 };
    return [...remotePackages].sort((a, b) => {
      const tA = typeOrder[(a.type || "otp").toLowerCase()] ?? 0;
      const tB = typeOrder[(b.type || "otp").toLowerCase()] ?? 0;
      if (tA !== tB) return tA - tB;
      return (a.price_bdt ?? 0) - (b.price_bdt ?? 0);
    });
  }, [remotePackages]);

  // Group packages by type for visual section headers.
  const groupedPackages = useMemo(() => {
    const groups = { otp: [], bulk: [], both: [] };
    packages.forEach((pkg) => {
      const t = (pkg.type || "otp").toLowerCase();
      if (groups[t]) groups[t].push(pkg);
    });
    return groups;
  }, [packages]);

  const packageSections = [
    { key: "otp", label: "OTP Credit Packages" },
    { key: "bulk", label: "Bulk SMS Packages" },
    { key: "both", label: "OTP + Bulk Packages" },
  ];

  const handleBuy = async (pkg) => {
    if (!selectedAppId) {
      setError("Please select an app first.");
      return;
    }
    setBuyingId(pkg.id);
    setError(null);
    try {
      const res = await requestCredit({
        packageId: pkg.id,
        appId: selectedAppId,
        packageName: pkg.name,
        smsQuota: pkg.sms_quota,
        amountBdt: pkg.price_bdt,
      });
      setPaymentModal({
        transactionId: res.data.transactionId,
        bkashNumber: res.data.bkashNumber,
        bkashNote: res.data.bkashNote,
        amount: res.data.amount,
        packageName: pkg.name,
      });
      setTrxId("");
    } catch (err) {
      setError(err.message || "Failed to initiate purchase.");
    } finally {
      setBuyingId(null);
    }
  };

  const handleSubmitTrxId = async () => {
    if (!trxId.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await submitTrxId({
        transactionId: paymentModal.transactionId,
        trxId: trxId.trim(),
      });
      setSuccessMsg("TrxID submitted! Awaiting admin approval.");
      setPaymentModal(null);
      setTrxId("");
    } catch (err) {
      setError(err.message || "Failed to submit TrxID.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <div className="mb-8 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Buy Credits</h1>
          <p className="mt-1 text-sm text-gray-500">
            Purchase OTP or bulk credit packages for your registered app.
          </p>
        </div>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {successMsg && (
        <div className="mb-6 rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-700">
          {successMsg}
        </div>
      )}

      {loading ? (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
          Loading packages…
        </div>
      ) : apps.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
          No registered apps found. Register an app before purchasing credits.
        </div>
      ) : (
        <div className="space-y-6">
          {/* App selector + balances */}
          <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-gray-700">
                  Selected app
                </p>
                <p className="mt-1 text-lg font-semibold text-gray-900">
                  {selectedApp?.name}
                </p>
                <p className="mt-1 text-sm text-gray-500">
                  {selectedApp?.appId}
                </p>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">
                  Switch app
                </label>
                <select
                  value={selectedAppId}
                  onChange={(event) => setSelectedAppId(event.target.value)}
                  className="mt-2 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900"
                >
                  {apps.map((app) => (
                    <option key={app.appId} value={app.appId}>
                      {app.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl border border-gray-200 bg-gray-50 p-5">
                <p className="text-xs uppercase tracking-wide text-gray-500">
                  OTP balance
                </p>
                <p className="mt-3 text-3xl font-semibold text-gray-900">
                  {selectedApp?.sms_remaining?.toLocaleString() ?? "0"}
                </p>
              </div>
              <div className="rounded-2xl border border-gray-200 bg-gray-50 p-5">
                <p className="text-xs uppercase tracking-wide text-gray-500">
                  Bulk balance
                </p>
                <p className="mt-3 text-3xl font-semibold text-gray-900">
                  {selectedApp?.bulk_sms_remaining?.toLocaleString() ?? "0"}
                </p>
              </div>
            </div>
          </div>

          {/* Package cards */}
          <div className="grid gap-6 xl:grid-cols-[1fr_320px]">
            {/* Package sections grouped by type */}
            <div className="space-y-8">
              {remotePackages === null && (
                <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
                  Could not load packages from server. Please refresh or contact
                  support.
                </div>
              )}
              {remotePackages !== null && packages.length === 0 && (
                <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
                  No packages available at the moment.
                </div>
              )}
              {packageSections.map(({ key, label }) => {
                const sectionPkgs = groupedPackages[key];
                if (!sectionPkgs?.length) return null;
                return (
                  <div key={key}>
                    <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-500">
                      {label}
                    </h2>
                    <div className="grid gap-6 sm:grid-cols-2">
                      {sectionPkgs.map((pkg) => (
                        <div
                          key={pkg.id}
                          className="flex flex-col justify-between rounded-lg border border-gray-200 bg-white p-6 shadow-sm transition-shadow hover:shadow-md"
                        >
                          <div>
                            <div className="flex items-center justify-between gap-4">
                              <div>
                                <p className="text-lg font-semibold text-gray-900">
                                  {pkg.name}
                                </p>
                                <p className="mt-1 text-sm text-gray-500">
                                  {pkg.sms_quota?.toLocaleString() ?? "0"}{" "}
                                  {packageCreditLabel(pkg)}
                                </p>
                              </div>
                              <p className="text-3xl font-bold text-brand-600">
                                ৳{pkg.price_bdt?.toLocaleString() ?? "0"}
                              </p>
                            </div>
                            {pkg.validity_days && (
                              <p className="mt-2 text-xs text-gray-400">
                                Valid for {pkg.validity_days} days
                              </p>
                            )}
                          </div>
                          <Button
                            variant="primary"
                            className="mt-6 w-full"
                            disabled={buyingId === pkg.id}
                            onClick={() => handleBuy(pkg)}
                          >
                            {buyingId === pkg.id ? "Processing…" : "Buy Now"}
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

            <aside className="rounded-lg border border-gray-200 bg-gray-50 p-6 text-sm text-gray-700">
              <p className="text-sm font-semibold text-gray-900">
                How it works
              </p>
              <ol className="mt-3 list-inside list-decimal space-y-1">
                <li>Select your app above.</li>
                <li>Choose a credit package.</li>
                <li>Send payment via bKash.</li>
                <li>Enter the TrxID for admin approval.</li>
              </ol>
            </aside>
          </div>
        </div>
      )}

      {/* Payment modal */}
      {paymentModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-gray-900">
              Payment Instructions
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              Send the amount to the bKash number below, then enter the TrxID.
            </p>
            <div className="mt-4 space-y-3 rounded-lg bg-gray-50 p-4">
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">Package</span>
                <span className="text-sm font-semibold text-gray-900">
                  {paymentModal.packageName}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">bKash Number</span>
                <div className="text-right">
                  <span className="text-sm font-semibold text-gray-900">
                    {paymentModal.bkashNumber}
                  </span>
                  {paymentModal.bkashNote && (
                    <p className="text-xs text-gray-500">
                      {paymentModal.bkashNote}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">Amount</span>
                <span className="text-sm font-semibold text-gray-900">
                  ৳{paymentModal.amount}
                </span>
              </div>
            </div>
            <div className="mt-4">
              <label
                htmlFor="trxId"
                className="block text-sm font-medium text-gray-700"
              >
                bKash TrxID
              </label>
              <input
                id="trxId"
                name="trxId"
                type="text"
                required
                value={trxId}
                onChange={(e) => setTrxId(e.target.value)}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:ring-brand-500"
                placeholder="Enter TrxID"
              />
            </div>
            {error && (
              <div className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-700">
                {error}
              </div>
            )}
            <div className="mt-6 flex justify-end gap-3">
              <Button
                variant="outline"
                onClick={() => {
                  setPaymentModal(null);
                  setError(null);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleSubmitTrxId}
                disabled={submitting || !trxId.trim()}
              >
                {submitting ? "Submitting…" : "Submit TrxID"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
