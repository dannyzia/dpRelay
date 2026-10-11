#!/usr/bin/env node
/**
 * STAGE F6 gate for landing/ (ISSUE-86) — zero-dependency structural checks
 * run by the `landing-checks` CI job and locally via `node scripts/check-landing.mjs`.
 *
 * Why hand-rolled: landing/ is contractually build-free with no package.json,
 * so the gate must run on bare Node. It enforces what the acceptance criteria
 * pin: every page exists, internal links resolve, per-page SEO (title +
 * description + lang + single h1), directory-style clean URLs behind
 * sitemap.xml, absolute app-subdomain CTAs, the owner-verbatim remittance
 * guides, the SMTP-free FAQ rule, and the AGPL identifier gate (agpl-grep.sh
 * does not walk landing/, so the pattern is mirrored here).
 *
 * Exit 0 = all checks pass; exit 1 prints every failure (no early exit, so a
 * single CI run shows the full list).
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "landing");
const BASE_URL = "https://dprelay.digital-papyrus.com";
const APP_URL = "https://app.dprelay.digital-papyrus.com";

/** Every live page the site ships, in site-path form. `/payment/` is a 301
 *  (landing/_redirects) to `/docs/payments/`, so it is deliberately absent. */
const PAGES = [
  { path: "/", file: "index.html" },
  { path: "/pricing/", file: "pricing/index.html" },
  { path: "/docs/", file: "docs/index.html" },
  { path: "/docs/byod/", file: "docs/byod/index.html" },
  { path: "/docs/payments/", file: "docs/payments/index.html" },
  { path: "/faq/", file: "faq/index.html" },
  { path: "/contact/", file: "contact/index.html" },
  { path: "/terms/", file: "terms/index.html" },
  { path: "/privacy/", file: "privacy/index.html" },
  { path: "/acceptable-use/", file: "acceptable-use/index.html" },
];

/** Owner-approved FAQ set must not leak infrastructure strings (AC). */
const FAQ_FORBIDDEN = [
  "smtp",
  "pop3",
  "imap",
  "port 587",
  ":587",
  "mail server",
  "postfix",
  "dovecot",
  "spf",
  "dkim",
  "dmarc",
];

/** AGPL identifier pattern mirrored from scripts/agpl-grep.sh. */
const AGPL_PATTERN = /com\.httpsms|NdoleStudio|HttpSms|httpsms-go|httpsms-node/;/** Owner-verbatim pins — exact strings, never paraphrased.
 *
 *  2026-10-11 (owner decision): the two public bKash wallet-number pins that
 *  used to sit here are redacted — the digits are deliberately not restated in
 *  this comment. This supersedes the hub-event-1243 wording: the copy doc's
 *  Payment guides section removes the public number so every guide points at
 *  the bKash number and recipient name shown on the signed-in Buy credits
 *  screen. The pins below are the identical redacted step sentences that now
 *  appear on /docs/payments/, so the check stays byte-identical without
 *  publishing the wallet number.
 *
 *  Gate: a recursive grep of landing/ for the retired wallet number (raw and
 *  +880-prefixed forms) must return zero matches.
 *  (That scope is landing/ only — the digits still appear elsewhere in the
 *  repo, e.g. server and app test fixtures, which this gate does not cover.)
 */
const PAYMENT_PINS = [
  "How to Send Using TapTap Send",
  "How to Send Using Remitly",
  "How to Send Using Wise",
  "How to Send Using Western Union",
  "How to Send Using WorldRemit",
  "Best for users in the US, UK, Canada, UAE, and Europe.",
  "Best for competitive exchange rates and promotional offers.",
  "Best for getting the mid-market exchange rate with low, transparent fees.",
  "Best for sending online or paying with cash at a brick-and-mortar location.",
  "Available in over 50 countries for fast mobile wallet routing.",
  "Phone Number: Input the bKash number shown on Buy credits.",
  "Phone Number: Type in the bKash number shown on Buy credits.",
];

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "source", "track", "wbr",
]);

const failures = [];
const passes = [];

function pass(msg) {
  passes.push(msg);
}

function fail(msg) {
  failures.push(msg);
}

/** Case-insensitive tag scanner that validates nesting with a stack. */
function checkTagBalance(html, pagePath) {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  const withoutPre = withoutComments.replace(/<pre[\s\S]*?<\/pre>/g, "<pre></pre>");
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;
  const stack = [];
  let match;
  while ((match = tagRe.exec(withoutPre)) !== null) {
    const [, closing, rawName, selfClosing] = match;
    const name = rawName.toLowerCase();
    if (name.startsWith("!")) continue;
    if (closing === "") {
      if (selfClosing === "/" || VOID_TAGS.has(name)) continue;
      stack.push(name);
    } else {
      const top = stack.pop();
      if (top !== name) {
        fail(`${pagePath}: tag mismatch — </${name}> encountered${top ? ` while <${top}> was open` : " with an empty stack"}`);
        return;
      }
    }
  }
  if (stack.length > 0) {
    fail(`${pagePath}: unclosed tag(s): ${stack.join(", ")}`);
  } else {
    pass(`${pagePath}: tags balanced`);
  }
}

/** Resolves href/src attributes; internal targets must exist on disk. */
function checkLinks(html, pagePath, pageFile) {
  const pageDir = dirname(join(SITE, pageFile));
  const attrRe = /(?:href|src)="([^"]*)"/g;
  let match;
  let linkCount = 0;
  while ((match = attrRe.exec(html)) !== null) {
    const raw = match[1];
    if (raw === "" || raw.startsWith("mailto:") || raw.startsWith("tel:")) continue;
    linkCount += 1;
    if (raw.startsWith("https://")) continue;
    if (raw.startsWith("http://")) {
      fail(`${pagePath}: insecure link ${raw} — use https`);
      continue;
    }
    if (raw.startsWith("#")) {
      const id = raw.slice(1);
      if (id !== "" && !html.includes(`id="${id}"`)) {
        fail(`${pagePath}: in-page anchor ${raw} has no matching id`);
      }
      continue;
    }
    const [pathPart] = raw.split("#");
    const [cleanPath] = pathPart.split("?");
    let target;
    if (cleanPath.startsWith("/")) {
      target = cleanPath.endsWith("/")
        ? join(SITE, cleanPath, "index.html")
        : join(SITE, cleanPath);
    } else {
      target = resolve(pageDir, cleanPath);
    }
    if (!existsSync(target)) {
      fail(`${pagePath}: broken internal link ${raw}`);
    }
  }
  pass(`${pagePath}: checked ${linkCount} links`);
}

/** Per-page SEO + semantic structure pins. */
function checkSeoAndStructure(html, pagePath) {
  const titleMatch = html.match(/<title>([^<]*)<\/title>/);
  if (titleMatch === null) {
    fail(`${pagePath}: missing <title>`);
  } else {
    const len = titleMatch[1].length;
    if (len < 20 || len > 75) fail(`${pagePath}: <title> length ${len} outside 20–75`);
    else pass(`${pagePath}: title ok`);
  }
  const descMatches = html.match(/<meta\s+name="description"\s+content="[^"]*"\s*\/?>/g) ?? [];
  if (descMatches.length !== 1) {
    fail(`${pagePath}: expected exactly one meta description, found ${descMatches.length}`);
  } else {
    const content = descMatches[0].match(/content="([^"]*)"/);
    const len = content !== null ? content[1].length : 0;
    if (len < 40 || len > 170) fail(`${pagePath}: meta description length ${len} outside 40–170`);
    else pass(`${pagePath}: meta description ok`);
  }
  if (!html.includes('<html lang="en">')) fail(`${pagePath}: missing <html lang="en">`);
  const h1Count = (html.match(/<h1[\s>]/g) ?? []).length;
  if (h1Count !== 1) fail(`${pagePath}: expected exactly one <h1>, found ${h1Count}`);
  for (const tag of ["<header", "<main", "<footer", "<nav"]) {
    if (!html.includes(tag)) fail(`${pagePath}: missing semantic <${tag.slice(1)}> landmark`);
  }
  if (!html.includes(`rel="canonical" href="${BASE_URL}${pagePath}"`)) {
    fail(`${pagePath}: canonical must be ${BASE_URL}${pagePath}`);
  }
  const ids = html.match(/\sid="([^"]+)"/g) ?? [];
  const seen = new Set();
  for (const idAttr of ids) {
    const id = idAttr.replace(/^\sid="/, "").replace(/"$/, "");
    if (seen.has(id)) fail(`${pagePath}: duplicate id "${id}"`);
    seen.add(id);
  }
}

function checkPage(page) {
  const filePath = join(SITE, page.file);
  if (!existsSync(filePath)) {
    fail(`${page.path}: missing file ${page.file}`);
    return null;
  }
  const html = readFileSync(filePath, "utf8");
  checkSeoAndStructure(html, page.path);
  checkTagBalance(html, page.path);
  checkLinks(html, page.path, page.file);
  if (AGPL_PATTERN.test(html)) {
    fail(`${page.path}: AGPL-derived identifier found (agpl-grep pattern)`);
  }
  return html;
}

// ── Run all checks ──────────────────────────────────────────────────────────

const htmlByPath = new Map();
for (const page of PAGES) {
  const html = checkPage(page);
  if (html !== null) htmlByPath.set(page.path, html);
}

// Home CTAs must be absolute app-subdomain URLs (AC).
// `!= null` (not `!== null`): a missing page is `undefined` in the map, and
// dereferencing it below would crash the gate instead of reporting a failure.
const home = htmlByPath.get("/");
if (home != null) {
  if (home.includes(`${APP_URL}/#/signup`) && home.includes(`${APP_URL}/#/signin`)) {
    pass("/: absolute app-subdomain signup + signin CTAs present");
  } else {
    fail(`/: CTAs must be absolute ${APP_URL}/#/signup and ${APP_URL}/#/signin`);
  }
}

// FAQ: SMTP/infrastructure strings are forbidden (owner flag).
const faq = htmlByPath.get("/faq/");
if (faq != null) {
  const lower = faq.toLowerCase();
  const hits = FAQ_FORBIDDEN.filter((needle) => lower.includes(needle));
  if (hits.length > 0) fail(`/faq/: forbidden infrastructure string(s): ${hits.join(", ")}`);
  else pass("/faq/: no SMTP/infrastructure strings");
  // The copy doc regroups the page into four categories of h3 questions; the
  // category ids and the question count are the "must not shrink silently" pins
  // (the old flat `<h2 id="faq-"> x5` shape no longer describes the page).
  const categories = ["faq-getting-started", "faq-billing", "faq-delivery", "faq-byod"];
  const missingCategories = categories.filter((id) => !faq.includes(`<h2 id="${id}">`));
  if (missingCategories.length > 0) {
    fail(`/faq/: missing category heading(s): ${missingCategories.join(", ")}`);
  } else {
    pass("/faq/: all 4 category headings present");
  }
  const questionCount = (faq.match(/<h3 id="q-/g) ?? []).length;
  if (questionCount !== 14) fail(`/faq/: expected the 14 copy-doc questions, found ${questionCount}`);
  else pass("/faq/: all 14 questions present");
}

// Payment guides: owner-verbatim pins (hub event 1243). The guides moved from
// /payment/ to /docs/payments/ — the pin PATH was retargeted, never the text.
const payments = htmlByPath.get("/docs/payments/");
if (payments != null) {
  const missing = PAYMENT_PINS.filter((pin) => !payments.includes(pin));
  if (missing.length > 0) fail(`/docs/payments/: verbatim guide pin(s) missing: ${missing.join(" | ")}`);
  else pass(`/docs/payments/: all ${PAYMENT_PINS.length} verbatim pins present`);
}

// sitemap.xml: exists, lists exactly PAGES, URLs resolve to files.
const sitemapPath = join(SITE, "sitemap.xml");
if (!existsSync(sitemapPath)) {
  fail("sitemap.xml: missing");
} else {
  const sitemap = readFileSync(sitemapPath, "utf8");
  const locs = [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
  const expected = PAGES.map((p) => `${BASE_URL}${p.path}`);
  for (const url of expected) {
    if (!locs.includes(url)) fail(`sitemap.xml: missing <loc>${url}</loc>`);
  }
  for (const loc of locs) {
    if (!expected.includes(loc)) fail(`sitemap.xml: unexpected <loc>${loc}</loc>`);
    if (!loc.startsWith("https://")) fail(`sitemap.xml: non-https <loc>${loc}</loc>`);
  }
  if (locs.length === expected.length && failures.every((f) => !f.startsWith("sitemap"))) {
    pass(`sitemap.xml: all ${expected.length} URLs present`);
  }
}

// robots.txt: sitemap pointer.
const robotsPath = join(SITE, "robots.txt");
if (!existsSync(robotsPath)) {
  fail("robots.txt: missing");
} else {
  const robots = readFileSync(robotsPath, "utf8");
  if (robots.includes(`Sitemap: ${BASE_URL}/sitemap.xml`)) pass("robots.txt: sitemap pointer ok");
  else fail(`robots.txt: must contain "Sitemap: ${BASE_URL}/sitemap.xml"`);
}

// ── Report ──────────────────────────────────────────────────────────────────

for (const msg of passes) console.log(`PASS  ${msg}`);
if (failures.length > 0) {
  for (const msg of failures) console.error(`FAIL  ${msg}`);
  console.error(`\nlanding checks: ${failures.length} failure(s), ${passes.length} passed`);
  process.exit(1);
}
console.log(`\nlanding checks: all ${passes.length} passed`);
