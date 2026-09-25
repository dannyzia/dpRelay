import { useEffect, useState } from "react";
import {
  clearOperatorSecret,
  createAdminApp,
  describeError,
  getAdminMetrics,
  getCredentialsStatus,
  getOperatorSecret,
  listAdminApps,
  listOversightCampaigns,
  listPendingTransactions,
  resolveTransaction,
  revokeAdminApp,
  rotateAdminAppWebhookSecret,
  setKillSwitch,
  setOperatorSecret,
  unrevokeAdminApp,
  updateAdminAppWebhook,
  type AdminApp,
  type AdminMetrics,
  type CredentialsStatus,
  type OversightCampaign,
  type PendingTransaction,
} from "../api.js";

/**
 * Operator admin view (server requireOperator plane). The operator secret is
 * pasted once per browser session and VERIFIED against /v5/admin/metrics
 * before being stored; a 401 from any operator call clears it and re-locks.
 * Sections: aggregate metrics, TrxID approvals (queue → approve/reject),
 * global SMS kill switch, apps registry (create → show-once secrets, revoke/
 * unrevoke, webhook URL + secret rotation, credentials-status), campaign
 * oversight.
 */

function StatCard({ label, value, sub }: { label: string; value: number | string; sub?: string }): JSX.Element {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {sub !== undefined && <p className="text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

/** Show-once secret surface: impossible to re-read later, so make it loud. */
function ShowOnceSecret({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rounded-lg border border-amber-700 bg-amber-950/40 p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-amber-300">{label} — shown once, never again</p>
      <p className="mt-1 break-all font-mono text-sm text-amber-100">{value}</p>
      <button
        onClick={() => void navigator.clipboard.writeText(value).catch(() => {})}
        className="mt-2 rounded border border-amber-700 px-2 py-1 text-xs text-amber-200 hover:border-amber-400"
      >
        Copy
      </button>
    </div>
  );
}

export function OperatorScreen() {
  const [unlocked, setUnlocked] = useState(getOperatorSecret() !== null);
  const [secretInput, setSecretInput] = useState("");
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);

  async function unlock(): Promise<void> {
    if (secretInput.length === 0) {
      setUnlockError("Paste the operator secret (OPERATOR_SECRET)");
      return;
    }
    setUnlocking(true);
    setOperatorSecret(secretInput);
    try {
      await getAdminMetrics(); // verification probe — throws 401 on a bad secret
      setUnlocked(true);
      setSecretInput("");
      setUnlockError(null);
    } catch (err) {
      clearOperatorSecret();
      setUnlockError(describeError(err));
    } finally {
      setUnlocking(false);
    }
  }

  if (!unlocked) {
    return (
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Operator view</h2>
          <p className="text-sm text-slate-400">Gated by the server's OPERATOR_SECRET. The secret stays in this tab's session only.</p>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <input
            type="password"
            value={secretInput}
            onChange={(e) => setSecretInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void unlock();
            }}
            placeholder="OPERATOR_SECRET"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm outline-none focus:border-sky-500"
          />
          <button
            onClick={() => void unlock()}
            disabled={unlocking}
            className="mt-3 w-fit rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            Unlock
          </button>
          {unlockError !== null && <p className="mt-3 rounded-lg border border-rose-900 bg-rose-950/50 px-3 py-2 text-sm text-rose-300">{unlockError}</p>}
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-10">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Operator view</h2>
          <p className="text-sm text-slate-400">Metrics, approvals, kill switch, and the app registry.</p>
        </div>
        <button
          onClick={() => {
            clearOperatorSecret();
            setUnlocked(false);
          }}
          className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-500"
        >
          Lock
        </button>
      </div>
      <MetricsSection />
      <ApprovalsSection />
      <KillSwitchSection />
      <AppsSection />
      <OversightSection />
    </section>
  );
}

function MetricsSection(): JSX.Element {
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAdminMetrics()
      .then(setMetrics)
      .catch((err: unknown) => setError(describeError(err)));
  }, []);

  if (error !== null) return <p className="rounded-lg border border-rose-900 bg-rose-950/50 px-3 py-2 text-sm text-rose-300">{error}</p>;
  if (metrics === null) return <p className="text-sm text-slate-500">Loading metrics…</p>;

  return (
    <div>
      <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Aggregate metrics</h3>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Apps" value={metrics.apps.total} sub={`${metrics.apps.revoked} revoked`} />
        <StatCard label="Users / devices" value={metrics.users.total} sub={`${metrics.users.devices} devices`} />
        <StatCard label="OTP sessions" value={metrics.otp.sessionsTotal} sub={`${metrics.otp.sessionsPending} pending · ${metrics.otp.sessionsVerified} verified`} />
        <StatCard label="OTP last 24h" value={metrics.otp.sessionsLast24h} />
        <StatCard label="Campaigns" value={metrics.bulk.campaignsTotal} sub={`${metrics.bulk.campaignsActive} active`} />
        <StatCard label="Bulk sent" value={metrics.bulk.recipientsSent} sub={`${metrics.bulk.recipientsFailed} failed · ${metrics.bulk.recipientsQueued} queued`} />
        <StatCard label="TrxID pending" value={metrics.billing.transactionsPending} sub={`${metrics.billing.transactionsApproved} approved · ${metrics.billing.transactionsRejected} rejected`} />
        <StatCard label="Webhooks 24h" value={metrics.webhooks.deliveriesLast24h} sub={`${metrics.webhooks.deliveredLast24h} delivered · ${metrics.webhooks.failedLast24h} failed`} />
      </div>
    </div>
  );
}

function ApprovalsSection(): JSX.Element {
  const [pending, setPending] = useState<PendingTransaction[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reload(): Promise<void> {
    try {
      setPending(await listPendingTransactions());
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function resolve(t: PendingTransaction, approve: boolean): Promise<void> {
    let rejectReason: string | undefined;
    if (!approve) {
      rejectReason = prompt(`Reason for rejecting TrxID ${t.trxId ?? t.transactionId}:`) ?? undefined;
      if (rejectReason === undefined || rejectReason.trim().length === 0) return;
    }
    setBusy(true);
    try {
      const res = await resolveTransaction(t.transactionId, approve, rejectReason);
      setNotice(
        approve
          ? `Approved — new balances: OTP ${res.newOtpBalance ?? 0}, bulk ${res.newBulkBalance ?? 0}`
          : "Rejected",
      );
      await reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">TrxID approvals</h3>
      {error !== null && <p className="mt-2 rounded-lg border border-rose-900 bg-rose-950/50 px-3 py-2 text-sm text-rose-300">{error}</p>}
      {notice !== null && <p className="mt-2 rounded-lg border border-emerald-900 bg-emerald-950/50 px-3 py-2 text-sm text-emerald-300">{notice}</p>}
      {pending === null ? (
        <p className="mt-2 text-sm text-slate-500">Loading queue…</p>
      ) : pending.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">Queue clear — no pending transactions.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {pending.map((t) => (
            <li key={t.transactionId} className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-mono text-sm">{t.trxId ?? "(no TrxID submitted)"}</p>
                  <p className="text-xs text-slate-500">
                    {t.appId} · {t.packageCode} ({t.packageType}) · ৳{t.amountBdt} → {t.smsQuota} SMS · requested {new Date(t.requestedAt * 1000).toLocaleString()}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => void resolve(t, true)} disabled={busy} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
                    Approve
                  </button>
                  <button onClick={() => void resolve(t, false)} disabled={busy} className="rounded-lg border border-rose-900 px-3 py-1.5 text-xs text-rose-300 hover:border-rose-500 disabled:opacity-50">
                    Reject
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function KillSwitchSection(): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<string | null>(null);

  async function flip(enabled: boolean): Promise<void> {
    if (enabled && !confirm("PAUSE all OTP SMS sending (503 sms_paused on /v5/otp/send)?")) return;
    setBusy(true);
    try {
      const res = await setKillSwitch(enabled);
      setState(res.enabled ? "SMS sending is PAUSED" : "SMS sending is running");
    } catch (err) {
      setState(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Global SMS kill switch</h3>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button onClick={() => void flip(true)} disabled={busy} className="rounded-lg border border-rose-900 px-4 py-2 text-sm text-rose-300 hover:border-rose-500 disabled:opacity-50">
          Pause OTP SMS
        </button>
        <button onClick={() => void flip(false)} disabled={busy} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
          Resume OTP SMS
        </button>
        {state !== null && <span className="text-sm text-slate-400">{state}</span>}
      </div>
    </div>
  );
}

function AppsSection(): JSX.Element {
  const [apps, setApps] = useState<AdminApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showOnce, setShowOnce] = useState<{ appId: string; appSecret: string; webhookSecret: string } | null>(null);
  const [newAppId, setNewAppId] = useState("");
  const [newName, setNewName] = useState("");
  const [newWebhook, setNewWebhook] = useState("");
  const [status, setStatus] = useState<CredentialsStatus | null>(null);

  async function reload(): Promise<void> {
    try {
      const res = await listAdminApps();
      setApps(res.apps);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function create(): Promise<void> {
    const appId = newAppId.trim();
    if (!/^[A-Za-z0-9_-]{3,64}$/.test(appId)) {
      setError("appId must be 3-64 chars of letters, digits, _ or -");
      return;
    }
    setBusy(true);
    try {
      const created = await createAdminApp({
        appId,
        ...(newName.trim().length > 0 ? { name: newName.trim() } : {}),
        ...(newWebhook.trim().length > 0 ? { webhookUrl: newWebhook.trim() } : {}),
      });
      setShowOnce({ appId: created.appId, appSecret: created.appSecret, webhookSecret: created.webhookSecret });
      setNotice(null);
      setNewAppId("");
      setNewName("");
      setNewWebhook("");
      await reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleRevoke(a: AdminApp): Promise<void> {
    setBusy(true);
    try {
      if (a.revokedAt === null) {
        if (!confirm(`Revoke ${a.appId}? Every app-plane call fails with 401 app_revoked until an operator un-revokes.`)) {
          setBusy(false);
          return;
        }
        await revokeAdminApp(a.id);
      } else {
        await unrevokeAdminApp(a.id);
      }
      await reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function rotate(a: AdminApp): Promise<void> {
    if (!confirm(`Rotate the webhook secret for ${a.appId}? The old secret stops verifying immediately.`)) return;
    setBusy(true);
    try {
      const res = await rotateAdminAppWebhookSecret(a.id);
      setShowOnce({ appId: a.appId, appSecret: "(unchanged)", webhookSecret: res.webhookSecret });
      await reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function editWebhook(a: AdminApp): Promise<void> {
    const next = prompt(`Webhook URL for ${a.appId} (absolute https://, empty string clears):`, a.webhookUrl ?? "");
    if (next === null) return;
    setBusy(true);
    try {
      await updateAdminAppWebhook(a.id, next.trim());
      setNotice("Webhook URL updated");
      await reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function showStatus(a: AdminApp): Promise<void> {
    try {
      setStatus(await getCredentialsStatus(a.id));
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <div>
      <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Apps registry</h3>

      <div className="mt-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <input
            value={newAppId}
            onChange={(e) => setNewAppId(e.target.value)}
            placeholder="appId (e.g. shop-frontend)"
            className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm outline-none focus:border-sky-500"
          />
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Label (optional)"
            className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-sky-500"
          />
          <input
            value={newWebhook}
            onChange={(e) => setNewWebhook(e.target.value)}
            placeholder="Webhook URL (optional, https://)"
            className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-sky-500"
          />
        </div>
        <button onClick={() => void create()} disabled={busy} className="mt-3 w-fit rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50">
          Create app (server generates secrets)
        </button>
      </div>

      {showOnce !== null && (
        <div className="mt-3 space-y-2">
          <p className="text-xs font-medium text-amber-300">Store these now — they are return-once and cannot be read again.</p>
          <ShowOnceSecret label={`appSecret for ${showOnce.appId}`} value={showOnce.appSecret} />
          <ShowOnceSecret label={`webhookSecret for ${showOnce.appId}`} value={showOnce.webhookSecret} />
          <button onClick={() => setShowOnce(null)} className="text-xs text-slate-400 underline hover:text-slate-200">
            I have stored them — hide
          </button>
        </div>
      )}

      {error !== null && <p className="mt-3 rounded-lg border border-rose-900 bg-rose-950/50 px-3 py-2 text-sm text-rose-300">{error}</p>}
      {notice !== null && <p className="mt-3 rounded-lg border border-emerald-900 bg-emerald-950/50 px-3 py-2 text-sm text-emerald-300">{notice}</p>}

      {apps === null ? (
        <p className="mt-3 text-sm text-slate-500">Loading apps…</p>
      ) : apps.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">No apps registered.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {apps.map((a) => (
            <li key={a.id} className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-mono text-sm">
                    {a.appId}
                    {a.revokedAt !== null && (
                      <span className="ml-2 rounded bg-rose-950 px-2 py-0.5 text-xs text-rose-300">REVOKED</span>
                    )}
                  </p>
                  <p className="text-xs text-slate-500">
                    {a.name} · {a.webhookUrl ?? "no webhook"} · rate {a.rateMaxPerPhone}/{a.rateWindowSec}s · created {new Date(a.createdAt * 1000).toLocaleString()}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => void showStatus(a)} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-sky-500 hover:text-sky-300">
                    Status
                  </button>
                  <button onClick={() => void editWebhook(a)} disabled={busy} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-sky-500 hover:text-sky-300 disabled:opacity-50">
                    Webhook
                  </button>
                  <button onClick={() => void rotate(a)} disabled={busy} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-amber-500 hover:text-amber-300 disabled:opacity-50">
                    Rotate webhook secret
                  </button>
                  <button onClick={() => void toggleRevoke(a)} disabled={busy} className={`rounded-lg border px-3 py-1.5 text-xs disabled:opacity-50 ${a.revokedAt === null ? "border-rose-900 text-rose-300 hover:border-rose-500" : "border-emerald-800 text-emerald-300 hover:border-emerald-500"}`}>
                    {a.revokedAt === null ? "Revoke" : "Un-revoke"}
                  </button>
                </div>
              </div>
              {status !== null && status.appId === a.appId && (
                <p className="mt-3 rounded-lg bg-slate-950 px-3 py-2 text-xs text-slate-400">
                  credentials issued: yes · revoked: {String(status.revoked)} · webhook configured: {String(status.webhookConfigured)}
                  {status.webhookRotatedAt !== null && ` · webhook rotated ${new Date(status.webhookRotatedAt * 1000).toLocaleString()}`}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OversightSection(): JSX.Element {
  const [campaigns, setCampaigns] = useState<OversightCampaign[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | OversightCampaign["status"]>("all");

  useEffect(() => {
    listOversightCampaigns(filter === "all" ? undefined : filter)
      .then((res) => {
        setCampaigns(res.campaigns);
        setError(null);
      })
      .catch((err: unknown) => setError(describeError(err)));
  }, [filter]);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Campaign oversight</h3>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as typeof filter)}
          className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-300 outline-none focus:border-sky-500"
        >
          <option value="all">All statuses</option>
          <option value="queued">Queued</option>
          <option value="sending">Sending</option>
          <option value="paused">Paused</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>
      {error !== null && <p className="mt-2 rounded-lg border border-rose-900 bg-rose-950/50 px-3 py-2 text-sm text-rose-300">{error}</p>}
      {campaigns === null ? (
        <p className="mt-2 text-sm text-slate-500">Loading campaigns…</p>
      ) : campaigns.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">No campaigns match.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {campaigns.map((c) => (
            <li key={c.campaignId} className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">
                    {c.name} <span className="ml-2 font-mono text-xs text-slate-500">{c.appId}</span>
                  </p>
                  <p className="text-xs text-slate-500">
                    {c.sentCount}/{c.totalRecipients} sent · {c.failedCount} failed · {c.queuedCount} queued · created {new Date(c.createdAt * 1000).toLocaleString()}
                  </p>
                </div>
                <span className="rounded bg-slate-800 px-2 py-0.5 text-xs uppercase tracking-wide text-slate-300">{c.status}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
