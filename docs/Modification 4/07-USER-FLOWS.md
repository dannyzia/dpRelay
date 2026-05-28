<!--
AI: This document maps how users navigate through the new screens and features.
Read first: 01-PRD.md, 08-UI-SPEC.md
You must: Ensure navigation paths in code match these flows.
Human reviews this: YES — agree on user flows before implementation.
-->

# User Flows — Modification 4
**Project:** dpRelay — Bulk SMS Enhancements + Dashboard Polish

---

## Flow 1: Create a Contact Group

**Goal:** Save a list of phone numbers for reuse in future campaigns.
**Role:** Client

1. **Dashboard Home:** User clicks "Contact Groups" in sidebar.
2. **Contact Groups Page:** User sees list of existing groups. User clicks "New Group".
3. **Modal:** User enters group name and uploads/pastes a CSV of phone numbers.
4. **Validation:** Client-side parses CSV and shows valid/invalid counts. User must fix any invalid numbers (e.g., missing country code).
5. **Submit:** User clicks "Save Group".
6. **Backend:** Cloud Function `createContactGroup` receives name and phones. Validates limits (max 50 groups). De-duplicates phones. Saves to Firestore.
7. **Success:** Modal closes. New group appears in the table.

## Flow 2: View/Delete a Contact Group

**Goal:** Review members of a group or remove an obsolete group.
**Role:** Client

1. **Contact Groups Page:** User sees table row for "Weekly Promo Customers".
2. **View Action:** User clicks "View".
3. **Group Detail Page:** User is navigated to `/dashboard/contact-groups/{groupId}`. Page displays paginated list of phone numbers (100 per page). User clicks "Back".
4. **Delete Action:** User clicks "Delete" on the table row.
5. **Confirmation:** System prompts: "Delete 'Weekly Promo Customers'? This will not affect campaigns already created."
6. **Execution:** User clicks "Confirm". `deleteContactGroup` function deletes the document and subcollections. Row is removed from table.

## Flow 3: Create and Use a Message Template

**Goal:** Save a standard SMS text and load it during campaign creation.
**Role:** Client

1. **Dashboard Home:** User clicks "Templates" in sidebar.
2. **Templates Page:** User clicks "New Template".
3. **Modal:** User enters name ("Eid Greeting") and types the message body. Segment counter shows character/segment usage (up to 1,600 chars).
4. **Submit:** User clicks "Save". Template appears as a card on the page.
5. **Campaign Creation:** Later, user goes to `/dashboard/bulk/create`.
6. **Message Step (Step 3):** User clicks "Load Template".
7. **Picker:** Dropdown appears showing saved templates. User selects "Eid Greeting".
8. **Result:** The textarea is pre-filled with the template body. User can freely edit the text before continuing to Step 4.

## Flow 4: Create Campaign Using Contact Groups

**Goal:** Send a campaign using saved groups instead of a raw CSV upload.
**Role:** Client

1. **Bulk Campaigns:** User clicks "Create Campaign".
2. **Step 1 (Details):** User enters campaign name and selects App ID. Continues.
3. **Step 2 (Recipients):** User sees two tabs: "Upload CSV" and "Use Contact Groups". User selects "Use Contact Groups".
4. **Group Selection:** User sees list of their saved groups with checkboxes. User selects "Group A" (100 phones) and "Group B" (50 phones).
5. **Summary:** UI shows "2 groups selected · 150 total recipients" (deduplicated count is shown if possible client-side, otherwise union count). User clicks "Continue".
6. **Step 3 (Message):** User enters message or loads template. Continues.
7. **Step 4 (Review):** User confirms details. User clicks "Submit Campaign".
8. **Backend:** `createBulkCampaign` function receives `sourceType: "contactGroups"` and `sourceGroupIds: ["idA", "idB"]`. Backend fetches all phones from those groups, de-duplicates them, and proceeds with standard dispatch flow.

## Flow 5: Export Delivery Report

**Goal:** Download a CSV report of sent and failed messages for a completed campaign.
**Role:** Client

1. **Bulk Campaigns:** User clicks "View" on a campaign with status `completed`, `cancelled`, or `failed`.
2. **Campaign Detail Page:** User sees campaign stats and the "Download Report" button in the header.
3. **Action:** User clicks "Download Report".
4. **Processing:** UI shows loading state ("Preparing...").
5. **Backend Data:** Client fetches all failed recipients via `listFailedRecipients` (paginating if necessary, up to 5 pages / 50k).
6. **Merge:** Client calculates sent recipients (`totalRecipients - failedCount`) and builds a merged CSV in memory.
7. **Download:** Browser triggers download of `{campaignName}-report.csv`.

## Flow 6: Admin Monitors System Health

**Goal:** Review daily stats and pending transactions quickly.
**Role:** Admin

1. **Login:** Admin logs in and is routed to `/admin`.
2. **KPIs:** Admin immediately sees color-coded KPI cards: Bulk Sent Today (Green), Failed (Red), Active (Blue), Total (Gray).
3. **Chart (Should-Have):** Admin sees a 7-day OTP volume trend chart to gauge weekly performance.
4. **Transactions:** Admin glances at the "Recent Pending Approvals" widget. Sees 2 pending top-ups.
5. **Action:** Admin clicks "Approve" directly from the mini-table. Transaction is processed instantly.
6. **Sidebar Badge:** Admin notices the red badge on the "Transactions" sidebar link drops from "2" to "0".
