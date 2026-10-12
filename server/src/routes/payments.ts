/**
 * STAGE F8 (ISSUE-90) — Payment Reader ingest plane.
 * ISSUE-98 (Stage 2) — hybrid fast-path / AI-extraction pipeline.
 *
 * The dedicated Payment Reader APK (payment-reader/) is a single-purpose app
 * on the money phone: it reads bKash/Nagad confirmation SMS and posts them
 * here. It has no device enrollment, no OTP role, no FCM, no heartbeat — one
 * Bearer secret (PAYMENT_READER_SECRET) gates its one route.
 *
 * ISSUE-98 pipeline (AC3–AC7, stage order round 2):
 * - hints first: `{ trxId, amountBdt }` are OPTIONAL (AC3) — when both are
 *   valid the row is inserted directly, zero AI calls (AC4's "0ms path");
 * - rawBody fallback: missing/invalid hints with a rawBody present go to
 *   parsePaymentWithAi — Gemini structured output when GEMINI_API_KEY is
 *   configured, the server-side Bengali/alternate-format regex fallback
 *   when it is not (graceful degradation, no 503 just for a missing key);
 * - verdict: not-a-payment → discard; counterfeit/spam → warn + discard;
 *   legitimate with trxId.length >= 8 + amount > 0 → INSERT OR IGNORE into
 *   payment_sms + the auto-match trigger (AC7);
 * - configured AI unreachable (timeout, bad response) → 503 ai_unavailable,
 *   so the reader's durable queue keeps the SMS and retries with backoff —
 *   money is never dropped on an infrastructure error.
 *
 * Feeds the SAME payment pipeline as the gateway ingest
 * (POST /v5/device/payment-sms): identical dedupe (UNIQUE txn_id), identical
 * rows for the operator panel's auto-match/approve machinery, tagged
 * `source = 'reader'`.
 *
 * rawBody is never stored and never logged (v4-era hard rule carried into
 * v5); it leaves the machine only for the configured AI endpoint — that IS
 * the AC5 extraction path.
 */
import type { FastifyPluginAsync } from "fastify";
import { parsePaymentWithAi } from "../services/ai-payment-parser.js";
import { constantTimeEquals, newId } from "../services/crypto.js";
import { autoMatchCandidates } from "./admin-payments.js";
import { TXN_ID_PATTERN } from "./device.js";

/**
 * Sender labels accepted from the reader. The reader is configured with the
 * same carrier-normalised variants the gateway parser recognises (different
 * handsets/carriers render the sender differently), so provider derivation
 * here matches the gateway's classification exactly.
 *
 * ISSUE-98 scope decision (owner-confirmed): the sender allowlist STAYS —
 * non-bKash/Nagad senders never leave the phone; AC1 only forbids dropping
 * on *regex* failure.
 */
const BKASH_SENDERS = new Set(["bKash", "BKASH", "16247"]);
const NAGAD_SENDERS = new Set(["Nagad", "NAGAD", "16167"]);

/** Cap on the sender label (matches the gateway route's bound). */
const MAX_SENDER_LEN = 32;

const paymentRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Payment Reader upload (STAGE F8 → ISSUE-98): `POST /v5/payments/ingest`.
   *
   * Auth: `Authorization: Bearer <PAYMENT_READER_SECRET>`, constant-time
   * compare even when the header is missing (ISSUE-11 timing parity).
   * Fail-closed: unset secret → 403 reader_disabled (a deployment with no
   * reader configured exposes nothing), bad secret → 401.
   *
   * Payload (AC3): `{ sender, rawBody, receivedAt, amountBdt?, trxId? }` —
   * receivedAt is epoch milliseconds (same contract as the device route);
   * trxId/amountBdt are reader-side HINTS (absent/empty/0 when its local
   * regex failed). Response: 201 created / 200 idempotent-repeat-or-discard,
   * both with the AC7 `autoMatch` evaluation.
   */
  app.post("/v5/payments/ingest", async (request, reply) => {
    const expected = app.config.paymentReaderSecret;
    if (expected === "") {
      return reply
        .code(403)
        .send({ ok: false, error: "Payment reader ingest is disabled", code: "reader_disabled" });
    }
    const authHeader = request.headers.authorization;
    const provided = typeof authHeader === "string" ? authHeader.replace(/^Bearer\s+/i, "") : "";
    if (provided === "" || !constantTimeEquals(provided, expected)) {
      return reply
        .code(401)
        .send({ ok: false, error: "Invalid reader secret", code: "invalid_reader_secret" });
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const sender = typeof body.sender === "string" && body.sender.length > 0 && body.sender.length <= MAX_SENDER_LEN
      ? body.sender
      : null;
    const provider =
      sender === null
        ? null
        : BKASH_SENDERS.has(sender)
          ? "bkash"
          : NAGAD_SENDERS.has(sender)
            ? "nagad"
            : null;
    const receivedAt =
      typeof body.receivedAt === "number" && Number.isInteger(body.receivedAt) && body.receivedAt > 0
        ? Math.floor(body.receivedAt / 1000)
        : Math.floor(Date.now() / 1000);
    const rawBody = typeof body.rawBody === "string" && body.rawBody.length > 0 ? body.rawBody : "";

    if (sender === null || provider === null) {
      return reply.code(400).send({
        ok: false,
        error: "Need { sender: known payment sender, rawBody } or { sender, trxId (10 alnum), amountBdt }",
        code: "invalid_payment",
      });
    }

    // --- AC4: fast path — both hints valid ⇒ zero AI calls, same ms as F8. --
    const trxIdHint = typeof body.trxId === "string" ? body.trxId : "";
    const amountHint =
      typeof body.amountBdt === "number" && Number.isFinite(body.amountBdt) && body.amountBdt > 0
        ? Math.round(body.amountBdt * 100)
        : null;
    const trxIdValid = trxIdHint !== "" && TXN_ID_PATTERN.test(trxIdHint);
    const amountValid = amountHint !== null && Number.isSafeInteger(amountHint);
    let txnId: string;
    let amountPaisa: number;
    let rowProvider: string = provider;
    let viaAi = false;

    if (trxIdValid && amountValid) {
      txnId = trxIdHint;
      amountPaisa = amountHint as number;
    } else if (rawBody !== "") {
      // --- AC5: extraction path (hints missing or invalid). ----------------
      // parsePaymentWithAi: Gemini when a key is configured, the server-side
      // regex fallback when it is not (never throws for a missing key).
      let extraction;
      try {
        extraction = await parsePaymentWithAi({ sender, rawBody }, app.config);
      } catch (err) {
        // Only a CONFIGURED AI call lands here — 503 so the reader retries.
        app.log.warn(
          { sender, reason: err instanceof Error ? err.message : String(err) },
          "AI payment extraction failed — reader will retry",
        );
        return reply
          .code(503)
          .send({ ok: false, error: "AI extraction unavailable", code: "ai_unavailable" });
      }

      if (!extraction.isPayment) {
        // Not a payment SMS at all (balance inquiry, spam, unrelated text).
        app.log.info({ sender, receivedAt }, "non-payment SMS discarded (extraction verdict)");
        return reply.code(200).send({
          ok: true,
          created: false,
          discarded: true,
          reason: "not_payment",
        });
      }
      if (!extraction.isLegitimate) {
        // AC7: counterfeit/fake SMS — warn and discard (200 so the reader's
        // queue drops it deliberately rather than retrying forever).
        app.log.warn({ sender, receivedAt }, "counterfeit/fake payment SMS discarded (extraction verdict)");
        return reply.code(200).send({
          ok: true,
          created: false,
          discarded: true,
          reason: "not_legitimate",
        });
      }
      if (extraction.trxId.length < 8 || extraction.amountBdt <= 0) {
        // Stage order: insert when isPayment && isLegitimate && trxId.length
        // >= 8 (+ a positive amount for payment_sms). Never fabricate money
        // data — discard loudly.
        app.log.warn(
          { sender, provider: extraction.provider || "unknown", hasTrxId: extraction.trxId !== "" },
          "extraction incomplete for a legitimate SMS — discarded",
        );
        return reply.code(200).send({
          ok: true,
          created: false,
          discarded: true,
          reason: "extraction_incomplete",
        });
      }
      // The AI may report a different service than the sender label (AC6:
      // rocket/upay/bank rows); the regex fallback cannot infer one, so the
      // sender-derived provider (bkash/nagad, already validated non-null)
      // fills the gap — payment_sms's CHECK never sees an empty string.
      rowProvider = extraction.provider !== "" ? extraction.provider : provider;
      txnId = extraction.trxId;
      amountPaisa = Math.round(extraction.amountBdt * 100);
      // viaAi means "the Gemini model was consulted" — the regex fallback
      // path (no key) is deterministic server-side parsing, not AI.
      viaAi = app.config.geminiApiKey !== "";
      app.log.info(
        {
          provider: rowProvider,
          counterpartyType: extraction.counterpartyType,
          hasSenderPhone: extraction.senderPhone !== null,
          confidence: extraction.confidence,
          viaAi,
        },
        "payment extraction succeeded",
      );
    } else {
      return reply.code(400).send({
        ok: false,
        error: "Need { sender, rawBody } (AI path) or { sender, trxId (10 alnum), amountBdt } (fast path)",
        code: "invalid_payment",
      });
    }

    // Same dedupe as the gateway path: INSERT OR IGNORE on UNIQUE txn_id, so
    // the reader's offline retry (or an AI re-extraction) is idempotent.
    const result = app.db
      .prepare(
        "INSERT OR IGNORE INTO payment_sms (id, device_id, sender, provider, txn_id, amount_paisa, received_at, created_at, source) " +
          "VALUES (?, NULL, ?, ?, ?, ?, ?, unixepoch(), 'reader')",
      )
      .run(newId(), sender, rowProvider, txnId, amountPaisa, receivedAt);

    // AC7: auto-match trigger — evaluate the shared rule NOW so the proposal
    // for this row is logged (and surfaced by the panel the moment it reads).
    const candidates = autoMatchCandidates(app.db, { txnId, amountPaisa, receivedAt });
    const proposedTransactionId = candidates.length === 1 ? candidates[0].id : null;
    app.log.info(
      {
        txnId,
        created: result.changes > 0,
        viaAi,
        candidates: candidates.length,
        proposedTransactionId,
      },
      "payment ingested — auto-match evaluated",
    );

    // Same envelope as the gateway route + the AC7 evaluation.
    return reply.code(result.changes > 0 ? 201 : 200).send({
      ok: true,
      created: result.changes > 0,
      txnId,
      autoMatch: { candidates: candidates.length, proposedTransactionId },
    });
  });
};

export default paymentRoutes;
