import { useState } from "react";
import { ApiError, connectApp, describeError, disconnectApp, getCredits } from "../api";

/** Pure sign-in form — exported for render tests. */
export function LoginView(props: {
  error: string | null;
  busy: boolean;
  onSubmit: (appId: string, appSecret: string) => void;
}): JSX.Element {
  return (
    <div className="card narrow">
      <h1>Sign in</h1>
      <p className="muted">
        Enter the app credentials the operator issued for your integration. They are kept in
        this tab&apos;s session storage only — closed tab, gone credentials.
      </p>
      <form
        onSubmit={(e): void => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          props.onSubmit(String(data.get("appId") ?? ""), String(data.get("appSecret") ?? ""));
        }}
      >
        <label htmlFor="appId">App ID</label>
        <input id="appId" name="appId" autoComplete="username" required spellCheck={false} />
        <label htmlFor="appSecret">App secret</label>
        <input
          id="appSecret"
          name="appSecret"
          type="password"
          autoComplete="current-password"
          required
          spellCheck={false}
        />
        {props.error !== null && (
          <p className="error" role="alert">
            {props.error}
          </p>
        )}
        <button type="submit" disabled={props.busy}>
          {props.busy ? "Checking…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

/**
 * Container: stores credentials only AFTER a successful probe
 * (GET /v5/billing/credits) — a bad secret never lingers in sessionStorage.
 */
export function Login({ onConnected }: { onConnected: () => void }): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  const submit = (appId: string, appSecret: string): void => {
    setBusy(true);
    setError(null);
    connectApp(appId, appSecret);
    getCredits()
      .then(() => {
        setBusy(false);
        onConnected();
      })
      .catch((err: unknown) => {
        disconnectApp();
        setBusy(false);
        setError(
          err instanceof ApiError && err.code === "network_error"
            ? describeError(err)
            : `Sign-in rejected: ${describeError(err)}`,
        );
      });
  };

  return <LoginView error={error} busy={busy} onSubmit={submit} />;
}
