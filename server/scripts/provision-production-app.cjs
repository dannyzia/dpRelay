/**
 * Provisions a production app on dP Relay via POST /v5/apps/register:
 *   appId = argv[2] || "dprelay-prod", operator-generated appSecret, no
 *   webhook (none exists yet).
 *
 * The OPERATOR_SECRET is fetched from the Render service env at runtime and the
 * credentials (containing the one-time appSecret) are written to the login
 * keyring. They used to be written to staging/ at 0600, which kept other
 * *users* out but did nothing about backups, sync agents, or a stolen laptop.
 * Nothing secret is printed or committed.
 *
 * Why the appId is an argument: appIds are immutable once registered
 * (UNIQUE(app_id), no delete route, no app-secret rotation route), so retiring
 * an exposed appSecret means registering a NEW appId and revoking the old app.
 * This script created `dprelay-prod`; `dprelay-prod-2`/`-3` are the same
 * operator action with the suffix bumped.
 *
 * The stored record must include `appSecret`: the provisioning route returns
 * `{ ok, appId, name, webhookUrl, webhookSecret }` — the caller-supplied
 * appSecret is NOT echoed back. An earlier version wrote the response verbatim,
 * which would have silently discarded the one credential that cannot be
 * recovered. buildCredentialsRecord() now pins the stored shape.
 *
 * Usage:
 *   node server/scripts/provision-production-app.cjs              # dprelay-prod
 *   node server/scripts/provision-production-app.cjs dprelay-prod-3
 */
const { randomBytes } = require("node:crypto");
const path = require("node:path");
const https = require("node:https");
const { resolveRenderApiKey } = require("./render-key.cjs");
const { writeSecret } = require("./secret-store.cjs");

/** Keyring account holding the production app's one-time credentials. */
const CREDENTIALS_ACCOUNT = "production-app-credentials";

/** Public appId shape — the same pattern the register routes enforce. */
const APP_ID_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;

const repoRoot = path.resolve(__dirname, "..", "..");
const serviceId = "srv-dal3bae7bikc73e7k7pg";

/**
 * Resolves the appId to register from CLI arguments.
 *
 * Defaulted so the original invocation keeps working byte-for-byte; anything
 * that is not a legal appId is refused before a request is made, because the
 * server's 400 would arrive only after a pointless production call.
 *
 * @param {string[]} argv arguments after the script path
 * @returns {string} the appId to register
 * @throws {Error} when the supplied appId is outside the allowed shape
 */
function chooseAppId(argv) {
  const raw = argv[0];
  if (raw === undefined || raw === "") return "dprelay-prod";
  if (!APP_ID_PATTERN.test(raw)) {
    throw new Error(`invalid appId "${raw}": must be 3-64 chars of [A-Za-z0-9_-]`);
  }
  return raw;
}

/**
 * Builds the keyring record for a registration.
 *
 * @param {{ appId?: string, name?: string, webhookUrl?: string|null, webhookSecret?: string }} response register response
 * @param {string} appSecret the caller-supplied secret (never returned by the server)
 * @param {string} registeredAt UTC date, YYYY-MM-DD
 * @returns {Record<string, unknown>} the record to store
 */
function buildCredentialsRecord(response, appSecret, registeredAt) {
  return {
    appId: response.appId,
    appSecret,
    name: response.name,
    webhookUrl: response.webhookUrl ?? null,
    webhookSecret: response.webhookSecret,
    registeredAt,
    note: "appSecret is caller-supplied (operator-generated); webhookSecret is server-minted, shown once",
  };
}

function httpsGetJson(url, headers) {
  return new Promise((resolve, reject) => {
    https
      .request(url, { headers }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, parsed: body ? JSON.parse(body) : null }); }
          catch (e) { reject(e); }
        });
      })
      .on("error", reject)
      .end();
  });
}

function httpsPostJson(url, headers, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = https.request(
      url,
      { method: "POST", headers: { ...headers, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, parsed: body ? JSON.parse(body) : null }); }
          catch (e) { reject(e); }
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const appId = chooseAppId(process.argv.slice(2));
  // Resolved inside main so importing this module for tests never needs a
  // Render credential or a reachable keyring.
  const apiKey = resolveRenderApiKey({ repoRoot });

  // 1. Fetch the provisioning secret from the Render service env (values come back; never printed).
  const envRes = await httpsGetJson(
    `https://api.render.com/v1/services/${serviceId}/env-vars`,
    { Authorization: `Bearer ${apiKey}` },
  );
  if (envRes.status !== 200) {
    throw new Error(`env GET failed: ${envRes.status}`);
  }
  const items = Array.isArray(envRes.parsed) ? envRes.parsed : envRes.parsed.env_vars;
  const env = {};
  for (const item of items) {
    const inner = item.envVar ?? item;
    env[inner.key] = inner.value;
  }
  const provisioningSecret = env.APP_PROVISIONING_SECRET ?? env.OPERATOR_SECRET;
  if (!provisioningSecret) {
    throw new Error("Neither APP_PROVISIONING_SECRET nor OPERATOR_SECRET set on Render — provisioning stays disabled");
  }

  // 2. Register the app (or a new appId, when retiring an exposed secret).
  const appSecret = randomBytes(32).toString("base64url"); // ~43 chars, >= policy floor
  const reg = await httpsPostJson(
    "https://dprelay-api-hug8.onrender.com/v5/apps/register",
    { Authorization: `Bearer ${provisioningSecret}` },
    { appId, appSecret, name: "dP Relay Production" },
  );
  if (reg.status !== 201) {
    throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.parsed).slice(0, 300)}`);
  }

  // 3. Persist the credentials to the login keyring, appSecret included. This
  //    API shows the webhookSecret exactly once and never returns the
  //    appSecret at all, so a failed write here means the app must be
  //    re-provisioned under a new appId rather than the secret recovered.
  const record = buildCredentialsRecord(reg.parsed ?? {}, appSecret, new Date().toISOString().slice(0, 10));
  writeSecret(CREDENTIALS_ACCOUNT, JSON.stringify(record, null, 2));
  console.log(`registered: appId=${record.appId}`);
  console.log(
    `credentials (appSecret included) stored in the login keyring as "${CREDENTIALS_ACCOUNT}"`,
  );
}

// Only run as a CLI: the test suite imports this module and must never be able
// to trigger a live registration (or a keyring read) by doing so.
if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { APP_ID_PATTERN, chooseAppId, buildCredentialsRecord };
