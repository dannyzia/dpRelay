/**
 * Application shell: semantic landmarks (`<header>` / `<nav>` / `<main>`)
 * plus the navigation rendered from the central route table
 * (`src/lib/routes.ts`) — ISSUE-91 extracted it from App.tsx so the
 * landmarks and nav ↔ route parity are directly render-testable, and so the
 * loading state carries the same landmarks as the loaded app.
 */
import type { ReactNode } from "react";
import { type SessionUser } from "../api";
import { NAV, navHref, navVisible } from "../lib/routes";

/**
 * Landmark frame around one screen.
 *
 * @param props.user session probe result — `undefined` while probing,
 * `null` signed out, otherwise the signed-in user.
 * @param props.connected whether app credentials are in this tab.
 * @param props.section current first hash segment (drives active states).
 * @param props.signOut clears the session and navigates to `#/login`.
 * @param props.children the screen, rendered inside `<main>`.
 */
export function Shell(props: {
  user: SessionUser | null | undefined;
  connected: boolean;
  section: string;
  signOut: () => void;
  children: ReactNode;
}): JSX.Element {
  const hasUser = props.user !== null && props.user !== undefined;
  const visible = NAV.filter((item) =>
    navVisible(item, { hasUser, connected: props.connected }),
  );
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
          {hasUser && <span className="nav-link muted">{props.user?.email}</span>}
          {(hasUser || props.connected) && (
            <button type="button" className="nav-link button-link" onClick={props.signOut}>
              Sign out
            </button>
          )}
        </nav>
      </header>

      <main className="content">{props.children}</main>
    </div>
  );
}
