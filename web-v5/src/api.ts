/**
 * dP Relay v5 API client — web-v5's single trust boundary.
 *
 * Auth model (server contract, server/src/middleware.ts `requireApp`):
 * the app plane authenticates with `X-App-Id` + `X-App-Secret` headers —
 * this is the QUEUE AMENDMENT #2 "login = appId + appSecret" surface: no new
 * server auth route exists or is needed. Credentials live ONLY in
 * sessionStorage (gone when the tab closes; never persisted to disk, never
 * part of the bundle).
 *
 * Every response is the server's `{ ok, error, code }` envelope; !ok maps to
 * a thrown ApiError carrying the server's `code` so screens can react to the
 * exact failure (`insufficient_credits`, `payment_destination_unconfigured`,
 * `trx_id_exists`, …).
 */

/** Build-time base URL; empty = same origin (server contract: relative fetch). */
export const API_BASE: string = import.meta.env.VITE_API_BASE ?? "";

const APP_ID_KEY = "webv5.appId";
const APP_SECRET_KEY = "webv5.appSecret";

/** Error carrying the server's envelope code (or a client-side pseudo-code). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

// ── App credentials (the "login": appId + appSecret, sessionStorage) ───────

export interface AppCredentials {
  appId: string;
  appSecret: string;
}

export function getConnectedApp(): AppCredentials | null {
  const appId = sessionStorage.getItem(APP_ID_KEY);
  const appSecret = sessionStorage.getItem(APP_SECRET_KEY);
  if (appId === null || appSecret === null) return null;
  return { appId, appSecret };
}

export function connectApp(appId: string, appSecret: string): void {
  sessionStorage.setItem(APP_ID_KEY, appId);
  sessionStorage.setItem(APP_SECRET_KEY, appSecret);
}

export function disconnectApp(): void {
  sessionStorage.removeItem(APP_ID_KEY);
  sessionStorage.removeItem(APP_SECRET_KEY);
}

/** Registered once by App; drops back to the sign-in screen on a 401. */
let onAppUnauthorized: (() => void) | null = null;

export function setAppUnauthorizedHandler(handler: (() => void) | null): void {
  onAppUnauthorized = handler;
}

// ── Raw request plumbing ───────────────────────────────────────────────────

interface Envelope {
  ok?: boolean;
  error?: string;
  code?: string;
}

/**
 * Raw JSON request. Throws ApiError on non-2xx or `ok: false` envelopes.
 * Content-Type is set ONLY when a body exists: a bodyless POST declaring
 * application/json trips Fastify's empty-JSON-body rejection (400) — same
 * rule the v4 client learned the hard way.
 */
export async function request<T>(path: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      // STAGE F3: the customer session is an HttpOnly cookie set by
      // /v5/auth/*; credentialed fetch is what sends it cross-origin (the
      // API answers with Access-Control-Allow-Credentials for allow-listed
      // origins only). Harmless for the header-based planes.
      credentials: "include",
      headers: {
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new ApiError(0, "network_error", "Network error — the API is unreachable");
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON error bodies (proxy/5xx pages) still surface as ApiError.
  }
  const envelope = (body ?? {}) as Envelope;
  if (!res.ok || envelope.ok === false) {
    throw new ApiError(
      res.status,
      envelope.code ?? `http_${res.status}`,
      envelope.error ?? `HTTP ${res.status}`,
    );
  }
  return body as T;
}

/**
 * App-plane request: X-App-Id/X-App-Secret. A 401 (unknown app, wrong
 * secret, revoked app) drops the stored credentials so the shell re-prompts.
 */
export async function appFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const creds = getConnectedApp();
  if (creds === null) {
    throw new ApiError(401, "app_not_connected", "Sign in with your app credentials first");
  }
  try {
    return await request<T>(path, {
      ...init,
      headers: {
        "X-App-Id": creds.appId,
        "X-App-Secret": creds.appSecret,
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      disconnectApp();
      onAppUnauthorized?.();
    }
    throw err;
  }
}

// ── Typed endpoints (F1 customer screens) ──────────────────────────────────

export interface Credits {
  otpSmsRemaining: number;
  bulkSmsRemaining: number;
  otpExpiresAt: number | null;
  bulkExpiresAt: number | null;
  lastTransactionId: string | null;
  purchasedAt: number | null;
}

export interface CreditPackage {
  packageCode: string;
  name: string;
  smsQuota: number;
  priceBdt: number;
  validityDays: number;
  type: string;
  /** ISSUE-89: price currency (BDT | USD | EUR) — priceBdt is in this unit. */
  currency: string;
}

export interface CreditRequestAccepted {
  transactionId: string;
  bkashNumber: string;
  bkashNote: string;
  amountBdt: number;
}

export interface Transaction {
  transactionId: string;
  packageCode: string;
  smsQuota: number;
  validityDays: number;
  amountBdt: number;
  packageType: string;
  /** ISSUE-89: amountBdt is in this unit — render with formatPrice, never bare ৳. */
  currency: string;
  trxId: string | null;
  status: string;
  adminNotes: string | null;
  requestedAt: number;
  resolvedAt: number | null;
}

/** GET /v5/billing/credits — both buckets + expiry. */
export async function getCredits(): Promise<Credits> {
  const body = await appFetch<{ ok: true; credits: Credits }>("/v5/billing/credits");
  return body.credits;
}

/**
 * GET /v5/billing/packages — public catalog of active packages (the route is
 * unauthenticated server-side; STAGE F9 moves the buy flow off the app
 * plane, so this must also work without connected app credentials).
 */
export async function listPackages(): Promise<CreditPackage[]> {
  const body = await request<{ ok: true; packages: CreditPackage[] }>("/v5/billing/packages", {
    method: "GET",
  });
  return body.packages;
}

/** POST /v5/billing/credits/request — opens a pending transaction + returns the bKash destination. */
export async function requestCredits(packageCode: string): Promise<CreditRequestAccepted> {
  return appFetch<CreditRequestAccepted & { ok: true }>("/v5/billing/credits/request", {
    method: "POST",
    body: JSON.stringify({ packageCode }),
  });
}

/** POST /v5/billing/credits/submit-trx — attaches the bKash TrxID (same TrxID is an idempotent no-op). */
export async function submitTrx(transactionId: string, trxId: string): Promise<string> {
  const body = await appFetch<{ ok: true; message: string }>("/v5/billing/credits/submit-trx", {
    method: "POST",
    body: JSON.stringify({ transactionId, trxId }),
  });
  return body.message;
}

/** GET /v5/billing/transactions — keyset-paged history, optional status filter. */
export async function listTransactions(opts: {
  status?: "pending" | "approved" | "rejected";
  limit?: number;
  cursor?: string;
}): Promise<{ transactions: Transaction[]; nextCursor: string | null }> {
  const params = new URLSearchParams();
  if (opts.status !== undefined) params.set("status", opts.status);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.cursor !== undefined) params.set("cursor", opts.cursor);
  const qs = params.toString();
  const body = await appFetch<{
    ok: true;
    transactions: Transaction[];
    nextCursor: string | null;
  }>(`/v5/billing/transactions${qs ? `?${qs}` : ""}`);
  return { transactions: body.transactions, nextCursor: body.nextCursor };
}

/** Maps any thrown error to a user-presentable one-liner including the code. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    return err.code === "network_error" ? err.message : `${err.message} (${err.code})`;
  }
  return "Unexpected error — see the browser console";
}

// ── Customer auth (STAGE F3: /v5/auth/*, HttpOnly session cookie) ─────────
//
// The session cookie is HttpOnly — JS never sees it, so "am I signed in?" is
// answered by GET /v5/auth/me, not by reading storage. App credentials remain
// a separate, per-app plane (X-App-Id/X-App-Secret above): owning an app in
// the dashboard does not leak its secret back out of the server.

export interface SessionUser {
  id: string;
  email: string;
  createdAt: number | null;
  /** Soft verification (F3 amendment): null = unverified; login never gated on it. */
  emailVerifiedAt?: number | null;
}

export interface OwnedApp {
  appId: string;
  name: string;
  revoked: boolean;
  createdAt: number;
}

export interface SelfServeApp {
  appId: string;
  appSecret: string;
  /** STAGE F7 (ISSUE-87): per-app device enrollment secret — same one-time contract as appSecret. */
  deviceEnrollmentSecret: string;
  name: string;
  trial: { otpSms: number; bulkSms: number; expiresAt: number } | null;
}

/** POST /v5/auth/register — creates the account and opens a session (cookie). */
export async function registerAccount(email: string, password: string): Promise<void> {
  await request<{
    ok: true;
  }>("/v5/auth/register", { method: "POST", body: JSON.stringify({ email, password }) });
}

/** POST /v5/auth/login — opens a session (cookie). Tokens in the response are ignored here. */
export async function loginAccount(email: string, password: string): Promise<void> {
  await request<{
    ok: true;
    accessToken: string;
    refreshToken: string;
  }>("/v5/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
}

/** POST /v5/auth/logout — deletes the session server-side; idempotent. */
export async function logoutAccount(): Promise<void> {
  await request<{ ok: true }>("/v5/auth/logout", { method: "POST" });
}

/**
 * GET /v5/auth/me — the signed-in user, or null when there is no live
 * session (401 auth_required is the normal signed-out answer, not an error).
 */
export async function getCurrentUser(): Promise<SessionUser | null> {
  try {
    const body = await request<{ ok: true; user: SessionUser }>("/v5/auth/me", { method: "GET" });
    return body.user;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

/** GET /v5/auth/apps — owned apps; secrets are never re-served by the server. */
export async function listOwnedApps(): Promise<OwnedApp[]> {
  const body = await request<{ ok: true; apps: OwnedApp[] }>("/v5/auth/apps", { method: "GET" });
  return body.apps;
}

/**
 * POST /v5/auth/apps — self-serve registration. The response is the ONLY
 * place appSecret ever appears: persist it now or unlock via link later.
 */
export async function createSelfServeApp(name?: string): Promise<SelfServeApp> {
  return request<SelfServeApp & { ok: true }>("/v5/auth/apps", {
    method: "POST",
    body: JSON.stringify(name !== undefined ? { name } : {}),
  });
}

/** POST /v5/auth/apps/link — claims/proves an app by its credentials once. */
export async function linkOwnedApp(
  appId: string,
  appSecret: string,
): Promise<{ appId: string; name: string; revoked: boolean }> {
  return request<{ ok: true; appId: string; name: string; revoked: boolean }>("/v5/auth/apps/link", {
    method: "POST",
    body: JSON.stringify({ appId, appSecret }),
  });
}

// ── Tenancy + wallet (STAGE F9, ISSUE-88) ────────────────────────────────
//
// User -> many Companies (each 1:1 with one app + its F7 gateway number) and
// a USER-level credit wallet: every company app draws from one balance.
// These routes are session-cookie plane — no app credentials involved.

export interface Company {
  id: string;
  name: string;
  disabled: boolean;
  createdAt: number;
  /** F7 gateway number bound to the company's app; null = none bound yet. */
  gatewayNumber: string | null;
  app: { appId: string; name: string; revoked: boolean };
}

export interface CompanyCreated {
  company: { id: string; name: string; disabled: boolean; createdAt: number };
  /** Shown EXACTLY once — the server keeps only digests. */
  app: { appId: string; appSecret: string; deviceEnrollmentSecret: string; name: string };
  trial: { otpSms: number; bulkSms: number; expiresAt: number } | null;
}

export interface Wallet {
  otpSmsRemaining: number;
  bulkSmsRemaining: number;
  otpExpiresAt: number | null;
  bulkExpiresAt: number | null;
  lastTransactionId: string | null;
  purchasedAt: number | null;
}

export interface WalletTransaction {
  transactionId: string;
  packageCode: string;
  smsQuota: number;
  amountBdt: number;
  packageType: string;
  /** ISSUE-89: the price unit (BDT | USD | EUR). */
  currency: string;
  status: string;
  trxId: string | null;
  requestedAt: number;
  resolvedAt: number | null;
}

/** GET /v5/auth/companies — the user's companies, each with its app summary + gateway number. */
export async function listCompanies(): Promise<Company[]> {
  const body = await request<{ ok: true; companies: Company[] }>("/v5/auth/companies", {
    method: "GET",
  });
  return body.companies;
}

/**
 * POST /v5/auth/companies — creates a company + its one app. The response is
 * the ONLY place the secrets appear; the trial (first company only) lands in
 * the user wallet.
 */
export async function createCompany(name: string): Promise<CompanyCreated> {
  return request<CompanyCreated & { ok: true }>("/v5/auth/companies", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

/** PATCH /v5/auth/companies/:id — renames a company the user owns. */
export async function renameCompany(companyId: string, name: string): Promise<void> {
  await request<{ ok: true }>(`/v5/auth/companies/${encodeURIComponent(companyId)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

/** POST /v5/auth/companies/:id/disable — withholds the company: its app stops sending. */
export async function disableCompany(companyId: string): Promise<void> {
  await request<{ ok: true }>(`/v5/auth/companies/${encodeURIComponent(companyId)}/disable`, {
    method: "POST",
  });
}

/** GET /v5/auth/wallet — the wallet balance every company app draws from. */
export async function getWallet(): Promise<Wallet> {
  const body = await request<{ ok: true; wallet: Wallet }>("/v5/auth/wallet", { method: "GET" });
  return body.wallet;
}

/** GET /v5/auth/wallet/transactions — wallet purchase history across all companies. */
export async function getWalletTransactions(): Promise<WalletTransaction[]> {
  const body = await request<{ ok: true; transactions: WalletTransaction[] }>(
    "/v5/auth/wallet/transactions",
    { method: "GET" },
  );
  return body.transactions;
}

/**
 * POST /v5/billing/credits/request (SESSION plane, F9): opens a pending
 * WALLET purchase — no app credentials involved; approval tops up the user
 * wallet that every company app draws from.
 */
export async function requestWalletCredits(packageCode: string): Promise<CreditRequestAccepted> {
  return request<CreditRequestAccepted & { ok: true }>("/v5/billing/credits/request", {
    method: "POST",
    body: JSON.stringify({ packageCode }),
  });
}

/** POST /v5/billing/credits/submit-trx (SESSION plane, F9): attaches the bKash TrxID to a wallet purchase. */
export async function submitWalletTrx(transactionId: string, trxId: string): Promise<string> {
  const body = await request<{ ok: true; message: string }>("/v5/billing/credits/submit-trx", {
    method: "POST",
    body: JSON.stringify({ transactionId, trxId }),
  });
  return body.message;
}

// ── Email features (F3 amendment: verification + self-service reset) ───────

/** GET /v5/auth/mail-status — public: is SMTP configured on this deployment. */
export async function getMailStatus(): Promise<boolean> {
  const body = await request<{ ok: true; configured: boolean }>("/v5/auth/mail-status", { method: "GET" });
  return body.configured;
}

/** POST /v5/auth/verify-email — consumes the emailed token (idempotent once verified). */
export async function verifyEmail(token: string): Promise<void> {
  await request<{ ok: true }>("/v5/auth/verify-email", { method: "POST", body: JSON.stringify({ token }) });
}

/** POST /v5/auth/verify-email/resend — session-required; server answers ok regardless. */
export async function resendVerification(): Promise<void> {
  await request<{ ok: true }>("/v5/auth/verify-email/resend", { method: "POST" });
}

/** POST /v5/auth/password/forgot — always generic-ok server-side (anti-enumeration). */
export async function forgotPassword(email: string): Promise<void> {
  await request<{ ok: true }>("/v5/auth/password/forgot", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

/** POST /v5/auth/password/reset — token + new password; revokes every session. */
export async function resetPassword(token: string, password: string): Promise<void> {
  await request<{ ok: true }>("/v5/auth/password/reset", {
    method: "POST",
    body: JSON.stringify({ token, password }),
  });
}

// ── Operator plane (server requireOperator routes — Stage F2) ──────────────
//
// `Authorization: Bearer <OPERATOR_SECRET>` — a third credential plane,
// entered per session (sessionStorage, never bundled) and VERIFIED against
// GET /v5/admin/metrics before being stored. A 401 from any operator call
// clears it so the unlock form re-prompts; customer credentials are untouched.

const OPERATOR_KEY = "webv5.operatorSecret";

export function getOperatorSecret(): string | null {
  return sessionStorage.getItem(OPERATOR_KEY);
}

export function setOperatorSecret(secret: string): void {
  sessionStorage.setItem(OPERATOR_KEY, secret);
}

export function clearOperatorSecret(): void {
  sessionStorage.removeItem(OPERATOR_KEY);
}

/** Registered once by the operator shell; returns to the unlock form on 401. */
let onOperatorRejected: (() => void) | null = null;

export function setOperatorRejectedHandler(handler: (() => void) | null): void {
  onOperatorRejected = handler;
}

export async function operatorFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const secret = getOperatorSecret();
  if (secret === null) {
    throw new ApiError(401, "operator_not_configured", "Enter the operator secret first");
  }
  try {
    return await request<T>(path, {
      ...init,
      headers: { Authorization: `Bearer ${secret}`, ...(init.headers ?? {}) },
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      clearOperatorSecret();
      onOperatorRejected?.();
    }
    throw err;
  }
}

export interface AdminMetrics {
  generatedAt: number;
  apps: { total: number; revoked: number };
  users: { total: number; devices: number };
  otp: {
    sessionsTotal: number;
    sessionsPending: number;
    sessionsVerified: number;
    sessionsLast24h: number;
  };
  bulk: {
    campaignsTotal: number;
    campaignsActive: number;
    recipientsSent: number;
    recipientsFailed: number;
    recipientsQueued: number;
  };
  billing: {
    transactionsPending: number;
    transactionsApproved: number;
    transactionsRejected: number;
    creditsRows: number;
  };
  webhooks: { deliveriesLast24h: number; deliveredLast24h: number; failedLast24h: number };
}

export interface PendingTransaction {
  transactionId: string;
  appId: string;
  packageCode: string;
  smsQuota: number;
  amountBdt: number;
  packageType: string;
  /** ISSUE-89: USD/EUR pendings are approved manually — show their unit. */
  currency: string;
  trxId: string | null;
  requestedAt: number;
}

export interface AdminApp {
  id: string;
  appId: string;
  name: string;
  webhookUrl: string | null;
  rateMaxPerPhone: number;
  rateWindowSec: number;
  createdAt: number;
  revokedAt: number | null;
}

export interface OversightCampaign {
  campaignId: string;
  appId: string;
  name: string;
  status: string;
  totalRecipients: number;
  sentCount: number;
  failedCount: number;
  queuedCount: number;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

/** GET /v5/admin/metrics — also the pre-storage probe that verifies a pasted secret. */
export async function getAdminMetrics(): Promise<AdminMetrics> {
  return operatorFetch<AdminMetrics & { ok: true }>("/v5/admin/metrics");
}

// ── STAGE F7 (ISSUE-87): device phone identity + app binding ──

/** One row of GET /v5/admin/devices — staleness is resolved server-side. */
export interface AdminDeviceItem {
  id: string;
  label: string;
  userId: string | null;
  createdAt: number;
  lastSeenAt: number | null;
  /** null = never heartbeaten; age is then measured from createdAt. */
  secondsSinceSeen: number;
  neverSeen: boolean;
  stale: boolean;
  revocable: boolean;
  revokedAt: number | null;
  quarantined: boolean;
  quarantinedAt: number | null;
  /** STAGE F7: E.164 gateway number, null until a device reports one. */
  phoneNumber: string | null;
  /** STAGE F7: public appId of the bound app; null = operator-fleet device. */
  boundAppId: string | null;
  boundAppName: string | null;
}

export interface AdminDeviceList {
  staleThresholdSec: number;
  total: number;
  staleCount: number;
  neverSeenCount: number;
  quarantinedCount: number;
  devices: AdminDeviceItem[];
}

/** GET /v5/admin/devices — fleet listing with the F7 identity columns. */
export async function listAdminDevices(): Promise<AdminDeviceList> {
  const body = await operatorFetch<AdminDeviceList & { ok: true }>("/v5/admin/devices");
  return {
    staleThresholdSec: body.staleThresholdSec,
    total: body.total,
    staleCount: body.staleCount,
    neverSeenCount: body.neverSeenCount,
    quarantinedCount: body.quarantinedCount,
    devices: body.devices,
  };
}

/** POST /v5/admin/devices/:id/bind — bind a device to exactly one app, or `{ appId: null }` to unbind (fleet). */
export async function bindAdminDevice(
  deviceId: string,
  appId: string | null,
): Promise<{ deviceId: string; boundAppId: string | null }> {
  return operatorFetch<{ ok: true; deviceId: string; boundAppId: string | null }>(
    `/v5/admin/devices/${encodeURIComponent(deviceId)}/bind`,
    { method: "POST", body: JSON.stringify({ appId }) },
  );
}

// ── Mail settings (F3 amendment: operator-configured SMTP, write-only password) ──

export interface MailConfigView {
  configured: boolean;
  host: string | null;
  port: number | null;
  fromAddress: string | null;
  passwordMasked: string | null;
  updatedAt: number | null;
}

/** GET /v5/admin/mail-config — masked; the password is never returned. */
export async function getMailConfig(): Promise<MailConfigView> {
  const body = await operatorFetch<MailConfigView & { ok: true }>("/v5/admin/mail-config");
  return { configured: body.configured, host: body.host, port: body.port, fromAddress: body.fromAddress, passwordMasked: body.passwordMasked, updatedAt: body.updatedAt };
}

/** PUT /v5/admin/mail-config — password optional (empty = keep the stored one, write-only). */
export async function updateMailConfig(cfg: {
  host: string;
  port: number;
  username: string;
  password?: string;
  fromAddress: string;
}): Promise<MailConfigView> {
  const body = await operatorFetch<MailConfigView & { ok: true }>("/v5/admin/mail-config", {
    method: "PUT",
    body: JSON.stringify(cfg),
  });
  return { configured: body.configured, host: body.host, port: body.port, fromAddress: body.fromAddress, passwordMasked: body.passwordMasked, updatedAt: body.updatedAt };
}

/** POST /v5/admin/mail-config/test — sends one real test email to `to`. */
export async function testMailConfig(to: string): Promise<void> {
  await operatorFetch<{ ok: true }>("/v5/admin/mail-config/test", {
    method: "POST",
    body: JSON.stringify({ to }),
  });
}

/** GET /v5/admin/billing/queue — pending TrxID approvals. */
export async function listPendingTransactions(): Promise<PendingTransaction[]> {
  const body = await operatorFetch<{ ok: true; pending: PendingTransaction[] }>(
    "/v5/admin/billing/queue",
  );
  return body.pending;
}

/**
 * POST /v5/admin/billing/approve — approve:false is the reject path
 * (rejectReason travels with it). ISSUE-89: `notes` is the optional
 * remittance-reference paper trail stored on the pending row in the SAME
 * transaction as the award (required reading for manual USD/EUR approvals).
 * Undefined fields are omitted from the body, never sent as null.
 */
export async function resolveTransaction(
  transactionId: string,
  approve: boolean,
  rejectReason?: string,
  notes?: string,
): Promise<{ status: string; newOtpBalance?: number; newBulkBalance?: number }> {
  return operatorFetch<{ ok: true; status: string; newOtpBalance?: number; newBulkBalance?: number }>(
    "/v5/admin/billing/approve",
    {
      method: "POST",
      body: JSON.stringify({
        transactionId,
        approve,
        ...(rejectReason !== undefined ? { rejectReason } : {}),
        ...(notes !== undefined && notes !== "" ? { notes } : {}),
      }),
    },
  );
}

/** GET /v5/admin/apps — cursor-paged registry. */
export async function listAdminApps(): Promise<{ apps: AdminApp[]; nextCursor: string | null }> {
  return operatorFetch<{ ok: true; apps: AdminApp[]; nextCursor: string | null }>("/v5/admin/apps");
}

/** POST /v5/admin/apps/:id/revoke — requireApp then answers 401 app_revoked. */
export async function revokeAdminApp(id: string): Promise<void> {
  await operatorFetch(`/v5/admin/apps/${encodeURIComponent(id)}/revoke`, { method: "POST" });
}

/** POST /v5/admin/apps/:id/unrevoke — restores app-plane access immediately. */
export async function unrevokeAdminApp(id: string): Promise<void> {
  await operatorFetch(`/v5/admin/apps/${encodeURIComponent(id)}/unrevoke`, { method: "POST" });
}

/** GET /v5/admin/campaigns — cross-app campaign oversight, optional status filter. */
export async function listOversightCampaigns(status?: string): Promise<{
  campaigns: OversightCampaign[];
  nextCursor: string | null;
}> {
  const qs = status !== undefined && status !== "all" ? `?status=${encodeURIComponent(status)}` : "";
  const body = await operatorFetch<{
    ok: true;
    campaigns: OversightCampaign[];
    nextCursor: string | null;
  }>(`/v5/admin/campaigns${qs}`);
  return { campaigns: body.campaigns, nextCursor: body.nextCursor };
}

// ── STAGE F5 (ISSUE-83) → F5b (ISSUE-84 spec): admin operations ───────────

/** Tunable payment-match parameters (server: admin_config rows, migration 014). */
export interface MatchConfig {
  windowMin: number;
  windowSec: number;
  toleranceBdt: number;
  updatedAt?: number;
}

/** The two whitelisted config keys (server: routes/admin-config.ts). */
export type AdminConfigKey = "payment_match_window_min" | "payment_match_tolerance_bdt";

export interface AdminConfigValue {
  key: string;
  value: number;
  updatedAt: number | null;
}

/** GET /v5/admin/config/:key — whitelist enforced server-side (404 otherwise). */
export async function getAdminConfig(key: AdminConfigKey): Promise<AdminConfigValue> {
  return operatorFetch<AdminConfigValue & { ok: true }>(`/v5/admin/config/${key}`);
}

/** PUT /v5/admin/config/:key — body { value } (per-key integer bounds server-side). */
export async function putAdminConfig(key: AdminConfigKey, value: number): Promise<AdminConfigValue> {
  return operatorFetch<AdminConfigValue & { ok: true }>(`/v5/admin/config/${key}`, {
    method: "PUT",
    body: JSON.stringify({ value }),
  });
}

export interface PaymentCandidate {
  transactionId: string;
  appId: string;
  packageCode: string;
  amountBdt: number;
  requestedAt: number;
  deltaBdt: number;
  timeDeltaSec: number;
}export interface PaymentSmsItem {
  id: string;
  sender: string;
  provider: string;
  txnId: string;
  amountBdt: number;
  receivedAt: number;
  createdAt: number;
  /** Spec match state: unmatched | matched (proposed) | approved | rejected. */
  status: "unmatched" | "matched" | "approved" | "rejected";
  /** Stored reject reason (shown on the row), null unless rejected. */
  reason: string | null;
  matched: { transactionId: string; status: string; appId: string } | null;
  candidates: PaymentCandidate[];
  ambiguous: boolean;
}

/** GET /v5/admin/payments — spec filters: status + received-at window (from/to, epoch s). */
export async function listPayments(opts: {
  status?: "unmatched" | "matched" | "approved" | "rejected";
  from?: number;
  to?: number;
} = {}): Promise<{ config: MatchConfig; payments: PaymentSmsItem[] }> {
  const params = new URLSearchParams();
  if (opts.status !== undefined) params.set("status", opts.status);
  if (opts.from !== undefined) params.set("from", String(opts.from));
  if (opts.to !== undefined) params.set("to", String(opts.to));
  const qs = params.toString();
  const body = await operatorFetch<{ ok: true; config: MatchConfig; payments: PaymentSmsItem[] }>(
    `/v5/admin/payments${qs ? `?${qs}` : ""}`,
  );
  return { config: body.config, payments: body.payments };
}

/** Award outcome shared by approve/attach. */
export interface PaymentAward {
  transactionId: string;
  status: string;
  newOtpBalance: number;
  newBulkBalance: number;
}

/** POST /v5/admin/payments/:id/approve — one click awards the proposed/attached transaction. */
export async function approvePayment(paymentId: string): Promise<PaymentAward> {
  return operatorFetch<PaymentAward & { ok: true }>(
    `/v5/admin/payments/${encodeURIComponent(paymentId)}/approve`,
    { method: "POST" },
  );
}

/** POST /v5/admin/payments/:id/reject — reason required; stores it on the row. */
export async function rejectPayment(
  paymentId: string,
  reason: string,
): Promise<{ status: string; reason: string }> {
  return operatorFetch<{ ok: true; status: string; reason: string }>(
    `/v5/admin/payments/${encodeURIComponent(paymentId)}/reject`,
    { method: "POST", body: JSON.stringify({ reason }) },
  );
}

/** POST /v5/admin/payments/:id/attach — explicit transactionId = the operator's ambiguity resolution. */
export async function attachPayment(
  paymentId: string,
  transactionId: string,
): Promise<PaymentAward> {
  return operatorFetch<PaymentAward & { ok: true }>(`/v5/admin/payments/${encodeURIComponent(paymentId)}/attach`, {
    method: "POST",
    body: JSON.stringify({ transactionId }),
  });
}

export interface AdminPackage {
  packageCode: string;
  name: string;
  smsQuota: number;
  priceBdt: number;
  validityDays: number;
  type: string;
  isActive: boolean;
  /** ISSUE-89: price currency — BDT | USD | EUR (server-enforced enum). */
  currency: string;
  updatedAt?: number;
}

/** GET /v5/admin/billing/packages — full directory incl. retired rows (reactivable). */
export async function listAdminPackages(): Promise<AdminPackage[]> {
  const body = await operatorFetch<{ ok: true; packages: AdminPackage[] }>(
    "/v5/admin/billing/packages",
  );
  return body.packages;
}

/** POST /v5/admin/billing/packages — create-or-update keyed by packageCode (all fields required). */
export async function upsertAdminPackage(pkg: {
  packageCode: string;
  name: string;
  smsQuota: number;
  priceBdt: number;
  validityDays: number;
  type: string;
  isActive?: boolean;
  /** ISSUE-89: required here so the create form always states the unit. */
  currency: string;
}): Promise<void> {
  await operatorFetch("/v5/admin/billing/packages", { method: "POST", body: JSON.stringify(pkg) });
}

/** PATCH /v5/admin/billing/packages/:code — partial edit of whitelisted fields. */
export async function patchAdminPackage(
  packageCode: string,
  patch: Partial<Pick<AdminPackage, "name" | "smsQuota" | "priceBdt" | "validityDays" | "type" | "isActive" | "currency">>,
): Promise<void> {
  await operatorFetch(`/v5/admin/billing/packages/${encodeURIComponent(packageCode)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/** POST /v5/admin/billing/packages/:code/retire — spec endpoint (soft, idempotent; hard-delete is forbidden). */
export async function retireAdminPackage(packageCode: string): Promise<void> {
  await operatorFetch(`/v5/admin/billing/packages/${encodeURIComponent(packageCode)}/retire`, {
    method: "POST",
  });
}

export interface AdminUserItem {
  id: string;
  email: string;
  disabled: boolean;
  /** Stored withhold reason (spec: badge + tooltip on the withheld row). */
  disabledReason: string | null;
  disabledAt: number | null;
  createdAt: number;
  appCount: number;
  apps: { id: string; appId: string; name: string; revoked: boolean }[];
}

/** GET /v5/admin/users — customer directory with withhold state + owned apps. */
export async function listAdminUsers(): Promise<AdminUserItem[]> {
  const body = await operatorFetch<{ ok: true; users: AdminUserItem[] }>("/v5/admin/users");
  return body.users;
}

/**
 * POST /v5/admin/users/:id/disable | /enable — the withhold toggle (credits
 * untouched). The reason is REQUIRED when disabling (spec): the server 400s
 * without it, sessions are revoked eagerly, and the action is audited.
 */
export async function setAdminUserDisabled(
  userId: string,
  disabled: boolean,
  reason?: string,
): Promise<void> {
  await operatorFetch(
    `/v5/admin/users/${encodeURIComponent(userId)}/${disabled ? "disable" : "enable"}`,
    {
      method: "POST",
      ...(disabled ? { body: JSON.stringify({ reason: reason ?? "" }) } : {}),
    },
  );
}

/** One ledger row (spec columns + additive identity fields for the screen). */
export interface LedgerRow {
  /** Stable row identity (purchase id | trial:<app> | <app>:<kind>:<day>) — the React key. */
  id: string;
  timestamp: number;
  appId: string;
  appName: string | null;
  ownerEmail: string | null;
  kind: string; // purchase | trial | spend-otp | spend-bulk
  packageCode: string;
  qty: number;
  amountBdt: number;
  /** ISSUE-89: purchases carry the package currency; trial/spend rows are BDT. */
  currency: string;
  trxId: string | null;
}

export interface LedgerReport {
  from: number;
  to: number;
  rows: LedgerRow[];
  nextCursor: string | null;
  totals: { packageType: string; status: string; currency: string; count: number; amountBdt: number; grantedSms: number }[];
}

/** One send-log row (spec: timestamp | app | kind | recipient | ref | status | campaign-name). */
export interface SendLogRow {
  timestamp: number;
  messageId: string;
  appId: string | null;
  appName: string | null;
  kind: string; // otp | bulk | other (other = legacy unlinked)
  recipient: string;
  ref: string | null; // sessionId | campaignId
  status: string; // sent | verified | expired | failed | pending (in-flight)
  campaignName: string | null;
  error: string | null;
  resultAt: number | null;
}

/** GET /v5/admin/reports/ledger — cursor-paginated (max 100/page); CSV via downloadOperatorCsv. */
export async function getLedgerReport(params: {
  appId?: string;
  from?: number;
  to?: number;
  cursor?: string;
} = {}): Promise<LedgerReport> {
  const qs = new URLSearchParams();
  if (params.appId !== undefined && params.appId !== "") qs.set("appId", params.appId);
  if (params.from !== undefined) qs.set("from", String(params.from));
  if (params.to !== undefined) qs.set("to", String(params.to));
  if (params.cursor !== undefined && params.cursor !== "") qs.set("cursor", params.cursor);
  const suffix = qs.toString() !== "" ? `?${qs.toString()}` : "";
  const body = await operatorFetch<LedgerReport & { ok: true }>(`/v5/admin/reports/ledger${suffix}`);
  return { from: body.from, to: body.to, rows: body.rows, nextCursor: body.nextCursor, totals: body.totals };
}

/** One row of GET /v5/admin/reports/packages — approved sales aggregated per package. */
export interface PackageReportRow {
  packageCode: string;
  name: string;
  /** ISSUE-89: the package's price currency — totalAmount is in this unit. */
  currency: string;
  countSold: number;
  totalAmount: number;
  smsSold: number;
  firstSoldAt: number | null;
  lastSoldAt: number | null;
}

export interface PackageReport {
  from: number;
  to: number;
  rows: PackageReportRow[];
  /** One bucket per currency — sums stay unit-consistent, never crossed. */
  totalsByCurrency: { currency: string; countSold: number; totalAmount: number }[];
}

/** GET /v5/admin/reports/packages — window is `?from=&to=` epoch s (server defaults to last 30 days). */
export async function getPackageReport(params: { from?: number; to?: number } = {}): Promise<PackageReport> {
  const qs = new URLSearchParams();
  if (params.from !== undefined) qs.set("from", String(params.from));
  if (params.to !== undefined) qs.set("to", String(params.to));
  const suffix = qs.toString() !== "" ? `?${qs.toString()}` : "";
  const body = await operatorFetch<PackageReport & { ok: true }>(`/v5/admin/reports/packages${suffix}`);
  return { from: body.from, to: body.to, rows: body.rows, totalsByCurrency: body.totalsByCurrency };
}

/** GET /v5/admin/reports/sends (spec path) — cursor-paginated; recipient numbers are PII: operator-only. */
export async function getSendLog(params: {
  appId?: string;
  from?: number;
  to?: number;
  cursor?: string;
} = {}): Promise<{ rows: SendLogRow[]; nextCursor: string | null }> {
  const qs = new URLSearchParams();
  if (params.appId !== undefined && params.appId !== "") qs.set("appId", params.appId);
  if (params.from !== undefined) qs.set("from", String(params.from));
  if (params.to !== undefined) qs.set("to", String(params.to));
  if (params.cursor !== undefined && params.cursor !== "") qs.set("cursor", params.cursor);
  const suffix = qs.toString() !== "" ? `?${qs.toString()}` : "";
  const body = await operatorFetch<{ ok: true; rows: SendLogRow[]; nextCursor: string | null }>(
    `/v5/admin/reports/sends${suffix}`,
  );
  return { rows: body.rows, nextCursor: body.nextCursor };
}

/**
 * Raw-text operator request — CSV exports are not JSON, so they cannot ride
 * `request`. Same contract: Bearer secret, 401 clears + notifies the shell.
 */
async function operatorText(path: string): Promise<string> {
  const secret = getOperatorSecret();
  if (secret === null) {
    throw new ApiError(401, "operator_not_configured", "Enter the operator secret first");
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      credentials: "include",
      headers: { Authorization: `Bearer ${secret}` },
    });
  } catch {
    throw new ApiError(0, "network_error", "Network error — the API is unreachable");
  }
  if (!res.ok) {
    if (res.status === 401) {
      clearOperatorSecret();
      onOperatorRejected?.();
    }
    throw new ApiError(res.status, `http_${res.status}`, `HTTP ${res.status}`);
  }
  return res.text();
}

/**
 * Downloads an operator report as CSV — the ONLY export form (PII policy:
 * recipient numbers never leave through any other channel). Fetches with the
 * operator secret, then hands the text to a transient object URL.
 */
export async function downloadOperatorCsv(path: string, filename: string): Promise<void> {
  const text = await operatorText(path);
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ── Bulk recipient upload (F5c: preview → checksum-bound confirm) ─────────

/** One rejected recipient row: 1-based file line + why it failed. */
export interface BulkInvalidRow {
  line: number;
  reason: string;
}

export interface BulkPreview {
  total: number;
  sampleFirst5: string[];
  invalidRows: BulkInvalidRow[];
  /** SHA-256 the create route must reproduce — binds submit to this preview. */
  checksum: string;
  headerSkipped?: boolean;
  perCampaignLimit?: number;
}

export interface BulkCreateResult {
  ok: true;
  campaignId: string;
  totalRecipients: number;
  creditsReserved: number;
  charset: string;
  status: string;
  duplicateCount?: number;
}

/**
 * Step 1 — POST /v5/bulk/campaigns/preview with the RAW csv text
 * (Content-Type: text/csv; the server parses natively, no library here).
 * Pure validation: spends nothing, stores nothing.
 */
export async function previewBulkCsv(csvText: string): Promise<BulkPreview> {
  return appFetch<BulkPreview & { ok: true }>("/v5/bulk/campaigns/preview", {
    method: "POST",
    headers: { "Content-Type": "text/csv" },
    body: csvText,
  });
}

/**
 * Step 2 — POST /v5/bulk/campaigns carrying the preview checksum. The server
 * recomputes it over the submitted csv and answers `checksum_mismatch` when
 * the list changed, so a list the operator never reviewed cannot spend
 * credits. The confirm payload names the field `name` (F5c AC).
 */
export async function createBulkCampaign(input: {
  checksum: string;
  name: string;
  message: string;
  csv: string;
}): Promise<BulkCreateResult> {
  return appFetch<BulkCreateResult>("/v5/bulk/campaigns", {
    method: "POST",
    body: JSON.stringify({ ...input, sourceType: "csv" }),
  });
}
