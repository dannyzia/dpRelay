<!--
AI: This is the source of truth for every screen's layout and interactive states. Implement exactly as specified.
Read first: 01-PRD.md (which screens exist), 07-USER-FLOWS.md (how screens connect)
You must: Implement every state listed (loading, empty, error, success). Apply responsive rules at every breakpoint.
You must not: Render a screen that has no empty state or error state defined. Use color alone to convey meaning.
Human reviews this: YES — agree on UI spec before building components.
-->

# UI Spec — Modification 4
**Project:** dpRelay — Bulk SMS Enhancements + Dashboard Polish

> **Design convention:** After theme unification (F4), ALL pages use the dark theme:
> - Page background: `bg-gray-900`
> - Card background: `bg-gray-800`
> - Card border: `border-gray-700`
> - Primary text: `text-white` / `text-gray-100`
> - Secondary text: `text-gray-400`
> - Muted text: `text-gray-500`
> - Input background: `bg-gray-700 border-gray-600 text-white`
> - Brand accent: `brand-500` (#10b981) / `brand-600` (#059669)
> - Status badges: same colors as Invoices.jsx `statusClass` pattern

---

# TRACK A — New Feature Pages

---

## New Page: Contact Groups
Route: `/dashboard/contact-groups`
Sidebar label: "Contact Groups"
Sidebar icon: `UserGroupIcon` (Heroicons)

### Layout
```
[Page header row]
  [h1 text-white] "Contact Groups"
  [p text-gray-400] "Save and reuse recipient lists across campaigns."
  [div flex gap-2]
    [span text-sm text-gray-500] "{N} / 50 groups used"
    [Button: primary] "New Group"

[Table card bg-gray-800 border-gray-700]
  [thead text-gray-400] NAME | PHONES | CREATED | ACTIONS
  [tbody rows text-gray-100]
    [Name cell] group name
    [Phones cell] "{N} numbers" (text-gray-400)
    [Created cell] relative date (text-gray-500 text-sm)
    [Actions cell]
      [Button: outline sm] "View"
      [Button: danger sm] "Delete"
```

### States

| State | Trigger | Behavior |
|-------|---------|----------|
| Loading | Page first mounts | Table shows centered "Loading..." spinner |
| Empty | 0 groups | Empty state: centered `UserGroupIcon` (xl, text-gray-600) + "No contact groups yet." (text-gray-400) + "New Group" button |
| Error | `listContactGroups` throws | Red banner: "Unable to load contact groups. [Retry]" |
| Success | Groups loaded | Table renders rows |
| Limit reached | `groups.length >= 50` | "New Group" button disabled with tooltip "50 group limit reached" |

### "New Group" Modal

Triggered by: "New Group" button click.

```
[Modal — max-w-lg bg-gray-800 border-gray-700]
  [Modal title text-white] "Create Contact Group"
  [Form]
    [Label text-gray-300] "Group Name"
    [Input bg-gray-700 border-gray-600 text-white] placeholder: "e.g. Weekly Promo Customers"
    [Label text-gray-300] "Phone Numbers"
    [CsvUploader component] (reuse existing — update colors for dark theme)
    [PhonePreviewTable component] (reuse existing)
  [Footer]
    [Button: outline] "Cancel"
    [Button: primary disabled until valid] "Save Group"
    [Spinner inline] shown while saving
```

**Save button disabled when:** name is empty OR validCount === 0 OR invalidCount > 0.

### Delete Confirmation
```
"Delete '{name}'? This will not affect campaigns already created."
[Confirm] [Cancel]
```

> **Gap 2 — Campaign reference warning.** If checking `sourceGroupIds` is feasible, show: `"This group was used by X campaign(s). Deleting it will not affect those campaigns."`
> For MVP, a static disclaimer on all deletions is acceptable.

---

## New Page: Contact Group Detail
Route: `/dashboard/contact-groups/:groupId`

### Layout
```
[Page header row]
  [Back link text-brand-400] "← Contact Groups"
  [h1 text-white] "{group.name}"
  [p text-gray-400] "{group.phoneCount} phone numbers"

[Card bg-gray-800]
  [Table]
    [thead text-gray-400] PHONE NUMBER
    [tbody text-gray-100] one row per phone
    [tfoot] Pagination: "Showing 1–100 of {total}" + [Prev] [Next]
```

### States
| State | Behavior |
|-------|----------|
| Loading | "Loading phones..." spinner |
| Empty | "This group has no phone numbers." |
| Error | Red banner |

---

## New Page: Message Templates
Route: `/dashboard/templates`
Sidebar label: "Templates"
Sidebar icon: `DocumentTextIcon`

### Layout
```
[Page header row]
  [h1 text-white] "Message Templates"
  [p text-gray-400] "Save reusable SMS message bodies for your campaigns."
  [Button: primary] "New Template"

[Template cards — grid 1 col sm:2 col gap-4]
  [Card per template bg-gray-800 border-gray-700]
    [Header row]
      [p font-semibold text-white] template name
      [div flex gap-2]
        [Button: outline sm] "Edit"
        [Button: danger sm] "Delete"
    [Body preview — text-sm text-gray-400 line-clamp-3]
      first 160 chars of body...
    [Footer — text-xs text-gray-500]
      "Updated {relative date}"
```

### States
| State | Trigger | Behavior |
|-------|---------|----------|
| Loading | Page mounts | 3 skeleton cards (animate-pulse, bg-gray-700) |
| Empty | 0 templates | "No templates yet. Create one to speed up campaign setup." + "New Template" button |
| Error | Load fails | Red banner |
| Limit reached | `templates.length >= 100` | "New Template" button disabled |

### New/Edit Template Modal
```
[Modal — max-w-xl bg-gray-800]
  [Modal title text-white] "New Template" or "Edit Template"
  [Form]
    [Label text-gray-300] "Template Name"
    [Input bg-gray-700 text-white] placeholder: "e.g. Weekly Sale"
    [Label text-gray-300] "Message Body"
    [MessageInput component with maxLength={1600}]
    ⚠️ Gap 1: MessageInput must allow up to 1,600 characters in template context.
    The segment counter displays normally (1,600 chars = 10 GSM segments).
  [Footer]
    [Button: outline] "Cancel"
    [Button: primary] "Save"
```

---

## Modified: Campaign Creation — Step 2 (Recipients)

**File:** `web/src/pages/dashboard/CreateBulkCampaign.jsx`

### Change: Tab switcher above the CSV uploader

```
[Tab row bg-gray-700 rounded-lg p-1]
  [Tab: "Upload CSV"]  ← existing behaviour, unchanged
  [Tab: "Use Contact Groups"]  ← new

--- When "Upload CSV" tab is active ---
[CsvUploader] (existing, unchanged)
[PhonePreviewTable] (existing, unchanged)

--- When "Use Contact Groups" tab is active ---
[Contact Group picker]
  [Loading state] "Loading your groups..."
  [Empty state] "No saved groups. [Create one →]"
  [Group list — checkbox rows bg-gray-700 rounded]
    [Checkbox] {group.name} — {group.phoneCount} numbers
  [Summary row text-gray-400]
    "X groups selected · Y total recipients"
```

### Validation (contact groups tab)
- "Continue" disabled if no groups selected.
- If `listContactGroups` fails: inline error, "Upload CSV" tab available as fallback.

---

## Modified: Campaign Creation — Step 3 (Message Content)

**File:** `web/src/pages/dashboard/CreateBulkCampaign.jsx`

### Change: "Load Template" button above MessageInput

```
[Row: flex justify-between items-center]
  [h2 text-white] "Message Content"
  [Button: outline sm] "Load Template"  ← (hidden if 0 templates)

[MessageInput] (existing, unchanged — standard campaign length limit)
```

### Template Picker (dropdown panel)
```
[Dropdown panel bg-gray-700 border-gray-600 max-h-64 overflow-y-auto rounded-lg shadow-xl]
  [List rows]
    [Row per template hover:bg-gray-600 rounded p-3]
      [p font-medium text-white] template name
      [p text-xs text-gray-400 truncate] body preview
```

Selecting a template pre-fills the MessageInput. User can edit freely.

---

## Modified: BulkCampaignDetail — Download Report Button

**File:** `web/src/pages/dashboard/BulkCampaignDetail.jsx`

### Change: Add "Download Report" button in header

```
[Page header row]
  [h1 text-white] {campaign.campaignName}
  [div flex gap-2]
    [Button: outline sm] "Back to campaigns"  ← existing
    [Button: secondary sm] "Download Report"   ← new (only when completed/cancelled/failed)
```

### Download button states
| State | Behavior |
|-------|----------|
| Not shown | Campaign status is `sending`, `paused`, or `queued` |
| Idle | Shows "Download Report" |
| Loading | Shows "Preparing..." with spinner; button disabled |
| Error | Toast: "Unable to generate report. Try again." |

### CSV format
```
phone,status,errorMessage,attemptedAt
+8801711111111,sent,,
+8801811111111,failed,RESULT_ERROR_NO_SERVICE,2026-05-21T12:34:56Z
```
File name: `{campaignName}-report.csv` (sanitised).

> **Gap 5 — Pagination.** If `listFailedRecipients` returns a `nextPageToken`, loop (max 5 pages = 50,000 failed recipients). If truncated, append: `"# Report truncated — exceeded 50,000 failed recipients."` Tooltip on button: "Reports cover up to 50,000 failed recipients."

---

# TRACK B — Dashboard Polish Pages

---

## F4 — Theme Unification: Client Portal Dark Theme

### Files to modify
- `web/src/components/layout/DashboardLayout.jsx` — change `bg-gray-50` → `bg-gray-900`
- `web/src/components/layout/ClientSidebar.jsx` — adopt AdminSidebar color scheme
- All files under `web/src/pages/dashboard/` — update card/table/input/text colors

### ClientSidebar Color Changes
| Element | Current (light) | New (dark) |
|---------|-----------------|------------|
| Background | `bg-white` | `bg-gray-900` |
| Border | `border-gray-200` | `border-gray-700` |
| Active item | `bg-brand-50 text-brand-700` | `bg-brand-500 text-white` |
| Inactive item | `text-gray-700 hover:bg-gray-50` | `text-gray-300 hover:bg-gray-700` |
| Logo area | light variant | dark variant with brand accent |
| Bottom user section | light bg | `bg-gray-800` |

### Card Color Pattern (all dashboard pages)
| Element | Current | New |
|---------|---------|-----|
| Card bg | `bg-white` | `bg-gray-800` |
| Card border | `border-gray-200` / `shadow-sm` | `border border-gray-700` |
| Card title | `text-gray-900` | `text-white` |
| Card subtitle | `text-gray-600` | `text-gray-400` |
| Input bg | `bg-white border-gray-300` | `bg-gray-700 border-gray-600 text-white` |
| Table header | `text-gray-500` | `text-gray-400` |
| Table row | `text-gray-900` | `text-gray-100` |
| Table row hover | `hover:bg-gray-50` | `hover:bg-gray-700` |

---

## F5 — Enhanced Client Dashboard Home (`/dashboard`)

**File:** `web/src/pages/dashboard/DashboardHome.jsx`

### New Layout (replaces current 4 plain cards)
```
[Welcome banner]
  [h1 text-white] "Welcome back, {displayName}"
  [p text-gray-400] "Here's an overview of your account."

[Credit Balance Hero — full-width card bg-gray-800 border-brand-500/20]
  [Row flex justify-around]
    [Stat block]
      [label text-gray-400 text-sm] "Total OTP Credits"
      [value text-3xl font-bold text-brand-400] "{totalOtpCredits}"
    [Stat block]
      [label text-gray-400 text-sm] "Total Bulk Credits"
      [value text-3xl font-bold text-brand-400] "{totalBulkCredits}"
    [Stat block]
      [label text-gray-400 text-sm] "Active Apps"
      [value text-3xl font-bold text-white] "{activeAppCount}"

[Low-credit warning — if any app has < 10 credits]
  [Alert amber bg-yellow-900/30 border-yellow-700 text-yellow-200]
    "⚠️ {AppName} has {N} OTP credits left. [Top up now →]"

[App cards grid — 2 col]
  [Card per app bg-gray-800 border-gray-700]
    [Header] App name + Active/Inactive badge
    [Row] OTP Credits: {N} | Bulk Credits: {N}
    [Row text-gray-500 text-sm] Expires: {date}
    [Actions] [Buy Credits] [View Details]

[Recent Activity — last 5 transactions]
  [Section header text-gray-400] "Recent Activity"
  [Mini table bg-gray-800]
    [Row per transaction] Date · App Name · Type · Amount · Status badge
  [Footer link text-brand-400] "View all transactions →"
```

### Data fetching
- `listApps()` on mount — for credit balances and app info
- `getTransactions({ limit: 5 })` on mount — for recent activity

### States
| State | Behavior |
|-------|----------|
| Loading | Skeleton cards (animate-pulse, bg-gray-700) |
| No apps | "You have no apps yet. [Register your first app →]" |
| All apps healthy | No warning banner |
| Low credits | Amber warning banner |

---

## F6 — Enhanced Admin Dashboard Home (`/admin`)

**File:** `web/src/pages/admin/AdminHome.jsx`

### New Layout (replaces current plain cards)
```
[Page header]
  [h1 text-white] "Admin Dashboard"
  [p text-gray-400] "System overview and quick actions."

[KPI Cards grid — 4 col]
  [Card: "Bulk Sent Today" bg-gray-800 border-l-4 border-green-500]
    [Icon: PaperAirplaneIcon text-green-400]
    [Value text-3xl font-bold text-white] "{bulk_sent_today}"
    [Label text-gray-400] "Bulk Sent Today"
  [Card: "Bulk Failed Today" bg-gray-800 border-l-4 border-red-500]
    [Icon: ExclamationCircleIcon text-red-400]
    [Value] "{bulk_failed_today}"
  [Card: "Active Campaigns" bg-gray-800 border-l-4 border-blue-500]
    [Icon: BoltIcon text-blue-400]
    [Value] "{bulk_active_campaigns}"
  [Card: "Campaigns Today" bg-gray-800 border-l-4 border-gray-500]
    [Icon: CalendarIcon text-gray-400]
    [Value] "{bulk_total_today}"

[Two-column layout below cards]
  [Left col 2/3]
    [Section: "Recent Pending Approvals" bg-gray-800]
      [Mini table — max 5 rows]
        App · Package · Amount · Requested · [Approve] [Reject]
      [Empty state if 0 pending] "✅ All caught up! No pending transactions."
      [Footer link] "View all transactions →"
  [Right col 1/3]
    [Quick Actions card bg-gray-800]
      [Link buttons — stacked]
        "Manage Packages →"
        "View Metrics →"
        "Bulk Campaigns →"
```

### Data fetching
- Existing RTDB `stats` listener (unchanged)
- `getTransactions({ status: 'pending', limit: 5 })` on mount — for recent pending widget

---

## F7 — Table & Component Polish

### BDT Symbol Fix
**Files:** `web/src/pages/dashboard/Transactions.jsx`, any file using `৳`

Ensure the font stack includes a font that supports Bengali script. Options:
- Add `'Noto Sans Bengali'` to the font-family fallback chain in `tailwind.config.js`
- Or replace `৳` with the string `BDT ` as a prefix (simpler, guaranteed to render)

### Status Badges — Transactions.jsx
**Current:** All statuses use `bg-gray-100 text-gray-700` (no differentiation).

**New:** Apply the same `statusClass` helper from `Invoices.jsx`:
| Status | Badge |
|--------|-------|
| approved | `bg-green-900/50 text-green-300` (dark theme adapted) |
| pending | `bg-yellow-900/50 text-yellow-300` |
| rejected | `bg-red-900/50 text-red-300` |
| default | `bg-gray-700 text-gray-300` |

> Note: Badge colors above are dark-theme adapted versions of the existing light-theme badges in Invoices.jsx.

### Status Badges — ApproveTransactions.jsx
**Current:** Single `bg-yellow-900 text-yellow-200` for pending.

**New:** Add badges for approved/rejected in the transaction history view (if F6.4 adds history tab).

### UUID → App Name Resolution
**Files:** `Transactions.jsx`, `Invoices.jsx`

**Implementation:** Call `listApps()` on mount, build a `Map<appId, appName>`. In table cells, display `appNameMap.get(row.appId) || row.appId.slice(0, 8) + '...'`.

### App ID Click-to-Copy
**File:** `Apps.jsx`

```
[App ID cell]
  [span text-mono text-sm text-gray-400] "{appId.slice(0, 8)}..."
  [button onClick=copyToClipboard title="Copy App ID"]
    [ClipboardDocumentIcon w-4 h-4 text-gray-500 hover:text-brand-400]
  [Tooltip on success] "Copied!"
```

Use `navigator.clipboard.writeText(fullAppId)` — no dependency needed.

### Relative Timestamps
**Files:** `Transactions.jsx`, `ApproveTransactions.jsx`

```
[td]
  [span text-gray-100] "2 hours ago"
  [span text-xs text-gray-500 block] "May 21, 2026 12:34 PM"
```

Helper function:
```js
function relativeTime(date) {
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const diff = (date - Date.now()) / 1000;
  if (Math.abs(diff) < 60) return rtf.format(Math.round(diff), 'second');
  if (Math.abs(diff) < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (Math.abs(diff) < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}
```

### Empty States
Apply to all tables/pages that can show empty data.

```
[Empty state — centered in card bg-gray-800, py-16]
  [Icon xl text-gray-600] (context-specific icon)
  [h3 text-gray-400 mt-4] "No {items} yet."
  [p text-gray-500 text-sm mt-2] Context message
  [Button primary sm mt-4] CTA
```

| Page | Icon | Message | CTA |
|------|------|---------|-----|
| ApproveTransactions | `CheckCircleIcon` | "All caught up! No pending transactions." | — |
| Transactions | `DocumentTextIcon` | "No transactions yet." | "Buy Credits →" |
| BulkCampaigns | `PaperAirplaneIcon` | "No campaigns yet." | "Create Campaign →" |
| CreditsOverview (no apps) | `CubeIcon` | "Register an app to get started." | "Register App →" |

### Invoices KPI Card Icons
**File:** `Invoices.jsx`

| Card | Icon |
|------|------|
| Credit Purchases | `CreditCardIcon` |
| Total Spent | `BanknotesIcon` |
| OTP Sent | `DevicePhoneMobileIcon` |
| Bulk Delivered | `PaperAirplaneIcon` |

---

## F8 — Sidebar Enhancements

### Pending Transaction Badge (Admin Sidebar)
**File:** `web/src/components/layout/AdminSidebar.jsx`

```
[Transactions nav item]
  [span] "Transactions"
  [badge if pendingCount > 0]
    [span bg-red-500 text-white text-xs rounded-full px-1.5 py-0.5 ml-2]
      "{pendingCount}"
```

**Data:** Fetch pending count on mount via `getTransactions({ status: 'pending', limit: 1 })` and read the `total` from response (or use a lightweight count endpoint if available). Re-fetch every 30 seconds via `setInterval`.

### Active-State Sub-Page Fix
**Files:** `ClientSidebar.jsx`, `AdminSidebar.jsx`

**Current:** `pathname === item.path` (exact match).
**New:** `pathname === item.path || pathname.startsWith(item.path + '/')` (prefix match).

Exception: `/dashboard` must still use exact match (otherwise it would match everything).

---

## F9 — Charts (Should-Have)

### Admin Home — 7-Day OTP Trend
**File:** `web/src/pages/admin/AdminHome.jsx` (or extracted to a component)

```
[Card bg-gray-800 col-span-full mt-6]
  [Header] "7-Day OTP Volume"
  [AreaChart height=200]
    X-axis: last 7 dates
    Y-axis: OTP count
    Fill: brand-500 with 20% opacity
    Stroke: brand-400
```

**Data source:** RTDB `stats/history/{YYYY-MM-DD}` — read last 7 keys, extract `total_today` per day.

> ⚠️ FLAG: This requires adding `recharts` as a new dependency. Pre-approved in PRD.

---

## Sidebar Changes Summary

**File:** `web/src/components/layout/ClientSidebar.jsx`

Full sidebar after all changes (dark theme, new entries):

```
[Sidebar bg-gray-900 border-r border-gray-700]
  [Logo area] dpRelay brand
  [Nav items]
    Dashboard         → /dashboard (HomeIcon)
    Your Apps         → /dashboard/apps (CubeIcon — currently uses no distinct icon, verify)
    Buy Credits       → /dashboard/buy-credits (CreditCardIcon)
    Transactions      → /dashboard/transactions (DocumentTextIcon)
    Invoices          → /dashboard/invoices (DocumentChartBarIcon)
    --- Bulk SMS section (if bulkEnabled) ---
    Bulk Campaigns    → /dashboard/bulk (PaperAirplaneIcon — or existing)
    Contact Groups    → /dashboard/contact-groups (UserGroupIcon) ← NEW
    Templates         → /dashboard/templates (DocumentTextIcon) ← NEW
    ---
    API Playground    → /dashboard/playground (CommandLineIcon)
    API Docs          → /api-docs (BookOpenIcon)
    Settings          → /dashboard/settings (CogIcon)
    --- Admin section (if admin) ---
    Admin Panel       → /admin (CogIcon)
```
