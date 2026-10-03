/**
 * One-off Render env writer for the alert-channel end-to-end proofs.
 * Modes:
 *   set     — GET env, set ALERT_WEBHOOK_URL (+ generated ALERT_WEBHOOK_SECRET,
 *             + WATCHDOG_STALE_SEC=60 temporarily to force one real alert), PUT back.
 *   set-stale <sec> — temporarily set WATCHDOG_STALE_SEC (forces the stale alert).
 *   revert  — GET env, drop the temporary WATCHDOG_STALE_SEC override, PUT back.
 *   deploy  — POST /deploys (env PUTs alone do NOT deploy).
 *   wait-live — poll the latest Render deploy until status=live (or timeout).
 *   telegram <botToken> <chatId> — ONE-COMMAND Telegram setup + proof:
 *       1) verify the bot+chat pair against the real Bot API (getMe, then a
 *          probe sendMessage — the exact dispatchAlert call path) BEFORE any
 *          Render write, so bad creds never deploy;
 *       2) set TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID (preserving all other
 *          vars) + temporary WATCHDOG_STALE_SEC=60, PUT back;
 *       3) trigger the deploy and wait for live — the stale alert then lands
 *          in the verified chat within ~10 min. Run `revert` afterwards.
 *     Arguments live in shell history (owner-local tradeoff, documented);
 *     token/chatId are never echoed, and only the bot's public @username is
 *     printed. TELEGRAM_API_BASE / RENDER_API_BASE override the two API origins
 *     (local verification of this script only, mirroring each other).
 *
 * DRY_RUN is treated as a HAZARD, not a rehearsal switch. If it is present and
 * non-empty this script REFUSES to run at all: the check fires before any network
 * call, before the Bot API probe, before any Render write, and exits 2 with a
 * loud banner. The reason is that a DRY_RUN inherited from a shell wrapper, sudo
 * or an agent runner is indistinguishable from a real run at the call site — that
 * is exactly how "real" staging runs silently became no-ops. Only an explicitly
 * unset value permits a run: either absent, or emptied for one invocation with
 * `DRY_RUN= node ...`. There is deliberately no rehearsal mode; a script whose
 * job is to tell the truth about production state should never quietly do less
 * work than it appears to.
 *
 * Exit codes: 0 = succeeded, 1 = failed, 2 = refused (DRY_RUN set, nothing done).
 * Secrets are never printed — only key names and status codes.
 */
const { readFileSync } = require('node:fs');
const { randomBytes } = require('node:crypto');
const https = require('node:https');
const http = require('node:http');

/**
 * Picks the http or https client to match a configured origin.
 *
 * The *_API_BASE overrides exist so this script can be verified against a local
 * mock, and a local mock is plain http — so the transport follows the base URL
 * instead of being pinned to https, which would make the overrides unusable.
 * Production origins are https and take the https path unchanged.
 */
const clientFor = (url) => (url.startsWith('http://') ? http : https);

/** Exit code meaning "refused to start; nothing was sent, written or deployed". */
const EXIT_REFUSED = 2;

// The hazard gate, placed above everything that can fail or reach the network.
// It must sit below EXIT_REFUSED (that const is not hoisted) and above the
// credential read below: reading .kilo/kilo.jsonc throws on a missing or
// malformed file, and a driver with DRY_RUN set deserves the loud refusal
// rather than a TypeError about an unrelated property. Function declarations
// hoist, so calling this ahead of its definition below is fine — and if it were
// ever moved above EXIT_REFUSED, every DRY_RUN test would fail on a TDZ
// ReferenceError instead of exiting 2.
refuseIfDryRun();
/** Per-request ceiling. A hung API call must fail loudly, not freeze the shell. */
const REQUEST_TIMEOUT_MS = 15_000;

const repoRoot = '/home/zia/Documents/My Projects/Authenticator';
const kiloRaw = readFileSync(`${repoRoot}/.kilo/kilo.jsonc`, 'utf8');
const kiloClean = kiloRaw.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const apiKey = JSON.parse(kiloClean).mcp.render.environment.RENDER_API_KEY;
const serviceId = 'srv-dal3bae7bikc73e7k7pg';
const base = `${process.env.RENDER_API_BASE || 'https://api.render.com/v1/services'}/${serviceId}`;

/**
 * Refuses to start when DRY_RUN is present and non-empty.
 *
 * Deliberately the very first thing the script does, ahead of argument parsing
 * and ahead of every network call, so no mode can be reached with the hazard
 * set — not even the read-only Bot API probe. A literally empty value
 * (`DRY_RUN= cmd`) counts as unset, which is how an operator overrides an
 * inherited export for a single invocation.
 *
 * Fails CLOSED: anything other than absent-or-empty blocks, including a
 * whitespace-only value. A blank-looking hazard is still a hazard, and a gate
 * that trims its way past one would reintroduce the exact class of bug this
 * exists to prevent.
 *
 * The banner is the point: the operator must see that the Render write was
 * skipped rather than infer it from a status code nobody reads.
 */
function refuseIfDryRun() {
  const raw = process.env.DRY_RUN;
  if (raw === undefined || raw === '') return;
  const invocation = ['telegram', 'set', 'set-stale', 'revert', 'deploy', 'wait-live']
    .find((m) => process.argv[2] === m);
  console.error('');
  console.error('============================================================');
  console.error('REFUSING TO RUN: DRY_RUN is set in this environment');
  console.error(`  DRY_RUN=${JSON.stringify(raw)}   (any non-empty value blocks execution)`);
  console.error(`  requested: ${invocation ? invocation : process.argv[2] ?? '(no mode)'}`);
  console.error('');
  console.error('NOTHING happened: no message was sent, no Render env was');
  console.error('written, and no deploy was triggered. This script refuses to');
  console.error('run with DRY_RUN set because an inherited value from a shell');
  console.error('wrapper, sudo or an agent runner is indistinguishable from a');
  console.error('real run at the call site — which is how "real" runs became');
  console.error('silent no-ops.');
  console.error('');
  console.error('To run for real, unset it for this invocation only:');
  console.error(`  DRY_RUN= node server/scripts/set-alert-channel.cjs ${process.argv.slice(2).join(' ')}`);
  console.error('  (or `unset DRY_RUN`, or open a fresh shell)');
  console.error('');
  console.error('exit code 2 = refused, nothing happened');
  console.error('============================================================');
  process.exit(EXIT_REFUSED);
}

/** Renders a Render error body as a message without ever dumping env values. */
function renderErrorDetail(parsed) {
  if (parsed && typeof parsed === 'object' && typeof parsed.message === 'string') {
    return parsed.message.slice(0, 200);
  }
  return 'no message in response body';
}

function request(path, method, payload) {
  return new Promise((resolve, reject) => {
    const data = payload ? JSON.stringify(payload) : null;
    // Without this a stalled Render connection leaves the operator staring at a
    // hung terminal with no output and no way to tell it apart from "working".
    const req = clientFor(base).request(
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
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`render api timeout after ${REQUEST_TIMEOUT_MS}ms (${method} ${path})`));
    });
    if (data) req.write(data);
    req.end();
  });
}

async function getEnv() {
  const res = await request('/env-vars', 'GET');
  if (res.status !== 200) {
    // Never print the body here: on this endpoint it holds live env values.
    throw new Error(`GET env failed: HTTP ${res.status} — ${renderErrorDetail(res.parsed)}`);
  }
  const items = Array.isArray(res.parsed) ? res.parsed : res.parsed?.env_vars;
  if (!Array.isArray(items)) {
    throw new Error('GET env failed: response was not an env-var array — Render API shape changed');
  }
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
  if (res.status !== 200) {
    throw new Error(`PUT env failed: HTTP ${res.status} — ${renderErrorDetail(res.parsed)}`);
  }
}

/**
 * Triggers a deploy and reports the outcome with its own recovery instructions.
 *
 * Split out because a failed deploy after a successful env PUT is the one
 * genuinely half-applied state this script can leave behind: the env now holds
 * WATCHDOG_STALE_SEC=60, which does not take effect until some later deploy
 * loads it. Saying "run revert" at that moment is the difference between a
 * five-second fix and a stale watchdog that starts screaming on the next
 * unrelated push.
 */
async function triggerDeploy() {
  const res = await request('/deploys', 'POST', {});
  console.log(`POST deploys status: ${res.status}`);
  if (res.status !== 201) {
    throw new Error(
      `deploy trigger failed: HTTP ${res.status} — ${renderErrorDetail(res.parsed)}\n` +
        '  NOTE: if this was the telegram mode, the env PUT already succeeded, so ' +
        'WATCHDOG_STALE_SEC=60 is now set in Render and will load on the next deploy.\n' +
        '  Recovery: node server/scripts/set-alert-channel.cjs revert',
    );
  }
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
      console.log('WATCHDOG_STALE_SEC not present — nothing to revert (no change made)');
      return;
    }
    delete env.WATCHDOG_STALE_SEC;
    console.log('reverting: removing WATCHDOG_STALE_SEC (back to default 900)');
    await putEnv(env);
  } else if (mode === 'deploy') {
    // Env-var PUTs do NOT auto-deploy on this service — trigger a restart
    // deploy of the latest commit so the new env is actually loaded.
    await triggerDeploy();
  } else if (mode === 'wait-live') {
    const deadline = Date.now() + 9 * 60 * 1000;
    while (Date.now() < deadline) {
      const res = await request('/deploys?limit=1', 'GET');
      const d = Array.isArray(res.parsed) ? res.parsed[0] : null;
      const inner = d ? (d.deploy ?? d) : null;
      if (inner) {
        console.log(`deploy ${inner.status} (commit ${String(inner.commit?.id ?? '').slice(0, 7)})`);
        if (inner.status === 'live') return;
        if (inner.status === 'build_failed') throw new Error('deploy build_failed — see the Render dashboard build log');
        if (inner.status === 'deactivated') {
          // Not a build failure: the deploy exists but is no longer the active
          // one, almost always because a newer deploy superseded it.
          throw new Error('deploy deactivated — superseded by a newer deploy, so this wait is watching the wrong commit');
        }
      }
      await new Promise((r) => setTimeout(r, 15000));
    }
    throw new Error('deploy did not go live within 9 minutes — last poll never reached a terminal status');
  } else if (mode === 'telegram') {
    const botToken = process.argv[3];
    const chatId = process.argv[4];
    if (!botToken || !chatId) {
      throw new Error('usage: set-alert-channel.cjs telegram <botToken> <chatId>');
    }
    // Verify against the REAL Bot API first — dispatchAlert posts to exactly
    // this endpoint shape, so a green probe means production alerts will land.
    // TELEGRAM_API_BASE exists solely for local verification of this script.
    const tgBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
    const tgRequest = (pathname, payload) =>
      new Promise((resolve, reject) => {
        const data = payload ? JSON.stringify(payload) : null;
        const req = clientFor(tgBase).request(
          `${tgBase}${pathname}`,
          {
            method: data ? 'POST' : 'GET',
            headers: {
              'Content-Type': 'application/json',
              ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
            },
          },
          (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => {
              let parsed = null;
              try { parsed = body ? JSON.parse(body) : null; } catch { parsed = null; }
              resolve({ status: res.statusCode, parsed });
            });
          },
        );
        req.on('error', reject);
        req.setTimeout(REQUEST_TIMEOUT_MS, () => {
          req.destroy(new Error(`telegram api timeout after ${REQUEST_TIMEOUT_MS}ms (${pathname})`));
        });
        if (data) req.write(data);
        req.end();
      });
    const me = await tgRequest(`/bot${botToken}/getMe`);
    if (me.status !== 200 || !me.parsed?.ok) {
      throw new Error(`bot verification failed (HTTP ${me.status}) — token rejected by the Bot API; nothing written to Render`);
    }
    console.log(`bot verified: @${me.parsed.result?.username ?? 'unknown'}`);
    const probe = await tgRequest(`/bot${botToken}/sendMessage`, {
      chat_id: chatId,
      text: 'dP Relay alert-channel verification — if you can read this, the ops channel works.',
    });
    if (probe.status !== 200 || !probe.parsed?.ok) {
      const why = probe.parsed?.description ? ` — Bot API says: ${probe.parsed.description}` : '';
      throw new Error(`chat verification failed (HTTP ${probe.status})${why}; nothing written to Render`);
    }
    console.log('chat verified: probe message delivered — check the ops group now');
    const env = await getEnv();
    env.TELEGRAM_BOT_TOKEN = botToken;
    env.TELEGRAM_CHAT_ID = chatId;
    env.WATCHDOG_STALE_SEC = '60'; // temporary: forces one real prod alert for the proof
    console.log('setting: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, WATCHDOG_STALE_SEC=60 (temporary)');
    await putEnv(env);
    await triggerDeploy();
    console.log('deploy triggered — the stale alert should land in the verified chat within ~10 min of live; run `revert` after the proof');
  } else {
    throw new Error(
      'usage: set-alert-channel.cjs <telegram <botToken> <chatId> | set <url> | set-stale <sec> | revert | deploy | wait-live>\n' +
        '  refuses to run (exit 2) while DRY_RUN is set to a non-empty value.',
    );
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
