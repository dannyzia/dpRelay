/**
 * Guards the move of three production credentials out of plaintext files and
 * into the login keyring.
 *
 * The regression this exists to prevent is concrete and already happened twice.
 * First the Render key lived inline in `.kilo/kilo.jsonc`, spread across twelve
 * open-coded readers. Then it moved to `~/.config/dprelay/render-api-key` at
 * mode 0600 — which stops other *users* and does nothing about backups, sync
 * agents, the `~` tarball, or a stolen laptop with the session already unlocked.
 * The same pattern put the entire production env (FCM private key included) in
 * `staging/fcm-rotation-backup.json` and the appSecret in
 * `staging/production-app-credentials.json`, both at 0600.
 *
 * Three layers, deliberately:
 *   - the result taxonomy, because "no such secret" and "the keyring is
 *     locked" share an exit code and are told apart only by stderr;
 *   - a stubbed `secret-tool` on PATH, which exercises the real spawn, the real
 *     argv, and the real stdin, so it catches a value leaking into a command
 *     line rather than asserting the source looks right;
 *   - static guards that the plaintext stores stay gone, because the easiest
 *     way to undo all of this is one well-meaning `writeFileSync`.
 *
 * Nothing here touches the real keyring, and no test prints a secret.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir, homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require_ = createRequire(import.meta.url);

type SecretStore = {
  SERVICE: string;
  ACCOUNTS: readonly string[];
  CODES: Record<string, string>;
  accountFor: (name: string) => string;
  sessionBusAddress: (env?: Record<string, string | undefined>) => string | null;
  classifyLookup: (name: string, account: string, result: unknown) => string;
  readSecret: (name: string, opts?: { env?: Record<string, string | undefined> }) => string;
  writeSecret: (name: string, value: string, opts?: { env?: Record<string, string | undefined> }) => void;
  hasSecret: (name: string, opts?: { env?: Record<string, string | undefined> }) => boolean;
  deleteSecret: (name: string, opts?: { env?: Record<string, string | undefined> }) => void;
  SecretStoreError: new (...args: never[]) => Error & { code: string; detail?: string };
};

const store = require_(join(repoRoot, "server/scripts/secret-store.cjs")) as SecretStore;
const { CODES, ACCOUNTS } = store;

/** Stand-ins shaped like secrets but obviously not credentials. */
const FAKE_SCALAR = "FAKE-scalar-not-a-credential-0001";
const FAKE_JSON = '{"private_key":"FAKE-not-a-key-0002","other":"x"}';
/** Trailing and leading whitespace plus an embedded newline: trimming would corrupt this. */
const AWKWARD = "  FAKE-padded-0003\nsecond line  \n";

/**
 * Runs `fn` and reports the `code` of whatever it threw.
 *
 * A `code` is the only assertion worth making about a failure: matching on the
 * prose would make the test fail the moment someone improves a sentence, while
 * the distinction between "missing" and "unreachable" is the whole reason the
 * taxonomy exists.
 */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    const code = (e as { code?: string }).code;
    return code ?? `THREW-WITHOUT-CODE(${String(e)})`;
  }
  return "DID-NOT-THROW";
}

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return "";
}

/** A finished `secret-tool` invocation, as classifyLookup sees it. */
function finished(status: number | null, stdout: string, stderr: string): unknown {
  return { status, stdout, stderr };
}

describe("classifyLookup tells a missing secret from an unreachable keyring", () => {
  // secret-tool reports both with exit 1 and empty stdout. Only stderr separates
  // them, and the difference decides whether the operator unlocks their keyring
  // or goes looking for a credential they never deleted.
  it("treats a silent non-zero exit as a genuine miss", () => {
    expect(codeOf(() => store.classifyLookup("render-api-key", "render-api-key", finished(1, "", "")))).toBe(
      CODES.NOT_FOUND,
    );
  });

  it("treats any stderr on a non-zero exit as an unreachable keyring", () => {
    const err = () =>
      store.classifyLookup(
        "render-api-key",
        "render-api-key",
        finished(1, "", "secret-tool: Could not connect: No such file or directory"),
      );
    expect(codeOf(err)).toBe(CODES.KEYRING_UNAVAILABLE);
    expect(messageOf(err)).toMatch(/unlock your session keyring/);
  });

  it("reports a keyring-unavailable rather than a miss when secret-tool is killed", () => {
    // status is null when a process dies from a signal. Folding that into
    // "not found" would tell an operator to re-create a secret that is fine.
    expect(codeOf(() => store.classifyLookup("render-api-key", "render-api-key", finished(null, "", "")))).toBe(
      CODES.KEYRING_UNAVAILABLE,
    );
  });

  it("distinguishes a stored-but-empty entry from an absent one", () => {
    // Both need operator action, but they are different faults: one is a bad
    // write, the other is a missing secret.
    expect(codeOf(() => store.classifyLookup("render-api-key", "render-api-key", finished(0, "", "")))).toBe(
      CODES.EMPTY,
    );
  });

  it("returns the stored value untouched on success", () => {
    expect(store.classifyLookup("render-api-key", "render-api-key", finished(0, AWKWARD, ""))).toBe(AWKWARD);
  });

  it("prefers the transport diagnosis over the miss diagnosis", () => {
    // The regression a naive `status !== 0 -> not-found` would ship: a locked
    // keyring reported as "your secret is gone".
    const err = () =>
      store.classifyLookup("render-api-key", "render-api-key", finished(1, "", "Timeout was reached"));
    expect(codeOf(err)).toBe(CODES.KEYRING_UNAVAILABLE);
    expect(messageOf(err)).not.toMatch(/no "render-api-key" in the keyring/);
  });
});

describe("sessionBusAddress is derived, never hardcoded", () => {
  it("prefers an address already in the environment", () => {
    expect(
      store.sessionBusAddress({
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/somewhere/explicit",
        XDG_RUNTIME_DIR: "/somewhere/else",
      }),
    ).toBe("unix:path=/somewhere/explicit");
  });

  it("derives the socket from XDG_RUNTIME_DIR when only that is set", () => {
    // The numeric uid differs per machine and per container, which is exactly
    // why this is derived rather than written down.
    expect(store.sessionBusAddress({ XDG_RUNTIME_DIR: "/run/user/4242" })).toBe("unix:path=/run/user/4242/bus");
  });

  it("returns null when nothing can be derived", () => {
    expect(store.sessionBusAddress({})).toBeNull();
  });

  it("treats a blank address as absent", () => {
    expect(store.sessionBusAddress({ DBUS_SESSION_BUS_ADDRESS: "   " })).toBeNull();
  });

  it("names no concrete uid anywhere in the module", () => {
    const src = readFileSync(join(repoRoot, "server/scripts/secret-store.cjs"), "utf8");
    expect(src).not.toMatch(/\/run\/user\/\d+/);
  });
});

describe("accountFor is an allowlist, not a lookup", () => {
  it("accepts every declared account", () => {
    for (const name of ACCOUNTS) expect(store.accountFor(name)).toBe(name);
  });

  it("rejects an unknown name before spawning anything", () => {
    expect(codeOf(() => store.accountFor("not-a-secret"))).toBe(CODES.UNKNOWN_NAME);
    expect(codeOf(() => store.readSecret("not-a-secret"))).toBe(CODES.UNKNOWN_NAME);
  });

  it("covers exactly the four credentials that moved off disk", () => {
    expect([...ACCOUNTS].sort()).toEqual(
      [
        "core-secrets-rotation-backup",
        "fcm-rotation-backup",
        "production-app-credentials",
        "render-api-key",
      ].sort(),
    );
  });
});

describe("round trip through a stubbed secret-tool", () => {
  let dir: string;
  let bin: string;
  let storeDir: string;
  let recordPath: string;

  /**
   * A fake `secret-tool` that mimics the real one's observable behaviour:
   * `store` takes the value on stdin, `lookup` writes it to stdout verbatim
   * and exits 1 *silently* when the account is absent.
   */
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "secret-store-test-"));
    bin = join(dir, "bin");
    storeDir = join(dir, "store");
    recordPath = join(dir, "argv.log");
    mkdirSync(bin);
    mkdirSync(storeDir);

    const stub = `#!/usr/bin/env bash
# The subcommand must be captured before the logging block shifts it off:
# a brace group is not a subshell, so \`shift\` inside it mutates this shell.
cmd="\${1:-}"
{
  printf '%s' "\${1:-}"; shift
  for a in "$@"; do printf '\\t%s' "$a"; done
  printf '\\n'
} >> "$STUB_RECORD"

if [ "\${STUB_MODE:-ok}" = "unreachable" ]; then
  echo "secret-tool: Could not connect: No such file or directory" >&2
  exit 1
fi

case "$cmd" in
  store)
    acct=""; prev=""
    for a in "$@"; do
      if [ "$prev" = "account" ]; then acct="$a"; fi
      prev="$a"
    done
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
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** The environment a call should run under: stub first on PATH, isolated bus. */
  function env(extra: Record<string, string> = {}): Record<string, string | undefined> {
    return {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      STUB_RECORD: recordPath,
      STUB_STORE_DIR: storeDir,
      STUB_MODE: "ok",
      // Never the developer's real bus: a test that could reach the real
      // keyring would be a test that can destroy a real credential.
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/0/bus",
      ...extra,
    };
  }

  /** Every argv line the stub recorded, split back into fields. */
  function recordedArgv(): string[][] {
    if (!existsSync(recordPath)) return [];
    return readFileSync(recordPath, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => l.split("\t"));
  }

  it("reads back exactly what was written", () => {
    store.writeSecret("render-api-key", FAKE_SCALAR, { env: env() });
    expect(store.readSecret("render-api-key", { env: env() })).toBe(FAKE_SCALAR);
  });

  it("round-trips a value with surrounding whitespace byte-for-byte", () => {
    // Trimming would silently corrupt the JSON blobs, which is the larger of
    // the two payloads this store holds.
    store.writeSecret("fcm-rotation-backup", AWKWARD, { env: env() });
    expect(store.readSecret("fcm-rotation-backup", { env: env() })).toBe(AWKWARD);
  });

  it("round-trips a JSON blob so callers can still JSON.parse it", () => {
    store.writeSecret("production-app-credentials", FAKE_JSON, { env: env() });
    expect(JSON.parse(store.readSecret("production-app-credentials", { env: env() }))).toEqual(
      JSON.parse(FAKE_JSON),
    );
  });

  it("never places the value in argv", () => {
    // argv is world-readable through /proc on Linux, so this is the assertion
    // that matters most in the whole file.
    store.writeSecret("render-api-key", FAKE_SCALAR, { env: env() });
    for (const argv of recordedArgv()) {
      expect(argv.join(" ")).not.toContain(FAKE_SCALAR);
    }
  });

  it("addresses the entry with service and account attributes", () => {
    store.writeSecret("render-api-key", FAKE_SCALAR, { env: env() });
    const storeCall = recordedArgv().find((a) => a[0] === "store");
    expect(storeCall).toBeDefined();
    expect(storeCall).toContain("dprelay");
    expect(storeCall).toContain("render-api-key");
    expect(storeCall?.join(" ")).toMatch(/--label=dP Relay render-api-key/);
  });

  it("replaces an existing entry rather than appending", () => {
    store.writeSecret("render-api-key", "FIRST", { env: env() });
    store.writeSecret("render-api-key", "SECOND", { env: env() });
    expect(store.readSecret("render-api-key", { env: env() })).toBe("SECOND");
  });

  it("reports an absent entry as not-found rather than an empty string", () => {
    // Returning "" would hand callers a blank credential and produce an
    // unauthenticated request instead of a clear error.
    expect(codeOf(() => store.readSecret("fcm-rotation-backup", { env: env() }))).toBe(CODES.NOT_FOUND);
    expect(messageOf(() => store.readSecret("fcm-rotation-backup", { env: env() }))).toMatch(
      /secret-tool store/,
    );
  });

  it("reports a locked keyring as unreachable, not as a missing secret", () => {
    store.writeSecret("render-api-key", FAKE_SCALAR, { env: env() });
    const locked = () => store.readSecret("render-api-key", { env: env({ STUB_MODE: "unreachable" }) });
    expect(codeOf(locked)).toBe(CODES.KEYRING_UNAVAILABLE);
  });

  it("reports a missing secret-tool as its own code", () => {
    const noBin = { ...env(), PATH: join(dir, "empty-dir") };
    expect(codeOf(() => store.readSecret("render-api-key", { env: noBin }))).toBe(CODES.NO_TOOL);
    expect(messageOf(() => store.readSecret("render-api-key", { env: noBin }))).toMatch(/libsecret-tools/);
  });

  it("refuses to store a non-string value", () => {
    // Guards against `writeSecret(name, someMaybeUndefined)` persisting the
    // literal string "undefined" as a credential.
    expect(codeOf(() => store.writeSecret("render-api-key", undefined as unknown as string, { env: env() }))).toBe(
      CODES.WRITE_FAILED,
    );
    expect(codeOf(() => store.writeSecret("render-api-key", null as unknown as string, { env: env() }))).toBe(
      CODES.WRITE_FAILED,
    );
  });

  it("never embeds a value in a thrown message", () => {
    store.writeSecret("render-api-key", FAKE_SCALAR, { env: env() });
    const messages = [
      messageOf(() => store.readSecret("render-api-key", { env: env({ STUB_MODE: "unreachable" }) })),
      messageOf(() => store.readSecret("production-app-credentials", { env: env() })),
      messageOf(() => store.writeSecret("render-api-key", 42 as unknown as string, { env: env() })),
    ];
    for (const m of messages) expect(m).not.toContain(FAKE_SCALAR);
  });

  it("hasSecret is false for absent and true for present", () => {
    expect(store.hasSecret("render-api-key", { env: env() })).toBe(false);
    store.writeSecret("render-api-key", FAKE_SCALAR, { env: env() });
    expect(store.hasSecret("render-api-key", { env: env() })).toBe(true);
  });

  it("hasSecret rethrows an unreachable keyring instead of answering false", () => {
    // A boolean cannot distinguish "locked" from "absent", and the caller's
    // remedy differs, so the transport failure has to survive.
    expect(codeOf(() => store.hasSecret("render-api-key", { env: env({ STUB_MODE: "unreachable" }) }))).toBe(
      CODES.KEYRING_UNAVAILABLE,
    );
  });

  it("deleteSecret removes the entry", () => {
    store.writeSecret("fcm-rotation-backup", FAKE_JSON, { env: env() });
    store.deleteSecret("fcm-rotation-backup", { env: env() });
    expect(codeOf(() => store.readSecret("fcm-rotation-backup", { env: env() }))).toBe(CODES.NOT_FOUND);
  });

  it("is safe to read all three declared accounts on a fresh store", () => {
    for (const name of ACCOUNTS) {
      expect(codeOf(() => store.readSecret(name, { env: env() }))).toBe(CODES.NOT_FOUND);
    }
  });
});

describe("the plaintext stores stay gone", () => {
  const GONE = [
    "staging/fcm-rotation-backup.json",
    "staging/production-app-credentials.json",
  ];

  it("has no plaintext file under staging/", () => {
    for (const rel of GONE) {
      expect(existsSync(join(repoRoot, rel)), `${rel} must not exist`).toBe(false);
    }
  });

  it("has no plaintext key file in the user's config", () => {
    // Stated as a contract, not a demand: absent on CI or a fresh machine.
    const p = join(homedir(), ".config", "dprelay", "render-api-key");
    expect(existsSync(p), `${p} must not exist`).toBe(false);
  });

  it("keeps every secret-writing script off disk", () => {
    // The cheapest way to undo this migration is one well-meaning writeFileSync.
    const writers = [
      "server/scripts/render-key.cjs",
      "server/scripts/secret-store.cjs",
      "server/scripts/provision-production-app.cjs",
      "server/scripts/rotate-secret.cjs",
      "staging/rotate-fcm-key.cjs",
    ];
    for (const rel of writers) {
      const src = readFileSync(join(repoRoot, rel), "utf8");
      expect(src, `${rel} must not write a secret to disk`).not.toMatch(/writeFileSync/);
    }
  });

  it("names no retired plaintext path anywhere in the scripts", () => {
    const files = [
      "server/scripts/render-key.cjs",
      "server/scripts/secret-store.cjs",
      "server/scripts/provision-production-app.cjs",
      "server/scripts/rotate-secret.cjs",
      "server/scripts/verify-otp-contract.cjs",
      "staging/rotate-fcm-key.cjs",
    ];
    for (const rel of files) {
      const src = readFileSync(join(repoRoot, rel), "utf8");
      // Comments are allowed to name the retired path so the history is legible.
      const code = src.replace(/^\s*(\*|\/\/).*$/gm, "");
      expect(code, `${rel} still references a retired plaintext path`).not.toMatch(
        /fcm-rotation-backup\.json|production-app-credentials\.json|\.config.dprelay/,
      );
    }
  });

  it("leaves no absolute machine path in any secret-reading script", () => {
    // verify-otp-contract.cjs used to hardcode /home/zia/... for the credentials
    // file, so it only ran on one machine.
    const files = [
      "server/scripts/secret-store.cjs",
      "server/scripts/render-key.cjs",
      "server/scripts/rotate-secret.cjs",
      "server/scripts/verify-otp-contract.cjs",
      "server/scripts/provision-production-app.cjs",
      "staging/rotate-fcm-key.cjs",
    ];
    for (const rel of files) {
      const src = readFileSync(join(repoRoot, rel), "utf8");
      expect(src, `${rel} hardcodes a machine path`).not.toContain(
        "/home/zia/Documents/My Projects/Authenticator",
      );
    }
  });
});

describe("account literals cannot drift out of the allowlist", () => {
  /**
   * Each call site names its account as a literal, because a shell wrapper and
   * a .cjs module cannot share a constant. This is what keeps those copies
   * honest: a renamed account fails here instead of silently reading nothing.
   */
  const LITERALS: Array<{ file: string; pattern: RegExp }> = [
    {
      file: "server/scripts/render-key.cjs",
      pattern: /const RENDER_KEY_ACCOUNT = '([^']+)'/,
    },
    {
      file: "staging/rotate-fcm-key.cjs",
      pattern: /const backupSecret = "([^"]+)"/,
    },
    {
      file: "server/scripts/provision-production-app.cjs",
      pattern: /const CREDENTIALS_ACCOUNT = "([^"]+)"/,
    },
    {
      file: "server/scripts/verify-otp-contract.cjs",
      pattern: /const CREDENTIALS_ACCOUNT = "([^"]+)"/,
    },
    {
      // The pre-rotation values of the four admin-plane secrets used to be a
      // 0600 file at staging/secrets-rotation-backup-2026-10-03.json — a
      // plaintext master-key dump. It is a keyring account now.
      file: "staging/rotate-core-secrets.cjs",
      pattern: /const ROLLBACK_ACCOUNT = "([^"]+)"/,
    },
    {
      // The same account, now also written per-secret by the on-demand
      // rotator — the single-quoted declaration is what keeps the two scripts
      // rolling back each other's work instead of drifting to different keys.
      file: "server/scripts/rotate-secret.cjs",
      pattern: /const ROLLBACK_ACCOUNT = '([^']+)'/,
    },
  ];

  it("matches every declared account at least once", () => {
    const found = new Set<string>();
    for (const { file, pattern } of LITERALS) {
      const src = readFileSync(join(repoRoot, file), "utf8");
      const m = src.match(pattern);
      expect(m, `${file} no longer declares its account with the expected form`).not.toBeNull();
      found.add(m![1]!);
    }
    for (const account of ACCOUNTS) {
      expect([...found].includes(account), `no call site declares "${account}"`).toBe(true);
    }
    // And the other direction: a literal that has drifted to a name no longer
    // in ACCOUNTS must fail here, not silently read nothing at runtime.
    for (const account of found) {
      expect(ACCOUNTS, `"${account}" is declared by a call site but absent from ACCOUNTS`).toContain(account);
    }
  });

  it("keeps the bash MCP wrapper on a declared account", () => {
    const wrapper = join(homedir(), ".local", "bin", "render-mcp-server-keyed");
    if (!existsSync(wrapper)) return; // absent on CI or a fresh machine
    const src = readFileSync(wrapper, "utf8");
    const m = src.match(/KEYRING_ACCOUNT="([^"]+)"/);
    expect(m).not.toBeNull();
    expect(ACCOUNTS).toContain(m![1]);
    expect(src).toMatch(/KEYRING_SERVICE="dprelay"/);
  });
});
