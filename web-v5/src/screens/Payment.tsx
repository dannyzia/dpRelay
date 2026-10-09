/**
 * STAGE F3 amendment (ISSUE-82): customer payment instructions — the five
 * remittance methods targeting the operator's bKash number (owner-provided
 * facts, hub events 1211-1212). The owner's VERBATIM per-service guides are
 * requested on the hub (QUESTION, STEP 4) and slot into each card when
 * posted; this page ships the confirmed facts only — no paraphrased owner copy.
 */
const BKASH_NUMBER = "01613249520";
const BKASH_NUMBER_E164 = "+8801613249520";

const METHODS: { name: string; note: string }[] = [
  { name: "TapTap Send", note: "Send money to a Bangladesh bKash number from the TapTap Send app." },
  { name: "Remitly", note: "Send money to a Bangladesh bKash wallet from Remitly." },
  { name: "Wise", note: "Send money to a Bangladesh bKash number from Wise." },
  { name: "Western Union", note: "Send via the Western Union app, or in person — quote the MTCN when paying at an agent." },
  { name: "WorldRemit", note: "Send money to a Bangladesh bKash number from WorldRemit." },
];

/** Pure view — exported for render tests. */
export function PaymentView(): JSX.Element {
  return (
    <div className="card">
      <h1>How to pay</h1>
      <p className="muted">
        Buy credit with bKash by sending money to{" "}
        <span className="big mono">{BKASH_NUMBER}</span> ({BKASH_NUMBER_E164}), then submit the
        TrxID on the Buy credits screen. Any of these five remittance services works:
      </p>
      <ul className="app-list">
        {METHODS.map((m) => (
          <li key={m.name} className="app-row">
            <span className="app-name">{m.name}</span>
            <span className="muted">{m.note}</span>
          </li>
        ))}
      </ul>
      <p className="muted">
        After sending, open <strong>Buy credits</strong>, pick your package, and paste the TrxID
        from the confirmation SMS — credits are added once the operator confirms it.
      </p>
    </div>
  );
}

export function Payment(): JSX.Element {
  return <PaymentView />;
}
