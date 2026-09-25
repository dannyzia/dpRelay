/**
 * V5 dashboard slice — routes, layout, and navigation, mounted as a separate
 * /v5/* subtree so the existing v4 (Firebase) pages stay untouched. Pages are
 * lazy-loaded so the slice costs nothing until someone visits /v5/*.
 *
 * Cloudflare Pages SPA note: public/_redirects maps every unknown path back
 * to /index.html so deep links like /v5/campaigns survive a hard refresh.
 */
import { Suspense, lazy } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { V5AuthProvider } from './V5AuthContext.jsx';
import V5ProtectedRoute from './V5ProtectedRoute.jsx';

const V5Login = lazy(() => import('./V5Pages.jsx').then((m) => ({ default: m.V5Login })));
const V5SessionCredentials = lazy(() => import('./V5Pages.jsx').then((m) => ({ default: m.V5SessionCredentials })));
const V5Campaigns = lazy(() => import('./V5Pages.jsx').then((m) => ({ default: m.V5Campaigns })));
const V5CreateCampaign = lazy(() => import('./V5Pages.jsx').then((m) => ({ default: m.V5CreateCampaign })));
const V5CampaignDetail = lazy(() => import('./V5Pages.jsx').then((m) => ({ default: m.V5CampaignDetail })));

const NAV_ITEMS = [
  { to: '/v5', label: 'Overview', end: true },
  { to: '/v5/campaigns', label: 'Campaigns' },
  { to: '/v5/credentials', label: 'Session credentials' },
];

function V5Layout() {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-6">
            <span className="text-sm font-bold tracking-tight text-slate-900">dP Relay v5</span>
            <nav className="flex items-center gap-1">
              {NAV_ITEMS.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    `rounded-lg px-3 py-1.5 text-sm font-medium ${
                      isActive ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100'
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>
          <V5HeaderUser />
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Routes>
          <Route element={<V5ProtectedRoute />}>
            <Route index element={<V5Campaigns />} />
            <Route path="campaigns" element={<V5Campaigns />} />
            <Route path="campaigns/create" element={<V5CreateCampaign />} />
            <Route path="campaigns/:campaignId" element={<V5CampaignDetail />} />
            <Route path="credentials" element={<V5SessionCredentials />} />
          </Route>
        </Routes>
      </main>
    </div>
  );
}

/** Shows the signed-in email + sign-out, or a sign-in link. */
function V5HeaderUser() {
  return (
    <V5HeaderUserInner />
  );
}

import { useV5Auth } from './V5AuthContext.jsx';
import { Link } from 'react-router-dom';

function V5HeaderUserInner() {
  const { user, logout, isAuthenticated } = useV5Auth();
  if (!isAuthenticated) {
    return <Link to="/v5/login" className="text-sm font-medium text-indigo-600 hover:underline">Sign in</Link>;
  }
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-slate-600">{user?.email}</span>
      <button
        type="button"
        onClick={logout}
        className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
      >
        Sign out
      </button>
    </div>
  );
}

function V5Suspense() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <p className="text-sm text-slate-500">Loading…</p>
    </div>
  );
}

/** Mounted from App.jsx: <Route path="/v5/*" element={<V5Routes />} /> */
export default function V5Routes() {
  return (
    <V5AuthProvider>
      <Suspense fallback={<V5Suspense />}>
        <Routes>
          <Route path="login" element={<V5Login />} />
          <Route path="*" element={<V5Layout />} />
        </Routes>
      </Suspense>
    </V5AuthProvider>
  );
}
