/**
 * Guards the Render API key migration out of `.kilo/kilo.jsonc` and off disk.
 *
 * The regression this exists to prevent is concrete and has happened: twelve
 * scripts each open-coded "read the JSONC, strip // comments, drill into
 * mcp.render.environment.RENDER_API_KEY", so one live production credential was
 * spread across twelve call sites and one plaintext config file. It was then
 * moved to `~/.config/dprelay/render-api-key` at 0600 — which keeps other users
 * out and does nothing about backups, sync agents, or a stolen already-unlocked
 * laptop. A future edit that re-adds any one of those reads re-opens the hole.
 *
 * Two layers, deliberately:
 *   - a static scan, which fails the build the moment a script mentions
 *     kilo.jsonc or parses that path again;
 *   - behavioural tests of the shared resolver, because a resolver that is
 *     merely *called* proves nothing about which source it actually prefers.
 *
 * Every behavioural test resolves against a hermetic environment with an empty
 * PATH and no D-Bus address. Without that, a test that expected "no key
 * available" would quietly succeed by reading the developer's real keyring on
 * their own machine — and the suite would pass here and fail on CI.
 *
 * The scan reads source text only. It never reads, parses or prints the key.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir, homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require_ = createRequire(import.meta.url);
const { resolveRenderApiKey } = require_(join(repoRoot, "server/scripts/render-key.cjs")) as {
  resolveRenderApiKey: (opts?: { env?: Record<string, string | undefined> }) => string;
};

/** Every ops script that touches Render, tracked or gitignored alike. */
const READERS = [
  "server/scripts/set-alert-channel.cjs",
  "server/scripts/fcm-wake-probe.cjs",
  "server/scripts/set-production-gates.cjs",
  "server/scripts/provision-production-app.cjs",
  "server/scripts/rotate-secret.cjs",
  "server/scripts/diag-env-shape.cjs",
  "server/scripts/diag-deploy-state.cjs",
  "server/scripts/alert-channel-selftest.ts",
  "staging/render-log-sweep.cjs",
  "staging/rotate-core-secrets.cjs",
  "staging/rotate-fcm-key.cjs",
  "staging/telegram-proof-runner.cjs",
  "staging/telegram-stagecheck.cjs",
];

/**
 * A stand-in credential. Deliberately NOT shaped like a real Render key: the
 * resolver never inspects key shape, so mimicking `rnd_...` would buy nothing
 * and trip the repo's own secret gate (scripts/secret-scan.sh) the moment this
 * file is committed.
 */
const FAKE_KEY = "FAKE-KEY-not-a-credential-0001";
const SAFE_MODE = 0o600;

/** Reads a source file without letting a stack trace swallow the assertion. */
function readSource(rel: string): string {
  return spawnSync(
    process.execPath,
    ["-e", "process.stdout.write(require('node:fs').readFileSync(process.argv[1],'utf8'))", join(repoRoot, rel)],
    { encoding: "utf8" },
  ).stdout;
}

/**
 * Drops docblock and whole-line comments before a substring scan.
 *
 * The resolver documents the kilo.jsonc history in prose, and a scan of raw
 * text punishes it for telling the truth. Only *code* is scanned, so the guard
 * still fails on a reintroduced `readFileSync(".kilo/kilo.jsonc")`.
 *
 * Deliberately conservative: only lines whose first non-space characters are
 * `*` or `//` are dropped. A stripper that hunted for `//` anywhere would also
 * eat the `//` inside a URL string and could hide a real reference.
 */
function codeOnly(src: string): string {
  return src.replace(/^\s*(\*|\/\/).*$/gm, "");
}

describe("no ops script reads the Render key from kilo.jsonc", () => {
  it("finds every expected reader on disk (the scan is not vacuous)", () => {
    for (const rel of READERS) {
      const r = spawnSync(process.execPath, ["-e", `require("node:fs").accessSync(process.argv[1])`, join(repoRoot, rel)], {
        encoding: "utf8",
      });
      expect(r.status, `${rel} is listed in READERS but missing from disk`).toBe(0);
    }
  });

  it("keeps every reader pointed at the shared resolver", () => {
    const offenders: string[] = [];
    for (const rel of READERS) {
      // Match the CALL, not the identifier. A bare `/resolveRenderApiKey/`
      // scan is satisfied by the `const { resolveRenderApiKey } = require(...)`
      // line alone — mutation-proven: replacing the call with a hardcoded value
      // left the require in place and the scan still passed.
      if (!/resolveRenderApiKey\(/.test(readSource(rel))) offenders.push(`${rel} never calls resolveRenderApiKey`);
    }
    expect(offenders).toEqual([]);
  });

  it("mentions kilo.jsonc nowhere, resolver included", () => {
    // The resolver used to keep a legacy kilo.jsonc fallback for "unmigrated"
    // checkouts. Nothing in this repo has shipped a key there since, and the
    // fallback is a silent downgrade to a plaintext copy — precisely the
    // behaviour this migration exists to remove.
    const offenders: string[] = [];
    for (const rel of [...READERS, "server/scripts/render-key.cjs"]) {
      if (codeOnly(readSource(rel)).includes("kilo.jsonc")) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("hardcodes no absolute machine path in any reader", () => {
    // The old code pinned "/home/zia/Documents/..." so a script could only ever
    // run on one machine. repoRoot is now derived from __dirname.
    const offenders: string[] = [];
    for (const rel of READERS) {
      if (codeOnly(readSource(rel)).includes("/home/zia/Documents/My Projects/Authenticator")) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});

describe("resolveRenderApiKey precedence", () => {
  let dir: string;
  let envBackup: Record<string, string | undefined>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "render-key-test-"));
    envBackup = {
      RENDER_API_KEY: process.env.RENDER_API_KEY,
      RENDER_API_KEY_FILE: process.env.RENDER_API_KEY_FILE,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    };
    delete process.env.RENDER_API_KEY;
    delete process.env.RENDER_API_KEY_FILE;
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * An environment that cannot reach any real secret store.
   *
   * Empty PATH means `secret-tool` cannot be spawned at all, so the keyring
   * branch fails with `no-secret-tool` instead of consulting the developer's
   * real keyring. DBUS is unset so the child could not fall back to a bus
   * socket either.
   */
  function hermetic(extra: Record<string, string> = {}): Record<string, string | undefined> {
    return { PATH: join(dir, "no-bin"), ...extra };
  }

  /** Writes a key file with the given content and safe permissions. */
  function keyFile(name: string, content: string): string {
    const p = join(dir, name);
    writeFileSync(p, content);
    chmodSync(p, SAFE_MODE);
    return p;
  }

  it("prefers RENDER_API_KEY over every other source", () => {
    const p = keyFile("render-api-key", "FAKE-KEY-from-file-0003");
    expect(
      resolveRenderApiKey({ env: hermetic({ RENDER_API_KEY: "FAKE-KEY-from-env-0002", RENDER_API_KEY_FILE: p }) }),
    ).toBe("FAKE-KEY-from-env-0002");
  });

  it("reads the file named by RENDER_API_KEY_FILE", () => {
    const p = keyFile("custom-key", `${FAKE_KEY}\n`);
    expect(resolveRenderApiKey({ env: hermetic({ RENDER_API_KEY_FILE: p }) })).toBe(FAKE_KEY);
  });

  it("does not fall back to a plaintext key file in the user's config", () => {
    // The regression this closes: after the 0600 file was the default source, a
    // stray copy in ~/.config/dprelay would satisfy the resolver again.
    const config = join(dir, "config");
    mkdirSync(join(config, "dprelay"), { recursive: true });
    writeFileSync(join(config, "dprelay", "render-api-key"), FAKE_KEY);
    chmodSync(join(config, "dprelay", "render-api-key"), SAFE_MODE);
    expect(() => resolveRenderApiKey({ env: hermetic({ XDG_CONFIG_HOME: config }) })).toThrow();
  });

  it("does not read the legacy kilo.jsonc", () => {
    // An "unmigrated checkout keeps working" fallback is a plaintext downgrade
    // path: it is how a key silently ends up back in a config file.
    mkdirSync(join(dir, ".kilo"));
    writeFileSync(
      join(dir, ".kilo", "kilo.jsonc"),
      `// a comment line that must be stripped\n{"mcp":{"render":{"environment":{"RENDER_API_KEY":"${FAKE_KEY}"}}}}\n`,
    );
    // HOME points at the fixture so a reintroduction shaped like the old
    // fallback (os.homedir() + '.kilo') would actually find the file. Without
    // it the resolver had no way to reach the fixture, the test could not fail,
    // and a passing test that cannot fail is worse than no test at all.
    expect(() => resolveRenderApiKey({ env: hermetic({ HOME: dir }) })).toThrow();
  });

  it("throws naming the keyring and the headless escapes when no source has a key", () => {
    let thrown = "";
    try {
      resolveRenderApiKey({ env: hermetic() });
    } catch (e) {
      thrown = e instanceof Error ? e.message : String(e);
    }
    // The message has to be actionable: an operator hitting this at 2am needs
    // to know the keyring was tried and what the CI substitute is.
    expect(thrown).toMatch(/keyring/i);
    expect(thrown).toMatch(/RENDER_API_KEY_FILE/);
    expect(thrown).toMatch(/RENDER_API_KEY/);
  });

  it("treats an empty key file as absent rather than returning ''", () => {
    // The failure this prevents: an editor truncated the file, the script
    // returned "", and Render answered 401 instead of the operator being told
    // where to put the key.
    const p = keyFile("empty-key", "\n  \n");
    expect(() => resolveRenderApiKey({ env: hermetic({ RENDER_API_KEY_FILE: p }) })).toThrow(/is empty/);
  });

  it("never embeds the key in an error message", () => {
    // The error path is the one most likely to end up pasted into a ticket.
    const p = keyFile("render-api-key", FAKE_KEY);
    chmodSync(p, 0o644);
    let thrown = "";
    try {
      resolveRenderApiKey({ env: hermetic({ RENDER_API_KEY_FILE: p }) });
    } catch (e) {
      thrown = e instanceof Error ? e.message : String(e);
    }
    expect(thrown).not.toContain(FAKE_KEY);
  });

  it("never interpolates a key-bearing value into a thrown message", () => {
    // A behavioural test cannot cover this: with RENDER_API_KEY unset the
    // mutation "leak the key into the error" produced the literal text
    // "key=undefined" and the assertion passed anyway. So this is stated as a
    // static invariant on the resolver's own source — every Error constructor
    // must mention paths, codes and constants, never the values read out of
    // them.
    const src = readSource("server/scripts/render-key.cjs");
    const throws = src.match(/throw new Error\([^;]*?\);/g) ?? [];
    expect(throws.length).toBeGreaterThan(0);
    const SAFE_TO_INTERPOLATE = new Set([
      "file",
      "code",
      "KEY_FILE_ENV",
      "RENDER_KEY_ACCOUNT",
      "err.code",
      "err.message",
    ]);
    for (const t of throws) {
      // An allowlist, not a denylist. A denylist on /key/i flagged
      // KEY_FILE_ENV, which is the NAME of an env var and carries nothing
      // secret — and a test that fails on correct code teaches the reader to
      // ignore it. Everything interpolated into an error must be a path, a
      // status code, or a constant.
      const interpolated = [...t.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1].trim());
      for (const expr of interpolated) {
        expect(
          SAFE_TO_INTERPOLATE.has(expr),
          `error message interpolates unlisted \${${expr}}`,
        ).toBe(true);
      }
    }
  });

  it("warns, but does not fail, when the key file is readable beyond its owner", () => {
    // Refusing outright would break a legitimate shared-box setup over a mode
    // bit; staying silent would make the whole migration cosmetic.
    const p = keyFile("loose-key", FAKE_KEY);
    chmodSync(p, 0o644);
    const stderr: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    // @ts-expect-error — the spy signature is narrower than the real method.
    process.stderr.write = (chunk: string) => {
      stderr.push(String(chunk));
      return true;
    };
    try {
      expect(resolveRenderApiKey({ env: hermetic({ RENDER_API_KEY_FILE: p }) })).toBe(FAKE_KEY);
    } finally {
      process.stderr.write = realWrite;
    }
    expect(stderr.join("")).toMatch(/readable beyond you/);
  });
});

describe("the key store itself", () => {
  it("keeps no plaintext key file on the owner's machine", () => {
    const p = join(homedir(), ".config", "dprelay", "render-api-key");
    expect(existsSync(p), `${p} must not exist — the key lives in the login keyring`).toBe(false);
  });

  it("resolves the real key from the real keyring when one is available", () => {
    // Skipped rather than demanded: on CI there is no session keyring, and the
    // point here is that the owner's machine works, not that everyone's does.
    const probe = spawnSync(
      process.execPath,
      [
        "-e",
        `const { hasSecret } = require(process.argv[1]);
         process.stdout.write(String(hasSecret("render-api-key")));`,
        join(repoRoot, "server/scripts/secret-store.cjs"),
      ],
      { encoding: "utf8" },
    );
    if (probe.status !== 0) return;
    expect(probe.stdout.trim()).toBe("true");
  });
});
