/**
 * Sets the four fail-closed production gates on the dprelay-api Render service:
 *   BULK_ENABLED=true, BKASH_PERSONAL_NUMBER, OPERATOR_SECRET (generated),
 *   FCM_SERVICE_ACCOUNT_JSON (from the local service-account file), plus
 *   DEVICE_ENROLLMENT_SECRET (generated) if absent — preserving every existing var.
 * Values are never printed; only key names and status codes.
 */
const { readFileSync } = require("node:fs");
const { randomBytes } = require("node:crypto");
const https = require("node:https");

const repoRoot = "/home/zia/Documents/My Projects/Authenticator";

// --- Render API key from kilo.jsonc (full-line // comments stripped only) ---
const kiloRaw = readFileSync(`${repoRoot}/.kilo/kilo.jsonc`, "utf8");
const kiloClean = kiloRaw
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");
const kilo = JSON.parse(kiloClean);
const apiKey = kilo.mcp.render.environment.RENDER_API_KEY;
const serviceId = "srv-dal3bae7bikc73e7k7pg";
const base = `https://api.render.com/v1/services/${serviceId}/env-vars`;

function request(method, payload) {
  return new Promise((resolve, reject) => {
    const data = payload ? JSON.stringify(payload) : null;
    const req = https.request(
      base,
      {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
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

(async () => {
  const get = await request("GET");
  if (get.status !== 200) {
    console.error(`GET failed: ${get.status}`);
    process.exit(1);
  }
  const items = Array.isArray(get.parsed) ? get.parsed : get.parsed.env_vars;
  const env = {};
  for (const item of items) {
    const inner = item.envVar ?? item; // GET wraps each var in an `envVar` object
    env[inner.key] = inner.value;
  }
  console.log(`current keys (${Object.keys(env).length}):`, Object.keys(env).sort().join(", "));

  env.BULK_ENABLED = "true";
  env.BKASH_PERSONAL_NUMBER = "01613249520";
  if (!env.OPERATOR_SECRET || env.OPERATOR_SECRET.length < 32) {
    env.OPERATOR_SECRET = randomBytes(32).toString("base64");
    console.log("OPERATOR_SECRET: generated (was missing/short)");
  }
  if (!env.APP_PROVISIONING_SECRET || env.APP_PROVISIONING_SECRET.length < 32) {
    env.APP_PROVISIONING_SECRET = randomBytes(32).toString("base64url");
    console.log("APP_PROVISIONING_SECRET: generated (was missing/short)");
  }
  if (!env.DEVICE_ENROLLMENT_SECRET || env.DEVICE_ENROLLMENT_SECRET.length < 32) {
    env.DEVICE_ENROLLMENT_SECRET = randomBytes(32).toString("base64url");
    console.log("DEVICE_ENROLLMENT_SECRET: generated (was missing/short)");
  }
  const sa = JSON.parse(readFileSync(`${repoRoot}/functions/authenticator-15fb7-36cfda9edf3b.json`, "utf8"));
  env.FCM_SERVICE_ACCOUNT_JSON = JSON.stringify(sa);
  console.log("FCM_SERVICE_ACCOUNT_JSON: loaded from file,", env.FCM_SERVICE_ACCOUNT_JSON.length, "bytes");

  const put = await request("PUT", Object.entries(env).map(([key, value]) => ({ key, value })));
  console.log(`PUT status: ${put.status}`);
  console.log(put.status === 200 ? "OK — all four gates set, redeploy triggered" : `FAILED: ${JSON.stringify(put.parsed).slice(0, 300)}`);
})();
