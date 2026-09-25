/**
 * V5 dashboard slice pages: login, session credentials (requireApp plane),
 * and campaigns (list / create / detail) against /v5/bulk/campaigns.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  V5ApiError,
  campaignAction,
  clearAppCredentials,
  createCampaign,
  getAppCredentials,
  getCampaign,
  getFailedRecipients,
  listCampaigns,
  login as apiLogin,
  setAppCredentials,
  verifyAppCredentials,
} from './api.js';
import { useV5Auth } from './V5AuthContext.jsx';

/** Shapes an unknown thrown value into a user-readable message. */
export function describeError(err) {
  if (err instanceof V5ApiError) return `${err.error} (${err.code})`;
  if (err instanceof Error) return err.message;
  return 'Unexpected error';
}

const STATUS_STYLES = {
  queued: 'bg-amber-100 text-amber-800',
  sending: 'bg-blue-100 text-blue-800',
  paused: 'bg-yellow-100 text-yellow-900',
  completed: 'bg-emerald-100 text-emerald-800',
  cancelled: 'bg-slate-200 text-slate-700',
};

/** Colored status pill; unknown statuses degrade to slate. */
export function StatusPill({ status }) {
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_STYLES[status] ?? 'bg-slate-100 text-slate-600'}`}>
      {status}
    </span>
  );
}

/** Formats epoch seconds as a local date-time string. */
export function formatEpoch(sec) {
  if (!sec) return '—';
  return new Date(sec * 1000).toLocaleString();
}

// ── Login ──────────────────────────────────────────────────────────────────

export function V5Login() {
  const { login, isAuthenticated } = useV5Auth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isAuthenticated) navigate('/v5', { replace: true });
  }, [isAuthenticated, navigate]);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
      navigate('/v5', { replace: true });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-xl font-bold text-slate-900">Sign in to dP Relay</h1>
        <p className="mt-1 text-sm text-slate-500">v5 dashboard — email and password</p>
        <form className="mt-6 space-y-4" onSubmit={submit}>
          <div>
            <label className="block text-sm font-medium text-slate-700" htmlFor="v5-email">Email</label>
            <input
              id="v5-email" type="email" required autoComplete="email" value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700" htmlFor="v5-password">Password</label>
            <input
              id="v5-password" type="password" required autoComplete="current-password" value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
          <button
            type="submit" disabled={busy}
            className="w-full rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}

// ── Session credentials (requireApp plane) ─────────────────────────────────

export function V5SessionCredentials() {
  const { refreshCredentials } = useV5Auth();
  const [appId, setAppId] = useState(() => getAppCredentials()?.appId ?? '');
  const [appSecret, setAppSecret] = useState('');
  const [verified, setVerified] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setVerified(null);
    try {
      await verifyAppCredentials(appId.trim(), appSecret);
      setAppCredentials(appId.trim(), appSecret);
      refreshCredentials();
      setVerified(true);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const clear = () => {
    clearAppCredentials();
    refreshCredentials();
    setAppId('');
    setAppSecret('');
    setVerified(null);
  };

  return (
    <div className="mx-auto max-w-xl">
      <h1 className="text-2xl font-bold text-slate-900">Session credentials</h1>
      <p className="mt-1 text-sm text-slate-500">
        The v5 API manages apps with per-app credentials (<code className="rounded bg-slate-100 px-1">X-App-Id</code> /{' '}
        <code className="rounded bg-slate-100 px-1">X-App-Secret</code>). They are kept for this browser tab only and never persisted.
      </p>
      <form className="mt-6 space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm" onSubmit={save}>
        <div>
          <label className="block text-sm font-medium text-slate-700" htmlFor="v5-app-id">App ID</label>
          <input
            id="v5-app-id" required value={appId}
            onChange={(e) => setAppId(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700" htmlFor="v5-app-secret">App Secret</label>
          <input
            id="v5-app-secret" type="password" required value={appSecret}
            onChange={(e) => setAppSecret(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>
        {verified === true && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">Credentials verified and saved for this session.</p>}
        {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
        <div className="flex gap-3">
          <button
            type="submit" disabled={busy}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {busy ? 'Verifying…' : 'Verify & save'}
          </button>
          <button type="button" onClick={clear} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
            Clear
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Campaigns list ─────────────────────────────────────────────────────────

export function V5Campaigns() {
  const { hasCredentials } = useV5Auth();
  const [campaigns, setCampaigns] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (cursor = null, nextStatus = null) => {
    setLoading(true);
    setError(null);
    try {
      const envelope = await listCampaigns({
        status: (nextStatus ?? status) || undefined,
        limit: 20,
        cursor: cursor ?? undefined,
      });
      setCampaigns((prev) => (cursor ? [...prev, ...envelope.campaigns] : envelope.campaigns));
      setNextCursor(envelope.nextCursor);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    if (hasCredentials) load(null);
  }, [hasCredentials, load]);

  if (!hasCredentials) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-6">
        <h2 className="font-semibold text-amber-900">App credentials required</h2>
        <p className="mt-1 text-sm text-amber-800">
          Campaigns are managed with per-app credentials.{' '}
          <Link to="/v5/credentials" className="font-semibold underline">Set them for this session →</Link>
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-slate-900">Campaigns</h1>
        <div className="flex items-center gap-3">
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              load(null, e.target.value);
            }}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
          >
            <option value="">All statuses</option>
            {['queued', 'sending', 'paused', 'completed', 'cancelled'].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <Link
            to="/v5/campaigns/create"
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
          >
            New campaign
          </Link>
        </div>
      </div>

      {error && <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}

      <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Campaign</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Sent</th>
              <th className="px-4 py-3">Failed</th>
              <th className="px-4 py-3">Queued</th>
              <th className="px-4 py-3">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {campaigns.map((c) => (
              <tr key={c.campaignId} className="hover:bg-slate-50">
                <td className="px-4 py-3">
                  <Link to={`/v5/campaigns/${c.campaignId}`} className="font-medium text-indigo-600 hover:underline">
                    {c.name}
                  </Link>
                </td>
                <td className="px-4 py-3"><StatusPill status={c.status} /></td>
                <td className="px-4 py-3">{c.sentCount}</td>
                <td className="px-4 py-3">{c.failedCount}</td>
                <td className="px-4 py-3">{c.queuedCount}</td>
                <td className="px-4 py-3 text-slate-500">{formatEpoch(c.createdAt)}</td>
              </tr>
            ))}
            {campaigns.length === 0 && !loading && (
              <tr>
                <td className="px-4 py-8 text-center text-slate-500" colSpan={6}>No campaigns yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {nextCursor && (
        <button
          onClick={() => load(nextCursor)} disabled={loading}
          className="mt-4 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}

// ── Create campaign ────────────────────────────────────────────────────────

/** Splits free text into E.164 candidates (newline/comma/semicolon separated). */
export function parsePhoneInput(text) {
  return text
    .split(/[\n,;]+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function V5CreateCampaign() {
  const navigate = useNavigate();
  const [campaignName, setCampaignName] = useState('');
  const [message, setMessage] = useState('');
  const [phonesText, setPhonesText] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const phones = useMemo(() => parsePhoneInput(phonesText), [phonesText]);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const envelope = await createCampaign({ campaignName, message, sourceType: 'csv', phones });
      navigate(`/v5/campaigns/${envelope.campaignId}`, { replace: true });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-bold text-slate-900">New campaign</h1>
      <form className="mt-6 space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm" onSubmit={submit}>
        <div>
          <label className="block text-sm font-medium text-slate-700" htmlFor="v5-campaign-name">Campaign name</label>
          <input
            id="v5-campaign-name" required maxLength={100} value={campaignName}
            onChange={(e) => setCampaignName(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700" htmlFor="v5-campaign-message">Message</label>
          <textarea
            id="v5-campaign-message" required rows={4} value={message}
            onChange={(e) => setMessage(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700" htmlFor="v5-campaign-phones">
            Recipients ({phones.length} parsed)
          </label>
          <textarea
            id="v5-campaign-phones" required rows={6} value={phonesText}
            onChange={(e) => setPhonesText(e.target.value)}
            placeholder={'+8801712345678\n+8801812345678'}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
          <p className="mt-1 text-xs text-slate-500">One E.164 number per line (commas or semicolons also accepted). Duplicates are deduplicated server-side.</p>
        </div>
        {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
        <button
          type="submit" disabled={busy}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create campaign'}
        </button>
      </form>
    </div>
  );
}

// ── Campaign detail + lifecycle actions ────────────────────────────────────

const ACTIONS = [
  { key: 'pause', label: 'Pause', statuses: ['queued', 'sending'] },
  { key: 'resume', label: 'Resume', statuses: ['paused'] },
  { key: 'cancel', label: 'Cancel (refund)', statuses: ['queued', 'sending', 'paused'] },
  { key: 'retry-failed', label: 'Retry failed', statuses: ['queued', 'sending', 'paused', 'completed'] },
];

export function V5CampaignDetail() {
  const { campaignId } = useParams();
  const [campaign, setCampaign] = useState(null);
  const [failed, setFailed] = useState([]);
  const [showFailed, setShowFailed] = useState(false);
  const [error, setError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [busyAction, setBusyAction] = useState(null);

  const load = useCallback(async () => {
    try {
      const envelope = await getCampaign(campaignId);
      setCampaign(envelope.campaign);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  }, [campaignId]);

  useEffect(() => {
    load();
  }, [load]);

  const loadFailed = useCallback(async () => {
    try {
      const envelope = await getFailedRecipients(campaignId);
      setFailed(envelope.failedRecipients);
    } catch (err) {
      setError(describeError(err));
    }
  }, [campaignId]);

  const runAction = async (action) => {
    setBusyAction(action);
    setActionError(null);
    try {
      await campaignAction(campaignId, action);
      await load();
      if (showFailed) await loadFailed();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusyAction(null);
    }
  };

  if (error && !campaign) {
    return <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>;
  }
  if (!campaign) {
    return <p className="text-sm text-slate-500">Loading campaign…</p>;
  }

  const available = ACTIONS.filter((a) => a.statuses.includes(campaign.status));

  return (
    <div className="mx-auto max-w-3xl">
      <Link to="/v5/campaigns" className="text-sm text-indigo-600 hover:underline">← Back to campaigns</Link>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-slate-900">{campaign.name}</h1>
        <StatusPill status={campaign.status} />
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm sm:grid-cols-4">
        {[
          ['Recipients', campaign.totalRecipients],
          ['Sent', campaign.sentCount],
          ['Failed', campaign.failedCount],
          ['Queued', campaign.queuedCount],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
            <dd className="mt-1 text-2xl font-bold text-slate-900">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Message</h2>
        <p className="mt-2 whitespace-pre-wrap text-sm text-slate-800">{campaign.message}</p>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 text-sm text-slate-600 sm:grid-cols-3">
        <div><span className="font-medium text-slate-800">Source:</span> {campaign.sourceType}</div>
        <div><span className="font-medium text-slate-800">Created:</span> {formatEpoch(campaign.createdAt)}</div>
        <div><span className="font-medium text-slate-800">Started:</span> {formatEpoch(campaign.startedAt)}</div>
        <div><span className="font-medium text-slate-800">Completed:</span> {formatEpoch(campaign.completedAt)}</div>
      </div>

      {available.length > 0 && (
        <div className="mt-6 flex flex-wrap gap-3">
          {available.map((a) => (
            <button
              key={a.key}
              onClick={() => runAction(a.key)}
              disabled={busyAction !== null}
              className={`rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 ${
                a.key === 'cancel' ? 'bg-rose-600 hover:bg-rose-700' : 'bg-indigo-600 hover:bg-indigo-700'
              }`}
            >
              {busyAction === a.key ? 'Working…' : a.label}
            </button>
          ))}
        </div>
      )}
      {actionError && <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{actionError}</p>}

      <div className="mt-6">
        <button
          onClick={() => {
            const next = !showFailed;
            setShowFailed(next);
            if (next) loadFailed();
          }}
          className="text-sm font-medium text-indigo-600 hover:underline"
        >
          {showFailed ? 'Hide failed recipients' : 'Show failed recipients'}
        </button>
        {showFailed && (
          <div className="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Phone</th>
                  <th className="px-4 py-3">Attempts</th>
                  <th className="px-4 py-3">Error</th>
                  <th className="px-4 py-3">Last attempt</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {failed.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-3 font-mono">{r.phone}</td>
                    <td className="px-4 py-3">{r.attempts}</td>
                    <td className="px-4 py-3 text-rose-700">{r.errorMessage}</td>
                    <td className="px-4 py-3 text-slate-500">{formatEpoch(r.lastAttemptAt)}</td>
                  </tr>
                ))}
                {failed.length === 0 && (
                  <tr><td className="px-4 py-8 text-center text-slate-500" colSpan={4}>No failed recipients.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
