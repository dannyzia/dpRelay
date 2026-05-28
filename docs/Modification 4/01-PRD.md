<!--
AI: This is the source of truth for what to build. Read it before writing any code.
Read first: 05-DATA-MODEL.md, 06-API.md
You must: Implement every functional requirement. Treat every acceptance criterion as a pass/fail test.
You must not: Build anything not listed here. Assume scope. Modify acceptance criteria without human approval.
Human reviews this: YES — do not begin implementation until a human has filled in this document.
-->

# Product Requirements: Bulk SMS Enhancements + Dashboard Polish
> **dpRelay Dashboard — Modification 4**
> Scope: Client-facing dashboard + Admin dashboard (React/Vite PWA at `web/`). No Android changes.
> Two tracks: (A) New bulk SMS features, (B) UI/UX polish across both portals.

---

## Problem Statement

**Track A — Bulk SMS Features:**
The existing bulk SMS flow requires users to upload a fresh CSV for every campaign. There is no way to save, reuse, or segment recipients. Message composition starts from scratch every time. After a campaign runs, there is no way to download a delivery report.

**Track B — Dashboard Polish:**
The platform suffers from visual inconsistencies and low information density. The Admin portal uses a dark theme while the Client portal uses a light theme — they share the same domain but feel like two different products. Dashboard home pages (both Admin and Client) show zero live data. Status indicators lack color coding. Raw UUIDs are displayed where human-readable names would be far more useful. The BDT currency symbol (৳) renders incorrectly as `↓`. There are no charts, empty-state designs, or notification indicators anywhere.

---

## Users

| User type | Description | Primary goal |
|-----------|-------------|-------------|
| Client (app owner) | Business running bulk SMS campaigns | Manage contacts, compose from templates, export reports, see credit health at a glance |
| Admin | dpRelay operator | Monitor system health via rich KPI cards, approve transactions quickly, see trends |

---

## Functional Requirements

### Track A — New Bulk SMS Features

#### F1 — Contact Groups (Recipient Lists)
1. A client can create a named **Contact Group** containing a list of phone numbers in E.164 format.
2. A client can view all their contact groups in a table: name, phone count, created date.
3. A client can delete a contact group. Deletion is permanent (no soft delete).
4. A client can upload contacts into a group via CSV (same E.164 validation as current `CsvUploader`).
5. A client can view the members of a contact group (paginated list of phone numbers).
6. When creating a bulk campaign (Step 2 — Recipients), the user can choose between:
   - **Option A:** Upload a CSV (existing behaviour, unchanged).
   - **Option B:** Select one or more saved contact groups. The union of all selected groups is used as the recipient list. Duplicates are de-duplicated server-side before dispatch.
7. A contact group may be used by multiple campaigns simultaneously.
8. Contact groups are scoped per `uid` (Firebase Auth). One client cannot see another client's groups.

#### F2 — Message Templates
1. A client can save a named **Message Template** containing a static SMS body.
2. A client can view all their templates in a list: name, preview (first 80 chars), created date.
3. A client can edit a template's name or body.
4. A client can delete a template. Deletion is permanent.
5. When composing a campaign message (Step 3 — Message), a "Load Template" button opens a picker. Selecting a template pre-fills the message textarea. The user can then edit it before continuing.
6. Templates are scoped per `uid`. One client cannot see another client's templates.
7. Templates are plain text only. No variable substitution (merge fields) in this modification — that is explicitly out of scope.

#### F3 — Delivery Report Export
1. On the `BulkCampaignDetail` page, a **"Download Report"** button is available when campaign `status` is `completed`, `cancelled`, or `failed`.
2. Clicking the button downloads a CSV file named `{campaignName}-report.csv`.
3. The CSV contains one row per recipient with columns: `phone`, `status` (`sent` or `failed`), `errorMessage` (empty if sent), `attemptedAt` (ISO timestamp).
4. The data source is the existing `listFailedRecipients` Cloud Function for failures. Sent recipients are derived from `totalRecipients - failedCount`. The client must paginate if `nextPageToken` is returned (max 5 pages / 50,000 failed recipients).

---

### Track B — Dashboard Polish

#### F4 — Theme Unification
1. The Admin portal and Client portal must use a **single, consistent visual theme**.
2. The chosen theme is **dark** (matching the current Admin portal's `bg-gray-900` aesthetic) — it is more developer-centric, premium, and aligns with the `dpRelay` brand.
3. All Client dashboard pages (`DashboardLayout`, `ClientSidebar`, and all pages under `/dashboard/*`) must be updated to use the dark theme.
4. The `ClientSidebar` must adopt the same color scheme as `AdminSidebar` (bg-gray-900, text-gray-300, active: bg-brand-500 text-white).
5. All page backgrounds, cards, tables, inputs, and text colors in the client portal must be updated for dark theme compatibility.

#### F5 — Client Dashboard Home Enhancements
1. The `/dashboard` home page must show **live credit balance** prominently at the top — a hero banner/card showing aggregate OTP and Bulk SMS credits across all apps.
2. Below the credit banner, show **contextual app cards** — each card shows: app name, OTP credits remaining, Bulk credits remaining, active/inactive status. Replace the current generic text-only nav cards.
3. If any app's credits fall below a configurable threshold (default: 10), show a **low-credit warning banner** (dismissable, amber): "⚠️ {AppName} has {N} OTP credits left. Top up now →".
4. Show a **recent activity feed** — last 5 transactions (from `getTransactions`) inline at the bottom of the home page.

#### F6 — Admin Dashboard Home Enhancements
1. The 4 KPI stat cards on `/admin` must be **color-coded**: green for sent, red for failed, blue for active campaigns, gray for total.
2. Each KPI card should have a **relevant icon** (e.g., `PaperAirplaneIcon` for sent, `ExclamationCircleIcon` for failed, `BoltIcon` for active, `CalendarIcon` for total).
3. Add a **recent pending transactions widget** below the stats — a mini-table showing the 5 latest pending transactions with quick Approve/Reject actions. If none pending, show "✅ All caught up!".
4. The Metrics page (`/admin/metrics`) and Admin Home currently duplicate KPI cards. Merge the Metrics KPIs into the Admin Home. The Metrics page should either be removed or repurposed to show a 7-day OTP trend chart (if F9 is implemented).

#### F7 — Table & Component Polish
1. **BDT Symbol Fix:** The `৳` (taka) symbol currently renders as `↓` on the Transactions page. Fix the unicode rendering — ensure the correct font-family supports Bengali script, or use the literal string `BDT` as a fallback.
2. **Status badges everywhere:** Apply the existing `statusClass` pattern (from `Invoices.jsx`) to:
   - `Transactions.jsx` — currently plain gray text for all statuses.
   - `ApproveTransactions.jsx` — currently only has a single yellow badge for pending.
3. **Resolve app UUIDs to names:** In `Transactions.jsx` and `Invoices.jsx` — wherever an `appId` UUID is displayed, resolve it to the app's human-readable name. The `listApps()` data is already available; use it as a lookup map.
4. **App ID truncation + click-to-copy:** In `Apps.jsx` and any table showing full UUIDs — truncate to first 8 characters + ellipsis, with a copy icon that copies the full ID to clipboard on click.
5. **Relative timestamps:** Add relative time display ("2 hours ago") alongside absolute dates in transaction tables. Use a simple helper like `new Intl.RelativeTimeFormat('en')` — no new dependency.
6. **Empty states:** Every table/page that can show empty data must have a friendly empty-state design: centered icon + message + CTA button. Apply to: `ApproveTransactions`, `Transactions`, `BulkCampaigns`, `CreditsOverview` (if no apps).
7. **Invoices KPI card icons:** Add icons to the 4 summary cards on the Invoices page (CreditCardIcon, BanknotesIcon, DevicePhoneMobileIcon, PaperAirplaneIcon).

#### F8 — Sidebar Enhancements
1. **Pending transaction badge:** On the Admin sidebar, the "Transactions" link must show a red badge count if there are N > 0 pending transactions. Fetch count on mount and update every 30 seconds.
2. **Active-state for sub-pages:** The sidebar must highlight the correct parent item when the user is on a sub-page (e.g., `/dashboard/bulk/create` should highlight "Bulk SMS", `/dashboard/bulk/abc123` should highlight "Bulk SMS"). Currently uses exact path matching — switch to `startsWith` matching.

#### F9 — Charts & Visualizations (Should-Have)
1. **Admin Home — 7-day OTP trend area chart:** Using RTDB `stats/history/{date}` data, render a simple area/line chart showing daily OTP volume for the last 7 days. Use a lightweight charting library (Recharts is acceptable — it's a common React charting lib).
2. **Invoices — Monthly spending bar chart:** Add a bar chart to the Invoices page showing monthly BDT spend. Data source: aggregate from the existing `getInvoiceHistory` response.

---

### Should-Have (Post-MVP, do not implement now)
1. Variable substitution in message templates (e.g., `{name}`, `{order_id}` from CSV columns).
2. Scheduled campaign sending (set a future `scheduledAt` datetime).
3. Sender ID / "From name" configuration per app.
4. Contact group tagging and filtering.
5. App credit history charts per app.

### Explicitly Out of Scope
1. Any changes to the OTP verification flow.
2. Any Android/Kotlin code changes.
3. Admin-side contact or template management.
4. Contact import from external services (Google Contacts, etc.).
5. Variable substitution / merge fields.
6. Campaign scheduling.

---

## Acceptance Criteria

### Track A — Features

| ID | Criterion | Verified by |
|----|-----------|-------------|
| AC-01 | A client can create a contact group with a name and CSV upload; group appears in the list immediately | Manual test |
| AC-02 | A client cannot create a contact group with 0 valid phone numbers | UI validation test |
| AC-03 | A contact group created by client A is not visible to client B | Firestore security rules test |
| AC-04 | Campaign Step 2 shows both "Upload CSV" and "Use Contact Group" options; selecting groups shows the total deduplicated recipient count | Manual test |
| AC-05 | A client can save a message template and load it into a campaign's message step | Manual test |
| AC-06 | A template edited by client A is not visible to client B | Firestore security rules test |
| AC-07 | "Download Report" button only appears when campaign status is completed, cancelled, or failed | Manual test |
| AC-08 | Downloaded CSV contains phone, status, errorMessage, attemptedAt columns | Manual test |
| AC-09 | Contact group deletion removes the Firestore document; it no longer appears in the list | Manual test |
| AC-10 | All new Firestore paths are covered by security rules that enforce `request.auth.uid` scoping | Firestore emulator rules test |

### Track B — Polish

| ID | Criterion | Verified by |
|----|-----------|-------------|
| AC-11 | Client dashboard pages use the same dark theme as Admin pages | Visual inspection |
| AC-12 | BDT symbol `৳` renders correctly on the Transactions page | Visual inspection |
| AC-13 | Client Dashboard home shows live credit balance for all apps | Manual test |
| AC-14 | Low-credit warning banner appears when any app has < 10 credits | Manual test |
| AC-15 | Admin Dashboard KPI cards are color-coded (green/red/blue/gray) with icons | Visual inspection |
| AC-16 | Admin sidebar shows red badge with pending transaction count | Manual test |
| AC-17 | Status badges on Transactions page use green/yellow/red coloring (not plain gray) | Visual inspection |
| AC-18 | App UUIDs in Transactions table resolve to human-readable app names | Manual test |
| AC-19 | Empty transaction table shows friendly empty-state design (not a blank void) | Visual inspection |
| AC-20 | Sidebar highlights "Bulk SMS" when user is on `/dashboard/bulk/create` | Manual test |

---

## Non-Functional Requirements

| Category | Requirement |
|----------|-------------|
| Security | All new Firestore collections must have rules enforcing `request.auth != null && request.auth.uid == resource.data.uid` |
| Performance | Contact group list page loads in < 2s for up to 50 groups |
| Data integrity | Phone numbers stored in contact groups must be validated to E.164 before write |
| No new dependencies | Do not add npm packages not already present in `web/package.json` without flagging. Exception: Recharts is pre-approved for F9 charts. |
| Theme consistency | All pages under both `/dashboard/*` and `/admin/*` must use the same color palette after F4 |
