import { useState } from "react";
import { buildEnrollmentUri, qrSvg, resolveServerBase } from "../lib/devicePairing";
import { API_BASE } from "../api";

/**
 * BYOD pairing panel for the Apps screen's fresh-secret card. The enrollment
 * secret is shown once; this panel renders it as a QR plus the copyable
 * payload and manual steps — the gateway app has no scanner, so manual entry
 * always works. Pure view, exported for render tests.
 */
export function DevicePairingView(props: { secret: string }): JSX.Element {
  const serverBase = resolveServerBase(API_BASE, window.location.origin);
  const payload = props.secret === "" ? "" : buildEnrollmentUri(serverBase, props.secret);
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    navigator.clipboard
      .writeText(payload)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };
  if (props.secret === "") {
    return (
      <div className="pairing" data-testid="pairing-empty">
        <p className="muted">
          The enrollment secret is shown once. Lost it? Create a company again, or ask
          the operator to enroll a device for you.
        </p>
      </div>
    );
  }
  return (
    <div className="pairing" data-testid="pairing">
      <h3>Link your Android gateway</h3>
      <ol className="pair-steps">
        <li>Install the dP Relay gateway app on the Android phone that holds your SIM.</li>
        <li>Scan this code with any QR reader on that phone, or copy the payload below.</li>
        <li>Paste it into the app's enrollment field — or type the enrollment secret by hand.</li>
        <li>Send a test OTP; messages now go out over your own number, anywhere.</li>
      </ol>
      <div className="qr-box" aria-hidden="true" dangerouslySetInnerHTML={{ __html: qrSvg(payload) }} />
      <p>
        <code data-testid="pairing-payload">{payload}</code>
      </p>
      <button type="button" className="button-link" onClick={copy}>
        {copied ? "Copied" : "Copy enrollment payload"}
      </button>
    </div>
  );
}
