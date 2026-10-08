/**
 * Integration docs — the send/verify/status contract as the server actually
 * implements it (server/src/routes/otp.ts + billing.ts handlers). Static
 * content: no endpoint needed, public before sign-in.
 */
export function Docs(): JSX.Element {
  return (
    <div className="docs">
      <h1>Integration docs</h1>
      <p className="muted">
        Base URL of this deployment&apos;s API. All request and response bodies are JSON; every
        response carries <code>{"{ ok, error, code }"}</code> on failure. Authenticate every
        app-plane call with the two headers below.
      </p>
      <pre>{`X-App-Id: <your app id>
X-App-Secret: <your app secret>`}</pre>

      <section>
        <h2>1 · Send an OTP</h2>
        <pre>{`POST /v5/otp/send
{ "phone": "+8801XXXXXXXXX" }

201 { "ok": true, "sessionId": "...", "expiresAt": 1794000000 }`}</pre>
        <p className="muted">
          Phone must be strict E.164. Each send consumes one OTP credit —{" "}
          <code>402 insufficient_credits</code> when the balance is zero. Rate limits answer{" "}
          <code>429 rate_limited</code> (per-app per-number) and{" "}
          <code>429 resend_cooldown</code> (per-number cooldown).
        </p>
      </section>

      <section>
        <h2>2 · Verify the code</h2>
        <pre>{`POST /v5/otp/verify
{ "phone": "+8801XXXXXXXXX", "otp": "123456" }

200 { "ok": true, "verified": true }`}</pre>
        <p className="muted">
          Failure codes: <code>400 otp_expired</code> (no active session / TTL passed),{" "}
          <code>423 otp_locked</code> (too many attempts — <code>retryAfterSec</code> tells you
          when), <code>400 invalid_otp_format</code> / <code>invalid_phone</code>.
        </p>
      </section>

      <section>
        <h2>3 · Poll status</h2>
        <pre>{`GET /v5/otp/status?phone=%2B8801XXXXXXXXX

200 { "ok": true, "status": "pending|verified|expired",
      "expiresAt": 1794000000, "attemptsLeft": 5,
      "lockedUntil": null, "verifiedAt": null }`}</pre>
        <p className="muted">
          <code>404 not_found</code> when the number never requested a session.
        </p>
      </section>

      <section>
        <h2>4 · Credits</h2>
        <p className="muted">
          Balance: <code>GET /v5/billing/credits</code> → both buckets plus their expiry.
          Buying: <code>GET /v5/billing/packages</code> → <code>POST /v5/billing/credits/request{" "}
          {"{ packageCode }"}</code> returns the bKash destination + amount → Send Money →{" "}
          <code>POST /v5/billing/credits/submit-trx {"{ transactionId, trxId }"}</code> → the
          operator approves and the balance updates. Track it all in{" "}
          <code>GET /v5/billing/transactions</code>. TrxID reuse of a different pending
          transaction answers <code>409 trx_id_exists</code>.
        </p>
      </section>
    </div>
  );
}
