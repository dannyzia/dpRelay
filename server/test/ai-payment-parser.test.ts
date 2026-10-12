/**
 * ISSUE-98 (AC5/AC6) — extraction service (services/ai-payment-parser.ts).
 *
 * Covers:
 * - normalizeExtraction: the defensive rules that make model output
 *   untrusted — provider/trxId/amount/counterparty all downgraded to
 *   empty/0/unknown when they fail validation, the stage-order schema
 *   (isPayment/confidence present, senderPhone nullable, trxId >= 8), and
 *   structurally unusable responses return null (→ throw → 503 upstream);
 * - parsePaymentWithAi: Gemini when a key is configured, the server-side
 *   regex fallback when it is not (never touches the network, never throws);
 * - regexFallbackExtract: Bengali/English/alternate provider fixtures —
 *   Bengali digits, Tk/৳/BDT/taka amounts, labelled vs generic TrxIDs, a
 *   phone number never mistaken for a TrxID, and the isPayment verdict for
 *   bodies with no payment structure;
 * - extractPayment: the Google GenAI request contract (model + key in the
 *   URL, JSON schema, timeout signal) and every transport/shape failure
 *   that must throw so the route answers 503 instead of discarding a real
 *   payment.
 */
import { describe, expect, it, vi } from "vitest";
import {
  extractPayment,
  normalizeExtraction,
  parsePaymentWithAi,
  regexFallbackExtract,
} from "../src/services/ai-payment-parser.js";

const CFG = {
  geminiApiKey: "test-key-0123456789abcdef",
  geminiModel: "gemini-2.0-flash",
  geminiApiBase: "https://generativelanguage.googleapis.com/v1beta",
  geminiTimeoutMs: 15_000,
};

const LEGIT = {
  isPayment: true,
  isLegitimate: true,
  provider: "bkash",
  trxId: "8AC3K2L9P1",
  amountBdt: 500,
  senderPhone: "01712345678",
  counterpartyType: "customer",
  confidence: 0.95,
};

function envelope(text: string): Response {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }),
    { status: 200 },
  );
}

describe("normalizeExtraction — untrusted model output is re-validated", () => {
  it("passes a well-formed extraction through", () => {
    expect(normalizeExtraction(LEGIT)).toEqual(LEGIT);
  });

  it("lowercases a known provider and nulls an unknown one", () => {
    expect(normalizeExtraction({ ...LEGIT, provider: "NAGAD" }).provider).toBe("nagad");
    expect(normalizeExtraction({ ...LEGIT, provider: "paypal" }).provider).toBe("");
    expect(normalizeExtraction({ ...LEGIT, provider: 42 }).provider).toBe("");
    // AC6 set: all five providers from migration 021 survive normalization;
    // the schema's "unknown" escape value maps to "" (uninsertable).
    for (const provider of ["bkash", "nagad", "rocket", "upay", "bank"]) {
      expect(normalizeExtraction({ ...LEGIT, provider }).provider).toBe(provider);
    }
    expect(normalizeExtraction({ ...LEGIT, provider: "unknown" }).provider).toBe("");
  });

  it("applies the stage-order trxId rule: >= 8 alnum, verbatim (never case-mangled)", () => {
    // 8..24 alnum accepted (stage order: trxId.length >= 8).
    expect(normalizeExtraction({ ...LEGIT, trxId: "ABCD1234" }).trxId).toBe("ABCD1234");
    expect(normalizeExtraction({ ...LEGIT, trxId: "Rocket9x" }).trxId).toBe("Rocket9x");
    expect(normalizeExtraction({ ...LEGIT, trxId: "  ABCD1234EF  " }).trxId).toBe("ABCD1234EF");
    // Below 8, containing separators, or not a string → downgraded to "".
    expect(normalizeExtraction({ ...LEGIT, trxId: "short" }).trxId).toBe("");
    expect(normalizeExtraction({ ...LEGIT, trxId: "ABC-12345" }).trxId).toBe("");
    expect(normalizeExtraction({ ...LEGIT, trxId: "A".repeat(25) }).trxId).toBe("");
    expect(normalizeExtraction({ ...LEGIT, trxId: 42 }).trxId).toBe("");
  });

  it("downgrades unusable amounts to 0 (negative, non-finite, unsafe)", () => {
    expect(normalizeExtraction({ ...LEGIT, amountBdt: -5 }).amountBdt).toBe(0);
    expect(normalizeExtraction({ ...LEGIT, amountBdt: Number.NaN }).amountBdt).toBe(0);
    expect(normalizeExtraction({ ...LEGIT, amountBdt: Infinity }).amountBdt).toBe(0);
    expect(normalizeExtraction({ ...LEGIT, amountBdt: 1e21 }).amountBdt).toBe(0);
    expect(normalizeExtraction({ ...LEGIT, amountBdt: "500" }).amountBdt).toBe(0);
  });

  it("normalizes counterpartyType to the enum with 'unknown' as the fallback", () => {
    expect(normalizeExtraction({ ...LEGIT, counterpartyType: "MERCHANT" }).counterpartyType).toBe("merchant");
    expect(normalizeExtraction({ ...LEGIT, counterpartyType: "brother" }).counterpartyType).toBe("unknown");
    expect(normalizeExtraction({ ...LEGIT, counterpartyType: 7 }).counterpartyType).toBe("unknown");
  });

  it("senderPhone is nullable: trimmed string when present, null when absent/blank", () => {
    expect(normalizeExtraction({ ...LEGIT, senderPhone: " 01712345678 " }).senderPhone).toBe("01712345678");
    expect(normalizeExtraction({ ...LEGIT, senderPhone: "" }).senderPhone).toBeNull();
    expect(normalizeExtraction({ ...LEGIT, senderPhone: "   " }).senderPhone).toBeNull();
    expect(normalizeExtraction({ ...LEGIT, senderPhone: 123 }).senderPhone).toBeNull();
    expect(normalizeExtraction({ ...LEGIT, senderPhone: "1".repeat(64) }).senderPhone).toHaveLength(32);
  });

  it("confidence is clamped to [0,1] with 0 as the non-numeric default", () => {
    expect(normalizeExtraction({ ...LEGIT, confidence: 0.42 }).confidence).toBe(0.42);
    expect(normalizeExtraction({ ...LEGIT, confidence: 7 }).confidence).toBe(1);
    expect(normalizeExtraction({ ...LEGIT, confidence: -1 }).confidence).toBe(0);
    expect(normalizeExtraction({ ...LEGIT, confidence: "high" }).confidence).toBe(0);
    expect(normalizeExtraction({ ...LEGIT, confidence: undefined }).confidence).toBe(0);
  });

  it("rejects structurally unusable responses (null, non-object, missing/typed-wrong verdicts)", () => {
    expect(normalizeExtraction(null)).toBeNull();
    expect(normalizeExtraction("yes")).toBeNull();
    expect(normalizeExtraction({})).toBeNull();
    expect(normalizeExtraction({ ...LEGIT, isPayment: undefined })).toBeNull();
    expect(normalizeExtraction({ ...LEGIT, isPayment: "yes" })).toBeNull();
    expect(normalizeExtraction({ ...LEGIT, isLegitimate: "yes" })).toBeNull();
    expect(normalizeExtraction({ ...LEGIT, isLegitimate: 1 })).toBeNull();
  });
});

describe("regexFallbackExtract — graceful path when GEMINI_API_KEY is unset", () => {
  it("parses a Bengali-digit bKash SMS (৳ amount + labelled TrxID)", () => {
    const result = regexFallbackExtract({
      sender: "16247",
      rawBody: "৳১২৫০.০০ টাকা প্রাপ্ত হয়েছে। TrxID: 7GH8JK9LMN। ব্যালেন্স ৳৫৩২৫০.০০",
    });
    expect(result).toMatchObject({
      isPayment: true,
      isLegitimate: true,
      trxId: "7GH8JK9LMN",
      amountBdt: 1250,
      confidence: 0.6,
    });
  });

  it("parses the English bKash fixture: labelled TrxID, Tk amount, zero fee skipped, phone extracted", () => {
    const result = regexFallbackExtract({
      sender: "16247",
      rawBody:
        "TrxID 8AC3K2L9P1 received from 01712345678. Tk 500.00 paid. Fee Tk 0.00. Balance Tk 1000.00",
    });
    expect(result).toMatchObject({
      isPayment: true,
      trxId: "8AC3K2L9P1",
      amountBdt: 500,
      senderPhone: "01712345678",
    });
  });

  it("parses alternate provider formats: 'Transaction No' label + BDT amount", () => {
    const result = regexFallbackExtract({
      sender: "16167",
      rawBody: "Transaction No: 7R8S9T1U2V completed. BDT 250 sent to 01812345678.",
    });
    expect(result).toMatchObject({ isPayment: true, trxId: "7R8S9T1U2V", amountBdt: 250 });
  });

  it("never mistakes a phone number for a TrxID (generic scan needs a letter AND a digit)", () => {
    const result = regexFallbackExtract({
      sender: "16247",
      rawBody: "Your account balance update request received. Call 01712345678 for support.",
    });
    expect(result.isPayment).toBe(false);
    expect(result.trxId).toBe("");
    expect(result.amountBdt).toBe(0);
    expect(result.confidence).toBe(0);
  });

  it("a one-signal body is legit-but-incomplete (route discards, never fabricates)", () => {
    const amountOnly = regexFallbackExtract({ sender: "16247", rawBody: "Tk 750.00 received today." });
    expect(amountOnly).toMatchObject({ isPayment: true, isLegitimate: true, trxId: "", amountBdt: 750 });
    const trxOnly = regexFallbackExtract({ sender: "16247", rawBody: "TrxID 8AC3K2L9P1 confirmed." });
    expect(trxOnly).toMatchObject({ isPayment: true, trxId: "8AC3K2L9P1", amountBdt: 0 });
  });
});

describe("parsePaymentWithAi — key configured → Gemini, key unset → regex fallback", () => {
  it("without a key: returns the regex fallback WITHOUT touching the network", async () => {
    const fetchMock = vi.fn();
    const result = await parsePaymentWithAi(
      { sender: "16247", rawBody: "TrxID 8AC3K2L9P1 received. Tk 500.00 paid." },
      { ...CFG, geminiApiKey: "" },
      fetchMock as unknown as typeof fetch,
    );
    expect(result).toMatchObject({ isPayment: true, trxId: "8AC3K2L9P1", amountBdt: 500 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("with a key: calls Gemini and returns the normalized extraction", async () => {
    const fetchMock = vi.fn(async () => envelope(JSON.stringify(LEGIT)));
    const result = await parsePaymentWithAi(
      { sender: "16247", rawBody: "whatever the reader could not parse" },
      CFG,
      fetchMock as unknown as typeof fetch,
    );
    expect(result).toEqual(LEGIT);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("with a key: AI failures still throw (route → 503, reader retries)", async () => {
    const fetchMock = vi.fn(async () => new Response("quota", { status: 429 }));
    await expect(
      parsePaymentWithAi({ sender: "16247", rawBody: "x" }, CFG, fetchMock as unknown as typeof fetch),
    ).rejects.toThrow("gemini HTTP 429");
  });
});

describe("extractPayment — Google GenAI request contract and failure modes", () => {
  it("fails closed on an empty key without ever touching the network", async () => {
    const fetchMock = vi.fn();
    await expect(
      extractPayment("body", "16247", { ...CFG, geminiApiKey: "" }, fetchMock as unknown as typeof fetch),
    ).rejects.toThrow("gemini key not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts structured-output generationConfig to the model URL and parses the candidate text", async () => {
    const fetchMock = vi.fn(async () => envelope(JSON.stringify(LEGIT)));
    const result = await extractPayment(
      "TrxID 8AC3K2L9P1. Tk 500.00 paid.",
      "16247",
      CFG,
      fetchMock as unknown as typeof fetch,
    );
    expect(result).toEqual(LEGIT);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { signal: AbortSignal }];
    expect(url).toBe(
      `${CFG.geminiApiBase}/models/${CFG.geminiModel}:generateContent?key=${CFG.geminiApiKey}`,
    );
    const body = JSON.parse(String(init.body)) as {
      contents: Array<{ parts: Array<{ text: string }> }>;
      generationConfig: {
        temperature: number;
        responseMimeType: string;
        responseSchema: { type: string; properties: Record<string, unknown>; required: string[] };
      };
    };
    expect(body.generationConfig.temperature).toBe(0);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema.type).toBe("OBJECT");
    // Stage-order schema: isPayment + confidence ride along with the original fields.
    expect(Object.keys(body.generationConfig.responseSchema.properties)).toEqual(
      expect.arrayContaining(["isPayment", "isLegitimate", "provider", "trxId", "amountBdt", "senderPhone", "counterpartyType", "confidence"]),
    );
    expect(body.generationConfig.responseSchema.required).toEqual(
      expect.arrayContaining(["isPayment", "isLegitimate", "confidence"]),
    );
    expect(body.contents[0].parts[0].text).toContain("16247");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws on a non-2xx status (status only, no body echo)", async () => {
    const fetchMock = vi.fn(async () => new Response("quota exceeded", { status: 429 }));
    await expect(
      extractPayment("body", "16247", CFG, fetchMock as unknown as typeof fetch),
    ).rejects.toThrow("gemini HTTP 429");
  });

  it("throws when the envelope carries no candidate text", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 }));
    await expect(
      extractPayment("body", "16247", CFG, fetchMock as unknown as typeof fetch),
    ).rejects.toThrow("missing candidate text");
  });

  it("throws when the candidate text is not JSON", async () => {
    const fetchMock = vi.fn(async () => envelope("not json at all"));
    await expect(
      extractPayment("body", "16247", CFG, fetchMock as unknown as typeof fetch),
    ).rejects.toThrow("was not JSON");
  });

  it("throws when the JSON fails structural validation (never a fake discard verdict)", async () => {
    const fetchMock = vi.fn(async () => envelope(JSON.stringify({ nonsense: true })));
    await expect(
      extractPayment("body", "16247", CFG, fetchMock as unknown as typeof fetch),
    ).rejects.toThrow("structural validation");
  });
});
