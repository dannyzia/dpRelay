/**
 * Application shell — route dispatch for the customer screens.
 *
 * Stage F2 adds the `#/operator` subtree here. Routes are hash-based (see
 * `src/lib/router.ts` + `src/hooks/useRoute.ts`) so deep links survive any
 * static host without rewrite config.
 *
 * STAGE F3 (ISSUE-81) adds the customer-session layer in front of the app
 * plane: `#/login` is now email/password (the raw credential gate is gone),
 * `#/apps` lists the signed-in user's owned apps (post-login hub), and
 * `#/link/:appId` proves an operator-issued app once. The existing customer
 * tabs stay keyed to the selected app's X-App-Id/X-App-Secret credentials in
 * sessionStorage — the session cookie identifies the USER, the app secret
 * authorizes the APP. `#/operator` is untouched.
 *
 * ISSUE-91 (frontend standard): the landmark frame + nav live in
 * `components/Shell.tsx`, rendered from the central table in
 * `lib/routes.ts`; this file owns only gating and screen dispatch.
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
import { Shell } from "./components/Shell";
import { useRoute } from "./hooks/useRoute";
import { hrefFor } from "./lib/router";
import { PUBLIC_SECTIONS, isKnownSection } from "./lib/routes";
import { Apps } from "./screens/Apps";
import { Bulk } from "./screens/Bulk";
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

/** Root component: session probe + gating around `Shell` (see file header). */
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

  const signOut = (): void => {
    // Best-effort server-side session delete; the cookie clears regardless.
    void logoutAccount().catch(() => undefined);
    disconnectApp();
    setUser(null);
    setConnected(false);
    window.location.hash = hrefFor(["login"]);
  };

  const section = route[0] ?? "";
  const isOperator = section === "operator";
  const isApps = section === "apps";
  const isLink = section === "link";
  // STAGE F9 (ISSUE-88): buy-credits is a SESSION flow (wallet top-up) — it
  // no longer requires connected app credentials.
  const isBuy = section === "buy";
  // Signed-out-reachable screens (email links + public info pages).
  const isPublic = (PUBLIC_SECTIONS as readonly string[]).includes(section);
  // Single source of truth for "can this shell render that section" — the
  // same table the nav and the routes test assert against (ISSUE-91).
  const known = isKnownSection(section);
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
        <Shell user={user} connected={connected} section={section} signOut={signOut}>
          <p className="muted">Loading…</p>
        </Shell>
      );
    }
    if (user === null) {
      window.location.hash = hrefFor(["login"]);
    } else if (!connected && !isApps && !isLink && !isBuy) {
      window.location.hash = hrefFor(["apps"]);
    }
  }
  if (connected && section === "login") {
    window.location.hash = hrefFor(["credits"]);
  }
  if (user === null && (isApps || isLink)) {
    window.location.hash = hrefFor(["login"]);
  }

  return (
    <Shell user={user} connected={connected} section={section} signOut={signOut}>
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
      ) : section === "buy" ? (
        <BuyCredits />
      ) : !connected || section === "login" ? (
        <Login
          onSignedIn={(): void => {
            window.location.hash = hrefFor(["apps"]);
          }}
        />
      ) : section === "bulk" ? (
        <Bulk />
      ) : section === "history" ? (
        <History />
      ) : section === "credentials" ? (
        <Credentials />
      ) : (
        <Credits />
      )}
    </Shell>
  );
}
