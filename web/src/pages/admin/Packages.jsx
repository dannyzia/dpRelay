import React, { useEffect, useState } from "react";
import { listPackages, upsertPackage } from "../../utils/firebase";
import Button from "../../components/ui/Button";

const packageTypes = [
  { value: "otp", label: "OTP" },
  { value: "bulk", label: "Bulk" },
  { value: "both", label: "OTP + Bulk" },
];

export default function Packages() {
  const [packages, setPackages] = useState([]);
  const [filterType, setFilterType] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({
    packageId: "",
    name: "",
    sms_quota: "",
    price_bdt: "",
    validity_days: "",
    type: "otp",
    is_active: true,
  });

  const loadPackages = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await listPackages();
      setPackages(response.data.packages || []);
    } catch (err) {
      setError(err.message || "Unable to load packages");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPackages();
  }, []);

  const startEditPackage = (pkg) => {
    setForm({
      packageId: pkg.id,
      name: pkg.name || "",
      sms_quota: pkg.sms_quota || 0,
      price_bdt: pkg.price_bdt || 0,
      validity_days: pkg.validity_days || 30,
      type: pkg.type || "otp",
      is_active: pkg.is_active !== false,
    });
  };

  const resetForm = () => {
    setForm({
      packageId: "",
      name: "",
      sms_quota: "",
      price_bdt: "",
      validity_days: "",
      type: "otp",
      is_active: true,
    });
    setError(null);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const payload = {
        packageId: form.packageId || undefined,
        name: form.name.trim(),
        sms_quota: Number(form.sms_quota),
        price_bdt: Number(form.price_bdt),
        validity_days: Number(form.validity_days),
        type: form.type,
        is_active: form.is_active,
      };

      await upsertPackage(payload);
      await loadPackages();
      resetForm();
    } catch (err) {
      setError(err.message || "Failed to save package");
    } finally {
      setLoading(false);
    }
  };

  const toggleActive = async (pkg) => {
    setLoading(true);
    setError(null);
    try {
      await upsertPackage({
        packageId: pkg.id,
        name: pkg.name,
        sms_quota: pkg.sms_quota,
        price_bdt: pkg.price_bdt,
        validity_days: pkg.validity_days,
        type: pkg.type || "otp",
        is_active: !pkg.is_active,
      });
      await loadPackages();
    } catch (err) {
      setError(err.message || "Unable to update package");
    } finally {
      setLoading(false);
    }
  };

  // Filter packages by type. Packages with type "both" appear in both
  // the "otp" and "bulk" filter views, matching the client-side logic.
  const filteredPackages = packages.filter((pkg) => {
    if (!filterType) return true;
    const pkgType = (pkg.type || "otp").toLowerCase();
    return pkgType === filterType || pkgType === "both";
  });

  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Manage Packages</h1>
          <p className="mt-1 text-sm text-gray-400">
            Create, edit, and deactivate credit packages.
          </p>
        </div>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-red-500 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
        <div>
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <label className="text-sm font-medium text-gray-300">
                Filter by type
              </label>
              <select
                value={filterType}
                onChange={(event) => setFilterType(event.target.value)}
                className="mt-2 rounded-lg border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-white"
              >
                <option value="">All types</option>
                {packageTypes.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border border-gray-700 bg-gray-800">
            <table className="min-w-full divide-y divide-gray-700 text-sm">
              <thead className="bg-gray-900">
                <tr>
                  <th className="px-6 py-3 text-left uppercase tracking-wider text-gray-400">
                    Name
                  </th>
                  <th className="px-6 py-3 text-left uppercase tracking-wider text-gray-400">
                    Type
                  </th>
                  <th className="px-6 py-3 text-right uppercase tracking-wider text-gray-400">
                    Credits
                  </th>
                  <th className="px-6 py-3 text-right uppercase tracking-wider text-gray-400">
                    Price
                  </th>
                  <th className="px-6 py-3 text-right uppercase tracking-wider text-gray-400">
                    Validity
                  </th>
                  <th className="px-6 py-3 text-center uppercase tracking-wider text-gray-400">
                    Active
                  </th>
                  <th className="px-6 py-3 text-right uppercase tracking-wider text-gray-400">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700 bg-gray-800">
                {loading ? (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-6 py-12 text-center text-sm text-gray-400"
                    >
                      Loading packages...
                    </td>
                  </tr>
                ) : filteredPackages.length === 0 ? (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-6 py-12 text-center text-sm text-gray-400"
                    >
                      No packages found.
                    </td>
                  </tr>
                ) : (
                  filteredPackages.map((pkg) => (
                    <tr key={pkg.id}>
                      <td className="px-6 py-4 text-gray-100">{pkg.name}</td>
                      <td className="px-6 py-4 text-gray-300 capitalize">
                        {pkg.type || "otp"}
                      </td>
                      <td className="px-6 py-4 text-right text-gray-100">
                        {pkg.sms_quota?.toLocaleString() ?? "0"}
                      </td>
                      <td className="px-6 py-4 text-right text-gray-100">
                        ৳{pkg.price_bdt?.toLocaleString() ?? "0"}
                      </td>
                      <td className="px-6 py-4 text-right text-gray-100">
                        {pkg.validity_days}d
                      </td>
                      <td className="px-6 py-4 text-center text-sm text-gray-100">
                        <span
                          className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${pkg.is_active ? "bg-green-800 text-green-200" : "bg-gray-700 text-gray-300"}`}
                        >
                          {pkg.is_active ? "Yes" : "No"}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right space-x-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => startEditPackage(pkg)}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => toggleActive(pkg)}
                        >
                          {pkg.is_active ? "Disable" : "Enable"}
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-lg border border-gray-700 bg-gray-800 p-6">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-white">
                {form.packageId ? "Update Package" : "Create Package"}
              </h2>
              <p className="text-sm text-gray-400">
                Use package type to deliver OTP, bulk, or combined credit
                bundles.
              </p>
            </div>
          </div>

          <form className="space-y-4" onSubmit={handleSubmit}>
            <div>
              <label className="block text-sm font-medium text-gray-300">
                Package name
              </label>
              <input
                type="text"
                value={form.name}
                onChange={(event) =>
                  setForm({ ...form, name: event.target.value })
                }
                className="mt-2 w-full rounded-lg border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-white"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-300">
                Credit type
              </label>
              <select
                value={form.type}
                onChange={(event) =>
                  setForm({ ...form, type: event.target.value })
                }
                className="mt-2 w-full rounded-lg border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-white"
              >
                {packageTypes.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-sm font-medium text-gray-300">
                  SMS quota
                </label>
                <input
                  type="number"
                  min="1"
                  value={form.sms_quota}
                  onChange={(event) =>
                    setForm({ ...form, sms_quota: event.target.value })
                  }
                  className="mt-2 w-full rounded-lg border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300">
                  Price (BDT)
                </label>
                <input
                  type="number"
                  min="1"
                  value={form.price_bdt}
                  onChange={(event) =>
                    setForm({ ...form, price_bdt: event.target.value })
                  }
                  className="mt-2 w-full rounded-lg border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-white"
                />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-sm font-medium text-gray-300">
                  Validity (days)
                </label>
                <input
                  type="number"
                  min="1"
                  value={form.validity_days}
                  onChange={(event) =>
                    setForm({ ...form, validity_days: event.target.value })
                  }
                  className="mt-2 w-full rounded-lg border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-white"
                />
              </div>
              <div className="flex items-end justify-between gap-3">
                <label className="block text-sm font-medium text-gray-300">
                  Active
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.is_active}
                    onChange={(event) =>
                      setForm({ ...form, is_active: event.target.checked })
                    }
                    className="h-4 w-4 rounded border-gray-600 bg-gray-900 text-brand-500"
                  />
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button type="submit" variant="primary" disabled={loading}>
                {form.packageId ? "Save changes" : "Create package"}
              </Button>
              {form.packageId && (
                <Button type="button" variant="outline" onClick={resetForm}>
                  Cancel
                </Button>
              )}
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
