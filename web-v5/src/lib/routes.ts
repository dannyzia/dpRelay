/**
 * Central route + navigation table (ISSUE-91 "connected" law): the nav the
 * shell renders, the sections the shell can render, and the signed-out
 * sections all come from THIS file, so tests can assert nav ↔ route parity
 * instead of trusting JSX that nobody re-reads.
 *
 * `segments` feed `hrefFor()` — nothing hand-builds hash strings.
 *
 * STAGE F15 (ISSUE-125): the table also encodes the owner's nav spec —
 * public order `Pricing · Docs · FAQ · Help`, customer order
 * `Companies · Balance · Buy credits · Bulk · History · Credentials ·
 * Docs · FAQ`, and no Operator entry (the panel stays reachable at
 * `#/operator` by direct URL only).
 */
import { hrefFor } from "./router";

/** Marketing site origin — the public nav's Pricing/Help and every footer
 *  link out of the app point here (F15). Same host the landing checks pin. */
export const LANDING_BASE = "https://dprelay.digital-papyrus.com";

/** One nav entry: where it points, what it is called, who may see it. */
export interface NavItem {
  /** First hash segment — also the active-state key. */
  id: string;
  label: string;
  /** Segments passed to `hrefFor` (never a raw hash string). */
  segments: string[];
  /** STAGE F15: absolute https target for public entries that live on the
   *  marketing site (Pricing, Help) instead of an in-app hash route. */
  external?: string;
  /** Shown only once app credentials are connected. */
  requiresConnected?: boolean;
  /** Shown only once the session probe resolved to a signed-in user. */
  requiresUser?: boolean;
  /** STAGE F15: marketing entries shown only while signed out — a signed-in
   *  customer gets the fixed customer order, not the public one. */
  requiresAnonymous?: boolean;
}

/** Customer tabs — the connected app's credit tools.
 *  STAGE F15: the "plan" tab leaves the nav (direct URL `#/plan` only); it is
 *  still a KNOWN section, so the deep link never dies. */
export const CUSTOMER_TABS: NavItem[] = [
  { id: "credits", label: "Balance", segments: ["credits"], requiresConnected: true },
  { id: "buy", label: "Buy credits", segments: ["buy"], requiresConnected: true },
  { id: "bulk", label: "Bulk", segments: ["bulk"], requiresConnected: true },
  { id: "history", label: "History", segments: ["history"], requiresConnected: true },
  { id: "credentials", label: "Credentials", segments: ["credentials"], requiresConnected: true },
];

/** The signed-in user's company/app list (F3 post-login hub) — first entry of
 *  the fixed customer order (F15). */
export const COMPANY_NAV: NavItem = {
  id: "apps",
  label: "Companies",
  segments: ["apps"],
  requiresUser: true,
};

/** Sections with no session requirement, rendered straight from the nav.
 *  STAGE F15: Operator is gone (secret-gated panel, direct URL only) and the
 *  two marketing entries bracket Docs/FAQ into the owner's public order. */
export const STATIC_NAV: NavItem[] = [
  {
    id: "pricing",
    label: "Pricing",
    segments: ["pricing"],
    external: `${LANDING_BASE}/pricing/`,
    requiresAnonymous: true,
  },
  { id: "docs", label: "Docs", segments: ["docs"] },
  { id: "faq", label: "FAQ", segments: ["faq"] },
  {
    id: "help",
    label: "Help",
    segments: ["help"],
    external: `${LANDING_BASE}/help/`,
    requiresAnonymous: true,
  },
];

/** Everything the top nav renders, in order. Signed-out visibility filters
 *  this down to Pricing · Docs · FAQ · Help; signed-in to Companies · Balance
 *  · Buy credits · Bulk · History · Credentials · Docs · FAQ (F15). */
export const NAV: NavItem[] = [COMPANY_NAV, ...CUSTOMER_TABS, ...STATIC_NAV];

/** Signed-out-reachable sections (email links + public info pages). */
export const PUBLIC_SECTIONS = ["docs", "faq", "payment", "forgot", "reset", "verify"] as const;

/** True when `section` (first hash segment) is one the shell can render. */
export function isKnownSection(section: string): boolean {
  if (
    section === "" ||
    section === "login" ||
    section === "operator" ||
    section === "apps" ||
    section === "link" ||
    // F15 removed the plan tab from the nav; the screen itself stays routable.
    section === "plan"
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
  if (item.requiresAnonymous === true && state.hasUser) return false;
  return true;
}

/** The href for a nav entry — marketing entries carry their own absolute
 *  URL, in-app entries go through the ONLY place hash hrefs are built. */
export function navHref(item: NavItem): string {
  return item.external ?? hrefFor(item.segments);
}
