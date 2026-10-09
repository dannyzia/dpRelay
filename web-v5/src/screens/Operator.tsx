/**
 * Operator panel (Stage F2, QUEUE AMENDMENT #2) — the `#/operator` subtree.
 *
 * Auth: OPERATOR_SECRET typed per session (sessionStorage, never bundled),
 * verified against GET /v5/admin/metrics BEFORE it is stored — mirroring the
 * customer login's probe-before-store rule. Only existing admin routes are
 * used: billing queue + approve (approve:false = reject), apps list +
 * revoke/unrevoke, metrics, campaigns.
 */
import { useCallback, useEffect, useState } from "react";
import {
  clearOperatorSecret,
  describeError,
  getAdminMetrics,
  getMailConfig,
  getOperatorSecret,
  listAdminApps,
  listOversightCampaigns,
  listPendingTransactions,
  request,
  revokeAdminApp,
  resolveTransaction,
  setOperatorRejectedHandler,
  setOperatorSecret,
  testMailConfig,
  unrevokeAdminApp,
  updateMailConfig,
  type AdminApp,
  type AdminMetrics,
  type MailConfigView,
  type OversightCampaign,
  type PendingTransaction,
} from "../api";
import { ErrorBanner } from "../components/ErrorBanner";
import { formatBdt, formatEpochUtc, formatStatus } from "../format";
import { hrefFor } from "../router";

type OperatorTab = "billing" | "apps" | "metrics" | "campaigns" | "mail";

const TABS: { id: OperatorTab; label: string }[] = [
  { id: "billing", label: "Billing queue" },
  { id: "apps", label: "Apps" },
  { id: "metrics", label: "Metrics" },
  { id: "campaigns", label: "Campaigns" },
  { id: "mail", label: "Mail Settings" },
];

/** Pure unlock form — exported for render tests. */
export function UnlockView(props: {
  error: string | null;
  busy: boolean;
  onSubmit: (secret: string) => void;
}): JSX.Element {
  return (
    <div className="card narrow">
      <h1>Operator unlock</h1>
      <p className="muted">
        Enter the operator secret for this session. It stays in this tab&apos;s storage only and
        is verified against the metrics endpoint before being kept.
      </p>
      <form
        onSubmit={(e): void => {
          e.preventDefault();
          const value = String(new FormData(e.currentTarget).get("operatorSecret") ?? "");
          if (value !== "") props.onSubmit(value);
        }}
      >
        <label htmlFor="operatorSecret">Operator secret</label>
        <input
          id="operatorSecret"
          name="operatorSecret"
          type="password"
          autoComplete="off"
          required
          spellCheck={false}
        />
        {props.error !== null && (
          <p className="error" role="alert">
            {props.error}
          </p>
        )}
        <button type="submit" disabled={props.busy}>
          {props.busy ? "Verifying…" : "Unlock"}
        </button>
      </form>
    </div>
  );
}

/** Pure billing-queue table — approve/reject per row. */
export function BillingQueueView(props: {
  pending: PendingTransaction[];
  onApprove: (tx: PendingTransaction) => void;
  onReject: (tx: PendingTransaction) => void;
}): JSX.Element {
  if (props.pending.length === 0) {
    return <p className="muted">Queue is empty — no TrxIDs awaiting approval.</p>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>Requested</th>
          <th>App</th>
          <th>Package</th>
          <th>Amount</th>
          <th>TrxID</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {props.pending.map((tx) => (
          <tr key={tx.transactionId}>
            <td>{formatEpochUtc(tx.requestedAt)}</td>
            <td className="mono">{tx.appId}</td>
            <td>
              {tx.packageCode} <span className="chip">{tx.packageType}</span>
            </td>
            <td className="num">{formatBdt(tx.amountBdt)}</td>
            <td className="mono">{tx.trxId ?? "—"}</td>
            <td>
              <div className="inline-actions">
                <button
                  type="button"
                  onClick={(): void => props.onApprove(tx)}
                  data-testid={`approve-${tx.transactionId}`}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={(): void => props.onReject(tx)}
                  data-testid={`reject-${tx.transactionId}`}
                >
                  Reject
                </button>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Pure apps registry table — revoke/unrevoke per row. */
export function AppsView(props: {
  apps: AdminApp[];
  onRevoke: (app: AdminApp) => void;
  onUnrevoke: (app: AdminApp) => void;
}): JSX.Element {
  if (props.apps.length === 0) {
    return <p className="muted">No apps registered.</p>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>App ID</th>
          <th>Name</th>
          <th>Created</th>
          <th>State</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {props.apps.map((app) => (
          <tr key={app.id}>
            <td className="mono">{app.appId}</td>
            <td>{app.name}</td>
            <td>{formatEpochUtc(app.createdAt)}</td>
            <td>
              <span className={app.revokedAt === null ? "chip approved" : "chip rejected"}>
                {app.revokedAt === null ? "Active" : "Revoked"}
              </span>
            </td>
            <td>
              {app.revokedAt === null ? (
                <button
                  type="button"
                  className="danger"
                  onClick={(): void => props.onRevoke(app)}
                  data-testid={`revoke-${app.id}`}
                >
                  Revoke
                </button>
              ) : (
                <button
                  type="button"
                  className="secondary"
                  onClick={(): void => props.onUnrevoke(app)}
                  data-testid={`unrevoke-${app.id}`}
                >
                  Unrevoke
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Pure metrics grid — exported for render tests. */
export function MetricsView({ metrics }: { metrics: AdminMetrics }): JSX.Element {
  const cards: { title: string; lines: string[] }[] = [
    {
      title: "Apps",
      lines: [`Total: ${metrics.apps.total}`, `Revoked: ${metrics.apps.revoked}`],
    },
    {
      title: "Users & devices",
      lines: [`Users: ${metrics.users.total}`, `Devices: ${metrics.users.devices}`],
    },
    {
      title: "OTP",
      lines: [
        `Sessions: ${metrics.otp.sessionsTotal}`,
        `Pending: ${metrics.otp.sessionsPending}`,
        `Verified: ${metrics.otp.sessionsVerified}`,
        `Last 24h: ${metrics.otp.sessionsLast24h}`,
      ],
    },
    {
      title: "Bulk",
      lines: [
        `Campaigns: ${metrics.bulk.campaignsTotal} (${metrics.bulk.campaignsActive} active)`,
        `Sent: ${metrics.bulk.recipientsSent}`,
        `Failed: ${metrics.bulk.recipientsFailed}`,
        `Queued: ${metrics.bulk.recipientsQueued}`,
      ],
    },
    {
      title: "Billing",
      lines: [
        `Pending: ${metrics.billing.transactionsPending}`,
        `Approved: ${metrics.billing.transactionsApproved}`,
        `Rejected: ${metrics.billing.transactionsRejected}`,
        `Credit rows: ${metrics.billing.creditsRows}`,
      ],
    },
    {
      title: "Webhooks (24h)",
      lines: [
        `Deliveries: ${metrics.webhooks.deliveriesLast24h}`,
        `Delivered: ${metrics.webhooks.deliveredLast24h}`,
        `Failed: ${metrics.webhooks.failedLast24h}`,
      ],
    },
  ];
  return (
    <div className="grid two">
      {cards.map((card) => (
        <section className="card" key={card.title}>
          <h2>{card.title}</h2>
          {card.lines.map((line) => (
            <p className="muted" key={line}>
              {line}
            </p>
          ))}
        </section>
      ))}
      <section className="card span2">
        <p className="muted">Generated: {formatEpochUtc(metrics.generatedAt)}</p>
      </section>
    </div>
  );
}

/** Pure cross-app campaigns table. */
export function CampaignsView({ campaigns }: { campaigns: OversightCampaign[] }): JSX.Element {
  if (campaigns.length === 0) {
    return <p className="muted">No campaigns.</p>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>Created</th>
          <th>App</th>
          <th>Name</th>
          <th>Status</th>
          <th>Recipients</th>
          <th>Sent</th>
          <th>Failed</th>
        </tr>
      </thead>
      <tbody>
        {campaigns.map((c) => (
          <tr key={c.campaignId}>
            <td>{formatEpochUtc(c.createdAt)}</td>
            <td className="mono">{c.appId}</td>
            <td>{c.name}</td>
            <td>
              <span className={`chip ${c.status}`}>{formatStatus(c.status)}</span>
            </td>
            <td className="num">{c.totalRecipients}</td>
            <td className="num">{c.sentCount}</td>
            <td className="num">{c.failedCount}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BillingQueue({ note }: { note: (msg: string | null) => void }): JSX.Element {
  const [pending, setPending] = useState<PendingTransaction[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const load = useCallback((): void => {
    setLoading(true);
    listPendingTransactions()
      .then((rows) => {
        setPending(rows);
        setError(null);
      })
      .catch((err: unknown) => setError(describeError(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const act = (tx: PendingTransaction, approve: boolean): void => {
    setError(null);
    let reason: string | undefined;
    if (!approve) {
      const input = window.prompt(`Reject reason for ${tx.transactionId}:`);
      if (input === null) return; // cancelled — leave the queue row untouched
      reason = input;
    }
    resolveTransaction(tx.transactionId, approve, reason)
      .then((res) => {
        note(
          `${tx.transactionId} ${res.status}` +
            (res.newOtpBalance !== undefined && res.newBulkBalance !== undefined
              ? ` — balances now OTP ${res.newOtpBalance} / bulk ${res.newBulkBalance}`
              : ""),
        );
        load();
      })
      .catch((err: unknown) => setError(describeError(err)));
  };

  return (
    <>
      <div className="page-head">
        <h1>Billing queue</h1>
        <button type="button" onClick={load} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {error !== null && <ErrorBanner message={error} />}
      <BillingQueueView pending={pending} onApprove={(tx) => act(tx, true)} onReject={(tx) => act(tx, false)} />
    </>
  );
}

function AppsPanel(): JSX.Element {
  const [apps, setApps] = useState<AdminApp[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback((): void => {
    listAdminApps()
      .then((page) => {
        setApps(page.apps);
        setError(null);
      })
      .catch((err: unknown) => setError(describeError(err)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const act = (app: AdminApp, revoke: boolean): void => {
    const verb = revoke ? "Revoke" : "Unrevoke";
    if (!window.confirm(`${verb} ${app.appId}?`)) return;
    setError(null);
    const call = revoke ? revokeAdminApp : unrevokeAdminApp;
    call(app.id)
      .then(() => {
        setNote(`${app.appId} ${verb.toLowerCase()}d`);
        load();
      })
      .catch((err: unknown) => setError(describeError(err)));
  };

  return (
    <>
      <div className="page-head">
        <h1>Apps</h1>
        <button type="button" onClick={load}>
          Refresh
        </button>
      </div>
      {error !== null && <ErrorBanner message={error} />}
      {note !== null && <p className="ok-note">{note}</p>}
      <AppsView apps={apps} onRevoke={(a) => act(a, true)} onUnrevoke={(a) => act(a, false)} />
    </>
  );
}

function MetricsPanel(): JSX.Element {
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAdminMetrics()
      .then((m) => {
        setMetrics(m);
        setError(null);
      })
      .catch((err: unknown) => setError(describeError(err)));
  }, []);

  return (
    <>
      <div className="page-head">
        <h1>Metrics</h1>
      </div>
      {error !== null && <ErrorBanner message={error} />}
      {metrics !== null && <MetricsView metrics={metrics} />}
    </>
  );
}

function CampaignsPanel(): JSX.Element {
  const [campaigns, setCampaigns] = useState<OversightCampaign[]>([]);
  const [status, setStatus] = useState<string>("all");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listOversightCampaigns(status)
      .then((page) => {
        setCampaigns(page.campaigns);
        setError(null);
      })
      .catch((err: unknown) => setError(describeError(err)));
  }, [status]);

  return (
    <>
      <div className="page-head">
        <h1>Campaigns</h1>
      </div>
      <div className="filterbar">
        <label htmlFor="campaignStatus" className="muted">
          Status
        </label>
        <select id="campaignStatus" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="all">All</option>
          <option value="queued">Queued</option>
          <option value="sending">Sending</option>
          <option value="paused">Paused</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>
      {error !== null && <ErrorBanner message={error} />}
      <CampaignsView campaigns={campaigns} />
    </>
  );
}

/**
 * STAGE F3 amendment (ISSUE-82): Mail Settings — the ONLY place SMTP details
 * exist (owner flag: never customer-facing). The password is write-only:
 * the form shows a mask after saving and never receives the stored value.
 * Pure view exported for render tests.
 */
export function MailSettingsView(props: {
  config: MailConfigView | null;
  error: string | null;
  note: string | null;
  busy: boolean;
  onSave: (cfg: { host: string; port: number; username: string; password: string; fromAddress: string }) => void;
  onTest: (to: string) => void;
}): JSX.Element {
  return (
    <>
      {props.error !== null && <ErrorBanner message={props.error} />}
      {props.note !== null && <p className="ok-note">{props.note}</p>}
      <section className="card">
        <h2>Outgoing email (SMTP)</h2>
        <p className="muted">
          {props.config?.configured === true
            ? `Configured${props.config.host !== null ? ` — ${props.config.host}:${String(props.config.port)}` : ""}. The password is stored encrypted and never shown again.`
            : "Not configured yet — customer verification and password-reset emails stay disabled until this is saved."}
        </p>
        <form
          onSubmit={(e): void => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            props.onSave({
              host: String(data.get("host") ?? "").trim(),
              port: Number(data.get("port") ?? 0),
              username: String(data.get("username") ?? "").trim(),
              password: String(data.get("password") ?? ""),
              fromAddress: String(data.get("fromAddress") ?? "").trim(),
            });
          }}
        >
          <label htmlFor="mailHost">SMTP host</label>
          <input id="mailHost" name="host" defaultValue={props.config?.host ?? ""} required spellCheck={false} />
          <label htmlFor="mailPort">Port</label>
          <input id="mailPort" name="port" type="number" min={1} max={65535} defaultValue={props.config?.port ?? 465} required />
          <label htmlFor="mailUsername">Username</label>
          <input id="mailUsername" name="username" required spellCheck={false} autoComplete="off" />
          <label htmlFor="mailPassword">
            Password {props.config?.passwordMasked !== null && props.config?.passwordMasked !== undefined ? `(${props.config.passwordMasked} — leave blank to keep)` : ""}
          </label>
          <input id="mailPassword" name="password" type="password" spellCheck={false} autoComplete="new-password" />
          <label htmlFor="mailFrom">From address</label>
          <input id="mailFrom" name="fromAddress" type="email" defaultValue={props.config?.fromAddress ?? ""} required spellCheck={false} />
          <button type="submit" disabled={props.busy}>
            {props.busy ? "Saving…" : "Save settings"}
          </button>
        </form>
        <form
          className="inline-actions"
          onSubmit={(e): void => {
            e.preventDefault();
            props.onTest(String(new FormData(e.currentTarget).get("to") ?? "").trim());
          }}
        >
          <label htmlFor="mailTestTo">Send a test email to</label>
          <input id="mailTestTo" name="to" type="email" required spellCheck={false} />
          <button type="submit" className="secondary" disabled={props.config?.configured !== true}>
            Send test
          </button>
        </form>
      </section>
    </>
  );
}

/** Container: load the masked config, save (password write-only), test-send. */
export function MailSettings(): JSX.Element {
  const [config, setConfig] = useState<MailConfigView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  useEffect(() => {
    getMailConfig()
      .then(setConfig)
      .catch((err: unknown) => setError(describeError(err)));
  }, []);

  const save = (cfg: { host: string; port: number; username: string; password: string; fromAddress: string }): void => {
    setBusy(true);
    setError(null);
    setNote(null);
    updateMailConfig(cfg)
      .then((next) => {
        setConfig(next);
        setBusy(false);
        setNote("Mail settings saved.");
      })
      .catch((err: unknown) => {
        setBusy(false);
        setError(describeError(err));
      });
  };

  const test = (to: string): void => {
    setError(null);
    setNote(null);
    testMailConfig(to)
      .then(() => setNote(`Test email sent to ${to}.`))
      .catch((err: unknown) => setError(describeError(err)));
  };

  return <MailSettingsView config={config} error={error} note={note} busy={busy} onSave={save} onTest={test} />;
}

/**
 * Operator shell: unlock gate → sub-tab content. `route` is the full hash
 * route so the active tab is URL-driven (`#/operator/billing`, deep-linkable).
 */
export function Operator({ route }: { route: string[] }): JSX.Element {
  const [unlocked, setUnlocked] = useState<boolean>(() => getOperatorSecret() !== null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    setOperatorRejectedHandler(() => {
      setUnlocked(false);
      setError("Operator secret rejected — unlock again.");
    });
    return () => setOperatorRejectedHandler(null);
  }, []);

  const unlock = (secret: string): void => {
    setBusy(true);
    setError(null);
    // Probe with a raw authorized request FIRST — the secret only enters
    // sessionStorage after /v5/admin/metrics accepts it (same rule as the
    // customer login, without the transient stash).
    request<AdminMetrics & { ok: true }>("/v5/admin/metrics", {
      headers: { Authorization: `Bearer ${secret}` },
    })
      .then(() => {
        setOperatorSecret(secret);
        setUnlocked(true);
        setBusy(false);
      })
      .catch((err: unknown) => {
        setBusy(false);
        setError(`Unlock rejected: ${describeError(err)}`);
      });
  };

  if (!unlocked) {
    return <UnlockView error={error} busy={busy} onSubmit={unlock} />;
  }

  const tabRaw = route[1] ?? "billing";
  const tab: OperatorTab = TABS.some((t) => t.id === tabRaw) ? (tabRaw as OperatorTab) : "billing";

  return (
    <>
      <div className="filterbar">
        <nav className="nav">
          {TABS.map((t) => (
            <a
              key={t.id}
              href={hrefFor(["operator", t.id])}
              className={tab === t.id ? "nav-link active" : "nav-link"}
            >
              {t.label}
            </a>
          ))}
        </nav>
        <button
          type="button"
          className="secondary"
          onClick={(): void => {
            clearOperatorSecret();
            setUnlocked(false);
            setNote(null);
          }}
        >
          Lock
        </button>
      </div>
      {note !== null && <p className="ok-note">{note}</p>}
      {tab === "apps" ? (
        <AppsPanel />
      ) : tab === "metrics" ? (
        <MetricsPanel />
      ) : tab === "campaigns" ? (
        <CampaignsPanel />
      ) : tab === "mail" ? (
        <MailSettings />
      ) : (
        <BillingQueue note={setNote} />
      )}
    </>
  );
}
