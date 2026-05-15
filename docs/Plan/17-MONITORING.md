<!--
AI: Use this document to configure alerts and understand what they mean.
Read first: 15-RUNBOOK-DEPLOY.md (for deploy-related alerts), 16-INCIDENT-RESPONSE.md (for how to respond)
You must: Configure alerts for every metric listed. Link each alert to its runbook action.
You must not: Ignore an alert without documenting why. Change thresholds without updating this doc.
Human reviews this: NO - AI configures and responds. Human reviews alert thresholds during setup.
-->

# Monitoring & Alerts

**Project:** Authenticator

## Key Metrics (SLIs)

| Metric | Target | Alert Threshold | Business Impact |
| ------ | ------ | --------------- | --------------- |
| Verification success rate | > 99% | < 95% | Users cannot register or checkout |
| Average verification time | < 15s | > 30s | Poor user experience |
| Authenticator phone uptime | > 99.5% | < 95% | Complete service outage |
| Cloud Function error rate | < 0.1% | > 1% | Failed verifications |

## Service Level Objectives (SLOs)

| SLO | Target | Measurement Window | Error Budget (monthly) |
| --- | ------ | ------------------ | ---------------------- |
| Verification availability | 99.5% | 30-day rolling | 3.6 hours downtime |
| Verification latency (P95) | < 5 seconds end-to-end | 30-day rolling | N/A (latency budget) |
| Verification success rate | > 99% of valid attempts | 30-day rolling | 0.5% failure rate = ~60 failed verifications/day at 200/day |
| Authenticator device uptime | > 99.5% | 30-day rolling | 3.6 hours offline |
| Cloud Function error rate | < 0.1% | 30-day rolling | N/A |

### Error budget tracking

- Monthly error budget for verification availability: 3.6 hours
- When 50% of budget is consumed (1.8 hours): notify the team channel and review recent incidents
- When 100% of budget is consumed: freeze non-critical deployments and prioritize reliability work
- Budget resets at the start of each calendar month
- Track via: BigQuery query counting failed verifications versus total verifications per month

## Dashboards

### Primary Dashboards

| Name | URL | What it shows | Refresh rate |
| ---- | --- | ------------- | ------------ |
| Firebase Functions | console.firebase.google.com -> Functions -> Logs | CF invocations, errors, latency | Real-time |
| Firebase RTDB | console.firebase.google.com -> RTDB -> Usage | Stored data, connections, downloads | Hourly |
| Health check | `curl -H "Authorization: Bearer {SECRET}" {CF_URL}/health` | Device liveness, queue depth | On-demand |

### Recommended Custom Dashboard (Data Studio/Metabase)

Build a dashboard showing:

1. Verification success rate (hourly, 24h window)
2. Average verification time (P50, P95, P99)
3. Authenticator device health (battery, last ping)
4. Queue depth over time
5. Invalid poll token or invalid challenge attempts by IP (top 10)

## Alert Configuration

### Channels

| Channel | Purpose | Setup |
| ------- | ------- | ----- |
| Slack #alerts-p1 | P1 incidents only | Webhook to P1 on-call rotation |
| Slack #alerts-all | P2, P3 alerts | Webhook to team channel |
| PagerDuty | P1 page on-call engineer | Integration with Firebase alerts |
| Email | Daily summaries, P4 alerts | `alerts@company.example` |

### Alert thresholds

| Metric | Normal range | Alert threshold | Severity | Alert channel | Silence window |
| ------ | ------------ | --------------- | -------- | ------------- | -------------- |
| Health endpoint status | `healthy` | `degraded` for > 10 min | P1 | PagerDuty + Slack #alerts-p1 | None |
| Verification success rate | > 99% | < 95% for 5 min | P1 | PagerDuty + Slack #alerts-p1 | None |
| CF error rate | < 1% | > 5% for 5 min | P2 | Slack #alerts-all | 30 min |
| CF response time P95 | < 500ms | > 2000ms for 5 min | P2 | Slack #alerts-all | 30 min |
| Invalid poll/challenge attempts | < 10/hour | > 50/hour | P2 | Slack #alerts-all | 1 hour |
| Authenticator battery < 20% | > 20% | < 20% | P2 | Slack #alerts-all | 24 hours |
| Queue depth (`verification_requests`) | < 10 | > 100 | P3 | Slack #alerts-all | 6 hours |
| RTDB stored data | < 10 MB | > 100 MB | P3 | Slack #alerts-all | 24 hours |
| CF invocations/month | < 100K | > 1.2M (80% of free tier) | P3 | Slack #alerts-all | 7 days |

### Firebase Alert Setup Instructions

#### Health endpoint monitoring (P1)

1. Go to Firebase Console -> Functions -> checkAuth
2. Click the Alerts tab
3. Set up HTTP alert: use a scheduled Cloud Function or external monitoring service to call `/health` every 5 minutes
4. On `degraded` status, trigger PagerDuty via webhook
5. Implementation: create a Cloud Scheduler job that pings the health endpoint and writes to a monitoring topic

#### CF error rate alert (P2)

1. Go to Google Cloud Console -> Monitoring -> Alerting
2. Create policy: `Cloud Function error rate`
3. Condition: `resource.type="cloud_function" AND severity>=ERROR` rate > 5% over 5 minutes
4. Notification: Slack webhook to `#alerts-all`

#### Invalid poll/challenge spike alert (P2)

1. This requires custom logging in `checkAuth` - log `invalid_poll_token` and `invalid_challenge` with source IP
2. Create a log-based metric in GCP Console -> Logging -> Log-based Metrics
3. Filter: `resource.type="cloud_function" (jsonPayload.error="invalid_poll_token" OR jsonPayload.error="invalid_challenge")`
4. Alert when rate > 50/hour

#### Quota alert (P3)

1. Firebase Console -> Usage & Billing -> Set budget alert
2. Alert at 80% of free-tier limits (1.2M CF invocations, 1 GB RTDB storage, 10 GB RTDB download)

## What Each Alert Means and What to Do

### Health endpoint `degraded`

- Check: dedicated phone powered on, Wi-Fi connected, service running, FCM registered
- First action: visit the dedicated phone and check the foreground notification and connectivity
- Runbook: [15-RUNBOOK-DEPLOY.md](./15-RUNBOOK-DEPLOY.md) - rollback and deploy checks, plus [16-INCIDENT-RESPONSE.md](./16-INCIDENT-RESPONSE.md) - timeout response flow

### High CF error rate

- Check: recent deploy, `VERIFICATION_SIGNING_SECRET` rotation, RTDB rules changes
- First action: inspect `firebase functions:log` for recent stack traces and request failures
- Runbook: [15-RUNBOOK-DEPLOY.md](./15-RUNBOOK-DEPLOY.md)

### High invalid poll/challenge attempts

- Check: source IP concentration and session-code pattern in Cloud Functions logs
- First action: review warn logs for `invalid_poll_token` and `invalid_challenge` from the same IP
- Action: if traffic is concentrated, consider edge blocking or tightening `RATE_LIMIT_MAX`

### High queue depth

- Check: cleanup function running and whether verifications are failing without deletion
- First action: check cleanup function logs with `firebase functions:log --only cleanupOldRequests`
- Action: manually run cleanup if the scheduler failed

## Log Aggregation & BigQuery

### Firebase -> BigQuery Export Setup

1. Firebase Console -> Project Settings -> Integrations -> BigQuery
2. Enable export for:
   - Cloud Functions logs
   - Realtime Database logs
  - Crashlytics

### Recommended BigQuery Queries

#### Verification success rate by hour

```sql
SELECT
  TIMESTAMP_TRUNC(timestamp, HOUR) as hour,
  COUNTIF(jsonPayload.verified = true) as success_count,
  COUNT(*) as total_count,
  ROUND(COUNTIF(jsonPayload.verified = true) * 100.0 / COUNT(*), 2) as success_rate
FROM `project-id.firebase_functions.cloudfunctions_googleapis_com_cloud_functions`
WHERE resource.labels.function_name = 'checkAuth'
  AND timestamp > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)
GROUP BY hour
ORDER BY hour DESC
```

#### Failed verification attempts by IP (potential attacks)

```sql
SELECT
  jsonPayload.ip as source_ip,
  COUNT(*) as failed_attempts,
  COUNT(DISTINCT jsonPayload.sessionCode) as unique_session_codes
FROM `project-id.firebase_functions.cloudfunctions_googleapis_com_cloud_functions`
WHERE resource.labels.function_name = 'checkAuth'
  AND jsonPayload.verified = false
  AND jsonPayload.error IN ('invalid_poll_token', 'invalid_challenge')
  AND timestamp > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)
GROUP BY source_ip
HAVING failed_attempts > 10
ORDER BY failed_attempts DESC
```

#### Authenticator device health trends

```sql
SELECT
  TIMESTAMP_TRUNC(timestamp, HOUR) as hour,
  AVG(jsonPayload.battery) as avg_battery,
  MIN(jsonPayload.battery) as min_battery,
  COUNT(DISTINCT jsonPayload.device) as active_devices
FROM `project-id.firebase_functions.cloudfunctions_googleapis_com_cloud_functions`
WHERE resource.labels.function_name = 'health'
  AND timestamp > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
GROUP BY hour
ORDER BY hour DESC
```

See `docs/08-Security-Maintenance.md` for additional audit logging queries.
