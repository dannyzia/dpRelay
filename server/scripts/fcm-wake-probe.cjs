/**
 * fcm-wake-probe — prove the FCM credential actually reaches a device.
 *
 * Why this exists: `rotate-fcm-key.cjs verify` proves the key was STORED on
 * Render and that the service is up. Neither of those proves the credential can
 * still push. A service-account key can parse, store, and pass a health check
 * while being revoked at the source, or while its FCM permission is gone — the
 * failure then shows up as phones that simply stop waking, with nothing in the
 * server logs, because wakeGateway() is best-effort by contract. The only way to
 * know is to send one real message and get a real verdict back.
 *
 * This sends ONE data-only message to ONE device token and interprets the HTTP
 * result into a verdict:
 *   200 + name          ACCEPTED      key healthy AND token valid — proof
 *   401 / 403           KEY UNHEALTHY stop here; the token verdict is meaningless
 *   UNREGISTERED        TOKEN STALE   key is fine, the device token is dead
 *   INVALID_ARGUMENT    TOKEN BAD     key is fine, the token is malformed
 *   429                 QUOTA         key is fine, FCM is rate-limiting
 *
 * "Harmless": AuthFcmService.onMessageReceived ignores the payload entirely — it
 * restarts the gateway service, reports health to RTDB, and reconciles. So the
 * probe wakes the phone exactly like production, sends no SMS itself, creates no
 * OTP session, and touches no server state. Use kind=ops_probe rather than the
 * production kind=outstanding purely so a probe is identifiable in the FCM
 * console; the gateway treats them identically.
 *
 * Device-side corroboration (the other half of the proof): the phone logs
 * "FCM message received" and rewrites /health/{androidId}.lastPing in Firebase
 * RTDB. A 200 here plus a moved lastPing is end-to-end proof; a 200 plus an
 * unmoved lastPing means the key is healthy but something between FCM and the
 * app is not.
 *
 * Usage:
 *   node server/scripts/fcm-wake-probe.cjs --token-file /path/to/token.txt
 *   FCM_PROBE_TOKEN=... node server/scripts/fcm-wake-probe.cjs
 *   node server/scripts/fcm-wake-probe.cjs --dry-run
 *   node server/scripts/fcm-wake-probe.cjs --key-file ./new-sa.json --token-file t.txt
 *
 * Flags:
 *   --key-file <path>   test a CANDIDATE key file instead of the live Render one
 *                       (validates a new key before it is ever deployed)
 *   --token-file <path> read the device token from a file — preferred over argv,
 *                       which lands in shell history and `ps`
 *   --dry-run           mint a token and run the empty-message probe only;
 *                       contacts no device and sends nothing
 *   --note <text>       free-text marker echoed into the message data so the
 *                       send is self-identifying in the FCM console
 *
 * Env:
 *   FCM_PROBE_TOKEN     device token (alternative to --token-file)
 *   RENDER_SERVICE_ID   override the target service (default: the dprelay-api one)
 *   RENDER_API_KEY      override the API key (default: ~/.config/dprelay/render-api-key)
 *
 * Neither the device token nor the service-account private key is ever printed,
 * logged, or written. Only key identity (project, private_key_id), status codes,
 * error codes, and the FCM message id are printed.
 */
const { readFileSync, existsSync } = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { createSign } = require("node:crypto");
const { resolveRenderApiKey } = require("./render-key.cjs");

const repoRoot = path.resolve(__dirname, "..", "..");
const DEFAULT_SERVICE_ID = "srv-dal3bae7bikc73e7k7pg";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

function request(url, { method = "GET", payload = null, body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    // `payload` is a JSON object; `body` is an already-encoded raw string (the
    // OAuth token endpoint is form-encoded, not JSON). These must not be
    // conflated — JSON.stringify() on the form string wraps it in quotes and
    // Google answers 400 invalid_request, which reads exactly like a bad key.
    const data = payload !== null ? JSON.stringify(payload) : body;
    const req = https.request(
      url,
      {
        method,
        headers: {
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
          ...(data && payload !== null ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          let parsed = null;
          try { parsed = body ? JSON.parse(body) : null; } catch { parsed = body; }
          resolve({ status: res.statusCode, parsed });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Render API key: shared resolution, so this probe and the ops scripts agree. */
function renderApiKey() {
  return resolveRenderApiKey({ repoRoot });
}

const serviceId = process.env.RENDER_SERVICE_ID || DEFAULT_SERVICE_ID;
const renderBase = `https://api.render.com/v1/services/${serviceId}`;

function renderRequest(path, method, payload, apiKey) {
  return request(`${renderBase}${path}`, {
    method,
    payload,
    headers: { Authorization: `Bearer ${apiKey}` },
  });
}

/** The live FCM credential exactly as the running service sees it. */
async function liveFcmJson(apiKey) {
  const res = await renderRequest("/env-vars", "GET", null, apiKey);
  if (res.status !== 200) throw new Error(`GET /env-vars failed: HTTP ${res.status}`);
  const items = Array.isArray(res.parsed) ? res.parsed : res.parsed.env_vars;
  const env = {};
  for (const i of items) {
    const inner = i.envVar ?? i;
    env[inner.key] = inner.value;
  }
  if (!env.FCM_SERVICE_ACCOUNT_JSON) {
    throw new Error("FCM_SERVICE_ACCOUNT_JSON is not set on Render (wake is disabled)");
  }
  return env.FCM_SERVICE_ACCOUNT_JSON;
}

/** Exchange the service account for an access token — this is the key under test. */
async function mintAccessToken(saJson) {
  const j = JSON.parse(saJson);
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({ iss: j.client_email, scope: SCOPE, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }),
  ).toString("base64url");
  const sig = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(j.private_key, "base64url");

  const res = await request("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${sig}`,
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (res.status !== 200 || !res.parsed?.access_token) {
    throw new Error(`KEY UNHEALTHY — OAuth token mint rejected (HTTP ${res.status}). The key cannot authenticate.`);
  }
  return { accessToken: res.parsed.access_token, identity: { project: j.project_id, keyId: j.private_key_id } };
}

/** FCM surfaces the actionable cause in details[].errorCode, not the HTTP status. */
function fcmErrorCode(parsed) {
  const details = parsed?.error?.details;
  if (!Array.isArray(details)) return null;
  const hit = details.find((d) => typeof d?.errorCode === "string");
  return hit ? hit.errorCode : null;
}

function parseArgs(argv) {
  const opts = { dryRun: false, keyFile: null, tokenFile: null, note: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--key-file") opts.keyFile = argv[++i];
    else if (a === "--token-file") opts.tokenFile = argv[++i];
    else if (a === "--note") opts.note = argv[++i] ?? "";
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function readToken(opts) {
  if (opts.tokenFile) {
    if (!existsSync(opts.tokenFile)) throw new Error(`token file not found: ${opts.tokenFile}`);
    const t = readFileSync(opts.tokenFile, "utf8").trim();
    if (!t) throw new Error(`token file is empty: ${opts.tokenFile}`);
    return t;
  }
  const env = process.env.FCM_PROBE_TOKEN;
  if (env && env.trim()) return env.trim();
  return null;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const apiKey = renderApiKey();

  // 1. Which credential are we testing? Default = the live one on Render, so the
  //    verdict describes the service that is actually running.
  const saJson = opts.keyFile
    ? readFileSync(opts.keyFile, "utf8").trim()
    : await liveFcmJson(apiKey);
  const source = opts.keyFile ? `candidate file ${opts.keyFile}` : "LIVE Render FCM_SERVICE_ACCOUNT_JSON";

  // 2. Does it authenticate?
  const { accessToken, identity } = await mintAccessToken(saJson);
  console.log(`credential : ${source}`);
  console.log(`project    : ${identity.project}`);
  console.log(`key id     : ${identity.keyId}`);
  console.log("auth       : OK (OAuth token minted)");

  // 3. Does FCM accept it at all? Empty message — we want the AUTH verdict only.
  const probe = await request(`https://fcm.googleapis.com/v1/projects/${identity.project}/messages:send`, {
    method: "POST",
    payload: { message: {} },
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
  });
  if (probe.status === 401 || probe.status === 403) {
    console.error(`FCM       : KEY UNHEALTHY — FCM rejected the credential (HTTP ${probe.status}).`);
    console.error("            The key cannot push; a device send would prove nothing.");
    process.exit(1);
  }
  console.log(`FCM scope  : OK (auth accepted, probe HTTP ${probe.status} on an empty message — expected)`);

  if (opts.dryRun) {
    console.log("");
    console.log("DRY RUN — key authenticates and FCM accepts it. No device was contacted.");
    console.log("Run without --dry-run and a device token for end-to-end proof.");
    return;
  }

  const token = readToken(opts);
  if (!token) {
    console.error("");
    console.error("no device token supplied — refusing to guess.");
    console.error("Get it from the device (it self-registers via POST /v5/device/fcm-token),");
    console.error("then pass it as FCM_PROBE_TOKEN=… or --token-file <path>.");
    process.exit(2);
  }

  // 4. The real send. Data-only, high priority, tagged so it is identifiable.
  const data = { kind: "ops_probe", note: opts.note || "fcm-wake-probe" };
  const send = await request(`https://fcm.googleapis.com/v1/projects/${identity.project}/messages:send`, {
    method: "POST",
    payload: { message: { token, data, android: { priority: "high" } } },
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
  });
  const code = fcmErrorCode(send.parsed);

  console.log("");
  console.log("=== VERDICT ===");
  if (send.status === 200 && send.parsed?.name) {
    console.log("ACCEPTED — key healthy, token valid. FCM accepted the send.");
    console.log(`message id: ${send.parsed.name}`);
    console.log("");
    console.log("Corroborate device-side: logcat shows \"FCM message received\", and");
    console.log("/health/{androidId}.lastPing in Firebase RTDB advances. Both moving");
    console.log("with this message id is end-to-end proof. Neither = look past the key.");
    return;
  }
  if (send.status === 401 || send.status === 403) {
    console.log(`KEY UNHEALTHY — FCM rejected the credential (HTTP ${send.status}).`);
    console.log("The device token verdict is meaningless; fix the key first.");
    process.exit(1);
  }
  if (code === "UNREGISTERED") {
    console.log("TOKEN STALE — the key is healthy, but this device token is dead.");
    console.log("UNREGISTERED means FCM accepted the credential and refused the target.");
    process.exit(3);
  }
  if (code === "INVALID_ARGUMENT") {
    console.log("TOKEN BAD — the key is healthy, but the token is malformed.");
    console.log(`FCM said: ${String(send.parsed?.error?.message ?? "").slice(0, 160)}`);
    process.exit(3);
  }
  if (send.status === 429) {
    console.log("QUOTA — key healthy, FCM is rate-limiting. Not a key fault.");
    process.exit(4);
  }
  console.log(`UNEXPECTED — HTTP ${send.status} ${code ?? ""}`);
  console.log(String(send.parsed?.error?.message ?? "").slice(0, 300));
  process.exit(5);
}

main().catch((err) => { console.error(err.message); process.exit(1); });