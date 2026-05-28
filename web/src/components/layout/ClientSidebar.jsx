import React from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { auth } from "../../utils/firebase";
import dpRelayLogo from "../../assets/dpRelay-logo.png";
import {
  HomeIcon,
  CreditCardIcon,
  DocumentChartBarIcon,
  DocumentTextIcon,
  CommandLineIcon,
  BookOpenIcon,
  CogIcon,
  ArrowLeftOnRectangleIcon,
  UserGroupIcon,
  PaperAirplaneIcon,
} from "@heroicons/react/24/outline";

const menuItems = [
  { to: "/dashboard", icon: HomeIcon, label: "My Apps" },
  { to: "/dashboard/buy-credits", icon: CreditCardIcon, label: "Buy Credits" },
  {
    to: "/dashboard/transactions",
    icon: DocumentTextIcon,
    label: "Transactions",
  },
  {
    to: "/dashboard/invoices",
    icon: DocumentChartBarIcon,
    label: "Invoices",
  },
  {
    to: "/dashboard/playground",
    icon: CommandLineIcon,
    label: "API Playground",
  },
  {
    to: "/api-docs",
    icon: BookOpenIcon,
    label: "API Docs",
  },
  { to: "/dashboard/settings", icon: CogIcon, label: "Settings" },
];

const ClientSidebar = () => {
  const location = useLocation();
  const { currentUser, userRole, bulkEnabled } = useAuth();

  return (
    <div className="w-64 bg-white border-r border-gray-200 min-h-screen fixed left-0 top-0 bottom-0 z-30">
      <div className="p-4">
        <div className="mb-8">
          <img
            src={dpRelayLogo}
            alt="dpRelay logo"
            className="h-8 w-auto object-contain rounded-lg"
          />
        </div>

        <nav className="space-y-1">
          {menuItems.map((item) => {
            const Icon = item.icon;
            const active = location.pathname === item.to;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`flex items-center space-x-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                  active
                    ? "bg-brand-50 text-brand-700"
                    : "text-gray-700 hover:bg-gray-50 hover:text-gray-900"
                }`}
              >
                <Icon className="h-5 w-5 shrink-0" />
                <span>{item.label}</span>
              </Link>
            );
          })}
          {bulkEnabled && (
            <>
              <Link
                to="/dashboard/bulk"
                className={`flex items-center space-x-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                  location.pathname.startsWith("/dashboard/bulk")
                    ? "bg-brand-50 text-brand-700"
                    : "text-gray-700 hover:bg-gray-50 hover:text-gray-900"
                }`}
              >
                <PaperAirplaneIcon className="h-5 w-5 shrink-0" />
                <span>Bulk SMS</span>
              </Link>
              <Link
                to="/dashboard/contact-groups"
                className={`flex items-center space-x-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                  location.pathname.startsWith("/dashboard/contact-groups")
                    ? "bg-brand-50 text-brand-700"
                    : "text-gray-700 hover:bg-gray-50 hover:text-gray-900"
                }`}
              >
                <UserGroupIcon className="h-5 w-5 shrink-0" />
                <span>Contact Groups</span>
              </Link>
              <Link
                to="/dashboard/templates"
                className={`flex items-center space-x-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                  location.pathname === "/dashboard/templates" ||
                  location.pathname.startsWith("/dashboard/templates/")
                    ? "bg-brand-50 text-brand-700"
                    : "text-gray-700 hover:bg-gray-50 hover:text-gray-900"
                }`}
              >
                <DocumentTextIcon className="h-5 w-5 shrink-0" />
                <span>Templates</span>
              </Link>
            </>
          )}
        </nav>

        {userRole === "admin" && (
          <div className="mt-6 pt-4 border-t border-gray-200">
            <p className="px-3 mb-2 text-xs font-semibold text-gray-400 uppercase tracking-wider">
              Admin
            </p>
            <Link
              to="/admin"
              className="flex items-center space-x-3 px-3 py-2 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50 hover:text-gray-900 transition-colors"
            >
              <CogIcon className="h-5 w-5 shrink-0" />
              <span>Admin Panel</span>
            </Link>
          </div>
        )}
      </div>

      <div className="absolute bottom-0 left-0 right-0 p-4 border-t border-gray-200">
        <div className="flex items-center space-x-3">
          <img
            src={
              currentUser?.photoURL ||
              `https://ui-avatars.com/api/?name=${currentUser?.email?.charAt(0)}&background=10b981&color=fff`
            }
            alt="User"
            className="w-8 h-8 rounded-full"
          />
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-900 truncate">
              {currentUser?.email}
            </p>
            <p className="text-xs text-gray-500">
              {userRole === "admin" ? "Admin" : "Client"}
            </p>
          </div>
        </div>
        <button
          onClick={() => auth.signOut()}
          className="mt-3 flex items-center space-x-2 w-full px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded-md transition-colors"
        >
          <ArrowLeftOnRectangleIcon className="h-4 w-4" />
          <span>Logout</span>
        </button>
      </div>
    </div>
  );
};

export default ClientSidebar;
