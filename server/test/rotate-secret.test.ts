/**
 * Guards the per-secret rotator's decision surface: the target table, argument
 * parsing, the refusal map, and the hand-rolled HS256 verification the JWT
 * probe depends on.
 *
 * The network half of the script (PUT, deploy, probe) is exercised end-to-end
 * against a local mock instead — but every decision it makes before or after a
 * request lives here, and each of these has a production failure mode: a
 * drifted generator deploys a value the service cannot consume, a missing
 * refusal rotates a secret nothing can verify, and an `alg: none` hole would
 * make the JWT probe prove the opposite of what it claims.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require_ = createRequire(import.meta.url);

type Target = {
  generate: () => string;
  pattern: RegExp;
  format: string;
  describe: string;
  /** True when the probe is answered by an external receiver, not by the service. */
  receiverSync?: boolean;
};

type ParsedArgs = {
  mode: "help" | "rotate" | "rollback";
  name: string | null;
  dryRun: boolean;
};

type RotateSecret = {
  TARGETS: Record<string, Target>;
  REFUSALS: Record<string, string>;
  ROLLBACK_ACCOUNT: string;
  EXIT_REFUSED: number;
  parseArgs: (argv: string[]) => ParsedArgs;
  refusalFor: (name: string) => string | null;
  generateValue: (name: string) => string;
  buildJwt: (secret: string, claims: { sub: string; email: string }) => string;
  verifyJwtHmac: (token: string, secret: string) => boolean;
  verifyAlertWebhook: (values: {
    accepted: string;
    rejected: string;
    env: Record<string, string>;
  }) => Promise<{ checks: { ok: boolean; label: string }[]; notes: string[] }>;
};

const rotate = require_(join(repoRoot, "server/scripts/rotate-secret.cjs")) as RotateSecret;
/** The real jsonwebtoken library @fastify/jwt consumes; used to keep the HMAC check honest. */
const jwt = require_(join(repoRoot, "server/node_modules/jsonwebtoken")) as {
  sign: (payload: object, secret: string, opts: { algorithm: string; expiresIn: number }) => string;
};

const SCRIPT_PATH = join(repoRoot, "server/scripts/rotate-secret.cjs");

/**
 * Runs the real CLI as a subprocess with DRY_RUN cleared unless a test sets it.
 * Every invocation here is a refusal or a plan, so no test reaches the network.
 */
function runCli(args: string[], extraEnv: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DRY_RUN;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], { cwd: repoRoot, env, encoding: "utf8" });
}

describe("the target table is exactly the managed operator-plane secrets", () => {
  /**
   * The lengths measured on the live Render env (2026-10-04; ALERT_WEBHOOK_SECRET
   * measured 2026-10-05). Pinned as numbers, not just as regexes, so a generator
   * edit that changes the format fails here even if someone relaxes the pattern
   * in the same commit.
   */
  const LIVE_LENGTHS: Record<string, number> = {
    JWT_SECRET: 88,
    OPERATOR_SECRET: 44,
    DEVICE_ENROLLMENT_SECRET: 43,
    APP_PROVISIONING_SECRET: 43,
    ALERT_WEBHOOK_SECRET: 43,
  };

  it("declares exactly the managed secrets and nothing else", () => {
    expect(Object.keys(rotate.TARGETS).sort()).toEqual(Object.keys(LIVE_LENGTHS).sort());
  });

  it("generates values at the pinned live length and format", () => {
    for (const [name, length] of Object.entries(LIVE_LENGTHS)) {
      const value = rotate.generateValue(name);
      expect(value.length, `${name} length`).toBe(length);
      expect(rotate.TARGETS[name]!.pattern.test(value), `${name} format`).toBe(true);
    }
  });

  it("pins each pattern to the full live length and charset", () => {
    for (const [name, target] of Object.entries(rotate.TARGETS)) {
      const value = rotate.generateValue(name);
      expect(target.pattern.test(value.slice(0, -1)), `${name} pattern accepts a short value`).toBe(false);
      expect(target.pattern.test(`${value.slice(0, -1)}!`), `${name} pattern accepts a foreign charset`).toBe(false);
    }
  });

  it("generates a fresh value every call", () => {
    for (const name of Object.keys(rotate.TARGETS)) {
      expect(rotate.generateValue(name), name).not.toBe(rotate.generateValue(name));
    }
  });

  it("describes a live probe for every target", () => {
    for (const [name, target] of Object.entries(rotate.TARGETS)) {
      expect(target.describe.length, name).toBeGreaterThan(30);
      expect(target.format.length, name).toBeGreaterThan(10);
    }
  });

  it("marks the alert secret as the only target needing an external receiver", () => {
    // The other four are answered by the deployed service. This one is answered
    // by the receiver, so its probe is only meaningful after the receiver has
    // been handed the new value — that ordering is the whole reason this flag
    // exists, and it must not be spread to targets that do not need it.
    expect(rotate.TARGETS.ALERT_WEBHOOK_SECRET?.receiverSync).toBe(true);
    for (const [name, target] of Object.entries(rotate.TARGETS)) {
      if (name !== "ALERT_WEBHOOK_SECRET") expect(target.receiverSync ?? false, name).toBe(false);
    }
  });
});

describe("refusals answer why a secret is not rotatable", () => {
  it("allows every declared target", () => {
    for (const name of Object.keys(rotate.TARGETS)) expect(rotate.refusalFor(name), name).toBeNull();
  });

  it("no longer refuses the alert secret — a real receiver was what it was missing", () => {
    expect(rotate.refusalFor("ALERT_WEBHOOK_SECRET")).toBeNull();
    expect(rotate.TARGETS.ALERT_WEBHOOK_SECRET?.receiverSync).toBe(true);
  });

  it("refuses the alert secret at the CLI when no receiver is configured", () => {
    // The refusal moved, it did not disappear. Without ALERT_RECEIVER_SYNC_URL
    // the probe would measure an untested value, so the run stops before its
    // first credentialed call — which is also why this needs no Render key.
    const res = runCli(["ALERT_WEBHOOK_SECRET"]);
    expect(res.status).toBe(rotate.EXIT_REFUSED);
    expect(res.stderr).toMatch(/ALERT_RECEIVER_SYNC_URL/);
    expect(res.stderr).toMatch(/nothing written/);
  });

  it("refuses provider-issued material with the operator's next step", () => {
    expect(rotate.refusalFor("R2_SECRET_ACCESS_KEY")).toMatch(/Cloudflare/);
    expect(rotate.refusalFor("FCM_SERVICE_ACCOUNT_JSON")).toMatch(/rotate-fcm-key\.cjs/);
    expect(rotate.refusalFor("TELEGRAM_BOT_TOKEN")).toMatch(/set-alert-channel\.cjs/);
  });

  it("gives every refusal a substantive reason", () => {
    for (const [name, reason] of Object.entries(rotate.REFUSALS)) {
      expect(reason.length, name).toBeGreaterThan(20);
    }
  });

  it("lists the real targets for an unknown name", () => {
    const reason = rotate.refusalFor("NOT_A_SECRET");
    expect(reason).toMatch(/not a declared core secret/);
    for (const name of Object.keys(rotate.TARGETS)) expect(reason).toContain(name);
  });

  it("cannot be fooled by an Object.prototype key", () => {
    // `name in TARGETS` would answer true for "constructor"/"toString"; the
    // script uses hasOwnProperty, and this is the regression it prevents.
    for (const proto of ["constructor", "toString", "hasOwnProperty"]) {
      expect(rotate.refusalFor(proto), proto).not.toBeNull();
    }
  });

  it("refuses to generate for a non-target instead of inventing a value", () => {
    expect(() => rotate.generateValue("FCM_SERVICE_ACCOUNT_JSON")).toThrow(/rotate-fcm-key\.cjs/);
  });
});

describe("parseArgs", () => {
  it("treats a bare invocation as help, not as a rotation", () => {
    expect(rotate.parseArgs([])).toEqual({ mode: "help", name: null, dryRun: false });
  });

  it("parses one rotation target", () => {
    expect(rotate.parseArgs(["JWT_SECRET"])).toEqual({ mode: "rotate", name: "JWT_SECRET", dryRun: false });
  });

  it("accepts --dry-run before or after the target", () => {
    const expected = { mode: "rotate", name: "OPERATOR_SECRET", dryRun: true };
    expect(rotate.parseArgs(["OPERATOR_SECRET", "--dry-run"])).toEqual(expected);
    expect(rotate.parseArgs(["--dry-run", "OPERATOR_SECRET"])).toEqual(expected);
  });

  it("parses rollback with and without --dry-run", () => {
    expect(rotate.parseArgs(["rollback"])).toEqual({ mode: "rollback", name: null, dryRun: false });
    expect(rotate.parseArgs(["rollback", "--dry-run"])).toEqual({ mode: "rollback", name: null, dryRun: true });
  });

  it("treats --help as help even when a target is present", () => {
    expect(rotate.parseArgs(["--help"])).toEqual({ mode: "help", name: null, dryRun: false });
    expect(rotate.parseArgs(["JWT_SECRET", "--help"])).toEqual({ mode: "help", name: null, dryRun: false });
  });

  it("rejects an unknown flag rather than ignoring it", () => {
    expect(() => rotate.parseArgs(["--nope"])).toThrow(/unknown flag/);
    expect(() => rotate.parseArgs(["JWT_SECRET", "-x"])).toThrow(/unknown flag/);
  });

  it("rejects more than one positional argument", () => {
    expect(() => rotate.parseArgs(["JWT_SECRET", "OPERATOR_SECRET"])).toThrow(/expected one target name/);
  });

  it("treats --dry-run alone as help", () => {
    expect(rotate.parseArgs(["--dry-run"])).toEqual({ mode: "help", name: null, dryRun: false });
  });
});

describe("verifyJwtHmac proves the live server signed with the candidate secret", () => {
  const SECRET = "rotate-test-secret-0123456789";

  it("verifies a real jsonwebtoken-minted HS256 token", () => {
    // Minted by the same library @fastify/jwt uses, so this is a check on the
    // hand-rolled verifier, not on a format this file invented.
    const token = jwt.sign({ sub: "u1", email: "u@example.invalid" }, SECRET, {
      algorithm: "HS256",
      expiresIn: 60,
    });
    expect(rotate.verifyJwtHmac(token, SECRET)).toBe(true);
  });

  it("rejects the same token under any other secret", () => {
    const token = jwt.sign({ sub: "u1", email: "u@example.invalid" }, SECRET, {
      algorithm: "HS256",
      expiresIn: 60,
    });
    expect(rotate.verifyJwtHmac(token, `${SECRET}x`)).toBe(false);
    expect(rotate.verifyJwtHmac(token, SECRET.toUpperCase())).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const token = rotate.buildJwt(SECRET, { sub: "u1", email: "u@example.invalid" });
    const [header, payload, signature] = token.split(".");
    // Mutate the FIRST signature char, not the last: the trailing base64url
    // char can carry unused padding bits that Buffer.from(..., "base64url")
    // drops, so flipping it once in ~16 runs decodes to the same bytes and the
    // "tamper" verifies (observed flake, 2026-10-08). Index 0 is always full
    // data bits, so this tamper is deterministic.
    const tampered = `${signature!.startsWith("A") ? "B" : "A"}${signature!.slice(1)}`;
    expect(rotate.verifyJwtHmac(`${header}.${payload}.${tampered}`, SECRET)).toBe(false);
  });

  it("rejects alg:none tokens, with and without a signature part", () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "u1" })).toString("base64url");
    expect(rotate.verifyJwtHmac(`${header}.${payload}.`, SECRET)).toBe(false);
    expect(rotate.verifyJwtHmac(`${header}.${payload}.${Buffer.from("sig").toString("base64url")}`, SECRET)).toBe(false);
  });

  it("rejects alg:none even when the HMAC part is correct", () => {
    // The header check is what stops a caller being talked into treating a
    // token as HS256 just because the HMAC verifies — otherwise the algorithm
    // field is decoration, and every other check above would still pass.
    const noneHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "u1" })).toString("base64url");
    const correctSignature = createHmac("sha256", SECRET).update(`${noneHeader}.${payload}`).digest("base64url");
    expect(rotate.verifyJwtHmac(`${noneHeader}.${payload}.${correctSignature}`, SECRET)).toBe(false);
  });

  it("rejects a signature of the wrong length instead of throwing", () => {
    const token = rotate.buildJwt(SECRET, { sub: "u1", email: "u@example.invalid" });
    const [header, payload] = token.split(".");
    expect(rotate.verifyJwtHmac(`${header}.${payload}.AAAA`, SECRET)).toBe(false);
  });

  it("round-trips a token the script itself built", () => {
    const token = rotate.buildJwt(SECRET, { sub: "u1", email: "u@example.invalid" });
    expect(token.split(".")).toHaveLength(3);
    expect(rotate.verifyJwtHmac(token, SECRET)).toBe(true);
  });

  it("rejects an empty secret and malformed input without throwing", () => {
    const token = rotate.buildJwt(SECRET, { sub: "u1", email: "u@example.invalid" });
    expect(rotate.verifyJwtHmac(token, "")).toBe(false);
    expect(rotate.verifyJwtHmac("", SECRET)).toBe(false);
    expect(rotate.verifyJwtHmac("not-a-token", SECRET)).toBe(false);
    expect(rotate.verifyJwtHmac("a.b", SECRET)).toBe(false);
    expect(rotate.verifyJwtHmac("..", SECRET)).toBe(false);
  });

  it("refuses an empty secret outright, even for a token built with it", () => {
    // Without the explicit guard this verifies true: an unset JWT_SECRET
    // would then accept tokens anyone can mint.
    const token = rotate.buildJwt("", { sub: "u1", email: "u@example.invalid" });
    expect(rotate.verifyJwtHmac(token, "")).toBe(false);
  });

  it("uses the shared core-secrets rotation account for rollback", () => {
    // staging/rotate-core-secrets.cjs writes the same account; the two scripts
    // must be able to roll back each other's rotations.
    expect(rotate.ROLLBACK_ACCOUNT).toBe("core-secrets-rotation-backup");
  });
});

describe("the alert probe cannot pass against a placeholder receiver", () => {
  // This is what the old blanket refusal was really protecting against: a
  // rotation that printed VERIFIED because the probe ran against a URL that
  // cannot tell the old value from the new one. With a real receiver the
  // refusal moved to the sync preflight, and the placeholder case has to fail
  // loudly here instead.
  const values = { accepted: "a".repeat(43), rejected: "b".repeat(43) };

  it("fails the check when ALERT_WEBHOOK_URL is empty", async () => {
    const outcome = await rotate.verifyAlertWebhook({ ...values, env: {} });
    expect(outcome.checks[0]?.ok).toBe(false);
  });

  it("fails the check when ALERT_WEBHOOK_URL is still a placeholder host", async () => {
    for (const url of ["https://receiver.example.com/hook", "http://example.org/hook"]) {
      const outcome = await rotate.verifyAlertWebhook({ ...values, env: { ALERT_WEBHOOK_URL: url } });
      expect(outcome.checks[0]?.ok, url).toBe(false);
      expect(outcome.checks[0]?.label, url).toMatch(/real receiver/);
    }
  });

  it("always produces an observation, so the outcome can never be silently empty", async () => {
    const outcome = await rotate.verifyAlertWebhook({ ...values, env: {} });
    expect(outcome.checks.length).toBeGreaterThan(0);
  });
});

describe("CLI contract (subprocess; every invocation here is a refusal or a plan)", () => {
  it("prints a plan for --dry-run and exits 0 without touching the network", () => {
    const res = runCli(["--dry-run", "JWT_SECRET"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/would rotate JWT_SECRET/);
    expect(res.stdout).toMatch(/no network calls and no writes/);
    expect(res.stdout).toMatch(/rollback first/);
  });

  it("refuses to run at all when DRY_RUN is set, before any write", () => {
    const res = runCli(["JWT_SECRET"], { DRY_RUN: "1" });
    expect(res.status).toBe(rotate.EXIT_REFUSED);
    expect(res.stderr).toMatch(/REFUSING TO RUN/);
    expect(res.stdout).not.toMatch(/would rotate/);
  });

  it("refuses an unsupported secret with its reason", () => {
    const res = runCli(["FCM_SERVICE_ACCOUNT_JSON"]);
    expect(res.status).toBe(rotate.EXIT_REFUSED);
    expect(res.stderr).toMatch(/REFUSED/);
    expect(res.stderr).toMatch(/rotate-fcm-key\.cjs/);
  });

  it("refuses an unknown name and names the rotatable ones", () => {
    const res = runCli(["NOT_A_SECRET"]);
    expect(res.status).toBe(rotate.EXIT_REFUSED);
    expect(res.stderr).toMatch(/not a declared core secret/);
    for (const name of Object.keys(rotate.TARGETS)) expect(res.stderr).toContain(name);
  });

  it("exits 2 with usage when asked for nothing", () => {
    const res = runCli([]);
    expect(res.status).toBe(rotate.EXIT_REFUSED);
    expect(res.stdout).toMatch(/usage:/);
    expect(res.stdout).toMatch(/refused on purpose/);
  });
});
