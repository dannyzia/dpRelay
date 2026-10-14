/**
 * Guards the keyring CLI: `server/scripts/secret-store-cli.cjs`.
 *
 * The CLI exists because provisioning a keyring entry by hand is error-prone and
 * because `secret-tool search` — the obvious way to find out what is stored —
 * prints every value it finds. So the properties worth pinning are:
 *
 *   - `list` reports every allowlisted account and CANNOT print a value. The
 *     stub is seeded with a recognisable sentinel, and every list assertion
 *     checks the sentinel is absent from stdout. That is the regression the CLI
 *     was written to prevent, so it is asserted rather than assumed.
 *   - A value never reaches a command line. The stub records its own argv, and
 *     the test asserts the sentinel appears in the value file (so the stub
 *     really did receive it) but in no recorded argv line. This exercises the
 *     real spawn, so it catches a leak that a source-reading assertion would
 *     miss.
 *   - Exit codes are the shared ops contract: 0 done, 1 failed, 2 refused.
 *   - A refusal never echoes what it refused. `set <name> <value>` is refused
 *     because argv is world-readable through /proc — and the refusal message
 *     must not repeat the value, or the protection is cosmetic.
 *
 * Every test spawns the real script as a subprocess against a stubbed
 * `secret-tool` on PATH. Nothing here touches the real keyring: the stub is
 * first on PATH and DBUS_SESSION_BUS_ADDRESS points at a path that does not
 * exist, so even a bug that reached the real binary could not open a real one.
 * No test prints a secret.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require_ = createRequire(import.meta.url);

type SecretStoreCli = {
  EXIT_OK: number;
  EXIT_FAILED: number;
  EXIT_REFUSED: number;
  COMMANDS: readonly string[];
  SERVICE: string;
  ACCOUNTS: readonly string[];
  RefusalError: new (...args: never[]) => Error;
  parseArgs: (argv: string[]) => { command: string; account: string | null; json: boolean };
  describeAccount: (account: string) => { account: string; state: string; bytes: number; detail: string };
  main: (argv: string[]) => number;
};

const store = require_(join(repoRoot, "server/scripts/secret-store.cjs")) as {
  ACCOUNTS: readonly string[];
};
const cli = require_(join(repoRoot, "server/scripts/secret-store-cli.cjs")) as SecretStoreCli;

const CLI_PATH = join(repoRoot, "server/scripts/secret-store-cli.cjs");

/**
 * A stand-in that must be recognisable in any leak but is not a credential.
 * Every "the value must not appear here" assertion greps for this exact string.
 */
const SENTINEL = "SENTINEL-not-a-credential-zzzz";

/** A second sentinel, for the case where one account's value must not leak into another's row. */
const OTHER_SENTINEL = "OTHER-SENTINEL-not-a-credential-yyyy";

describe("secret-store-cli", () => {
  let dir: string;
  let bin: string;
  let storeDir: string;
  let recordPath: string;

  /**
   * A fake `secret-tool` that mimics the real one's observable behaviour and,
   * crucially, records the argv it was handed. `store` takes the value on stdin
   * (the real tool does too), `lookup` writes the value to stdout verbatim and
   * exits 1 *silently* when the account is absent — the same confusing overlap
   * of exit codes that `classifyLookup` exists to unpick.
   */
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "secret-store-cli-test-"));
    bin = join(dir, "bin");
    storeDir = join(dir, "store");
    recordPath = join(dir, "argv.log");
    mkdirSync(bin);
    mkdirSync(storeDir);

    const stub = `#!/usr/bin/env bash
# Capture the subcommand before the logging block shifts it off: a brace group
# is not a subshell, so \`shift\` inside it mutates this shell.
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

  /** The environment the CLI runs under: stub first on PATH, isolated bus. */
  function env(extra: Record<string, string> = {}): Record<string, string> {
    return {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      STUB_RECORD: recordPath,
      STUB_STORE_DIR: storeDir,
      STUB_MODE: "ok",
      // Never the developer's real bus: a test that could open a real keyring
      // would be a test that could destroy a real credential.
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

  /** Everything the stub was ever handed on a command line, flattened. */
  function argvBlob(): string {
    return recordedArgv().flat().join(" ");
  }

  /** Seeds the stub keyring with a value for one account. */
  function seedStored(account: string, value: string): void {
    writeFileSync(join(storeDir, account), value);
  }

  /** Runs the real CLI as a subprocess. */
  function run(args: string[], opts: { input?: string; env?: Record<string, string> } = {}) {
    return spawnSync(process.execPath, [CLI_PATH, ...args], {
      encoding: "utf8",
      input: opts.input ?? "",
      env: opts.env ?? env(),
    });
  }

  // ---------------------------------------------------------------- list ---

  it("lists every account the store knows, present or not", () => {
    seedStored("render-api-key", SENTINEL);

    const res = run(["list"]);

    expect(res.status).toBe(cli.EXIT_OK);
    for (const account of store.ACCOUNTS) {
      expect(res.stdout).toContain(account);
    }
    expect(res.stdout).toContain("render-api-key\tpresent");
    expect(res.stdout).toContain("production-app-credentials\tabsent");
  });

  it("never prints a stored value, which is the entire point of the command", () => {
    // The regression this file exists for. `secret-tool search` answers the same
    // question by printing every value, which is how credentials end up in
    // scrollback and pasted tickets.
    seedStored("render-api-key", SENTINEL);
    seedStored("production-app-credentials", OTHER_SENTINEL);

    const res = run(["list"]);

    expect(res.status).toBe(cli.EXIT_OK);
    expect(res.stdout).not.toContain(SENTINEL);
    expect(res.stdout).not.toContain(OTHER_SENTINEL);
    expect(res.stderr).not.toContain(SENTINEL);
    expect(res.stderr).not.toContain(OTHER_SENTINEL);
  });

  it("emits machine-readable rows for a script under --json", () => {
    seedStored("render-api-key", SENTINEL);

    const res = run(["list", "--json"]);

    expect(res.status).toBe(cli.EXIT_OK);
    const parsed = JSON.parse(res.stdout) as {
      service: string;
      entries: { account: string; state: string; bytes: number }[];
    };
    expect(parsed.service).toBe(cli.SERVICE);
    expect(parsed.entries.map((e) => e.account).sort()).toEqual([...store.ACCOUNTS].sort());
    const render = parsed.entries.find((e) => e.account === "render-api-key");
    expect(render?.state).toBe("present");
    // The length is the diagnostic value here — it catches a truncated write.
    expect(render?.bytes).toBe(Buffer.byteLength(SENTINEL, "utf8"));
    expect(res.stdout).not.toContain(SENTINEL);
  });

  it("fails the list rather than reporting a partial answer as complete", () => {
    // Every account is `error`, so there is no useful answer. Exit 1 says so.
    const res = run(["list"], { env: env({ STUB_MODE: "unreachable" }) });

    expect(res.status).toBe(cli.EXIT_FAILED);
    expect(res.stderr).toContain("could not be checked");
    for (const account of store.ACCOUNTS) {
      expect(res.stderr).toContain(account);
    }
  });

  // ----------------------------------------------------------------- get ---

  it("writes the stored value to stdout for piping", () => {
    seedStored("render-api-key", SENTINEL);

    const res = run(["get", "render-api-key"]);

    expect(res.status).toBe(cli.EXIT_OK);
    expect(res.stdout).toBe(SENTINEL);
  });

  it("preserves surrounding whitespace byte-for-byte, because two of the four accounts hold JSON", () => {
    // secret-store.cjs goes out of its way not to trim. A CLI that added a
    // newline or trimmed the tail would corrupt `fcm-rotation-backup` silently.
    const padded = `  ${SENTINEL}\nsecond line  \n`;
    seedStored("fcm-rotation-backup", padded);

    const res = run(["get", "fcm-rotation-backup"]);

    expect(res.status).toBe(cli.EXIT_OK);
    expect(res.stdout).toBe(padded);
  });

  it("fails with the typed not-found message rather than an empty success", () => {
    const res = run(["get", "render-api-key"]);

    expect(res.status).toBe(cli.EXIT_FAILED);
    expect(res.stderr).toContain("not-found");
    expect(res.stdout).toBe("");
  });

  it("points a missing secret back at this tool instead of a hand-typed secret-tool line", () => {
    // The store's message ends with the raw `secret-tool store` command, which
    // is right for a library caller and wrong here: the whole reason this file
    // exists is that nobody should have to hand-assemble one.
    const res = run(["get", "render-api-key"]);

    expect(res.stderr).toContain("create it with this tool");
    expect(res.stderr).toContain("--help");
  });

  // ----------------------------------------------------------------- set ---

  it("stores a value piped on stdin", () => {
    const res = run(["set", "render-api-key"], { input: SENTINEL });

    expect(res.status).toBe(cli.EXIT_OK);
    expect(readFileSync(join(storeDir, "render-api-key"), "utf8")).toBe(SENTINEL);
  });

  it("never puts the value on a command line", () => {
    // argv is world-readable through /proc on Linux, so this is the property
    // that makes the keyring worth having at all.
    run(["set", "render-api-key"], { input: SENTINEL });

    // The stub did receive the value — otherwise this assertion would pass for
    // the wrong reason, which is the usual failure mode of a "no leak" test.
    expect(readFileSync(join(storeDir, "render-api-key"), "utf8")).toBe(SENTINEL);
    expect(argvBlob()).not.toContain(SENTINEL);
    expect(recordedArgv().some((line) => line[0] === "store")).toBe(true);
  });

  it("confirms a store without echoing the value", () => {
    const res = run(["set", "render-api-key"], { input: SENTINEL });

    expect(res.stderr).toContain("render-api-key");
    expect(res.stderr).toContain(`${Buffer.byteLength(SENTINEL, "utf8")} bytes`);
    expect(res.stderr).not.toContain(SENTINEL);
    expect(res.stdout).toBe("");
  });

  it("replaces an existing value rather than refusing", () => {
    seedStored("render-api-key", "OLD-not-a-credential-aaaa");

    const res = run(["set", "render-api-key"], { input: SENTINEL });

    expect(res.status).toBe(cli.EXIT_OK);
    expect(readFileSync(join(storeDir, "render-api-key"), "utf8")).toBe(SENTINEL);
  });

  it("refuses a value passed as an argument, and does not repeat it while refusing", () => {
    // `set <name> <value>` is the exact spelling that leaks through /proc. The
    // refusal must name the fix without quoting the value — echoing it would put
    // it in the terminal scrollback and in whatever captures this output.
    const res = run(["set", "render-api-key", SENTINEL]);

    expect(res.status).toBe(cli.EXIT_REFUSED);
    expect(res.stderr).not.toContain(SENTINEL);
    expect(res.stderr).toContain("/proc");
    expect(res.stderr).toContain("pipe it");
    // Nothing was written: a refused command must leave the store untouched.
    expect(existsSync(join(storeDir, "render-api-key"))).toBe(false);
    expect(recordedArgv()).toEqual([]);
  });

  it("refuses to store a blank value rather than poisoning the slot", () => {
    // `writeSecret` persists the empty string happily; the entry then reads back
    // as the `empty` fault. So `< /dev/null`, or a variable that expanded to
    // nothing, would replace a working credential and report success. Catching
    // it here names the cause instead.
    const res = run(["set", "render-api-key"], { input: "" });

    expect(res.status).toBe(cli.EXIT_REFUSED);
    expect(res.stderr).toContain("blank value");
    expect(existsSync(join(storeDir, "render-api-key"))).toBe(false);
    expect(recordedArgv()).toEqual([]);
  });

  it("refuses a whitespace-only value for the same reason", () => {
    const res = run(["set", "render-api-key"], { input: "   \n\t " });

    expect(res.status).toBe(cli.EXIT_REFUSED);
    expect(existsSync(join(storeDir, "render-api-key"))).toBe(false);
  });

  // -------------------------------------------------------------- delete ---

  it("clears an entry", () => {
    seedStored("render-api-key", SENTINEL);

    const res = run(["delete", "render-api-key"]);

    expect(res.status).toBe(cli.EXIT_OK);
    expect(existsSync(join(storeDir, "render-api-key"))).toBe(false);
    expect(res.stderr).toContain("cleared");
  });

  it("treats deleting an absent entry as done, so teardown scripts do not break", () => {
    const res = run(["delete", "render-api-key"]);

    expect(res.status).toBe(cli.EXIT_OK);
    expect(res.stderr).toContain("nothing to delete");
  });

  it("leaves other accounts alone when deleting one", () => {
    seedStored("render-api-key", SENTINEL);
    seedStored("production-app-credentials", OTHER_SENTINEL);

    const res = run(["delete", "render-api-key"]);

    expect(res.status).toBe(cli.EXIT_OK);
    expect(readFileSync(join(storeDir, "production-app-credentials"), "utf8")).toBe(OTHER_SENTINEL);
  });

  // ----------------------------------------------------------- refusals ---

  it("refuses an account name outside the allowlist before touching the keyring", () => {
    const res = run(["get", "some-other-apps-token"]);

    expect(res.status).toBe(cli.EXIT_REFUSED);
    // A usage refusal, not a store fault: the message names the valid accounts
    // so the operator can see the typo. The store's own code is for callers that
    // branch on it, not something to hand to a human at a terminal.
    expect(res.stderr).toContain("refused:");
    expect(res.stderr).toContain("unknown secret");
    for (const account of store.ACCOUNTS) {
      expect(res.stderr).toContain(account);
    }
    expect(recordedArgv()).toEqual([]);
  });

  it("names the bad account before asking for a value on stdin", () => {
    // Ordering matters. With no stdin supplied the store would report "nothing
    // is piped in" first, which sends the operator to fix their pipe rather than
    // their typo, and the command still fails for the reason that is not it.
    const res = run(["set", "render-api-ke"]);

    expect(res.status).toBe(cli.EXIT_REFUSED);
    expect(res.stderr).toContain("unknown secret");
    expect(res.stderr).not.toContain("nothing is piped in");
  });

  it("refuses an unknown command and an unknown flag by name", () => {
    const unknownCommand = run(["frobnicate"]);
    expect(unknownCommand.status).toBe(cli.EXIT_REFUSED);
    expect(unknownCommand.stderr).toContain('unknown command "frobnicate"');
    expect(unknownCommand.stderr).toContain("list, get, set, delete");

    const unknownFlag = run(["list", "--pretty"]);
    expect(unknownFlag.status).toBe(cli.EXIT_REFUSED);
    expect(unknownFlag.stderr).toContain("unknown flag: --pretty");
  });

  it("refuses --json outside list, where there is nothing to parse", () => {
    const res = run(["get", "render-api-key", "--json"]);

    expect(res.status).toBe(cli.EXIT_REFUSED);
    expect(res.stderr).toContain("--json applies to `list` only");
  });

  it("prints usage on --help and refuses a bare invocation", () => {
    const help = run(["--help"]);
    expect(help.status).toBe(cli.EXIT_OK);
    expect(help.stderr).toContain("secret-store-cli.cjs <command>");
    // The allowlist is the useful part of the usage text: it is the thing an
    // operator otherwise has to go read in the source to learn.
    for (const account of store.ACCOUNTS) {
      expect(help.stderr).toContain(account);
    }
    expect(help.stderr).toContain("secret-tool search");

    const bare = run([]);
    expect(bare.status).toBe(cli.EXIT_REFUSED);
    expect(bare.stderr).toContain("Usage:");
  });

  it("reports an unreachable keyring as a failure, not a refusal", () => {
    // The distinction the exit codes exist for: nothing about the command was
    // wrong, so retrying it unchanged will fail identically. The remedy is to
    // unlock the keyring.
    const res = run(["list"], { env: env({ STUB_MODE: "unreachable" }) });

    expect(res.status).toBe(cli.EXIT_FAILED);
  });

  it("maps the three exit codes to the shared ops contract", () => {
    expect(cli.EXIT_OK).toBe(0);
    expect(cli.EXIT_FAILED).toBe(1);
    expect(cli.EXIT_REFUSED).toBe(2);
  });

  // ------------------------------------------------ in-process unit checks ---

  describe("parseArgs", () => {
    it("routes --help and an empty invocation to the usage path", () => {
      expect(cli.parseArgs(["--help"])).toEqual({ command: "help", account: null, json: false });
      expect(cli.parseArgs([])).toEqual({ command: "help", account: null, json: false });
      // `-h` is the short form, not an unknown flag.
      expect(cli.parseArgs(["-h"]).command).toBe("help");
    });

    it("pulls the account out of positionals and the format out of flags", () => {
      expect(cli.parseArgs(["get", "render-api-key"])).toEqual({
        command: "get",
        account: "render-api-key",
        json: false,
      });
      expect(cli.parseArgs(["list", "--json"])).toEqual({ command: "list", account: null, json: true });
    });

    it("treats a dash-prefixed word as a flag, never as a value", () => {
      // There is deliberately no `-` placeholder: `set` reads stdin
      // unconditionally. Accepting one would create a spelling that looks like
      // it stores something and silently does not.
      expect(() => cli.parseArgs(["set", "render-api-key", "-"])).toThrow(/unknown flag: -/);
    });

    it("requires an account for every command except list", () => {
      expect(() => cli.parseArgs(["get"])).toThrow(/needs an account name/);
      expect(() => cli.parseArgs(["set"])).toThrow(/piped on stdin/);
      expect(() => cli.parseArgs(["list", "render-api-key"])).toThrow(/takes no argument/);
    });
  });

  describe("describeAccount is exercised only through subprocesses", () => {
    // Deliberately NOT called in-process here. `describeAccount` reads
    // `process.env` to find `secret-tool`, so an in-process call from a test
    // that forgot to stub PATH reaches the developer's *real* login keyring and
    // reads a real credential. A first draft of this file did exactly that: an
    // unwrapped in-process call reported the real `render-api-key` as
    // `present` with a 33-byte value. Everything below therefore goes through
    // `run()`, which hands the child a controlled PATH and a bus address that
    // does not exist. The properties it covers are asserted on the child's
    // stdout, which is strictly stronger: it proves the real binary could not
    // have been reached at all.
    it("lists a mix of present and absent accounts as exactly those two states", () => {
      seedStored("render-api-key", SENTINEL);
      seedStored("production-app-credentials", OTHER_SENTINEL);

      const res = run(["list"]);

      expect(res.status).toBe(cli.EXIT_OK);
      expect(res.stdout).toContain("render-api-key\tpresent");
      expect(res.stdout).toContain("production-app-credentials\tpresent");
      expect(res.stdout).toContain("fcm-rotation-backup\tabsent");
      expect(res.stdout).toContain("core-secrets-rotation-backup\tabsent");
      expect(res.stdout).not.toContain("error");
    });

    it("reports an unreachable keyring as error, never as absent", () => {
      // The two must not collapse: "not there" tells an operator to store it,
      // "locked" tells them to unlock their session. Reporting an unreachable
      // keyring as four absent accounts would send them to do the wrong thing.
      const res = run(["list"], { env: env({ STUB_MODE: "unreachable" }) });

      expect(res.status).toBe(cli.EXIT_FAILED);
      expect(res.stdout).not.toContain("absent");
      expect(res.stdout).not.toContain("present");
      expect(res.stdout.match(/error/g)?.length).toBe(store.ACCOUNTS.length);
    });

    it("carries the same three states through --json", () => {
      seedStored("render-api-key", SENTINEL);

      const present = run(["list", "--json"]);
      const locked = run(["list", "--json"], { env: env({ STUB_MODE: "unreachable" }) });

      const states = (res: { stdout: string }) =>
        (JSON.parse(res.stdout) as { entries: { state: string }[] }).entries.map((e) => e.state);

      expect(states(present)).toContain("present");
      expect(states(present)).toContain("absent");
      expect(new Set(states(locked))).toEqual(new Set(["error"]));
    });
  });
});