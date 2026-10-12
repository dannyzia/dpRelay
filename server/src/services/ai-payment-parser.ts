/**
 * ISSUE-98 (AC5–AC7) — server-side payment extraction: Gemini structured
 * output with a graceful server-side regex fallback (stage order round 2).
 *
 * The Payment Reader forwards the RAW confirmation body whenever its local
 * regex hints are missing (trxId empty / amountBdt 0). This service decides
 * what that body actually is:
 *
 * - GEMINI_API_KEY configured → Google GenAI **structured output**
 *   (responseSchema + application/json) returns the verdict fields;
 * - GEMINI_API_KEY NOT configured → `regexFallbackExtract` runs the known
 *   Bengali/English/alternate provider formats locally (no network, never
 *   throws) so ingest keeps working instead of failing closed;
 * - a configured-but-failing AI call still THROWS — the route answers 503
 *   ai_unavailable and the reader's durable queue retries (money is never
 *   dropped on an infrastructure error).
 *
 * Trust rules:
 * - model output is NEVER trusted verbatim: every field is re-validated
 *   (provider set, trxId shape, positive finite amount) and downgraded when
 *   it fails;
 * - the raw body leaves the machine only for the configured AI endpoint —
 *   that IS the AC5 extraction path — and is never logged here;
 * - the regex fallback is a *heuristic*: it cannot judge spoofing depth, so
 *   it only ever returns isLegitimate=true for an already-allowlisted
 *   sender whose body carries at least one payment signal (the route has
 *   already enforced the sender allowlist before this service is called).
 *
 * Transport: the Google GenAI REST API (v1beta generateContent) via the
 * runtime's built-in fetch — deliberately NO new npm dependency.
 */
import type { Config } from "../config.js";

/** Providers the AI may report (AC6) — mirrors migration 021's CHECK. */
export const AI_PROVIDERS = ["bkash", "nagad", "rocket", "upay", "bank"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

/** Counterparty direction of the payment, as reported by the model (AC6). */
export const COUNTERPARTY_TYPES = ["customer", "merchant", "unknown"] as const;
export type CounterpartyType = (typeof COUNTERPARTY_TYPES)[number];

/**
 * Normalized extraction result — the ordered stage-order schema.
 *
 * `isPayment=false` → not a payment SMS at all; `isLegitimate=false` →
 * counterfeit/spam; `provider === ""` / `trxId === ""` / `amountBdt === 0`
 * mean "not extractable" (the route discards a legitimate-but-incomplete
 * row rather than inserting fabricated money data). The route inserts when
 * `isPayment && isLegitimate && trxId.length >= 8 && amountBdt > 0`.
 */
export interface ExtractedPayment {
  isPayment: boolean;
  isLegitimate: boolean;
  provider: AiProvider | "";
  trxId: string;
  amountBdt: number;
  senderPhone: string | null;
  counterpartyType: CounterpartyType;
  confidence: number;
}

/** Input for the high-level parser (stage-order signature). */
export interface AiParseInput {
  sender: string;
  rawBody: string;
}

/**
 * Stage-order insert threshold for AI/fallback-extracted TrxIDs: at least 8
 * characters. (The fast path keeps the stricter TXN_ID_PATTERN — exactly 10
 * uppercase alnum — because reader-hinted IDs come from its own regex.)
 */
const AI_TRXID_PATTERN = /^[A-Za-z0-9]{8,24}$/;

/** Gemini structured-output schema (v1beta camelCase); all fields required. */
const EXTRACTION_SCHEMA = {
  type: "OBJECT",
  properties: {
    isPayment: {
      type: "BOOLEAN",
      description:
        "false when the message is not about a payment at all (marketing, OTP, balance inquiry, unrelated chat)",
    },
    provider: { type: "STRING", enum: [...AI_PROVIDERS, "unknown"] },
    trxId: { type: "STRING", description: "Transaction id, empty string when absent" },
    amountBdt: { type: "NUMBER", description: "Amount in BDT, 0 when absent" },
    senderPhone: { type: "STRING", description: "Counterparty phone/msisdn, empty string when absent" },
    counterpartyType: { type: "STRING", enum: [...COUNTERPARTY_TYPES] },
    isLegitimate: {
      type: "BOOLEAN",
      description:
        "false when the message is a fake/counterfeit payment confirmation, phishing scam, or unrelated spam",
    },
    confidence: {
      type: "NUMBER",
      description: "Your confidence in this extraction, from 0 (guess) to 1 (certain)",
    },
  },
  required: ["isPayment", "provider", "trxId", "amountBdt", "senderPhone", "counterpartyType", "isLegitimate", "confidence"],
} as const;

/**
 * The single prompt. Temperature 0 (set by the caller's generationConfig) +
 * an explicit "no invention" rule: absent fields stay empty, never guessed.
 */
function buildPrompt(rawBody: string, sender: string): string {
  return [
    "You are validating a mobile payment confirmation SMS for a Bangladeshi payment pipeline.",
    `It arrived from sender "${sender}". Extract the fields below as JSON.`,
    "Rules:",
    "- isPayment: false when the message is not about a payment at all (marketing, OTP, balance inquiry, unrelated chat).",
    "- isLegitimate: false if the message is a FAKE/counterfeit confirmation, a phishing/scam message, an OTP request, or not a real payment confirmation at all.",
    "- provider: which service the message is about (bkash | nagad | rocket | upay | bank), or unknown.",
    "- trxId: the transaction id, typically 10 uppercase alphanumeric characters; empty string if none.",
    "- amountBdt: the numeric amount in BDT (e.g. 500 or 500.5); 0 if none.",
    "- senderPhone: the counterparty phone number if present, else empty string.",
    "- counterpartyType: 'customer' when money was received FROM them, 'merchant' when money was PAID TO them, 'unknown' otherwise.",
    "- confidence: 0 to 1 — how sure you are of this extraction.",
    "Never invent values: use the empty string / 0 when a field is absent.",
    "",
    "SMS body:",
    rawBody,
  ].join("\n");
}

/**
 * Defensive normalizer for one parsed model response object. Exported so the
 * unit tests can pin every downgrade rule without a network round-trip.
 *
 * @param value Parsed JSON from the model (untrusted).
 * @returns The normalized extraction, or null when the response is structurally unusable.
 */
export function normalizeExtraction(value: unknown): ExtractedPayment | null {
  if (typeof value !== "object" || value === null) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.isPayment !== "boolean") return null;
  if (typeof rec.isLegitimate !== "boolean") return null;

  const rawProvider = typeof rec.provider === "string" ? rec.provider.toLowerCase() : "";
  const provider = (AI_PROVIDERS as readonly string[]).includes(rawProvider)
    ? (rawProvider as AiProvider)
    : "";

  const rawTrxId = typeof rec.trxId === "string" ? rec.trxId.trim() : "";
  const trxId = AI_TRXID_PATTERN.test(rawTrxId) ? rawTrxId : "";

  const rawAmount = typeof rec.amountBdt === "number" ? rec.amountBdt : 0;
  const amountBdt =
    Number.isFinite(rawAmount) && rawAmount > 0 && Number.isSafeInteger(Math.round(rawAmount * 100))
      ? rawAmount
      : 0;

  const rawCounterparty = typeof rec.counterpartyType === "string" ? rec.counterpartyType.toLowerCase() : "";
  const counterpartyType = (COUNTERPARTY_TYPES as readonly string[]).includes(rawCounterparty)
    ? (rawCounterparty as CounterpartyType)
    : "unknown";

  const rawPhone = typeof rec.senderPhone === "string" ? rec.senderPhone.trim() : "";
  const senderPhone = rawPhone === "" ? null : rawPhone.slice(0, 32);

  const rawConfidence = typeof rec.confidence === "number" ? rec.confidence : 0;
  const confidence = Number.isFinite(rawConfidence) ? Math.min(1, Math.max(0, rawConfidence)) : 0;

  return {
    isPayment: rec.isPayment,
    isLegitimate: rec.isLegitimate,
    provider,
    trxId,
    amountBdt,
    senderPhone,
    counterpartyType,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Server-side regex fallback (GEMINI_API_KEY not configured)
// ---------------------------------------------------------------------------

/** Bengali digits ০–৯ (U+09E6–U+09EF) → ASCII, so amount math works. */
function toAsciiDigits(text: string): string {
  return text.replace(/[\u09E6-\u09EF]/g, (d) => String(d.charCodeAt(0) - 0x09e6));
}

/** Phone-shaped candidates are never transaction ids. */
const PHONE_LIKE = /^(?:\+?8801|01)\d{9,10}$/;

/** Labelled TrxID: "TrxID 8AC3K2L9P1", "Transaction No: 7R8S9T1U2V", "ref-…". */
const LABELLED_TRXID =
  /\b(?:trxid|txnid|transaction|ref(?:erence)?|id)\s*(?:no|number|id)?\s*[:#=-]?\s*([A-Za-z0-9]{8,24})\b/i;

/**
 * Generic TrxID token: 8–24 alphanumeric WITH at least one letter and one
 * digit — this is what separates a transaction id from a phone number, a
 * balance, or a timestamp (e.g. "8AC3K2L9P1" yes, "01712345678" no).
 */
function genericTrxId(text: string): string {
  const tokens = text.toUpperCase().match(/\b[A-Z0-9]{8,24}\b/g) ?? [];
  for (const token of tokens) {
    if (/[A-Z]/.test(token) && /\d/.test(token)) return token;
  }
  return "";
}

/**
 * Amount patterns over digit-normalized text: "Tk 1,250.00", "BDT 500",
 * "৳৫০০.০০", "500 টাকা". Zero amounts are skipped (fee lines like
 * "Fee Tk 0.00" must not win over the real amount that follows).
 */
function fallbackAmount(text: string): number {
  const ascii = toAsciiDigits(text);
  const patterns: RegExp[] = [
    /(?:tk\.?|bdt|৳)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/gi,
    /([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:টাকা|taka)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of ascii.matchAll(pattern)) {
      const parsed = Number.parseFloat(match[1].replace(/,/g, ""));
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return 0;
}

/** Counterparty phone, when the body names one ("from 01712345678", "থেকে …"). */
function fallbackSenderPhone(text: string): string | null {
  const match = text.match(/(?:from|থেকে)\s*(\+?8801\d{10}|01\d{9})/i);
  return match === null ? null : match[1];
}

/**
 * Server-side regex extraction covering the known Bengali & alternate
 * provider formats — the graceful path when no AI key is configured
 * (stage order round 2). Pure, synchronous, never throws.
 *
 * Verdict semantics (route reasons stay accurate):
 * - both trxId + amount found → isPayment/isLegitimate true → insert-eligible;
 * - exactly one signal → isPayment/isLegitimate true → the route discards
 *   it as `extraction_incomplete` (legit but uninsertable);
 * - no signal at all → isPayment false → the route discards `not_payment`
 *   (e.g. a balance inquiry or spam from an allowlisted sender).
 *
 * @param input The sender label (already allowlisted by the route) and raw SMS body.
 * @returns A normalized extraction with a heuristic confidence score.
 */
export function regexFallbackExtract(input: AiParseInput): ExtractedPayment {
  const { rawBody } = input;

  const labelled = rawBody.match(LABELLED_TRXID);
  const labelledCandidate = labelled === null ? "" : labelled[1];
  const trxId =
    labelledCandidate !== "" && !PHONE_LIKE.test(labelledCandidate)
      ? labelledCandidate
      : genericTrxId(rawBody);

  const amountBdt = fallbackAmount(rawBody);
  const signals = (trxId !== "" ? 1 : 0) + (amountBdt > 0 ? 1 : 0);

  return {
    isPayment: signals > 0,
    isLegitimate: signals > 0,
    provider: "",
    trxId,
    amountBdt,
    senderPhone: fallbackSenderPhone(rawBody),
    counterpartyType: "unknown",
    confidence: signals === 2 ? 0.6 : signals === 1 ? 0.3 : 0,
  };
}

// ---------------------------------------------------------------------------
// High-level entry point
// ---------------------------------------------------------------------------

/**
 * Extracts payment fields from one raw body (stage-order signature).
 *
 * With a configured GEMINI_API_KEY this calls Gemini structured output
 * (AC5); without one it falls back to `regexFallbackExtract` so ingest keeps
 * working offline of the AI provider. Throws ONLY when a configured AI call
 * fails (transport/HTTP/shape) — the route maps that to 503 ai_unavailable
 * so the reader retries instead of the SMS being lost.
 *
 * @param input Sender label + raw SMS body.
 * @param config Server config (key/model/base URL/timeout come from env).
 * @param fetchImpl Injectable for tests; defaults to the runtime fetch.
 * @throws Error when a configured AI call times out, returns non-2xx, or an unparseable response.
 */
export async function parsePaymentWithAi(
  input: AiParseInput,
  config: Pick<Config, "geminiApiKey" | "geminiModel" | "geminiApiBase" | "geminiTimeoutMs">,
  fetchImpl: typeof fetch = fetch,
): Promise<ExtractedPayment> {
  if (config.geminiApiKey === "") {
    return regexFallbackExtract(input);
  }
  return extractPayment(input.rawBody, input.sender, config, fetchImpl);
}

/**
 * Gemini-only extraction (AC5). Throws on any transport, HTTP, or
 * response-shape failure, including an unconfigured key — callers that want
 * the no-key fallback use `parsePaymentWithAi` instead.
 *
 * @param rawBody Raw SMS body (sent to the AI provider; never logged here).
 * @param sender Originating address (context for the model).
 * @param config Server config (key/model/base URL/timeout come from env).
 * @param fetchImpl Injectable for tests; defaults to the runtime fetch.
 * @throws Error on missing key, timeout, non-2xx, or an unparseable model response.
 */
export async function extractPayment(
  rawBody: string,
  sender: string,
  config: Pick<Config, "geminiApiKey" | "geminiModel" | "geminiApiBase" | "geminiTimeoutMs">,
  fetchImpl: typeof fetch = fetch,
): Promise<ExtractedPayment> {
  if (config.geminiApiKey === "") {
    throw new Error("gemini key not configured");
  }
  const url = `${config.geminiApiBase}/models/${encodeURIComponent(config.geminiModel)}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: buildPrompt(rawBody, sender) }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: EXTRACTION_SCHEMA,
      },
    }),
    signal: AbortSignal.timeout(config.geminiTimeoutMs),
  });
  if (!response.ok) {
    // Status only — response bodies can echo request-derived data.
    throw new Error(`gemini HTTP ${response.status}`);
  }

  const envelope = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
  };
  const text = (envelope.candidates ?? [])
    .flatMap((c) => c.content?.parts ?? [])
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("");
  if (text === "") {
    throw new Error("gemini response missing candidate text");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("gemini response was not JSON");
  }
  const normalized = normalizeExtraction(parsed);
  if (normalized === null) {
    throw new Error("gemini response failed structural validation");
  }
  return normalized;
}
