/**
 * set-alert-channel.cjs regression tests.
 *
 * Why this file exists: the script is an ops tool whose entire value is telling
 * the operator the truth about what it did to production, and it had exactly
 * one guard protecting that — DRY_RUN, checked *after* the probe sendMessage
 * and *only* in telegram mode. So a DRY_RUN still messaged the real ops group,
 * a dry run exited 0 (indistinguishable from a real run), and `set`/`set-stale`/
 * `revert`/`deploy` ignored DRY_RUN completely and wrote to Render anyway.
 *
 * These tests are hermetic: both API origins are pointed at local http mocks
 * via the script's own *_API_BASE overrides, so no test can ever touch the real
 * Bot API or Render — including when run against the unfixed script.
 */
import { describe, expect, it, afterEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(serverRoot, "scripts", "set-alert-channel.cjs");

/** Fake bot token: matches the shape getMe expects, carries no real secret. */
const FAKE_TOKEN = "12345:TEST-TOKEN";
const FAKE_CHAT_ID = "-100200300";

interface Recorded {
  method: string;
  path: string;
}

interface MockOptions {
  /** Status for POST /deploys; 201 is the only success Render returns. */
  deployStatus?: number;
}

/** Spins up a recording mock of both APIs and tears it down after each test. */
async function startMocks(opts: MockOptions = {}): Promise<{
  tgUrl: string;
  renderUrl: string;
  tgCalls: Recorded[];
  renderCalls: Recorded[];
  stop: () => Promise<void>;
}> {
  const tgCalls: Recorded[] = [];
  const renderCalls: Recorded[] = [];
  const servers: Server[] = [];

  const tg = createServer((req, res) => {
    tgCalls.push({ method: req.method ?? "", path: req.url ?? "" });
    req.resume();
    req.on("end", () => {
      // getMe and sendMessage both answer 200 {ok:true} on success; the test
      // distinguishes them by path, which is what the real Bot API does.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { username: "test_ops_bot" } }));
    });
  });

  const render = createServer((req, res) => {
    renderCalls.push({ method: req.method ?? "", path: req.url ?? "" });
    req.resume();
    req.on("end", () => {
      const url = req.url ?? "";
      if (req.method === "GET" && url.endsWith("/env-vars")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([{ key: "JWT_SECRET", value: "test-only" }]));
        return;
      }
      if (req.method === "PUT" && url.endsWith("/env-vars")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("[]");
        return;
      }
      if (req.method === "POST" && url.endsWith("/deploys")) {
        res.writeHead(opts.deployStatus ?? 201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "deploy triggered" }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "unmocked" }));
    });
  });

  await Promise.all(
    [tg, render].map(
      (s) =>
        new Promise<void>((resolve) => {
          s.listen(0, "127.0.0.1", resolve);
          servers.push(s);
        }),
    ),
  );
  const url = (s: Server): string => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

  return {
    tgUrl: url(tg),
    renderUrl: `${url(render)}/v1/services`,
    tgCalls,
    renderCalls,
    stop: () =>
      Promise.all(
        servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
      ).then(() => undefined),
  };
}

let stopMocks: (() => Promise<void>) | null = null;
afterEach(async () => {
  if (stopMocks) {
    await stopMocks();
    stopMocks = null;
  }
});

/**
 * Runs the script with both APIs pointed at the mocks.
 *
 * Uses async spawn, NOT spawnSync: the mock servers live in this process, and
 * spawnSync blocks the event loop, so the child would wait on a connection this
 * process can never accept. The result is a 15s timeout in every test rather
 * than an obvious deadlock, which is why it is spelled out here.
 */
function run(
  args: string[],
  env: { tgUrl: string; renderUrl: string; dryRun?: string },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const childEnv = { ...process.env };
  delete childEnv.DRY_RUN;
  // Supplied explicitly so the suite does not depend on a machine-local
  // .kilo/kilo.jsonc — which is exactly the coupling that made this script
  // crash on CI. The value is a non-secret placeholder.
  childEnv.RENDER_API_KEY = "test-render-key-not-a-secret";
  if (env.dryRun !== undefined) childEnv.DRY_RUN = env.dryRun;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      env: { ...childEnv, TELEGRAM_API_BASE: env.tgUrl, RENDER_API_BASE: env.renderUrl },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ status: code, stdout, stderr }));
  });
}

describe("set-alert-channel.cjs DRY_RUN hazard", () => {
  it("is syntactically valid", () => {
    const res = spawnSync(process.execPath, ["--check", scriptPath], { encoding: "utf8" });
    expect(res.status).toBe(0);
  });

  it("refuses before ANY network call, so a rehearsal cannot message the group", async () => {
    const mocks = await startMocks();
    stopMocks = mocks.stop;

    const res = await run(["telegram", FAKE_TOKEN, FAKE_CHAT_ID], {
      tgUrl: mocks.tgUrl,
      renderUrl: mocks.renderUrl,
      dryRun: "1",
    });

    // Not merely "no sendMessage" — no call at all, not even the read-only
    // getMe. An earlier design let getMe through as a harmless read, which
    // meant a blocked run still looked like it had verified something.
    expect(mocks.tgCalls).toEqual([]);
    expect(mocks.renderCalls).toEqual([]);
    expect(res.status).toBe(2);
  });

  it("exits 2 and says loudly that the Render write was skipped", async () => {
    const mocks = await startMocks();
    stopMocks = mocks.stop;

    const res = await run(["telegram", FAKE_TOKEN, FAKE_CHAT_ID], {
      tgUrl: mocks.tgUrl,
      renderUrl: mocks.renderUrl,
      dryRun: "1",
    });

    expect(res.status).not.toBe(0);
    expect(res.status).toBe(2);
    // The refusal goes to stderr: it is a refusal, not a result.
    expect(res.stderr).toContain("REFUSING TO RUN");
    expect(res.stderr).toContain("no Render env was");
    expect(res.stderr).toContain("no deploy was triggered");
    // It must hand back the exact command that does the real work.
    expect(res.stderr).toContain("DRY_RUN= node server/scripts/set-alert-channel.cjs telegram");
  });

  it("blocks any non-empty value, not just 1 or true", async () => {
    const mocks = await startMocks();
    stopMocks = mocks.stop;

    for (const value of ["true", "yes", "0", "  "]) {
      const res = await run(["telegram", FAKE_TOKEN, FAKE_CHAT_ID], {
        tgUrl: mocks.tgUrl,
        renderUrl: mocks.renderUrl,
        dryRun: value,
      });
      // "0" and whitespace look falsy to a naive parse, which is precisely how a
      // hazard would slip through a truthiness check.
      expect(res.status, `DRY_RUN=${JSON.stringify(value)} must block`).toBe(2);
    }
    expect(mocks.renderCalls).toEqual([]);
  });

  it("treats DRY_RUN= (empty) as explicitly unset and runs for real", async () => {
    const mocks = await startMocks();
    stopMocks = mocks.stop;

    const res = await run(["telegram", FAKE_TOKEN, FAKE_CHAT_ID], {
      tgUrl: mocks.tgUrl,
      renderUrl: mocks.renderUrl,
      dryRun: "",
    });

    expect(res.status).toBe(0);
    expect(mocks.renderCalls.map((c) => `${c.method} ${c.path.split("/").pop()}`)).toEqual([
      "GET env-vars",
      "PUT env-vars",
      "POST deploys",
    ]);
  });

  it("blocks read-only modes too, rather than special-casing them", async () => {
    const mocks = await startMocks();
    stopMocks = mocks.stop;

    // wait-live only issues GETs, so a "harmless" exemption would still let an
    // operator believe they had polled a deploy that they never triggered.
    const res = await run(["wait-live"], {
      tgUrl: mocks.tgUrl,
      renderUrl: mocks.renderUrl,
      dryRun: "1",
    });

    expect(res.status).toBe(2);
    expect(mocks.renderCalls).toEqual([]);
  });

  it("refuses every mode under DRY_RUN, including the ones that used to ignore it", async () => {
    const mocks = await startMocks();
    stopMocks = mocks.stop;
    const env = { tgUrl: mocks.tgUrl, renderUrl: mocks.renderUrl, dryRun: "1" };

    // set / set-stale / revert / deploy originally had no DRY_RUN guard at all:
    // they went straight through to a live Render PUT while the operator
    // assumed a rehearsal. All must now stop before the first request.
    for (const args of [
      ["set", "https://receiver.example.com/hook"],
      ["set-stale", "60"],
      ["revert"],
      ["deploy"],
    ]) {
      const res = await run(args, env);
      expect(res.status, `${args[0]} should exit 2`).toBe(2);
      expect(res.stderr, `${args[0]} should explain the refusal`).toContain("REFUSING TO RUN");
    }

    expect(mocks.renderCalls).toEqual([]);
  });

  it("still performs the real run when DRY_RUN is absent", async () => {
    const mocks = await startMocks();
    stopMocks = mocks.stop;

    const res = await run(["telegram", FAKE_TOKEN, FAKE_CHAT_ID], {
      tgUrl: mocks.tgUrl,
      renderUrl: mocks.renderUrl,
    });

    expect(res.status).toBe(0);
    expect(mocks.tgCalls.map((c) => c.path)).toEqual([
      `/bot${FAKE_TOKEN}/getMe`,
      `/bot${FAKE_TOKEN}/sendMessage`,
    ]);
    // Only the last path segment is asserted: the service id is a constant and
    // asserting it here would make every test re-state it.
    expect(mocks.renderCalls.map((c) => `${c.method} ${c.path.split("/").pop()}`)).toEqual([
      "GET env-vars",
      "PUT env-vars",
      "POST deploys",
    ]);
  });
});

describe("set-alert-channel.cjs failure modes", () => {
  it("names the half-applied recovery step when the deploy trigger fails", async () => {
    const mocks = await startMocks({ deployStatus: 500 });
    stopMocks = mocks.stop;

    const res = await run(["telegram", FAKE_TOKEN, FAKE_CHAT_ID], {
      tgUrl: mocks.tgUrl,
      renderUrl: mocks.renderUrl,
    });

    // The env PUT already landed, so WATCHDOG_STALE_SEC=60 is armed and will
    // load on the next unrelated deploy. Silence here is how a production
    // watchdog ends up screaming at 60s forever.
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("WATCHDOG_STALE_SEC=60");
    expect(res.stderr).toContain("set-alert-channel.cjs revert");
  });

  it("exits 1 with usage when invoked with no mode", () => {
    const res = spawnSync(process.execPath, [scriptPath], { encoding: "utf8" });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("usage: set-alert-channel.cjs");
    // The usage text is where an operator learns the refusal exists at all.
    expect(res.stderr).toContain("DRY_RUN");
    expect(res.stderr).toContain("refuses to run");
  });

  it("does not need a machine-local credential file to print usage", () => {
    // The CI failure this pins: with the repo root resolved from an absolute
    // owner-machine path and the key read eagerly at module load, this spawn
    // died with a bare ENOENT before printing anything.
    const res = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      // A cwd far from the repo, and no RENDER_API_KEY, so any eager read of
      // .kilo/kilo.jsonc would surface here.
      cwd: os.tmpdir(),
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(res.stderr).not.toContain("ENOENT");
    expect(res.stderr).toContain("usage: set-alert-channel.cjs");
  });
});

describe("set-alert-channel.cjs real-run banner", () => {
  it("announces itself BEFORE it changes production, not after", async () => {
    const mocks = await startMocks();
    stopMocks = mocks.stop;

    const res = await run(["telegram", FAKE_TOKEN, FAKE_CHAT_ID], {
      tgUrl: mocks.tgUrl,
      renderUrl: mocks.renderUrl,
    });

    // The run really happened, so the banner is not vacuous...
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("PUT env status");
    // ...and it was said first. A banner printed after the write would be a
    // receipt, not a warning, which is the opposite of what this is for.
    expect(res.stdout).toContain("REAL RUN");
    expect(res.stdout.indexOf("REAL RUN")).toBeLessThan(res.stdout.indexOf("PUT env status"));
  });

  it("names the actual consequence for the mode being run", async () => {
    const mocks = await startMocks();
    stopMocks = mocks.stop;

    const res = await run(["revert"], {
      tgUrl: mocks.tgUrl,
      renderUrl: mocks.renderUrl,
    });

    // Not a generic "you are running for real": the operator has to be told
    // what this specific mode is about to do to production.
    expect(res.stdout).toContain("mode: revert removes WATCHDOG_STALE_SEC");
  });

  it("calls wait-live READ-ONLY rather than claiming it will change production", () => {
    // No mock: wait-live only needs the banner, which prints before any I/O.
    const res = spawnSync(process.execPath, [scriptPath, "wait-live"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", RENDER_API_KEY: "test-render-key-not-a-secret", RENDER_API_BASE: "http://127.0.0.1:1" },
    });
    expect(res.stdout).toContain("READ-ONLY");
    // A banner that overstates a status poll trains the eye to skip it.
    expect(res.stdout).not.toContain("WILL act on production\n  mode: wait-live sets");
  });

  it("stays silent on the bare usage path, which changes nothing", () => {
    const res = spawnSync(process.execPath, [scriptPath], { encoding: "utf8" });
    expect(res.status).toBe(1);
    // A banner that fired here would be pure noise on `node script` with no args.
    expect(res.stdout).not.toContain("REAL RUN");
  });

  it("never prints the real-run banner on a run it refused", async () => {
    const mocks = await startMocks();
    stopMocks = mocks.stop;

    const res = await run(["telegram", FAKE_TOKEN, FAKE_CHAT_ID], {
      tgUrl: mocks.tgUrl,
      renderUrl: mocks.renderUrl,
      dryRun: "1",
    });

    expect(res.status).toBe(2);
    expect(res.stderr).toContain("REFUSING TO RUN");
    // "Real run" and "refused" in the same output is exactly the ambiguity
    // both banners exist to remove.
    expect(res.stdout).not.toContain("REAL RUN");
  });
});
