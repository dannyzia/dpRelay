/**
 * dP Relay v5 API client (web dashboard slice).
 *
 * Every v5 route answers the structured envelope { ok, error, code } — this
 * client turns non-ok envelopes into typed V5ApiError throws so UI code never
 * has to guess shapes, and no failure is ever silent.
 *
 * Credentials live in two places, both chosen deliberately:
 * - JWT pair (localStorage): the user account survives page reloads; the
 *   access token is rotated through the single-use /v5/auth/refresh endpoint.
 * - App credentials (sessionStorage): X-App-Id / X-App-Secret are tenant
 *   secrets (requireApp plane), so they are scoped to the browser tab session
 *   and never persisted beyond it.
 *
 * The base URL comes from VITE_V5_API_BASE_URL. Unset → same-origin requests,
 * which is what the Cloudflare Pages deployment and the dev proxy both use.
 */

const BASE_URL = import.meta.env.VITE_V5_API_BASE_URL ?? '';

const JWT_STORAGE_KEY = 'dprelay.v5.auth';
const APP_CREDENTIALS_KEY = 'dprelay.v5.appCredentials';
/** Refresh when the access token expires within this window (seconds). */
const EXPIRY_SKEW_SEC = 60;

/** Typed failure for every non-ok v5 envelope or non-JSON response. */
export class V5ApiError extends Error {
  /**
   * @param {number} status HTTP status code
   * @param {string} code v5 machine-readable error code (e.g. 'sms_paused')
   * @param {string} error human-readable message from the server
   */
  constructor(status, code, error) {
    super(error);
    this.name = 'V5ApiError';
    this.status = status;
    this.code = code;
  }
}

function readJsonStorage(key, storage) {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Extracts the JWT payload (sub/email/exp) without verifying — display only. */
export function decodeJwtPayload(token) {
  try {
    const payloadPart = token.split('.')[1];
    if (!payloadPart) return null;
    const base64 = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join(''),
    );
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function tokenExpired(token) {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== 'number') return true;
  return payload.exp * 1000 <= Date.now() + EXPIRY_SKEW_SEC * 1000;
}

// ── Persisted JWT pair ─────────────────────────────────────────────────────

/** Returns { accessToken, refreshToken, email } or null. */
export function getAuth() {
  return readJsonStorage(JWT_STORAGE_KEY, window.localStorage);
}

export function setAuth(auth) {
  window.localStorage.setItem(JWT_STORAGE_KEY, JSON.stringify(auth));
}

export function clearAuth() {
  window.localStorage.removeItem(JWT_STORAGE_KEY);
}

// ── Per-session app credentials (requireApp plane) ─────────────────────────

/** Returns { appId, appSecret } for the current tab session, or null. */
export function getAppCredentials() {
  return readJsonStorage(APP_CREDENTIALS_KEY, window.sessionStorage);
}

export function setAppCredentials(appId, appSecret) {
  window.sessionStorage.setItem(APP_CREDENTIALS_KEY, JSON.stringify({ appId, appSecret }));
}

export function clearAppCredentials() {
  window.sessionStorage.removeItem(APP_CREDENTIALS_KEY);
}

// ── Core request path ──────────────────────────────────────────────────────

async function parseResponse(response) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON (proxy error page, empty body): surface the status, not a parse crash.
    throw new V5ApiError(response.status, 'invalid_response', `Unexpected non-JSON response (HTTP ${response.status})`);
  }
  if (!response.ok || body.ok !== true) {
    throw new V5ApiError(
      response.status,
      typeof body.code === 'string' ? body.code : 'unknown_error',
      typeof body.error === 'string' ? body.error : `Request failed (HTTP ${response.status})`,
    );
  }
  return body;
}

/**
 * Single fetch with envelope enforcement. `replayed` guards the one-shot
 * refresh-replay so a genuinely dead session never loops.
 */
async function rawRequest(path, { method = 'GET', headers = {}, body, replayed = false } = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  // Access token died mid-flight: rotate the refresh token once and replay.
  // The v5 refresh endpoint is single-use, so this must happen exactly once.
  if (response.status === 401 && !replayed && !path.startsWith('/v5/auth/')) {
    let envelope = null;
    try {
      envelope = await response.clone().json();
    } catch {
      envelope = null;
    }
    if (envelope && envelope.code === 'invalid_access_token' && getAuth()) {
      await refreshTokens();
      return rawRequest(path, { method, headers, body, replayed: true });
    }
  }

  return parseResponse(response);
}

/** Rotates the stored refresh token (single-use) and persists the new pair. */
export async function refreshTokens() {
  const auth = getAuth();
  if (!auth?.refreshToken) {
    clearAuth();
    throw new V5ApiError(401, 'not_authenticated', 'Not signed in');
  }
  let envelope;
  try {
    const response = await fetch(`${BASE_URL}/v5/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: auth.refreshToken }),
    });
    envelope = await parseResponse(response);
  } catch (err) {
    // Dead refresh token: the session is over — clear and rethrow typed.
    clearAuth();
    throw err;
  }
  const next = { ...auth, accessToken: envelope.accessToken, refreshToken: envelope.refreshToken };
  setAuth(next);
  return next;
}

/** Returns a valid access token, proactively refreshing near expiry. */
export async function ensureAccessToken() {
  const auth = getAuth();
  if (!auth?.accessToken) {
    throw new V5ApiError(401, 'not_authenticated', 'Not signed in');
  }
  if (tokenExpired(auth.accessToken)) {
    return (await refreshTokens()).accessToken;
  }
  return auth.accessToken;
}

// ── Auth endpoints ─────────────────────────────────────────────────────────

/** Logs in with the v5 user plane and persists the token pair. */
export async function login(email, password) {
  const envelope = await rawRequest('/v5/auth/login', { method: 'POST', body: { email, password } });
  const payload = decodeJwtPayload(envelope.accessToken);
  const auth = {
    accessToken: envelope.accessToken,
    refreshToken: envelope.refreshToken,
    email: typeof payload?.email === 'string' ? payload.email : email,
  };
  setAuth(auth);
  return auth;
}

/** Clears the persisted session (client-side only; v5 has no logout endpoint). */
export function logout() {
  clearAuth();
}

// ── requireApp endpoints (X-App-Id / X-App-Secret per session) ─────────────

function requireAppCredentials() {
  const creds = getAppCredentials();
  if (!creds?.appId || !creds?.appSecret) {
    throw new V5ApiError(401, 'app_credentials_missing', 'App credentials are not set for this session');
  }
  return creds;
}

/** Authenticated request against a requireApp route. */
export async function appRequest(path, options = {}) {
  const creds = requireAppCredentials();
  return rawRequest(path, {
    ...options,
    headers: { 'X-App-Id': creds.appId, 'X-App-Secret': creds.appSecret, ...options.headers },
  });
}

/**
 * Verifies the entered credentials against a cheap authenticated route so
 * the credentials page can show "verified" instead of trusting a first save.
 */
export async function verifyAppCredentials(appId, appSecret) {
  return rawRequest('/v5/billing/credits', {
    headers: { 'X-App-Id': appId, 'X-App-Secret': appSecret },
  });
}

// ── Campaigns ──────────────────────────────────────────────────────────────

/** Lists campaigns (newest first, keyset-paginated via nextCursor). */
export function listCampaigns({ status, limit, cursor } = {}) {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (limit) params.set('limit', String(limit));
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  return appRequest(`/v5/bulk/campaigns${qs ? `?${qs}` : ''}`);
}

/** Fetches one campaign (includes message + source groups). */
export function getCampaign(campaignId) {
  return appRequest(`/v5/bulk/campaigns/${encodeURIComponent(campaignId)}`);
}

/** Lists failed recipients for a campaign. */
export function getFailedRecipients(campaignId, { limit } = {}) {
  const qs = limit ? `?limit=${encodeURIComponent(String(limit))}` : '';
  return appRequest(`/v5/bulk/campaigns/${encodeURIComponent(campaignId)}/recipients/failed${qs}`);
}

/** Creates a campaign: { campaignName, message, sourceType, phones?, sourceGroupIds? }. */
export function createCampaign(payload) {
  return appRequest('/v5/bulk/campaigns', { method: 'POST', body: payload });
}

/** Runs a lifecycle action: 'pause' | 'resume' | 'cancel' | 'retry-failed'. */
export function campaignAction(campaignId, action) {
  if (!['pause', 'resume', 'cancel', 'retry-failed'].includes(action)) {
    throw new V5ApiError(400, 'invalid_action', `Unknown campaign action: ${action}`);
  }
  return appRequest(`/v5/bulk/campaigns/${encodeURIComponent(campaignId)}/${action}`, { method: 'POST' });
}
