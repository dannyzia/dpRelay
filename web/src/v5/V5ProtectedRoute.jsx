import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useV5Auth } from './V5AuthContext.jsx';

/**
 * Route guard for the v5 slice. Renders the v5 login while the session check
 * is in flight, and captures the intended location so sign-in returns the
 * user to where they were headed.
 */
export default function V5ProtectedRoute() {
  const { isAuthenticated, loading } = useV5Auth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <p className="text-sm text-slate-500">Checking your session…</p>
      </div>
    );
  }
  if (!isAuthenticated) {
    return <Navigate to="/v5/login" replace state={{ from: location.pathname }} />;
  }
  return <Outlet />;
}
