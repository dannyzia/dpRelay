/**
 * STAGE F3 amendment (ISSUE-82): customer payment instructions — the five
 * remittance methods targeting the operator's bKash number, carrying the
 * owner's VERBATIM per-service guides (hub event 1243, ANSWER to STEP 4's
 * QUESTION). This is owner copy labelled "verbatim": paste exactly, never
 * paraphrase or editorialise. Structure (headings/lists) is presentational
 * only — every sentence below is the owner's own text.
 */
const BKASH_NUMBER = "01613249520";
const BKASH_NUMBER_E164 = "+8801613249520";

/** One remittance service: owner heading fragment, tagline, and steps (all verbatim). */
type Guide = {
  name: string;
  tagline: string;
  steps?: string[];
  /** Western Union ships two routes instead of a flat list. */
  options?: { label: string; steps: string[] }[];
};

const GUIDES: Guide[] = [
  {
    name: "TapTap Send",
    tagline: "Best for users in the US, UK, Canada, UAE, and Europe.",
    steps: [
      "Open the App: Download the TapTap Send app, log in, or set up your account.",
      "Select Destination: Pick Bangladesh from the country menu.",
      "Enter Amount: Type the amount you want to send. The app will display the current exchange rate and the total BDT the recipient will get.",
      "Add Recipient: Tap Add Recipient and choose bKash as the wallet provider.",
      "Input Details: Full Name: Enter the recipient's legal name. Phone Number: Input +8801613249520.",
      "Pay and Send: Link your local debit card, review the details, and tap Send.",
    ],
  },
  {
    name: "Remitly",
    tagline: "Best for competitive exchange rates and promotional offers.",
    steps: [
      "Log In: Open the Remitly app or website and sign in.",
      "Choose Country & Amount: Select Bangladesh as the destination and enter your sending amount.",
      "Select Delivery Speed: Choose Express for an instant transfer.",
      "Choose Delivery Method: Select Mobile Money and click on bKash.",
      "Recipient Info: Phone Number: Type in 01613249520. Recipient Name: Enter their legal first and last name.",
      "Complete Payment: Enter your card or bank payment details and hit Confirm & Send.",
    ],
  },
  {
    name: "Wise",
    tagline: "Best for getting the mid-market exchange rate with low, transparent fees.",
    steps: [
      "Set Up Transfer: Log into Wise and enter how much you want to transfer in your local currency.",
      "Select Recipient Type: Click on Someone else.",
      "Choose bKash Wallet: Enter the recipient's legal name and select the bKash payout option.",
      "Input Wallet Details: Mobile Number: Type the complete phone number: +8801613249520.",
      "Review & Pay: Review the transfer screen and pay using your linked bank account or debit card.",
    ],
  },
  {
    name: "Western Union",
    tagline: "Best for sending online or paying with cash at a brick-and-mortar location.",
    options: [
      {
        label: "Option A: Via the Western Union App/Website",
        steps: [
          "Initiate Transfer: Go to Send Money and select Bangladesh.",
          "Select Payout: Choose Mobile Wallet as the reception method.",
          "Recipient Information: Add the recipient's legal name and enter +8801613249520 under the wallet number.",
          "Pay Online: Pay with your credit/debit card to send the money instantly.",
        ],
      },
      {
        label: "Option B: In-Person at an Agent Location (Cash Payment)",
        steps: [
          "Visit an Agent: Go to a Western Union counter (e.g., in a grocery store, exchange house, or bank).",
          "Fill the Form: Write down the destination (Bangladesh), recipient's full name, and the bKash number: +8801613249520.",
          "Submit ID and Cash: Provide your local residency ID/passport and pay the agent the cash amount plus the transfer fee.",
          "Keep the Receipt: The agent will provide a receipt with an MTCN (Pin Number). The funds will route directly into the mobile wallet in minutes.",
        ],
      },
    ],
  },
  {
    name: "WorldRemit",
    tagline: "Available in over 50 countries for fast mobile wallet routing.",
    steps: [
      "Select Country: Open WorldRemit and choose Bangladesh.",
      "Select Service: Tap Mobile Money and choose bKash as the payment network.",
      "Enter Amount: Input the sum you wish to transfer and click Next.",
      "Enter Beneficiary Info: Type the recipient's full legal name and mobile number: 01613249520.",
      "Send Funds: Put in your international card details to authorize the transaction.",
    ],
  },
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
      {GUIDES.map((g) => (
        <section key={g.name}>
          <h2>{`How to Send Using ${g.name}`}</h2>
          <p className="muted">{g.tagline}</p>
          {g.steps && (
            <ol>
              {g.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          )}
          {g.options?.map((opt) => (
            <div key={opt.label}>
              <h3>{opt.label}</h3>
              <ol>
                {opt.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            </div>
          ))}
        </section>
      ))}
      <p className="muted">
        After sending, open <strong>Buy credits</strong>, pick your package, and paste the TrxID
        from the confirmation SMS — credits are added once the operator confirms it.
      </p>
    </div>
  );
}

/** Container for the remittance guide — static content, renders the view. */
export function Payment(): JSX.Element {
  return <PaymentView />;
}
