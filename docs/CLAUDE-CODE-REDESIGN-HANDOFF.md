# Claude Code Handoff: dP Relay Visual Redesign & Content Revamp

> **Objective:** Redesign the user-facing marketing pages (`landing/`) and web dashboard (`web-v5/`) to look visually world-class, premium, and modern, while correcting the core product positioning and copy to reflect dP Relay's true architecture.

---

## 1. 🧠 Core Product Truth & Positioning (Must Reflect Across All Content)

Previous landing pages described dP Relay solely as a "৳0.20 SMS API for Bangladesh". That was an incomplete view. The real architecture consists of **two distinct operational tiers**:

### Tier 1: 🌍 Global BYOD (Bring Your Own Device) — *Primary Offering (Worldwide)*
* **Concept:** Use your own Android phone as a programmable cellular SMS gateway.
* **Target Audience:** Developers, startups, e-commerce stores, and system administrators worldwide.
* **Value Proposition:** Bypass predatory telecom / aggregator markup (Twilio, MessageBird, etc.). Send OTP and Bulk SMS directly through your own cellular carrier plan (unlimited SMS SIMs, local telco bundles) anywhere in the world.
* **How It Works:** Install the lightweight dP Relay Android Gateway app (`authenticator-app`), link it to your app ID in 1 click, and send via REST API.

### Tier 2: 🇧🇩 Dedicated Operator Relay — *Secondary Offering (Bangladesh Only)*
* **Concept:** Turnkey SMS dispatch from dedicated dP Relay pool numbers hosted in Bangladesh.
* **Target Audience:** Bangladeshi businesses, startups, and developers who do not want to keep a physical phone plugged in 24/7.
* **Value Proposition:** High deliverability on Grameenphone, Robi, Banglalink, and Teletalk; instant top-up via bKash automated transaction matching.

---

## 2. 🎨 Visual & Aesthetic Redesign Blueprint

### Color Palette & Tone
* **Theme:** Sleek, high-contrast dark mode with electric accents (slate-950 background `#030712`, card background `#0f172a`, subtle borders `#1e293b`).
* **Accents:** Electric Cyan (`#06b6d4` / `#0ea5e9`), Emerald for healthy states (`#10b981`), Amber for warnings, Rose for errors.
* **Typography:** Inter or Geist for body text, JetBrains Mono or Fira Code for API snippets and IDs.

### Component Design
* **Hero Section:** Eye-catching headline, dual toggle or badge highlighting both modes (BYOD Global vs BD Dedicated), terminal/code interactive preview showing `curl` dispatch, live status pills.
* **Feature Cards:** Glassmorphism backdrop-blur, subtle linear gradient borders on hover, clear iconography.
* **Tables:** Tabular numeric fonts (`tabular-nums`), clean horizontal alignment, sticky headers, subtle alternating row highlight on hover.
* **Code Blocks:** Syntax highlighted, one-click copy button with animated tooltip feedback, language switcher (cURL, Node.js, Python).

---

## 3. 📄 Detailed Page-by-Page Specifications

### A. Marketing Landing Pages (`landing/`)
Hosted on **Cloudflare Pages** (`dprelay.digital-papyrus.com`). Fast, zero-bundle vanilla HTML/CSS.

1. **Homepage (`landing/index.html`)**:
   * **Hero:** *"Turn any Android phone into a cellular SMS gateway — or use our dedicated Bangladesh relay."*
   * **Two Clear Tracks:**
     * Track A: *Your Phone, Your Carrier (Global)* — 0 extra SMS fee, global carrier support, BYOD gateway app.
     * Track B: *Dedicated Cloud Gateway (Bangladesh)* — Shared/dedicated SIM pool, bKash instant recharge, ৳0.20/SMS base rate.
   * **Interactive API Preview:** Live side-by-side comparison of OTP verification vs Bulk broadcast.
   * **Social Proof / Architecture Highlights:** Zero vendor lock-in, open API spec, end-to-end encrypted telemetry.

2. **Pricing Page (`landing/pricing/index.html`)**:
   * **BYOD Tier:** **Free / Self-Hosted Gateway** — You provide the device and SIM; dP Relay platform handles API orchestration and delivery queuing.
   * **Dedicated Bangladesh Pool:** Pre-packaged OTP and Bulk credit tiers (e.g. 500 SMS, 2,000 SMS, 10,000 SMS) payable via bKash.
   * **Validity Info:** Highlight long-term validity options (1 year, 5 years, or effectively lifetime).

3. **Documentation Page (`landing/docs/index.html`)**:
   * Clear navigation sidebar: Quickstart, Device Gateway Setup (BYOD), OTP API, Bulk SMS API, Webhooks, Delivery Receipts, Error Codes.
   * Real code examples with copy-to-clipboard.

4. **FAQ Page (`landing/faq/index.html`)**:
   * Q: *Can I use dP Relay outside Bangladesh?* Yes! Mode 1 (BYOD) works in every country with any Android phone.
   * Q: *How does device pairing work?* Install the APK, paste your app ID, and grant SMS permissions.
   * Q: *What happens if my phone loses connection?* The server queues messages and alerts via watchdog; optional multi-device failover.
   * Q: *Do credits expire?* No surprise expirations — choose packages with up to 10-year validity.

5. **Payment Guide (`landing/payment/index.html`)**:
   * Step-by-step visual walkthrough for bKash Send Money / Merchant payment with TrxID entry for automated instant recharge.

---

### B. Client Dashboard (`web-v5/`)
Hosted on **Render** (`app.dprelay.digital-papyrus.com`). React 18 + Vite 5 + TypeScript.

1. **Dashboard Shell & Header (`web-v5/src/components/Shell.tsx` / `App.tsx`)**:
   * Polished navigation bar with app selector, active balance chip, and quick-link to API credentials.
2. **Device Gateway Onboarding Screen (`web-v5/src/screens/Apps.tsx`)**:
   * Add dedicated section for **"Link Your Android Device"** with QR code / enrollment key to easily pair the BYOD Android Gateway.
3. **Campaigns & Bulk Screen (`web-v5/src/screens/Bulk.tsx`)**:
   * Clean recipient importer (paste numbers or CSV upload), template variable chips (`{{name}}`), and progress bar during broadcast.
4. **Operator Screen (`web-v5/src/screens/Operator.tsx`)**:
   * Maintain the table alignment recently shipped (PR #73 & #74) while polishing typography and badge states.

---

## 4. 🛠️ Build, Test, and Deployment Instructions

### For `landing/` (Cloudflare Pages):
* Directory: `landing/`
* Deployment: Direct upload via Cloudflare Wrangler without build step:
  ```bash
  npx wrangler pages deploy . --project-name=dprelay-landing --branch=main
  ```
  *(API token is securely stored in local keyring under `service dprelay account cloudflare-api-token`)*.

### For `web-v5/` (Render Static Site):
* Directory: `web-v5/`
* Commands:
  ```bash
  npm ci
  npm test       # Must pass all 158 vitest tests
  npm run build  # Builds to web-v5/dist
  ```
* Render auto-deploys from GitHub `master` branch.
* Git Workflow: `git checkout -b <branch>`, commit with `type(scope): subject`, create PR via `gh pr create`, wait for CI checks, and squash-merge via `gh pr merge --squash`.
