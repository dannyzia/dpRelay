import React, { useEffect, useState } from "react";
import {
  createApp,
  revokeApp,
  regenerateAppSecret,
  listApps,
} from "../../utils/firebase";
import Button from "../../components/ui/Button";

/**
 * Formats a timestamp from Firebase into a human-readable date string.
 * Handles three formats:
 *  - Firestore Timestamp objects (have a `.toDate()` method)
 *  - Plain numbers (milliseconds since epoch, from RTDB `{ ".sv": "timestamp" }`)
 *  - Serialized objects with a `seconds` property (`{ seconds, nanoseconds }`)
 *
 * @param {number|object|null|undefined} timestamp
 * @returns {string} Formatted date string, or a placeholder if unparseable.
 */
function formatAppDate(timestamp) {
  if (!timestamp) {
    return "Not available";
  }

  // Firestore Timestamp class — has a toDate() method
  if (typeof timestamp.toDate === "function") {
    return timestamp.toDate().toLocaleString();
  }

  // Raw milliseconds number (RTDB server timestamp)
  if (typeof timestamp === "number") {
    return new Date(timestamp).toLocaleString();
  }

  // Serialised Firestore-style object { seconds, nanoseconds }
  if (typeof timestamp === "object" && timestamp.seconds != null) {
    return new Date(timestamp.seconds * 1000).toLocaleString();
  }

  return "Invalid Date";
}

export default function Apps() {
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showRegister, setShowRegister] = useState(false);
  const [newAppName, setNewAppName] = useState("");
  const [registering, setRegistering] = useState(false);
  const [newAppResult, setNewAppResult] = useState(null);
  const [regenerating, setRegenerating] = useState(null);
  const [newSecret, setNewSecret] = useState(null);
  const [copied, setCopied] = useState(null);

  const loadApps = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await listApps();
      setApps(response.data.apps || []);
    } catch (err) {
      setError(err.message || "Unable to load apps");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadApps();
  }, []);

  const handleRegister = async (e) => {
    e.preventDefault();
    if (!newAppName.trim()) return;
    setRegistering(true);
    setError(null);
    try {
      const response = await createApp({ appName: newAppName.trim() });
      setNewAppResult(response.data);
      setNewAppName("");
    } catch (err) {
      setError(err.message || "Failed to create app");
    } finally {
      setRegistering(false);
    }
  };

  const handleRevoke = async (appId) => {
    if (
      !window.confirm("Revoke this app? Existing API keys will stop working.")
    )
      return;
    setError(null);
    try {
      await revokeApp({ appId });
      await loadApps();
    } catch (err) {
      setError(err.message || "Failed to revoke app");
    }
  };

  const handleRegenerate = async (appId) => {
    if (
      !window.confirm(
        "Regenerate secret? The current secret will stop working immediately.",
      )
    )
      return;
    setRegenerating(appId);
    setError(null);
    setNewSecret(null);
    try {
      const response = await regenerateAppSecret({ appId });
      setNewSecret(response.data.appSecret);
      setNewAppResult({ appId, appSecret: response.data.appSecret });
    } catch (err) {
      setError(err.message || "Failed to regenerate secret");
    } finally {
      setRegenerating(null);
    }
  };

  const copyToClipboard = (text, key) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const closeResult = () => {
    setNewAppResult(null);
    setNewSecret(null);
    loadApps();
  };

  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Your Apps</h1>
          <p className="mt-1 text-sm text-gray-500">
            Manage your registered applications, API keys, and webhook settings.
          </p>
        </div>
        <Button variant="primary" onClick={() => setShowRegister(true)}>
          Register New App
        </Button>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Register modal */}
      {showRegister && !newAppResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-gray-900">
              Register New App
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              Enter a name for your application.
            </p>
            <form onSubmit={handleRegister} className="mt-4 space-y-4">
              <div>
                <label
                  htmlFor="appName"
                  className="block text-sm font-medium text-gray-700"
                >
                  App Name
                </label>
                <input
                  id="appName"
                  name="appName"
                  type="text"
                  required
                  value={newAppName}
                  onChange={(e) => setNewAppName(e.target.value)}
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                  placeholder="My App"
                />
              </div>
              <div className="flex justify-end gap-3">
                <Button
                  variant="outline"
                  onClick={() => setShowRegister(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={registering || !newAppName.trim()}
                >
                  {registering ? "Creating…" : "Create App"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* App created — show credentials */}
      {newAppResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-green-700">
              App created successfully
            </h2>
            <p className="mt-2 text-sm text-red-600 font-semibold">
              Save this secret now — it will never be shown again.
            </p>
            <div className="mt-4 space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide">
                  App ID
                </label>
                <div className="mt-1 flex items-center gap-2">
                  <code className="flex-1 rounded-md bg-gray-100 px-3 py-2 text-sm font-mono break-all">
                    {newAppResult.appId}
                  </code>
                  <button
                    onClick={() => copyToClipboard(newAppResult.appId, "appId")}
                    className="rounded-md border border-gray-300 px-3 py-2 text-xs font-medium hover:bg-gray-50"
                  >
                    {copied === "appId" ? "Copied!" : "Copy"}
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide">
                  App Secret
                </label>
                <div className="mt-1 flex items-center gap-2">
                  <code className="flex-1 rounded-md bg-gray-100 px-3 py-2 text-sm font-mono break-all">
                    {newAppResult.appSecret}
                  </code>
                  <button
                    onClick={() =>
                      copyToClipboard(newAppResult.appSecret, "appSecret")
                    }
                    className="rounded-md border border-gray-300 px-3 py-2 text-xs font-medium hover:bg-gray-50"
                  >
                    {copied === "appSecret" ? "Copied!" : "Copy"}
                  </button>
                </div>
              </div>
            </div>
            <div className="mt-6 flex justify-end">
              <Button variant="primary" onClick={closeResult}>
                Done
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* App list */}
      {loading ? (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
          Loading apps...
        </div>
      ) : apps.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-12 text-center">
          <p className="text-gray-400">No apps registered yet.</p>
          <Button
            variant="primary"
            className="mt-4"
            onClick={() => setShowRegister(true)}
          >
            Register New App
          </Button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left font-semibold uppercase tracking-wider text-gray-500">
                  Name
                </th>
                <th className="px-6 py-3 text-left font-semibold uppercase tracking-wider text-gray-500">
                  App ID
                </th>
                <th className="px-6 py-3 text-left font-semibold uppercase tracking-wider text-gray-500">
                  Status
                </th>
                <th className="px-6 py-3 text-left font-semibold uppercase tracking-wider text-gray-500">
                  Created
                </th>
                <th className="px-6 py-3 text-right font-semibold uppercase tracking-wider text-gray-500">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white">
              {apps.map((app) => (
                <tr key={app.appId}>
                  <td className="px-6 py-4 font-medium text-gray-900">
                    {app.name}
                  </td>
                  <td className="px-6 py-4 font-mono text-xs text-gray-600">
                    {app.appId}
                  </td>
                  <td className="px-6 py-4">
                    <span
                      className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${app.active ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`}
                    >
                      {app.active ? "Active" : "Revoked"}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-gray-600">
                    {formatAppDate(app.createdAt)}
                  </td>
                  <td className="px-6 py-4 text-right space-x-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handleRegenerate(app.appId)}
                      disabled={regenerating === app.appId}
                    >
                      {regenerating === app.appId
                        ? "Regenerating…"
                        : "Regenerate Secret"}
                    </Button>
                    {app.active && (
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => handleRevoke(app.appId)}
                      >
                        Revoke
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
