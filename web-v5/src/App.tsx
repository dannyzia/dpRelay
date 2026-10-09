/**
 * Application shell — route table + navigation for the customer screens.
 *
 * Stage F2 adds the `#/operator` subtree here. Routes are hash-based (see
 * router.ts) so deep links survive any static host without rewrite config.
 *
 * STAGE F3 (ISSUE-81) adds the customer-session layer in front of the app
 * plane: `#/login` is now email/password (the raw credential gate is gone),
 * `#/apps` lists the signed-in user's owned apps (post-login hub), and
 * `#/link/:appId` proves an operator-issued app once. The existing customer
 * tabs stay keyed to the selected app's X-App-Id/X-App-Secret credentials in
 * sessionStorage — the session cookie identifies the USER, the app secret
 * authorizes the APP. `#/operator` is untouched.
 */
import { useEffect, useState } from "react";
import {
  disconnectApp,
  getConnectedApp,
  logoutAccount,
  setAppUnauthorizedHandler,
  getCurrentUser,
  type SessionUser,
} from "./api";
import { hrefFor, useRoute } from "./router";
import { Apps } from "./screens/Apps";
import { BuyCredits } from "./screens/BuyCredits";
import { Credentials } from "./screens/Credentials";
import { Credits } from "./screens/Credits";
import { Docs } from "./screens/Docs";
import { Faq } from "./screens/Faq";
import { ForgotPassword } from "./screens/ForgotPassword";
import { History } from "./screens/History";
import { LinkApp } from "./screens/LinkApp";
import { Login } from "./screens/Login";
import { Operator } from "./screens/Operator";
import { Payment } from "./screens/Payment";
import { ResetPassword } from "./screens/ResetPassword";
import { VerifyEmail } from "./screens/VerifyEmail";
import "./styles.css";

type CustomerTab = "credits" | "buy" | "history" | "credentials";

const TABS: { id: CustomerTab; label: string }[] = [
  { id: "credits", label: "Balance" },
  { id: "buy", label: "Buy credits" },
  { id: "history", label: "History" },
  { id: "credentials", label: "Credentials" },
];

export function App(): JSX.Element {
  const route = useRoute();
  const [connected, setConnected] = useState<boolean>(() => getConnectedApp() !== null);
  // null = probing /v5/auth/me once on mount; then the user or signed-out.
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);

  useEffect(() => {
    setAppUnauthorizedHandler(() => setConnected(false));
    getCurrentUser()
      .then((me) => setUser(me))
      .catch(() => setUser(null));
    return () => setAppUnauthorizedHandler(null);
  }, []);

  const section = route[0] ?? "";
  const isOperator = section === "operator";

  const isCustomerTab = (t: string): t is CustomerTab =>
    TABS.some((tab) => tab.id === t);
  const isApps = section === "apps";
  const isLink = section === "link";
  // Signed-out-reachable screens (email links + public info pages).
  const isPublic =
    section === "docs" ||
    section === "faq" ||
    section === "payment" ||
    section === "forgot" ||
    section === "reset" ||
    section === "verify";
  const known =
    section === "" ||
    section === "login" ||
    isPublic ||
    isOperator ||
    isApps ||
    isLink ||
    isCustomerTab(section);
  if (!known || section === "") {
    window.location.hash = hrefFor([
      user ? (connected ? "credits" : "apps") : "login",
    ]);
  }
  // Public-ish planes: operator has its own unlock, docs/faq/payment/email
  // links need no account; everything else waits for the session probe.
  if (!isOperator && !isPublic && section !== "login") {
    if (user === undefined) {
      return (
        <div className="shell">
          <main className="content">
            <p className="muted">Loading…</p>
          </main>
        </div>
      );
    }
    if (user === null) {
      window.location.hash = hrefFor(["login"]);
    } else if (!connected && !isApps && !isLink) {
      window.location.hash = hrefFor(["apps"]);
    }
  }
  if (connected && section === "login") {
    window.location.hash = hrefFor(["credits"]);
  }
  if (user === null && (isApps || isLink)) {
    window.location.hash = hrefFor(["login"]);
  }

  const signOut = (): void => {
    // Best-effort server-side session delete; the cookie clears regardless.
    void logoutAccount().catch(() => undefined);
    disconnectApp();
    setUser(null);
    setConnected(false);
    window.location.hash = hrefFor(["login"]);
  };

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">
          dP Relay<span className="brand-sub"> dashboard</span>
        </span>
        <nav className="nav">
          {connected &&
            TABS.map((tab) => (
              <a
                key={tab.id}
                href={hrefFor([tab.id])}
                className={section === tab.id ? "nav-link active" : "nav-link"}
              >
                {tab.label}
              </a>
            ))}
          {user !== null && user !== undefined && (
            <a
              href={hrefFor(["apps"])}
              className={isApps || isLink ? "nav-link active" : "nav-link"}
            >
              Apps
            </a>
          )}
          <a
            href={hrefFor(["docs"])}
            className={section === "docs" ? "nav-link active" : "nav-link"}
          >
            Docs
          </a>
          <a
            href={hrefFor(["faq"])}
            className={section === "faq" ? "nav-link active" : "nav-link"}
          >
            FAQ
          </a>
          <a
            href={hrefFor(["operator"])}
            className={isOperator ? "nav-link active" : "nav-link"}
          >
            Operator
          </a>
          {user !== null && user !== undefined && (
            <span className="nav-link muted">{user.email}</span>
          )}
          {(user !== null && user !== undefined || connected) && (
            <button
              type="button"
              className="nav-link button-link"
              onClick={signOut}
            >
              Sign out
            </button>
          )}
        </nav>
      </header>

      <main className="content">
        {isOperator ? (
          <Operator route={route} />
        ) : section === "docs" ? (
          <Docs />
        ) : section === "faq" ? (
          <Faq />
        ) : section === "payment" ? (
          <Payment />
        ) : section === "forgot" ? (
          <ForgotPassword />
        ) : section === "reset" ? (
          <ResetPassword token={route[1] !== undefined ? decodeURIComponent(route[1]) : ""} />
        ) : section === "verify" ? (
          <VerifyEmail token={route[1] !== undefined ? decodeURIComponent(route[1]) : ""} />
        ) : section === "login" || user === null ? (
          <Login
            onSignedIn={(): void => {
              getCurrentUser()
                .then((me) => setUser(me))
                .catch(() => setUser(null));
              window.location.hash = hrefFor(["apps"]);
            }}
          />
        ) : isApps ? (
          <Apps
            emailVerifiedAt={user?.emailVerifiedAt ?? null}
            onOpenApp={(): void => {
              setConnected(true);
              window.location.hash = hrefFor(["credits"]);
            }}
            onLinkExisting={(): void => {
              window.location.hash = hrefFor(["link"]);
            }}
          />
        ) : isLink ? (
          <LinkApp
            prefillAppId={route[1] !== undefined ? decodeURIComponent(route[1]) : ""}
            onLinked={(): void => {
              setConnected(true);
              window.location.hash = hrefFor(["credits"]);
            }}
            onBack={(): void => {
              window.location.hash = hrefFor(["apps"]);
            }}
          />
        ) : !connected || section === "login" ? (
          <Login
            onSignedIn={(): void => {
              window.location.hash = hrefFor(["apps"]);
            }}
          />
        ) : section === "buy" ? (
          <BuyCredits />
        ) : section === "history" ? (
          <History />
        ) : section === "credentials" ? (
          <Credentials />
        ) : (
          <Credits />
        )}
      </main>
    </div>
  );
}
