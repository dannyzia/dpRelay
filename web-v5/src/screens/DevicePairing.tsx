import { useState } from "react";
import { buildEnrollmentUri, qrSvg, resolveServerBase } from "../lib/devicePairing";
import { API_BASE } from "../api";

/**
 * Public BYOD install guide on the marketing site — where the gateway APK
 * download reference and the battery/permission walkthrough live. The APK is
 * distributed by dP Relay (it is not hosted by this dashboard), so the panel
 * points at this guide instead of inventing a download URL.
 *
 * ⚠️ FLAG: product-wide constant hardcoded to the marketing host — see the
 * ISSUE-112 stage notes; move it to config if that host ever changes.
 */
export const BYOD_GUIDE_URL = "https://dprelay.digital-papyrus.com/docs/byod/";

/**
 * BYOD pairing panel for the Apps screen's fresh-secret card and the
 * per-company "Link your Android device" section. The enrollment secret is
 * shown once; this panel always renders the 4-step setup guide plus the
 * gateway APK reference, and renders the QR + copyable payload only when the
 * secret is actually known — the gateway app has no scanner, so manual entry
 * always works. Pure view, exported for render tests.
 */
export function DevicePairingView(props: { secret: string }): JSX.Element {
  const serverBase = resolveServerBase(API_BASE, window.location.origin);
  const payload = props.secret === "" ? "" : buildEnrollmentUri(serverBase, props.secret);
  const known = props.secret !== "";
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    navigator.clipboard
      .writeText(payload)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };
  return (
    <div className="pairing" data-testid={known ? "pairing" : "pairing-empty"}>
      <h3>Link your Android gateway</h3>
      <ol className="pair-steps" data-testid="pairing-steps">
        <li>Install the dP Relay gateway app on the Android phone that holds your SIM.</li>
        <li>
          {known
            ? "Scan this code with any QR reader on that phone, or copy the payload below."
            : "Get the enrollment payload — it is shown once, right after the company is created."}
        </li>
        <li>Paste it into the app's enrollment field — or type the enrollment secret by hand.</li>
        <li>Send a test OTP; messages now go out over your own number, anywhere.</li>
      </ol>
      <p className="muted" data-testid="gateway-apk">
        Gateway APK: dP Relay distributes the gateway APK outside this dashboard — ask
        your operator for the official download link, then follow the{" "}
        <a href={BYOD_GUIDE_URL} target="_blank" rel="noreferrer noopener">
          BYOD install guide
        </a>{" "}
        for permissions and battery settings.
      </p>
      {known ? (
        <>
          <div className="qr-box" aria-hidden="true" dangerouslySetInnerHTML={{ __html: qrSvg(payload) }} />
          <p>
            <code data-testid="pairing-payload">{payload}</code>
          </p>
          <button type="button" className="button-link" onClick={copy}>
            {copied ? "Copied" : "Copy enrollment payload"}
          </button>
        </>
      ) : (
        <p className="muted">
          The enrollment secret is shown once. Lost it? Create a company again, or ask
          the operator to rotate the enrollment secret for you — it is stored hashed, so
          the original can never be re-served.
        </p>
      )}
    </div>
  );
}
