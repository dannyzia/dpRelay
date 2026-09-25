import React from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { AuthProvider } from "./contexts/AuthContext";
import Layout from "./components/layout/Layout";

// Marketing pages
import Home from "./pages/marketing/Home";
import Pricing from "./pages/marketing/Pricing";
import Contact from "./pages/marketing/Contact";

// Auth pages
import Login from "./pages/auth/Login";
import Register from "./pages/auth/Register";

// Public API docs page
import APIDocs from "./pages/dashboard/APIDocs";

// Dashboard pages
import DashboardLayout from "./components/layout/DashboardLayout";
import DashboardHome from "./pages/dashboard/DashboardHome";
import Apps from "./pages/dashboard/Apps";
import BuyCredits from "./pages/dashboard/BuyCredits";
import CreditsOverview from "./pages/dashboard/CreditsOverview";
import Transactions from "./pages/dashboard/Transactions";
import Playground from "./pages/dashboard/Playground";
import Settings from "./pages/dashboard/Settings";
import BulkCampaigns from "./pages/dashboard/BulkCampaigns";
import CreateBulkCampaign from "./pages/dashboard/CreateBulkCampaign";
import BulkCampaignDetail from "./pages/dashboard/BulkCampaignDetail";
import Invoices from "./pages/dashboard/Invoices";
import ContactGroups from "./pages/dashboard/ContactGroups";
import ContactGroupDetail from "./pages/dashboard/ContactGroupDetail";
import MessageTemplates from "./pages/dashboard/MessageTemplates";

// Admin pages
import AdminLayout from "./components/layout/AdminLayout";
import AdminHome from "./pages/admin/AdminHome";
import Packages from "./pages/admin/Packages";
import ApproveTransactions from "./pages/admin/ApproveTransactions";
import Metrics from "./pages/admin/Metrics";
import AdminBulkCampaigns from "./pages/admin/AdminBulkCampaigns";
import AdminCampaignDetail from "./pages/admin/AdminCampaignDetail";

// Protected route component
import ProtectedRoute from "./components/layout/ProtectedRoute";

// v5 dashboard slice (dP Relay v5) — separate Firebase-free subtree at /v5/*
import V5Routes from "./v5/V5Routes.jsx";

function ScrollToTop() {
  const { pathname } = useLocation();
  React.useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

function CatchAll() {
  const navigate = useNavigate();
  React.useEffect(() => {
    navigate("/");
  }, [navigate]);
  return null;
}

function AppRoutes() {
  return (
    <>
      <ScrollToTop />
      <Routes>
        {/* Marketing - Public */}
        <Route path="/" element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="pricing" element={<Pricing />} />
          <Route path="api-docs" element={<APIDocs />} />
          <Route path="contact" element={<Contact />} />
        </Route>

        {/* Auth - Public */}
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />

        {/* Redirects from old URLs */}
        <Route path="/docs" element={<Navigate to="/api-docs" replace />} />
        <Route
          path="/dashboard/api-docs"
          element={<Navigate to="/api-docs" replace />}
        />

        {/* Client Dashboard - Protected */}
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <DashboardLayout />
            </ProtectedRoute>
          }
        >
          <Route index element={<DashboardHome />} />
          <Route path="apps" element={<Apps />} />
          <Route path="buy-credits" element={<BuyCredits />} />
          <Route path="credits-overview" element={<CreditsOverview />} />
          <Route path="transactions" element={<Transactions />} />
          <Route path="playground" element={<Playground />} />
          <Route path="settings" element={<Settings />} />
          <Route path="bulk" element={<BulkCampaigns />} />
          <Route path="bulk/create" element={<CreateBulkCampaign />} />
          <Route path="bulk/:campaignId" element={<BulkCampaignDetail />} />
          <Route path="contact-groups" element={<ContactGroups />} />
          <Route
            path="contact-groups/:groupId"
            element={<ContactGroupDetail />}
          />
          <Route path="templates" element={<MessageTemplates />} />
          <Route path="invoices" element={<Invoices />} />
        </Route>

        {/* Admin Panel - Protected (admin only) */}
        <Route
          path="/admin"
          element={
            <ProtectedRoute requiredRole="admin">
              <AdminLayout />
            </ProtectedRoute>
          }
        >
          <Route index element={<AdminHome />} />
          <Route path="packages" element={<Packages />} />
          <Route path="transactions" element={<ApproveTransactions />} />
          <Route path="metrics" element={<Metrics />} />
          <Route path="bulk" element={<AdminBulkCampaigns />} />
          <Route path="bulk/:campaignId" element={<AdminCampaignDetail />} />
        </Route>

        {/* v5 dashboard slice (dP Relay v5) — own auth provider + guard */}
        <Route path="/v5/*" element={<V5Routes />} />

        {/* 404 Catch-all */}
        <Route path="*" element={<CatchAll />} />
      </Routes>
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
