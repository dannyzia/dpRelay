/**
 * dP Relay v5 API client — the dashboard's single trust boundary.
 *
 * Auth model (server contract, server/src/routes/auth.ts):
 * - POST /v5/auth/login → { accessToken, refreshToken }; register returns
 *   201 { ok } only (login afterwards). Refresh rotates single-use tokens:
 *   the presented token is consumed and a fresh pair returned.
 * - App-plane routes authenticate with `Authorization: Bearer <accessToken>`.
 * - Every response is the { ok, error, code } envelope; !ok maps to a thrown
 *   ApiError carrying the server's code so screens can react precisely.
 *
 * Token storage: localStorage is deliberate for this milestone (the server
 * plane is JWT-only today — no httpOnly cookie endpoint exists to trust).
 * All app-plane requests flow through `authedFetch`, which on a single 401
 * clears the session and surfaces it via `onUnauthorized` (App redirects to
 * login). A silent single-flight refresh loop is deliberately NOT wired to
 * app-plane calls yet: the access token TTL (900s) comfortably exceeds a
 * dashboard session's typical activity span, and the server-side refresh
 * rotation is one explicit call away (refreshTokens()).
 */

/** API base: Vite env at build time, defaulting to the production API. */
export const API_BASE: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "https://dprelay-api-hug8.onrender.com";

const ACCESS_KEY = "dprelay.accessToken";
const REFRESH_KEY = "dprelay.refreshToken";
const APP_ID_KEY = "dprelay.appId";
const APP_SECRET_KEY = "dprelay.appSecret";

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

export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_KEY);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_KEY);
}

export function storeTokens(accessToken: string, refreshToken: string): void {
  localStorage.setItem(ACCESS_KEY, accessToken);
  localStorage.setItem(REFRESH_KEY, refreshToken);
}

export function clearTokens(): void {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

// ── App connection (the app-credential plane) ─────────────────────────────
//
// Server contract (verified live 2026-09-25): bulk campaigns, credits, and
// groups/templates authenticate via requireApp — X-App-Id + X-App-Secret —
// NOT the user JWT (a Bearer-JWT call to /v5/bulk/* returns 401
// missing_app_credentials). The dashboard therefore has two credential
// planes: the user session (login/refresh, localStorage) and a CONNECTED APP
// whose credentials the operator pastes once per browser session
// (sessionStorage — gone when the tab closes, never persisted to disk).

export function getConnectedApp(): { appId: string; appSecret: string } | null {
  const appId = sessionStorage.getItem(APP_ID_KEY);
  const appSecret = sessionStorage.getItem(APP_SECRET_KEY);
  return appId !== null && appSecret !== null ? { appId, appSecret } : null;
}

export function connectApp(appId: string, appSecret: string): void {
  sessionStorage.setItem(APP_ID_KEY, appId);
  sessionStorage.setItem(APP_SECRET_KEY, appSecret);
}

export function disconnectApp(): void {
  sessionStorage.removeItem(APP_ID_KEY);
  sessionStorage.removeItem(APP_SECRET_KEY);
}

/**
 * App-plane request: X-App-Id/X-App-Secret headers. 401 (unknown app, bad
 * secret, or revoked app) drops the connection so the shell re-prompts —
 * the user JWT session itself is unaffected.
 */
export async function appFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const app = getConnectedApp();
  if (app === null) {
    throw new ApiError(401, "app_not_connected", "Connect an app to use this section");
  }
  try {
    return await request<T>(path, {
      ...init,
      headers: { "X-App-Id": app.appId, "X-App-Secret": app.appSecret, ...(init.headers ?? {}) },
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      disconnectApp();
      onAppDisconnected?.();
    }
    throw err;
  }
}

/** Registered once by App; drops back to the connect-app prompt. */
let onAppDisconnected: (() => void) | null = null;

export function setAppDisconnectedHandler(handler: (() => void) | null): void {
  onAppDisconnected = handler;
}

/** Registered once by App; redirects to the login screen. */
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

interface Envelope {
  ok?: boolean;
  error?: string;
  code?: string;
}

/** Raw JSON request; throws ApiError on !ok envelopes and non-2xx. */
export async function request<T>(path: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      // Content-Type only when a body exists: bodyless POSTs (pause/resume/
      // cancel) declaring application/json hit Fastify's empty-JSON-body
      // rejection (400) — caught by the lifecycle smoke test.
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
    throw new ApiError(res.status, envelope.code ?? `http_${res.status}`, envelope.error ?? `HTTP ${res.status}`);
  }
  return body as T;
}

/** Authed request: Bearer token; 401 clears the session and redirects. */
export async function authedFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getAccessToken();
  if (!token) {
    onUnauthorized?.();
    throw new ApiError(401, "not_authenticated", "Not signed in");
  }
  try {
    return await request<T>(path, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      clearTokens();
      onUnauthorized?.();
    }
    throw err;
  }
}

// ── Auth plane ─────────────────────────────────────────────────────────────

export async function register(email: string, password: string): Promise<void> {
  await request<{ ok: true }>("/v5/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export async function login(email: string, password: string): Promise<void> {
  const body = await request<{ ok: true; accessToken: string; refreshToken: string }>("/v5/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  storeTokens(body.accessToken, body.refreshToken);
}

/** Explicit refresh (rotation: presented token is single-use). */
export async function refreshTokens(): Promise<void> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) throw new ApiError(401, "not_authenticated", "Not signed in");
  const body = await request<{ ok: true; accessToken: string; refreshToken: string }>("/v5/auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refreshToken }),
  });
  storeTokens(body.accessToken, body.refreshToken);
}

export function logout(): void {
  clearTokens();
}

// ── Campaigns plane (server/src/routes/bulk.ts contract) ──────────────────

export interface Campaign {
  campaignId: string;
  name: string;
  status: "queued" | "sending" | "paused" | "completed" | "cancelled";
  sourceType: "csv" | "contactGroups";
  totalRecipients: number;
  sentCount: number;
  failedCount: number;
  queuedCount: number;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export interface CampaignDetail extends Campaign {
  message: string;
  sourceGroupIds: string[] | null;
}

interface CampaignsResponse {
  ok: true;
  campaigns: Campaign[];
  nextCursor: string | null;
}

export async function listCampaigns(status?: Campaign["status"]): Promise<{ campaigns: Campaign[]; nextCursor: string | null }> {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  const body = await appFetch<CampaignsResponse>(`/v5/bulk/campaigns${query}`);
  return { campaigns: body.campaigns, nextCursor: body.nextCursor };
}

export async function getCampaign(id: string): Promise<CampaignDetail> {
  const body = await appFetch<{ ok: true; campaign: CampaignDetail }>(`/v5/bulk/campaigns/${encodeURIComponent(id)}`);
  return body.campaign;
}

export interface CreateCampaignInput {
  name: string;
  message: string;
  phones: string[];
}

export interface CreateCampaignResult {
  campaignId: string;
  totalRecipients: number;
  creditsReserved: number;
  duplicateCount?: number;
}

export async function createCampaign(input: CreateCampaignInput): Promise<CreateCampaignResult> {
  return appFetch<CreateCampaignResult & { ok: true }>("/v5/bulk/campaigns", {
    method: "POST",
    body: JSON.stringify({
      campaignName: input.name,
      message: input.message,
      sourceType: "csv",
      phones: input.phones,
    }),
  });
}

/** One of the per-status actions; the server rejects illegal transitions. */
export async function campaignAction(id: string, action: "pause" | "resume" | "cancel"): Promise<{ status: string; creditsRefunded?: number }> {
  return appFetch<{ ok: true; status: string; creditsRefunded?: number }>(
    `/v5/bulk/campaigns/${encodeURIComponent(id)}/${action}`,
    { method: "POST" },
  );
}

/** Maps any thrown error to a user-presentable one-liner. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    return err.code === "network_error" ? err.message : `${err.message} (${err.code})`;
  }
  return "Unexpected error — see the browser console";
}

// ── Operator plane (server requireOperator routes) ─────────────────────────
//
// Admin routes authenticate with `Authorization: Bearer <OPERATOR_SECRET>` —
// a third credential plane, pasted once per browser session (sessionStorage,
// same contract as the connected app) and VERIFIED against /v5/admin/metrics
// before being stored. A 401 from an operator call clears it so the unlock
// form re-prompts; user session and connected app are untouched.

const OPERATOR_KEY = "dprelay.operatorSecret";

export function getOperatorSecret(): string | null {
  return sessionStorage.getItem(OPERATOR_KEY);
}

export function setOperatorSecret(secret: string): void {
  sessionStorage.setItem(OPERATOR_KEY, secret);
}

export function clearOperatorSecret(): void {
  sessionStorage.removeItem(OPERATOR_KEY);
}

let onOperatorRejected: (() => void) | null = null;

export function setOperatorRejectedHandler(handler: (() => void) | null): void {
  onOperatorRejected = handler;
}

export async function operatorFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const secret = getOperatorSecret();
  if (secret === null) {
    throw new ApiError(401, "operator_not_configured", "Enter the operator secret to use this section");
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

// ── Contact groups plane (server/src/routes/contact-groups.ts contract) ───

export interface ContactGroup {
  groupId: string;
  name: string;
  phoneCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface ContactGroupDetail extends ContactGroup {
  phones: string[];
}

export async function listContactGroups(): Promise<{ groups: ContactGroup[]; nextCursor: string | null }> {
  const body = await appFetch<{ ok: true; groups: ContactGroup[]; nextCursor: string | null }>("/v5/contact-groups");
  return { groups: body.groups, nextCursor: body.nextCursor };
}

export async function createContactGroup(
  name: string,
  phones: string[],
): Promise<{ groupId: string; phoneCount: number; duplicateCount?: number }> {
  return appFetch<{ ok: true; groupId: string; phoneCount: number; duplicateCount?: number }>("/v5/contact-groups", {
    method: "POST",
    body: JSON.stringify({ name, phones }),
  });
}

export async function getContactGroup(id: string): Promise<ContactGroupDetail> {
  const body = await appFetch<{ ok: true; group: ContactGroupDetail }>(`/v5/contact-groups/${encodeURIComponent(id)}`);
  return body.group;
}

export async function renameContactGroup(id: string, name: string): Promise<void> {
  await appFetch(`/v5/contact-groups/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export async function deleteContactGroup(id: string): Promise<void> {
  await appFetch(`/v5/contact-groups/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function addGroupPhones(
  id: string,
  phones: string[],
): Promise<{ addedCount: number; duplicateCount?: number }> {
  return appFetch<{ ok: true; addedCount: number; duplicateCount?: number }>(
    `/v5/contact-groups/${encodeURIComponent(id)}/phones`,
    { method: "POST", body: JSON.stringify({ phones }) },
  );
}

export async function removeGroupPhones(id: string, phones: string[]): Promise<{ removedCount: number }> {
  return appFetch<{ ok: true; removedCount: number }>(
    `/v5/contact-groups/${encodeURIComponent(id)}/phones`,
    { method: "DELETE", body: JSON.stringify({ phones }) },
  );
}

// ── Message templates plane (server/src/routes/message-templates.ts) ───────

export interface MessageTemplate {
  templateId: string;
  name: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

export async function listMessageTemplates(): Promise<{ templates: MessageTemplate[]; nextCursor: string | null }> {
  const body = await appFetch<{ ok: true; templates: MessageTemplate[]; nextCursor: string | null }>(
    "/v5/message-templates",
  );
  return { templates: body.templates, nextCursor: body.nextCursor };
}

export async function createMessageTemplate(name: string, body: string): Promise<{ templateId: string }> {
  return appFetch<{ ok: true; templateId: string }>("/v5/message-templates", {
    method: "POST",
    body: JSON.stringify({ name, body }),
  });
}

export async function updateMessageTemplate(
  id: string,
  fields: { name?: string; body?: string },
): Promise<void> {
  await appFetch(`/v5/message-templates/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(fields),
  });
}

export async function deleteMessageTemplate(id: string): Promise<void> {
  await appFetch(`/v5/message-templates/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// ── Admin: apps registry (server/src/routes/admin-apps.ts contract) ────────
//
// Secret handling is return-once at mint/rotation (create, rotate): the raw
// appSecret/webhookSecret appear exactly once and only hashes are stored —
// the UI must surface them prominently with a never-again warning.

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

export interface AdminAppCreated extends AdminApp {
  appSecret: string;
  webhookSecret: string;
  appSecretGenerated: boolean;
}

export interface CredentialsStatus {
  appId: string;
  credentialsIssued: boolean;
  revoked: boolean;
  revokedAt: number | null;
  webhookConfigured: boolean;
  webhookRotatedAt: number | null;
  createdAt: number;
}

export async function listAdminApps(): Promise<{ apps: AdminApp[]; nextCursor: string | null }> {
  const body = await operatorFetch<{ ok: true; apps: AdminApp[]; nextCursor: string | null }>("/v5/admin/apps");
  return { apps: body.apps, nextCursor: body.nextCursor };
}

export interface CreateAdminAppInput {
  appId: string;
  name?: string;
  webhookUrl?: string;
}

export async function createAdminApp(input: CreateAdminAppInput): Promise<AdminAppCreated> {
  return operatorFetch<AdminAppCreated & { ok: true }>("/v5/admin/apps", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function revokeAdminApp(id: string): Promise<void> {
  await operatorFetch(`/v5/admin/apps/${encodeURIComponent(id)}/revoke`, { method: "POST" });
}

export async function unrevokeAdminApp(id: string): Promise<void> {
  await operatorFetch(`/v5/admin/apps/${encodeURIComponent(id)}/unrevoke`, { method: "POST" });
}

export async function rotateAdminAppWebhookSecret(id: string): Promise<{ webhookSecret: string }> {
  return operatorFetch<{ ok: true; webhookSecret: string }>(
    `/v5/admin/apps/${encodeURIComponent(id)}/rotate-webhook-secret`,
    { method: "POST" },
  );
}

export async function updateAdminAppWebhook(id: string, webhookUrl: string): Promise<void> {
  await operatorFetch(`/v5/admin/apps/${encodeURIComponent(id)}/webhook`, {
    method: "PATCH",
    body: JSON.stringify({ webhookUrl }),
  });
}

export async function getCredentialsStatus(id: string): Promise<CredentialsStatus> {
  return operatorFetch<{ ok: true } & CredentialsStatus>(
    `/v5/admin/apps/${encodeURIComponent(id)}/credentials-status`,
  );
}

// ── Admin: metrics + campaign oversight ───────────────────────────────────

export interface AdminMetrics {
  generatedAt: number;
  apps: { total: number; revoked: number };
  users: { total: number; devices: number };
  otp: { sessionsTotal: number; sessionsPending: number; sessionsVerified: number; sessionsLast24h: number };
  bulk: {
    campaignsTotal: number;
    campaignsActive: number;
    recipientsSent: number;
    recipientsFailed: number;
    recipientsQueued: number;
  };
  billing: { transactionsPending: number; transactionsApproved: number; transactionsRejected: number; creditsRows: number };
  webhooks: { deliveriesLast24h: number; deliveredLast24h: number; failedLast24h: number };
}

/** Also used to verify a pasted operator secret before it is stored. */
export async function getAdminMetrics(): Promise<AdminMetrics> {
  return operatorFetch<AdminMetrics & { ok: true }>("/v5/admin/metrics");
}

export type OversightStatus = "queued" | "sending" | "paused" | "completed" | "cancelled";

export interface OversightCampaign {
  campaignId: string;
  appId: string;
  name: string;
  status: OversightStatus;
  totalRecipients: number;
  sentCount: number;
  failedCount: number;
  queuedCount: number;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export async function listOversightCampaigns(
  status?: OversightStatus,
): Promise<{ campaigns: OversightCampaign[]; nextCursor: string | null }> {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  const body = await operatorFetch<{ ok: true; campaigns: OversightCampaign[]; nextCursor: string | null }>(
    `/v5/admin/campaigns${query}`,
  );
  return { campaigns: body.campaigns, nextCursor: body.nextCursor };
}

// ── Admin: TrxID approvals (server/src/routes/billing.ts contract) ─────────

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

export async function listPendingTransactions(): Promise<PendingTransaction[]> {
  const body = await operatorFetch<{ ok: true; pending: PendingTransaction[] }>("/v5/admin/billing/queue");
  return body.pending;
}

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

// ── Admin: global SMS kill switch ──────────────────────────────────────────

export async function setKillSwitch(
  enabled: boolean,
): Promise<{ previous: boolean; enabled: boolean; changed: boolean }> {
  return operatorFetch<{ ok: true; previous: boolean; enabled: boolean; changed: boolean }>(
    "/v5/admin/kill-switch",
    { method: "POST", body: JSON.stringify({ enabled }) },
  );
}
