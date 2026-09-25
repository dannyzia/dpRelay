# W2 Toggle-Additivity Report — `V5_API_ENABLED=true` on the parallel-run APK

| | |
|---|---|
| **Date** | 2026-09-25 |
| **Refs** | ISSUE-15 / ISSUE-21 (M4 Workstream 2), PLAN §9 |
| **Verified against** | `authenticator-app/` at master `d3b3873` (PR #25) — every file:line below re-read at HEAD on 2026-09-25 |
| **Question** | With `V5_API_ENABLED=true`, does the legacy Firebase plane (`PendingSmsListener`) keep running untouched? |

**Answer: YES — strictly additive.** `V5_API_ENABLED` only ever *adds* v5 behavior;
it never gates, replaces, or stops any legacy-plane path. The one shared resource
between the planes (SmsManager + send pacing) is governed by the single process-wide
`SmsRateLimiter` object, so the two planes cannot race each other into the Android
"too many SMS" dialog.

## 1. The toggle itself

- `app/build.gradle` `defaultConfig`:
  - `V5_API_BASE_URL = "https://dprelay-api-hug8.onrender.com"` (base, non-secret)
  - `V5_SERVER_URL = "https://dprelay-api-hug8.onrender.com"` (operator-settable override; `V5ApiClient.baseUrl()` prefers it, `V5_API_BASE_URL` is the fallback — both default to production)
  - `V5_API_ENABLED = true` (compile-time boolean for this parallel-run build)
- `V5ApiClient.isEnabled()` (`V5ApiClient.kt:53`) returns `BuildConfig.V5_API_ENABLED` — the sole definition of the toggle.

## 2. Legacy plane is unconditional (flag never checked)

- `AuthenticatorService.kt:190–196` — after Firebase auth succeeds, `startPendingSmsListener()` is called with **no flag check of any kind**. With the flag on or off, the RTDB `/pending_sms` listener runs identically.
- `AuthenticatorService.kt:278–283` — `startPendingSmsListener()` constructs `PendingSmsListener(applicationContext).also { it.startListening() }` unconditionally.
- `AuthenticatorService.kt:341–345` — `stopPendingSmsListener()` is called **only** from `onDestroy()` (`:86`) and the explicit stop action (`:190`); neither is reachable from any v5 code path. No v5 symbol appears in any destroy path.
- `SmsReceiver.kt:200–207` — the payment-SMS receiver feeds **both** planes: the legacy RTDB flow runs first and unconditionally (preceding lines), and the v5 REST ingest is *added* behind `if (V5ApiClient.isEnabled() && device key != null)` with the comment "Server is idempotent per unique txn_id, so retries never double-count". With the flag on, the legacy write still happens.
- `AuthFcmService.kt:68–75` — token refresh still updates RTDB/Firebase as before; the v5 `postFcmToken` call is *added* behind `if (V5ApiClient.isEnabled())` with failure logged at `Log.w` and explicitly non-fatal ("will re-register on next refresh"). A v5 failure can never abort the legacy refresh.

## 3. What the flag actually adds

- `AuthenticatorService.kt:105` + `:300–311` — `startV5PlaneIfEnabled()` is invoked from `startAsForeground()` in **addition** to the legacy startup sequence (foreground + wake lock + `authenticateWithFirebase()` all still run). The only gate is at `:301`: `if (!V5ApiClient.isEnabled() || v5PlaneStarted) return` — it self-gates the v5 loop only.
- `AuthenticatorService.kt:302–336` — the v5 loop is deliberately **independent of Firebase auth** (own heartbeat + enrollment retry loop, "v5 enrollment failed — retrying next tick" self-healing, post-heartbeat `OutstandingFetcher.fetchAndSend`). The v4 Cloud Functions can die (HTTP 503) without dragging v5 down, and vice versa: neither loop references the other's health.
- `OutstandingFetcher.kt:30, 82` — the v5 fetcher is invoked only from the v5 loop (`AuthenticatorService` heartbeat path) and from FCM wake (`AuthFcmService`); `OutstandingFetcher.fetchAndSend` itself re-checks `V5ApiClient.isEnabled()` at `:82` and returns silently when off. When on, it never touches any legacy object — it works only through `V5ApiClient`, its own broadcast receivers (distinct `V5_SMS_SENT`/`V5_SMS_DELIVERED` actions), and `EncryptedPrefsHelper`.

## 4. The one shared resource: SmsManager pacing (the W2 refactor target)

- `ratelimit/SmsRateLimiter.kt` is a Kotlin `object` — a **process-wide singleton by construction**. Its own header documents the dual-plane contract: "A SINGLE instance must serve every outbound SMS path on the phone… a per-plane limiter would let the two planes race each other into the Android 'too many SMS' dialog."
- Both planes hold a reference to that one object (references, not constructions):
  - `PendingSmsListener.kt:36` — `private val smsRateLimiter = SmsRateLimiter`
  - `OutstandingFetcher.kt:30` — `private val smsRateLimiter = SmsRateLimiter`
- Both call the identical `enqueueSms(...)` entry point (`PendingSmsListener.kt:sendSms`, `OutstandingFetcher.kt:enqueueSend`), so all sends interleave in one queue on one handler thread with one `MIN_INTERVAL_MS = 5000L` inter-send interval.
- **Audit of the handoff premise**: the handoff said the two classes "each construct their own SmsRateLimiter". That was already false on `master` — there is nothing to refactor *structurally*; sharing is guaranteed by the Kotlin `object` declaration, not by wiring. The refactor-equivalent deliverable is the regression lock added in this branch: `app/src/test/java/com/digitalpapyrus/authenticator/SmsRateLimiterDualPlaneTest.kt` proves on the JVM that cross-plane sends share one FIFO queue and honor the >= 5 s inter-send interval (with a 50 ms scheduling tolerance).

## 5. Conclusion

`V5_API_ENABLED=true` on this build:
1. keeps `PendingSmsListener` and the whole legacy Firebase plane running exactly as before (no flag check on any legacy start/stop/send path);
2. adds the independent v5 loop (enroll → heartbeat → fetch-and-send), the v5 payment-SMS REST ingest, and v5 FCM-token registration alongside — never instead of — the legacy equivalents;
3. routes every send from both planes through one process-wide `SmsRateLimiter`, keeping the 5-second phone-level send pacing under dual-plane operation (locked by a unit test in this branch).

No device enrollment was performed by this workstream; enrollment happens on the physical phone by the owner.
