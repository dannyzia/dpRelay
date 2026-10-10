/**
 * Guard tests for the two owner-local rotation scripts under gitignored
 * `staging/`: rotate-core-secrets.cjs and rotate-fcm-key.cjs.
 *
 * These scripts are the only tools in the repo that invalidate every operator
 * credential at once, and both had defects that turned a rehearsal into the real
 * thing. This file pins the guards that prevent a repeat, and it pins them by
 * RUNNING the real CLI as a subprocess rather than by reading its source — the
 * defects were not in the source text, they were in what a given argv did.
 *
 *   rotate-core-secrets.cjs  `rollback --dry-run` performed a LIVE rollback,
 *   because --dry-run was a positional mode rather than a flag. And an unknown
 *   argument was not an error: `mode = process.argv[2] || "rotate"` meant a bare
 *   invocation or a typo rotated all four core secrets and deployed.
 *
 *   rotate-fcm-key.cjs  had no dry-run at all, so `apply` — which PUTs the env
 *   and triggers a deploy — could not be rehearsed at all.
 *
 * The environment each CLI runs in is hostile on purpose, so a script cannot
 * accidentally do the real thing and still pass:
 *
 *   RENDER_API_KEY deleted + an unreachable DBus address means resolving a
 *   credential fails in ~35ms instead of reading the owner's keyring. Any script
 *   that resolves credentials before answering a question therefore fails loudly.
 *   https://127.0.0.1:9 for both API bases means any network call is refused
 *   instantly, so "exited 0" is proof that no call was made rather than proof
 *   that a call succeeded quietly.
 *
 * Both scripts live under gitignored staging/ and do not exist on a CI runner,
 * so each describe SKIPS when its script is absent — the precedent is
 * rotate-fcm-key-validation.test.ts, which reads the same directory.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";
import { testTmpDir } from "./helpers/tmp-dirs.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require_ = createRequire(import.meta.url);

const CORE_SECRETS = join(repoRoot, "staging", "rotate-core-secrets.cjs");
const FCM_KEY = join(repoRoot, "staging", "rotate-fcm-key.cjs");

/**
 * Runs a rotation script in an environment where every real action fails fast.
 *
 * @param {string} script absolute path to the script
 * @param {string[]} args arguments after the script path
 * @param {Record<string, string>} [extraEnv] overrides merged last
 * @returns {{ status: number|null, out: string }} exit status and combined output
 */
function runCli(script: string, args: string[], extraEnv: Record<string, string> = {}): { status: number | null; out: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DRY_RUN;
  // No credential, and none obtainable: an unreachable session bus makes the
  // keyring lookup fail in milliseconds rather than reach for the real one.
  delete env.RENDER_API_KEY;
  env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/nonexistent-dprelay-test-bus";
  // Connection refused, not a hang.
  env.RENDER_API_BASE = "https://127.0.0.1:9";
  env.DPRELAY_API_BASE = "https://127.0.0.1:9";
  Object.assign(env, extraEnv);
  const res = spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, env, encoding: "utf8" });
  return { status: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

/** A key file the dry-run can read without touching Google or Render. */
function writeFakeKey(): string {
  const dir = testTmpDir("dprelay-rotate-guard-");
  const file = join(dir, "service-account.json");
  writeFileSync(
    file,
    JSON.stringify({
      type: "service_account",
      project_id: "authenticator-15fb7",
      private_key_id: "candidate-key-id",
      client_email: "svc@authenticator-15fb7.iam.gserviceaccount.com",
      // Assembled from fragments on purpose: scripts/secret-scan.sh rejects any
      // tracked line carrying a PEM shape, and this fixture is synthetic —
      // concatenation is the mitigation the allowlist file itself prescribes,
      // so no allowlist entry is needed (same class as pre-commit-hook.test.ts).
      private_key: [
        "-----BEGIN ",
        "PRIVATE KEY-----",
        "not-a-real-key",
        "-----END ",
        "PRIVATE KEY-----",
      ].join("\\n") + "\\n",
    }),
  );
  return file;
}

/** The shape the stalled transport hands back: chainable no-ops plus a destroy. */
interface StalledRequest {
  on(event: string, handler: (arg?: unknown) => void): StalledRequest;
  write(): StalledRequest;
  end(): void;
  destroy(err: Error): void;
}

/**
 * A stand-in for node:https whose request never answers, so the script's
 * per-request ceiling is what ends the call.
 *
 * The scripts hold a reference to the shared module object rather than importing
 * `request` by name, so replacing the property is enough — the alternative,
 * re-extracting the source as the sibling suite does, cannot reach the real
 * module-scope timeout constant without duplicating that whole scanner here.
 *
 * `destroy(err)` emits 'error', which is what a real ClientRequest does; that is
 * the only reason the promise under test settles.
 */
async function withStalledTransport<T>(fn: (transport: { fire: (event: string) => void }) => Promise<T>): Promise<T> {
  const handlers = new Map<string, Array<(arg?: unknown) => void>>();
  const real = https.request;
  let fire: (event: string) => void = () => {};

  https.request = (() => {
    const req: StalledRequest = {
      on(event: string, handler: (arg?: unknown) => void) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
        return req;
      },
      write() {
        return req;
      },
      end() {
        // Deliberately never responds: this is the hang the ceiling exists for.
      },
      destroy(err: Error) {
        for (const handler of handlers.get("error") ?? []) handler(err);
      },
    };
    return req;
  }) as unknown as typeof https.request;
  fire = (event: string) => {
    for (const handler of [...(handlers.get(event) ?? [])]) handler();
  };

  try {
    return await fn({ fire });
  } finally {
    https.request = real;
  }
}

describe.skipIf(!existsSync(CORE_SECRETS))("rotate-core-secrets.cjs guards", () => {
  it("prints the rotation plan with no credential and no network call", () => {
    const { status, out } = runCli(CORE_SECRETS, ["rotate", "--dry-run"]);

    // Exit 0 under a credential that cannot be resolved and an API base that
    // refuses connections: the plan touched nothing.
    expect(status).toBe(0);
    expect(out).toMatch(/would rotate/);
    expect(out).toMatch(/no network calls/);
  });

  it("treats --dry-run as a flag, so `rollback --dry-run` cannot roll back", () => {
    // The regression this whole file exists for: --dry-run used to be read as
    // argv[2], so this exact command took the rollback branch and restored
    // every operator credential in production.
    const { status, out } = runCli(CORE_SECRETS, ["rollback", "--dry-run"]);

    // Exit 2, not 0: this environment has no keyring, so the plan correctly
    // reports that there is nothing to restore. Either way it is not exit 1,
    // which is what an attempted rollback against 127.0.0.1:9 would produce.
    expect(status).toBe(2);
    expect(out).not.toMatch(/PUT env-vars|POST \/deploys|restoring/);
  });

  it("refuses a bare invocation instead of rotating", () => {
    const { status, out } = runCli(CORE_SECRETS, []);

    expect(status).toBe(2);
    expect(out).toMatch(/a mode must be named/);
    expect(out).not.toMatch(/PUT env-vars|POST \/deploys/);
  });

  it("refuses an unknown mode rather than falling through to a rotation", () => {
    const { status, out } = runCli(CORE_SECRETS, ["rotat"]);

    expect(status).toBe(2);
    expect(out).toMatch(/unknown mode/);
    // "nothing happened" is the whole claim; the PUT line would contradict it.
    expect(out).not.toMatch(/PUT env-vars|POST \/deploys/);
  });

  it("refuses an unknown flag and extra arguments", () => {
    expect(runCli(CORE_SECRETS, ["rotate", "--force"]).status).toBe(2);
    expect(runCli(CORE_SECRETS, ["rollback", "--dry-run", "extra"]).status).toBe(2);
  });

  it("refuses every mode when DRY_RUN is set, including rollback and dry-run", () => {
    for (const args of [["rotate"], ["rollback"], ["rotate", "--dry-run"], ["rollback", "--dry-run"]]) {
      const { status, out } = runCli(CORE_SECRETS, args, { DRY_RUN: "1" });

      expect(status, `DRY_RUN with args ${args.join(" ")}`).toBe(2);
      expect(out).toMatch(/REFUSING TO RUN/);
      expect(out).not.toMatch(/PUT env-vars|POST \/deploys|restoring/);
    }
  });

  it("treats an empty DRY_RUN as unset, so an operator can override one export", () => {
    const { out } = runCli(CORE_SECRETS, ["rotate", "--dry-run"], { DRY_RUN: "" });

    expect(out).not.toMatch(/REFUSING TO RUN/);
    expect(out).toMatch(/would rotate/);
  });

  it("is importable without starting a rotation", () => {
    // The guard against a test — or any future tooling — importing this module
    // and taking the whole admin plane with it.
    const mod = require_(CORE_SECRETS) as { parseArgs: (a: string[]) => { mode: string; dryRun: boolean }; EXIT_REFUSED: number };

    expect(mod.EXIT_REFUSED).toBe(2);
    expect(mod.parseArgs(["rollback", "--dry-run"])).toEqual({ mode: "rollback", dryRun: true });
    // The flag is order-independent, which is the property that broke before.
    expect(mod.parseArgs(["--dry-run", "rotate"])).toEqual({ mode: "rotate", dryRun: true });
    expect(mod.parseArgs([])).toEqual({ mode: "help", dryRun: false });
    expect(() => mod.parseArgs(["rotat"])).toThrow(/unknown mode/);
  });

  it("exits 1 when a real run fails, rather than reporting it as a refusal", () => {
    // Completes the 0/1/2 contract: 2 is "refused, nothing happened", so a run
    // that genuinely started and genuinely failed must not also report 2.
    // A dummy credential plus the unroutable base means the failure is the
    // connection itself, with no production call anywhere in it.
    const { status, out } = runCli(CORE_SECRETS, ["rotate"], { RENDER_API_KEY: "test-key-not-real" });

    expect(status).toBe(1);
    // Anchored, because "ECONNREFUSED" contains the substring "REFUSED"; what
    // matters is that this is the connection failing, not a guard refusing.
    expect(out).toMatch(/ECONNREFUSED/);
    expect(out).not.toMatch(/no Render API key/);
    expect(out).not.toMatch(/^REFUSED: /m);
  });

  it("fails a hung request loudly instead of freezing the shell", async () => {
    const mod = require_(CORE_SECRETS) as { request: (u: string, o?: unknown) => Promise<unknown> };

    await withStalledTransport(async ({ fire }) => {
      const settled = mod
        .request("https://render.example.test/v1/services/srv/env-vars?cursor=secret", {})
        .then(() => null, (err: Error) => err);
      fire("timeout");
      const err = await settled;

      expect(err?.message).toMatch(/^request timed out after \d+ms/);
      // Named by host only: the failure must not paste a full URL into a log.
      expect(err?.message).toContain("render.example.test");
      expect(err?.message).not.toContain("cursor=secret");
    });
  });
});

describe.skipIf(!existsSync(FCM_KEY))("rotate-fcm-key.cjs guards", () => {
  it("plans an apply with no credential, no Google call and no Render write", () => {
    const keyFile = writeFakeKey();
    const { status, out } = runCli(FCM_KEY, ["apply", keyFile, "--dry-run"]);

    expect(status).toBe(0);
    expect(out).toMatch(/candidate key: project=authenticator-15fb7 id=candidate-key-id/);
    // The checks it did NOT run are named, so nobody reads exit 0 as "validated".
    expect(out).toMatch(/needs the network/);
    expect(out).not.toMatch(/PUT env status|POST deploys status/);
  });

  it("plans snapshot and rollback without calling anything", () => {
    const snap = runCli(FCM_KEY, ["snapshot", "--dry-run"]);
    expect(snap.status).toBe(0);
    expect(snap.out).toMatch(/would GET the full env/);
    expect(snap.out).not.toMatch(/PUT env status|POST deploys status/);

    // The rollback plan has to read the keyring to say what it would restore,
    // and this environment has none, so it reports that and refuses (exit 2)
    // rather than reaching Render to find out. Exit 1 would be an attempted call
    // against 127.0.0.1:9.
    const back = runCli(FCM_KEY, ["rollback", "--dry-run"]);
    expect(back.status).toBe(2);
    expect(back.out).toMatch(/no rollback available/);
    expect(back.out).not.toMatch(/PUT env status|POST deploys status/);
  });

  it("refuses apply and verify with no key file", () => {
    for (const mode of ["apply", "verify"]) {
      const { status, out } = runCli(FCM_KEY, [mode]);

      expect(status, mode).toBe(2);
      expect(out).toMatch(new RegExp(`usage: .* ${mode} <new-service-account\\.json>`));
    }
  });

  it("refuses a missing key file rather than failing a run", () => {
    const { status, out } = runCli(FCM_KEY, ["apply", "/tmp/dprelay-no-such-key-file.json"]);

    expect(status).toBe(2);
    expect(out).toMatch(/key file not found/);
  });

  it("refuses a bare invocation and an unknown mode", () => {
    expect(runCli(FCM_KEY, []).status).toBe(2);
    expect(runCli(FCM_KEY, []).out).toMatch(/a mode must be named/);
    const typo = runCli(FCM_KEY, ["aply", "/tmp/x.json"]);
    expect(typo.status).toBe(2);
    expect(typo.out).toMatch(/nothing happened/);
  });

  it("refuses a key file on a mode that takes none", () => {
    const { status, out } = runCli(FCM_KEY, ["rollback", "/tmp/x.json"]);

    expect(status).toBe(2);
    expect(out).toMatch(/takes no key file/);
  });

  it("refuses every mode when DRY_RUN is set, including rollback and dry-run", () => {
    for (const args of [
      ["snapshot"],
      ["apply", writeFakeKey()],
      ["verify", writeFakeKey()],
      ["rollback"],
      ["rollback", "--dry-run"],
    ]) {
      const { status, out } = runCli(FCM_KEY, args, { DRY_RUN: "1" });

      expect(status, `DRY_RUN with args ${args[0]}`).toBe(2);
      expect(out).toMatch(/REFUSING TO RUN/);
      expect(out).not.toMatch(/PUT env status|POST deploys status/);
    }
  });

  it("is importable without starting a rotation", () => {
    const mod = require_(FCM_KEY) as {
      parseArgs: (a: string[]) => { mode: string; keyFile: string | null; dryRun: boolean };
      EXIT_REFUSED: number;
      keyIdentity: (s: string) => { keyId?: string };
    };

    expect(mod.EXIT_REFUSED).toBe(2);
    expect(mod.parseArgs(["rollback", "--dry-run"])).toEqual({
      mode: "rollback",
      keyFile: null,
      dryRun: true,
    });
    expect(mod.parseArgs(["apply", "/tmp/k.json", "--dry-run"])).toEqual({
      mode: "apply",
      keyFile: "/tmp/k.json",
      dryRun: true,
    });
    expect(mod.parseArgs([])).toEqual({ mode: "help", keyFile: null, dryRun: false });
    expect(() => mod.parseArgs(["apply"])).toThrow(/usage/);
    // The module must still be usable for the validation helpers the existing
    // suite exercises, so requiring it changes nothing about their behaviour.
    expect(mod.keyIdentity('{"private_key_id":"abc"}').keyId).toBe("abc");
  });

  it("exits 1 when a real run fails, rather than reporting it as a refusal", () => {
    const { status, out } = runCli(FCM_KEY, ["snapshot"], { RENDER_API_KEY: "test-key-not-real" });

    expect(status).toBe(1);
    expect(out).toMatch(/ECONNREFUSED/);
    expect(out).not.toMatch(/no Render API key/);
    expect(out).not.toMatch(/^REFUSED: /m);
  });

  it("fails a hung request loudly instead of freezing the shell", async () => {
    const mod = require_(FCM_KEY) as { request: (u: string, o?: unknown) => Promise<unknown> };

    await withStalledTransport(async ({ fire }) => {
      const settled = mod
        .request("https://oauth2.googleapis.com/token?key=abc123", { method: "POST", body: "x=1" })
        .then(() => null, (err: Error) => err);
      fire("timeout");
      const err = await settled;

      expect(err?.message).toMatch(/^request timed out after \d+ms/);
      expect(err?.message).toContain("oauth2.googleapis.com");
      // A stalled token POST must not echo the query string into the message.
      expect(err?.message).not.toContain("key=abc123");
    });
  });
});
