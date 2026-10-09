import { useState } from "react";
import { describeError, resetPassword } from "../api";

/**
 * STAGE F3 amendment (ISSUE-82): "Reset password" — step 2, reached from the
 * emailed link (`#/reset/<token>`). On success every session for the account
 * is revoked server-side, so the screen sends the user back to sign in.
 * Pure view exported for render tests.
 */
export function ResetPasswordView(props: {
  hasToken: boolean;
  done: boolean;
  error: string | null;
  busy: boolean;
  onSubmit: (password: string) => void;
}): JSX.Element {
  if (!props.hasToken) {
    return (
      <div className="card narrow">
        <h1>Reset your password</h1>
        <p className="error" role="alert">
          This reset link is incomplete — open the newest email and follow the link in it.
        </p>
      </div>
    );
  }
  return (
    <div className="card narrow">
      <h1>Choose a new password</h1>
      {props.done ? (
        <>
          <p className="muted">Password updated — sign in with it. Other sessions were signed out.</p>
          <p className="muted">
            <a href="#/login">Back to sign in</a>
          </p>
        </>
      ) : (
        <form
          onSubmit={(e): void => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            props.onSubmit(String(data.get("password") ?? ""));
          }}
        >
          <label htmlFor="newPassword">New password</label>
          <input
            id="newPassword"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={10}
            required
            spellCheck={false}
          />
          <p className="muted">At least 10 characters.</p>
          {props.error !== null && (
            <p className="error" role="alert">
              {props.error}
            </p>
          )}
          <button type="submit" disabled={props.busy}>
            {props.busy ? "Saving…" : "Set new password"}
          </button>
        </form>
      )}
    </div>
  );
}

/** Container: submits the emailed-token password reset and tracks done/error/busy. */
export function ResetPassword({ token }: { token: string }): JSX.Element {
  const [done, setDone] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  const submit = (password: string): void => {
    setBusy(true);
    setError(null);
    resetPassword(token, password)
      .then(() => {
        setBusy(false);
        setDone(true);
      })
      .catch((err: unknown) => {
        setBusy(false);
        setError(describeError(err));
      });
  };

  return <ResetPasswordView hasToken={token !== ""} done={done} error={error} busy={busy} onSubmit={submit} />;
}
