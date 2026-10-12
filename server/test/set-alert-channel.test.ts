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
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startSink, type Sink } from "./helpers/net.js";

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

/**
 * Spins up a recording mock of both APIs and tears it down after each test.
 *
 * Both mocks are instances of the shared helpers/net.ts sink, configured with
 * a `record` path filter (ISSUE-92: a cross-worker stray is neither recorded
 * nor answered — its socket is destroyed) and a `respond` that replays the
 * real APIs' success shapes. The scoping and force-drop teardown semantics
 * live in the shared module; this file only states WHICH paths are its own.
 */
async function startMocks(opts: MockOptions = {}): Promise<{
  tgUrl: string;
  renderUrl: string;
  tgCalls: Recorded[];
  renderCalls: Recorded[];
  stop: () => Promise<void>;
}> {
  // getMe and sendMessage both answer 200 {ok:true} on success; the test
  // distinguishes them by path, which is what the real Bot API does.
  const tg: Sink = await startSink({
    record: ({ path }) => path.startsWith("/bot"),
    respond: (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { username: "test_ops_bot" } }));
    },
  });

  const render: Sink = await startSink({
    path: "/v1/services",
    record: ({ path }) => path.startsWith("/v1/services"),
    respond: (req, res) => {
      if (req.method === "GET" && req.path.endsWith("/env-vars")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([{ key: "JWT_SECRET", value: "test-only" }]));
        return;
      }
      if (req.method === "PUT" && req.path.endsWith("/env-vars")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("[]");
        return;
      }
      if (req.method === "POST" && req.path.endsWith("/deploys")) {
        res.writeHead(opts.deployStatus ?? 201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "deploy triggered" }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "unmocked" }));
    },
  });

  // Test files assert `tgCalls == []` / method+path projections; the shared
  // sink captures strictly more (headers + body), so narrow to the shape the
  // assertions were written against.
  const tgCalls: Recorded[] = [];
  const renderCalls: Recorded[] = [];
  const project = (sink: Sink, into: Recorded[]): void => {
    while (into.length < sink.requests.length) {
      const r = sink.requests[into.length];
      into.push({ method: r.method, path: r.path });
    }
  };

  return {
    tgUrl: tg.url,
    renderUrl: render.url,
    get tgCalls() {
      project(tg, tgCalls);
      return tgCalls;
    },
    get renderCalls() {
      project(render, renderCalls);
      return renderCalls;
    },
    stop: () => Promise.all([tg.close(), render.close()]).then(() => undefined),
  };
}

let stopMocks: (() => Promise<void>) | null = null;
afterEach(async () => {
  if (stopMocks) {
    await stopMocks();
    stopMocks = null;
  }
});

describe("set-alert-channel.cjs mock scope isolation (ISSUE-92)", () => {
  it("ignores cross-worker stray requests without recording or answering them", async () => {
    const mocks = await startMocks();
    stopMocks = mocks.stop;

    // Simulate another vitest worker's lingering webhook retry landing on
    // these mocks via ephemeral-port recycling (the exact CI failure: a
    // POST /otp-status recorded on the Render mock, path only the OTP
    // webhook-dispatch tests use). The stray must not be recorded, and the
    // socket is destroyed so the other worker still sees a transport error
    // rather than a response that would fail ITS assertions.
    for (const [base, path] of [
      [mocks.renderUrl.replace(/\/v1\/services$/, ""), "/otp-status"],
      [mocks.tgUrl, "/health"],
    ] as const) {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        body: JSON.stringify({ stray: true }),
        signal: AbortSignal.timeout(2_000),
      }).catch((err: unknown) => err);
      // Destroyed socket = fetch rejection, never a recorded call.
      expect(res, `${path} must not receive an HTTP response`).toBeInstanceOf(Error);
    }

    expect(mocks.renderCalls).toEqual([]);
    expect(mocks.tgCalls).toEqual([]);
  });

  it("still records the script's own paths after scoping", async () => {
    const mocks = await startMocks();
    stopMocks = mocks.stop;

    // Positive control: scoping must not swallow the real traffic the
    // assertions depend on — a Bot API path and a Render API path.
    const tg = await fetch(`${mocks.tgUrl}/bot${FAKE_TOKEN}/getMe`, { signal: AbortSignal.timeout(2_000) });
    expect(tg.status).toBe(200);
    const render = await fetch(`${mocks.renderUrl}/svc_TEST/env-vars`, { signal: AbortSignal.timeout(2_000) });
    expect(render.status).toBe(200);

    expect(mocks.tgCalls.map((c) => c.path)).toEqual([`/bot${FAKE_TOKEN}/getMe`]);
    expect(mocks.renderCalls.map((c) => c.path)).toEqual(["/v1/services/svc_TEST/env-vars"]);
  });
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

/**
 * Runs the script with stderr folded into stdout, giving one ordered stream.
 *
 * Both banners went to stderr on purpose, so that they survive a redirected
 * stdout. The side effect is that "the banner was said before the write" is no
 * longer observable inside `stdout` alone - and that ordering is the property
 * which makes the banner a warning rather than a receipt. Folding the streams
 * here reproduces what an operator actually sees: both in a terminal, or with
 * `2>&1`.
 */
async function runMerged(
  args: string[],
  env: { tgUrl: string; renderUrl: string },
): Promise<{ status: number | null; output: string }> {
  const childEnv = { ...process.env };
  delete childEnv.DRY_RUN;
  childEnv.RENDER_API_KEY = "test-render-key-not-a-secret";
  // The redirect is appended unquoted: quoting it would hand the script a
  // literal "2>&1" argv entry instead of folding the streams.
  const cmd =
    [process.execPath, scriptPath, ...args].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ") + " 2>&1";
  return new Promise((resolve, reject) => {
    // spawn, never spawnSync: the mock APIs are HTTP servers in THIS process,
    // so a synchronous spawn would block the event loop that has to answer the
    // child. That failure mode is nasty rather than obvious - the child just
    // waits out its 15s request timeout and exits 1.
    const child = spawn("sh", ["-c", cmd], {
      env: { ...childEnv, TELEGRAM_API_BASE: env.tgUrl, RENDER_API_BASE: env.renderUrl },
    });
    let output = "";
    // `2>&1` in the command already folds the inner process's stderr into this
    // pipe; the second listener is belt-and-braces for anything sh itself emits.
    child.stdout.on("data", (d) => (output += String(d)));
    child.stderr.on("data", (d) => (output += String(d)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ status: code, output }));
  });
}

describe("set-alert-channel.cjs real-run banner", () => {
  it("announces itself BEFORE it changes production, not after", async () => {
    const mocks = await startMocks();
    stopMocks = mocks.stop;

    const res = await runMerged(["telegram", FAKE_TOKEN, FAKE_CHAT_ID], {
      tgUrl: mocks.tgUrl,
      renderUrl: mocks.renderUrl,
    });

    // The run really happened, so the banner is not vacuous...
    expect(res.status).toBe(0);
    expect(res.output).toContain("PUT env status");
    // ...and it was said first. A banner printed after the write would be a
    // receipt, not a warning, which is the opposite of what this is for.
    expect(res.output).toContain("REAL RUN");
    expect(res.output.indexOf("REAL RUN")).toBeLessThan(res.output.indexOf("PUT env status"));
  });

  it("survives stdout being redirected away, which is the point of stderr", async () => {
    const mocks = await startMocks();
    stopMocks = mocks.stop;

    const res = await run(["telegram", FAKE_TOKEN, FAKE_CHAT_ID], {
      tgUrl: mocks.tgUrl,
      renderUrl: mocks.renderUrl,
    });

    // The receipt stays on stdout, where `> deploy.log` collects it...
    expect(res.stdout).toContain("PUT env status");
    // ...and the warning does not go with it. On stdout, `node … > deploy.log`
    // would swallow the one line that says production is about to change.
    expect(res.stderr).toContain("REAL RUN");
    expect(res.stdout).not.toContain("REAL RUN");
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
    expect(res.stderr).toContain("mode: revert removes WATCHDOG_STALE_SEC");
  });

  it("calls wait-live READ-ONLY rather than claiming it will change production", () => {
    // No mock: wait-live only needs the banner, which prints before any I/O.
    const res = spawnSync(process.execPath, [scriptPath, "wait-live"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", RENDER_API_KEY: "test-render-key-not-a-secret", RENDER_API_BASE: "http://127.0.0.1:1" },
    });
    expect(res.stderr).toContain("READ-ONLY");
    // A banner that overstates a status poll trains the eye to skip it.
    expect(res.stderr).not.toContain("WILL act on production\n  mode: wait-live sets");
  });

  it("stays silent on the bare usage path, which changes nothing", () => {
    const res = spawnSync(process.execPath, [scriptPath], { encoding: "utf8" });
    expect(res.status).toBe(1);
    // A banner that fired here would be pure noise on `node script` with no args.
    // Both streams are checked because the banner now lives on stderr; checking
    // stdout alone would pass whether or not the banner fired.
    expect(res.stdout).not.toContain("REAL RUN");
    expect(res.stderr).not.toContain("REAL RUN");
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
    // both banners exist to remove. stderr is where both now print, so this
    // has to be asserted there rather than on stdout.
    expect(res.stderr).not.toContain("REAL RUN");
  });
});
