/**
 * Guards `server/scripts/keyring-backup.cjs` — the encrypted bundle that makes a
 * machine rebuild survivable.
 *
 * The properties worth pinning, in the order they matter:
 *
 *   - The bundle is ciphertext. The whole reason the file is encrypted is that
 *     a backup is the one artifact designed to be copied and kept, which is
 *     exactly where the 0600-plaintext files this repo already removed would
 *     have leaked. So the assertion is on the bytes actually written to disk,
 *     not on the code that writes them.
 *   - A wrong passphrase writes nothing. Restore authenticates before it
 *     touches the keyring, so a mistyped passphrase cannot leave a half-built
 *     store that no script expects.
 *   - The manifest is authenticated. Account names are readable without the
 *     passphrase, so an attacker could otherwise rewrite that list. It is bound
 *     as GCM additionalAuthenticatedData; changing it must break the bundle.
 *   - Restore refuses to overwrite a live credential without --force.
 *   - `core-secrets-rotation-backup` is never bundled. It is itself a snapshot
 *     of other secrets; including it would put eight credentials behind one
 *     passphrase to preserve a rollback path that should not outlive its
 *     rotation.
 *   - Nothing anywhere prints a value or accepts a passphrase on argv.
 *
 * Every keyring-touching assertion spawns the real CLI against a stubbed
 * `secret-tool`, with a PATH that contains only the stub and a bus address that
 * does not exist. Nothing here can reach a real keyring, and no test prints a
 * secret. The in-process block at the end covers only pure crypto, which reads
 * no keyring and touches no file.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync, statSync, chmodSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require_ = createRequire(import.meta.url);

type BackupTool = {
  EXIT_OK: number;
  EXIT_FAILED: number;
  EXIT_REFUSED: number;
  FORMAT: string;
  FORMAT_VERSION: number;
  BUNDLE_ACCOUNTS: readonly string[];
  BUNDLE_PATH_ENV: string;
  MODES: readonly string[];
  BackupError: new (...args: never[]) => Error;
  defaultBundlePath: (env?: Record<string, string | undefined>) => string;
  parseArgs: (argv: string[]) => {
    mode: string;
    inPath: string | null;
    outPath: string | null;
    force: boolean;
    allowMissing: boolean;
  };
  additionalDataFor: (envelope: Record<string, unknown>) => Buffer;
  sealBundle: (entries: Record<string, string>, passphrase: string) => Record<string, unknown>;
  openBundle: (envelope: Record<string, unknown>, passphrase: string) => { service: string; entries: Record<string, string> };
  validatePayload: (
    payload: { service: string; entries: Record<string, string> },
    envelope: { accounts: string[] },
  ) => string[];
  main: (argv: string[]) => number;
};

const store = require_(join(repoRoot, "server/scripts/secret-store.cjs")) as { ACCOUNTS: readonly string[]; SERVICE: string };
const tool = require_(join(repoRoot, "server/scripts/keyring-backup.cjs")) as BackupTool;

const CLI_PATH = join(repoRoot, "server/scripts/keyring-backup.cjs");

/** Recognisable in any leak, but obviously not a credential. */
const RENDER_VALUE = "SENTINEL-render-key-not-a-credential-1111";
const APP_VALUE = "SENTINEL-appsecret-not-a-credential-2222";
const FCM_VALUE = '{"private_key":"SENTINEL-fcm-private-key-3333","other":"x"}';
const ROLLBACK_VALUE = "SENTINEL-rollback-not-a-credential-4444";

/** Every bundled value, so "no value appears in the file" is one assertion. */
const ALL_VALUES = [RENDER_VALUE, APP_VALUE, FCM_VALUE, ROLLBACK_VALUE];

const PASSPHRASE = "correct horse battery staple";

/** A passphrase with a trailing newline, which is how every pipe adds one. */
const PASSPHRASE_WITH_NEWLINE = `${PASSPHRASE}\n`;

describe("keyring-backup", () => {
  let dir: string;
  let bin: string;
  let storeDir: string;
  let bundlePath: string;

  /**
   * One backup, reused as a fixture by every test whose subject is `verify` or
   * `restore` rather than `backup`.
   *
   * scrypt at N=2^15 costs ~250ms and this file drives the real CLI as a
   * subprocess, so re-running `backup` as setup in nine tests dominated the
   * whole suite. The bytes are copied per test into that test's own directory,
   * so nothing is shared but the immutable content — and the content is
   * identical because `beforeEach` seeds the same values every time. The backup
   * path itself is still covered on its own terms by the tests that assert it.
   */
  let fixtureBundle: string | null = null;

  /**
   * A fake `secret-tool`, with two failure shapes that need different defences:
   *
   *   fail-write    `store` exits non-zero. Restore stops at the write, loudly.
   *   silent-store  `store` exits 0 but discards the value. Nothing upstream can
   *                 notice — only reading the entry back catches it, which is
   *                 exactly what the read-back in restore is for.
   */
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keyring-backup-test-"));
    bin = join(dir, "bin");
    storeDir = join(dir, "store");
    bundlePath = join(dir, "backup", "keyring-backup.json.enc");
    mkdirSync(bin);
    mkdirSync(storeDir);
    mkdirSync(dirname(bundlePath));

    const stub = `#!/usr/bin/env bash
cmd="\${1:-}"
if [ "\${STUB_MODE:-ok}" = "unreachable" ]; then
  echo "secret-tool: Could not connect: No such file or directory" >&2
  exit 1
fi
case "$cmd" in
  store)
    acct="\${!#}"
    if [ "\${STUB_MODE:-ok}" = "fail-write" ]; then
      echo "secret-tool: cannot store" >&2
      exit 1
    fi
    if [ "\${STUB_MODE:-ok}" = "silent-store" ]; then
      cat > /dev/null
      exit 0
    fi
    cat > "$STUB_STORE_DIR/$acct"
    exit 0
    ;;
  lookup)
    acct="\${!#}"
    if [ -f "$STUB_STORE_DIR/$acct" ]; then cat "$STUB_STORE_DIR/$acct"; exit 0; fi
    exit 1
    ;;
  clear)
    acct="\${!#}"; rm -f "$STUB_STORE_DIR/$acct"; exit 0
    ;;
esac
exit 64
`;
    writeFileSync(join(bin, "secret-tool"), stub, { mode: 0o755 });

    // A fully populated keyring is the starting point for most tests.
    seedStored("render-api-key", RENDER_VALUE);
    seedStored("production-app-credentials", APP_VALUE);
    seedStored("fcm-rotation-backup", FCM_VALUE);
    seedStored("core-secrets-rotation-backup", ROLLBACK_VALUE);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seedStored(account: string, value: string): void {
    writeFileSync(join(storeDir, account), value);
  }

  /** The environment the CLI runs under: stub first on PATH, isolated bus. */
  function env(extra: Record<string, string> = {}): Record<string, string> {
    return {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      STUB_STORE_DIR: storeDir,
      STUB_MODE: "ok",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/0/bus",
      HOME: dir,
      XDG_CONFIG_HOME: join(dir, "xdg"),
      ...extra,
    };
  }

  /** Runs the real CLI as a subprocess with the passphrase on stdin. */
  function run(args: string[], opts: { passphrase?: string; env?: Record<string, string> } = {}) {
    return spawnSync(process.execPath, [CLI_PATH, ...args], {
      encoding: "utf8",
      input: opts.passphrase === undefined ? "" : opts.passphrase,
      env: opts.env ?? env(),
    });
  }

  /** Removes every entry, simulating a freshly rebuilt machine. */
  function wipeKeyring(): void {
    for (const account of store.ACCOUNTS) rmSync(join(storeDir, account), { force: true });
  }

  /** Any half-written temp file the tool failed to clean up beside `file`. */
  function tempFilesBeside(file: string): string[] {
    return readdirSync(dirname(file)).filter((f) => f.includes(".tmp-"));
  }

  /** Puts a valid, decryptable bundle at bundlePath for this test to work with. */
  function seedBundle(): string {
    if (fixtureBundle === null) {
      const scratch = join(dir, "fixture.json.enc");
      const res = run(["backup", "--out", scratch], { passphrase: PASSPHRASE });
      expect(res.status, `fixture backup failed: ${res.stderr}`).toBe(tool.EXIT_OK);
      fixtureBundle = readFileSync(scratch, "utf8");
    }
    writeFileSync(bundlePath, fixtureBundle, { mode: 0o600 });
    return bundlePath;
  }

  /** Reads back what the stub keyring currently holds. */
  function stored(account: string): string | null {
    const file = join(storeDir, account);
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  }

  // -------------------------------------------------------------- backup ---

  it("writes a bundle that contains no credential value in the clear", () => {
    const res = run(["backup", "--out", bundlePath], { passphrase: PASSPHRASE });

    expect(res.status).toBe(tool.EXIT_OK);
    const onDisk = readFileSync(bundlePath, "utf8");
    for (const value of ALL_VALUES) {
      expect(onDisk).not.toContain(value);
    }
    // The manifest is readable on purpose, so an operator can see what the
    // bundle claims to hold. What must not be readable is any credential.
    expect(JSON.parse(onDisk)).toMatchObject({ format: tool.FORMAT, cipher: "aes-256-gcm" });
  });

  it("never bundles the rollback snapshot", () => {
    // `core-secrets-rotation-backup` is itself a backup of four other secrets.
    // Backing up a backup doubles the credential count behind one passphrase.
    const res = run(["backup", "--out", bundlePath], { passphrase: PASSPHRASE });

    expect(res.status).toBe(tool.EXIT_OK);
    const envelope = JSON.parse(readFileSync(bundlePath, "utf8"));
    expect(envelope.accounts).not.toContain("core-secrets-rotation-backup");
    expect(envelope.accounts.sort()).toEqual([...tool.BUNDLE_ACCOUNTS].sort());
    // And the value never reaches the file at all.
    expect(readFileSync(bundlePath, "utf8")).not.toContain(ROLLBACK_VALUE);
  });

  it("writes the bundle at mode 0600 rather than trusting the umask", () => {
    // writeFileSync's mode is masked by umask, so a umask of 022 would leave
    // ciphertext world-readable. The passphrase is the primary control, but
    // the file should still be nobody else's business. This runs a real backup
    // rather than reusing the fixture, because the fixture is written by the
    // test and would assert the test's own mode.
    const res = run(["backup", "--out", bundlePath], { passphrase: PASSPHRASE });

    expect(res.status).toBe(tool.EXIT_OK);
    expect(statSync(bundlePath).mode & 0o777).toBe(0o600);
  });

  it("refuses to back up a partial keyring, because a partial bundle looks complete", () => {
    rmSync(join(storeDir, "fcm-rotation-backup"), { force: true });

    const res = run(["backup", "--out", bundlePath], { passphrase: PASSPHRASE });

    expect(res.status).toBe(tool.EXIT_REFUSED);
    expect(res.stderr).toContain("fcm-rotation-backup");
    expect(res.stderr).toContain("--allow-missing");
    expect(existsSync(bundlePath)).toBe(false);
  });

  it("backs up the accounts that exist when --allow-missing is given", () => {
    rmSync(join(storeDir, "fcm-rotation-backup"), { force: true });

    const res = run(["backup", "--out", bundlePath, "--allow-missing"], { passphrase: PASSPHRASE });

    expect(res.status).toBe(tool.EXIT_OK);
    expect(res.stderr).toContain("WARNING");
    const envelope = JSON.parse(readFileSync(bundlePath, "utf8"));
    expect(envelope.accounts).not.toContain("fcm-rotation-backup");
    expect(envelope.accounts).toContain("render-api-key");
  });

  it("accepts a passphrase that arrived with a trailing newline", () => {
    // Every way of piping a passphrase adds one, and a passphrase with a
    // trailing newline is a lockout nobody could diagnose.
    const res = run(["backup", "--out", bundlePath], { passphrase: PASSPHRASE_WITH_NEWLINE });

    expect(res.status).toBe(tool.EXIT_OK);
    expect(run(["verify", "--in", bundlePath], { passphrase: PASSPHRASE }).status).toBe(tool.EXIT_OK);
  });

  it("refuses an empty passphrase rather than making the bundle readable to anyone", () => {
    const res = run(["backup", "--out", bundlePath], { passphrase: "\n" });

    expect(res.status).toBe(tool.EXIT_REFUSED);
    expect(res.stderr).toContain("blank-passphrase");
    expect(existsSync(bundlePath)).toBe(false);
  });

  it("leaves a previous good bundle intact when a new backup fails", () => {
    // The temp-file-then-rename write exists for exactly this: an interrupted
    // run must not take the last known-good backup with it.
    seedBundle();
    const good = readFileSync(bundlePath, "utf8");

    const res = run(["backup", "--out", bundlePath], { passphrase: "" });

    expect(res.status).toBe(tool.EXIT_REFUSED);
    expect(readFileSync(bundlePath, "utf8")).toBe(good);
    expect(tempFilesBeside(bundlePath)).toEqual([]);
  });

  it("leaves the previous bundle intact when the write itself fails", () => {
    // The failure arrives at the filesystem rather than at argument checking,
    // which is the case an atomic write is actually for.
    seedBundle();
    const good = readFileSync(bundlePath, "utf8");
    const parent = dirname(bundlePath);
    chmodSync(parent, 0o500);

    let res: ReturnType<typeof run>;
    try {
      res = run(["backup", "--out", bundlePath], { passphrase: PASSPHRASE });
    } finally {
      chmodSync(parent, 0o700);
    }

    expect(res.status).toBe(tool.EXIT_FAILED);
    expect(res.stderr).toContain("write-failed");
    expect(readFileSync(bundlePath, "utf8")).toBe(good);
    expect(tempFilesBeside(bundlePath)).toEqual([]);
  });

  it("replaces the bundle by rename, so it never opens the old file for writing", () => {
    // The discriminator between temp+rename and writing the destination
    // directly: a destination at mode 0444 cannot be opened for writing, but on
    // Linux rename() over it succeeds because the containing directory is the
    // permission boundary. A bundle that arrived read-only from a transfer
    // should not then block every refresh.
    seedBundle();
    const first = readFileSync(bundlePath, "utf8");
    chmodSync(bundlePath, 0o444);

    const res = run(["backup", "--out", bundlePath], { passphrase: PASSPHRASE });

    expect(res.status).toBe(tool.EXIT_OK);
    // A fresh salt and IV mean the ciphertext differs, so this really replaced it.
    expect(readFileSync(bundlePath, "utf8")).not.toBe(first);
    expect(tempFilesBeside(bundlePath)).toEqual([]);
  });

  it("never accepts the passphrase as an argument", () => {
    const res = run(["backup", "--out", bundlePath, PASSPHRASE], { passphrase: "" });

    expect(res.status).toBe(tool.EXIT_REFUSED);
    expect(existsSync(bundlePath)).toBe(false);
  });

  // -------------------------------------------------------------- verify ---

  it("verifies a bundle and reports names and lengths without printing values", () => {
    seedBundle();

    const res = run(["verify", "--in", bundlePath], { passphrase: PASSPHRASE });

    expect(res.status).toBe(tool.EXIT_OK);
    for (const account of tool.BUNDLE_ACCOUNTS) {
      expect(res.stdout).toContain(account);
    }
    expect(res.stdout).toContain(`${Buffer.byteLength(RENDER_VALUE, "utf8")} bytes`);
    for (const value of ALL_VALUES) {
      expect(res.stdout).not.toContain(value);
      expect(res.stderr).not.toContain(value);
    }
  });

  it("fails verification with the wrong passphrase and says it cannot tell why", () => {
    seedBundle();

    const res = run(["verify", "--in", bundlePath], { passphrase: "not the passphrase" });

    expect(res.status).toBe(tool.EXIT_FAILED);
    expect(res.stderr).toContain("wrong-passphrase-or-damaged");
    // Claiming to know which of the two it was would be a guess, and a wrong
    // guess sends the operator re-typing a passphrase that was always correct.
    expect(res.stderr).toContain("either the passphrase is wrong or the file is damaged");
  });

  // ------------------------------------------------------------- restore ---

  it("rebuilds a wiped keyring from a bundle in one step", () => {
    seedBundle();
    wipeKeyring();

    const res = run(["restore", "--in", bundlePath], { passphrase: PASSPHRASE });

    expect(res.status).toBe(tool.EXIT_OK);
    expect(stored("render-api-key")).toBe(RENDER_VALUE);
    expect(stored("production-app-credentials")).toBe(APP_VALUE);
    // Byte-for-byte: the FCM payload is JSON with a private key in it, and a
    // trailing newline or a trim would corrupt it.
    expect(stored("fcm-rotation-backup")).toBe(FCM_VALUE);
    for (const value of [RENDER_VALUE, APP_VALUE, FCM_VALUE]) {
      expect(res.stderr).not.toContain(value);
    }
  });

  it("restores nothing extra: the excluded account stays absent", () => {
    seedBundle();
    wipeKeyring();

    run(["restore", "--in", bundlePath], { passphrase: PASSPHRASE });

    expect(stored("core-secrets-rotation-backup")).toBeNull();
  });

  it("refuses to overwrite a live credential unless --force is given", () => {
    seedBundle();
    const rotated = "SENTINEL-rotated-after-backup-5555";
    seedStored("render-api-key", rotated);

    const refused = run(["restore", "--in", bundlePath], { passphrase: PASSPHRASE });

    expect(refused.status).toBe(tool.EXIT_REFUSED);
    expect(refused.stderr).toContain("overwrite-refused");
    expect(refused.stderr).toContain("render-api-key");
    // The live credential is untouched, and nothing else was written either.
    expect(stored("render-api-key")).toBe(rotated);
    expect(stored("production-app-credentials")).toBe(APP_VALUE);

    const forced = run(["restore", "--in", bundlePath, "--force"], { passphrase: PASSPHRASE });

    expect(forced.status).toBe(tool.EXIT_OK);
    expect(stored("render-api-key")).toBe(RENDER_VALUE);
  });

  it("writes nothing when the passphrase is wrong", () => {
    seedBundle();
    wipeKeyring();

    const res = run(["restore", "--in", bundlePath], { passphrase: "not the passphrase" });

    expect(res.status).toBe(tool.EXIT_FAILED);
    for (const account of store.ACCOUNTS) {
      expect(stored(account)).toBeNull();
    }
  });

  it("writes nothing when the manifest has been tampered with", () => {
    // Account names are readable without the passphrase, so without AAD an
    // attacker could rewrite that list. The tag must catch it.
    seedBundle();
    wipeKeyring();
    const envelope = JSON.parse(readFileSync(bundlePath, "utf8"));
    envelope.accounts = ["render-api-key", "core-secrets-rotation-backup"];
    writeFileSync(bundlePath, JSON.stringify(envelope));

    const res = run(["restore", "--in", bundlePath], { passphrase: PASSPHRASE });

    expect(res.status).toBe(tool.EXIT_FAILED);
    expect(res.stderr).toContain("wrong-passphrase-or-damaged");
    expect(stored("render-api-key")).toBeNull();
    expect(stored("core-secrets-rotation-backup")).toBeNull();
  });

  it("refuses a file that is not a bundle rather than half-parsing it", () => {
    writeFileSync(bundlePath, "this is not json");
    wipeKeyring();

    const res = run(["restore", "--in", bundlePath], { passphrase: PASSPHRASE });

    expect(res.status).toBe(tool.EXIT_FAILED);
    expect(res.stderr).toContain("unreadable-bundle");
    expect(stored("render-api-key")).toBeNull();
  });

  it("refuses a bundle written by a newer version", () => {
    seedBundle();
    wipeKeyring();
    const envelope = JSON.parse(readFileSync(bundlePath, "utf8"));
    envelope.version = tool.FORMAT_VERSION + 1;
    writeFileSync(bundlePath, JSON.stringify(envelope));

    const res = run(["restore", "--in", bundlePath], { passphrase: PASSPHRASE });

    expect(res.status).toBe(tool.EXIT_FAILED);
    expect(res.stderr).toContain("unsupported-bundle");
    expect(stored("render-api-key")).toBeNull();
  });

  it("stops loudly when the keyring rejects the write", () => {
    // The easy half of the two: secret-tool exits non-zero, so the write
    // itself throws and there is nothing to verify.
    seedBundle();
    wipeKeyring();

    const res = run(["restore", "--in", bundlePath], { passphrase: PASSPHRASE, env: env({ STUB_MODE: "fail-write" }) });

    expect(res.status).toBe(tool.EXIT_FAILED);
    expect(res.stderr).toContain("write-failed");
    expect(res.stderr).toContain("render-api-key");
  });

  it("reports a write that was acknowledged but did not land", () => {
    // The half that only a read-back can catch: the store exits 0 and keeps
    // nothing. Without the verification loop, restore would report success and
    // leave a keyring with none of these credentials in it.
    seedBundle();
    wipeKeyring();

    const res = run(["restore", "--in", bundlePath], { passphrase: PASSPHRASE, env: env({ STUB_MODE: "silent-store" }) });

    expect(res.status).toBe(tool.EXIT_FAILED);
    expect(res.stderr).toContain("restore-verification-failed");
    expect(res.stderr).toContain("render-api-key");
    expect(res.stderr).not.toContain(RENDER_VALUE);
  });

  it("surfaces an unreachable keyring as a failure", () => {
    const res = run(["backup", "--out", bundlePath], {
      passphrase: PASSPHRASE,
      env: env({ STUB_MODE: "unreachable" }),
    });

    expect(res.status).toBe(tool.EXIT_FAILED);
    expect(res.stderr).toContain("keyring-unavailable");
    expect(existsSync(bundlePath)).toBe(false);
  });

  // ------------------------------------------------------------ refusals ---

  it("refuses an unknown mode and an unknown flag by name", () => {
    const mode = run(["frobnicate"], { passphrase: PASSPHRASE });
    expect(mode.status).toBe(tool.EXIT_REFUSED);
    expect(mode.stderr).toContain('unknown mode "frobnicate"');
    expect(mode.stderr).toContain("backup, verify, restore");

    const flag = run(["backup", "--sideways", "--out", bundlePath], { passphrase: PASSPHRASE });
    expect(flag.status).toBe(tool.EXIT_REFUSED);
    expect(flag.stderr).toContain("unknown flag: --sideways");
  });

  it("refuses a path flag pointing the wrong way", () => {
    // `--out` on a restore would write a bundle nobody asked for; `--in` on a
    // backup would read a bundle and then overwrite the keyring from it.
    const restoreWithOut = run(["restore", "--out", bundlePath], { passphrase: PASSPHRASE });
    expect(restoreWithOut.status).toBe(tool.EXIT_REFUSED);
    expect(restoreWithOut.stderr).toContain("reads with --in");

    const backupWithIn = run(["backup", "--in", bundlePath], { passphrase: PASSPHRASE });
    expect(backupWithIn.status).toBe(tool.EXIT_REFUSED);
    expect(backupWithIn.stderr).toContain("writes with --out");
  });

  it("refuses flags on modes that change nothing", () => {
    const res = run(["verify", "--in", bundlePath, "--force"], { passphrase: PASSPHRASE });

    expect(res.status).toBe(tool.EXIT_REFUSED);
    expect(res.stderr).toContain("--force applies to restore only");
  });

  it("prints usage on --help and refuses a bare invocation", () => {
    const help = run(["--help"], { passphrase: PASSPHRASE });
    expect(help.status).toBe(tool.EXIT_OK);
    expect(help.stderr).toContain("keyring-backup.cjs <mode>");
    for (const account of tool.BUNDLE_ACCOUNTS) {
      expect(help.stderr).toContain(account);
    }
    // The usage must warn about the one failure mode a user cannot debug alone.
    expect(help.stderr).toContain("Losing it loses the backup but not the keyring");
    // And must say the exclusion, so its absence is not mistaken for a bug.
    expect(help.stderr).not.toContain("core-secrets-rotation-backup");

    const bare = run([], { passphrase: PASSPHRASE });
    expect(bare.status).toBe(tool.EXIT_REFUSED);
    expect(bare.stderr).toContain("Usage:");
  });

  it("maps the three exit codes to the shared ops contract", () => {
    expect(tool.EXIT_OK).toBe(0);
    expect(tool.EXIT_FAILED).toBe(1);
    expect(tool.EXIT_REFUSED).toBe(2);
  });

  // ------------------------------------------- in-process, no I/O, no keyring ---

  describe("defaultBundlePath is derived, never hardcoded", () => {
    it("prefers the explicit environment variable", () => {
      // An operator's backup belongs wherever it is actually backed up, which
      // differs per machine. The env var is how a scheduled job says so.
      expect(tool.defaultBundlePath({ [tool.BUNDLE_PATH_ENV]: "/srv/offsite/keyring.enc" })).toBe("/srv/offsite/keyring.enc");
    });

    it("falls back to XDG_CONFIG_HOME, then HOME", () => {
      expect(tool.defaultBundlePath({ XDG_CONFIG_HOME: "/home/op/xdg" })).toBe("/home/op/xdg/dprelay/keyring-backup.json.enc");
      expect(tool.defaultBundlePath({ HOME: "/home/op" })).toBe("/home/op/.config/dprelay/keyring-backup.json.enc");
    });

    it("ignores a blank environment variable rather than resolving to the cwd", () => {
      // path.resolve('') is the process cwd, so a blank value would silently
      // drop a bundle in the repository instead of the config directory.
      expect(tool.defaultBundlePath({ [tool.BUNDLE_PATH_ENV]: "  ", HOME: "/home/op" })).toBe(
        "/home/op/.config/dprelay/keyring-backup.json.enc",
      );
    });
  });

  describe("bundle crypto, exercised without a keyring or a file", () => {
    it("round-trips values byte-for-byte and never emits them into the envelope", () => {
      const entries = { "render-api-key": RENDER_VALUE, "fcm-rotation-backup": FCM_VALUE };
      const envelope = tool.sealBundle(entries, PASSPHRASE);

      expect(tool.openBundle(envelope as never, PASSPHRASE)).toEqual({ service: store.SERVICE, entries });
      const serialised = JSON.stringify(envelope);
      for (const value of ALL_VALUES) {
        expect(serialised).not.toContain(value);
      }
    });

    it("uses a fresh salt and IV for every bundle", () => {
      // Reusing either across two bundles of the same passphrase leaks the key
      // stream; identical KDF params in two files are the tell.
      const a = tool.sealBundle({ "render-api-key": RENDER_VALUE }, PASSPHRASE);
      const b = tool.sealBundle({ "render-api-key": RENDER_VALUE }, PASSPHRASE);

      const kdf = a.kdf as { salt: string };
      expect((b.kdf as { salt: string }).salt).not.toBe(kdf.salt);
      expect(b.iv).not.toBe(a.iv);
      expect(b.ciphertext).not.toBe(a.ciphertext);
    });

    it("binds the manifest, version and timestamp as additional data", () => {
      // Account names are readable without the passphrase, so without binding
      // them an attacker could rewrite the manifest. The proof that AAD is what
      // does the work is that each mutation changes the AAD AND breaks auth.
      const envelope = tool.sealBundle({ "render-api-key": RENDER_VALUE }, PASSPHRASE);
      const original = tool.additionalDataFor(envelope as never);

      const mutations: [string, (e: Record<string, unknown>) => void][] = [
        ["accounts", (e) => ((e.accounts as string[]).push("core-secrets-rotation-backup"))],
        ["createdAt", (e) => (e.createdAt = "1999-01-01T00:00:00.000Z")],
        ["version", (e) => (e.version = 99)],
        ["cipher", (e) => (e.cipher = "aes-128-gcm")],
      ];

      for (const [label, mutate] of mutations) {
        const tampered = JSON.parse(JSON.stringify(envelope));
        mutate(tampered);
        expect(tool.additionalDataFor(tampered).equals(original), `${label} must change the AAD`).toBe(false);
        expect(() => tool.openBundle(tampered, PASSPHRASE), label).toThrow();
      }
    });

    it("rejects a flipped ciphertext bit", () => {
      const envelope = tool.sealBundle({ "render-api-key": RENDER_VALUE }, PASSPHRASE);
      const bytes = Buffer.from(String(envelope.ciphertext), "base64");
      bytes[0] ^= 0x01;
      const tampered = { ...envelope, ciphertext: bytes.toString("base64") };

      expect(() => tool.openBundle(tampered, PASSPHRASE)).toThrow();
    });
  });

  describe("validatePayload refuses a payload this build did not write", () => {
    // The subprocess tests can only ever feed restore a payload this tool
    // produced, which authenticates correctly and names known accounts. The
    // checks below are the untrusted-input boundary, so they need hand-built
    // payloads. validatePayload is a pure function over two objects: it reads no
    // keyring and touches no file, so calling it in-process is safe.
    const env = (accounts: string[]) => ({ accounts });

    it("refuses an account outside the store allowlist", () => {
      // Defence in depth behind the authenticated manifest: a store write is
      // not somewhere to discover a surprise account name.
      expect(() =>
        tool.validatePayload(
          { service: store.SERVICE, entries: { "some-other-apps-token": "value" } },
          env(["some-other-apps-token"]),
        ),
      ).toThrow(/does not know/);
    });

    it("refuses a payload addressed to a different libsecret service", () => {
      expect(() =>
        tool.validatePayload({ service: "someotherservice", entries: { "render-api-key": "value" } }, env(["render-api-key"])),
      ).toThrow(/libsecret service/);
    });

    it("refuses an entry that is empty or not a string", () => {
      // An empty entry is the `empty` fault the store reports on read-back, so
      // restoring one would provision a poisoned slot that reports success.
      expect(() =>
        tool.validatePayload({ service: store.SERVICE, entries: { "render-api-key": "" } }, env(["render-api-key"])),
      ).toThrow(/empty or not a string/);
      expect(() =>
        tool.validatePayload(
          { service: store.SERVICE, entries: { "render-api-key": 42 } } as never,
          env(["render-api-key"]),
        ),
      ).toThrow(/empty or not a string/);
    });

    it("refuses an entry the manifest does not list", () => {
      expect(() =>
        tool.validatePayload({ service: store.SERVICE, entries: { "render-api-key": "value" } }, env([])),
      ).toThrow(/not in its manifest/);
    });

    it("refuses a payload with no entries at all", () => {
      // Restoring this would provision an empty keyring and report success.
      expect(() => tool.validatePayload({ service: store.SERVICE, entries: {} }, env([]))).toThrow(/no entries/);
    });

    it("accepts a well-formed payload and returns its account names", () => {
      const entries = { "render-api-key": "value", "fcm-rotation-backup": "blob" };
      expect(tool.validatePayload({ service: store.SERVICE, entries }, env(Object.keys(entries)))).toEqual(Object.keys(entries));
    });
  });

  describe("parseArgs", () => {
    it("requires a value after --in and --out", () => {
      expect(() => tool.parseArgs(["backup", "--out"])).toThrow(/--out needs a path/);
      expect(() => tool.parseArgs(["restore", "--in", "--force"])).toThrow(/--in needs a path/);
    });

    it("resolves paths to absolute ones", () => {
      const parsed = tool.parseArgs(["backup", "--out", "relative/bundle.enc"]);
      expect(parsed.outPath?.startsWith("/")).toBe(true);
      expect(parsed.mode).toBe("backup");
    });

    it("routes --help and a bare invocation to the usage path", () => {
      expect(tool.parseArgs(["--help"]).mode).toBe("help");
      expect(tool.parseArgs(["-h"]).mode).toBe("help");
      expect(tool.parseArgs([]).mode).toBe("help");
    });
  });
});