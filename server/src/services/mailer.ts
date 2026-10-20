/**
 * STAGE F3 amendment (ISSUE-82): outbound email via operator-configured SMTP.
 *
 * The SMTP config lives in the `mail_config` DB row (owner decision — never
 * env vars). The password is AES-256-GCM encrypted at rest with a key derived
 * from the server secret (JWT_SECRET) and is decrypted ONLY at send time
 * inside this module — no route ever returns it (GET masks it).
 *
 * Every send re-reads the config, so an operator changing settings in the
 * panel takes effect on the next email without a restart. When no config
 * exists, `isMailConfigured()` is false and every caller must disable its
 * feature cleanly (ordered amendment behavior) instead of throwing.
 *
 * Privacy: success/failure is logged WITHOUT recipient addresses or password
 * material (PII + secret policy); only the purpose and outcome are logged.
 *
 * STAGE F11 (ISSUE-123) — transport selection: Render blocks all outbound
 * SMTP (every relay ETIMEDOUTs at CONN from Render while the same connections
 * succeed elsewhere), so when the configured host is `api.brevo.com` the
 * mailer sends through Brevo's HTTP API instead. In that mode the stored
 * password field carries the xkeysib API key (no schema change — ordered).
 * Every other host keeps the SMTP transport below, unchanged.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import nodemailer from "nodemailer";

/** Singleton row id (mail_config has exactly one row). */
const CONFIG_ROW_ID = 1;
/** Ciphertext format tag — bump if the envelope ever changes. */
const ENC_PREFIX = "v1:";
/** Nodemailer defaults are 30s; a dead SMTP host must fail the operator's test button fast. */
const SMTP_TIMEOUTS_MS = { connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000 };
/** STAGE F11: this configured host selects Brevo's HTTP API instead of SMTP. */
const BREVO_HTTP_HOST = "api.brevo.com";
/** Brevo transactional-mail endpoint (SMTP-over-HTTP, docs: POST /v3/smtp/email). */
const BREVO_HTTP_ENDPOINT = "https://api.brevo.com/v3/smtp/email";
/** HTTP sends must fail as fast as the SMTP connection timeouts above. */
const BREVO_HTTP_TIMEOUT_MS = 10_000;
/** Cap on the response body echoed into an error — enough to debug, no payload dumping. */
const BREVO_ERROR_EXCERPT_CHARS = 300;

export interface MailConfigRow {
  host: string;
  port: number;
  username: string;
  /** Decrypted ONLY inside sendMail; never returned by any route. */
  password: string;
  fromAddress: string;
}

/** Public projection of the config — deliberately password-free (route masks it). */
export interface MailConfigView {
  configured: boolean;
  host: string | null;
  port: number | null;
  fromAddress: string | null;
  /** Always the literal mask when configured; null when not. */
  passwordMasked: string | null;
  updatedAt: number | null;
}

/** Derives the AES-256 key from the server secret (no new env vars — ordered). */
function deriveKey(serverSecret: string): Buffer {
  // Fixed salt is a policy constant here: the secret itself is high-entropy,
  // so the derivation does not need per-row salting to resist brute force.
  return scryptSync(serverSecret, "dprelay-mail-config-v1", 32);
}

/** Encrypts the SMTP password for storage (AES-256-GCM, random IV per write). */
export function encryptMailSecret(plain: string, serverSecret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(serverSecret), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString("base64url")}:${tag.toString("base64url")}:${ct.toString("base64url")}`;
}

/** Decrypts a stored SMTP password. Throws on tamper/mismatch (GCM auth). */
export function decryptMailSecret(stored: string, serverSecret: string): string {
  if (!stored.startsWith(ENC_PREFIX)) throw new Error("unsupported mail secret format");
  const [ivB64, tagB64, ctB64] = stored.slice(ENC_PREFIX.length).split(":");
  if (!ivB64 || !tagB64 || !ctB64) throw new Error("malformed mail secret");
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(serverSecret), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64url")), decipher.final()]).toString("utf8");
}

/** SHA-256 hex of an emailed token — raw value never persisted (sessions parity). */
export function hashEmailToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** Generates a raw email token (32 random bytes, URL-safe). Returned once, emailed. */
export function generateEmailToken(): string {
  return randomBytes(32).toString("base64url");
}

type Db = import("better-sqlite3").Database;

/** True when the operator has saved SMTP settings — the feature gate for all email. */
export function isMailConfigured(db: Db): boolean {
  const row = db.prepare("SELECT COUNT(*) AS n FROM mail_config").get() as { n: number };
  return row.n > 0;
}

/** Public masked view for GET /v5/admin/mail-config (no username, no password). */
export function getMailConfigView(db: Db): MailConfigView {
  const row = db
    .prepare("SELECT host, port, from_address, updated_at FROM mail_config WHERE id = ?")
    .get(CONFIG_ROW_ID) as { host: string; port: number; from_address: string; updated_at: number } | undefined;
  if (!row) {
    return { configured: false, host: null, port: null, fromAddress: null, passwordMasked: null, updatedAt: null };
  }
  return {
    configured: true,
    host: row.host,
    port: row.port,
    fromAddress: row.from_address,
    passwordMasked: "••••",
    updatedAt: row.updated_at,
  };
}

/** Full config (decrypted) for send time only. Null when unconfigured. */
function loadMailConfigForSend(db: Db, serverSecret: string): MailConfigRow | null {
  const row = db
    .prepare("SELECT host, port, username, password_encrypted, from_address FROM mail_config WHERE id = ?")
    .get(CONFIG_ROW_ID) as
    | { host: string; port: number; username: string; password_encrypted: string; from_address: string }
    | undefined;
  if (!row) return null;
  return {
    host: row.host,
    port: row.port,
    username: row.username,
    password: decryptMailSecret(row.password_encrypted, serverSecret),
    fromAddress: row.from_address,
  };
}

/**
 * STAGE F11: one send through Brevo's HTTP API (selected when the configured
 * host is `api.brevo.com`). The stored password is the xkeysib API key here.
 *
 * @param config decrypted mail config (loadMailConfigForSend).
 * @param to recipient address.
 * @param subject message subject.
 * @param text plain-text body (`textContent` — Brevo sends it as text/plain).
 * @throws Error carrying the HTTP status and a response-body excerpt on a
 *         non-2xx, so the existing catch/log surface keeps the detail without
 *         callers needing to know which transport ran.
 */
async function sendBrevoHttp(config: MailConfigRow, to: string, subject: string, text: string): Promise<void> {
  const res = await fetch(BREVO_HTTP_ENDPOINT, {
    method: "POST",
    headers: {
      "api-key": config.password,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sender: { email: config.fromAddress },
      to: [{ email: to }],
      subject,
      textContent: text,
    }),
    signal: AbortSignal.timeout(BREVO_HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    // Body read for the error only — the log keeps it, the caller only maps it.
    const body = await res.text().catch(() => "");
    throw new Error(`brevo_http_send_failed: ${res.status} ${res.statusText} ${body.slice(0, BREVO_ERROR_EXCERPT_CHARS)}`);
  }
}

/**
 * Sends one email through the operator-configured transport (SMTP relay, or
 * Brevo's HTTP API when the host is `api.brevo.com` — STAGE F11).
 * @throws when unconfigured (mail_not_configured) or the transport fails —
 *         callers map both to structured envelopes.
 */
export async function sendMail(
  db: Db,
  serverSecret: string,
  to: string,
  subject: string,
  text: string,
): Promise<void> {
  const config = loadMailConfigForSend(db, serverSecret);
  if (config === null) {
    throw new Error("mail_not_configured");
  }
  // STAGE F11: the configured host selects the transport. `transport.close()`
  // is meaningless in HTTP mode, so the two paths stay separate.
  if (config.host === BREVO_HTTP_HOST) {
    await sendBrevoHttp(config, to, subject, text);
    return;
  }
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465, // implicit TLS on 465 (the owner's stackmail setup); STARTTLS otherwise
    auth: { user: config.username, pass: config.password },
    ...SMTP_TIMEOUTS_MS,
  });
  try {
    await transport.sendMail({ from: config.fromAddress, to, subject, text });
  } finally {
    transport.close();
  }
}

/** Verification link lands on the SPA, which calls POST /v5/auth/verify-email. */
export function verificationEmailBody(dashboardBaseUrl: string, rawToken: string): string {
  const link = `${dashboardBaseUrl}/#/verify/${encodeURIComponent(rawToken)}`;
  return [
    "Confirm your email for dP Relay.",
    "",
    "Open this link to verify your address:",
    link,
    "",
    "If you did not create this account, you can ignore this message.",
  ].join("\n");
}

/** Reset link lands on the SPA, which calls POST /v5/auth/password/reset. */
export function resetEmailBody(dashboardBaseUrl: string, rawToken: string): string {
  const link = `${dashboardBaseUrl}/#/reset/${encodeURIComponent(rawToken)}`;
  return [
    "Reset your dP Relay password.",
    "",
    "Open this link to choose a new password (valid once, briefly):",
    link,
    "",
    "If you did not request this, you can ignore this message — nothing changes until the link is used.",
  ].join("\n");
}
