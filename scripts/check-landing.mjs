#!/usr/bin/env node
/**
 * STAGE F6 gate for landing/ (ISSUE-86) — zero-dependency structural checks
 * run by the `landing-checks` CI job and locally via `node scripts/check-landing.mjs`.
 *
 * 2026-10-11: updated for the second-pass copy rewrite
 * (.kilo/plans/dp-relay-site-copy-full-rewrite.md): payment guides moved from
 * /docs/payments/ to /help/payments/ with a new Help hub at /help/ (both old
 * URLs are 301s in landing/_redirects), FAQ regrouped into four categories of
 * 20 questions, and a redacted-number gate (BD mobile-number regex over the
 * whole landing/ tree — the wallet digits are never restated in this script).
 *
 * Why hand-rolled: landing/ is contractually build-free with no package.json,
 * so the gate must run on bare Node. It enforces what the acceptance criteria
 * pin: every page exists, internal links resolve, per-page SEO (title +
 * description + lang + single h1), directory-style clean URLs behind
 * sitemap.xml, absolute app-subdomain CTAs, the republished-copy pins, the
 * SMTP-free FAQ rule, and the AGPL identifier gate (agpl-grep.sh does not
 * walk landing/, so the pattern is mirrored here).
 *
 * 2026-10-20: STAGE F13 (ISSUE-122) — real-404 gate. landing/404.html must
 * exist, carry noindex, use the site stylesheet and link all 11 pages; a
 * throwaway local static server mirrors the publish-dir contract (unmatched
 * path → 404.html with HTTP 404) and probes the unknown-path 404, the 11 pages
 * 200 and /sitemap.xml + /robots.txt 200. `--production [base-url]` runs the
 * same probes against the live origin — opt-in, never in CI, because the live
 * origin can only pass once this branch merges and deploys. F13 content pins:
 * the owner-verbatim SIM + download sentences and the PDF-derived keep-awake
 * sections on /docs/byod/, and the owner legal block confined to /terms/ and
 * /privacy/ (address nowhere else in landing/).
 *
 * Exit 0 = all checks pass; exit 1 prints every failure (no early exit, so a
 * single CI run shows the full list).
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve, relative, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "landing");
const BASE_URL = "https://dprelay.digital-papyrus.com";
const APP_URL = "https://app.dprelay.digital-papyrus.com";

/** Every live page the site ships, in site-path form. `/payment/` and
 *  `/docs/payments/` are 301s (landing/_redirects) to `/help/payments/`, so
 *  both are deliberately absent. */
const PAGES = [
  { path: "/", file: "index.html" },
  { path: "/pricing/", file: "pricing/index.html" },
  { path: "/docs/", file: "docs/index.html" },
  { path: "/docs/byod/", file: "docs/byod/index.html" },
  { path: "/help/", file: "help/index.html" },
  { path: "/help/payments/", file: "help/payments/index.html" },
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
const AGPL_PATTERN = /com\.httpsms|NdoleStudio|HttpSms|httpsms-go|httpsms-node/;/** Owner-verbatim pins for /help/payments/ — exact strings, never
 *  paraphrased. Pins are pattern-based (sentences from the copy doc §8); no
 *  wallet number or other secret is restated here. */
const PAYMENT_PINS = [
  "Add credits to your dP Relay account",
  "Send the exact amount shown.",
  "Enter the destination number displayed in Buy credits.",
  "Save the transaction ID (TrxID) shown after the payment.",
  "Do not assume that a remittance transaction has a bKash TrxID.",
  "A payment may require manual review before credits are added.",
  "Do not include your app secret.",
  "Do not send confidential transfer references outside the official payment form or verified support process.",
  "If the payment cannot be matched automatically, support may need to review it.",
  "Availability depends on country, currency and the current purchase flow.",
];

/** STAGE F13 (ISSUE-122): owner-ratified sentences for /docs/byod/ — verbatim,
 *  never paraphrased (hub amendment, owner inputs 2026-10-20). */
const BYOD_SIM_SENTENCE =
  "Messages are sent from the SIM of the gateway phone enrolled for your app — one number per company; you choose which phone by enrolling it.";
/** STAGE F16: the public payments page ships the full method guides —
 *  number-free (the bKash wallet number stays retired from the public site;
 *  the number is only ever shown in the authenticated Buy credits screen). */
const PAYMENT_METHODS = ["TapTap Send", "Remitly", "Wise", "Western Union", "WorldRemit"];
const PAYMENT_SAFE_PHRASE = "the destination number displayed in Buy credits";

/** STAGE F16: site-wide SEO pins — OG/social tags, JSON-LD, sitemap lastmod. */
const SEO_GOLDEN = [
  { path: "/", pins: ['property="og:title"', 'property="og:image"', 'application/ld+json', '"@type": "Organization"', '"@type": "WebSite"'] },
  { path: "/faq/", pins: ['application/ld+json', '"@type": "FAQPage"'] },
  { path: "/help/payments/", pins: ['property="og:title"', 'property="og:image"'] },
];
const BYOD_APPROVAL_STATES = ["Requested", "Approved", "Email link", "Install"];

const BYOD_DOWNLOAD_SENTENCE =
  "After your company is created and approved, your personal download link arrives by email — the app is not publicly distributed.";

/** PDF-derived brand coverage the "Keep your phone awake 24/7" section keeps. */
const BYOD_BRANDS = [
  "Samsung — One UI",
  "Xiaomi — MIUI",
  "Oppo / Realme / OnePlus",
  "Vivo / iQOO",
  "Google Pixel — stock Android",
  "Any other Android 13 / 14 phone",
];

/** Owner legal block (F13 amendment): the address appears on /terms/ and
 *  /privacy/ ONLY — the needle is the address so the long-standing footer line
 *  "…by Digital Papyrus. © 2026 …" on every other page is not a false hit. */
const LEGAL_BLOCK = "Digital Papyrus — 7/1-D, R. K. Mission Road, Dhaka 1203, Bangladesh.";
const LEGAL_ADDRESS_NEEDLE = "7/1-D, R. K. Mission Road";
const LEGAL_ALLOWED_FILES = ["terms/index.html", "privacy/index.html"];

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

/** STAGE F13: parse `--production [base-url]` (adds the live-origin HTTP
 *  probes); any other argument is a usage error, reported not thrown. @returns
 *  the production base URL, or null for local-only mode. */
function parseArgs(args) {
  let production = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--production") {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        production = next;
        i += 1;
      } else {
        production = BASE_URL;
      }
    } else {
      fail(`unknown argument "${args[i]}" — usage: node scripts/check-landing.mjs [--production [base-url]]`);
    }
  }
  return production;
}
const productionBase = parseArgs(process.argv.slice(2));

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

// Home hero pins (rewrite doc): the deterministic hero contract markers and
// the hero copy that the scroll-driven scene overlays.
const HERO_PINS = [
  "Send SMS from a number your customers recognize",
  "One message.",
  "Any country your phone can reach.",
  "From your own number.",
  "Start sending free",
];
if (home != null) {
  const missingHero = HERO_PINS.filter((pin) => !home.includes(pin));
  if (missingHero.length > 0) fail(`/: hero pin(s) missing: ${missingHero.join(" | ")}`);
  else pass(`/: all ${HERO_PINS.length} hero pins present`);
  const heroMarkers = ["hero-pin", "hero-scene", "hero-canvas", "hero-fallback", "hero-caption"];
  const missingMarkers = heroMarkers.filter((m) => !home.includes(m));
  if (missingMarkers.length > 0) fail(`/: hero DOM marker(s) missing: ${missingMarkers.join(", ")}`);
  else pass("/: all hero DOM markers present");
  const captionCount = (home.match(/class="hero-caption"/g) ?? []).length;
  if (captionCount !== 3) fail(`/: expected 3 hero captions, found ${captionCount}`);
  else pass("/: 3 hero captions present");
  if (!home.includes('<script src="/assets/hero.js" defer></script>')) {
    fail("/: hero script tag missing or changed");
  } else {
    pass("/: hero script tag present");
  }
  // Spec section 8: the hero loads its seeded data from the committed static
  // world-dots.js (defer = document order, before hero.js) — no runtime fetch.
  const worldDotsAt = home.indexOf('<script src="/assets/world-dots.js" defer></script>');
  const heroTagAt = home.indexOf('<script src="/assets/hero.js" defer></script>');
  if (worldDotsAt === -1 || worldDotsAt > heroTagAt) {
    fail("/: world-dots.js script tag missing or not before hero.js");
  } else {
    pass("/: world-dots.js script tag present and before hero.js");
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
  const categories = ["faq-getting-started", "faq-pricing-payments", "faq-sending-delivery", "faq-account-security"];
  const missingCategories = categories.filter((id) => !faq.includes(`<h2 id="${id}">`));
  if (missingCategories.length > 0) {
    fail(`/faq/: missing category heading(s): ${missingCategories.join(", ")}`);
  } else {
    pass("/faq/: all 4 category headings present");
  }
  const questionCount = (faq.match(/<h3 id="q-/g) ?? []).length;
  if (questionCount !== 20) fail(`/faq/: expected the 20 copy-doc questions, found ${questionCount}`);
  else pass("/faq/: all 20 questions present");
}

// Payment guides: owner-verbatim pins. The guides moved /payment/ →
// /docs/payments/ → /help/payments/ — the pin PATH was retargeted, never the text.
const payments = htmlByPath.get("/help/payments/");
if (payments != null) {
  for (const target of SEO_GOLDEN) {
    const pageHtml = htmlByPath.get(target.path) ?? "";
    const seoMissing = target.pins.filter((pin) => !pageHtml.includes(pin));
    if (seoMissing.length > 0) fail(`${target.path}: SEO pin(s) missing: ${seoMissing.join(" | ")}`);
    else pass(`${target.path}: all ${target.pins.length} SEO pins present`);
  }

  const missing = PAYMENT_PINS.filter((pin) => !payments.includes(pin));
  if (missing.length > 0) fail(`/help/payments/: verbatim guide pin(s) missing: ${missing.join(" | ")}`);
  else pass(`/help/payments/: all ${PAYMENT_PINS.length} verbatim pins present`);
  if (!payments.includes(PAYMENT_SAFE_PHRASE)) {
    fail(`/help/payments/: the number-free destination phrase is missing — the bKash wallet number stays retired from the public site`);
  } else pass(`/help/payments/: number-free destination phrase present`);
  const methodMissing = PAYMENT_METHODS.filter((m) => !payments.includes(m));
  if (methodMissing.length > 0) fail(`/help/payments/: method guide(s) missing: ${methodMissing.join(" | ")}`);
  else pass(`/help/payments/: all ${PAYMENT_METHODS.length} method guides present`);
  const bdNumbers = (payments.match(/(?<![\d.])(?:\+?880|0)1[3-9]\d{8}\b/g) ?? []).length;
  if (bdNumbers > 0) fail(`/help/payments/: ${bdNumbers} raw BD mobile number(s) found — the wallet number stays retired from the public site`);
  else pass(`/help/payments/: no raw BD mobile numbers`);

}

// Redaction gate: the bKash wallet number is retired from the public site.
// Pattern-based (no digits restated): any Bangladesh mobile number, raw or
// +880-prefixed, anywhere in landing/ — html, css, js, svg, xml, txt, json.
// Support WhatsApp channel: published deliberately by the owner (on-the-record
// decision, 2026-10-12) — the release hold applies to the draft markers only;
// this channel is intentionally final and un-held. Owner-confirmed distinct
// from the retired bKash wallet number. Exemption is deliberately narrow:
// exactly three match-shapes of one number; every other BD mobile number
// still trips the gate.
const REDACT_SCAN_EXT = new Set([".html", ".css", ".js", ".svg", ".xml", ".txt", ".json"]);
const REDACT_PATTERN = /(?<![\d.])(?:\+?880|0)1[3-9]\d{8}\b/g;
const SUPPORT_WHATSAPP_EXEMPTIONS = [
  /https:\/\/wa\.me\/8801713249520/g,
  /\+880\s?1713[- ]?249520/g,
  /\+8801713249520/g,
];
function checkRedaction() {
  const hits = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!REDACT_SCAN_EXT.has(extname(entry.name))) continue;
      let text = readFileSync(p, "utf8");
      for (const rx of SUPPORT_WHATSAPP_EXEMPTIONS) {
        text = text.replace(rx, "");
      }
      for (const m of text.matchAll(REDACT_PATTERN)) {
        hits.push(`${relative(ROOT, p)}: BD mobile pattern found`);
      }
    }
  }
  walk(SITE);
  if (hits.length > 0) fail(`redaction gate: ${hits.length} hit(s) — ${hits.join("; ")}`);
  else pass("redaction gate: no BD mobile-number patterns anywhere in landing/");
}
checkRedaction();

// Release gate (parallax.md §15): owner-note markup and bracketed editorial
// placeholders are draft-only. With RELEASE_GATE=1 the gate fails on them so
// a release cannot ship unresolved notes; draft mode reports the count and
// passes. The bracket pattern covers every placeholder form currently in the
// tree ([legal …], [country], [add …], [state …], [app …]) plus common forms.
const NOTE_CLASS_NEEDLES = ['class="owner-note"', 'class="internal-note"'];
const NOTE_BRACKET_RE = /\[(?:legal|country|add|state|app|insert|todo|draft|verify|optional)\b[^\]]*\]/gi;
function checkReleaseGate() {
  const hits = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!REDACT_SCAN_EXT.has(extname(entry.name))) continue;
      const text = readFileSync(p, "utf8");
      for (const needle of NOTE_CLASS_NEEDLES) {
        if (text.includes(needle)) hits.push(`${relative(ROOT, p)}: owner-note markup`);
      }
      for (const m of text.matchAll(NOTE_BRACKET_RE)) {
        hits.push(`${relative(ROOT, p)}: bracketed editorial note "${m[0]}"`);
        break; // one report per file is enough to locate it
      }
    }
  }
  walk(SITE);
  if (process.env.RELEASE_GATE === "1") {
    if (hits.length > 0) {
      fail(`release gate: ${hits.length} draft marker(s) — ${hits.join("; ")}`);
    } else {
      pass("release gate: no draft markers (RELEASE_GATE=1)");
    }
  } else {
    pass(`release gate: draft mode — ${hits.length} draft marker(s) present (set RELEASE_GATE=1 to fail on these)`);
  }
}
checkReleaseGate();

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

// ── STAGE F13 (ISSUE-122): 404 page, owner content, HTTP behaviour ──────────

/** Every text file under landing/ (the extension set the redaction gate
 *  already scans) as absolute paths — reused by the legal-block placement. */
function landingTextFiles(dir = SITE) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...landingTextFiles(p));
    else if (REDACT_SCAN_EXT.has(extname(entry.name))) out.push(p);
  }
  return out;
}

// 404.html: exists, no-index, same stylesheet, exactly one h1, links to every
// real page. Deliberately NOT in PAGES — it is not a live page, must never be
// canonicalised, and must stay out of sitemap.xml (the sitemap check pins 11).
const notFoundFile = join(SITE, "404.html");
if (!existsSync(notFoundFile)) {
  fail("404.html: missing — unmatched paths cannot render a branded 404");
} else {
  const nf = readFileSync(notFoundFile, "utf8");
  checkTagBalance(nf, "/404.html");
  checkLinks(nf, "/404.html", "404.html");
  if (/<meta name="robots" content="noindex/.test(nf)) pass("404.html: noindex meta present");
  else fail('404.html: missing <meta name="robots" content="noindex…">');
  if (nf.includes('rel="stylesheet" href="/styles.css"')) pass("404.html: uses /styles.css");
  else fail("404.html: must link the site stylesheet /styles.css");
  const missingLinks = PAGES.filter((p) => !nf.includes(`href="${p.path}"`)).map((p) => p.path);
  if (missingLinks.length > 0) fail(`404.html: missing link(s) to ${missingLinks.join(", ")}`);
  else pass(`404.html: links all ${PAGES.length} real pages`);
  const nfH1 = (nf.match(/<h1[\s>]/g) ?? []).length;
  if (nfH1 !== 1) fail(`404.html: expected exactly one <h1>, found ${nfH1}`);
  if (AGPL_PATTERN.test(nf)) fail("404.html: AGPL-derived identifier found");
}

// /docs/byod/ content pins: owner-verbatim sentences (hub amendment) and the
// PDF-derived "Keep your phone awake 24/7" build (ruling: the PDF replaces the
// pending Android-steps placeholder entirely).
const byod = htmlByPath.get("/docs/byod/");
if (byod != null) {
  const pins = [
    ["ratified SIM sentence", BYOD_SIM_SENTENCE],
    ["enrollment-gated download sentence", BYOD_DOWNLOAD_SENTENCE],
    ["keep-awake heading", "<h2>Keep your phone awake 24/7</h2>"],
    ["every-phone checklist heading", ">Do this on every phone</h3>"],
    ["reboot-test heading", "How to prove it's working"],
    ["PDF link target", 'href="/assets/SMS-Gateway-Phone-Keep-Alive-Guide.pdf"'],
    ["PDF link text", "Complete setup guide (PDF)"],
  ];
  const missing = pins.filter(([, needle]) => !byod.includes(needle)).map(([label]) => label);
  if (missing.length > 0) fail(`/docs/byod/: F13 pin(s) missing: ${missing.join(" | ")}`);
  else pass(`/docs/byod/: all ${pins.length} F13 content pins present`);
  const approvalStates = BYOD_APPROVAL_STATES.filter((st) => !byod.includes(st));
  if (approvalStates.length > 0) fail(`/docs/byod/: approval-state(s) missing: ${approvalStates.join(" | ")}`);
  else pass(`/docs/byod/: all ${BYOD_APPROVAL_STATES.length} approval states present`);
  const missingBrands = BYOD_BRANDS.filter((brand) => !byod.includes(brand));
  if (missingBrands.length > 0) fail(`/docs/byod/: keep-awake brand section(s) missing: ${missingBrands.join(" | ")}`);
  else pass(`/docs/byod/: all ${BYOD_BRANDS.length} brand sections present`);
}
const smFile = readFileSync(join(SITE, "sitemap.xml"), "utf8");
  if (!smFile.includes("<lastmod>")) fail("/sitemap.xml: lastmod missing");
  else pass("/sitemap.xml: lastmod present");
  if (existsSync(join(SITE, "assets/SMS-Gateway-Phone-Keep-Alive-Guide.pdf"))) {
  pass("landing/assets: keep-alive PDF hosted");
} else {
  fail("landing/assets/SMS-Gateway-Phone-Keep-Alive-Guide.pdf: missing — /docs/byod/ links it");
}

// Legal block placement: the owner address appears on /terms/ and /privacy/
// ONLY (owner: buried only in the Terms/Privacy pages), and both pages carry
// the block verbatim.
{
  const offenders = landingTextFiles()
    .filter((p) => readFileSync(p, "utf8").includes(LEGAL_ADDRESS_NEEDLE))
    .map((p) => relative(SITE, p))
    .filter((p) => !LEGAL_ALLOWED_FILES.includes(p));
  if (offenders.length > 0) {
    fail(`legal block address outside terms/ + privacy/: ${offenders.join(", ")}`);
  } else {
    pass("legal block address confined to terms/ + privacy/");
  }
  for (const allowed of LEGAL_ALLOWED_FILES) {
    if (readFileSync(join(SITE, allowed), "utf8").includes(LEGAL_BLOCK)) {
      pass(`${allowed}: owner-verbatim legal block present`);
    } else {
      fail(`${allowed}: owner-verbatim legal block missing`);
    }
  }
}

// ── STAGE F15 (ISSUE-125): public nav + footer spec ───────────────────────

/** Owner's fixed public nav: Pricing · Docs · FAQ · Help, then the two
 *  signed-out CTAs (Sign in + Get started → pricing). No Operator. */
const NAV_LINKS = [
  ["/pricing/", "Pricing"],
  ["/docs/", "Docs"],
  ["/faq/", "FAQ"],
  ["/help/", "Help"],
];

/** Owner's three-column footer link sets — exact order, exact labels. */
const FOOTER_COLUMNS = [
  ["Product", [["/pricing/", "Pricing"], ["/docs/", "Docs"], ["/docs/byod/", "BYOD guide"]]],
  ["Support", [["/help/", "Help"], ["/help/payments/", "Payments help"], ["/faq/", "FAQ"], ["/contact/", "Contact"]]],
  ["Legal", [["/terms/", "Terms"], ["/privacy/", "Privacy"], ["/acceptable-use/", "Acceptable use"]]],
];

/** F15 nav + footer pins for one page's HTML. */
function checkNavAndFooter(html, label) {
  // Public nav order, then the two CTAs. aria-current moves with the page but
  // never changes the ORDER, so strip the attribute before comparing.
  const navMatch = html.match(/<nav aria-label="Main">[\s\S]*?<\/nav>/);
  if (navMatch === null) {
    fail(`${label}: missing <nav aria-label="Main">`);
  } else {
    const nav = navMatch[0].replace(/\s+aria-current="page"/g, "");
    const links = [...nav.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]);
    const expected = [
      ...NAV_LINKS,
      ["https://app.dprelay.digital-papyrus.com/#/signin", "Sign in"],
      ["/pricing/", "Get started"],
    ];
    if (JSON.stringify(links) !== JSON.stringify(expected)) {
      fail(`${label}: public nav is ${JSON.stringify(links)}, expected ${JSON.stringify(expected)}`);
    } else {
      pass(`${label}: public nav is Pricing · Docs · FAQ · Help + Sign in / Get started`);
    }
    if (nav.includes("operator")) fail(`${label}: Operator must not appear in the public nav`);
  }

  const footerMatch = html.match(/<footer class="site-footer">[\s\S]*?<\/footer>/);
  if (footerMatch === null) {
    fail(`${label}: missing <footer class="site-footer">`);
    return;
  }
  const footer = footerMatch[0];
  const headings = [...footer.matchAll(/<p class="footer-heading">([^<]+)<\/p>/g)].map((m) => m[1]);
  if (headings.join("|") !== "Product|Support|Legal") {
    fail(`${label}: footer headings are ${headings.join("|")}, expected Product|Support|Legal`);
  } else {
    pass(`${label}: footer carries the three Product/Support/Legal columns`);
  }
  for (const [heading, links] of FOOTER_COLUMNS) {
    const col = footer.match(
      new RegExp(`<p class="footer-heading">${heading}<\\/p>[\\s\\S]*?<ul>([\\s\\S]*?)<\\/ul>`),
    );
    const found = col === null
      ? null
      : [...col[1].matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]);
    if (JSON.stringify(found) !== JSON.stringify(links)) {
      fail(`${label}: footer ${heading} column is ${JSON.stringify(found)}, expected ${JSON.stringify(links)}`);
    }
  }
  if (!footer.includes("dP Relay — OTP &amp; bulk SMS API · © Digital Papyrus")) {
    fail(`${label}: footer brand line missing (dP Relay — OTP & bulk SMS API · © Digital Papyrus)`);
  }
  if (!footer.includes('class="footer-status"') || !footer.includes("All systems operational")) {
    fail(`${label}: footer status indicator (All systems operational → /health) missing`);
  }
  if (footer.includes("owner-note")) {
    fail(`${label}: footer must not carry an owner-note placeholder (nothing else in the footer)`);
  }
  if (footer.includes("#/operator")) {
    fail(`${label}: footer must not link the operator panel`);
  }
}

for (const page of PAGES) {
  const html = htmlByPath.get(page.path);
  if (html !== null) checkNavAndFooter(html, page.path);
}
{
  const nf = readFileSync(join(SITE, "404.html"), "utf8");
  checkNavAndFooter(nf, "/404.html");
}

// No payment surface may link the operator panel anywhere on the site.
{
  const offenders = landingTextFiles()
    .filter((p) => readFileSync(p, "utf8").includes("#/operator"))
    .map((p) => relative(SITE, p));
  if (offenders.length > 0) fail(`#/operator referenced on the landing site: ${offenders.join(", ")}`);
  else pass("landing: no #/operator link anywhere");
}

// F15 amendment: /pricing/ carries a "How to pay" link next to each price
// table, pointing at the canonical /help/payments/ guides.
{
  const pricing = htmlByPath.get("/pricing/");
  if (pricing != null) {
    const howToPay = (pricing.match(/<a href="\/help\/payments\/">How to pay<\/a>/g) ?? []).length;
    if (howToPay < 1) fail("/pricing/: missing the 'How to pay' link to /help/payments/");
    else pass(`/pricing/: ${howToPay} 'How to pay' link(s) → /help/payments/`);
  }
}

// HTTP behaviour of the published tree (Defect 1 acceptance): an unmatched
// path answers 404 (with our noindex 404.html body), every real page 200,
// sitemap + robots 200. Local mode mirrors the static host's publish-dir
// semantics on a throwaway 127.0.0.1 server so CI gates this with zero
// network; the live origin can only pass after merge + deploy, which is why
// production probing stays opt-in via --production (owner/orchestrator).
const HTTP_TARGETS = [
  { path: "/this-page-does-not-exist/", expect: 404 },
  ...PAGES.map((p) => ({ path: p.path, expect: 200 })),
  { path: "/sitemap.xml", expect: 200 },
  { path: "/robots.txt", expect: 200 },
];

/** extension → Content-Type for the throwaway local server. */
const LOCAL_CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
};

/** Map a request path to a file under landing/, or null — never escapes SITE.
 *  Directory-style URLs (/pricing/ → pricing/index.html) match how the static
 *  host publishes the tree; anything else falls through to the 404. */
function resolveStatic(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const candidates = decoded.endsWith("/")
    ? [join(SITE, decoded, "index.html")]
    : [join(SITE, decoded), join(SITE, decoded, "index.html")];
  for (const candidate of candidates) {
    const abs = resolve(candidate);
    if (!abs.startsWith(SITE + sep)) continue;
    if (existsSync(abs) && statSync(abs).isFile()) return abs;
  }
  return null;
}

/** Throwaway HTTP server reproducing the publish-dir 404 contract. */
function startLocalServer() {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const file = resolveStatic(pathname);
    if (file !== null) {
      res.writeHead(200, { "content-type": LOCAL_CONTENT_TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(readFileSync(file));
      return;
    }
    const notFoundPage = join(SITE, "404.html");
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end(existsSync(notFoundPage) ? readFileSync(notFoundPage) : "404");
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      done({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

/** Assert one path's status against a base URL; an expected 404 must also
 *  serve the noindex 404.html body, not a bare server error page. */
async function checkHttpTarget(base, target, label) {
  let status = 0;
  let body = "";
  try {
    const res = await fetch(new URL(target.path, base), {
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    status = res.status;
    if (target.expect === 404) body = await res.text();
  } catch (err) {
    fail(`${label}: ${target.path} — request failed (${err instanceof Error ? err.message : String(err)})`);
    return;
  }
  if (status !== target.expect) {
    fail(`${label}: ${target.path} returned HTTP ${status}, expected ${target.expect}`);
    return;
  }
  pass(`${label}: ${target.path} → HTTP ${status}`);
  if (target.expect === 404 && !body.includes('name="robots"')) {
    fail(`${label}: ${target.path} answered 404 without the noindex 404.html body`);
  }
}

const localServer = await startLocalServer();
for (const target of HTTP_TARGETS) {
  await checkHttpTarget(localServer.base, target, "landing-checks local");
}
localServer.server.closeAllConnections();
localServer.server.close();

if (productionBase !== null) {
  for (const target of HTTP_TARGETS) {
    await checkHttpTarget(productionBase, target, `production(${productionBase})`);
  }
}

  if (productionBase !== null) {
    const prodSm = await (await fetch(productionBase + "/sitemap.xml")).text();
    if (!prodSm.includes("<lastmod>")) fail(`production: /sitemap.xml lastmod missing`);
    else pass("production: /sitemap.xml lastmod present");
  }


// ── Report ──────────────────────────────────────────────────────────────────

for (const msg of passes) console.log(`PASS  ${msg}`);
if (failures.length > 0) {
  for (const msg of failures) console.error(`FAIL  ${msg}`);
  console.error(`\nlanding checks: ${failures.length} failure(s), ${passes.length} passed`);
  process.exit(1);
}
console.log(`\nlanding checks: all ${passes.length} passed`);
