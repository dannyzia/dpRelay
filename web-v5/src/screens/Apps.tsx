import { useEffect, useState } from "react";
import {
  connectApp,
  createCompany,
  describeError,
  disableCompany,
  getConnectedApp,
  getMailStatus,
  getWallet,
  getWalletTransactions,
  listCompanies,
  listOwnedApps,
  renameCompany,
  resendVerification,
  rotateCompanyDeviceSecret,
  type Company,
  type CompanyCreated,
  type OwnedApp,
  type Wallet,
  type WalletTransaction,
} from "../api";
import { formatPrice } from "../lib/format";
import { hrefFor } from "../lib/router";
import { DevicePairingView } from "./DevicePairing";

/** Epoch-seconds → a short UTC date for the wallet panels. */
function shortDate(epochSec: number | null): string {
  if (epochSec === null) return "—";
  return new Date(epochSec * 1000).toISOString().slice(0, 10);
}

/**
 * STAGE F9 (ISSUE-88): the wallet header — one balance shared by every
 * company the user owns. Pure view, exported for render tests.
 */
export function WalletHeader(props: {
  wallet: Wallet | null;
  history: WalletTransaction[] | null;
  showHistory: boolean;
  onToggleHistory: () => void;
}): JSX.Element {
  return (
    <div className="card" data-testid="wallet-header">
      <h1>Your wallet</h1>
      <p className="muted">
        Every company you own sends from this one balance.{" "}
        <a href="#/buy">Buy credits</a> tops it up.
      </p>
      {props.wallet === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <p data-testid="wallet-balances">
          <strong>{props.wallet.otpSmsRemaining}</strong> OTP SMS ·{" "}
          <strong>{props.wallet.bulkSmsRemaining}</strong> bulk SMS
          {props.wallet.otpExpiresAt !== null && (
            <span className="muted"> · OTP credits expire {shortDate(props.wallet.otpExpiresAt)}</span>
          )}
          {props.wallet.bulkExpiresAt !== null && (
            <span className="muted"> · bulk credits expire {shortDate(props.wallet.bulkExpiresAt)}</span>
          )}
        </p>
      )}
      <button type="button" className="button-link" onClick={props.onToggleHistory}>
        {props.showHistory ? "Hide purchase history" : "Show purchase history"}
      </button>
      {props.showHistory && (
        <div data-testid="wallet-history">
          {props.history === null && <p className="muted">Loading…</p>}
          {props.history !== null && props.history.length === 0 && (
            <p className="muted">No wallet purchases yet.</p>
          )}
          {props.history !== null && props.history.length > 0 && (
            <ul className="app-list">
              {props.history.map((t) => (
                <li key={t.transactionId} className="app-row">
                  <span className="app-name">
                    {t.packageCode} <span className="chip">{t.status}</span>
                  </span>
                  <span>
                    {t.smsQuota} SMS · {formatPrice(t.amountBdt, t.currency)} · {shortDate(t.requestedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * STAGE F9 (ISSUE-88): the post-login hub — wallet header, company cards
 * (each company is 1:1 with one app + its F7 gateway number), the
 * create-company flow, and the legacy "link existing app" entry. Selecting a
 * company keys the customer screens to its app credentials; secrets are shown
 * exactly once at creation and never re-served (link re-proves them).
 * Pure view, exported for render tests.
 */
export function AppsView(props: {
  companies: Company[] | null;
  wallet: Wallet | null;
  walletHistory: WalletTransaction[] | null;
  showHistory: boolean;
  /** Owned apps WITHOUT a company (operator-issued, claimed via link). */
  linkedApps: OwnedApp[] | null;
  emailVerified: boolean;
  error: string | null;
  busy: boolean;
  /** Set while freshly minted company+app secrets are on screen — shown exactly once. */
  freshSecret: {
    companyId: string;
    appId: string;
    appSecret: string;
    deviceEnrollmentSecret: string;
    trialSms: number;
  } | null;
  /** Soft-verification banner (F3 amendment): shown when unverified AND mail is configured. */
  verifyBanner: "hidden" | "offer" | "sent";
  /**
   * ISSUE-119: hard creation gate — true when mail is configured AND the
   * account is unverified (holds even after a resend, while the banner flips
   * to "sent"). Optional so existing render tests keep compiling.
   */
  creationBlocked?: boolean;
  /** ISSUE-112: id of the company whose pairing panel is open (null/omitted = collapsed). */
  pairingCompanyId?: string | null;
  /** ISSUE-112: toggles the "Link your Android device" panel for one company. */
  onTogglePairing?: (companyId: string) => void;
  /** ISSUE-113: freshly minted enrollment secrets per company (shown once, this session). */
  rotatedSecrets?: Record<string, string>;
  /** ISSUE-113: id of the company whose rotation is in flight (drives the busy label). */
  rotatingCompanyId?: string | null;
  /** ISSUE-113: last rotation failure, surfaced as an alert in the pairing panel. */
  rotateError?: string | null;
  /** ISSUE-113: mints a new enrollment secret for one company (self-serve re-pairing). */
  onRotateSecret?: (companyId: string) => void;
  onResend: () => void;
  onOpen: (appId: string) => void;
  onCreate: (name: string) => void;
  onRename: (companyId: string, name: string) => void;
  onDisable: (companyId: string) => void;
  onAcknowledgeSecret: () => void;
  onLinkExisting: () => void;
  onToggleHistory: () => void;
}): JSX.Element {
  const storedCreds = getConnectedApp();
  const pairingCompanyId = props.pairingCompanyId ?? null;
  const pairingCompany =
    pairingCompanyId === null
      ? null
      : (props.companies ?? []).find((company) => company.id === pairingCompanyId) ?? null;
  // The freshly created company's enrollment secret is the only one this
  // session can show UNTIL ISSUE-113: a self-serve rotation mints a new one
  // on demand (and invalidates the previous pairing payload). The server
  // stores every other secret hashed — it is never re-served.
  const rotatedSecret = pairingCompany === null ? undefined : (props.rotatedSecrets ?? {})[pairingCompany.id];
  const pairingSecret =
    rotatedSecret ??
    (pairingCompany !== null &&
    props.freshSecret !== null &&
    props.freshSecret.companyId === pairingCompany.id
      ? props.freshSecret.deviceEnrollmentSecret
      : "");
  return (
    <>
      <WalletHeader
        wallet={props.wallet}
        history={props.walletHistory}
        showHistory={props.showHistory}
        onToggleHistory={props.onToggleHistory}
      />
      <div className="card">
        <h1>Your companies</h1>
        {props.verifyBanner === "offer" && (
          <div className="callout" data-testid="verify-banner">
            <p>
              Confirm your email so the operator can reach you about credits and incidents.
            </p>
            <button type="button" onClick={props.onResend}>
              Send verification email
            </button>
          </div>
        )}
        {props.verifyBanner === "sent" && (
          <p className="ok-note" data-testid="verify-sent">
            Verification email sent — check your inbox (and spam folder).
          </p>
        )}
        {props.companies === null && props.error === null && <p className="muted">Loading…</p>}
        {props.error !== null && (
          <p className="error" role="alert">
            {props.error}
          </p>
        )}
        {props.companies !== null && props.companies.length === 0 && (
          <p className="muted">
            No companies yet — create one below, or link an app your operator issued.
          </p>
        )}
        {props.companies !== null && props.companies.length > 0 && (
          <ul className="app-list" data-testid="company-list">
            {props.companies.map((company) => (
              <li key={company.id} className="app-row">
                <span className="app-name">
                  {company.name}
                  {company.disabled && <span className="badge">disabled</span>}
                  {company.app.revoked && <span className="badge">revoked</span>}
                  {!company.disabled && !company.app.revoked && (
                    <span className="chip" data-testid="verify-status">
                      {props.emailVerified ? "email verified" : "email unverified"}
                    </span>
                  )}
                </span>
                <code>{company.app.appId}</code>
                <span className="muted" data-testid="gateway-number">
                  {company.gatewayNumber ?? "no gateway bound"}
                </span>
                <span className="inline-actions">
                  {company.disabled || company.app.revoked ? (
                    <span className="muted">Not sending</span>
                  ) : storedCreds?.appId === company.app.appId ? (
                    <button type="button" onClick={(): void => props.onOpen(company.app.appId)}>
                      Open dashboard
                    </button>
                  ) : (
                    <button type="button" onClick={(): void => props.onOpen(company.app.appId)}>
                      Unlock with secret
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={(): void => {
                      const next = window.prompt("New company name", company.name);
                      if (next !== null && next.trim() !== "" && next.trim() !== company.name) {
                        props.onRename(company.id, next.trim());
                      }
                    }}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    aria-expanded={pairingCompanyId === company.id}
                    onClick={(): void => props.onTogglePairing?.(company.id)}
                  >
                    {pairingCompanyId === company.id ? "Hide device setup" : "Link device"}
                  </button>
                  {company.disabled ? null : (
                    <button
                      type="button"
                      onClick={(): void => {
                        if (
                          window.confirm(
                            `Disable "${company.name}"? Its app stops sending immediately (credits are untouched).`,
                          )
                        ) {
                          props.onDisable(company.id);
                        }
                      }}
                    >
                      Disable
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}

        {pairingCompany !== null && (
          <div className="card nested" data-testid="company-pairing">
            <h2>Link your Android device — {pairingCompany.name}</h2>
            <p className="muted">
              Pair the Android phone that holds your SIM as this company&apos;s BYOD gateway.
              The same steps work for every company you own.
            </p>
            <DevicePairingView secret={pairingSecret} />
            {props.rotateError !== null && props.rotateError !== undefined && (
              <p className="error" role="alert">
                {props.rotateError}
              </p>
            )}
            <p>
              <button
                type="button"
                data-testid="company-rotate-secret-btn"
                disabled={props.rotatingCompanyId === pairingCompany.id}
                onClick={(): void => props.onRotateSecret?.(pairingCompany.id)}
              >
                {props.rotatingCompanyId === pairingCompany.id
                  ? "Generating new code…"
                  : "Generate new pairing code / Re-pair phone"}
              </button>
            </p>
            {rotatedSecret !== undefined && (
              <p className="ok-note" data-testid="company-rotated-secret">
                New pairing code generated — the QR and payload above are live now. The previous
                code stopped working the moment it was issued, so re-pair any other phone with
                this one.
              </p>
            )}
            <button
              type="button"
              onClick={(): void => props.onTogglePairing?.(pairingCompany.id)}
            >
              Hide device setup
            </button>
          </div>
        )}

        {props.freshSecret !== null && (
          <div className="card nested" data-testid="fresh-secret">
            <h2>Save your company secrets now</h2>
            <p className="muted">
              This is the only time the server will show them. They are stored hashed —
              lost secrets cannot be recovered, only re-proven via Link existing app.
            </p>
            <p>
              App ID: <code data-testid="fresh-app-id">{props.freshSecret.appId}</code>
            </p>
            <p>
              App secret: <code data-testid="fresh-app-secret">{props.freshSecret.appSecret}</code>
            </p>
            <p>
              Device enrollment secret:{" "}
              <code data-testid="fresh-device-secret">{props.freshSecret.deviceEnrollmentSecret}</code>
            </p>
            <DevicePairingView secret={props.freshSecret.deviceEnrollmentSecret} />
            {props.freshSecret.trialSms > 0 && (
              <p className="muted" data-testid="fresh-trial">
                Trial credits ({props.freshSecret.trialSms} OTP + {props.freshSecret.trialSms} bulk
                SMS) were added to your wallet — once per account.
              </p>
            )}
            <button type="button" onClick={props.onAcknowledgeSecret}>
              I saved it — open dashboard
            </button>
          </div>
        )}

        <form
          onSubmit={(e): void => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            props.onCreate(String(data.get("name") ?? ""));
          }}
        >
          <h2>Create a company</h2>
          {props.creationBlocked === true ? (
            <p className="error" role="alert" data-testid="creation-gated">
              Company creation is paused until your email is verified — confirm
              the link we sent, then come back here.
            </p>
          ) : null}
          <label htmlFor="companyName">Company name</label>
          <input
            id="companyName"
            name="name"
            placeholder="My shop"
            maxLength={128}
            required
            disabled={props.creationBlocked === true}
          />
          <button
            type="submit"
            disabled={props.busy || props.creationBlocked === true}
            title={props.creationBlocked === true ? "Verify your email to create a company" : undefined}
          >
            {props.busy ? "Creating…" : "Create company"}
          </button>
        </form>

        {props.linkedApps !== null && props.linkedApps.length > 0 && (
          <>
            <h2>Linked apps</h2>
            <p className="muted">Operator-issued apps you claimed — they keep their own balance.</p>
            <ul className="app-list">
              {props.linkedApps.map((app) => (
                <li key={app.appId} className="app-row">
                  <span className="app-name">
                    {app.name}
                    {app.revoked && <span className="badge">revoked</span>}
                  </span>
                  <code>{app.appId}</code>
                  {app.revoked ? (
                    <span className="muted">Revoked by the operator</span>
                  ) : (
                    <button type="button" onClick={(): void => props.onOpen(app.appId)}>
                      {storedCreds?.appId === app.appId ? "Open dashboard" : "Unlock with secret"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}

        <p className="muted">
          Operator issued you an app?{" "}
          <button type="button" className="button-link" onClick={props.onLinkExisting}>
            Link existing app
          </button>
        </p>
      </div>
    </>
  );
}

/**
 * Container: loads wallet + companies + linked apps, creates companies
 * (secrets shown exactly once, then handed to sessionStorage), renames and
 * disables them, and routes Open/Unlock to the selected app.
 */
export function Apps({
  emailVerifiedAt,
  onOpenApp,
  onLinkExisting,
}: {
  /** From /v5/auth/me (undefined = still probing the session). */
  emailVerifiedAt: number | null | undefined;
  onOpenApp: () => void;
  onLinkExisting: () => void;
}): JSX.Element {
  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [linkedApps, setLinkedApps] = useState<OwnedApp[] | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [walletHistory, setWalletHistory] = useState<WalletTransaction[] | null>(null);
  const [showHistory, setShowHistory] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [freshSecret, setFreshSecret] = useState<{
    companyId: string;
    appId: string;
    appSecret: string;
    deviceEnrollmentSecret: string;
    trialSms: number;
  } | null>(null);
  const [mailConfigured, setMailConfigured] = useState<boolean | null>(null);
  const [resent, setResent] = useState<boolean>(false);
  // ISSUE-112: which company's "Link your Android device" panel is open.
  const [pairingCompanyId, setPairingCompanyId] = useState<string | null>(null);
  // ISSUE-113: self-serve re-pairing — minted secrets live only in this
  // session's state (the server never re-serves one), keyed by company.
  const [rotatedSecrets, setRotatedSecrets] = useState<Record<string, string>>({});
  const [rotatingCompanyId, setRotatingCompanyId] = useState<string | null>(null);
  const [rotateError, setRotateError] = useState<string | null>(null);

  const reload = (): void => {
    listCompanies()
      .then(setCompanies)
      .catch((err: unknown) => setError(describeError(err)));
    getWallet()
      .then(setWallet)
      .catch((err: unknown) => setError(describeError(err)));
    // Linked apps = owned rows WITHOUT a company (the company-backed ones are
    // cards above; the /v5/auth/apps projection stays a legacy consumer).
    listOwnedApps()
      .then((owned) => {
        setLinkedApps(owned.filter((a) => !companiesRef.has(a.appId)));
      })
      .catch((err: unknown) => setError(describeError(err)));
  };

  // Company appIds of the LAST loaded list — used to split linked apps from
  // company apps without a second server round-trip.
  const [companiesRef, setCompaniesRef] = useState<Set<string>>(new Set());
  useEffect(() => {
    setCompaniesRef(new Set((companies ?? []).map((c) => c.app.appId)));
    setLinkedApps((prev) => (prev === null ? prev : prev.filter((a) => !new Set((companies ?? []).map((c) => c.app.appId)).has(a.appId))));
  }, [companies]);

  useEffect(() => {
    listCompanies()
      .then((loaded) => {
        setCompanies(loaded);
        const ids = new Set(loaded.map((c) => c.app.appId));
        listOwnedApps()
          .then((owned) => setLinkedApps(owned.filter((a) => !ids.has(a.appId))))
          .catch((err: unknown) => setError(describeError(err)));
      })
      .catch((err: unknown) => setError(describeError(err)));
    getWallet()
      .then(setWallet)
      .catch((err: unknown) => setError(describeError(err)));
    getMailStatus()
      .then(setMailConfigured)
      .catch(() => setMailConfigured(null));
  }, []);

  useEffect(() => {
    if (!showHistory) return;
    getWalletTransactions()
      .then(setWalletHistory)
      .catch((err: unknown) => setError(describeError(err)));
  }, [showHistory]);

  const create = (name: string): void => {
    setBusy(true);
    setError(null);
    createCompany(name)
      .then((created: CompanyCreated) => {
        setBusy(false);
        setFreshSecret({
          companyId: created.company.id,
          appId: created.app.appId,
          appSecret: created.app.appSecret,
          deviceEnrollmentSecret: created.app.deviceEnrollmentSecret,
          trialSms: created.trial?.otpSms ?? 0,
        });
        reload();
        getWallet().then(setWallet).catch(() => undefined);
      })
      .catch((err: unknown) => {
        setBusy(false);
        setError(describeError(err));
      });
  };

  const acknowledge = (): void => {
    if (freshSecret !== null) {
      connectApp(freshSecret.appId, freshSecret.appSecret);
      setFreshSecret(null);
      onOpenApp();
    }
  };

  const rename = (companyId: string, name: string): void => {
    setError(null);
    renameCompany(companyId, name)
      .then(reload)
      .catch((err: unknown) => setError(describeError(err)));
  };

  const disable = (companyId: string): void => {
    setError(null);
    disableCompany(companyId)
      .then(reload)
      .catch((err: unknown) => setError(describeError(err)));
  };

  /**
   * ISSUE-113: self-serve re-pairing — mints a new enrollment secret and
   * keeps the one-time value in this session's state so the panel can show
   * its QR/payload immediately. The previous payload stops enrolling the
   * moment the server commits the new digest.
   */
  const rotateSecret = (companyId: string): void => {
    setRotatingCompanyId(companyId);
    setRotateError(null);
    rotateCompanyDeviceSecret(companyId)
      .then((res) => {
        setRotatedSecrets((prev) => ({ ...prev, [res.companyId]: res.deviceEnrollmentSecret }));
      })
      .catch((err: unknown) => setRotateError(describeError(err)))
      .finally(() => setRotatingCompanyId(null));
  };

  const open = (appId: string): void => {
    if (getConnectedApp()?.appId === appId) {
      onOpenApp();
      return;
    }
    // The secret for this app is not in this tab (never re-served by the
    // server) — the link screen re-proves it once and stores it here.
    onLinkExisting();
    window.location.hash = hrefFor(["link", encodeURIComponent(appId)]);
  };

  const verifyBanner: "hidden" | "offer" | "sent" =
    resent
      ? "sent"
      : mailConfigured === true && emailVerifiedAt !== undefined && emailVerifiedAt === null
        ? "offer"
        : "hidden";
  // ISSUE-119: mirrors the banner-offer condition but stays true after a
  // resend (banner flips to "sent" while the account is still unverified).
  const creationBlocked =
    mailConfigured === true && emailVerifiedAt !== undefined && emailVerifiedAt === null;

  return (
    <AppsView
      companies={companies}
      wallet={wallet}
      walletHistory={walletHistory}
      showHistory={showHistory}
      linkedApps={linkedApps}
      emailVerified={emailVerifiedAt !== null && emailVerifiedAt !== undefined}
      error={error}
      busy={busy}
      freshSecret={freshSecret}
      verifyBanner={verifyBanner}
      creationBlocked={creationBlocked}
      pairingCompanyId={pairingCompanyId}
      onTogglePairing={(companyId: string): void => {
        setPairingCompanyId((current) => (current === companyId ? null : companyId));
      }}
      rotatedSecrets={rotatedSecrets}
      rotatingCompanyId={rotatingCompanyId}
      rotateError={rotateError}
      onRotateSecret={rotateSecret}
      onResend={(): void => {
        resendVerification()
          .then(() => setResent(true))
          .catch((err: unknown) => setError(describeError(err)));
      }}
      onOpen={open}
      onCreate={create}
      onRename={rename}
      onDisable={disable}
      onAcknowledgeSecret={acknowledge}
      onLinkExisting={onLinkExisting}
      onToggleHistory={(): void => setShowHistory((v) => !v)}
    />
  );
}
