/**
 * V5 API client tests — auth persistence, single-use refresh rotation, and
 * envelope-to-V5ApiError behavior, against a mocked global fetch. Pure unit
 * tests: no network, no storage beyond jsdom-less localStorage/sessionStorage
 * shims installed here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Minimal storage shims (happy-dom/jsdom not installed in this repo).
class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

const { V5ApiError, getAuth, setAuth, clearAuth, getAppCredentials, setAppCredentials, ensureAccessToken, refreshTokens, login, appRequest, campaignAction } = await import('../src/v5/api.js');

/** Builds a fetch mock returning (status, body) JSON responses in order. */
function mockFetch(...responses) {
  const impl = vi.fn(async () => {
    const next = responses.shift() ?? { status: 500, body: { ok: false, error: 'no stub', code: 'unknown_error' } };
    return { ok: next.status < 400, status: next.status, json: async () => next.body, clone() { return this; } };
  });
  vi.stubGlobal('fetch', impl);
  return impl;
}

const ACCESS = `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: 'u1', email: 'a@b.co', exp: Math.floor(Date.now() / 1000) + 900 }))}.sig`;
const STALE = `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: 'u1', email: 'a@b.co', exp: Math.floor(Date.now() / 1000) - 10 }))}.sig`;
const ACCESS2 = `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: 'u1', email: 'a@b.co', exp: Math.floor(Date.now() / 1000) + 1800 }))}.sig2`;

beforeEach(() => {
  // Fresh storage shims per test (the module under test reads window.* lazily).
  vi.stubGlobal('window', {
    localStorage: new MemoryStorage(),
    sessionStorage: new MemoryStorage(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('credential storage', () => {
  it('round-trips and clears the JWT pair and per-session app credentials', () => {
    expect(getAuth()).toBeNull();
    setAuth({ accessToken: 'a', refreshToken: 'r', email: 'a@b.co' });
    expect(getAuth()).toEqual({ accessToken: 'a', refreshToken: 'r', email: 'a@b.co' });
    clearAuth();
    expect(getAuth()).toBeNull();

    expect(getAppCredentials()).toBeNull();
    setAppCredentials('app-1', 'secret-1');
    expect(getAppCredentials()).toEqual({ appId: 'app-1', appSecret: 'secret-1' });
  });
});

describe('login + refresh rotation', () => {
  it('login persists the pair and decodes the email from the access token', async () => {
    mockFetch({ status: 200, body: { ok: true, accessToken: ACCESS, refreshToken: 'r1' } });
    const auth = await login('A@B.co', 'password-1');
    expect(auth.email).toBe('a@b.co');
    expect(getAuth().refreshToken).toBe('r1');
  });

  it('ensureAccessToken refreshes proactively when the access token is stale', async () => {
    setAuth({ accessToken: STALE, refreshToken: 'r-old', email: 'a@b.co' });
    mockFetch({ status: 200, body: { ok: true, accessToken: ACCESS2, refreshToken: 'r-new' } });
    const token = await ensureAccessToken();
    expect(token).toBe(ACCESS2);
    expect(getAuth().refreshToken).toBe('r-new');
  });

  it('a dead refresh token clears the session and throws typed', async () => {
    setAuth({ accessToken: STALE, refreshToken: 'r-dead', email: 'a@b.co' });
    mockFetch({ status: 401, body: { ok: false, error: 'Invalid, expired, or revoked refresh token', code: 'invalid_refresh_token' } });
    await expect(refreshTokens()).rejects.toMatchObject({ code: 'invalid_refresh_token', status: 401 });
    expect(getAuth()).toBeNull();
  });
});

describe('envelope + requireApp requests', () => {
  it('sends X-App-Id / X-App-Secret from the session store', async () => {
    setAppCredentials('app-1', 'secret-1');
    const fetchMock = mockFetch({ status: 200, body: { ok: true, campaigns: [] } });
    await appRequest('/v5/bulk/campaigns');
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['X-App-Id']).toBe('app-1');
    expect(init.headers['X-App-Secret']).toBe('secret-1');
  });

  it('throws typed app_credentials_missing when no credentials are stored', async () => {
    await expect(appRequest('/v5/bulk/campaigns')).rejects.toMatchObject({ code: 'app_credentials_missing' });
  });

  it('turns a non-ok envelope into V5ApiError with status and code', async () => {
    setAppCredentials('app-1', 'secret-1');
    mockFetch({ status: 429, body: { ok: false, error: 'Daily bulk quota exceeded', code: 'daily_quota_exceeded' } });
    const err = await appRequest('/v5/bulk/campaigns', { method: 'POST', body: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(V5ApiError);
    expect(err.status).toBe(429);
    expect(err.code).toBe('daily_quota_exceeded');
  });

  it('replays once through refresh on invalid_access_token then succeeds', async () => {
    setAuth({ accessToken: ACCESS, refreshToken: 'r-old', email: 'a@b.co' });
    setAppCredentials('app-1', 'secret-1');
    const fetchMock = mockFetch(
      { status: 401, body: { ok: false, error: 'Invalid or expired access token', code: 'invalid_access_token' } },
      { status: 200, body: { ok: true, accessToken: ACCESS2, refreshToken: 'r-new' } },
      { status: 200, body: { ok: true, campaigns: [{ campaignId: 'c1' }] } },
    );
    const envelope = await appRequest('/v5/bulk/campaigns');
    expect(envelope.campaigns).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(getAuth().refreshToken).toBe('r-new');
  });

  it('never loops: a second invalid_access_token surfaces as V5ApiError', async () => {
    setAuth({ accessToken: ACCESS, refreshToken: 'r-old', email: 'a@b.co' });
    setAppCredentials('app-1', 'secret-1');
    const fetchMock = mockFetch(
      { status: 401, body: { ok: false, error: 'Invalid or expired access token', code: 'invalid_access_token' } },
      { status: 200, body: { ok: true, accessToken: ACCESS2, refreshToken: 'r-new' } },
      { status: 401, body: { ok: false, error: 'Invalid or expired access token', code: 'invalid_access_token' } },
    );
    await expect(appRequest('/v5/bulk/campaigns')).rejects.toMatchObject({ code: 'invalid_access_token', status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('campaignAction rejects unknown actions before any network call', () => {
    expect(() => campaignAction('c1', 'pause!')).toThrow(V5ApiError);
    expect(() => campaignAction('c1', 'pause!')).toThrow(/Unknown campaign action/);
  });
});
