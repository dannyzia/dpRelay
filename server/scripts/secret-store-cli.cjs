/**
 * secret-store-cli — the operator-facing front door to the dP Relay keyring.
 *
 * Why this exists: `secret-store.cjs` is a library, and its only human-facing
 * instructions are the `secret-tool store …` lines embedded in its own error
 * messages. So provisioning an entry means hand-assembling a libsecret command
 * line with a correctly spelled `--label`, a `service dprelay account <name>`
 * pair, and a pipe. Getting the label or the account wrong fails quietly:
 * `secret-tool store` will happily write an entry that no dP Relay script ever
 * reads back.
 *
 * Worse, the natural question an operator asks first — "what is even in the
 * keyring?" — has a libsecret answer that prints every stored value to stdout.
 * `secret-tool search` is a footgun in a repo whose entire reason for having a
 * keyring is that these values must not land in scrollback, shell history, a
 * terminal recording, or a paste into a ticket. `list` answers the same
 * question as account + present/absent and cannot print a value at all.
 *
 * The rules this file holds itself to:
 *
 *   - No secret reaches a command line. argv is world-readable through /proc on
 *     Linux, so `set` reads the value from stdin and refuses the obvious
 *     `set <name> <value>` spelling outright.
 *   - No secret reaches an error message, a refusal, or a confirmation. Every
 *     line of output names an account — an allowlisted identifier — and never a
 *     value. `set` reports a byte count, which is enough to catch a truncated
 *     pipe without putting the credential in a scrollback.
 *   - No secret is read unless a subcommand needs it. `list` reports presence
 *     through `hasSecret`, which returns a boolean and never exposes the value
 *     to this file at all.
 *   - The default output is for a human; `--json` is for a script.
 *
 * All keyring access goes through `secret-store.cjs`. This file deliberately
 * contains no `secret-tool` invocation of its own: the account allowlist, the
 * stderr-based not-found/unreachable classification, and the stdin-only write
 * path all live there, and a second copy would be a second set of bugs.
 *
 * Usage:
 *   node server/scripts/secret-store-cli.cjs list [--json]
 *   node server/scripts/secret-store-cli.cjs get <name>
 *   node server/scripts/secret-store-cli.cjs set <name>          # value on stdin
 *   node server/scripts/secret-store-cli.cjs delete <name>
 *   node server/scripts/secret-store-cli.cjs --help
 *
 * Exit codes: 0 = done, 1 = the operation failed, 2 = refused (nothing read,
 * nothing written). A bad argument, an unknown account name, and an unusable
 * stdin are all refusals, because in each of those the right action is to
 * change the command rather than to go and fix the keyring.
 *
 * Synchronous on purpose: every keyring call in secret-store.cjs is
 * spawnSync-backed, so an async wrapper here would imply concurrency that does
 * not exist and would make the tests await meaningless values.
 *
 * Written as CommonJS with no imports beyond node builtins and the local store,
 * so plain `node script.cjs` works and the TypeScript selftest can pull it in
 * through `createRequire` without a build step.
 */
const { readFileSync } = require('node:fs');

const {
  ACCOUNTS,
  CODES,
  SERVICE,
  SecretStoreError,
  accountFor,
  readSecret,
  hasSecret,
  writeSecret,
  deleteSecret,
} = require('./secret-store.cjs');

/** The command did what was asked. */
const EXIT_OK = 0;

/** The command was understood but could not be carried out. */
const EXIT_FAILED = 1;

/** The command was refused before anything was read or written. */
const EXIT_REFUSED = 2;

/**
 * Subcommands this CLI understands.
 *
 * Frozen because it is also the vocabulary the arity check in {@link parseArgs}
 * reasons about: an unrecognised word is refused by name, never guessed at.
 */
const COMMANDS = Object.freeze(['list', 'get', 'set', 'delete']);

/**
 * The invocation was refused: bad arguments, an unknown account, unusable
 * stdin. Kept distinct from {@link SecretStoreError} because the two demand
 * different remedies — this means "fix the command", that means "fix the
 * keyring" — and collapsing them would make the exit code ambiguous advice.
 */
class RefusalError extends Error {
  /**
   * @param {string} message operator-facing explanation, never containing a secret
   */
  constructor(message) {
    super(message);
    this.name = 'RefusalError';
  }
}

/**
 * Reads the whole of stdin as UTF-8.
 *
 * `readFileSync(0)` rather than a stream read so the CLI stays synchronous and
 * the value is never held in a partially-filled buffer: an interrupted write
 * must fail rather than store a truncated credential. A TTY is refused first —
 * without that check, an operator who forgets the pipe gets a silent hang
 * instead of being told what to type.
 *
 * The bytes are taken exactly as given. Trimming a trailing newline would be
 * the tidier-looking choice and is the wrong one: two of the four accounts hold
 * JSON blobs, and `secret-store.cjs` already documents at length why silent
 * whitespace mutation of a payload is not acceptable. The fix for a value with a
 * stray newline is `printf '%s'`, not a hidden strip.
 *
 * @returns {string} the value, byte-for-byte
 * @throws {RefusalError} when stdin is a terminal or cannot be read
 */
function readValueFromStdin() {
  if (process.stdin.isTTY) {
    throw new RefusalError(
      'nothing is piped in. `set` reads the value from stdin so it never appears in argv, which every ' +
        "process on this machine can read through /proc. Use: printf '%s' \"$VALUE\" | " +
        'node server/scripts/secret-store-cli.cjs set <name>',
    );
  }
  try {
    return readFileSync(0, 'utf8');
  } catch (err) {
    // EINVAL/EAGAIN is what a closed or non-readable stdin looks like on Linux.
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'unknown';
    throw new RefusalError(`cannot read the value from stdin (${code}) — pipe it in, or check the redirect`);
  }
}

/**
 * Parses argv into a command, an optional account, and an output format.
 *
 * @param {string[]} argv arguments after the script path
 * @returns {{command: string, account: string|null, json: boolean}}
 * @throws {RefusalError} on an unknown flag, command, or arity
 */
function parseArgs(argv) {
  let json = false;
  const positionals = [];
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return { command: 'help', account: null, json: false };
    if (arg === '--json') {
      json = true;
      continue;
    }
    // Anything dash-prefixed is a flag. `set` reads stdin unconditionally, so
    // there is no `-` placeholder for a value, and accepting one would only
    // create a spelling that looks like it works and then writes nothing.
    if (arg.startsWith('-')) throw new RefusalError(`unknown flag: ${arg}`);
    positionals.push(arg);
  }

  // A bare invocation asked for nothing: usage, and the caller decides what to
  // make of it (main turns this into exit 2).
  if (positionals.length === 0) return { command: 'help', account: null, json: false };

  const [command, ...rest] = positionals;
  if (!COMMANDS.includes(command)) {
    throw new RefusalError(`unknown command "${command}" — expected one of: ${COMMANDS.join(', ')}`);
  }

  if (rest.length > 1) {
    // Never echo the extra arguments. `set <name> <value>` is the mistake this
    // branch exists for, and repeating the value in the refusal would leak the
    // exact thing the refusal is protecting — into scrollback, and into whatever
    // captures it. Only the command is named.
    const howToFix =
      command === 'set'
        ? 'A value on the command line is readable by every process on this machine through /proc; ' +
          "pipe it instead: printf '%s' \"$VALUE\" | node server/scripts/secret-store-cli.cjs set <name>"
        : '';
    throw new RefusalError(`${command} takes at most one argument (an account name), got ${rest.length}. ${howToFix}`.trim());
  }

  const account = rest[0] ?? null;

  if (json && command !== 'list') {
    throw new RefusalError('--json applies to `list` only — `get` already prints the value, and `set`/`delete` print nothing but a status line');
  }
  if (command === 'list' && account !== null) {
    throw new RefusalError('list takes no argument — it reports every known account');
  }
  if (command !== 'list' && account === null) {
    throw new RefusalError(
      `${command} needs an account name: ${command} <name>` +
        (command === 'set' ? '  (the value is piped on stdin, not passed as an argument)' : ''),
    );
  }

  return { command, account, json };
}

/**
 * Reports presence for one account, keeping the value strictly out of the
 * return type.
 *
 * One `readSecret`, not `hasSecret` followed by `readSecret`: that pair would
 * spawn secret-tool twice per account and open a window in which the entry is
 * deleted between the two calls, which would report a length for something that
 * is no longer there. `readSecret` distinguishes the two outcomes this needs —
 * a miss raises `not-found`, a transport failure raises `keyring-unavailable` —
 * so one call is enough.
 *
 * A stored-but-empty entry is an `error`, not `absent`: both need operator
 * action but they are different faults, and `set` (a pipe that went nowhere) is
 * the fix for one while `set` of a real value is the fix for the other.
 *
 * A transport failure becomes an `error` row rather than a thrown exception:
 * `list` walks four accounts and must survive one unreachable, and the operator
 * needs to see all four states rather than the first failure alone.
 *
 * @param {string} account keyring account name
 * @returns {{account: string, state: 'present'|'absent'|'error', bytes: number, detail: string}}
 */
function describeAccount(account) {
  try {
    const value = readSecret(account);
    // The value is measured and dropped here. `bytes` is the stored length,
    // enough to spot a truncated write and useless for reconstructing one.
    return { account, state: 'present', bytes: Buffer.byteLength(value, 'utf8'), detail: '' };
  } catch (err) {
    if (!(err instanceof SecretStoreError)) throw err;
    if (err.code === CODES.NOT_FOUND) return { account, state: 'absent', bytes: 0, detail: '' };
    // `detail` is raw secret-tool stderr on a transport failure. That is
    // connection chatter, never a value: secret-tool does not echo a secret
    // back on any failure path.
    return { account, state: 'error', bytes: 0, detail: err.detail ?? err.message };
  }
}

/**
 * `list` — every known account with its presence, and no values.
 *
 * @param {boolean} json emit a machine-readable object instead of tab-separated rows
 * @returns {number} exit code
 */
function runList(json) {
  const rows = ACCOUNTS.map((account) => describeAccount(account));
  const failed = rows.filter((row) => row.state === 'error');

  for (const row of failed) {
    // One line per bad account on stderr, so the reason survives even though
    // the rows themselves still go to stdout.
    process.stderr.write(`${row.account}: could not be checked — ${row.detail}\n`);
  }

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          service: SERVICE,
          // `bytes` is the stored length, not the value: enough to spot a
          // truncated write, useless for reconstructing one.
          entries: rows.map(({ account, state, bytes }) => ({ account, state, bytes })),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`${rows.map((row) => `${row.account}\t${row.state}`).join('\n')}\n`);
  }

  // A row that could not be checked is a failure even when its neighbours
  // resolved: a script asking "what is in the keyring?" must not read a
  // partial answer as a complete one.
  return failed.length === 0 ? EXIT_OK : EXIT_FAILED;
}

/**
 * `get` — writes one value to stdout, for piping into another command.
 *
 * The only path in this file that prints a secret, and it is gated on naming
 * `get` explicitly. The bytes are written verbatim with no trailing newline
 * added, matching what `secret-store.cjs` deliberately does not trim:
 * `VAR=$(… get name)` yields the stored payload exactly, with nothing to strip.
 *
 * @param {string} account keyring account name
 * @returns {number} exit code
 */
function runGet(account) {
  const value = readSecret(account);
  process.stdout.write(value);
  return EXIT_OK;
}

/**
 * `set` — stores a value read from stdin.
 *
 * A blank value is refused before the write rather than stored. `writeSecret`
 * will happily persist the empty string, and the entry then reads back as the
 * `empty` fault — so a redirect that went nowhere (`… set name < /dev/null`,
 * or a variable that expanded to nothing) would quietly replace a working
 * credential with a poisoned slot and report success. Refusing up front names
 * the cause, and costs nothing: no real credential is whitespace.
 *
 * @param {string} account keyring account name
 * @returns {number} exit code
 */
function runSet(account) {
  const value = readValueFromStdin();
  if (value.trim() === '') {
    throw new RefusalError(
      `refusing to store a blank value for ${account} — an empty entry reads back as a fault, so a redirect that ` +
        'went nowhere would replace a working credential and still report success. Pipe the real value in.',
    );
  }
  writeSecret(account, value);
  process.stderr.write(
    `stored ${account} in the keyring (${Buffer.byteLength(value, 'utf8')} bytes). The value was not echoed.\n`,
  );
  return EXIT_OK;
}

/**
 * `delete` — removes one entry.
 *
 * Deleting something that is not there is reported and treated as success: the
 * end state the operator asked for already holds, and a non-zero exit would
 * make this useless as the last line of a teardown script.
 *
 * @param {string} account keyring account name
 * @returns {number} exit code
 */
function runDelete(account) {
  if (!hasSecret(account)) {
    process.stderr.write(`${account} is not in the keyring — nothing to delete.\n`);
    return EXIT_OK;
  }
  deleteSecret(account);
  process.stderr.write(`cleared ${account} from the keyring.\n`);
  return EXIT_OK;
}

/**
 * Writes the usage text to stderr.
 *
 * @returns {void}
 */
function printUsage() {
  const lines = [
    'dP Relay secret store — manage the credentials in your login keyring.',
    '',
    'Usage: node server/scripts/secret-store-cli.cjs <command> [account] [--json]',
    '',
    'Commands:',
    '  list              every account this store knows, with present/absent/error.',
    '                    Never prints a value. Use this, not `secret-tool search`,',
    '                    which prints every secret it finds.',
    '  get <account>     write the stored value to stdout, for piping.',
    '  set <account>     store the value piped in on stdin; replaces any existing value.',
    '  delete <account>  clear the entry from the keyring.',
    '',
    `Accounts: ${ACCOUNTS.join(', ')}`,
    '',
    'Examples:',
    '  node server/scripts/secret-store-cli.cjs list',
    "  printf '%s' \"$RENDER_API_KEY\" | node server/scripts/secret-store-cli.cjs set render-api-key",
    '  KEY=$(node server/scripts/secret-store-cli.cjs get render-api-key)',
    '',
    'Exit codes: 0 done | 1 failed | 2 refused (nothing read, nothing written).',
  ];
  process.stderr.write(`${lines.join('\n')}\n`);
}

/**
 * CLI entry point.
 *
 * @param {string[]} argv arguments after the script path
 * @returns {number} exit code
 * @throws {RefusalError} on a refused invocation
 * @throws {SecretStoreError} when the keyring itself misbehaves
 */
function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.command === 'help') {
    printUsage();
    // --help is a successful answer to a question; a bare invocation asked for
    // nothing and is a refusal. Same rule as rotate-secret.cjs.
    return argv.length === 0 ? EXIT_REFUSED : EXIT_OK;
  }

  // Validate the account before any keyring access. The store functions each
  // re-validate, so this is not about safety — it is about which failure the
  // operator sees. Without it, `set <typo>` reaches readValueFromStdin first and
  // reports "nothing is piped in" for what is really a misspelled account, and
  // `get <typo>` reports a raw store code rather than a usage error naming the
  // names that do exist.
  if (parsed.account !== null) {
    try {
      accountFor(parsed.account);
    } catch (err) {
      if (err instanceof SecretStoreError && err.code === CODES.UNKNOWN_NAME) {
        throw new RefusalError(err.message);
      }
      throw err;
    }
  }

  switch (parsed.command) {
    case 'list':
      return runList(parsed.json);
    case 'get':
      return runGet(parsed.account);
    case 'set':
      return runSet(parsed.account);
    case 'delete':
      return runDelete(parsed.account);
    /* c8 ignore next 2 -- COMMANDS and parseArgs together keep this unreachable */
    default:
      throw new RefusalError(`unhandled command: ${parsed.command}`);
  }
}

module.exports = {
  EXIT_OK,
  EXIT_FAILED,
  EXIT_REFUSED,
  COMMANDS,
  RefusalError,
  SERVICE,
  ACCOUNTS,
  readValueFromStdin,
  parseArgs,
  describeAccount,
  runList,
  runGet,
  runSet,
  runDelete,
  printUsage,
  main,
};

// Only run as a CLI. The test suite imports this module, and must never be able
// to reach a real keyring or exit the process by doing so.
if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof RefusalError) {
      process.stderr.write(`refused: ${err.message}\n`);
      process.exitCode = EXIT_REFUSED;
    } else if (err instanceof SecretStoreError) {
      process.stderr.write(`${err.code}: ${err.message}\n`);
      if (err.code === CODES.NOT_FOUND) {
        // The store's message ends with the raw `secret-tool store` line. That
        // is right for a library caller and wrong here: this tool exists so
        // nobody has to hand-assemble one, so point back at `set` instead. The
        // account is already named on the line above.
        process.stderr.write('hint: create it with this tool rather than by hand — see --help.\n');
      }
      // A name outside the allowlist is an operator mistake (exit 2). An
      // unreachable keyring, an empty entry, and a failed write are all
      // environment faults (exit 1).
      process.exitCode = err.code === CODES.UNKNOWN_NAME ? EXIT_REFUSED : EXIT_FAILED;
    } else {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = EXIT_FAILED;
    }
  }
}