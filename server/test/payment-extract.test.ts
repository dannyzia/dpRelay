/**
 * ISSUE-98 (AC5/AC6) — AI extraction service (services/payment-extract.ts).
 *
 * Covers:
 * - normalizeExtraction: the defensive rules that make model output
 *   untrusted — provider/trxId/amount/counterparty all downgraded to
 *   empty/0/unknown when they fail the SAME validation the fast path uses,
 *   and structurally unusable responses return null (→ throw → 503 upstream);
 * - extractPayment: fail-closed on an empty key (fetch never called), the
 *   Google GenAI request contract (model + key in the URL, JSON schema,
 *   timeout signal), and every transport/shape failure that must throw so
 *   the route answers 503 instead of discarding a real payment.
 */
import { describe, expect, it, vi } from "vitest";
import {
  extractPayment,
  normalizeExtraction,
} from "../src/services/payment-extract.js";

const CFG = {
  geminiApiKey: "test-key-0123456789abcdef",
  geminiModel: "gemini-2.0-flash",
  geminiApiBase: "https://generativelanguage.googleapis.com/v1beta",
  geminiTimeoutMs: 15_000,
};

const LEGIT = {
  isLegitimate: true,
  provider: "bkash",
  trxId: "8AC3K2L9P1",
  amountBdt: 500,
  senderPhone: "01712345678",
  counterpartyType: "customer",
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
    // AC6 set: all five providers from migration 021 survive normalization.
    for (const provider of ["bkash", "nagad", "rocket", "upay", "bank"]) {
      expect(normalizeExtraction({ ...LEGIT, provider }).provider).toBe(provider);
    }
  });

  it("downgrades a TrxID that fails the fast path's own pattern", () => {
    expect(normalizeExtraction({ ...LEGIT, trxId: "short" }).trxId).toBe("");
    expect(normalizeExtraction({ ...LEGIT, trxId: "lower case1" }).trxId).toBe("");
    expect(normalizeExtraction({ ...LEGIT, trxId: "  ABCD1234EF  " }).trxId).toBe("ABCD1234EF");
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

  it("bounds senderPhone and defaults a missing one", () => {
    expect(normalizeExtraction({ ...LEGIT, senderPhone: " 01712345678 " }).senderPhone).toBe("01712345678");
    expect(normalizeExtraction({ ...LEGIT, senderPhone: 123 }).senderPhone).toBe("");
    expect(normalizeExtraction({ ...LEGIT, senderPhone: "1".repeat(64) }).senderPhone).toHaveLength(32);
  });

  it("rejects structurally unusable responses (null, non-object, missing/typed-wrong verdict)", () => {
    expect(normalizeExtraction(null)).toBeNull();
    expect(normalizeExtraction("yes")).toBeNull();
    expect(normalizeExtraction({})).toBeNull();
    expect(normalizeExtraction({ ...LEGIT, isLegitimate: "yes" })).toBeNull();
    expect(normalizeExtraction({ ...LEGIT, isLegitimate: 1 })).toBeNull();
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
      generationConfig: { temperature: number; responseMimeType: string; responseSchema: { type: string } };
    };
    expect(body.generationConfig.temperature).toBe(0);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema.type).toBe("OBJECT");
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
