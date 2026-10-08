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

/** GET /v5/billing/packages — public catalog of active packages. */
export async function listPackages(): Promise<CreditPackage[]> {
  const body = await appFetch<{ ok: true; packages: CreditPackage[] }>("/v5/billing/packages");
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

/** GET /v5/admin/billing/queue — pending TrxID approvals. */
export async function listPendingTransactions(): Promise<PendingTransaction[]> {
  const body = await operatorFetch<{ ok: true; pending: PendingTransaction[] }>(
    "/v5/admin/billing/queue",
  );
  return body.pending;
}

/** POST /v5/admin/billing/approve — approve:false is the reject path (rejectReason travels with it). */
export async function resolveTransaction(
  transactionId: string,
  approve: boolean,
  rejectReason?: string,
): Promise<{ status: string; newOtpBalance?: number; newBulkBalance?: number }> {
  return operatorFetch<{ ok: true; status: string; newOtpBalance?: number; newBulkBalance?: number }>(
    "/v5/admin/billing/approve",
    { method: "POST", body: JSON.stringify({ transactionId, approve, rejectReason }) },
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
