<!--
AI: This is the source of truth for the database schema. Implement exactly as specified.
Read first: 01-PRD.md (for entities the product needs)
You must: Follow this schema exactly. Keep this doc in sync when schema changes.
You must not: Add fields not listed here. Store timestamps in local time. Use RTDB for these new entities.
Human reviews this: YES — schema changes require human review before any production migration.
-->

# Data Model — Modification 4
**Project:** dpRelay — Bulk SMS Enhancements

---

## Storage Backend for New Entities

> All new entities introduced in this modification use **Cloud Firestore** (NOT Realtime Database).
> The existing RTDB schema (`/verification_requests`, `/health`, `/bulk_progress`, etc.) is unchanged.

---

## New Firestore Collections

### `contactGroups/{groupId}`

A saved list of phone numbers a client can reuse across campaigns.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `groupId` | string | yes (doc ID) | Auto-generated Firestore document ID |
| `uid` | string | yes | Firebase Auth UID of the owner. Set server-side by the Cloud Function from `context.auth.uid`. Never trust client-supplied `uid`. |
| `name` | string | yes | Human-readable group name. Max 100 characters. |
| `phoneCount` | number | yes | Count of valid E.164 phone numbers in the group. Denormalized for display — do not compute client-side. |
| `createdAt` | timestamp | yes | Firestore server timestamp (`FieldValue.serverTimestamp()`). |
| `updatedAt` | timestamp | yes | Updated on any phone list change. |

**Sub-collection:** `contactGroups/{groupId}/phones/{phoneId}`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `phoneId` | string | yes (doc ID) | Auto-generated or the E.164 phone number used as the key (to enforce uniqueness within the group). |
| `phone` | string | yes | E.164 format. Pattern: `/^\+[0-9]{7,15}$/`. Validated before write. |

> **Limitation:** Firestore does not support atomic count updates on sub-collections without a Cloud Function. `phoneCount` on the parent document is written by the Cloud Function `createContactGroup` / `deleteContactGroup` — never by the client directly.

---

### `messageTemplates/{templateId}`

A saved, reusable SMS body.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `templateId` | string | yes (doc ID) | Auto-generated Firestore document ID |
| `uid` | string | yes | Firebase Auth UID of the owner. Set server-side. |
| `name` | string | yes | Human-readable template name. Max 100 characters. |
| `body` | string | yes | SMS message body. Max 1600 characters (10 GSM segments). Plain text only — no merge fields in this modification. |
| `createdAt` | timestamp | yes | Firestore server timestamp. |
| `updatedAt` | timestamp | yes | Updated on any edit. |

---

## Existing Collections — Modifications

### `bulkCampaigns/{campaignId}` (existing — additions only)

Two new optional fields are added to support contact-group-sourced campaigns:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sourceType` | string | no | `'csv'` (default, existing behaviour) or `'contactGroups'`. If absent, treat as `'csv'`. |
| `sourceGroupIds` | array\<string\> | no | Populated when `sourceType == 'contactGroups'`. Array of `groupId` values the campaign was built from. Read-only after campaign creation. |

> **Do not** remove or rename any existing fields on `bulkCampaigns`. This is an additive change only.

---

## Firestore Security Rules (new paths only)

```javascript
// contactGroups — owner-scoped
match /contactGroups/{groupId} {
  allow read, delete: if request.auth != null
                      && request.auth.uid == resource.data.uid;
  allow create: if false; // write via Cloud Function only — uid set server-side
  allow update: if false; // update via Cloud Function only

  match /phones/{phoneId} {
    allow read: if request.auth != null
                && request.auth.uid == get(/databases/$(database)/documents/contactGroups/$(groupId)).data.uid;
    allow write: if false; // write via Cloud Function only
  }
}

// messageTemplates — owner-scoped
match /messageTemplates/{templateId} {
  allow read, delete: if request.auth != null
                      && request.auth.uid == resource.data.uid;
  allow create, update: if false; // write via Cloud Function only
}
```

> **Note:** All writes go through Firebase Cloud Functions using the Admin SDK, which bypasses client-side security rules. Client-side rules above are the safety net — they ensure a client cannot read or delete another client's data even if the function has a bug.

---

## Indexes Required

| Collection | Fields | Type | Reason |
|------------|--------|------|--------|
| `contactGroups` | `uid` ASC, `createdAt` DESC | Composite | List groups for a user, newest first |
| `messageTemplates` | `uid` ASC, `createdAt` DESC | Composite | List templates for a user, newest first |

> Add these indexes to `firestore.indexes.json` before deployment.

---

## Data Lifecycle

| Event | Action |
|-------|--------|
| Client calls `createContactGroup` CF | Creates `contactGroups/{groupId}` + sub-collection `phones/*`. Sets `uid` from `context.auth.uid`. |
| Client calls `deleteContactGroup` CF | Deletes `contactGroups/{groupId}` and all `phones/*` sub-documents (batch delete). |
| Client calls `createMessageTemplate` CF | Creates `messageTemplates/{templateId}`. Sets `uid` from `context.auth.uid`. |
| Client calls `updateMessageTemplate` CF | Updates `name`, `body`, `updatedAt` on existing template. Validates `uid` matches caller. |
| Client calls `deleteMessageTemplate` CF | Deletes `messageTemplates/{templateId}`. Validates `uid` matches caller before delete. |
| Campaign created with `sourceType: 'contactGroups'` | CF reads phones from selected groups, de-duplicates, proceeds with existing campaign dispatch logic. `sourceGroupIds` stored on campaign doc for audit. |
