/**
 * Application shell: semantic landmarks (`<header>` / `<nav>` / `<main>`)
 * plus the navigation rendered from the central route table
 * (`src/lib/routes.ts`) — ISSUE-91 extracted it from App.tsx so the
 * landmarks and nav ↔ route parity are directly render-testable, and so the
 * loading state carries the same landmarks as the loaded app.
 */
import type { ReactNode } from "react";
import { type SessionUser, type Wallet } from "../api";
import { hrefFor } from "../lib/router";
import { LANDING_BASE, NAV, navHref, navVisible } from "../lib/routes";
import { SiteFooter } from "./Footer";

/**
 * Hash target for the topbar "API credentials" jump: the credentials screen
 * once this tab holds app credentials, otherwise the company hub where the
 * app gets unlocked first.
 *
 * @param connected whether app credentials are in this tab.
 * @returns the hash href the jump navigates to.
 */
export function credentialsJump(connected: boolean): string {
  return hrefFor(connected ? ["credentials"] : ["apps"]);
}

/**
 * Landmark frame around one screen.
 *
 * ISSUE-112: the topbar also carries the two quick-glance affordances — the
 * wallet balance chip and the API-credentials jump — rendered as a status
 * chip and a button (not extra anchors) so the nav ↔ route-table parity test
 * keeps asserting that the ONLY hash links in the shell come from the
 * central NAV table.
 *
 * @param props.user session probe result — `undefined` while probing,
 * `null` signed out, otherwise the signed-in user.
 * @param props.connected whether app credentials are in this tab.
 * @param props.section current first hash segment (drives active states).
 * @param props.signOut clears the session and navigates to `#/login`.
 * @param props.wallet last loaded wallet balance — `undefined` when there is
 * no signed-in user to load it for, `null` while it is still loading.
 * STAGE F15 (ISSUE-125): the header also carries the signed-out CTAs
 * (Sign in + Get started → pricing) rendered OUTSIDE the `<nav>` so the
 * nav ↔ route-table parity test keeps asserting that the only links inside
 * the nav are the central NAV table's; the three-column site footer sits
 * below `<main>` on the owner's spec.
 *
 * @param props.children the screen, rendered inside `<main>`.
 */
export function Shell(props: {
  user: SessionUser | null | undefined;
  connected: boolean;
  section: string;
  signOut: () => void;
  wallet?: Wallet | null;
  children: ReactNode;
}): JSX.Element {
  const hasUser = props.user !== null && props.user !== undefined;
  const visible = NAV.filter((item) =>
    navVisible(item, { hasUser, connected: props.connected }),
  );
  const wallet = props.wallet ?? null;
  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">
          dP Relay<span className="brand-sub"> dashboard</span>
        </span>
        <nav className="nav">
          {visible.map((item) => (
            <a
              key={item.id}
              href={navHref(item)}
              className={
                props.section === item.id || (item.id === "apps" && props.section === "link")
                  ? "nav-link active"
                  : "nav-link"
              }
            >
              {item.label}
            </a>
          ))}
          {hasUser && wallet !== null && (
            <span
              className="chip balance-chip"
              data-testid="topbar-balance"
              title="Wallet balance — OTP and bulk SMS remaining"
            >
              <strong>{wallet.otpSmsRemaining}</strong> OTP ·{" "}
              <strong>{wallet.bulkSmsRemaining}</strong> bulk
            </span>
          )}
          {hasUser && (
            <button
              type="button"
              className="nav-link credentials-link"
              data-testid="topbar-credentials"
              onClick={(): void => {
                // Without connected app credentials there is nothing to show
                // on #/credentials, so the jump lands on the company hub
                // where the app is unlocked first.
                window.location.hash = credentialsJump(props.connected);
              }}
            >
              API credentials
            </button>
          )}
          {hasUser && <span className="nav-link muted">{props.user?.email}</span>}
          {(hasUser || props.connected) && (
            <button type="button" className="nav-link button-link" onClick={props.signOut}>
              Sign out
            </button>
          )}
        </nav>
        {!hasUser && (
          <div className="nav-ctas" data-testid="nav-ctas">
            <a className="nav-link" href={hrefFor(["login"])}>
              Sign in
            </a>
            <a className="nav-link cta" href={`${LANDING_BASE}/pricing/`}>
              Get started
            </a>
          </div>
        )}
      </header>

      <main className="content">{props.children}</main>
      <SiteFooter />
    </div>
  );
}
