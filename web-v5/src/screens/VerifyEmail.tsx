import { useEffect, useState } from "react";
import { describeError, verifyEmail } from "../api";

/**
 * STAGE F3 amendment (ISSUE-82): email verification landing screen — the
 * emailed link opens `#/verify/<token>`, which consumes the token once and
 * reports the outcome. Verification is SOFT (never gates login), so the
 * screen always offers a way onward.
 * Pure view exported for render tests.
 */
export function VerifyEmailView(props: {
  state: "pending" | "verified" | "failed";
  error: string | null;
}): JSX.Element {
  return (
    <div className="card narrow">
      <h1>Email verification</h1>
      {props.state === "pending" && <p className="muted">Verifying…</p>}
      {props.state === "verified" && (
        <p className="muted">
          Your email is verified — thanks. <a href="#/login">Continue to sign in</a>.
        </p>
      )}
      {props.state === "failed" && (
        <>
          <p className="error" role="alert">
            {props.error ?? "This verification link is invalid or has expired."}
          </p>
          <p className="muted">
            Sign in and request a new link from your apps screen. <a href="#/login">Sign in</a>
          </p>
        </>
      )}
    </div>
  );
}

/** Container: exchanges the emailed token once on mount and tracks verification state. */
export function VerifyEmail({ token }: { token: string }): JSX.Element {
  const [state, setState] = useState<"pending" | "verified" | "failed">("pending");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (token === "") {
      setState("failed");
      return;
    }
    verifyEmail(token)
      .then(() => setState("verified"))
      .catch((err: unknown) => {
        setError(describeError(err));
        setState("failed");
      });
  }, [token]);

  return <VerifyEmailView state={state} error={error} />;
}
