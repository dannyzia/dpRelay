/**
 * The dP Relay secret store: libsecret, reached through `secret-tool`.
 *
 * Three credentials used to live on disk in the clear, each at mode 0600 —
 * which stops other *users* reading them and does nothing about the backups,
 * the sync agents, the `~` backup tarball, or a laptop that is stolen with the
 * session already unlocked:
 *
 *   ~/.config/dprelay/render-api-key            the Render API key
 *   staging/fcm-rotation-backup.json             the whole production env,
 *                                                including the FCM service
 *                                                account's private key
 *   staging/production-app-credentials.json      appSecret + webhookSecret
 *
 * They now live in the login keyring. Nothing here ever writes a secret to
 * disk, and no value is ever placed on a command line — argv is world-readable
 * through /proc on Linux, so every write goes through stdin.
 *
 * Why libsecret rather than an encrypted file: an operator's own login
 * keyring is the one secret store that is already unlocked exactly when a
 * person is sitting at the machine, needs no passphrase to remember or type,
 * and leaves no ciphertext whose passphrase can be lost. The cost is that the
 * store is unreachable from a locked screen, a cron unit, or a CI runner — so
 * `RENDER_API_KEY` and `RENDER_API_KEY_FILE` remain supported escapes for
 * those contexts, and are documented in server/README.md.
 *
 * Failure is always loud and typed. There is no plaintext fallback: a caller
 * that cannot open the keyring gets a `SecretStoreError`, never a silently
 * different (or missing) credential.
 *
 * Written as CommonJS with no imports beyond node builtins so plain
 * `node script.cjs` works and the TypeScript selftests can pull it in through
 * `createRequire` without a build step.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

/** libsecret `service` attribute. Every dP Relay secret shares it. */
const SERVICE = 'dprelay';

/**
 * Every account the dP Relay store holds.
 *
 * The account string *is* the public identifier: call sites pass it straight to
 * readSecret/writeSecret. An earlier draft instead mapped a logical name
 * (`renderApiKey`) onto the account (`render-api-key`) and took the logical
 * name, which made the value you read out of the exported table an invalid
 * argument to pass back — the migration script using it died with
 * `unknown secret "render-api-key"`. One identifier removes that whole class of
 * mistake, and it is the same string shown in the keyring UI and in error
 * messages, so an operator can match the two up.
 *
 * Frozen because it doubles as the allowlist: an unrecognised name is rejected
 * before any process is spawned, so a typo cannot silently read nothing.
 */
const ACCOUNTS = Object.freeze([
  'render-api-key',
  'fcm-rotation-backup',
  'production-app-credentials',
  'core-secrets-rotation-backup',
]);

/** Stable `code` on SecretStoreError, so callers can branch without matching prose. */
const CODES = Object.freeze({
  UNKNOWN_NAME: 'unknown-secret',
  NO_TOOL: 'no-secret-tool',
  KEYRING_UNAVAILABLE: 'keyring-unavailable',
  NOT_FOUND: 'not-found',
  EMPTY: 'empty',
  WRITE_FAILED: 'write-failed',
});

/** The keyring blob is a few KB; this is only here so a future large secret cannot silently truncate. */
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * A secret store failure, carrying a machine-readable `code`.
 *
 * Messages name the account and the command needed to create the entry. They
 * never embed a value: this error text is what ends up on stderr and in a
 * ticket.
 */
class SecretStoreError extends Error {
  /**
   * @param {string} code one of {@link CODES}
   * @param {string} message operator-facing explanation, never containing a secret
   * @param {string} [detail] raw tool stderr, for the keyring-unavailable case
   */
  constructor(code, message, detail) {
    super(message);
    this.name = 'SecretStoreError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/**
 * Validates a secret name against the known accounts.
 *
 * @param {string} name keyring account
 * @returns {string} `name`, unchanged
 * @throws {SecretStoreError} with code `unknown-secret`
 */
function accountFor(name) {
  if (!ACCOUNTS.includes(name)) {
    throw new SecretStoreError(
      CODES.UNKNOWN_NAME,
      `unknown secret "${name}" — known: ${ACCOUNTS.join(', ')}`,
    );
  }
  return name;
}

/**
 * The D-Bus session bus to hand the child, or null when it cannot be derived.
 *
 * Never hardcoded: `/run/user/$UID/bus` is derived from `XDG_RUNTIME_DIR`
 * precisely because the numeric uid differs per machine and per container.
 * An address already in the environment always wins — this only fills a gap.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|null} a D-Bus address, or null when none can be determined
 */
function sessionBusAddress(env = process.env) {
  const explicit = env.DBUS_SESSION_BUS_ADDRESS;
  if (explicit !== undefined && explicit.trim() !== '') return explicit.trim();
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime !== undefined && runtime.trim() !== '') {
    return `unix:path=${path.join(runtime.trim(), 'bus')}`;
  }
  return null;
}

/**
 * Spawns `secret-tool`, translating a missing binary into a typed error.
 *
 * @param {string[]} args arguments for secret-tool
 * @param {string|undefined} input value to pipe on stdin, or undefined to leave stdin alone
 * @param {Record<string, string|undefined>} env environment for the child
 * @returns {import('node:child_process').SpawnSyncReturns<string>} the finished process
 * @throws {SecretStoreError} when secret-tool is absent or cannot be spawned
 */
function runSecretTool(args, input, env) {
  const address = sessionBusAddress(env);
  const childEnv = address === null ? env : { ...env, DBUS_SESSION_BUS_ADDRESS: address };
  const result = spawnSync('secret-tool', args, {
    encoding: 'utf8',
    input,
    env: childEnv,
    maxBuffer: MAX_BUFFER_BYTES,
  });
  if (result.error && result.error.code === 'ENOENT') {
    throw new SecretStoreError(
      CODES.NO_TOOL,
      'secret-tool is not on PATH — install libsecret-tools (Debian/Ubuntu: apt install libsecret-tools) to reach the dP Relay secret store',
    );
  }
  if (result.error) {
    throw new SecretStoreError(
      CODES.KEYRING_UNAVAILABLE,
      `cannot run secret-tool ${args[0]}: ${result.error.message}`,
    );
  }
  return result;
}

/**
 * Turns a finished `secret-tool lookup` into the value, or a typed error.
 *
 * The classification exists because secret-tool reports "no such secret" and
 * "I could not reach the keyring" with the *same* exit code (1) and the *same*
 * empty stdout. The only thing separating them is stderr: a genuine miss is
 * silent, while every transport failure explains itself on stderr. Collapsing
 * the two would tell an operator their credential is missing when in fact
 * their keyring is merely locked — the wrong remedy for the actual fault.
 *
 * @param {string} name logical name, used only to phrase the message
 * @param {string} account keyring account
 * @param {import('node:child_process').SpawnSyncReturns<string>} result
 * @returns {string} the stored value, byte-for-byte
 * @throws {SecretStoreError} `not-found`, `empty`, or `keyring-unavailable`
 */
function classifyLookup(name, account, result) {
  const stderr = (result.stderr ?? '').trim();
  const stdout = result.stdout ?? '';

  if (result.status === 0) {
    if (stdout === '') {
      throw new SecretStoreError(
        CODES.EMPTY,
        `keyring account "${account}" holds an empty value — re-store it`,
      );
    }
    // Returned verbatim. `secret-tool lookup` adds no trailing newline of its
    // own (verified against a value stored with none), so trimming here would
    // silently corrupt a JSON blob and would paper over a store that *did*
    // gain a newline. Callers that want a trimmed scalar trim it themselves.
    return stdout;
  }

  // status is null when the process died from a signal. Reporting that as a
  // miss would send an operator off to re-create a credential that is intact.
  if (result.status === null || result.status === undefined) {
    throw new SecretStoreError(
      CODES.KEYRING_UNAVAILABLE,
      `secret-tool was killed by a signal while reading "${account}"`,
    );
  }

  if (stderr !== '') {
    throw new SecretStoreError(
      CODES.KEYRING_UNAVAILABLE,
      `cannot reach the keyring to read "${account}": ${stderr} — unlock your session keyring, then retry`,
      stderr,
    );
  }

  throw new SecretStoreError(
    CODES.NOT_FOUND,
    `no "${name}" in the keyring (service ${SERVICE}, account ${account}). Create it with: secret-tool store --label='dP Relay ${name}' service ${SERVICE} account ${account}`,
  );
}

/**
 * Reads one secret from the keyring.
 *
 * @param {string} name key of {@link ACCOUNTS}
 * @param {object} [opts]
 * @param {Record<string, string|undefined>} [opts.env] environment to resolve the bus from; defaults to `process.env`
 * @returns {string} the stored value, byte-for-byte
 * @throws {SecretStoreError} when the entry is absent, empty, or the keyring is unreachable
 */
function readSecret(name, opts = {}) {
  const account = accountFor(name);
  const result = runSecretTool(
    ['lookup', 'service', SERVICE, 'account', account],
    undefined,
    opts.env ?? process.env,
  );
  return classifyLookup(name, account, result);
}

/**
 * Writes one secret into the keyring, replacing any existing entry.
 *
 * The value goes on stdin. Passing it as an argument would publish it to every
 * process on the machine through /proc.
 *
 * @param {string} name key of {@link ACCOUNTS}
 * @param {string} value the secret; must be a string so `undefined` can never be stored by accident
 * @param {object} [opts]
 * @param {Record<string, string|undefined>} [opts.env] environment to resolve the bus from; defaults to `process.env`
 * @returns {void}
 * @throws {SecretStoreError} on an unknown name, a non-string value, or a failed write
 */
function writeSecret(name, value, opts = {}) {
  const account = accountFor(name);
  if (typeof value !== 'string') {
    throw new SecretStoreError(
      CODES.WRITE_FAILED,
      `refusing to store "${name}": value must be a string, got ${typeof value}`,
    );
  }
  const result = runSecretTool(
    ['store', `--label=dP Relay ${name}`, 'service', SERVICE, 'account', account],
    value,
    opts.env ?? process.env,
  );
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim();
    throw new SecretStoreError(
      CODES.WRITE_FAILED,
      `cannot write "${account}" to the keyring: ${detail !== '' ? detail : `secret-tool exited ${result.status}`}`,
      detail !== '' ? detail : undefined,
    );
  }
}

/**
 * Whether a secret exists and is non-empty.
 *
 * A transport failure is re-thrown rather than reported as `false`: "the key
 * is absent" and "the keyring is locked" call for different actions, and a
 * boolean cannot carry that difference.
 *
 * @param {string} name key of {@link ACCOUNTS}
 * @param {object} [opts] see {@link readSecret}
 * @returns {boolean} true when readable
 * @throws {SecretStoreError} when the keyring itself is unreachable
 */
function hasSecret(name, opts = {}) {
  try {
    readSecret(name, opts);
    return true;
  } catch (err) {
    if (err instanceof SecretStoreError && err.code === CODES.NOT_FOUND) return false;
    throw err;
  }
}

/**
 * Removes a secret from the keyring.
 *
 * @param {string} name key of {@link ACCOUNTS}
 * @param {object} [opts] see {@link readSecret}
 * @returns {void}
 * @throws {SecretStoreError} when the clear fails
 */
function deleteSecret(name, opts = {}) {
  const account = accountFor(name);
  const result = runSecretTool(
    ['clear', 'service', SERVICE, 'account', account],
    undefined,
    opts.env ?? process.env,
  );
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim();
    throw new SecretStoreError(
      CODES.WRITE_FAILED,
      `cannot clear "${account}" from the keyring: ${detail !== '' ? detail : `secret-tool exited ${result.status}`}`,
      detail !== '' ? detail : undefined,
    );
  }
}

module.exports = {
  SERVICE,
  ACCOUNTS,
  CODES,
  SecretStoreError,
  accountFor,
  sessionBusAddress,
  classifyLookup,
  readSecret,
  writeSecret,
  hasSecret,
  deleteSecret,
};
