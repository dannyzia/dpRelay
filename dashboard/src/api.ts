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
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
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
