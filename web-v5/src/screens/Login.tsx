import { useState } from "react";
import { describeError, loginAccount, registerAccount } from "../api";
import { ErrorBanner } from "../components/ErrorBanner";

/**
 * STAGE F3 (ISSUE-81): email/password sign-in + signup — replaces the raw
 * appId/appSecret gate as the dashboard's front door. The session is an
 * HttpOnly cookie set by the server; nothing secret is kept in JS here.
 * Pure view exported for render tests.
 */
export function LoginView(props: {
  mode: "login" | "signup";
  error: string | null;
  busy: boolean;
  onSubmit: (email: string, password: string) => void;
  onToggleMode: () => void;
}): JSX.Element {
  const signingUp = props.mode === "signup";
  return (
    <div className="card narrow">
      <h1>{signingUp ? "Create your account" : "Sign in"}</h1>
      <p className="muted">
        {signingUp
          ? "Your dashboard account owns the apps you register — no app credentials needed to get started."
          : "Sign in with your email and password to reach your apps."}
      </p>
      <form
        onSubmit={(e): void => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          props.onSubmit(String(data.get("email") ?? ""), String(data.get("password") ?? ""));
        }}
      >
        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          spellCheck={false}
          aria-describedby={props.error !== null ? "form-error" : undefined}
        />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete={signingUp ? "new-password" : "current-password"}
          minLength={signingUp ? 10 : undefined}
          required
          spellCheck={false}
          aria-describedby={props.error !== null ? "form-error" : undefined}
        />
        {signingUp && <p className="muted">At least 10 characters.</p>}
        {props.error !== null && <ErrorBanner message={props.error} />}
        <button type="submit" disabled={props.busy}>
          {props.busy ? "Checking…" : signingUp ? "Create account" : "Sign in"}
        </button>
      </form>
      {!signingUp && (
        <p className="muted">
          <a href="#/forgot">Forgot password?</a>
        </p>
      )}
      <p className="muted">
        {signingUp ? "Already have an account? " : "No account yet? "}
        <button type="button" className="button-link" onClick={props.onToggleMode}>
          {signingUp ? "Sign in" : "Create one"}
        </button>
      </p>
      <p className="muted">
        Have an app already? Sign in, then use <strong>Link existing app</strong> with the
        appId + appSecret your operator issued.
      </p>
    </div>
  );
}

/**
 * Container: register auto-opens a session (the server sets the cookie with
 * the 201), so both paths just move on to the owned-app list.
 */
export function Login({ onSignedIn }: { onSignedIn: () => void }): JSX.Element {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  const submit = (email: string, password: string): void => {
    setBusy(true);
    setError(null);
    const action = mode === "signup" ? registerAccount(email, password) : loginAccount(email, password);
    action
      .then(() => {
        setBusy(false);
        onSignedIn();
      })
      .catch((err: unknown) => {
        setBusy(false);
        setError(describeError(err));
      });
  };

  return (
    <LoginView
      mode={mode}
      error={error}
      busy={busy}
      onSubmit={submit}
      onToggleMode={(): void => {
        setMode(mode === "login" ? "signup" : "login");
        setError(null);
      }}
    />
  );
}
