/**
 * ISSUE-57: the daily synthetic alert canary.
 *
 * The failure this exists to catch is silence: a Telegram token revoked, a bot
 * removed from the group, or a chat id rotated all fail without anyone noticing,
 * because the only thing that would have told them is the channel that just
 * stopped working. The canary sends a real message once a day and treats
 * Telegram's `message_id` as the receipt; no receipt means the channel is broken.
 *
 * The load-bearing test here is the escalation route. The canary's failure must
 * NOT be dispatched back through Telegram, or a dead token swallows its own
 * page and the channel reports itself healthy precisely because it is dead. It
 * escalates through ALERT_WEBHOOK_URL only, and `/health/alerts` carries the
 * state for an external monitor.
 *
 * `ok:true` with no `message_id` is pinned explicitly: Telegram can answer 200
 * with a body that is not a Bot API response (proxy, captive portal), and
 * trusting the status code instead of the receipt is exactly the bug.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { buildApp } from "../src/app.js";

/**
 * node-cron is captured at the module level so the scheduling tests can assert
 * which expressions were registered and drive the registered handler directly.
 * Mocked rather than real: a real daily cron would either leak a live timer into
 * the suite or need a clock fake, and what is under test is the wiring.
 */
const cronJobs = vi.hoisted(() => ({
  registered: [] as Array<{ expression: string; handler: () => void }>,
}));
vi.mock("node-cron", () => {
  const api = {
    schedule: (expression: string, handler: () => void) => {
      cronJobs.registered.push({ expression, handler });
      return { stop: (): void => {} };
    },
  };
  return { default: api, ...api };
});
import {
  resetAlertCanaryState,
  resetAlertSinkHealth,
  type AlertCanaryStatus,
} from "../src/jobs.js";
import type { AlertSinkStatus } from "../src/jobs.js";
import type { FastifyInstance } from "fastify";
import { testTmpDir } from "./helpers/tmp-dirs.js";

const TEST_JWT_SECRET = "test-only-secret-0123456789abcdef0123456789abcdef";
const TG_TOKEN = "12345:TEST-TOKEN-abcdefghijklmnop";
const TG_CHAT = "-100200300";

const tempDirs: string[] = [];

beforeEach(() => {
  resetAlertCanaryState();
  resetAlertSinkHealth();
  cronJobs.registered.length = 0;
});

/**
 * Waits for registerJobs' lazy `import("node-cron")` to finish registering.
 * Bounded so a broken scheduling path fails the test instead of hanging it.
 */
async function waitForCronRegistration(min: number): Promise<void> {
  for (let i = 0; i < 200 && cronJobs.registered.length < min; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetAlertCanaryState();
  resetAlertSinkHealth();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeApp(env: Record<string, string> = {}): FastifyInstance {
  const dir = testTmpDir("dprelay-canary-");
  tempDirs.push(dir);
  return buildApp({
    dbPath: join(dir, "test.db"),
    startCron: false,
    runBootSweep: false,
    enableWakeGuard: false,
    env: { JWT_SECRET: TEST_JWT_SECRET, ...env },
  });
}

/** Base env with the canary on and a Telegram sink configured. */
const canaryEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  TELEGRAM_BOT_TOKEN: TG_TOKEN,
  TELEGRAM_CHAT_ID: TG_CHAT,
  ALERT_CANARY_ENABLED: "true",
  ...extra,
});

/** Records every outbound request and answers with `response`. */
function stubFetch(handler: (url: string) => Response): { urls: string[]; bodies: string[] } {
  const urls: string[] = [];
  const bodies: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      bodies.push(typeof init?.body === "string" ? init.body : "");
      return handler(String(url));
    }),
  );
  return { urls, bodies };
}

const okBody = (messageId: number) =>
  new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("alert canary receipt", () => {
  it("records Telegram's message_id as the receipt and logs delivered", async () => {
    const { urls, bodies } = stubFetch(() => okBody(4242));
    const app = makeApp(canaryEnv());
    await app.ready();

    const infos: Array<{ msg?: string; messageId?: number }> = [];
    app.log.info = ((obj: unknown, msg?: string) => {
      infos.push({ msg, ...(obj as { messageId?: number }) });
      return app.log;
    }) as typeof app.log.info;

    const result = await app.runAlertCanary();

    expect(result).toEqual({ delivered: true, messageId: 4242, detail: null });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/sendMessage");
    // The message is unmistakably synthetic, so an operator who sees one in the
    // channel does not go looking for an incident.
    expect(bodies[0]).toContain("dprelay alert canary");
    expect(bodies[0]).toContain("Synthetic message");
    expect(infos.filter((i) => i.msg === "alert_canary_delivered")).toHaveLength(1);

    const status = await app.inject({ method: "GET", url: "/health/alerts" });
    const body = status.json() as AlertSinkStatus & { canary: AlertCanaryStatus };
    expect(body.canary.lastMessageId).toBe(4242);
    expect(body.canary.lastReceiptAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.canary.consecutiveFailures).toBe(0);
    expect(body.canary.overdue).toBe(false);
    await app.close();
  });

  it("treats HTTP 200 with ok:true but NO message_id as no receipt", async () => {
    // The specific silent success this guards: trusting the status code instead
    // of the receipt. A proxy or captive portal can answer 200 with a body that
    // is not a Bot API response at all.
    stubFetch(
      () =>
        new Response(JSON.stringify({ ok: true, result: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const app = makeApp(canaryEnv());
    await app.ready();

    const result = await app.runAlertCanary();

    expect(result.delivered).toBe(false);
    expect(result.messageId).toBeNull();
    expect(result.detail).toBe("no message_id in response");
    const status = await app.inject({ method: "GET", url: "/health/alerts" });
    const body = status.json() as { canary: AlertCanaryStatus };
    expect(body.canary.lastReceiptAt).toBeNull();
    expect(body.canary.consecutiveFailures).toBe(1);
    expect(body.canary.overdue).toBe(true);
    await app.close();
  });

  it("treats ok:false with HTTP 200 as no receipt", async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ ok: false, description: "chat not found" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const app = makeApp(canaryEnv());
    await app.ready();

    const result = await app.runAlertCanary();
    expect(result.delivered).toBe(false);
    expect(result.detail).toBe("response ok:false");
    await app.close();
  });

  it("treats a non-2xx response as no receipt, without storing the response body", async () => {
    stubFetch(() => new Response("Unauthorized", { status: 401 }));
    const app = makeApp(canaryEnv());
    await app.ready();

    const result = await app.runAlertCanary();
    expect(result.delivered).toBe(false);
    expect(result.detail).toBe("HTTP 401");
    await app.close();
  });

  it("treats an HTTP 500 as no receipt", async () => {
    stubFetch(() => new Response("<html>502 Bad Gateway</html>", { status: 500 }));
    const app = makeApp(canaryEnv());
    await app.ready();

    const result = await app.runAlertCanary();

    expect(result).toEqual({ delivered: false, messageId: null, detail: "HTTP 500" });
    // The failure text from the gateway must not become the recorded detail —
    // it is attacker- or proxy-controlled and would end up on the health endpoint.
    expect(result.detail).not.toContain("Bad Gateway");
    const status = await app.inject({ method: "GET", url: "/health/alerts" });
    const body = status.json() as { canary: AlertCanaryStatus };
    expect(body.canary.lastReceiptAt).toBeNull();
    expect(body.canary.consecutiveFailures).toBe(1);
    await app.close();
  });

  it("reports a transport failure by error class only, never the token-bearing URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed: https://api.telegram.org/bot12345:TEST-TOKEN-abcdefghijklmnop/sendMessage");
      }),
    );
    const app = makeApp(canaryEnv());
    await app.ready();

    const logged: unknown[] = [];
    app.log.error = ((obj: unknown) => {
      logged.push(obj);
      return app.log;
    }) as typeof app.log.error;

    const result = await app.runAlertCanary();

    expect(result.delivered).toBe(false);
    expect(result.detail).toBe("TypeError");
    // The raw fetch error embeds the bot token in the URL, so it must not be
    // stored or surfaced anywhere.
    expect(JSON.stringify(logged)).not.toContain("TEST-TOKEN");
    const status = await app.inject({ method: "GET", url: "/health/alerts" });
    expect(status.body).not.toContain("TEST-TOKEN");
    await app.close();
  });
});

describe("alert canary escalation", () => {
  it("escalates through the webhook and NEVER back through telegram", async () => {
    // Telegram fails; the webhook is the only working channel.
    const { urls, bodies } = stubFetch((url) =>
      url.includes("api.telegram.org")
        ? new Response("nope", { status: 401 })
        : new Response("ok", { status: 200 }),
    );
    const app = makeApp(
      canaryEnv({
        ALERT_WEBHOOK_URL: "https://receiver.example.com/hooks/alert",
        ALERT_WEBHOOK_SECRET: "whsec-test-value-0123456789",
        ALERT_SINK_FAILURE_THRESHOLD: "1",
      }),
    );
    await app.ready();

    const result = await app.runAlertCanary();

    expect(result.delivered).toBe(false);
    const telegramCalls = urls.filter((u) => u.includes("api.telegram.org"));
    const webhookCalls = urls.filter((u) => u.includes("receiver.example.com"));
    // Exactly one Telegram attempt (the canary's own send) and one webhook
    // escalation. If the failure were routed through Telegram there would be two.
    expect(telegramCalls).toHaveLength(1);
    expect(webhookCalls).toHaveLength(1);
    const alert = JSON.parse(bodies[urls.indexOf("https://receiver.example.com/hooks/alert")]) as {
      type: string;
      consecutiveFailures: number;
      lastReceiptAt: string | null;
      lastError: string;
    };
    expect(alert.type).toBe("alert_canary_failed");
    expect(alert.consecutiveFailures).toBe(1);
    expect(alert.lastReceiptAt).toBeNull();
    expect(alert.lastError).toBe("HTTP 401");
    await app.close();
  });

  it("does not escalate on a single blip below the threshold", async () => {
    const { urls } = stubFetch((url) =>
      url.includes("api.telegram.org")
        ? new Response("nope", { status: 500 })
        : new Response("ok", { status: 200 }),
    );
    const app = makeApp(
      canaryEnv({
        ALERT_WEBHOOK_URL: "https://receiver.example.com/hooks/alert",
        ALERT_SINK_FAILURE_THRESHOLD: "3",
      }),
    );
    await app.ready();

    await app.runAlertCanary();
    await app.runAlertCanary();

    // Two failures, threshold three: the canary has failed but must stay quiet,
    // because a canary that pages on one blip gets muted.
    expect(urls.filter((u) => u.includes("receiver.example.com"))).toHaveLength(0);
    const status = await app.inject({ method: "GET", url: "/health/alerts" });
    const body = status.json() as { canary: AlertCanaryStatus };
    expect(body.canary.consecutiveFailures).toBe(2);

    await app.runAlertCanary();
    expect(urls.filter((u) => u.includes("receiver.example.com"))).toHaveLength(1);
    await app.close();
  });

  it("clears the failure count as soon as a receipt lands again", async () => {
    let failing = true;
    stubFetch((url) => {
      if (url.includes("api.telegram.org")) {
        return failing ? new Response("nope", { status: 500 }) : okBody(99);
      }
      return new Response("ok", { status: 200 });
    });
    const app = makeApp(
      canaryEnv({
        ALERT_WEBHOOK_URL: "https://receiver.example.com/hooks/alert",
        ALERT_SINK_FAILURE_THRESHOLD: "2",
      }),
    );
    await app.ready();

    await app.runAlertCanary();
    await app.runAlertCanary();
    expect((await app.inject({ method: "GET", url: "/health/alerts" })).statusCode).toBe(503);

    failing = false;
    const recovered = await app.runAlertCanary();
    expect(recovered).toEqual({ delivered: true, messageId: 99, detail: null });

    const res = await app.inject({ method: "GET", url: "/health/alerts" });
    const body = res.json() as AlertSinkStatus & { canary: AlertCanaryStatus };
    expect(body.canary.consecutiveFailures).toBe(0);
    expect(body.canary.overdue).toBe(false);
    // A receipt is proof the Telegram sink works, so the sink's own degraded
    // flag must clear too rather than contradicting the canary.
    expect(body.sinks.find((s) => s.sink === "telegram")?.degradedSince).toBeNull();
    await app.close();
  });
});

describe("alert canary scheduling", () => {
  const CANARY_CRON = "0 9 * * *";

  it("registers ALERT_CANARY_CRON when enabled, and the registered job really sends", async () => {
    // Acceptance criterion 1 is about a daily *schedule*, not just a callable
    // tick: an unscheduled canary looks perfect in every other test and sends
    // nothing, ever.
    const { urls, bodies } = stubFetch(() => okBody(5150));
    // cron enabled: the other four jobs land here too, and their mocked timers
    // are never invoked.
    const dir = testTmpDir("dprelay-canary-");
    tempDirs.push(dir);
    const app = buildApp({
      dbPath: join(dir, "test.db"),
      startCron: true,
      runBootSweep: false,
      enableWakeGuard: false,
      env: { JWT_SECRET: TEST_JWT_SECRET, ...canaryEnv({ ALERT_CANARY_CRON: CANARY_CRON }) },
    });
    await app.ready();
    await waitForCronRegistration(5);

    const scheduled = cronJobs.registered.map((job) => job.expression);
    expect(scheduled).toContain(CANARY_CRON);
    // Scheduling must not send: the canary posts into the real ops channel, so
    // a boot-time send would be an unrequested message on every deploy.
    expect(urls).toHaveLength(0);

    const canaryJob = cronJobs.registered.find((job) => job.expression === CANARY_CRON);
    expect(canaryJob).toBeDefined();
    canaryJob?.handler();

    // The scheduled handler is fire-and-forget. Wait on the persisted receipt
    // rather than on the fetch having been called: the send is not "done" until
    // the evidence is stored, and asserting on the in-flight call is a race.
    await vi.waitFor(async () => {
      const res = await app.inject({ method: "GET", url: "/health/alerts" });
      expect((res.json() as { canary: AlertCanaryStatus }).canary.lastMessageId).toBe(5150);
    });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/sendMessage");
    expect(bodies[0]).toContain("dprelay alert canary");

    const status = await app.inject({ method: "GET", url: "/health/alerts" });
    const body = status.json() as { canary: AlertCanaryStatus };
    expect(body.canary.overdue).toBe(false);
    expect(body.canary.consecutiveFailures).toBe(0);
    await app.close();
  });

  it("registers no canary job at all when disabled", async () => {
    // The whole point of defaulting off: an operator who never opted in must not
    // receive daily messages because someone flipped a condition somewhere.
    stubFetch(() => okBody(1));
    const dir = testTmpDir("dprelay-canary-");
    tempDirs.push(dir);
    const app = buildApp({
      dbPath: join(dir, "test.db"),
      startCron: true,
      runBootSweep: false,
      enableWakeGuard: false,
      env: { JWT_SECRET: TEST_JWT_SECRET, TELEGRAM_BOT_TOKEN: TG_TOKEN, TELEGRAM_CHAT_ID: TG_CHAT },
    });
    await app.ready();
    await waitForCronRegistration(4);

    expect(cronJobs.registered.map((job) => job.expression)).not.toContain(CANARY_CRON);
    // The other jobs still register, so this is "canary skipped", not "cron off".
    expect(cronJobs.registered.length).toBeGreaterThan(0);
    await app.close();
  });
});

describe("alert canary configuration", () => {
  it("is inert when disabled, sending nothing at all", async () => {
    const { urls } = stubFetch(() => okBody(1));
    const app = makeApp({ TELEGRAM_BOT_TOKEN: TG_TOKEN, TELEGRAM_CHAT_ID: TG_CHAT });
    await app.ready();

    const result = await app.runAlertCanary();

    expect(result).toEqual({ delivered: false, messageId: null, detail: "canary disabled" });
    expect(urls).toHaveLength(0);
    await app.close();
  });

  it("skips without escalating when no telegram sink is configured", async () => {
    const { urls } = stubFetch(() => new Response("ok", { status: 200 }));
    const app = makeApp({ ALERT_CANARY_ENABLED: "true" });
    await app.ready();

    const result = await app.runAlertCanary();

    expect(result.detail).toBe("telegram not configured");
    expect(urls).toHaveLength(0);
    // A disabled canary is not a degraded one: reporting red here would be noise
    // about a channel the operator deliberately did not configure.
    const status = await app.inject({ method: "GET", url: "/health/alerts" });
    const body = status.json() as { canary: AlertCanaryStatus };
    expect(body.canary.enabled).toBe(true);
    expect(body.canary.lastAttemptAt).toBeNull();
    await app.close();
  });

  it("survives a restart: a fresh app reads the last receipt from job_state", async () => {
    stubFetch(() => okBody(777));
    const first = makeApp(canaryEnv());
    await first.ready();
    await first.runAlertCanary();
    const dbPath = first.db.name;
    await first.close();

    // Same database, new process: the evidence must outlive the deploy, or the
    // canary cannot answer "has this channel worked recently?".
    resetAlertCanaryState();
    const second = buildApp({
      dbPath,
      startCron: false,
      runBootSweep: false,
      enableWakeGuard: false,
      env: { JWT_SECRET: TEST_JWT_SECRET, ...canaryEnv() },
    });
    await second.ready();
    const status = await second.inject({ method: "GET", url: "/health/alerts" });
    const body = status.json() as { canary: AlertCanaryStatus };

    expect(body.canary.lastMessageId).toBe(777);
    expect(body.canary.lastReceiptAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await second.close();
  });
});