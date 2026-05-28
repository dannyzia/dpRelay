import React from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { auth } from '../../utils/firebase'
import {
  HomeIcon,
  ShoppingBagIcon,
  DocumentTextIcon,
  ChartBarIcon,
  ArrowLeftOnRectangleIcon,
} from '@heroicons/react/24/outline'

const menuItems = [
  { to: '/admin', icon: HomeIcon, label: 'Dashboard' },
  { to: '/admin/packages', icon: ShoppingBagIcon, label: 'Packages' },
  { to: '/admin/transactions', icon: DocumentTextIcon, label: 'Transactions' },
  { to: '/admin/metrics', icon: ChartBarIcon, label: 'Metrics' },
]

const AdminSidebar = () => {
  const location = useLocation()
  const { currentUser, bulkEnabled } = useAuth()

  return (
    <div className="w-64 bg-gray-900 border-r border-gray-700 min-h-screen fixed left-0 top-0 bottom-0 z-30">
      <div className="p-4">
        <div className="flex items-center space-x-2 mb-8">
          <div className="w-8 h-8 bg-brand-600 rounded-lg flex items-center justify-center shrink-0">
            <span className="text-white font-bold text-sm">ADM</span>
          </div>
          <span className="text-lg font-bold text-white">Admin Panel</span>
        </div>

        <nav className="space-y-1">
          {menuItems.map((item) => {
            const Icon = item.icon
            const active = location.pathname === item.to
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`flex items-center space-x-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                  active
                    ? 'bg-brand-500 text-white'
                    : 'text-gray-300 hover:bg-gray-700 hover:text-white'
                }`}
              >
                <Icon className="h-5 w-5 shrink-0" />
                <span>{item.label}</span>
              </Link>
            )
          })}
          {bulkEnabled && (
            <Link
              to="/admin/bulk"
              className={`flex items-center space-x-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                location.pathname.startsWith('/admin/bulk')
                  ? 'bg-brand-500 text-white'
                  : 'text-gray-300 hover:bg-gray-700 hover:text-white'
              }`}
            >
              <DocumentTextIcon className="h-5 w-5 shrink-0" />
              <span>Bulk SMS</span>
            </Link>
          )}
        </nav>
      </div>

      <div className="absolute bottom-0 left-0 right-0 p-4 border-t border-gray-700">
        <div className="flex items-center space-x-3">
          <img
            src={currentUser?.photoURL || `https://ui-avatars.com/api/?name=${currentUser?.email?.charAt(0)}&background=ef4444&color=fff`}
            alt="Admin"
            className="w-8 h-8 rounded-full"
          />
          <div className="min-w-0">
            <p className="text-sm font-medium text-white truncate">{currentUser?.email}</p>
            <p className="text-xs text-gray-400">Admin</p>
          </div>
        </div>
        <button
          onClick={() => auth.signOut()}
          className="mt-3 flex items-center space-x-2 w-full px-3 py-2 text-sm text-red-400 hover:bg-red-900/50 rounded-md transition-colors"
        >
          <ArrowLeftOnRectangleIcon className="h-4 w-4" />
          <span>Logout</span>
        </button>
      </div>
    </div>
  )
}

export default AdminSidebar
