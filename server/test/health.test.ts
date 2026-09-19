import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { buildApp } from "../src/app.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

/** Test-only secret — the server fail-fasts at boot without JWT_SECRET (M1). */
const TEST_JWT_SECRET = "test-only-secret-0123456789abcdef0123456789abcdef";

function makeApp() {
  const dbPath = join(mkdtempSync(join(tmpdir(), "dprelay-test-")), "test.db");
  return buildApp({ dbPath, env: { JWT_SECRET: TEST_JWT_SECRET } });
}

describe("health endpoints", () => {
  it("GET /health returns healthy with a working db", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("healthy");
    expect(body.db).toBe("ok");
    // ISSUE-13: production staleness was invisible for 3 merges. The version
    // field must track package.json so "is prod current?" is one curl.
    expect(body.version).toBe(pkg.version);
    expect(typeof body.timestamp).toBe("number");
    await app.close();
  });

  it("migrations are idempotent across boots (simulates Render restart)", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "dprelay-test-")), "t.db");
    const app1 = makeApp();
    await app1.close();
    const app2 = buildApp({ dbPath, env: { JWT_SECRET: TEST_JWT_SECRET } }); // second boot on same file
    const res = await app2.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    await app2.close();
  });

  it("seeds kill_switch=false from migration 001", async () => {
    const app = makeApp();
    const row = app.db
      .prepare("SELECT value FROM settings WHERE key = 'kill_switch'")
      .get() as { value: string } | undefined;
    expect(row?.value).toBe("false");
    await app.close();
  });
});
