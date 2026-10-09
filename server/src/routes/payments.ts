/**
 * STAGE F8 (ISSUE-90) — Payment Reader ingest plane.
 *
 * The dedicated Payment Reader APK (payment-reader/) is a single-purpose app
 * on the money phone: it reads bKash/Nagad confirmation SMS and posts the
 * parsed fields here. It has no device enrollment, no OTP role, no FCM, no
 * heartbeat — one Bearer secret (PAYMENT_READER_SECRET) gates its one route.
 *
 * Feeds the SAME payment pipeline as the gateway ingest
 * (POST /v5/device/payment-sms):
 * - identical field validation (TXN_ID_PATTERN shared with the device route),
 * - identical dedupe — INSERT OR IGNORE on the UNIQUE txn_id, so the reader's
 *   offline retry queue can never double-count a payment,
 * - identical rows for the operator panel's auto-match/approve machinery,
 *   tagged `source = 'reader'` (gateway rows keep the DEFAULT 'gateway').
 *
 * rawBody rides along in the payload for spec parity but is NEVER stored or
 * logged — SMS body text must not reach the database (v4-era hard rule
 * carried into v5); the parsed fields are all the pipeline needs.
 */
import type { FastifyPluginAsync } from "fastify";
import { constantTimeEquals, newId } from "../services/crypto.js";
import { TXN_ID_PATTERN } from "./device.js";

/**
 * Sender labels accepted from the reader. The reader is configured with the
 * same carrier-normalised variants the gateway parser recognises (different
 * handsets/carriers render the sender differently), so provider derivation
 * here matches the gateway's classification exactly.
 */
const BKASH_SENDERS = new Set(["bKash", "BKASH", "16247"]);
const NAGAD_SENDERS = new Set(["Nagad", "NAGAD", "16167"]);

/** Cap on the sender label (matches the gateway route's bound). */
const MAX_SENDER_LEN = 32;

const paymentRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Payment Reader upload (STAGE F8): `POST /v5/payments/ingest`.
   *
   * Auth: `Authorization: Bearer <PAYMENT_READER_SECRET>`, constant-time
   * compare even when the header is missing (ISSUE-11 timing parity).
   * Fail-closed: unset secret → 403 reader_disabled (a deployment with no
   * reader configured exposes nothing), bad secret → 401.
   *
   * Payload: `{ sender, amountBdt, trxId, receivedAt, rawBody? }` —
   * receivedAt is epoch milliseconds (same contract as the device route).
   * Response mirrors the gateway route: 201 created / 200 idempotent-repeat.
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
    const trxId = typeof body.trxId === "string" ? body.trxId : null;
    const amountBdt =
      typeof body.amountBdt === "number" && Number.isFinite(body.amountBdt) && body.amountBdt >= 0
        ? body.amountBdt
        : null;
    const receivedAt =
      typeof body.receivedAt === "number" && Number.isInteger(body.receivedAt) && body.receivedAt > 0
        ? Math.floor(body.receivedAt / 1000)
        : Math.floor(Date.now() / 1000);

    if (sender === null || provider === null || trxId === null || !TXN_ID_PATTERN.test(trxId) || amountBdt === null) {
      return reply.code(400).send({
        ok: false,
        error: "Need { sender, amountBdt (number >= 0), trxId (10 alnum), receivedAt (epoch ms) }",
        code: "invalid_payment",
      });
    }

    const amountPaisa = Math.round(amountBdt * 100);
    if (!Number.isSafeInteger(amountPaisa)) {
      return reply.code(400).send({
        ok: false,
        error: "amountBdt is out of range",
        code: "invalid_payment",
      });
    }

    // rawBody is accepted for payload parity and then discarded — never
    // inspected, never logged, never stored (see file header).
    const result = app.db
      .prepare(
        "INSERT OR IGNORE INTO payment_sms (id, device_id, sender, provider, txn_id, amount_paisa, received_at, created_at, source) " +
          "VALUES (?, NULL, ?, ?, ?, ?, ?, unixepoch(), 'reader')",
      )
      .run(newId(), sender, provider, trxId, amountPaisa, receivedAt);

    // Same envelope as the gateway route: a duplicate TrxID (reader retry)
    // is reported, not double-counted.
    return reply.code(result.changes > 0 ? 201 : 200).send({
      ok: true,
      created: result.changes > 0,
      txnId: trxId,
    });
  });
};

export default paymentRoutes;
