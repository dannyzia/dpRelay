import { useEffect, useState } from "react";
import {
  connectApp,
  createSelfServeApp,
  describeError,
  getConnectedApp,
  listOwnedApps,
  type OwnedApp,
} from "../api";

/**
 * STAGE F3 (ISSUE-81): the post-login hub — the signed-in customer's owned
 * apps, self-serve registration, and the entry point into "Link existing app".
 * Selecting an app keys the existing customer screens to it: the tab that
 * created or linked the app holds its secret in sessionStorage (the server
 * never re-serves secrets), and an app unlocked elsewhere is re-proven through
 * the link screen. Pure view exported for render tests.
 */
export function AppsView(props: {
  apps: OwnedApp[] | null;
  error: string | null;
  busy: boolean;
  /** Set while a freshly minted app's secret is on screen — shown exactly once. */
  freshSecret: { appId: string; appSecret: string; trialSms: number } | null;
  onOpen: (appId: string) => void;
  onCreate: (name: string) => void;
  onAcknowledgeSecret: () => void;
  onLinkExisting: () => void;
}): JSX.Element {
  const storedCreds = getConnectedApp();
  return (
    <div className="card">
      <h1>Your apps</h1>
      {props.apps === null && props.error === null && <p className="muted">Loading…</p>}
      {props.error !== null && (
        <p className="error" role="alert">
          {props.error}
        </p>
      )}
      {props.apps !== null && props.apps.length === 0 && (
        <p className="muted">
          No apps yet — register one below, or link an app your operator issued.
        </p>
      )}
      {props.apps !== null && props.apps.length > 0 && (
        <ul className="app-list">
          {props.apps.map((app) => (
            <li key={app.appId} className="app-row">
              <span className="app-name">
                {app.name}
                {app.revoked && <span className="badge">revoked</span>}
              </span>
              <code>{app.appId}</code>
              {app.revoked ? (
                <span className="muted">Revoked by the operator</span>
              ) : storedCreds?.appId === app.appId ? (
                <button type="button" onClick={(): void => props.onOpen(app.appId)}>
                  Open dashboard
                </button>
              ) : (
                <button type="button" onClick={(): void => props.onOpen(app.appId)}>
                  Unlock with secret
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {props.freshSecret !== null && (
        <div className="card nested" data-testid="fresh-secret">
          <h2>Save your app secret now</h2>
          <p className="muted">
            This is the only time the server will show it. It is stored hashed —
            lost secrets cannot be recovered, only re-proven via Link existing app.
          </p>
          <p>
            App ID: <code data-testid="fresh-app-id">{props.freshSecret.appId}</code>
          </p>
          <p>
            App secret: <code data-testid="fresh-app-secret">{props.freshSecret.appSecret}</code>
          </p>
          {props.freshSecret.trialSms > 0 && (
            <p className="muted">Trial credits: {props.freshSecret.trialSms} OTP + {props.freshSecret.trialSms} bulk SMS</p>
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
        <h2>Register a new app</h2>
        <label htmlFor="appName">App name</label>
        <input id="appName" name="name" placeholder="My shop" maxLength={128} />
        <button type="submit" disabled={props.busy}>
          {props.busy ? "Creating…" : "Create app"}
        </button>
      </form>

      <p className="muted">
        Operator issued you an app?{" "}
        <button type="button" className="button-link" onClick={props.onLinkExisting}>
          Link existing app
        </button>
      </p>
    </div>
  );
}

/**
 * Container: loads the owned list, mints apps (secret shown exactly once,
 * then handed to sessionStorage), and routes Open/Unlock to the selected app.
 */
export function Apps({
  onOpenApp,
  onLinkExisting,
}: {
  onOpenApp: () => void;
  onLinkExisting: () => void;
}): JSX.Element {
  const [apps, setApps] = useState<OwnedApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [freshSecret, setFreshSecret] = useState<{
    appId: string;
    appSecret: string;
    trialSms: number;
  } | null>(null);

  useEffect(() => {
    listOwnedApps()
      .then((owned) => {
        setApps(owned);
      })
      .catch((err: unknown) => setError(describeError(err)));
  }, []);

  const create = (name: string): void => {
    setBusy(true);
    setError(null);
    createSelfServeApp(name.trim() === "" ? undefined : name.trim())
      .then((created) => {
        setBusy(false);
        setFreshSecret({
          appId: created.appId,
          appSecret: created.appSecret,
          trialSms: created.trial?.otpSms ?? 0,
        });
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

  const open = (appId: string): void => {
    if (getConnectedApp()?.appId === appId) {
      onOpenApp();
      return;
    }
    // The secret for this app is not in this tab (never re-served by the
    // server) — the link screen re-proves it once and stores it here.
    onLinkExisting();
    window.location.hash = `#/link/${encodeURIComponent(appId)}`;
  };

  return (
    <AppsView
      apps={apps}
      error={error}
      busy={busy}
      freshSecret={freshSecret}
      onOpen={open}
      onCreate={create}
      onAcknowledgeSecret={acknowledge}
      onLinkExisting={onLinkExisting}
    />
  );
}
