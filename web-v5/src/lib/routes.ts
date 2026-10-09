/**
 * Central route + navigation table (ISSUE-91 "connected" law): the nav the
 * shell renders, the sections the shell can render, and the signed-out
 * sections all come from THIS file, so tests can assert nav ↔ route parity
 * instead of trusting JSX that nobody re-reads.
 *
 * `segments` feed `hrefFor()` — nothing hand-builds hash strings.
 */
import { hrefFor } from "./router";

/** One nav entry: where it points, what it is called, who may see it. */
export interface NavItem {
  /** First hash segment — also the active-state key. */
  id: string;
  label: string;
  /** Segments passed to `hrefFor` (never a raw hash string). */
  segments: string[];
  /** Shown only once app credentials are connected. */
  requiresConnected?: boolean;
  /** Shown only once the session probe resolved to a signed-in user. */
  requiresUser?: boolean;
}

/** Customer tabs — the connected app's credit tools. */
export const CUSTOMER_TABS: NavItem[] = [
  { id: "credits", label: "Balance", segments: ["credits"], requiresConnected: true },
  { id: "buy", label: "Buy credits", segments: ["buy"], requiresConnected: true },
  { id: "bulk", label: "Bulk", segments: ["bulk"], requiresConnected: true },
  { id: "history", label: "History", segments: ["history"], requiresConnected: true },
  { id: "credentials", label: "Credentials", segments: ["credentials"], requiresConnected: true },
];

/** The signed-in user's company/app list (F3 post-login hub). */
export const COMPANY_NAV: NavItem = {
  id: "apps",
  label: "Companies",
  segments: ["apps"],
  requiresUser: true,
};

/** Sections with no session requirement, rendered straight from the nav. */
export const STATIC_NAV: NavItem[] = [
  { id: "docs", label: "Docs", segments: ["docs"] },
  { id: "faq", label: "FAQ", segments: ["faq"] },
  { id: "operator", label: "Operator", segments: ["operator"] },
];

/** Everything the top nav renders, in order. */
export const NAV: NavItem[] = [...CUSTOMER_TABS, COMPANY_NAV, ...STATIC_NAV];

/** Signed-out-reachable sections (email links + public info pages). */
export const PUBLIC_SECTIONS = ["docs", "faq", "payment", "forgot", "reset", "verify"] as const;

/** True when `section` (first hash segment) is one the shell can render. */
export function isKnownSection(section: string): boolean {
  if (
    section === "" ||
    section === "login" ||
    section === "operator" ||
    section === "apps" ||
    section === "link"
  ) {
    return true;
  }
  if ((PUBLIC_SECTIONS as readonly string[]).includes(section)) return true;
  return CUSTOMER_TABS.some((tab) => tab.id === section);
}

/** Visibility rule for one nav entry (used by the Shell and the nav tests). */
export function navVisible(
  item: NavItem,
  state: { hasUser: boolean; connected: boolean },
): boolean {
  if (item.requiresConnected === true && !state.connected) return false;
  if (item.requiresUser === true && !state.hasUser) return false;
  return true;
}

/** The hash href for a nav entry — the ONLY place nav hrefs are built. */
export function navHref(item: NavItem): string {
  return hrefFor(item.segments);
}
