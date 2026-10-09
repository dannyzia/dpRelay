import { useState } from "react";
import { API_BASE, getConnectedApp } from "../api";

/** Where requests actually go ("" = same origin). */
export function effectiveApiBase(): string {
  return API_BASE === "" ? window.location.origin : API_BASE;
}

/** Pure credentials view — exported for render tests (revealed=true shows literals). */
export function CredentialsView(props: {
  appId: string;
  appSecret: string;
  revealed: boolean;
  onToggleReveal: () => void;
}): JSX.Element {
  const mask = "•".repeat(24);
  return (
    <div className="card">
      <h2>App ID</h2>
      <div className="reveal">
        <code data-testid="app-id">{props.appId}</code>
      </div>
      <h2 className="mt-18">App secret</h2>
      <div className="reveal">
        <code data-testid="app-secret">
          {props.revealed ? props.appSecret : mask}
        </code>
        <button type="button" className="secondary" onClick={props.onToggleReveal}>
          {props.revealed ? "Hide" : "Reveal"}
        </button>
      </div>
      <p className="muted mt-6">
        Session-only — these values live in this tab&apos;s storage and are never part of the
        page bundle. Reveal shares your screen; nothing is copied anywhere.
      </p>
      <h2 className="mt-18">Request headers</h2>
      <pre>{`X-App-Id: ${props.appId}
X-App-Secret: ${props.revealed ? props.appSecret : mask}`}</pre>
      <p className="muted">
        API base: <code>{effectiveApiBase()}</code> — webhook deliveries use the webhook secret
        shown exactly once when your app was registered (rotate it with the operator if lost).
      </p>
    </div>
  );
}

/** Container: reads the signed-in credentials from session storage. */
export function Credentials(): JSX.Element {
  const [revealed, setRevealed] = useState<boolean>(false);
  const creds = getConnectedApp();
  if (creds === null) {
    return <p className="muted">Not signed in.</p>;
  }
  return (
    <>
      <div className="page-head">
        <h1>API credentials</h1>
      </div>
      <CredentialsView
        appId={creds.appId}
        appSecret={creds.appSecret}
        revealed={revealed}
        onToggleReveal={(): void => setRevealed((r) => !r)}
      />
    </>
  );
}
