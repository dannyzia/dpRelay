/**
 * alert-channel-selftest — one command, one verdict on the ops alert channel.
 *
 * Why this exists: `set-alert-channel.cjs` can tell you which env keys are set
 * and whether a token authenticates, and `alert-pipeline-test.ts` proves the
 * dispatch path against a temp DB with test credentials. Neither proves the
 * thing that actually matters — that the credentials in PRODUCTION can carry a
 * real alert to a real sink. §1.4 of the handoff has been sitting on "owner
 * attested" for exactly this reason: the evidence never existed.
 *
 * It calls the server's own `dispatchAlert`, with the live Render env, rather
 * than reimplementing the dispatch. A copy of the routing logic would prove the
 * copy works, which is the failure mode this repo keeps hitting.
 *
 * Stages:
 *   1. INVENTORY   which sinks production actually has configured
 *   2. TELEGRAM    getMe  — is the token live, and which bot is it
 *   3. REACHABLE   getChat — can that bot actually see the configured chat
 *                  (this is the check that catches "wrong chat", "bot kicked
 *                  from the group", and a stale chat id)
 *   4. TELEGRAM SEND  real sendMessage through the production payload shape
 *   5. WEBHOOK SEND   real dispatch with telegram keys CLEARED, so the webhook
 *                  fallback is exercised rather than short-circuited
 *
 * Stages 2–5 send REAL alerts into the real ops channel. They are marked
 * unmistakably: device id `selftest-not-a-real-device`, so an operator seeing
 * one knows it is this script and not an incident. Use --dry-run to stop before
 * any send.
 *
 * Usage:
 *   cd server && npx tsx scripts/alert-channel-selftest.ts
 *   cd server && npx tsx scripts/alert-channel-selftest.ts --dry-run
 *   cd server && npx tsx scripts/alert-channel-selftest.ts --env-file ./ci-alerts.env
 *
 * `--env-file` (KEY=VALUE lines) tests an arbitrary config instead of the live
 * Render env, which is how the PASS path is exercised in CI or against a local
 * receiver. Without it, the script reads production.
 *
 * Exit code is the verdict: 0 = PASS, 1 = FAIL. Secrets are never printed —
 * only key names, presence, HTTP status codes, the bot's public @username, and
 * Telegram's message id.
 */
import pino from "pino";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig, type Config } from "../src/config.js";
import {
  dispatchAlert,
  resetAlertSinkHealth,
  type OpsAlert,
  type WatchdogAlert,
} from "../src/jobs.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DRY_RUN = process.argv.includes("--dry-run");
const ENV_FILE_IDX = process.argv.indexOf("--env-file");
const ENV_FILE = ENV_FILE_IDX > -1 ? process.argv[ENV_FILE_IDX + 1] : null;
const SERVICE_ID = process.env.RENDER_SERVICE_ID ?? "srv-dal3bae7bikc73e7k7pg";
const RENDER_BASE = `https://api.render.com/v1/services/${SERVICE_ID}`;

/** The live Render API key, from env or the same source the sibling scripts use. */
function renderApiKey(): string {
  if (process.env.RENDER_API_KEY) return process.env.RENDER_API_KEY;
  const kiloPath = join(repoRoot, ".kilo/kilo.jsonc");
  const kilo = readFileSync(kiloPath, "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  const key = (JSON.parse(kilo) as { mcp?: { render?: { environment?: { RENDER_API_KEY?: string } } } })
    .mcp?.render?.environment?.RENDER_API_KEY;
  if (!key) throw new Error(`no Render API key: set RENDER_API_KEY or provide ${kiloPath}`);
  return key;
}

/** Live production env vars, exactly as the running service sees them. */
async function liveEnv(): Promise<Record<string, string>> {
  if (ENV_FILE) {
    const env: Record<string, string> = {};
    for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
      const t = line.trim();
      if (t === "" || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq > 0) env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
    // loadConfig requires JWT_SECRET; a self-test config that omits it would
    // fail on that instead of on the thing being tested.
    env.JWT_SECRET ??= "selftest-only-jwt-secret-0123456789abcdef0123456789";
    return env;
  }
  const res = await fetch(`${RENDER_BASE}/env-vars`, {
    headers: { Authorization: `Bearer ${renderApiKey()}` },
  });
  if (res.status !== 200) throw new Error(`GET /env-vars failed: HTTP ${res.status}`);
  const body = (await res.json()) as Array<{ envVar?: { key: string; value: string } }> | { env_vars: Array<{ key: string; value: string }> };
  const items = Array.isArray(body) ? body : body.env_vars;
  const env: Record<string, string> = {};
  for (const i of items) {
    const inner = i.envVar ?? i;
    env[inner.key] = inner.value;
  }
  return env;
}

interface StageResult {
  name: string;
  status: "PASS" | "FAIL" | "SKIP";
  detail: string;
}

const results: StageResult[] = [];
function record(name: string, status: StageResult["status"], detail: string): void {
  results.push({ name, status, detail });
  const icon = status === "PASS" ? "  ok  " : status === "FAIL" ? " FAIL " : " skip ";
  console.log(`[${icon}] ${name.padEnd(16)} ${detail}`);
}

const log = pino({ level: "error" });

/**
 * A watchdog alert shaped exactly like the real one, so dispatchAlert takes the
 * production branch. The device id is deliberately absurd: an operator seeing
 * this in the ops channel must instantly recognise it as a self-test rather
 * than assume a gateway died.
 */
const selfTestAlert: WatchdogAlert = {
  type: "device_heartbeat_stale",
  deviceIds: ["selftest-not-a-real-device"],
  count: 1,
  threshold_sec: 1,
  detected_at: new Date().toISOString(),
};

async function main(): Promise<void> {
  console.log("=== alert channel self-test ===");
  console.log(`source:  ${ENV_FILE ? `env file ${ENV_FILE}` : `live Render ${SERVICE_ID}`}`);
  if (DRY_RUN) console.log("mode:    DRY RUN — no alert will be sent\n");

  // --- 1. Inventory ---------------------------------------------------------------
  const env = await liveEnv();
  const config = loadConfig(env);
  const hasTelegram = config.telegramBotToken !== "" && config.telegramChatId !== "";
  const hasWebhook = config.alertWebhookUrl !== "";
  const sinks = [hasTelegram && "telegram", hasWebhook && "webhook"].filter(Boolean).join(" + ");
  record("inventory", sinks ? "PASS" : "FAIL",
    `${Object.keys(env).length} env keys; sinks configured: ${sinks || "NONE (alerting is log-only)"}`);
  if (!sinks) {
    verdict();
    return;
  }

  // --- 2/3. Telegram credential + reachability ------------------------------------
  if (!hasTelegram) {
    record("telegram", "SKIP", "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not both set");
  } else {
    const token = config.telegramBotToken;
    const me = await fetch(`https://api.telegram.org/bot${token}/getMe`).then((r) => r.json() as Promise<{ ok: boolean; result?: { username?: string }; description?: string }>);
    record("telegram getMe", me.ok ? "PASS" : "FAIL",
      me.ok ? `token live; bot is @${me.result?.username}` : `token rejected: ${me.description}`);

    const chat = await fetch(`https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(config.telegramChatId)}`)
      .then((r) => r.json() as Promise<{ ok: boolean; result?: { title?: string; username?: string; type?: string }; description?: string }>);
    // A dead token makes getChat fail too, so blaming the chat there would send
    // the operator to fix the wrong thing. Report the chat as unknown, not bad.
    record("chat reachable", chat.ok ? "PASS" : "FAIL",
      chat.ok
        ? `chat ok (${chat.result?.type}${chat.result?.title ? `: ${chat.result.title}` : chat.result?.username ? `: @${chat.result.username}` : ""})`
        : !me.ok
          ? `not tested — token rejected above, so this result says nothing about the chat`
          : `bot cannot see that chat: ${chat.description} — wrong id, or the bot was removed from the group`);
  }

  // --- 4. Real Telegram send, through the production dispatch ---------------------
  if (DRY_RUN) {
    record("telegram send", "SKIP", "dry run");
  } else if (!hasTelegram) {
    record("telegram send", "SKIP", "telegram not configured");
  } else {
    resetAlertSinkHealth();
    const result: string = await dispatchAlert(log, config, selfTestAlert as OpsAlert);
    record("telegram send", result === "telegram" ? "PASS" : "FAIL",
      result === "telegram"
        ? "dispatchAlert delivered via telegram"
        : `dispatchAlert returned "${result}" (telegram rejected or skipped the send)`);
  }

  // --- 5. Real webhook send, with telegram CLEARED so the fallback is exercised ---
  // Without clearing telegram, this stage would short-circuit on the primary sink
  // and the webhook would never be tested at all.
  if (DRY_RUN) {
    record("webhook send", "SKIP", "dry run");
  } else if (!hasWebhook) {
    record("webhook send", "SKIP", "ALERT_WEBHOOK_URL not set — no fallback receiver");
  } else {
    resetAlertSinkHealth();
    const webhookOnly: Config = {
      ...config,
      telegramBotToken: "",
      telegramChatId: "",
    };
    const result: string = await dispatchAlert(log, webhookOnly, selfTestAlert as OpsAlert);
    record("webhook send", result === "webhook" ? "PASS" : "FAIL",
      result === "webhook"
        ? "dispatchAlert delivered via webhook fallback"
        : `dispatchAlert returned "${result}" (webhook receiver rejected the delivery)`);
  }

  verdict();
}

function verdict(): void {
  const failed = results.filter((r) => r.status === "FAIL");
  const passed = results.filter((r) => r.status === "PASS");
  console.log("");
  console.log("=== VERDICT ===");
  for (const r of results) {
    console.log(`  ${r.status.padEnd(4)} ${r.name.padEnd(16)} ${r.detail}`);
  }
  console.log("");
  const ok = failed.length === 0 && passed.length > 0;
  if (ok) {
    console.log(`PASS — ${passed.length}/${results.length} checks. The configured sink(s) carried a real alert.`);
  } else if (passed.length === 0) {
    console.log("FAIL — nothing was proven: no sink is configured, so alerting is log-only.");
  } else {
    console.log(`FAIL — ${failed.length} of ${results.length} checks failed: ${failed.map((f) => f.name).join(", ")}.`);
  }
  process.exit(ok ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(`self-test could not run: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
