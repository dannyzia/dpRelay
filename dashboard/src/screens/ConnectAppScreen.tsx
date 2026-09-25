import { useState, type FormEvent } from "react";
import { ApiError, connectApp, getAccessToken, request } from "../api.js";

/**
 * Connect-app screen: the campaigns/credits plane authenticates with app
 * credentials (X-App-Id/X-App-Secret), not the user JWT — verified against
 * production (a Bearer-JWT call to /v5/bulk/* returns 401
 * missing_app_credentials). The operator pastes the app credentials once per
 * browser session; they are verified against /v5/billing/credits BEFORE
 * being stored, so a typo can never silently poison every later screen.
 */
export function ConnectAppScreen(props: { onConnected: () => void }) {
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const token = getAccessToken();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Verify before store: an unauthenticated GET on the credits route
      // proves the credential pair without touching anything.
      await request("/v5/billing/credits", {
        headers: { "X-App-Id": appId.trim(), "X-App-Secret": appSecret },
      });
      connectApp(appId.trim(), appSecret);
      props.onConnected();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "unknown_app") setError("Unknown X-App-Id — check the app id.");
        else if (err.code === "invalid_app_secret" || err.code === "app_revoked") setError(err.message);
        else setError(err.message);
      } else {
        setError("Connection check failed — try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="mx-auto w-full max-w-sm space-y-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-8 shadow-xl"
    >
      <h1 className="text-xl font-semibold text-slate-100">Connect an app</h1>
      {token !== null ? (
        <p className="text-sm text-slate-400">
          Signed in. Campaigns and credits are scoped to an <strong>app</strong> — paste the X-App-Id and
          X-App-Secret you received when the app was provisioned (the secret is shown once at mint time).
        </p>
      ) : (
        <p className="text-sm text-slate-400">Sign-in required before connecting an app.</p>
      )}
      {error !== null && (
        <div role="alert" className="rounded-lg border border-red-800 bg-red-950/60 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-300">App ID (X-App-Id)</span>
        <input
          value={appId}
          onChange={(e) => setAppId(e.target.value)}
          placeholder="e.g. dprelay-prod-2"
          className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-sky-500"
          required
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-300">App secret (X-App-Secret)</span>
        <input
          type="password"
          value={appSecret}
          onChange={(e) => setAppSecret(e.target.value)}
          placeholder="Shown once when the app was provisioned"
          className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-sky-500"
          required
        />
      </label>
      <button
        type="submit"
        disabled={busy || token === null}
        className="w-full rounded-lg bg-sky-600 px-4 py-2.5 font-medium text-white hover:bg-sky-500 disabled:opacity-50"
      >
        {busy ? "Verifying…" : "Connect app"}
      </button>
    </form>
  );
}
