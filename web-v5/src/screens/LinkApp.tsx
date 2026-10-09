import { useState } from "react";
import { connectApp, describeError, linkOwnedApp } from "../api";

/**
 * STAGE F3 (ISSUE-81): "Link existing app" — proves possession of an
 * operator-provisioned app (or re-proves an owned one in a fresh tab) by
 * entering appId + appSecret once. On success the credentials join this
 * tab's sessionStorage and the existing customer screens key to the app.
 * Pure view exported for render tests.
 */
export function LinkAppView(props: {
  appId: string;
  error: string | null;
  busy: boolean;
  onLink: (appId: string, appSecret: string) => void;
  onBack: () => void;
}): JSX.Element {
  return (
    <div className="card narrow">
      <h1>Link existing app</h1>
      <p className="muted">
        Enter the appId + appSecret your operator issued (or that you saved once at
        registration). The server proves them and binds the app to your account —
        the secret is kept in this tab only.
      </p>
      <form
        onSubmit={(e): void => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          props.onLink(String(data.get("appId") ?? ""), String(data.get("appSecret") ?? ""));
        }}
      >
        <label htmlFor="linkAppId">App ID</label>
        <input
          id="linkAppId"
          name="appId"
          defaultValue={props.appId}
          required
          spellCheck={false}
          autoComplete="off"
        />
        <label htmlFor="linkAppSecret">App secret</label>
        <input
          id="linkAppSecret"
          name="appSecret"
          type="password"
          required
          spellCheck={false}
          autoComplete="off"
        />
        {props.error !== null && (
          <p className="error" role="alert">
            {props.error}
          </p>
        )}
        <button type="submit" disabled={props.busy}>
          {props.busy ? "Checking…" : "Link app"}
        </button>
      </form>
      <p className="muted">
        <button type="button" className="button-link" onClick={props.onBack}>
          Back to apps
        </button>
      </p>
    </div>
  );
}

/** Container: links, stores the proven credentials, opens the dashboard. */
export function LinkApp({
  prefillAppId,
  onLinked,
  onBack,
}: {
  prefillAppId: string;
  onLinked: () => void;
  onBack: () => void;
}): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  const submit = (appId: string, appSecret: string): void => {
    setBusy(true);
    setError(null);
    linkOwnedApp(appId.trim(), appSecret)
      .then((app) => {
        connectApp(app.appId, appSecret);
        setBusy(false);
        onLinked();
      })
      .catch((err: unknown) => {
        setBusy(false);
        setError(describeError(err));
      });
  };

  return <LinkAppView appId={prefillAppId} error={error} busy={busy} onLink={submit} onBack={onBack} />;
}
