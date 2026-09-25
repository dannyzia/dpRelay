/**
 * V5 auth context — the user-plane JWT session for the v5 dashboard slice.
 *
 * Deliberately separate from the v4 AuthContext (Firebase): the v5 plane has
 * its own credential model (email/password → access + single-use refresh
 * tokens). On mount a stale-but-present session is proactively refreshed so a
 * reload doesn't bounce an already-signed-in user to /v5/login.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { clearAppCredentials, clearAuth, getAppCredentials, getAuth, login as apiLogin, logout as apiLogout, refreshTokens } from './api.js';

const V5AuthContext = createContext(null);

export function V5AuthProvider({ children }) {
  const [auth, setAuth] = useState(() => getAuth());
  const [loading, setLoading] = useState(() => Boolean(getAuth()?.refreshToken));
  // App credentials live in sessionStorage; a mirror in state makes the UI
  // reactive to save/clear without prop drilling.
  const [appCredentials, setAppCredentialsMirror] = useState(() => getAppCredentials());

  useEffect(() => {
    // Proactive refresh: a reload with a near-expiry access token must not
    // force a re-login if the refresh token is still valid.
    let cancelled = false;
    if (!getAuth()?.refreshToken) {
      setLoading(false);
      return undefined;
    }
    refreshTokens()
      .then((next) => {
        if (!cancelled) setAuth(next);
      })
      .catch(() => {
        if (!cancelled) setAuth(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email, password) => {
    const next = await apiLogin(email, password);
    setAuth(next);
    return next;
  }, []);

  const logout = useCallback(() => {
    apiLogout();
    setAuth(null);
  }, []);

  /** Re-reads sessionStorage after a save/clear on the credentials page. */
  const refreshCredentials = useCallback(() => {
    setAppCredentialsMirror(getAppCredentials());
  }, []);

  const value = useMemo(
    () => ({
      user: auth ? { email: auth.email } : null,
      isAuthenticated: Boolean(auth?.refreshToken),
      loading,
      hasCredentials: Boolean(appCredentials?.appId && appCredentials?.appSecret),
      login,
      logout,
      refreshCredentials,
    }),
    [auth, loading, appCredentials, login, logout, refreshCredentials],
  );

  return <V5AuthContext.Provider value={value}>{children}</V5AuthContext.Provider>;
}

/** Accessor for the v5 session; must be used inside <V5AuthProvider>. */
export function useV5Auth() {
  const ctx = useContext(V5AuthContext);
  if (!ctx) throw new Error('useV5Auth must be used within V5AuthProvider');
  return ctx;
}
