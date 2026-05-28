import React from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';

/**
 * Dashboard home — overview of account activity and quick-action cards.
 */
export default function DashboardHome() {
  const { currentUser } = useAuth();

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
      <p className="mt-1 text-sm text-gray-500">
        Welcome back{currentUser?.email ? `, ${currentUser.email}` : ''}.
      </p>

      <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        <Link
          to="/dashboard/apps"
          className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm transition hover:shadow-md"
        >
          <h2 className="text-lg font-semibold text-gray-900">Your Apps</h2>
          <p className="mt-1 text-sm text-gray-500">
            Manage API keys, webhooks, and app settings.
          </p>
        </Link>

        <Link
          to="/dashboard/buy-credits"
          className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm transition hover:shadow-md"
        >
          <h2 className="text-lg font-semibold text-gray-900">Buy Credits</h2>
          <p className="mt-1 text-sm text-gray-500">
            Purchase OTP credit packages.
          </p>
        </Link>

        <Link
          to="/dashboard/credits-overview"
          className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm transition hover:shadow-md"
        >
          <h2 className="text-lg font-semibold text-gray-900">Credits Overview</h2>
          <p className="mt-1 text-sm text-gray-500">
            View OTP and bulk credit balances across your apps.
          </p>
        </Link>

        <Link
          to="/dashboard/playground"
          className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm transition hover:shadow-md"
        >
          <h2 className="text-lg font-semibold text-gray-900">API Playground</h2>
          <p className="mt-1 text-sm text-gray-500">
            Test your integration live.
          </p>
        </Link>
      </div>
    </div>
  );
}
