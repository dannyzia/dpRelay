/**
 * Application shell — route table + navigation for the customer screens.
 *
 * Stage F2 adds the `#/operator` subtree here. Routes are hash-based (see
 * router.ts) so deep links survive any static host without rewrite config.
 */
import { useEffect, useState } from "react";
import { disconnectApp, getConnectedApp, setAppUnauthorizedHandler } from "./api";
import { hrefFor, useRoute } from "./router";
import { BuyCredits } from "./screens/BuyCredits";
import { Credentials } from "./screens/Credentials";
import { Credits } from "./screens/Credits";
import { Docs } from "./screens/Docs";
import { History } from "./screens/History";
import { Login } from "./screens/Login";
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

  useEffect(() => {
    setAppUnauthorizedHandler(() => setConnected(false));
    return () => setAppUnauthorizedHandler(null);
  }, []);

  const section = route[0] ?? "";

  // Docs is public; every other customer screen requires credentials.
  const isCustomerTab = (t: string): t is CustomerTab =>
    TABS.some((tab) => tab.id === t);
  if (section === "" || (connected && !isCustomerTab(section) && section !== "docs")) {
    window.location.hash = hrefFor([connected ? "credits" : "login"]);
  }
  if (!connected && section !== "docs" && section !== "login") {
    window.location.hash = hrefFor(["login"]);
  }
  if (connected && section === "login") {
    window.location.hash = hrefFor(["credits"]);
  }

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
          <a
            href={hrefFor(["docs"])}
            className={section === "docs" ? "nav-link active" : "nav-link"}
          >
            Docs
          </a>
          {connected && (
            <button
              type="button"
              className="nav-link button-link"
              onClick={(): void => {
                disconnectApp();
                setConnected(false);
                window.location.hash = hrefFor(["login"]);
              }}
            >
              Sign out
            </button>
          )}
        </nav>
      </header>

      <main className="content">
        {section === "docs" ? (
          <Docs />
        ) : !connected || section === "login" ? (
          <Login
            onConnected={(): void => {
              setConnected(true);
              window.location.hash = hrefFor(["credits"]);
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
