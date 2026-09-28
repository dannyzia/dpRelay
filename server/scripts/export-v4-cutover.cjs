/**
 * T-0 cutover v4 export (CUTOVER-CHECKLIST §4 T-0; ISSUE-36 gate item 3).
 *
 * Re-exports the 9 v4 sources from Firebase (RTDB REST + Firestore REST) into
 * staging/v4-export-cutover-<date>/ in the exact byte-shape the frozen
 * 2026-09-19 baseline uses (rtdb/<name>.json keyed objects, firestore/<name>.json
 * {collection, documents:[{name, fields}]} REST envelopes), then writes
 * manifest.json ({exported_at, project, sources:[{source, rows, sha256}]}).
 *
 * Authentication: pass GOOGLE_OAUTH_ACCESS_TOKEN (minted per the runbook via
 * `gcloud auth print-access-token`), or set FIREBASE_SERVICE_ACCOUNT_JSON to a
 * service-account path and the script mints a token itself (RS256 over the
 * JWT grant to https://oauth2.googleapis.com/token; no dependencies).
 *
 * Modes:
 *   (default)  export into --out (default staging/v4-export-cutover-<date>)
 *   --verify   re-hash an existing export dir and diff against its manifest
 *
 * House rules: contents are never printed (counts + hashes only); the frozen
 * baseline directory is never written to; Firestore reads are strongly
 * consistent (single-run readTime is meaningless across sources but each
 * response IS the data at its own read time — the manifest pins what was read).
 */
const { readFileSync, mkdirSync, writeFileSync, existsSync } = require('node:fs');
const { createHash, createSign } = require('node:crypto');
const https = require('node:https');

const PROJECT = 'authenticator-15fb7';
// RTDB instance is REGIONAL (asia-southeast1), not the default firebaseio.com
// host — verified against the frozen baseline provenance (web/.env v4 config).
// Override with FIREBASE_RTDB_BASE if the instance ever moves.
const RTDB_BASE = process.env.FIREBASE_RTDB_BASE
  ?? `https://${PROJECT}-default-rtdb.asia-southeast1.firebasedatabase.app`;
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

const RTDB_SOURCES = ['registered_apps', 'stats', 'config', 'health'];
const FS_SOURCES = ['packages', 'transactions', 'app_credits', 'contactGroups', 'messageTemplates'];

// ── auth ────────────────────────────────────────────────────────────────────
function mintTokenFromServiceAccount(saPath) {
  const sa = JSON.parse(readFileSync(saPath, 'utf8'));
  if (!sa.client_email || !sa.private_key) {
    throw new Error('service account JSON missing client_email/private_key');
  }
  const iat = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: [
      'https://www.googleapis.com/auth/firebase.database',
      'https://www.googleapis.com/auth/datastore',
      'https://www.googleapis.com/auth/cloud-platform',
    ].join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat,
    exp: iat + 3600,
  })).toString('base64url');
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(sa.private_key, 'base64url');
  const assertion = `${header}.${claims}.${signature}`;
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${assertion}`;
  return new Promise((resolve, reject) => {
    const req = https.request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(b);
          if (res.statusCode !== 200 || !j.access_token) reject(new Error(`token mint failed (HTTP ${res.statusCode})`));
          else resolve(j.access_token);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function resolveToken() {
  if (process.env.GOOGLE_OAUTH_ACCESS_TOKEN) return process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return mintTokenFromServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }
  console.error('No credentials: set GOOGLE_OAUTH_ACCESS_TOKEN (gcloud auth print-access-token) or FIREBASE_SERVICE_ACCOUNT_JSON.');
  process.exit(2);
}

// ── fetch helpers ───────────────────────────────────────────────────────────
function getJson(url, token) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Authorization: `Bearer ${token}` } }, (res) => {
      if (res.statusCode === 302 && res.headers.location) {
        // RTDB REST can redirect to a regional host; follow exactly once.
        res.resume();
        getJson(res.headers.location, token).then(resolve, reject);
        return;
      }
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} on ${url.split('?')[0]}`));
          return;
        }
        try { resolve(JSON.parse(b)); } catch (e) { reject(new Error(`bad JSON from ${url.split('?')[0]}`)); }
      });
    }).on('error', reject);
  });
}

async function fetchRtdb(name, token) {
  // RTDB REST with no ?print=pretty returns the compact keyed object.
  return getJson(`${RTDB_BASE}/${name}.json`, token);
}

async function fetchFirestore(name, token) {
  // Matches the baseline shape: {collection, documents:[{name, fields}]}.
  const documents = [];
  let pageToken = null;
  let pages = 0;
  do {
    const url = `${FS_BASE}/${name}?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const page = await getJson(url, token);
    for (const doc of page.documents ?? []) documents.push(doc);
    pageToken = page.nextPageToken ?? null;
    pages += 1;
    if (pages > 100) throw new Error('runaway pagination guard tripped');
  } while (pageToken);
  return { collection: name, documents };
}

// ── main ────────────────────────────────────────────────────────────────────
(async () => {
  const args = process.argv.slice(2);
  const verifyIdx = args.indexOf('--verify');
  const outIdx = args.indexOf('--out');
  const defaultOut = `staging/v4-export-cutover-${new Date().toISOString().slice(0, 10)}`;
  const outDir = outIdx !== -1 ? args[outIdx + 1] : defaultOut;

  const manifestPath = `${outDir}/manifest.json`;

  if (verifyIdx !== -1) {
    if (!existsSync(manifestPath)) { console.error(`no manifest at ${manifestPath}`); process.exit(1); }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    let ok = true;
    for (const s of manifest.sources) {
      const p = `${outDir}/${s.source}.json`;
      if (!existsSync(p)) { console.error(`MISSING ${s.source}`); ok = false; continue; }
      const hash = createHash('sha256').update(readFileSync(p)).digest('hex');
      const match = hash === s.sha256;
      if (!match) ok = false;
      console.log(`${match ? 'MATCH' : 'DIFF '} ${s.source} rows=${s.rows} sha256=${hash.slice(0, 16)}…`);
    }
    console.log(ok ? 'VERIFY OK — export matches its manifest' : 'VERIFY FAILED');
    process.exit(ok ? 0 : 1);
  }

  if (outDir.startsWith('staging/v4-export-final')) {
    console.error('refusing to write into the frozen baseline directory');
    process.exit(2);
  }
  if (existsSync(outDir)) { console.error(`refusing to overwrite existing ${outDir} — remove it or pass --out`); process.exit(2); }

  const token = await resolveToken();
  mkdirSync(`${outDir}/rtdb`, { recursive: true });
  mkdirSync(`${outDir}/firestore`, { recursive: true });

  const sources = [];
  for (const name of RTDB_SOURCES) {
    const data = await fetchRtdb(name, token);
    if (data === null) { console.error(`ABORT: rtdb/${name} is EMPTY (null) — source unreadable or wrong project`); process.exit(1); }
    const rows = Object.keys(data).length;
    const json = JSON.stringify(data);
    const sha = createHash('sha256').update(json).digest('hex');
    writeFileSync(`${outDir}/rtdb/${name}.json`, json);
    sources.push({ source: `rtdb/${name}`, rows, sha256: sha });
    console.log(`rtdb/${name}: rows=${rows} sha256=${sha.slice(0, 16)}…`);
  }
  for (const name of FS_SOURCES) {
    const data = await fetchFirestore(name, token);
    if (!data.documents.length) { console.error(`ABORT: firestore/${name} has ZERO documents — source unreadable or wrong project`); process.exit(1); }
    const rows = data.documents.length;
    const json = JSON.stringify(data, null, 2);
    const sha = createHash('sha256').update(json).digest('hex');
    writeFileSync(`${outDir}/firestore/${name}.json`, json);
    sources.push({ source: `firestore/${name}`, rows, sha256: sha });
    console.log(`firestore/${name}: rows=${rows} sha256=${sha.slice(0, 16)}…`);
  }

  const manifest = {
    exported_at: new Date().toISOString(),
    project: PROJECT,
    sources,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const total = sources.reduce((a, s) => a + s.rows, 0);
  console.log(`\nmanifest: ${sources.length} sources, ${total} rows total -> ${manifestPath}`);
  console.log('contents never printed (counts + hashes only). Next: dry-run reconciliation per 30-T0-RUNBOOK.md.');
})().catch((err) => {
  console.error('EXPORT FAILED:', err.message);
  process.exit(1);
});
