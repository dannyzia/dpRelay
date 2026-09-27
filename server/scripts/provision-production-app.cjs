/**
 * Provisions the first production app on dP Relay via POST /v5/apps/register:
 *   appId = "dprelay-prod", server-generated appSecret, no webhook (none exists yet).
 * The OPERATOR_SECRET is fetched from the Render service env at runtime and the
 * full registration response (containing the one-time appSecret) is written to
 * staging/ with 0600 perms — nothing secret is printed or committed.
 */
const { readFileSync, writeFileSync, chmodSync } = require("node:fs");
const { randomBytes } = require("node:crypto");
const https = require("node:https");

const repoRoot = "/home/zia/Documents/My Projects/Authenticator";
const kiloRaw = readFileSync(`${repoRoot}/.kilo/kilo.jsonc`, "utf8");
const kiloClean = kiloRaw.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
const apiKey = JSON.parse(kiloClean).mcp.render.environment.RENDER_API_KEY;
const serviceId = "srv-dal3bae7bikc73e7k7pg";

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

(async () => {
  // 1. Fetch OPERATOR_SECRET from the Render service env (values come back; never printed).
  const envRes = await httpsGetJson(
    `https://api.render.com/v1/services/${serviceId}/env-vars`,
    { Authorization: `Bearer ${apiKey}` },
  );
  if (envRes.status !== 200) {
    console.error(`env GET failed: ${envRes.status}`);
    process.exit(1);
  }
  const items = Array.isArray(envRes.parsed) ? envRes.parsed : envRes.parsed.env_vars;
  const env = {};
  for (const item of items) {
    const inner = item.envVar ?? item;
    env[inner.key] = inner.value;
  }
  const operatorSecret = env.APP_PROVISIONING_SECRET ?? env.OPERATOR_SECRET;
  if (!operatorSecret) {
    console.error("Neither APP_PROVISIONING_SECRET nor OPERATOR_SECRET set on Render — provisioning stays disabled");
    process.exit(1);
  }

  // 2. Provision the production app.
  const appSecret = randomBytes(32).toString("base64url"); // ~43 chars, >= policy floor
  const reg = await httpsPostJson(
    "https://dprelay-api-hug8.onrender.com/v5/apps/register",
    { Authorization: `Bearer ${operatorSecret}` },
    { appId: "dprelay-prod", appSecret, name: "dP Relay Production" },
  );
  if (reg.status !== 201) {
    console.error(`register failed: ${reg.status} ${JSON.stringify(reg.parsed).slice(0, 300)}`);
    process.exit(1);
  }

  // 3. Persist the one-time credentials to gitignored staging (0600).
  const out = `${repoRoot}/staging/production-app-credentials.json`;
  writeFileSync(out, JSON.stringify(reg.parsed, null, 2));
  chmodSync(out, 0o600);
  console.log(`registered: appId=${reg.parsed.appId ?? "dprelay-prod"}`);
  console.log(`credentials (appSecret shown once) saved to: ${out}`);
})();
