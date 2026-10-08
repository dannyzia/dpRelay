/**
 * rotate-secret — rotate ONE operator-plane secret on demand, with the same
 * backup-verify-rollback shape as staging/rotate-core-secrets.cjs.
 *
 * Why one secret at a time: the four-secret rotator invalidates every
 * admin-plane credential at once. JWT_SECRET logs every user out;
 * OPERATOR_SECRET breaks every operator tool holding the old value; the
 * enrollment and provisioning secrets only affect future enrollments and
 * registrations. "Any core secret on demand" means each blast radius is chosen
 * deliberately, and a failed probe points at exactly one target instead of
 * leaving four values to diagnose.
 *
 * Verification is per-secret against the LIVE service, and this script refuses
 * to print VERIFIED for a secret it did not exercise:
 *
 *   JWT_SECRET                crafted old-secret token -> 401 on
 *                             POST /v5/device/register; then a throwaway probe
 *                             user registers and logs in, and the server-minted
 *                             token's HMAC must match the new secret and not
 *                             the old one. Side effect: one probe user per run.
 *   OPERATOR_SECRET           GET /v5/admin/metrics — old -> 401, new -> 200.
 *                             Read-only.
 *   DEVICE_ENROLLMENT_SECRET  POST /v5/device/enroll — old -> 401, new -> 201,
 *                             then the probe device is revoked through the
 *                             admin plane. Side effect: one device row.
 *   APP_PROVISIONING_SECRET   POST /v5/apps/register with a deliberately
 *                             invalid appId — old -> 401, new -> 400. No app is
 *                             created.
 *
 *   ALERT_WEBHOOK_SECRET      POST to ALERT_WEBHOOK_URL — old -> 401, new -> 200.
 *                             The only target whose verdict comes from OUTSIDE
 *                             the deployed service: the receiver validates the
 *                             bearer, so the run hands it the new value first
 *                             (ALERT_RECEIVER_SYNC_URL) and probes after that.
 *                             With no receiver configured there is nothing to
 *                             prove, so the run refuses before writing anything.
 *
 * Everything else is refused on purpose (see REFUSALS) — provider-issued
 * material that cannot be generated locally, identifiers that are not secrets,
 * and the credential these scripts use to reach Render in the first place.
 *
 * Rollback: the pre-rotation values of ALL four targets are snapshotted into
 * the login keyring (account core-secrets-rotation-backup, shared with the
 * existing four-secret rotator) before the first write. `rollback` overlays
 * that snapshot, deploys, and re-runs the live probe for every key it actually
 * reverted — a rollback that did not take effect cannot report success.
 *
 * DRY_RUN in the environment is a hazard, not a rehearsal switch: if it is set
 * to any non-empty value this script refuses to run at all (exit 2) before any
 * network call or keyring read. Use the explicit `--dry-run` flag for a plan.
 * The reason is the same one that produced this convention in
 * set-alert-channel.cjs: an inherited DRY_RUN from a shell wrapper or an agent
 * runner is indistinguishable from a real run at the call site, so a "real"
 * invocation would silently do nothing.
 *
 * Usage:
 *   node server/scripts/rotate-secret.cjs <NAME>            # rotate + deploy + verify
 *   node server/scripts/rotate-secret.cjs <NAME> --dry-run  # report only, no network
 *   node server/scripts/rotate-secret.cjs rollback          # restore the snapshot + verify
 *   node server/scripts/rotate-secret.cjs rollback --dry-run
 *
 * Exit codes: 0 = verified, 1 = failed, 2 = refused (nothing written).
 * Values are never printed — only key names, lengths, and status codes.
 */
const http = require('node:http');
const https = require('node:https');
const { createHmac, randomBytes, timingSafeEqual } = require('node:crypto');

const { resolveRenderApiKey } = require('./render-key.cjs');
const { readSecret, writeSecret } = require('./secret-store.cjs');

/** Exit code meaning "refused to start; nothing was written, deployed, or sent". */
const EXIT_REFUSED = 2;

/**
 * Keyring account holding the pre-rotation values of the four targets.
 * Shared with staging/rotate-core-secrets.cjs so either script can roll back
 * the other's rotation. secret-store.cjs validates the name against ACCOUNTS,
 * so a typo here fails loudly instead of silently reading nothing.
 */
const ROLLBACK_ACCOUNT = 'core-secrets-rotation-backup';

/**
 * Render service id and the two API origins.
 *
 * Overridable so the script can be exercised end-to-end against a local mock —
 * the mock test is what proves the rotate/rollback flow without touching
 * production — and so a service move does not require editing the script.
 * These are test hooks, not deployment configuration.
 */
const serviceId = process.env.RENDER_SERVICE_ID || 'srv-dal3bae7bikc73e7k7pg';
const renderBase = `${process.env.RENDER_API_BASE || 'https://api.render.com/v1/services'}/${serviceId}`;
const publicBase = process.env.DPRELAY_API_BASE || 'https://dprelay-api-hug8.onrender.com';

/** Per-request ceiling: a hung API call must fail loudly, not freeze the shell. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Rotatable targets: the four operator-plane secrets, each paired with the
 * generator that reproduces the live format and a description of the live probe
 * that proves the rotation.
 *
 * `pattern` pins the exact format the production values use today (measured
 * 2026-10-04): base64 64/32 bytes, base64url 32 bytes. A generator that drifts
 * outside it is caught here at generation time AND in
 * server/test/rotate-secret.test.ts, so a silent format change cannot ship.
 */
const TARGETS = Object.freeze({
  JWT_SECRET: {
    generate: () => randomBytes(64).toString('base64'),
    pattern: /^[A-Za-z0-9+/]{86}==$/,
    format: 'crypto.randomBytes(64).toString("base64") — 88 chars',
    describe:
      'crafted old-secret token -> 401 on POST /v5/device/register; throwaway probe user registers and logs in, and the server-minted token HMAC must match the new secret (leaves one probe user)',
  },
  OPERATOR_SECRET: {
    generate: () => randomBytes(32).toString('base64'),
    pattern: /^[A-Za-z0-9+/]{43}=$/,
    format: 'crypto.randomBytes(32).toString("base64") — 44 chars',
    describe: 'GET /v5/admin/metrics — old -> 401, new -> 200 (read-only)',
  },
  DEVICE_ENROLLMENT_SECRET: {
    generate: () => randomBytes(32).toString('base64url'),
    pattern: /^[A-Za-z0-9_-]{43}$/,
    format: 'crypto.randomBytes(32).toString("base64url") — 43 chars',
    describe:
      'POST /v5/device/enroll — old -> 401, new -> 201, then the probe device is revoked through the admin plane (creates and cleans up one device row)',
  },
  APP_PROVISIONING_SECRET: {
    generate: () => randomBytes(32).toString('base64url'),
    pattern: /^[A-Za-z0-9_-]{43}$/,
    format: 'crypto.randomBytes(32).toString("base64url") — 43 chars',
    describe:
      'POST /v5/apps/register with a deliberately invalid appId — old -> 401, new -> 400 (no app is created)',
  },
  ALERT_WEBHOOK_SECRET: {
    generate: () => randomBytes(32).toString('base64url'),
    pattern: /^[A-Za-z0-9_-]{43}$/,
    format: 'crypto.randomBytes(32).toString("base64url") — 43 chars',
    describe:
      'POST to ALERT_WEBHOOK_URL — old -> 401, new -> 200, after the receiver has been handed the new value via ALERT_RECEIVER_SYNC_URL',
    receiverSync: true,
  },
});

/**
 * Known production secrets this script deliberately will not touch, each with
 * the reason. Kept next to TARGETS so "why is X not here?" is answered by the
 * script itself instead of by an archaeology session.
 */
const REFUSALS = Object.freeze({
  FCM_SERVICE_ACCOUNT_JSON:
    'not random material: a GCP service-account key. Use staging/rotate-fcm-key.cjs (create the key in GCP, PUT, deploy, verify with server/scripts/fcm-wake-probe.cjs)',
  R2_ACCESS_KEY_ID:
    'issued by Cloudflare; cannot be generated locally — rotate it in the R2 dashboard and update Render',
  R2_SECRET_ACCESS_KEY:
    'issued by Cloudflare; cannot be generated locally — rotate it in the R2 dashboard and update Render',
  R2_ACCOUNT_ID: 'a Cloudflare account identifier, not a secret — changing it reassigns the storage backend',
  R2_ENDPOINT: 'a Cloudflare endpoint, not a secret — changing it reassigns the storage backend',
  R2_BUCKET_ATTACHMENTS: 'a bucket name, not a secret',
  R2_BUCKET_LITESTREAM: 'a bucket name, not a secret',
  RENDER_API_KEY:
    'issued by the Render dashboard and read from the keyring by the ops scripts themselves — rotating it from here would cut off the tooling mid-flight',
  TELEGRAM_BOT_TOKEN:
    'issued by BotFather; rotate there, then re-run server/scripts/set-alert-channel.cjs telegram <token> <chatId>',
});

/** Raised for anything that stops the script before (or instead of) a write. */
class RefusalError extends Error {}

/**
 * Parses argv into a mode. Pure: no process state, no network, no keyring.
 *
 * `--dry-run` may appear anywhere; exactly one positional argument (a target
 * name or `rollback`) is required. A bare invocation is `help`, which the
 * bootstrap turns into exit 2 because nothing was asked for.
 *
 * @param {string[]} argv arguments after the script path
 * @returns {{ mode: 'help'|'rotate'|'rollback', name: string|null, dryRun: boolean }}
 * @throws {RefusalError} on an unknown flag or more than one positional
 */
function parseArgs(argv) {
  const positionals = [];
  let dryRun = false;
  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') return { mode: 'help', name: null, dryRun: false };
    if (arg.startsWith('-')) throw new RefusalError(`unknown flag: ${arg}`);
    positionals.push(arg);
  }
  if (positionals.length === 0) return { mode: 'help', name: null, dryRun: false };
  if (positionals.length > 1) {
    throw new RefusalError(`expected one target name (or rollback), got ${positionals.length}: ${positionals.join(' ')}`);
  }
  const name = positionals[0];
  if (name === 'rollback') return { mode: 'rollback', name: null, dryRun };
  return { mode: 'rotate', name, dryRun };
}

/**
 * Why `name` cannot be rotated by this script, or null when it can.
 *
 * Own-property checks, not `in`: a name that collides with an Object.prototype
 * key must not inherit a truthy answer it was never given.
 *
 * @param {string} name candidate env-var name
 * @returns {string|null} a refusal reason, or null when rotatable
 */
function refusalFor(name) {
  if (Object.prototype.hasOwnProperty.call(TARGETS, name)) return null;
  if (Object.prototype.hasOwnProperty.call(REFUSALS, name)) return REFUSALS[name];
  return `not a declared core secret. Rotatable: ${Object.keys(TARGETS).join(', ')}`;
}

/**
 * Generates a fresh replacement for one target, checked against its live format.
 *
 * The check is not paranoia: a generator whose output drifts would otherwise be
 * deployed and only discovered when the service rejects the value, with a
 * production API key already overwritten.
 *
 * @param {string} name target key
 * @returns {string} the new value; callers must never log it
 * @throws {RefusalError} when `name` is not a target
 * @throws {Error} when the generator produced a value outside the live format
 */
function generateValue(name) {
  const target = Object.prototype.hasOwnProperty.call(TARGETS, name) ? TARGETS[name] : null;
  if (target === null) throw new RefusalError(`cannot generate "${name}": ${refusalFor(name)}`);
  const value = target.generate();
  if (!target.pattern.test(value)) {
    throw new Error(`generator for ${name} produced a value outside the live format — refusing to deploy it`);
  }
  return value;
}

/**
 * Builds a minimal HS256 JWT signed with `secret`.
 *
 * Used to prove the OLD secret is rejected: if the live service accepts this
 * token after a rotation, the rotation did not take effect. Hand-rolled on
 * node:crypto so the script pulls no new dependency; the layout is the compact
 * serialization @fastify/jwt (jsonwebtoken) consumes.
 *
 * @param {string} secret HMAC key
 * @param {{ sub: string, email: string, nowSeconds?: number, ttlSeconds?: number }} claims
 * @returns {string} compact JWS serialization
 */
function buildJwt(secret, claims) {
  const nowSeconds = claims.nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: claims.sub,
      email: claims.email,
      iat: nowSeconds,
      exp: nowSeconds + (claims.ttlSeconds ?? 120),
    }),
  ).toString('base64url');
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/**
 * Verifies an HS256 JWT's signature against `secret`, in constant time.
 *
 * Anything that is not an HS256 token with a matching signature is false —
 * including `alg: none`, which must never be accepted, and a truncated
 * signature, which a length check would otherwise let through a lenient
 * comparison.
 *
 * @param {string} token compact JWS serialization
 * @param {string} secret candidate HMAC key
 * @returns {boolean} true only for a valid HS256 signature under `secret`
 */
function verifyJwtHmac(token, secret) {
  if (typeof token !== 'string' || typeof secret !== 'string' || secret === '') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [headerB64, payloadB64, signatureB64] = parts;
  let header;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  if (header === null || typeof header !== 'object' || header.alg !== 'HS256') return false;
  const expected = createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest();
  const actual = Buffer.from(signatureB64, 'base64url');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * Formats one probe observation. `got`/`want` are HTTP statuses or booleans.
 *
 * @param {string} label human description of what was checked
 * @param {unknown} got observed value
 * @param {unknown} want required value
 * @returns {{ label: string, got: unknown, want: unknown, ok: boolean }}
 */
function check(label, got, want) {
  return { label, got, want, ok: Object.is(got, want) };
}

/**
 * Refuses to start when DRY_RUN is present and non-empty.
 *
 * Runs before argument parsing so no mode — not even the read-only plan — is
 * reachable with the hazard set. A literally empty value (`DRY_RUN= cmd`)
 * counts as unset, which is how an operator overrides an inherited export for
 * a single invocation. Whitespace still blocks: a blank-looking hazard is a
 * hazard.
 */
function refuseIfDryRun() {
  const raw = process.env.DRY_RUN;
  if (raw === undefined || raw === '') return;
  console.error('');
  console.error('============================================================');
  console.error('REFUSING TO RUN: DRY_RUN is set in this environment');
  console.error(`  DRY_RUN=${JSON.stringify(raw)}   (any non-empty value blocks execution)`);
  console.error(`  requested: ${process.argv.slice(2).join(' ') || '(no arguments)'}`);
  console.error('');
  console.error('NOTHING happened: no secret was snapshotted, no Render env was');
  console.error('written, and no deploy was triggered. For a plan that touches');
  console.error('nothing, use the explicit flag instead:');
  console.error('  node server/scripts/rotate-secret.cjs <NAME> --dry-run');
  console.error('');
  console.error('exit code 2 = refused, nothing happened');
  console.error('============================================================');
  process.exit(EXIT_REFUSED);
}

/**
 * Picks the http or https client to match an origin.
 *
 * The *_BASE overrides exist so this script can be verified against a local
 * mock, and a local mock is plain http — so the transport follows the URL
 * instead of being pinned to https, which would make the overrides unusable.
 */
const clientFor = (url) => (url.startsWith('http://') ? http : https);

/**
 * One request, JSON in and JSON out: resolves with the status and the parsed
 * body, and never throws for a non-2xx (callers assert on the status).
 *
 * @param {string} url absolute URL
 * @param {{ method?: string, payload?: unknown, headers?: Record<string, string> }} [opts]
 * @returns {Promise<{ status: number|undefined, parsed: unknown }>}
 */
function request(url, { method = 'GET', payload = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = payload !== null ? JSON.stringify(payload) : null;
    const req = clientFor(url).request(
      url,
      {
        method,
        headers: {
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = body ? JSON.parse(body) : null;
          } catch {
            parsed = body;
          }
          resolve({ status: res.statusCode, parsed });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`request timeout after ${REQUEST_TIMEOUT_MS}ms (${method} ${url})`));
    });
    if (data) req.write(data);
    req.end();
  });
}

/**
 * The Render API key, resolved lazily.
 *
 * Lazy on purpose: `--dry-run` and `--help` must work on a machine with no
 * keyring and no Render credential. Caching is per-process, which is fine for
 * a script that makes one run.
 */
let cachedApiKey = null;
function renderApiKey() {
  if (cachedApiKey === null) cachedApiKey = resolveRenderApiKey();
  return cachedApiKey;
}

/** Calls the Render API for this service. */
const render = (path, method, payload) =>
  request(`${renderBase}${path}`, { method, payload, headers: { Authorization: `Bearer ${renderApiKey()}` } });

/** Calls the deployed dprelay API. */
const api = (path, opts = {}) => request(`${publicBase}${path}`, opts);

/** GETs the full env set as a flat `{ key: value }` object. */
async function getEnv() {
  const res = await render('/env-vars', 'GET');
  if (res.status !== 200) throw new Error(`GET env-vars failed: HTTP ${res.status}`);
  const items = Array.isArray(res.parsed) ? res.parsed : res.parsed?.env_vars;
  if (!Array.isArray(items)) {
    throw new Error('GET env-vars: response was not an env-var array — Render API shape changed');
  }
  const env = {};
  for (const item of items) {
    const inner = item.envVar ?? item;
    env[inner.key] = inner.value;
  }
  return env;
}

/** PUTs the full env set back. Replaces every key, so callers preserve the rest verbatim. */
async function putEnv(env) {
  const res = await render(
    '/env-vars',
    'PUT',
    Object.entries(env).map(([key, value]) => ({ key, value })),
  );
  console.log(`PUT env-vars -> HTTP ${res.status}`);
  if (res.status !== 200) throw new Error(`PUT env-vars failed: HTTP ${res.status}`);
}

/** Triggers a deploy and polls until it is live. An env PUT alone does not restart the service. */
async function deployAndWait() {
  const dep = await render('/deploys', 'POST', {});
  console.log(`POST /deploys -> HTTP ${dep.status}`);
  if (dep.status !== 201) throw new Error(`deploy trigger failed: HTTP ${dep.status}`);
  const depId = dep.parsed?.id;
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15000));
    const d = await render(`/deploys/${depId}`, 'GET');
    const status = d.parsed?.status ?? '?';
    console.log(`  deploy: ${status}`);
    if (status === 'live') return;
    if (['build_failed', 'update_failed', 'create_failed', 'canceled', 'deactivated'].includes(status)) {
      throw new Error(`deploy failed: ${status}. Rollback: node server/scripts/rotate-secret.cjs rollback`);
    }
  }
  throw new Error('deploy did not go live within 10 minutes');
}

/**
 * Checks that the deployed service is serving at all before probing secrets.
 * A non-200 here is an environment fault, not a secret verdict.
 */
async function requireHealthyService() {
  const health = await api('/health');
  console.log(`/health -> HTTP ${health.status}`);
  if (health.status !== 200) throw new Error('/health is not 200 — investigate before trusting the rotation');
}

/** Live probe for OPERATOR_SECRET. Read-only: the admin plane forwards a valid secret and rejects nothing else. */
async function verifyOperator({ accepted, rejected }) {
  const oldRes = await api('/v5/admin/metrics', { headers: { Authorization: `Bearer ${rejected}` } });
  const checks = [check('old OPERATOR_SECRET on GET /v5/admin/metrics -> 401', oldRes.status, 401)];
  const newRes = await api('/v5/admin/metrics', { headers: { Authorization: `Bearer ${accepted}` } });
  checks.push(check('new OPERATOR_SECRET on GET /v5/admin/metrics -> 200', newRes.status, 200));
  return { checks, notes: [] };
}

/**
 * Live probe for APP_PROVISIONING_SECRET.
 *
 * The body is deliberately invalid — appId "x" is below the 3-char floor — so
 * an accepted secret yields 400 without creating an app. A still-live old
 * secret stays 401, which is the distinction the probe exists to make.
 */
async function verifyProvisioning({ accepted, rejected }) {
  const oldRes = await api('/v5/apps/register', {
    method: 'POST',
    payload: { appId: 'x' },
    headers: { Authorization: `Bearer ${rejected}` },
  });
  const checks = [check('old APP_PROVISIONING_SECRET on POST /v5/apps/register -> 401', oldRes.status, 401)];
  const newRes = await api('/v5/apps/register', {
    method: 'POST',
    payload: { appId: 'x' },
    headers: { Authorization: `Bearer ${accepted}` },
  });
  checks.push(check('new APP_PROVISIONING_SECRET on POST /v5/apps/register -> 400 invalid_app_id', newRes.status, 400));
  const notes = [];
  if (newRes.status === 429) {
    notes.push(
      'the probe was rate limited (HTTP 429): the new secret was not exercised, so the rotation is neither proven nor disproven — re-run once the per-IP window clears',
    );
  }
  return { checks, notes };
}

/**
 * Live probe for ALERT_WEBHOOK_SECRET.
 *
 * The one target where the deployed service is not the party that answers: the
 * receiver validates the bearer, so the probe posts straight at
 * ALERT_WEBHOOK_URL. A placeholder URL cannot tell the two values apart, so it
 * is a hard failure rather than a skipped check — reporting VERIFIED against a
 * URL that answers nothing is the exact failure this script exists to prevent.
 *
 * @param {{accepted: string, rejected: string, env: Record<string, string>}} values
 * @returns {Promise<{checks: object[], notes: string[]}>}
 */
async function verifyAlertWebhook({ accepted, rejected, env }) {
  const url = typeof env?.ALERT_WEBHOOK_URL === 'string' ? env.ALERT_WEBHOOK_URL : '';
  if (url === '' || /(^|\/\/)[^/]*example\.(com|org|net)/i.test(url)) {
    return {
      checks: [
        check(
          'ALERT_WEBHOOK_URL is a real receiver — a placeholder cannot answer the probe',
          url === '' ? '(empty)' : 'placeholder',
          'an https URL of a real receiver',
        ),
      ],
      notes: [],
    };
  }
  const checks = [];
  const oldRes = await request(url, {
    method: 'POST',
    payload: { kind: 'rotate-secret-probe', probe: 'old-value' },
    headers: { Authorization: `Bearer ${rejected}` },
  });
  checks.push(check('old ALERT_WEBHOOK_SECRET rejected by the receiver -> 401', oldRes.status, 401));
  const newRes = await request(url, {
    method: 'POST',
    payload: { kind: 'rotate-secret-probe', probe: 'new-value' },
    headers: { Authorization: `Bearer ${accepted}` },
  });
  checks.push(check('new ALERT_WEBHOOK_SECRET accepted by the receiver -> 200', newRes.status, 200));
  return { checks, notes: [] };
}

/**
 * Hands the receiver the value production is now serving.
 *
 * Runs after the deploy (production must already be live with the new value)
 * and before the probe. A receiver still holding the old one would reject the
 * new one, which reads as a broken rotation when nothing is wrong — worse than
 * refusing to start.
 *
 * @param {string} value the value production is serving
 * @returns {Promise<void>}
 */
async function syncReceiver(value) {
  const url = process.env.ALERT_RECEIVER_SYNC_URL;
  const token = process.env.ALERT_RECEIVER_SYNC_TOKEN;
  if (!url || !token) {
    throw new RefusalError(
      'ALERT_RECEIVER_SYNC_URL and ALERT_RECEIVER_SYNC_TOKEN must both be set to sync a receiver',
    );
  }
  const res = await request(url, { method: 'POST', payload: { secret: value }, headers: { 'X-Sync-Token': token } });
  console.log(`receiver sync -> HTTP ${res.status}`);
  if (res.status !== 200) {
    throw new Error(
      `receiver sync failed: HTTP ${res.status} — the receiver would reject the value production now sends. ` +
        'Rollback: node server/scripts/rotate-secret.cjs rollback',
    );
  }
}

/**
 * Live probe for DEVICE_ENROLLMENT_SECRET.
 *
 * Enrolling necessarily creates a device row, so the probe revokes it through
 * the admin plane immediately: a never-seen device would otherwise turn into
 * watchdog noise. A failed cleanup fails the probe on purpose — it left a row
 * behind, and that is a state the operator must know about.
 */
async function verifyEnrollment({ accepted, rejected, operatorSecret }) {
  const checks = [];
  const notes = [];
  const oldRes = await api('/v5/device/enroll', {
    method: 'POST',
    payload: { label: 'rotate-secret probe (rejected attempt)' },
    headers: { Authorization: `Bearer ${rejected}` },
  });
  checks.push(check('old DEVICE_ENROLLMENT_SECRET on POST /v5/device/enroll -> 401', oldRes.status, 401));
  if (oldRes.status === 429) notes.push('the old-value probe was rate limited (HTTP 429)');

  const newRes = await api('/v5/device/enroll', {
    method: 'POST',
    payload: { label: 'rotate-secret probe (revoked immediately)' },
    headers: { Authorization: `Bearer ${accepted}` },
  });
  checks.push(check('new DEVICE_ENROLLMENT_SECRET on POST /v5/device/enroll -> 201', newRes.status, 201));
  if (newRes.status === 429) {
    notes.push(
      'the new-value probe was rate limited (HTTP 429): the new secret was not exercised — re-run once the per-IP window clears',
    );
  } else if (newRes.status === 201) {
    const deviceId = newRes.parsed?.deviceId;
    if (typeof deviceId !== 'string' || deviceId === '') {
      checks.push(check('probe device id returned so it can be revoked', deviceId, 'a non-empty string'));
    } else {
      const revokeRes = await api(`/v5/admin/devices/${encodeURIComponent(deviceId)}/revoke`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${operatorSecret}` },
      });
      checks.push(check(`probe device ${deviceId} revoked through the admin plane -> 200`, revokeRes.status, 200));
      if (revokeRes.status !== 200) {
        notes.push(
          `the probe device was left behind — revoke it by hand: curl -X POST ${publicBase}/v5/admin/devices/${deviceId}/revoke -H "Authorization: Bearer $OPERATOR_SECRET"`,
        );
      }
    }
  }
  return { checks, notes };
}

/**
 * Live probe for JWT_SECRET.
 *
 * Two independent facts must hold. First, a token crafted with the old secret
 * must be rejected on the only JWT-guarded route, POST /v5/device/register —
 * an old secret that still works is a rotation that did not happen. Second,
 * the service must be MINTING with the new secret: a throwaway probe user
 * registers and logs in, and the returned access token's HMAC is checked in
 * this process against the new and old values. The probe user is a real row
 * (there is no delete-user route); it is named so an operator can find it.
 */
async function verifyJwt({ accepted, rejected }) {
  const checks = [];
  const notes = [];
  const probeSub = `rotate-probe-${randomBytes(8).toString('hex')}`;

  const oldToken = buildJwt(rejected, { sub: probeSub, email: 'rotate-probe@probe.invalid' });
  const oldRes = await api('/v5/device/register', {
    method: 'POST',
    payload: { label: 'rotate-secret probe (rejected attempt)' },
    headers: { Authorization: `Bearer ${oldToken}` },
  });
  checks.push(check('crafted old-secret JWT on POST /v5/device/register -> 401', oldRes.status, 401));

  const email = `${probeSub}@probe.invalid`;
  const password = randomBytes(24).toString('base64url');
  const register = await api('/v5/auth/register', { method: 'POST', payload: { email, password } });
  checks.push(check(`throwaway probe user registered (${email}) -> 201`, register.status, 201));
  if (register.status !== 201) return { checks, notes };

  notes.push(`probe user created: ${email} (no delete route exists; one row per JWT rotation)`);
  const login = await api('/v5/auth/login', { method: 'POST', payload: { email, password } });
  checks.push(check('probe user login -> 200', login.status, 200));
  const token = login.parsed?.accessToken;
  if (login.status !== 200 || typeof token !== 'string') {
    checks.push(check('login returned an accessToken', token, 'a non-empty string'));
    return { checks, notes };
  }
  checks.push(check('server-minted token verifies under the new JWT_SECRET', verifyJwtHmac(token, accepted), true));
  checks.push(check('server-minted token does NOT verify under the old JWT_SECRET', verifyJwtHmac(token, rejected), false));
  return { checks, notes };
}

/**
 * Runs the live probe for `name` with the value that must now work (`accepted`)
 * and the value that must now fail (`rejected`).
 *
 * Returns observations rather than throwing on a miss so the caller can print
 * every check before deciding. Transport failures still throw: a probe that
 * could not run must never look like a probe that passed.
 *
 * @param {string} name target key
 * @param {{ accepted: string, rejected: string, operatorSecret: string }} values
 * @returns {Promise<{ checks: Array<{label: string, got: unknown, want: unknown, ok: boolean}>, notes: string[] }>}
 */
async function verifyTarget(name, values) {
  if (name === 'OPERATOR_SECRET') return verifyOperator(values);
  if (name === 'APP_PROVISIONING_SECRET') return verifyProvisioning(values);
  if (name === 'DEVICE_ENROLLMENT_SECRET') return verifyEnrollment(values);
  if (name === 'JWT_SECRET') return verifyJwt(values);
  if (name === 'ALERT_WEBHOOK_SECRET') return verifyAlertWebhook(values);
  throw new Error(`no live probe for ${name} — refusing to report verification`);
}

/**
 * Prints one probe's observations and throws if there were none.
 *
 * The empty case is a hard failure, not a pass: `[].every(...)` is true, so a
 * probe that returned nothing would otherwise print VERIFIED without ever
 * exercising the secret.
 */
function reportOutcome(name, outcome) {
  if (outcome.checks.length === 0) {
    throw new Error(`probe for ${name} returned no observations — refusing to report verification`);
  }
  for (const c of outcome.checks) {
    console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.label} (got: ${String(c.got)}, want: ${String(c.want)})`);
  }
  for (const note of outcome.notes) console.log(`  note: ${note}`);
}

/** Reads and validates the keyring snapshot, or refuses. */
function readSnapshot() {
  let saved;
  try {
    saved = JSON.parse(readSecret(ROLLBACK_ACCOUNT));
  } catch (err) {
    throw new RefusalError(`no usable rollback in the keyring (account "${ROLLBACK_ACCOUNT}"): ${err.message}`);
  }
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) {
    throw new RefusalError(`rollback snapshot in "${ROLLBACK_ACCOUNT}" is not an object of key -> value`);
  }
  const unknown = Object.keys(saved).filter((k) => !Object.prototype.hasOwnProperty.call(TARGETS, k));
  if (unknown.length > 0) {
    throw new RefusalError(
      `rollback snapshot names keys this script does not manage: ${unknown.join(', ')} — refusing to write them to Render`,
    );
  }
  return saved;
}

/** Rotate one target: snapshot, generate, PUT, deploy, verify. */
async function runRotate(name) {
  // Refused first, before the first credentialed call. Without a receiver to
  // sync, the probe below would measure an untested value and the run would
  // still print VERIFIED — and checking it here means the refusal needs no
  // Render credential to hit.
  if (TARGETS[name].receiverSync && (!process.env.ALERT_RECEIVER_SYNC_URL || !process.env.ALERT_RECEIVER_SYNC_TOKEN)) {
    throw new RefusalError(
      `${name} is verified through a live receiver, so ALERT_RECEIVER_SYNC_URL and ALERT_RECEIVER_SYNC_TOKEN ` +
        'must both be set — nothing written, deployed, or sent',
    );
  }

  const env = await getEnv();
  const missing = Object.keys(TARGETS).filter((k) => !env[k]);
  if (missing.length > 0) throw new RefusalError(`not set on Render, refusing to invent: ${missing.join(', ')}`);

  const before = {};
  for (const k of Object.keys(TARGETS)) before[k] = env[k];

  // 1. Rollback first, always before the write. The snapshot covers every
  //    target, so `rollback` can also undo a rotation made by the older
  //    four-secret rotator (and vice versa).
  writeSecret(ROLLBACK_ACCOUNT, JSON.stringify(before, null, 2));
  console.log(`rollback stored in the login keyring as "${ROLLBACK_ACCOUNT}" (pre-rotation values of every managed target)`);
  console.log('  it holds the OLD values; clear it once you are sure the rotation is good.');

  // 2. The one new value, written with the other sixteen env vars preserved verbatim.
  const generated = generateValue(name);
  env[name] = generated;
  console.log(`rotating ${name}: len ${before[name].length} -> ${generated.length}`);
  await putEnv(env);
  await deployAndWait();

  // 3. Read the value back from Render. A mismatch between what was PUT and
  //    what Render serves is a hard stop: the probes below would then be
  //    verifying a value nobody chose.
  const after = await getEnv();
  const live = after[name];
  const matches = live === generated;
  console.log(`${name} read back from Render: ${typeof live === 'string' ? `len ${live.length}` : 'missing'} (matches generated: ${matches})`);
  if (!matches) {
    throw new Error(
      `${name} read back from Render is not the value that was PUT — refusing to verify against it. Rollback: node server/scripts/rotate-secret.cjs rollback`,
    );
  }

  // The receiver must hold what production now serves, or the probe below
  // would fail on a receiver that is merely a step behind.
  if (TARGETS[name].receiverSync) await syncReceiver(generated);

  await requireHealthyService();

  const operatorSecret = name === 'OPERATOR_SECRET' ? live : (after.OPERATOR_SECRET ?? '');
  const outcome = await verifyTarget(name, { accepted: live, rejected: before[name], operatorSecret, env: after });
  reportOutcome(name, outcome);

  if (!outcome.checks.every((c) => c.ok)) {
    throw new Error(`${name} verification FAILED — rollback: node server/scripts/rotate-secret.cjs rollback`);
  }

  console.log('');
  console.log(`ROTATION VERIFIED for ${name}.`);
  console.log(`  rollback is held in the keyring as "${ROLLBACK_ACCOUNT}"; clear it when satisfied:`);
  console.log(`    secret-tool clear service dprelay account ${ROLLBACK_ACCOUNT}`);
}

/** Rollback: restore the snapshot and re-verify every key that changed. */
async function runRollback() {
  const saved = readSnapshot();
  const env = await getEnv();
  const changed = Object.keys(saved).filter((k) => env[k] !== saved[k]);
  if (changed.length === 0) {
    console.log('the live env already matches the keyring snapshot — nothing to roll back');
    return;
  }

  console.log(`rolling back ${changed.length} key(s): ${changed.join(', ')}`);

  // Same preflight as a rotation, and equally before any write: restoring a
  // receiver-verified secret without a receiver to re-sync leaves the rollback
  // unverifiable halfway through.
  const needingSync = changed.filter((k) => TARGETS[k]?.receiverSync);
  if (needingSync.length > 0 && (!process.env.ALERT_RECEIVER_SYNC_URL || !process.env.ALERT_RECEIVER_SYNC_TOKEN)) {
    throw new RefusalError(
      `rollback restores ${needingSync.join(', ')}, which is verified through a live receiver: set ` +
        'ALERT_RECEIVER_SYNC_URL and ALERT_RECEIVER_SYNC_TOKEN — nothing written or deployed',
    );
  }
  const superseded = {};
  for (const k of changed) {
    superseded[k] = env[k];
    console.log(`  ${k}: len ${typeof env[k] === 'string' ? env[k].length : 'missing'} -> ${saved[k].length}`);
    env[k] = saved[k];
  }
  await putEnv(env);
  await deployAndWait();

  // Read back first: verifying against values Render did not store would be
  // theatre. Then probe every changed key with the restored value accepted and
  // the superseded one rejected.
  const after = await getEnv();
  for (const k of changed) {
    if (after[k] !== saved[k]) {
      throw new Error(`${k} read back from Render is not the restored snapshot value — rollback did not take effect`);
    }
  }
  await requireHealthyService();
  for (const k of changed) {
    if (TARGETS[k].receiverSync) await syncReceiver(saved[k]);
    const operatorSecret = k === 'OPERATOR_SECRET' ? saved[k] : (after.OPERATOR_SECRET ?? '');
    const outcome = await verifyTarget(k, { accepted: saved[k], rejected: superseded[k], operatorSecret, env: after });
    reportOutcome(k, outcome);
    if (!outcome.checks.every((c) => c.ok)) {
      throw new Error(`rollback verification FAILED for ${k}`);
    }
  }
  console.log('');
  console.log(`ROLLBACK VERIFIED for ${changed.join(', ')}.`);
}

/** Prints the plan for a rotation without any network call. */
function printPlan(name) {
  const target = TARGETS[name];
  console.log(`would rotate ${name} on Render service ${serviceId}`);
  console.log(`  generator     : ${target.format}`);
  console.log(`  probe         : ${target.describe}`);
  console.log(`  rollback first: snapshot every managed target into keyring account "${ROLLBACK_ACCOUNT}"`);
  if (target.receiverSync) {
    console.log('  receiver     : after the deploy the new value is handed to ALERT_RECEIVER_SYNC_URL, then probed');
  }
  console.log(`  deploy        : PUT env-vars, POST /deploys, poll until live, then read the value back`);
  console.log('  no network calls and no writes happen in --dry-run');
}

/** Prints what a rollback would do without any network call. */
function printRollbackPlan() {
  let saved;
  try {
    saved = readSnapshot();
  } catch (err) {
    console.log(`no rollback snapshot available: ${err.message}`);
    return EXIT_REFUSED;
  }
  console.log(`would restore ${Object.keys(saved).length} key(s) from keyring account "${ROLLBACK_ACCOUNT}": ${Object.keys(saved).join(', ')}`);
  console.log('  only keys that actually differ from the deployed env would be written, then re-probed after the deploy');
  console.log('  no network calls and no writes happen in --dry-run');
  return 0;
}

/** The full usage text, including why non-targets are refused. */
function printUsage() {
  console.log('rotate-secret — rotate one operator-plane secret on demand.');
  console.log('');
  console.log('usage:');
  console.log('  node server/scripts/rotate-secret.cjs <NAME>            rotate + deploy + verify');
  console.log('  node server/scripts/rotate-secret.cjs <NAME> --dry-run  plan only: no network, no writes');
  console.log('  node server/scripts/rotate-secret.cjs rollback          restore the keyring snapshot + verify');
  console.log('  node server/scripts/rotate-secret.cjs rollback --dry-run');
  console.log('');
  console.log('targets:');
  for (const [name, target] of Object.entries(TARGETS)) {
    console.log(`  ${name}`);
    console.log(`    format: ${target.format}`);
    console.log(`    probe : ${target.describe}`);
  }
  console.log('');
  console.log('refused on purpose:');
  for (const [name, reason] of Object.entries(REFUSALS)) {
    console.log(`  ${name.padEnd(24)} ${reason}`);
  }
  console.log('');
  console.log('exit codes: 0 = verified | 1 = failed | 2 = refused (nothing written)');
  console.log('DRY_RUN set to any non-empty value refuses to run (exit 2) before any network call.');
  console.log(`rollback snapshot: keyring account "${ROLLBACK_ACCOUNT}".`);
  console.log('values are never printed — only key names, lengths, and status codes.');
}

/**
 * CLI entry point.
 *
 * @param {string[]} argv arguments after the script path
 * @returns {Promise<number>} exit code
 */
async function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.mode === 'help') {
    printUsage();
    // A bare invocation asked for nothing, so it is a refusal; --help is a
    // successful answer to a question.
    return argv.length === 0 ? EXIT_REFUSED : 0;
  }
  if (parsed.mode === 'rollback') {
    if (parsed.dryRun) return printRollbackPlan();
    await runRollback();
    return 0;
  }
  const refusal = refusalFor(parsed.name);
  if (refusal !== null) throw new RefusalError(`refusing to rotate ${parsed.name}: ${refusal}`);
  if (parsed.dryRun) {
    printPlan(parsed.name);
    return 0;
  }
  await runRotate(parsed.name);
  return 0;
}

module.exports = {
  TARGETS,
  REFUSALS,
  ROLLBACK_ACCOUNT,
  EXIT_REFUSED,
  parseArgs,
  refusalFor,
  generateValue,
  buildJwt,
  verifyJwtHmac,
  verifyAlertWebhook,
};

// Only run as a CLI. The test suite imports this module, and must never be able
// to trigger a live run (or a process exit) by doing so.
if (require.main === module) {
  refuseIfDryRun();
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err instanceof RefusalError ? `REFUSED: ${err.message}` : err.message);
      process.exitCode = err instanceof RefusalError ? EXIT_REFUSED : 1;
    });
}
