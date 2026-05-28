import React from 'react';

/**
 * Settings — account settings for the current user.
 */
export default function Settings() {
  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
      <p className="mt-1 text-sm text-gray-500">
        Manage your account preferences.
      </p>

      <div className="mt-6 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <p className="text-sm text-gray-500">
          Account settings will appear here.
        </p>
      </div>
    </div>
  );
}
