/**
 * ISSUE-98 (AC5–AC7) — server-side AI payment extraction.
 *
 * The Payment Reader forwards the RAW confirmation body whenever its local
 * regex hints are missing (trxId empty / amountBdt 0). This service calls
 * Gemini with **structured output** (responseSchema + application/json) and
 * returns the fields the ingest route needs to decide: legit → insert +
 * auto-match; counterfeit/spam → warn + discard (AC7).
 *
 * Trust rules:
 * - the model output is NEVER trusted verbatim: every field is re-validated
 *   against the same rules the fast path uses (TXN_ID_PATTERN, provider set,
 *   positive finite amount) and downgraded to ""/0 when it fails;
 * - a structurally unusable response THROWS — the route answers 503
 *   ai_unavailable so the reader's durable queue retries instead of the SMS
 *   being lost (never discard money on a glitchy model answer);
 * - the raw body is sent to the configured Google GenAI endpoint only (AC5's
 *   whole point) and is never logged here.
 *
 * Transport: the Google GenAI REST API (v1beta generateContent) via the
 * runtime's built-in fetch — deliberately NO new npm dependency.
 */
import { TXN_ID_PATTERN } from "../routes/device.js";
import type { Config } from "../config.js";

/** Providers the AI may report (AC6) — mirrors migration 021's CHECK. */
export const AI_PROVIDERS = ["bkash", "nagad", "rocket", "upay", "bank"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

/** Counterparty direction of the payment, as reported by the model (AC6). */
export const COUNTERPARTY_TYPES = ["customer", "merchant", "unknown"] as const;
export type CounterpartyType = (typeof COUNTERPARTY_TYPES)[number];

/**
 * Normalized extraction result. `provider === ""` / `trxId === ""` /
 * `amountBdt === 0` mean "not extractable" — the route treats a legitimate
 * row in that state as incomplete (warn + discard) rather than inserting
 * fabricated money data.
 */
export interface ExtractedPayment {
  isLegitimate: boolean;
  provider: AiProvider | "";
  trxId: string;
  amountBdt: number;
  senderPhone: string;
  counterpartyType: CounterpartyType;
}

/** Gemini structured-output schema (v1beta camelCase); all fields required. */
const EXTRACTION_SCHEMA = {
  type: "OBJECT",
  properties: {
    isLegitimate: {
      type: "BOOLEAN",
      description:
        "false when the message is a fake/counterfeit payment confirmation, phishing scam, or unrelated spam",
    },
    provider: { type: "STRING", enum: [...AI_PROVIDERS] },
    trxId: { type: "STRING", description: "Transaction ID, empty string when absent" },
    amountBdt: { type: "NUMBER", description: "Amount in BDT, 0 when absent" },
    senderPhone: { type: "STRING", description: "Counterparty phone/msisdn, empty string when absent" },
    counterpartyType: { type: "STRING", enum: [...COUNTERPARTY_TYPES] },
  },
  required: ["isLegitimate", "provider", "trxId", "amountBdt", "senderPhone", "counterpartyType"],
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
    "- isLegitimate: false if the message is a FAKE/counterfeit confirmation, a phishing/scam message, an OTP request, or not a real payment confirmation at all.",
    "- provider: which service the message is about (bkash | nagad | rocket | upay | bank).",
    "- trxId: the transaction id, typically 10 uppercase alphanumeric characters; empty string if none.",
    "- amountBdt: the numeric amount in BDT (e.g. 500 or 500.5); 0 if none.",
    "- senderPhone: the counterparty phone number if present, else empty string.",
    "- counterpartyType: 'customer' when money was received FROM them, 'merchant' when money was PAID TO them, 'unknown' otherwise.",
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
  if (typeof rec.isLegitimate !== "boolean") return null;

  const rawProvider = typeof rec.provider === "string" ? rec.provider.toLowerCase() : "";
  const provider = (AI_PROVIDERS as readonly string[]).includes(rawProvider)
    ? (rawProvider as AiProvider)
    : "";

  const rawTrxId = typeof rec.trxId === "string" ? rec.trxId.trim() : "";
  const trxId = TXN_ID_PATTERN.test(rawTrxId) ? rawTrxId : "";

  const rawAmount = typeof rec.amountBdt === "number" ? rec.amountBdt : 0;
  const amountBdt = Number.isFinite(rawAmount) && rawAmount > 0 && Number.isSafeInteger(Math.round(rawAmount * 100))
    ? rawAmount
    : 0;

  const rawCounterparty = typeof rec.counterpartyType === "string" ? rec.counterpartyType.toLowerCase() : "";
  const counterpartyType = (COUNTERPARTY_TYPES as readonly string[]).includes(rawCounterparty)
    ? (rawCounterparty as CounterpartyType)
    : "unknown";

  return {
    isLegitimate: rec.isLegitimate,
    provider,
    trxId,
    amountBdt,
    senderPhone: typeof rec.senderPhone === "string" ? rec.senderPhone.trim().slice(0, 32) : "",
    counterpartyType,
  };
}

/**
 * Extracts payment fields from one raw body via Gemini structured output
 * (AC5). Throws on any transport, HTTP, or response-shape failure — the
 * caller maps that to 503 so the reader retries (money is never dropped on
 * an infrastructure error).
 *
 * @param rawBody Raw SMS body (sent to the AI provider; never logged here).
 * @param sender Originating address (context for the model).
 * @param config Server config (key/model/base URL/timeout come from env).
 * @param fetchImpl Injectable for tests; defaults to the runtime fetch.
 * @throws Error on timeout, non-2xx, or an unparseable model response.
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
