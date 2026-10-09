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
  approvePayment,
  attachPayment,
  bindAdminDevice,
  clearOperatorSecret,
  describeError,
  downloadOperatorCsv,
  getAdminConfig,
  getAdminMetrics,
  getLedgerReport,
  getMailConfig,
  getOperatorSecret,
  getPackageReport,
  getSendLog,
  listAdminApps,
  listAdminDevices,
  listAdminPackages,
  listAdminUsers,
  listOversightCampaigns,
  listPayments,
  listPendingTransactions,
  patchAdminPackage,
  putAdminConfig,
  rejectPayment,
  request,
  retireAdminPackage,
  revokeAdminApp,
  resolveTransaction,
  setAdminUserDisabled,
  setOperatorRejectedHandler,
  setOperatorSecret,
  testMailConfig,
  unrevokeAdminApp,
  updateMailConfig,
  upsertAdminPackage,
  type AdminApp,
  type AdminConfigKey,
  type AdminDeviceItem,
  type AdminDeviceList,
  type AdminMetrics,
  type AdminPackage,
  type AdminUserItem,
  type LedgerReport,
  type MailConfigView,
  type OversightCampaign,
  type PackageReport,
  type PaymentSmsItem,
  type PendingTransaction,
  type SendLogRow,
} from "../api";
import { ErrorBanner } from "../components/ErrorBanner";
import { formatBdt, formatEpochUtc, formatPrice, formatStatus } from "../format";
import { hrefFor } from "../router";

type OperatorTab =
  | "billing"
  | "apps"
  | "devices"
  | "metrics"
  | "campaigns"
  | "mail"
  | "payments"
  | "packages"
  | "users"
  | "reports"
  | "settings";

const TABS: { id: OperatorTab; label: string }[] = [
  { id: "billing", label: "Billing queue" },
  { id: "payments", label: "Payments" },
  { id: "packages", label: "Packages" },
  { id: "users", label: "Users" },
  { id: "reports", label: "Reports" },
  { id: "settings", label: "Settings" },
  { id: "apps", label: "Apps" },
  { id: "devices", label: "Devices" },
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
            </td>              <td className="num">{formatPrice(tx.amountBdt, tx.currency)}</td>
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
    let notes: string | undefined;
    if (!approve) {
      const input = window.prompt(`Reject reason for ${tx.transactionId}:`);
      if (input === null) return; // cancelled — leave the queue row untouched
      reason = input;
    } else {
      // ISSUE-89: approve optionally records the remittance-reference note
      // (the paper trail for manual USD/EUR approvals). Cancel aborts the
      // approval, mirroring the reject prompt; an empty note is no note.
      const input = window.prompt(
        `Approve note for ${tx.transactionId} (optional — e.g. remittance reference):`,
      );
      if (input === null) return; // cancelled — leave the queue row untouched
      notes = input.trim() === "" ? undefined : input.trim();
    }
    resolveTransaction(tx.transactionId, approve, reason, notes)
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

// ── STAGE F5 (ISSUE-83): admin operations panels ───────────────────────────

/**
 * Pure payments view: ingested payment SMS with match state, candidate
 * selection + one-click confirm, and the operator-tunable match parameters.
 * Ambiguity is rendered as an explicit unselected choice — the Confirm form
 * cannot submit a transaction the operator did not pick. Exported for tests.
 */
export function PaymentsView(props: {
  payments: PaymentSmsItem[];
  pending: PendingTransaction[];
  filters: { status: string; from: string; to: string };
  error: string | null;
  note: string | null;
  busy: boolean;
  onFilter: (status: string, from: string, to: string) => void;
  onApprove: (paymentId: string) => void;
  onReject: (paymentId: string) => void;
  onAttach: (paymentId: string, transactionId: string) => void;
}): JSX.Element {
  return (
    <>
      {props.error !== null && <ErrorBanner message={props.error} />}
      {props.note !== null && <p className="ok-note">{props.note}</p>}
      <section className="card">
        <h2>Ingested payment SMS</h2>
        <p className="muted">
          Auto-match proposes TrxID-equal or exact-amount±window rows; Approve always awards,
          Reject needs a stored reason. Match parameters live in Settings.
        </p>
        <form
          id="paymentsFilterForm"
          className="inline-actions"
          onSubmit={(e): void => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            props.onFilter(
              String(data.get("status") ?? "all"),
              String(data.get("from") ?? ""),
              String(data.get("to") ?? ""),
            );
          }}
        >
          <label htmlFor="payStatus">Status</label>
          <select id="payStatus" name="status" defaultValue={props.filters.status}>
            <option value="all">All</option>
            <option value="unmatched">Unmatched</option>
            <option value="matched">Matched (proposed)</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
          <label htmlFor="payFrom">Received from</label>
          <input id="payFrom" name="from" type="date" defaultValue={props.filters.from} />
          <label htmlFor="payTo">to</label>
          <input id="payTo" name="to" type="date" defaultValue={props.filters.to} />
          <button type="submit">Apply</button>
        </form>
        {props.payments.length === 0 ? (
          <p className="muted">No payment SMS ingested yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Received at</th>
                <th>Sender</th>
                <th>Source</th>
                <th>Amount</th>
                <th>TrxID</th>
                <th>Match status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {props.payments.map((p) => (
                <tr key={p.id}>
                  <td>{formatEpochUtc(p.receivedAt)}</td>
                  <td className="mono">{p.sender}</td>
                  <td className="mono">{p.source}</td>
                  <td className="num">{formatBdt(p.amountBdt)}</td>
                  <td className="mono">{p.txnId}</td>
                  <td>
                    <span
                      className={`chip ${p.status === "approved" ? "approved" : p.status === "rejected" ? "rejected" : ""}`}
                      title={p.reason ?? undefined}
                    >
                      {p.status === "matched" ? "Matched (proposed)" : p.status}
                    </span>
                    {p.reason !== null && <span className="muted"> — {p.reason}</span>}
                    {p.ambiguous && (
                      <span className="muted"> — {p.candidates.length} candidates, choose explicitly</span>
                    )}
                  </td>
                  <td>
                    {p.status === "approved" || p.status === "rejected" ? (
                      <span className="muted">—</span>
                    ) : (
                      <div className="inline-actions">
                        {p.status === "matched" && (
                          <button
                            type="button"
                            onClick={(): void => props.onApprove(p.id)}
                            disabled={props.busy}
                            data-testid={`pay-approve-${p.id}`}
                          >
                            Approve
                          </button>
                        )}
                        <button
                          type="button"
                          className="danger"
                          onClick={(): void => props.onReject(p.id)}
                          disabled={props.busy}
                          data-testid={`pay-reject-${p.id}`}
                        >
                          Reject
                        </button>
                        {p.status === "unmatched" && (
                          <AttachPicker
                            payment={p}
                            pending={props.pending}
                            busy={props.busy}
                            onAttach={props.onAttach}
                          />
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

/**
 * STAGE F5b (ISSUE-84 spec): "Attach to transaction…" picker for unmatched
 * rows — searches the pending queue by TrxID (typed) and, before any search,
 * offers the rows the auto-match rule already proposed. Confirm never fires
 * without an explicit selection (ambiguity never resolves itself).
 */
function AttachPicker(props: {
  payment: PaymentSmsItem;
  pending: PendingTransaction[];
  busy: boolean;
  onAttach: (paymentId: string, transactionId: string) => void;
}): JSX.Element {
  const [query, setQuery] = useState<string>("");
  const q = query.trim().toLowerCase();
  const matches: { transactionId: string; label: string }[] =
    q === ""
      ? props.payment.candidates.map((c) => ({
          transactionId: c.transactionId,
          label: `${c.packageCode} · ${formatBdt(c.amountBdt)} · ${c.appId}`,
        }))
      : props.pending
          .filter((t) => (t.trxId ?? "").toLowerCase().includes(q))
          .map((t) => ({
            transactionId: t.transactionId,
            label: `${t.packageCode} · ${formatBdt(t.amountBdt)} · ${t.appId} · ${t.trxId ?? "no TrxID yet"}`,
          }));
  return (
    <form
      className="inline-actions"
      onSubmit={(e): void => {
        e.preventDefault();
        const tx = String(new FormData(e.currentTarget).get("tx") ?? "");
        if (tx !== "") props.onAttach(props.payment.id, tx);
      }}
    >
      <input
        aria-label={`search-trx-${props.payment.txnId}`}
        placeholder="Attach: search TrxID"
        value={query}
        onChange={(e): void => setQuery(e.target.value)}
        spellCheck={false}
      />
      <select name="tx" aria-label={`candidate-${props.payment.txnId}`} defaultValue="">
        <option value="" disabled>
          {matches.length === 0 ? "No match — type a TrxID to search" : "Choose…"}
        </option>
        {matches.map((c) => (
          <option key={c.transactionId} value={c.transactionId}>
            {c.label}
          </option>
        ))}
      </select>
      <button type="submit" disabled={props.busy || matches.length === 0}>
        Confirm
      </button>
    </form>
  );
}

/**
 * Container: filtered payments + pending queue for the attach search;
 * one-click approve, reasoned reject (prompt), explicit attach.
 */
export function PaymentsPanel(): JSX.Element {
  const [payments, setPayments] = useState<PaymentSmsItem[]>([]);
  const [pending, setPending] = useState<PendingTransaction[]>([]);
  const [filters, setFilters] = useState<{ status: string; from: string; to: string }>({
    status: "all",
    from: "",
    to: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  /** Date input value (YYYY-MM-DD) → epoch seconds; empty → undefined. */
  const dayToEpoch = (value: string): number | undefined =>
    value === "" ? undefined : Math.floor(Date.parse(`${value}T00:00:00Z`) / 1000);

  const reload = useCallback((f: { status: string; from: string; to: string }): void => {
    listPayments({
      status:
        f.status === "all"
          ? undefined
          : (f.status as "unmatched" | "matched" | "approved" | "rejected"),
      from: dayToEpoch(f.from),
      to: dayToEpoch(f.to),
    })
      .then((res) => setPayments(res.payments))
      .catch((err: unknown) => setError(describeError(err)));
    // The attach search reads the pending queue (never status-filtered).
    listPendingTransactions()
      .then(setPending)
      .catch((err: unknown) => setError(describeError(err)));
  }, []);

  useEffect(() => {
    reload(filters);
  }, [reload, filters]);

  const applyFilter = (status: string, from: string, to: string): void => {
    setError(null);
    setFilters({ status, from, to });
  };

  const approve = (paymentId: string): void => {
    setBusy(true);
    setError(null);
    setNote(null);
    approvePayment(paymentId)
      .then((res) => {
        setBusy(false);
        setNote(`Approved — credits awarded (OTP balance now ${res.newOtpBalance}).`);
        reload(filters);
      })
      .catch((err: unknown) => {
        setBusy(false);
        setError(describeError(err));
      });
  };

  const reject = (paymentId: string): void => {
    const input = window.prompt("Reject reason (required):");
    if (input === null) return;
    if (input.trim() === "") {
      setError("A reject reason is required — rejected rows must say why.");
      return;
    }
    setBusy(true);
    setError(null);
    setNote(null);
    rejectPayment(paymentId, input.trim())
      .then(() => {
        setBusy(false);
        setNote(`Rejected: ${input.trim()}`);
        reload(filters);
      })
      .catch((err: unknown) => {
        setBusy(false);
        setError(describeError(err));
      });
  };

  const attach = (paymentId: string, transactionId: string): void => {
    if (transactionId === "") {
      setError("Choose which transaction this payment funds — ambiguity never resolves itself.");
      return;
    }
    setBusy(true);
    setError(null);
    setNote(null);
    attachPayment(paymentId, transactionId)
      .then((res) => {
        setBusy(false);
        setNote(`Attached — credits awarded (OTP balance now ${res.newOtpBalance}).`);
        reload(filters);
      })
      .catch((err: unknown) => {
        setBusy(false);
        setError(describeError(err));
      });
  };

  return (
    <PaymentsView
      payments={payments}
      pending={pending}
      filters={filters}
      error={error}
      note={note}
      busy={busy}
      onFilter={applyFilter}
      onApprove={approve}
      onReject={reject}
      onAttach={attach}
    />
  );
}

// ── STAGE F5b (ISSUE-84 spec): Settings — whitelisted admin_config keys ─────

const MATCH_WINDOW_KEY: AdminConfigKey = "payment_match_window_min";
const MATCH_TOLERANCE_KEY: AdminConfigKey = "payment_match_tolerance_bdt";

/**
 * Pure settings view: the ONLY editor for the whitelisted config keys
 * (the server 404s anything else). Exported for render tests.
 */
export function SettingsView(props: {
  values: { windowMin: number | null; toleranceBdt: number | null };
  error: string | null;
  note: string | null;
  busy: boolean;
  onSave: (windowMin: number, toleranceBdt: number) => void;
}): JSX.Element {
  return (
    <>
      {props.error !== null && <ErrorBanner message={props.error} />}
      {props.note !== null && <p className="ok-note">{props.note}</p>}
      <section className="card">
        <h2>Payment matching</h2>
        <p className="muted">
          Whitelisted keys ({MATCH_WINDOW_KEY}, {MATCH_TOLERANCE_KEY}) — the Payments proposal
          engine reads them live. Defaults: 30 minutes / 0 BDT (exact package price).
        </p>
        <form
          onSubmit={(e): void => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            props.onSave(Number(data.get("windowMin") ?? 0), Number(data.get("toleranceBdt") ?? 0));
          }}
        >
          <label htmlFor="setWindow">Match window (minutes, ±)</label>
          <input
            id="setWindow"
            name="windowMin"
            type="number"
            min={0}
            required
            defaultValue={props.values.windowMin ?? ""}
          />
          <label htmlFor="setTolerance">Amount tolerance (BDT)</label>
          <input
            id="setTolerance"
            name="toleranceBdt"
            type="number"
            min={0}
            required
            defaultValue={props.values.toleranceBdt ?? ""}
          />
          <button type="submit" disabled={props.busy || props.values.windowMin === null}>
            {props.busy ? "Saving…" : "Save settings"}
          </button>
        </form>
      </section>
    </>
  );
}

/** Container: load both whitelisted keys, save both. */
export function SettingsPanel(): JSX.Element {
  const [values, setValues] = useState<{ windowMin: number | null; toleranceBdt: number | null }>({
    windowMin: null,
    toleranceBdt: null,
  });
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  const load = useCallback((): void => {
    Promise.all([getAdminConfig(MATCH_WINDOW_KEY), getAdminConfig(MATCH_TOLERANCE_KEY)])
      .then(([win, tol]) => {
        setValues({ windowMin: win.value, toleranceBdt: tol.value });
        setError(null);
      })
      .catch((err: unknown) => setError(describeError(err)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = (windowMin: number, toleranceBdt: number): void => {
    setBusy(true);
    setError(null);
    setNote(null);
    Promise.all([
      putAdminConfig(MATCH_WINDOW_KEY, windowMin),
      putAdminConfig(MATCH_TOLERANCE_KEY, toleranceBdt),
    ])
      .then(([win, tol]) => {
        setValues({ windowMin: win.value, toleranceBdt: tol.value });
        setBusy(false);
        setNote("Settings saved — new candidate calculations use them immediately.");
      })
      .catch((err: unknown) => {
        setBusy(false);
        setError(describeError(err));
      });
  };

  return <SettingsView values={values} error={error} note={note} busy={busy} onSave={save} />;
}

/**
 * Pure packages view: full directory (retired rows visible + reactivate),
 * inline per-row edit form, retire button, and the create form. Every price
 * row carries its currency (ISSUE-89: BDT | USD | EUR — priceBdt is in that
 * unit, never implicitly taka). Exported for tests.
 */
export function PackagesView(props: {
  packages: AdminPackage[];
  error: string | null;
  note: string | null;
  busy: boolean;
  onCreate: (pkg: {
    packageCode: string;
    name: string;
    smsQuota: number;
    priceBdt: number;
    validityDays: number;
    type: string;
    currency: string;
  }) => void;
  onPatch: (
    packageCode: string,
    patch: {
      name: string;
      smsQuota: number;
      priceBdt: number;
      validityDays: number;
      type: string;
      currency: string;
    },
  ) => void;
  onToggleActive: (pkg: AdminPackage) => void;
}): JSX.Element {
  return (
    <>
      {props.error !== null && <ErrorBanner message={props.error} />}
      {props.note !== null && <p className="ok-note">{props.note}</p>}
      <section className="card">
        <h2>Create package</h2>
        <form
          onSubmit={(e): void => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            props.onCreate({
              packageCode: String(data.get("packageCode") ?? "").trim(),
              name: String(data.get("name") ?? "").trim(),
              smsQuota: Number(data.get("smsQuota") ?? 0),
              priceBdt: Number(data.get("priceBdt") ?? 0),
              validityDays: Number(data.get("validityDays") ?? 0),
              type: String(data.get("type") ?? "otp"),
              currency: String(data.get("currency") ?? "BDT"),
            });
            e.currentTarget.reset();
          }}
        >
          <label htmlFor="pkgCode">Package code</label>
          <input id="pkgCode" name="packageCode" required spellCheck={false} pattern="[A-Za-z0-9_\-]{2,64}" />
          <label htmlFor="pkgName">Name</label>
          <input id="pkgName" name="name" required maxLength={128} />
          <label htmlFor="pkgQuota">SMS quota</label>
          <input id="pkgQuota" name="smsQuota" type="number" min={1} required />
          <label htmlFor="pkgPrice">Price</label>
          <input id="pkgPrice" name="priceBdt" type="number" min={0} required />
          <label htmlFor="pkgCurrency">Currency</label>
          <select id="pkgCurrency" name="currency" defaultValue="BDT">
            <option value="BDT">BDT</option>
            <option value="USD">USD</option>
            <option value="EUR">EUR</option>
          </select>
          <label htmlFor="pkgValidity">Validity (days)</label>
          <input id="pkgValidity" name="validityDays" type="number" min={1} required />
          <label htmlFor="pkgType">Type</label>
          <select id="pkgType" name="type" defaultValue="otp">
            <option value="otp">otp</option>
            <option value="bulk">bulk</option>
            <option value="both">both</option>
          </select>
          <button type="submit" disabled={props.busy}>
            {props.busy ? "Saving…" : "Create package"}
          </button>
        </form>
      </section>
      <section className="card">
        <h2>Packages</h2>
        {props.packages.length === 0 ? (
          <p className="muted">No packages yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Quota</th>
                <th>Price</th>
                <th>Currency</th>
                <th>Days</th>
                <th>Type</th>
                <th>State</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {props.packages.map((p) => (
                <tr key={p.packageCode}>
                  <td colSpan={9}>
                    <form
                      className="inline-actions"
                      onSubmit={(e): void => {
                        e.preventDefault();
                        const data = new FormData(e.currentTarget);
                        props.onPatch(p.packageCode, {
                          name: String(data.get("name") ?? "").trim(),
                          smsQuota: Number(data.get("smsQuota") ?? 0),
                          priceBdt: Number(data.get("priceBdt") ?? 0),
                          validityDays: Number(data.get("validityDays") ?? 0),
                          type: String(data.get("type") ?? p.type),
                          currency: String(data.get("currency") ?? p.currency),
                        });
                      }}
                    >
                      <span className="mono">{p.packageCode}</span>
                      <input name="name" defaultValue={p.name} required maxLength={128} aria-label={`name-${p.packageCode}`} />
                      <input name="smsQuota" type="number" min={1} defaultValue={p.smsQuota} aria-label={`quota-${p.packageCode}`} />
                      <input name="priceBdt" type="number" min={0} defaultValue={p.priceBdt} aria-label={`price-${p.packageCode}`} />
                      <select name="currency" defaultValue={p.currency} aria-label={`currency-${p.packageCode}`}>
                        <option value="BDT">BDT</option>
                        <option value="USD">USD</option>
                        <option value="EUR">EUR</option>
                      </select>
                      <input name="validityDays" type="number" min={1} defaultValue={p.validityDays} aria-label={`days-${p.packageCode}`} />
                      <select name="type" defaultValue={p.type} aria-label={`type-${p.packageCode}`}>
                        <option value="otp">otp</option>
                        <option value="bulk">bulk</option>
                        <option value="both">both</option>
                      </select>
                      <span className={`chip ${p.isActive ? "approved" : "rejected"}`}>
                        {p.isActive ? "Active" : "Retired"}
                      </span>
                      <button type="submit" disabled={props.busy}>
                        Save
                      </button>
                      <button
                        type="button"
                        className={p.isActive ? "danger" : "secondary"}
                        onClick={(): void => props.onToggleActive(p)}
                        disabled={props.busy}
                      >
                        {p.isActive ? "Retire" : "Reactivate"}
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

/** Container: load the full directory; create (upsert), edit (PATCH), retire/reactivate. */
export function PackagesPanel(): JSX.Element {
  const [packages, setPackages] = useState<AdminPackage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  const reload = useCallback((): void => {
    listAdminPackages()
      .then(setPackages)
      .catch((err: unknown) => setError(describeError(err)));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const create = (pkg: {
    packageCode: string;
    name: string;
    smsQuota: number;
    priceBdt: number;
    validityDays: number;
    type: string;
    currency: string;
  }): void => {
    setBusy(true);
    setError(null);
    setNote(null);
    upsertAdminPackage(pkg)
      .then(() => {
        setBusy(false);
        setNote(`Package ${pkg.packageCode} saved.`);
        reload();
      })
      .catch((err: unknown) => {
        setBusy(false);
        setError(describeError(err));
      });
  };

  const patch = (
    packageCode: string,
    fields: {
      name: string;
      smsQuota: number;
      priceBdt: number;
      validityDays: number;
      type: string;
      currency: string;
    },
  ): void => {
    setBusy(true);
    setError(null);
    setNote(null);
    patchAdminPackage(packageCode, fields)
      .then(() => {
        setBusy(false);
        setNote(`Package ${packageCode} updated.`);
        reload();
      })
      .catch((err: unknown) => {
        setBusy(false);
        setError(describeError(err));
      });
  };

  const toggleActive = (pkg: AdminPackage): void => {
    setBusy(true);
    setError(null);
    setNote(null);
    // DELETE always retires (hard-delete is forbidden); reactivate is a PATCH.
    const action = pkg.isActive ? retireAdminPackage(pkg.packageCode) : patchAdminPackage(pkg.packageCode, { isActive: true });
    action
      .then(() => {
        setBusy(false);
        setNote(pkg.isActive ? `Package ${pkg.packageCode} retired (row kept for history).` : `Package ${pkg.packageCode} reactivated.`);
        reload();
      })
      .catch((err: unknown) => {
        setBusy(false);
        setError(describeError(err));
      });
  };

  return (
    <PackagesView
      packages={packages}
      error={error}
      note={note}
      busy={busy}
      onCreate={create}
      onPatch={patch}
      onToggleActive={toggleActive}
    />
  );
}

/** Pure users (withhold) view — exported for render tests. */
export function UsersView(props: {
  users: AdminUserItem[];
  error: string | null;
  note: string | null;
  busy: boolean;
  onToggle: (user: AdminUserItem) => void;
}): JSX.Element {
  return (
    <>
      {props.error !== null && <ErrorBanner message={props.error} />}
      {props.note !== null && <p className="ok-note">{props.note}</p>}
      <section className="card">
        <h2>Customers</h2>
        <p className="muted">
          Withholding blocks the customer&apos;s login and freezes their apps' sends
          (<code>account_withheld</code>). Credits are never touched.
        </p>
        {props.users.length === 0 ? (
          <p className="muted">No users yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>State</th>
                <th>Owned apps</th>
                <th>Created</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {props.users.map((u) => (
                <tr key={u.id}>
                  <td>{u.email}</td>
                  <td>
                    <span
                      className={`chip ${u.disabled ? "rejected" : "approved"}`}
                      title={u.disabledReason ?? undefined}
                    >
                      {u.disabled ? "Withheld" : "Active"}
                    </span>
                    {u.disabled && u.disabledReason !== null && (
                      <span className="muted"> — {u.disabledReason}</span>
                    )}
                  </td>
                  <td>
                    {u.apps.length === 0 ? (
                      <span className="muted">None</span>
                    ) : (
                      u.apps.map((a) => (
                        <span key={a.id} className="muted">
                          {a.name} {a.revoked ? "(revoked)" : ""} ·{" "}
                        </span>
                      ))
                    )}
                  </td>
                  <td>{formatEpochUtc(u.createdAt)}</td>
                  <td>
                    <button
                      type="button"
                      className={u.disabled ? "secondary" : "danger"}
                      onClick={(): void => props.onToggle(u)}
                      disabled={props.busy}
                    >
                      {u.disabled ? "Enable" : "Withhold"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

/** Container: user directory + withhold toggles. */
export function UsersPanel(): JSX.Element {
  const [users, setUsers] = useState<AdminUserItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  const reload = useCallback((): void => {
    listAdminUsers()
      .then(setUsers)
      .catch((err: unknown) => setError(describeError(err)));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const toggle = (user: AdminUserItem): void => {
    setError(null);
    setNote(null);
    let reason: string | undefined;
    if (!user.disabled) {
      // Spec: withhold needs a stored reason AND an explicit confirm dialog.
      const input = window.prompt(`Withhold reason for ${user.email} (required):`);
      if (input === null) return;
      if (input.trim() === "") {
        setError("A withhold reason is required.");
        return;
      }
      if (!window.confirm(`Withhold ${user.email}?\nReason: ${input.trim()}`)) return;
      reason = input.trim();
    } else if (!window.confirm(`Enable ${user.email}?`)) {
      return;
    }
    setBusy(true);
    setAdminUserDisabled(user.id, !user.disabled, reason)
      .then(() => {
        setBusy(false);
        setNote(user.disabled ? `${user.email} enabled.` : `${user.email} withheld.`);
        reload();
      })
      .catch((err: unknown) => {
        setBusy(false);
        setError(describeError(err));
      });
  };

  return <UsersView users={users} error={error} note={note} busy={busy} onToggle={toggle} />;
}

/**
 * STAGE F7 (ISSUE-87): pure devices table — identity columns the order pins:
 * `number | bound-app | last-seen`, plus the bind control (a bound device only
 * ever fetches its own app's messages; the fallback fleet is everything else).
 */
export function DevicesView(props: {
  list: AdminDeviceList | null;
  apps: AdminApp[];
  error: string | null;
  note: string | null;
  busy: boolean;
  onBind: (device: AdminDeviceItem, appId: string | null) => void;
}): JSX.Element {
  const devices = props.list?.devices ?? [];
  return (
    <>
      {props.error !== null && <ErrorBanner message={props.error} />}
      {props.note !== null && <p className="ok-note">{props.note}</p>}
      <section className="card">
        <h2>Gateway devices</h2>
        <p className="muted">
          A device bound to an app receives only that app&apos;s pending messages. Unbound devices
          form the operator fleet and receive messages for apps with no bound device. Every
          device&apos;s phone number is shown once it reports one.
        </p>
        {props.list !== null && (
          <p className="muted">
            {props.list.total} devices · {props.list.staleCount} stale ·{" "}
            {props.list.neverSeenCount} never seen · {props.list.quarantinedCount} quarantined
          </p>
        )}
        {devices.length === 0 ? (
          <p className="muted">No devices enrolled yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Number</th>
                <th>Bound app</th>
                <th>Last seen</th>
                <th>Label</th>
                <th>State</th>
                <th>Binding</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id}>
                  <td className="mono">{d.phoneNumber ?? "—"}</td>
                  <td>
                    {d.boundAppId === null ? (
                      <span className="muted">fleet (unbound)</span>
                    ) : (
                      <span className="chip approved" title={d.boundAppName ?? undefined}>
                        {d.boundAppId}
                      </span>
                    )}
                  </td>
                  <td>{d.lastSeenAt === null ? "never" : formatEpochUtc(d.lastSeenAt)}</td>
                  <td>{d.label}</td>
                  <td>
                    {d.revokedAt !== null ? (
                      <span className="chip rejected">revoked</span>
                    ) : d.stale ? (
                      <span className="chip rejected" title={`${d.secondsSinceSeen}s since last heartbeat`}>
                        stale
                      </span>
                    ) : d.quarantined ? (
                      <span className="chip" title="Quarantined — still able to heartbeat">
                        quarantined
                      </span>
                    ) : (
                      <span className="chip approved">online</span>
                    )}
                  </td>
                  <td>
                    <label className="sr-only" htmlFor={`bind-${d.id}`}>
                      Bind device {d.label} to an app
                    </label>
                    <select
                      id={`bind-${d.id}`}
                      value={d.boundAppId ?? ""}
                      disabled={props.busy || d.revokedAt !== null}
                      onChange={(e): void => props.onBind(d, e.target.value === "" ? null : e.target.value)}
                    >
                      <option value="">— fleet (unbound) —</option>
                      {props.apps.map((a) => (
                        <option key={a.id} value={a.appId}>
                          {a.appId} ({a.name})
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

/** Container: fleet listing + bind/unbind actions. */
export function DevicesPanel(): JSX.Element {
  const [list, setList] = useState<AdminDeviceList | null>(null);
  const [apps, setApps] = useState<AdminApp[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  const reload = useCallback((): void => {
    listAdminDevices()
      .then(setList)
      .catch((err: unknown) => setError(describeError(err)));
    listAdminApps()
      .then((res) => setApps(res.apps))
      .catch((err: unknown) => setError(describeError(err)));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const bind = (device: AdminDeviceItem, appId: string | null): void => {
    const target = appId === null ? "the operator fleet (unbound)" : `app ${appId}`;
    if (!window.confirm(`Bind device "${device.label}" (${device.phoneNumber ?? "number unknown"}) to ${target}?`)) {
      return;
    }
    setBusy(true);
    setError(null);
    setNote(null);
    bindAdminDevice(device.id, appId)
      .then(() => {
        setBusy(false);
        setNote(`Device "${device.label}" → ${target}.`);
        reload();
      })
      .catch((err: unknown) => {
        setBusy(false);
        setError(describeError(err));
      });
  };

  return <DevicesView list={list} apps={apps} error={error} note={note} busy={busy} onBind={bind} />;
}

/**
 * Pure reports view: spec columns, app+date filters, cursor Load-more,
 * CSV-only export, plus the ISSUE-89 package-aggregate report (currency-
 * dimensioned — totals roll up per currency, never across).
 */
export function ReportsView(props: {
  ledger: LedgerReport | null;
  pkgReport: PackageReport | null;
  sendRows: SendLogRow[] | null;
  sendNextCursor: string | null;
  error: string | null;
  onLedgerLoad: (from: string, to: string, appId: string) => void;
  onLedgerMore: () => void;
  onPkgLoad: (from: string, to: string) => void;
  onSendLoad: (from: string, to: string, appId: string) => void;
  onSendMore: () => void;
  onLedgerCsv: (from: string, to: string, appId: string) => void;
  onSendCsv: (from: string, to: string, appId: string) => void;
}): JSX.Element {
  return (
    <>
      {props.error !== null && <ErrorBanner message={props.error} />}
      <section className="card">
        <h2>Per-customer ledger</h2>
        <form
          id="ledgerForm"
          className="inline-actions"
          onSubmit={(e): void => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            props.onLedgerLoad(
              String(data.get("from") ?? ""),
              String(data.get("to") ?? ""),
              String(data.get("appId") ?? "").trim(),
            );
          }}
        >
          <label htmlFor="ledgerFrom">From</label>
          <input id="ledgerFrom" name="from" type="date" />
          <label htmlFor="ledgerTo">To</label>
          <input id="ledgerTo" name="to" type="date" />
          <label htmlFor="ledgerApp">App ID</label>
          <input id="ledgerApp" name="appId" spellCheck={false} />
          <button type="submit">Load ledger</button>
          <button
            type="button"
            className="secondary"
            onClick={(): void => {
              const form = document.getElementById("ledgerForm") as HTMLFormElement | null;
              const data = form !== null ? new FormData(form) : null;
              props.onLedgerCsv(
                String(data?.get("from") ?? ""),
                String(data?.get("to") ?? ""),
                String(data?.get("appId") ?? "").trim(),
              );
            }}
          >
            Download CSV
          </button>
        </form>
        {props.ledger !== null && (
          <>
            <p className="muted">
              {props.ledger.rows.length} row(s) — {props.ledger.totals
                .map((t) => `${t.packageType}/${t.status} ${t.currency}: ${t.count} (${formatPrice(t.amountBdt, t.currency)}, ${String(t.grantedSms)} SMS granted)`)
                .join(" · ")}
            </p>
            <table>
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>App</th>
                  <th>Kind</th>
                  <th>Package</th>
                  <th>Qty</th>
                  <th>Amount</th>
                  <th>TrxID</th>
                </tr>
              </thead>
              <tbody>
                {props.ledger.rows.map((r) => (
                  <tr key={r.id}>
                    <td>{formatEpochUtc(r.timestamp)}</td>
                    <td
                      className="mono"
                      title={`${r.appId}${r.ownerEmail !== null ? ` · ${r.ownerEmail}` : ""}`}
                    >
                      {r.appName ?? r.appId}
                    </td>
                    <td>
                      <span className="chip">{r.kind}</span>
                    </td>
                    <td>{r.packageCode === "" ? "—" : r.packageCode}</td>
                    <td className="num">{r.qty}</td>
                    <td className="num">{formatPrice(r.amountBdt, r.currency)}</td>
                    <td className="mono">{r.trxId ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {props.ledger.nextCursor !== null && (
              <button type="button" className="secondary" onClick={props.onLedgerMore}>
                Load more
              </button>
            )}
          </>
        )}
      </section>
      <section className="card">
        <h2>Package sales (aggregated)</h2>
        <p className="muted">
          Approved purchases per package — totals roll up per currency and are never summed
          across currencies.
        </p>
        <form
          id="pkgReportForm"
          className="inline-actions"
          onSubmit={(e): void => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            props.onPkgLoad(String(data.get("from") ?? ""), String(data.get("to") ?? ""));
          }}
        >
          <label htmlFor="pkgRFrom">From</label>
          <input id="pkgRFrom" name="from" type="date" />
          <label htmlFor="pkgRTo">To</label>
          <input id="pkgRTo" name="to" type="date" />
          <button type="submit">Load package report</button>
        </form>
        {props.pkgReport !== null && (
          <>
            <p className="muted">
              {props.pkgReport.rows.length} package(s) —{" "}
              {props.pkgReport.totalsByCurrency
                .map((t) => `${t.currency}: ${t.countSold} sold · ${formatPrice(t.totalAmount, t.currency)}`)
                .join(" · ")}
            </p>
            {props.pkgReport.rows.length === 0 ? (
              <p className="muted">No approved sales in this window.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Package</th>
                    <th>Name</th>
                    <th>Currency</th>
                    <th>Sold</th>
                    <th>Total</th>
                    <th>SMS sold</th>
                    <th>First sale</th>
                    <th>Last sale</th>
                  </tr>
                </thead>
                <tbody>
                  {props.pkgReport.rows.map((r) => (
                    <tr key={`${r.packageCode}:${r.currency}`}>
                      <td className="mono">{r.packageCode}</td>
                      <td>{r.name}</td>
                      <td>{r.currency}</td>
                      <td className="num">{r.countSold}</td>
                      <td className="num">{formatPrice(r.totalAmount, r.currency)}</td>
                      <td className="num">{r.smsSold}</td>
                      <td>{formatEpochUtc(r.firstSoldAt)}</td>
                      <td>{formatEpochUtc(r.lastSoldAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </section>
      <section className="card">
        <h2>Item-wise send log</h2>
        <p className="muted">Recipient numbers are PII — operator-only, CSV is the only export.</p>
        <form
          id="sendLogForm"
          className="inline-actions"
          onSubmit={(e): void => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            props.onSendLoad(
              String(data.get("from") ?? ""),
              String(data.get("to") ?? ""),
              String(data.get("appId") ?? "").trim(),
            );
          }}
        >
          <label htmlFor="sendFrom">From</label>
          <input id="sendFrom" name="from" type="date" />
          <label htmlFor="sendTo">To</label>
          <input id="sendTo" name="to" type="date" />
          <label htmlFor="sendApp">App ID</label>
          <input id="sendApp" name="appId" spellCheck={false} />
          <button type="submit">Load send log</button>
          <button
            type="button"
            className="secondary"
            onClick={(): void => {
              const form = document.getElementById("sendLogForm") as HTMLFormElement | null;
              const data = form !== null ? new FormData(form) : null;
              props.onSendCsv(
                String(data?.get("from") ?? ""),
                String(data?.get("to") ?? ""),
                String(data?.get("appId") ?? "").trim(),
              );
            }}
          >
            Download CSV
          </button>
        </form>
        {props.sendRows !== null && (
          <table>
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>App</th>
                <th>Kind</th>
                <th>Recipient</th>
                <th>Ref</th>
                <th>Status</th>
                <th>Campaign</th>
              </tr>
            </thead>
            <tbody>
              {props.sendRows.map((r) => (
                <tr key={r.messageId}>
                  <td>{formatEpochUtc(r.timestamp)}</td>
                  <td className="mono">{r.appName ?? r.appId ?? "—"}</td>
                  <td>
                    <span className="chip">{r.kind}</span>
                  </td>
                  <td className="mono">{r.recipient}</td>
                  <td className="mono">{r.ref ?? "—"}</td>
                  <td>
                    <span
                      className={`chip ${r.status === "sent" || r.status === "verified" ? "approved" : r.status === "failed" ? "rejected" : ""}`}
                      title={r.error ?? undefined}
                    >
                      {formatStatus(r.status)}
                    </span>
                  </td>
                  <td>{r.campaignName ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {props.sendRows !== null && props.sendNextCursor !== null && (
          <button type="button" className="secondary" onClick={props.onSendMore}>
            Load more
          </button>
        )}
      </section>
    </>
  );
}

/** Container: filtered + cursor-paged ledger/send log and CSV-only downloads. */
export function ReportsPanel(): JSX.Element {
  const [ledger, setLedger] = useState<LedgerReport | null>(null);
  const [pkgReport, setPkgReport] = useState<PackageReport | null>(null);
  const [sendRows, setSendRows] = useState<SendLogRow[] | null>(null);
  const [sendNextCursor, setSendNextCursor] = useState<string | null>(null);
  const [ledgerFilters, setLedgerFilters] = useState<{ appId: string; from?: number; to?: number }>({
    appId: "",
  });
  const [sendFilters, setSendFilters] = useState<{ appId: string; from?: number; to?: number }>({
    appId: "",
  });
  const [error, setError] = useState<string | null>(null);

  /** Date input value (YYYY-MM-DD) → epoch seconds; empty/invalid → undefined. */
  const dayToEpoch = (value: string): number | undefined =>
    value === "" ? undefined : Math.floor(Date.parse(`${value}T00:00:00Z`) / 1000);

  const loadLedger = (from: string, to: string, appId: string): void => {
    const f = { appId, from: dayToEpoch(from), to: dayToEpoch(to) };
    setLedgerFilters(f);
    setError(null);
    getLedgerReport(f)
      .then(setLedger)
      .catch((err: unknown) => setError(describeError(err)));
  };

  /** Cursor page: append to what is already on screen (same filters). */
  const moreLedger = (): void => {
    if (ledger === null || ledger.nextCursor === null) return;
    setError(null);
    getLedgerReport({ ...ledgerFilters, cursor: ledger.nextCursor })
      .then((next) => setLedger({ ...next, rows: [...ledger.rows, ...next.rows] }))
      .catch((err: unknown) => setError(describeError(err)));
  };

  /** ISSUE-89 package report: same date-widget → epoch conversion; empty dates → server default window. */
  const loadPkgReport = (from: string, to: string): void => {
    setError(null);
    getPackageReport({ from: dayToEpoch(from), to: dayToEpoch(to) })
      .then(setPkgReport)
      .catch((err: unknown) => setError(describeError(err)));
  };

  const loadSend = (from: string, to: string, appId: string): void => {
    const f = { appId, from: dayToEpoch(from), to: dayToEpoch(to) };
    setSendFilters(f);
    setError(null);
    getSendLog(f)
      .then((res) => {
        setSendRows(res.rows);
        setSendNextCursor(res.nextCursor);
      })
      .catch((err: unknown) => setError(describeError(err)));
  };

  const moreSend = (): void => {
    if (sendNextCursor === null) return;
    setError(null);
    getSendLog({ ...sendFilters, cursor: sendNextCursor })
      .then((res) => {
        setSendRows([...(sendRows ?? []), ...res.rows]);
        setSendNextCursor(res.nextCursor);
      })
      .catch((err: unknown) => setError(describeError(err)));
  };

  const ledgerCsv = (from: string, to: string, appId: string): void => {
    setError(null);
    const fromE = dayToEpoch(from);
    const toE = dayToEpoch(to);
    const qs = new URLSearchParams({ format: "csv" });
    if (fromE !== undefined) qs.set("from", String(fromE));
    if (toE !== undefined) qs.set("to", String(toE));
    if (appId !== "") qs.set("appId", appId);
    downloadOperatorCsv(`/v5/admin/reports/ledger?${qs.toString()}`, "ledger.csv").catch((err: unknown) =>
      setError(describeError(err)),
    );
  };

  const sendCsv = (from: string, to: string, appId: string): void => {
    setError(null);
    const fromE = dayToEpoch(from);
    const toE = dayToEpoch(to);
    const qs = new URLSearchParams({ format: "csv" });
    if (fromE !== undefined) qs.set("from", String(fromE));
    if (toE !== undefined) qs.set("to", String(toE));
    if (appId !== "") qs.set("appId", appId);
    downloadOperatorCsv(`/v5/admin/reports/sends?${qs.toString()}`, "send-log.csv").catch((err: unknown) =>
      setError(describeError(err)),
    );
  };

  return (
    <ReportsView
      ledger={ledger}
      pkgReport={pkgReport}
      sendRows={sendRows}
      sendNextCursor={sendNextCursor}
      error={error}
      onLedgerLoad={loadLedger}
      onLedgerMore={moreLedger}
      onPkgLoad={loadPkgReport}
      onSendLoad={loadSend}
      onSendMore={moreSend}
      onLedgerCsv={ledgerCsv}
      onSendCsv={sendCsv}
    />
  );
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
      ) : tab === "devices" ? (
        <DevicesPanel />
      ) : tab === "metrics" ? (
        <MetricsPanel />
      ) : tab === "campaigns" ? (
        <CampaignsPanel />
      ) : tab === "mail" ? (
        <MailSettings />
      ) : tab === "payments" ? (
        <PaymentsPanel />
      ) : tab === "packages" ? (
        <PackagesPanel />
      ) : tab === "users" ? (
        <UsersPanel />
      ) : tab === "reports" ? (
        <ReportsPanel />
      ) : tab === "settings" ? (
        <SettingsPanel />
      ) : (
        <BillingQueue note={setNote} />
      )}
    </>
  );
}
