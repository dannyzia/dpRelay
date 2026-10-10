import { useEffect, useState } from "react";
import { describeError, forgotPassword, getMailStatus } from "../api";

/**
 * STAGE F3 amendment (ISSUE-82): "Forgot password?" — step 1 of the
 * self-service reset. The server always answers ok (anti-enumeration), so
 * this screen says "check your email" unconditionally; the mail-status hint
 * tells the user when email isn't configured yet (ordered clean-disable UX).
 * Pure view exported for render tests.
 */
export function ForgotPasswordView(props: {
  sent: boolean;
  error: string | null;
  busy: boolean;
  mailConfigured: boolean | null;
  onSubmit: (email: string) => void;
}): JSX.Element {
  return (
    <div className="card narrow">
      <h1>Reset your password</h1>
      {props.mailConfigured === false && (
        <p className="error" role="alert">
          Email is not enabled on this deployment yet — contact the operator to reset your
          password.
        </p>
      )}
      {props.sent ? (
        <>
          <p className="muted">
            If that email has a dP Relay account, a reset link is on its way. The link works
            once and expires quickly.
          </p>
          <p className="muted">
            <a href="#/login">Back to sign in</a>
          </p>
        </>
      ) : (
        <form
          onSubmit={(e): void => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            props.onSubmit(String(data.get("email") ?? ""));
          }}
        >
          <label htmlFor="forgotEmail">Email</label>
          <input id="forgotEmail" name="email" type="email" autoComplete="email" required spellCheck={false} />
          {props.error !== null && (
            <p className="error" role="alert">
              {props.error}
            </p>
          )}
          <button type="submit" disabled={props.busy}>
            {props.busy ? "Sending…" : "Send reset link"}
          </button>
        </form>
      )}
    </div>
  );
}

/** Container: probes mail config, submits the reset request, tracks sent/error/busy. */
export function ForgotPassword(): JSX.Element {
  const [sent, setSent] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [mailConfigured, setMailConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    getMailStatus()
      .then(setMailConfigured)
      .catch(() => setMailConfigured(null));
  }, []);

  const submit = (email: string): void => {
    setBusy(true);
    setError(null);
    forgotPassword(email)
      .then(() => {
        setBusy(false);
        setSent(true);
      })
      .catch((err: unknown) => {
        setBusy(false);
        setError(describeError(err));
      });
  };

  return <ForgotPasswordView sent={sent} error={error} busy={busy} mailConfigured={mailConfigured} onSubmit={submit} />;
}
