/**
 * STAGE F3 amendment (ISSUE-82): customer FAQ. The question set is the
 * owner-confirmed SAFE list (hub events 1211-1212); SMTP/infrastructure
 * details are deliberately absent (owner flag) — mail setup lives only in
 * the operator panel.
 */

interface FaqEntry {
  q: string;
  a: JSX.Element;
}

const ENTRIES: FaqEntry[] = [
  {
    q: "How do I pay?",
    a: (
      <>
        Open the <a href="#/payment">payment page</a>: you send money to the bKash number with
        TapTap Send, Remitly, Wise, Western Union, or WorldRemit, then submit the TrxID on the
        Buy credits screen.
      </>
    ),
  },
  {
    q: "How do I get API keys?",
    a: (
      <>
        Sign in with your email, then register an app on the Apps screen — the appId and
        appSecret are shown <strong>once</strong>; store them safely. If an operator issued you
        an app instead, use <strong>Link existing app</strong> with those credentials.
      </>
    ),
  },
  {
    q: "How do I reset my password?",
    a: (
      <>
        On the sign-in screen choose <strong>Forgot password?</strong> and enter your email —
        a reset link follows. If email is not yet enabled on this deployment, contact the
        operator and they can reset it for you.
      </>
    ),
  },
  {
    q: "What does an OTP cost?",
    a: (
      <>
        New apps get free trial credits. After that, each SMS is billed from your credit
        balance at the package prices shown on the <strong>Buy credits</strong> screen —
        both OTP and bulk credits are listed there.
      </>
    ),
  },
  {
    q: "Why hasn't my SMS arrived?",
    a: (
      <>
        Check that the recipient number is in strict E.164 format (e.g. +8801XXXXXXXXX) and
        that the recipient&apos;s device is switched on and reachable. Failed sends show in
        the <strong>History</strong> screen; repeated failures usually mean the receiving
        device is offline — contact the operator.
      </>
    ),
  },
];

/** Pure view — exported for render tests. */
export function FaqView(): JSX.Element {
  return (
    <div className="card">
      <h1>Frequently asked questions</h1>
      {ENTRIES.map((e) => (
        <section key={e.q}>
          <h2>{e.q}</h2>
          <p className="muted">{e.a}</p>
        </section>
      ))}
    </div>
  );
}

export function Faq(): JSX.Element {
  return <FaqView />;
}
