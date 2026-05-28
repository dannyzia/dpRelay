<!--
AI: This is the API contract for all new Cloud Functions in Modification 4.
Read first: 05-DATA-MODEL.md (for field types and Firestore paths), 01-PRD.md (for auth requirements)
You must: Return exactly the fields listed. Enforce every validation rule. Handle every listed error code.
You must not: Add undocumented fields to responses. Return stack traces to clients. Skip input validation.
Human reviews this: YES — the API contract must not change without human approval.
-->

# API Contract — Modification 4
**Project:** dpRelay — Bulk SMS Enhancements
**Runtime:** Firebase Cloud Functions (callable functions via `httpsCallable`)
**Auth:** All functions require Firebase Auth (`context.auth` must be present). No anonymous access.

> All new functions are Firebase **callable functions** (`onCall`), not raw HTTP endpoints.
> This means:
> - Auth is handled automatically via the Firebase SDK — `context.auth.uid` is the verified caller.
> - Clients call them via `firebase.functions().httpsCallable('functionName')`.
> - Error format follows Firebase callable error convention: `{ code: 'functions/...-error', message: '...' }`.

---

## Standard Error Codes

| Firebase error code | Meaning |
|---------------------|---------|
| `functions/unauthenticated` | Caller is not signed in |
| `functions/invalid-argument` | Missing or invalid field in request |
| `functions/not-found` | Document does not exist |
| `functions/permission-denied` | Caller's UID does not match resource owner |
| `functions/resource-exhausted` | Rate limit exceeded |
| `functions/internal` | Unexpected server error |

---

## Contact Group Functions

### `createContactGroup`

Creates a new contact group with an uploaded phone list.

**Request**
| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `name` | string | yes | Non-empty, max 100 characters |
| `phones` | string[] | yes | Array of E.164 strings. Min 1. Max 10,000. Each must match `/^\+[0-9]{7,15}$/`. Duplicates are silently de-duplicated before storage. |

**Response (success)**
```json
{
  "groupId": "abc123",
  "phoneCount": 450,
  "name": "Summer Promo List"
}
```

**Errors**
| Code | Condition |
|------|-----------|
| `unauthenticated` | Not signed in |
| `invalid-argument` | `name` empty or too long; `phones` empty or contains invalid E.164 |
| `resource-exhausted` | User already has 50 contact groups (soft limit) |

**Side effects**
- Creates `contactGroups/{groupId}` with `uid = context.auth.uid`.
- Batch-writes all de-duplicated phones to `contactGroups/{groupId}/phones/{phone}` (using phone as doc ID for uniqueness enforcement).
- Sets `phoneCount` to the de-duplicated count.

---

### `listContactGroups`

Returns all contact groups owned by the caller.

**Request:** (no fields required)

**Response (success)**
```json
{
  "groups": [
    {
      "groupId": "abc123",
      "name": "Summer Promo List",
      "phoneCount": 450,
      "createdAt": "2026-05-21T12:00:00Z"
    }
  ]
}
```

**Notes**
- Returns groups ordered by `createdAt` descending.
- Max 50 groups returned (matches the create limit).
- Does not return the phone sub-collection — use `listContactGroupPhones` for that.

---

### `deleteContactGroup`

Permanently deletes a contact group and all its phones.

**Request**
| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `groupId` | string | yes | Non-empty |

**Response (success)**
```json
{ "deleted": true }
```

**Errors**
| Code | Condition |
|------|-----------|
| `not-found` | Group does not exist |
| `permission-denied` | Group `uid` does not match caller's UID |

**Side effects**
- Batch-deletes all documents in `contactGroups/{groupId}/phones/*`.
- Deletes `contactGroups/{groupId}`.

---

### `listContactGroupPhones`

Returns the phone numbers in a contact group (paginated).

**Request**
| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `groupId` | string | yes | Non-empty |
| `pageSize` | number | no | Default 100. Max 500. |
| `pageToken` | string | no | Firestore cursor for next page |

**Response (success)**
```json
{
  "phones": ["+8801711111111", "+8801811111111"],
  "nextPageToken": "cursor_string_or_null"
}
```

**Errors**
| Code | Condition |
|------|-----------|
| `not-found` | Group does not exist |
| `permission-denied` | Group `uid` does not match caller's UID |

---

## Message Template Functions

### `createMessageTemplate`

**Request**
| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `name` | string | yes | Non-empty, max 100 characters |
| `body` | string | yes | Non-empty, max 1600 characters |

**Response (success)**
```json
{
  "templateId": "tpl_xyz",
  "name": "Weekly Promo",
  "body": "Hello! Check out this week's deals..."
}
```

**Errors**
| Code | Condition |
|------|-----------|
| `unauthenticated` | Not signed in |
| `invalid-argument` | `name` or `body` empty or too long |
| `resource-exhausted` | User already has 100 templates (soft limit) |

---

### `listMessageTemplates`

**Request:** (no fields required)

**Response (success)**
```json
{
  "templates": [
    {
      "templateId": "tpl_xyz",
      "name": "Weekly Promo",
      "body": "Hello! Check out this week's deals at HaatBazar. Visit haatbazar.com",
      "createdAt": "2026-05-21T12:00:00Z",
      "updatedAt": "2026-05-21T12:00:00Z"
    }
  ]
}
```

- Ordered by `updatedAt` descending (most recently used first).
- Max 100 templates.

---

### `updateMessageTemplate`

**Request**
| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `templateId` | string | yes | Non-empty |
| `name` | string | no | Max 100 chars if provided |
| `body` | string | no | Max 1600 chars if provided |

At least one of `name` or `body` must be provided.

**Response (success)**
```json
{ "updated": true }
```

**Errors**
| Code | Condition |
|------|-----------|
| `not-found` | Template does not exist |
| `permission-denied` | Template `uid` does not match caller's UID |
| `invalid-argument` | Neither `name` nor `body` provided; or values exceed limits |

---

### `deleteMessageTemplate`

**Request**
| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `templateId` | string | yes | Non-empty |

**Response (success)**
```json
{ "deleted": true }
```

**Errors**
| Code | Condition |
|------|-----------|
| `not-found` | Template does not exist |
| `permission-denied` | Template `uid` does not match caller's UID |

---

## Existing Function — Modified

### `createBulkCampaign` (existing — extended)

The existing `createBulkCampaign` callable function is extended to accept an alternative `sourceType`.

**Additional request fields (optional — ignored if absent)**

| Field | Type | Condition | Validation |
|-------|------|-----------|------------|
| `sourceType` | string | optional | `'csv'` (default) or `'contactGroups'` |
| `sourceGroupIds` | string[] | required when `sourceType == 'contactGroups'` | 1–10 group IDs. Each group must be owned by the caller. |

**Behaviour when `sourceType == 'contactGroups'`:**
1. Validate each `groupId` in `sourceGroupIds` — confirm all exist and all have `uid == context.auth.uid`.
2. Read all phones from each group's `phones` sub-collection.
3. De-duplicate the union of all phone numbers.
4. Proceed with existing campaign dispatch logic using the de-duplicated phone array.
5. Store `sourceType: 'contactGroups'` and `sourceGroupIds: [...]` on the campaign document.

**Note:** The `phones` field in the request is ignored when `sourceType == 'contactGroups'`. The function builds the phone list from Firestore.

**Additional errors**
| Code | Condition |
|------|-----------|
| `not-found` | One or more `groupId` values do not exist |
| `permission-denied` | One or more groups are not owned by the caller |
| `invalid-argument` | `sourceType == 'contactGroups'` but `sourceGroupIds` is empty |

---

## Delivery Report (Client-Side Only — No New Function)

The delivery report CSV download is generated **entirely client-side** in `BulkCampaignDetail.jsx`.

**Data source:**
- Failed recipients: existing `listFailedRecipients({ campaignId })` call (already in use on the detail page).
- Sent recipients: `campaign.totalRecipients - campaign.failedCount` (count only — no per-phone sent log exists).

**CSV format:**
```
phone,status,errorMessage,attemptedAt
+8801711111111,sent,,
+8801811111111,failed,RESULT_ERROR_NO_SERVICE,2026-05-21T12:34:56Z
```

**Implementation:** Use `URL.createObjectURL(new Blob([csvString], { type: 'text/csv' }))` and trigger an `<a download>` click. No new Cloud Function needed.

> **Limitation acknowledged:** Because there is no per-recipient sent log, sent rows in the CSV will only contain the phone number and status `"sent"` — the `attemptedAt` column will be empty for sent recipients. Failed recipients have full data from `listFailedRecipients`. This limitation is documented and accepted for this modification.
