<!--
AI: Follow these steps exactly when something breaks in production. Do not attempt fixes before assessing severity.
Read first: 17-MONITORING.md (to identify what broke), 15-RUNBOOK-DEPLOY.md (for rollback steps)
You must: Assess severity first. Mitigate before root-cause analysis. Write an incident report within 24 hours.
You must not: Attempt a fix before identifying the cause. Skip the incident report.
Human reviews this: NO — AI follows the steps. Human authorizes rollbacks and external communication.
-->

# Incident Response
**Project:** Authenticator

## Severity levels
| Level | Definition | Response time | Escalate to |
|-------|-----------|---------------|-------------|
| P1 | No verifications succeeding (authenticator phone dead or CF broken) | Immediate | Team lead |
| P2 | Verifications failing for specific users or error rate > 5% | < 30 min | Team channel |
| P3 | Intermittent failures, retry guidance used | < 2 hours | Issue tracker |
| P4 | Minor issue (slow polling, cosmetic) | Next business day | Issue tracker |

## Response steps (for any incident)
1. Acknowledge: Post "Investigating [symptom]" in team channel
2. Assess severity using the table above
3. If P1 or P2: immediately notify team lead
4. Identify proximate cause: recent deploy? dedicated phone offline? Wi-Fi down? verification-signing secret rotated? authenticator enrollment broken?
5. **Mitigate first** — restart authenticator phone, rollback CF if needed (see `15-RUNBOOK-DEPLOY.md`). Root cause second.
6. Post status updates every 15 minutes until resolved
7. Write incident report within 24 hours (template below)

## Common failure modes
| Symptom | Likely cause | First action |
|---------|-------------|-------------|
| All verifications timeout | Authenticator phone service dead | Check phone: is notification showing? Restart phone if not |
| All verifications timeout | Wi-Fi disconnected on dedicated phone | Check phone Wi-Fi settings, reconnect |
| CF returns 500 (integrity_error) | Verification record inconsistent after deploy or partial secret rotation | Inspect `/verification_requests/{sessionCode}` and recent deploys |
| CF returns 403 (`invalid_poll_token`) | Poll token expired or request restarted | Restart verification from `startVerification` |
| CF returns 403 (`invalid_challenge`) | SMS payload altered or stale | Ask user to restart verification; inspect authenticator receipt |
| CF returns 429 (rate_limited) | Brute-force attack or client polling too fast | Check CF logs for source IP; increase RATE_LIMIT_MAX if legitimate |
| Health endpoint returns "degraded" | Authenticator phone not reporting for > 10 min | Check phone: service alive? FCM token valid? Wi-Fi connected? |
| SMS not arriving at dedicated phone | RECEIVE_SMS permission revoked or SIM issue | Reinstall app, re-grant permission, check SIM card |
| Verification request expires too early | Clock skew > 5 min between devices | Both devices: Settings → Date & Time → Automatic (NTP) |
| Verifications work but slow (> 10s) | Network latency or Firebase region mismatch | Check Wi-Fi signal, verify CF region matches RTDB region |

## On-Call Runbooks

### Runbook: Authenticator phone offline
**Trigger:** Health endpoint returns "degraded", last ping > 10 min ago

1. **Immediate check:** Call/text the dedicated phone number
   - If rings → Phone has power and cellular, issue is likely Wi-Fi or service
   - If no ring → Phone dead or out of battery

2. **If phone is on:**
   - Check notification: "Running 24/7" showing?
   - If NOT showing: Open app, re-grant permissions, restart service
   - Check Wi-Fi: Connected to stable network? Reconnect if needed
   - Check FCM: Open app → check for any error messages

3. **If phone is off/dead:**
   - Check charger connection
   - Power on, wait 5 minutes for service auto-start
   - Verify notification appears
   - Run health check: `curl -H "Authorization: Bearer {SECRET}" {CF_URL}/health`

**Escalation:** If phone won't power on after 30 min → hardware failure, need backup phone

---

### Runbook: Cloud Function errors spiking
**Trigger:** Error rate > 5% in Firebase Console

1. **Check recent changes:**
   ```bash
   git log --oneline -10
   firebase functions:list  # Check deploy history
   ```

2. **View error logs:**
   ```bash
   firebase functions:log --only checkAuth --limit 50
   ```

3. **Common errors and fixes:**
   | Error | Likely Cause | Action |
   |-------|-------------|--------|
   | `integrity_error` | Verification request corrupted or partially migrated | Inspect `/verification_requests/{sessionCode}` and rollback if needed |
   | `invalid_poll_token` | Client polling stale session | Restart verification and confirm `startVerification` output |
   | `invalid_challenge` | SMS payload altered or stale | Inspect authenticator receipt and recent secret rotation |
   | `rate_limited` | Brute force | Review IP, adjust limit if needed |
   | `auth/invalid-credential` | Firebase auth failure | Check service account |

4. **If errors started after deploy:**
   - Follow rollback procedure in `15-RUNBOOK-DEPLOY.md`

---

### Runbook: Firebase quota exceeded
**Trigger:** CF invocations approaching free tier limit (1.5M/month)

1. **Check current usage:**
   - Firebase Console → Usage & Billing

2. **Immediate actions:**
   - If legitimate traffic: Upgrade to Blaze plan
   - If attack traffic: Enable App Check, review rate limits

3. **Prevention:**
   - Set up quota alert at 80% threshold
   - Review `03-TECH-STACK.md` capacity planning

---

## Communication Templates

### User notification (verification degraded)
```
We are experiencing delays with phone number verification. 
Our team is working on a fix. Please try again in 15 minutes.
Thank you for your patience.
```

### Status page update (P1 incident)
```
**Investigating:** Phone verification is currently unavailable.
We are aware of the issue and working on a resolution.
Posted at: [timestamp]
```

### Status page update (resolved)
```
**Resolved:** Phone verification is now working normally.
All services have been restored. Thank you for your patience.
Posted at: [timestamp]
```

---

## Incident report format
```markdown
## Incident: [Short title] — YYYY-MM-DD
**Severity:** P1 / P2 / P3
**Duration:** HH:MM — HH:MM UTC
**Impact:** Number of failed verifications, which apps affected
**Root cause:** What actually went wrong
**Timeline:**
- HH:MM UTC — [event]
- HH:MM UTC — [event]
**Fix:** What was done to resolve it
**Prevention:** What changes will prevent recurrence
```
