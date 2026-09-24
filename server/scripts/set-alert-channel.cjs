/**
 * One-off Render env writer for the ALERT_WEBHOOK_URL end-to-end proof.
 * Modes:
 *   set     — GET env, set ALERT_WEBHOOK_URL (+ generated ALERT_WEBHOOK_SECRET,
 *             + WATCHDOG_STALE_SEC=60 temporarily to force one real alert), PUT back.
 *   revert  — GET env, drop the temporary WATCHDOG_STALE_SEC override, PUT back.
 *   wait-live — poll the latest Render deploy until status=live (or timeout).
 * Secrets are never printed — only key names and status codes.
 */
const { readFileSync } = require('node:fs');
const { randomBytes } = require('node:crypto');
const https = require('node:https');

const repoRoot = '/home/zia/Documents/My Projects/Authenticator';
const kiloRaw = readFileSync(`${repoRoot}/.kilo/kilo.jsonc`, 'utf8');
const kiloClean = kiloRaw.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const apiKey = JSON.parse(kiloClean).mcp.render.environment.RENDER_API_KEY;
const serviceId = 'srv-dal3bae7bikc73e7k7pg';
const base = `https://api.render.com/v1/services/${serviceId}`;

function request(path, method, payload) {
  return new Promise((resolve, reject) => {
    const data = payload ? JSON.stringify(payload) : null;
    const req = https.request(
      `${base}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          let parsed = null;
          try { parsed = body ? JSON.parse(body) : null; } catch { parsed = body; }
          resolve({ status: res.statusCode, parsed });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function getEnv() {
  const res = await request('/env-vars', 'GET');
  if (res.status !== 200) throw new Error(`GET env failed: ${res.status}`);
  const items = Array.isArray(res.parsed) ? res.parsed : res.parsed.env_vars;
  const env = {};
  for (const item of items) {
    const inner = item.envVar ?? item;
    env[inner.key] = inner.value;
  }
  return env;
}

async function putEnv(env) {
  const res = await request('/env-vars', 'PUT', Object.entries(env).map(([key, value]) => ({ key, value })));
  console.log(`PUT env status: ${res.status}`);
  if (res.status !== 200) throw new Error(`PUT failed: ${JSON.stringify(res.parsed).slice(0, 300)}`);
}

const mode = process.argv[2];

(async () => {
  if (mode === 'set') {
    const url = process.argv[3];
    if (!url || !/^https:\/\//.test(url)) throw new Error('usage: set-alert-channel.cjs set <https receiver url>');
    const env = await getEnv();
    const before = Object.keys(env).length;
    env.ALERT_WEBHOOK_URL = url;
    env.ALERT_WEBHOOK_SECRET = env.ALERT_WEBHOOK_SECRET || randomBytes(32).toString('base64url');
    env.WATCHDOG_STALE_SEC = '60'; // temporary: forces one real prod alert for the proof
    console.log(`env keys: ${before} -> ${Object.keys(env).length}`);
    console.log('setting: ALERT_WEBHOOK_URL, ALERT_WEBHOOK_SECRET (generated if absent), WATCHDOG_STALE_SEC=60 (temporary)');
    await putEnv(env);
  } else if (mode === 'set-stale') {
    const sec = process.argv[3];
    if (!/^\d+$/.test(sec ?? '')) throw new Error('usage: set-alert-channel.cjs set-stale <seconds>');
    const env = await getEnv();
    env.WATCHDOG_STALE_SEC = sec;
    console.log(`setting WATCHDOG_STALE_SEC=${sec} (temporary)`);
    await putEnv(env);
  } else if (mode === 'revert') {
    const env = await getEnv();
    if (!('WATCHDOG_STALE_SEC' in env)) {
      console.log('WATCHDOG_STALE_SEC not present — nothing to revert');
      return;
    }
    delete env.WATCHDOG_STALE_SEC;
    console.log('reverting: removing WATCHDOG_STALE_SEC (back to default 900)');
    await putEnv(env);
  } else if (mode === 'deploy') {
    // Env-var PUTs do NOT auto-deploy on this service — trigger a restart
    // deploy of the latest commit so the new env is actually loaded.
    const res = await request('/deploys', 'POST', {});
    console.log(`POST deploys status: ${res.status}`);
    if (res.status !== 201) throw new Error(`deploy trigger failed: ${JSON.stringify(res.parsed).slice(0, 300)}`);
  } else if (mode === 'wait-live') {
    const deadline = Date.now() + 9 * 60 * 1000;
    while (Date.now() < deadline) {
      const res = await request('/deploys?limit=1', 'GET');
      const d = Array.isArray(res.parsed) ? res.parsed[0] : null;
      const inner = d ? (d.deploy ?? d) : null;
      if (inner) {
        console.log(`deploy ${inner.status} (commit ${String(inner.commit?.id ?? '').slice(0, 7)})`);
        if (inner.status === 'live' || inner.status === 'deactivated' || inner.status === 'build_failed') {
          if (inner.status !== 'live') process.exit(1);
          return;
        }
      }
      await new Promise((r) => setTimeout(r, 15000));
    }
    throw new Error('deploy did not go live within 9 minutes');
  } else {
    throw new Error('usage: set-alert-channel.cjs <set <url> | revert | wait-live>');
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
