import Fastify, { type FastifyInstance } from "fastify";
import { createRequire } from "node:module";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { loadConfig } from "./config.js";
import { openDb, type Db } from "./db.js";
import authService from "./services/auth.js";
import middleware from "./middleware.js";
import authRoutes from "./routes/auth.js";
import appRoutes from "./routes/apps.js";
import deviceRoutes from "./routes/device.js";
import otpRoutes from "./routes/otp.js";
import billingRoutes from "./routes/billing.js";
import bulkRoutes from "./routes/bulk.js";
import contactGroupRoutes from "./routes/contact-groups.js";
import messageTemplateRoutes from "./routes/message-templates.js";
import adminAppRoutes from "./routes/admin-apps.js";
import { registerJobs } from "./jobs.js";
import { registerWakeGuard } from "./wake-guard.js";

/** ESM-compatible require — reads package.json for the /health version field. */
const require = createRequire(import.meta.url);

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    config: import("./config.js").Config;
  }
}

export interface AppOptions {
  dbPath?: string;
  /** Set false in tests to keep cron timers out of the test process. */
  startCron?: boolean;
  /** Set false in tests to avoid boot-time sweep side effects. */
  runBootSweep?: boolean;
  /** Set false in tests to keep the wake-guard hook passive. */
  enableWakeGuard?: boolean;
  /** Test hook: override env-derived config (e.g. JWT_SECRET for auth tests). */
  env?: NodeJS.ProcessEnv;
  /** Test hook: shrink the wake-guard idle threshold. */
  wakeIdleThresholdSec?: number;
}

/**
 * Builds the Fastify application (routes registered, DB open + migrated).
 * Separated from index.ts so tests can inject a temporary database path.
 */
export function buildApp(opts: AppOptions = {}): FastifyInstance {
  const {
    startCron = true,
    runBootSweep = true,
    enableWakeGuard = true,
  } = opts;
  const config = loadConfig({ ...process.env, ...opts.env });
  const dbPath = opts.dbPath ?? config.dbPath;
  const db: Db = openDb(dbPath);

  const app = Fastify({ logger: { level: config.logLevel } });
  // Expose for route handlers and tests without module-level singletons
  app.decorate("db", db);
  app.decorate("config", config);

  // OpenAPI (M3 tail, ISSUE-23) registers an fp-wrapped onRoute hook. It
  // captures routes from every ROUTE PLUGIN queued after it; /health and
  // /healthz are added synchronously on the root instance before plugins
  // load, so they stay out of the spec (ops probes, not API surface). Spec:
  // Swagger UI at /docs, raw JSON at /docs/json; the generated spec is
  // committed to docs/Plan/27-OPENAPI-SPEC.json and a unit test fails when
  // routes drift from the committed file so the docs cannot rot silently.
  app.register(swagger, {
    openapi: {
      info: {
        title: "dP Relay v5 API",
        description:
          "dP Relay v5 (Modification 6 — Firebase exit): device plane, OTP plane, " +
          "billing/credits, bulk campaigns, contact groups, templates, and the " +
          "operator admin plane. Webhook deliveries are signed with " +
          "X-DP-Signature (hex HMAC-SHA256 of the raw body).",
        version: require("../package.json").version as string,
      },
      tags: [
        { name: "health", description: "Liveness and deployment verification" },
        { name: "auth", description: "User JWT register/login/refresh" },
        { name: "device", description: "Gateway phone plane (enroll, heartbeat, outstanding, results)" },
        { name: "otp", description: "OTP sessions (send/verify/status) — app credentials" },
        { name: "apps", description: "App provisioning (operator Bearer)" },
        { name: "billing", description: "Credit packages, transactions, balances" },
        { name: "bulk", description: "Bulk SMS campaigns" },
        { name: "contact-groups", description: "Per-app contact groups" },
        { name: "message-templates", description: "Per-app message templates" },
        { name: "admin", description: "Operator-gated management plane (OPERATOR_SECRET)" },
      ],
    },
  });
  app.register(swaggerUi, { routePrefix: "/docs" });

  app.get("/health", async () => {
    // DB ping: proves migrations ran and the file is writable this boot
    db.prepare("SELECT 1").get();
    return {
      status: "healthy",
      service: "dprelay-server",
      // package.json version, so "is production current?" is one curl — this is
      // how 3 merges shipped to master while Render kept serving a pre-M1 build
      // undetected (ISSUE-13).
      version: require("../package.json").version as string,
      db: "ok",
      timestamp: Date.now(),
    };
  });

  app.get("/healthz", async () => ({ ok: true }));

  // Auth/service + middleware plugins first, then routes (they rely on decorators).
  app.register(authService, { config });
  app.register(middleware);
  app.register(authRoutes);
  app.register(deviceRoutes);
  app.register(otpRoutes);
  app.register(appRoutes);
  app.register(billingRoutes);
  app.register(bulkRoutes);
  app.register(contactGroupRoutes);
  app.register(messageTemplateRoutes);
  app.register(adminAppRoutes);

  // Jobs (R3) + wake guard (R5). Decorators must exist before hooks run.
  registerJobs(app, config, startCron);
  if (enableWakeGuard) {
    registerWakeGuard(app, opts.wakeIdleThresholdSec ?? config.wakeIdleThresholdSec);
  }
  if (runBootSweep) {
    // R5: catch-up sweep on boot compensates for ticks missed while asleep.
    app.ready().then(
      () => app.runCatchUpSweep(),
      (err: unknown) => app.log.error({ err }, "boot catch-up sweep failed"),
    );
  }

  // Structured error envelope for unhandled route errors: { ok, error, code }.
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;
    app.log.error({ err: error }, "request failed");
    void reply.code(statusCode).send({
      ok: false,
      error: statusCode >= 500 ? "Internal server error" : error.message,
      code: "internal_error",
    });
  });

  return app;
}
