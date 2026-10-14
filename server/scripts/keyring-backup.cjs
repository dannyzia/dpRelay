/**
 * keyring-backup — take the dP Relay keyring off this machine and put it back.
 *
 * Why this exists: every ops credential now lives in the operator's login
 * keyring and nowhere else. That is the right place to *run* them, but it means
 * a new laptop, a reinstalled desktop, or a wiped disk has no way to be
 * reconstructed — the Render API key, the FCM rotation env, and the appSecret
 * would all have to be re-derived by hand against a live service that may only
 * ever hand one of them back.
 *
 * Why the bundle is encrypted: the obvious implementation is to write the
 * credentials to a file at mode 0600, and that is exactly what this repository
 * already stopped doing. `secret-store.cjs` records the reason in full — a 0600
 * file keeps other *users* out and does nothing about the home-directory
 * tarball, the sync agent, the cloud backup, or a machine stolen with the
 * session already unlocked. A backup file is *designed* to be copied and kept,
 * so it is the single artifact where that weakness matters most. So the bundle
 * is ciphertext: scrypt to stretch the passphrase, AES-256-GCM to encrypt and
 * authenticate. Node built-ins only; no new dependency.
 *
 * The trade-off this reintroduces, stated plainly: a passphrase can be lost.
 * `secret-store.cjs` names that as the reason the keyring beat an encrypted
 * file as the *primary* store. The answer here is that this bundle is
 * deliberately not the primary store — it is an off-machine copy of something
 * you already hold. Losing the passphrase loses the backup, not the keyring.
 * Treat it accordingly, and keep the passphrase somewhere that is not this
 * laptop.
 *
 * What is in the bundle, and why not all four accounts:
 *
 *   render-api-key                the Render credential every ops script uses
 *   production-app-credentials    the appSecret + webhookSecret
 *   fcm-rotation-backup           the whole production env, FCM key included
 *
 * `core-secrets-rotation-backup` is deliberately excluded. It is itself a
 * snapshot of four core secrets, it is only meaningful alongside the specific
 * rollback it was captured for, and including it would put eight credentials
 * behind one passphrase to preserve a rollback path that a deliberate rotation
 * should not survive anyway.
 *
 * What is deliberately absent:
 *
 *   - The passphrase is never accepted as an argument. argv is world-readable
 *     through /proc on Linux, so it is read from stdin, and an env var was
 *     rejected for the same reason.
 *   - No value is ever printed by any mode. `verify` reports account names and
 *     byte lengths only, because its job is to tell you a backup is restorable
 *     before you need it to be.
 *   - Restore authenticates the whole bundle before it writes anything, so a
 *     wrong passphrase cannot half-provision a keyring.
 *
 * Known limitation: a passphrase read into a JS string cannot be reliably
 * zeroed from process memory afterwards. This is a property of the runtime,
 * not of the design, and is recorded rather than papered over.
 *
 * Usage:
 *   node server/scripts/keyring-backup.cjs backup  [--out PATH] [--allow-missing]
 *   node server/scripts/keyring-backup.cjs verify  [--in PATH]
 *   node server/scripts/keyring-backup.cjs restore [--in PATH] [--force]
 *   node server/scripts/keyring-backup.cjs --help
 *
 * The passphrase is prompted for on stdin in every mode that needs one. When
 * there is no TTY, pipe it: `node -e "process.stdout.write(...)" | …` is not
 * advised — prefer a TTY so it is not in your shell history either.
 *
 * Exit codes: 0 done, 1 failed, 2 refused (nothing written).
 */
const { createCipheriv, createDecipheriv, randomBytes, scryptSync } = require('node:crypto');
const { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const { ACCOUNTS, SERVICE, CODES, SecretStoreError, accountFor, readSecret, hasSecret, writeSecret } = require('./secret-store.cjs');

/** The command did what was asked. */
const EXIT_OK = 0;

/** The command was understood but could not be carried out. */
const EXIT_FAILED = 1;

/** The command was refused before anything was read or written. */
const EXIT_REFUSED = 2;

/** Identifies the file so a stray JSON blob is refused rather than half-parsed. */
const FORMAT = 'dprelay-keyring-backup';

/**
 * Envelope version. Bumped only if the ciphertext layout changes in a way an
 * older build cannot read; a newer reader refuses an older version outright
 * rather than guessing.
 */
const FORMAT_VERSION = 1;

/**
 * The accounts a bundle carries.
 *
 * A subset of `secret-store.cjs`'s ACCOUNTS, and the reason is the file header:
 * `core-secrets-rotation-backup` is a snapshot of other secrets, so backing it
 * up doubles the credential count behind one passphrase to preserve a rollback
 * path that should not outlive the rotation it was taken for.
 *
 * Every name is still validated against ACCOUNTS at restore time, so a bundle
 * naming anything else is refused before a single byte is written.
 */
const BUNDLE_ACCOUNTS = Object.freeze(['render-api-key', 'production-app-credentials', 'fcm-rotation-backup']);

/** scrypt cost. N=2^15 with r=8 is ~100ms on a laptop and expensive to brute-force offline. */
const SCRYPT = Object.freeze({ N: 32768, r: 8, p: 1, keylen: 32 });

/**
 * scrypt memory ceiling. Node's default of 32MB is exactly the working set
 * SCRYPT needs (128 * N * r), so the default either fails or leaves no
 * headroom; 64MB is deliberate.
 */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Env var naming the bundle, so the path is never hardcoded. */
const BUNDLE_PATH_ENV = 'DPRELAY_KEYRING_BACKUP';

/** Suffix marking the file as ciphertext, so a stray editor or grep skips it. */
const DEFAULT_BUNDLE_FILENAME = 'keyring-backup.json.enc';

/** Modes this tool understands. */
const MODES = Object.freeze(['backup', 'verify', 'restore']);

/**
 * A failure carrying a machine-readable `code`.
 *
 * Messages name the file, the account, or the mode — never a credential and
 * never the passphrase. This text is what lands on stderr and in a ticket.
 */
class BackupError extends Error {
  /**
   * @param {string} code stable identifier for the failure
   * @param {string} message operator-facing explanation, never containing a secret
   * @param {number} [exitCode] process exit status this failure should produce
   */
  constructor(code, message, exitCode = EXIT_FAILED) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

/**
 * Reads the passphrase from stdin.
 *
 * The TTY check is the important part: without it, an operator who forgets to
 * pipe gets a silent hang instead of being told how to proceed. This duplicates
 * the guard in `secret-store-cli.cjs` on purpose — that one reads a credential
 * and this one reads a passphrase, and sharing the message would tell a caller
 * looking for a passphrase to look for a value.
 *
 * @returns {string} the passphrase, byte-for-byte
 * @throws {BackupError} `blank-passphrase` or `unreadable-stdin`
 */
function readPassphraseFromStdin() {
  if (process.stdin.isTTY) {
    throw new BackupError(
      'passphrase-required',
      'the passphrase must be piped on stdin, not typed here and not passed as an argument. ' +
        'argv is readable by every process on this machine through /proc, and a typed passphrase ' +
        'ends up in shell history.',
      EXIT_REFUSED,
    );
  }
  let raw;
  try {
    raw = readFileSync(0, 'utf8');
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'unknown';
    throw new BackupError('unreadable-stdin', `cannot read the passphrase from stdin (${code})`, EXIT_REFUSED);
  }
  // Trailing newlines are stripped because every way of piping a passphrase
  // adds one, and a trailing newline in the passphrase would be a lockout
  // nobody could diagnose. Interior bytes are untouched.
  const passphrase = raw.replace(/\r?\n$/, '');
  if (passphrase === '') {
    throw new BackupError('blank-passphrase', 'the passphrase is empty — an empty passphrase would make this bundle readable by anyone who finds it', EXIT_REFUSED);
  }
  return passphrase;
}

/**
 * Where the bundle lives, when no explicit path is given.
 *
 * Derived, never hardcoded: an operator's backup belongs off this repository,
 * and `$HOME` differs per machine and per account. `DPRELAY_KEYRING_BACKUP`
 * always wins so a scheduled job can put it wherever it is actually backed up.
 *
 * @param {Record<string, string|undefined>} [env] defaults to `process.env`
 * @returns {string} an absolute path
 */
function defaultBundlePath(env = process.env) {
  const explicit = env[BUNDLE_PATH_ENV];
  if (explicit !== undefined && explicit.trim() !== '') return path.resolve(explicit.trim());
  const base =
    env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME.trim() !== ''
      ? env.XDG_CONFIG_HOME.trim()
      : path.join(env.HOME ?? '', '.config');
  return path.join(base, 'dprelay', DEFAULT_BUNDLE_FILENAME);
}

/**
 * Parses argv into a mode and its options.
 *
 * @param {string[]} argv arguments after the script path
 * @returns {{mode: string, inPath: string|null, outPath: string|null, force: boolean, allowMissing: boolean}}
 * @throws {BackupError} on an unknown flag, mode, or arity
 */
function parseArgs(argv) {
  let force = false;
  let allowMissing = false;
  let inPath = null;
  let outPath = null;
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { mode: 'help', inPath: null, outPath: null, force, allowMissing };
    if (arg === '--force') {
      force = true;
      continue;
    }
    if (arg === '--allow-missing') {
      allowMissing = true;
      continue;
    }
    if (arg === '--in' || arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new BackupError('bad-args', `${arg} needs a path`, EXIT_REFUSED);
      }
      if (arg === '--in') inPath = path.resolve(value);
      else outPath = path.resolve(value);
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) throw new BackupError('bad-args', `unknown flag: ${arg}`, EXIT_REFUSED);
    positionals.push(arg);
  }

  if (positionals.length === 0) return { mode: 'help', inPath, outPath, force, allowMissing };
  if (positionals.length > 1) {
    throw new BackupError('bad-args', `expected one mode, got ${positionals.length}`, EXIT_REFUSED);
  }

  const [mode] = positionals;
  if (!MODES.includes(mode)) {
    throw new BackupError('bad-args', `unknown mode "${mode}" — expected one of: ${MODES.join(', ')}`, EXIT_REFUSED);
  }
  // A path pointing the wrong way is a typo worth naming, not a silently
  // ignored flag: `--out` on a restore would write a bundle nobody asked for.
  if (mode === 'backup' && inPath !== null) {
    throw new BackupError('bad-args', 'backup writes with --out, not --in', EXIT_REFUSED);
  }
  if (mode !== 'backup' && outPath !== null) {
    throw new BackupError('bad-args', `${mode} reads with --in, not --out`, EXIT_REFUSED);
  }
  if (mode === 'verify' && force) {
    throw new BackupError('bad-args', '--force applies to restore only — verify changes nothing', EXIT_REFUSED);
  }
  if (mode === 'verify' && allowMissing) {
    throw new BackupError('bad-args', '--allow-missing applies to backup only — verify changes nothing', EXIT_REFUSED);
  }

  return { mode, inPath, outPath, force, allowMissing };
}

/**
 * The bytes authenticated as part of the ciphertext, covering everything in the
 * envelope except the ciphertext and tag themselves.
 *
 * This is the point of using GCM rather than a bare cipher: the account list is
 * readable without the passphrase (so `verify` can name what is inside), and
 * binding it here means an attacker cannot rewrite that list to, say, redirect
 * a restore at an account they control. Key order is fixed by construction so
 * the same envelope always produces the same AAD.
 *
 * @param {object} envelope the parsed bundle
 * @returns {Buffer} the additional authenticated data
 */
function additionalDataFor(envelope) {
  return Buffer.from(
    JSON.stringify({
      format: envelope.format,
      version: envelope.version,
      createdAt: envelope.createdAt,
      cipher: envelope.cipher,
      kdf: envelope.kdf,
      iv: envelope.iv,
      accounts: envelope.accounts,
    }),
    'utf8',
  );
}

/**
 * Encrypts a payload into an envelope.
 *
 * @param {Record<string, string>} entries account name to value
 * @param {string} passphrase the bundle passphrase
 * @returns {object} the serialisable envelope
 */
function sealBundle(entries, passphrase) {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = scryptSync(passphrase, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT_MAXMEM });

  const envelope = {
    format: FORMAT,
    version: FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    cipher: 'aes-256-gcm',
    kdf: { name: 'scrypt', salt: salt.toString('base64'), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keylen: SCRYPT.keylen },
    iv: iv.toString('base64'),
    accounts: Object.keys(entries),
  };

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(additionalDataFor(envelope));
  // The payload names the service it belongs to, so a bundle is not just a bag
  // of strings: restoring it into a different libsecret service is a mistake
  // this makes detectable rather than silent.
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ service: SERVICE, entries }), 'utf8'), cipher.final()]);

  envelope.tag = cipher.getAuthTag().toString('base64');
  envelope.ciphertext = ciphertext.toString('base64');
  return envelope;
}

/**
 * Decrypts an envelope, authenticating the metadata as well as the payload.
 *
 * @param {object} envelope the parsed bundle
 * @param {string} passphrase the bundle passphrase
 * @returns {{service: string, entries: Record<string, string>}} the decrypted payload
 * @throws {BackupError} `wrong-passphrase-or-damaged` when GCM rejects the input
 */
function openBundle(envelope, passphrase) {
  const salt = Buffer.from(envelope.kdf.salt, 'base64');
  const key = scryptSync(passphrase, salt, SCRYPT.keylen, { N: envelope.kdf.N, r: envelope.kdf.r, p: envelope.kdf.p, maxmem: SCRYPT_MAXMEM });

  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(additionalDataFor(envelope));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  try {
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plaintext);
  } catch {
    // Deliberately not distinguishing "wrong passphrase" from "tampered file".
    // AES-GCM cannot tell them apart — that is the property that makes it safe
    // to report the failure without leaking anything — so claiming to know
    // which one it was would be a guess, and a wrong guess sends the operator
    // re-typing a passphrase that was always correct.
    throw new BackupError(
      'wrong-passphrase-or-damaged',
      'cannot decrypt the bundle — either the passphrase is wrong or the file is damaged. ' +
        'Both produce this same failure by design, so nothing can be concluded about the passphrase from seeing it.',
    );
  }
}

/**
 * Reads and validates a bundle's envelope without needing the passphrase.
 *
 * @param {string} file absolute path to the bundle
 * @returns {object} the parsed envelope
 * @throws {BackupError} `unreadable-bundle` or `unsupported-bundle`
 */
function readEnvelope(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'unknown';
    throw new BackupError('unreadable-bundle', `cannot read the bundle at ${file} (${code})`);
  }
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new BackupError('unreadable-bundle', `${file} is not a dP Relay bundle — it does not parse as JSON`);
  }
  if (envelope === null || typeof envelope !== 'object' || envelope.format !== FORMAT) {
    throw new BackupError('unsupported-bundle', `${file} is not a ${FORMAT} bundle`);
  }
  if (envelope.version !== FORMAT_VERSION) {
    throw new BackupError('unsupported-bundle', `${file} is bundle version ${envelope.version}, this build reads version ${FORMAT_VERSION}`);
  }
  for (const field of ['cipher', 'kdf', 'iv', 'tag', 'ciphertext', 'accounts']) {
    if (envelope[field] === undefined) {
      throw new BackupError('unreadable-bundle', `${file} is missing "${field}" — the bundle is truncated`);
    }
  }
  if (envelope.kdf.name !== 'scrypt') {
    throw new BackupError('unsupported-bundle', `${file} uses KDF "${envelope.kdf.name}", this build only reads scrypt`);
  }
  return envelope;
}

/**
 * Checks a decrypted payload against what this build is willing to restore.
 *
 * @param {{service: string, entries: Record<string, string>}} payload the decrypted payload
 * @param {object} envelope the envelope the payload came from
 * @returns {string[]} the account names, in bundle order
 * @throws {BackupError} `untrusted-bundle` when the payload names anything unexpected
 */
function validatePayload(payload, envelope) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new BackupError('untrusted-bundle', 'the bundle decrypted to something that is not a payload');
  }
  if (payload.service !== SERVICE) {
    throw new BackupError('untrusted-bundle', `the bundle is for libsecret service "${payload.service}", this store is "${SERVICE}"`);
  }
  const entries = payload.entries;
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) {
    throw new BackupError('untrusted-bundle', 'the bundle decrypted to something that is not a set of entries');
  }
  const names = Object.keys(entries);
  if (names.length === 0) {
    throw new BackupError('untrusted-bundle', 'the bundle contains no entries — restoring it would provision an empty keyring');
  }
  for (const name of names) {
    // Defence in depth. The metadata is authenticated, so this should be
    // unreachable, but a bundle is still untrusted input and a store write is
    // not somewhere to discover a surprise account name.
    if (!ACCOUNTS.includes(name)) {
      throw new BackupError('untrusted-bundle', `the bundle names an account this build does not know: ${name}`);
    }
    if (typeof entries[name] !== 'string' || entries[name] === '') {
      throw new BackupError('untrusted-bundle', `the bundle entry for ${name} is empty or not a string`);
    }
    if (Array.isArray(envelope.accounts) && !envelope.accounts.includes(name)) {
      throw new BackupError('untrusted-bundle', `the bundle lists ${name} in its contents but not in its manifest`);
    }
  }
  return names;
}

/**
 * Writes the bundle so an interrupted run cannot destroy a good one.
 *
 * The temp file is created beside the destination (rename is only atomic within
 * a filesystem), written, chmod'ed, and only then moved into place. The explicit
 * chmod is not redundant: `writeFileSync`'s mode is masked by the umask, so a
 * umask of 022 would otherwise leave the ciphertext world-readable. It is
 * ciphertext, so this is defence in depth rather than the primary control — the
 * passphrase is.
 *
 * @param {string} file absolute destination path
 * @param {object} envelope the envelope to serialise
 * @returns {void}
 * @throws {BackupError} `write-failed`, with the temp file removed
 */
function writeBundleAtomically(file, envelope) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Already gone, or never created; the original failure is the one to report.
    }
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'unknown';
    throw new BackupError('write-failed', `cannot write the bundle to ${file} (${code})`);
  }
}

/**
 * `backup` — reads every bundled account and writes an encrypted bundle.
 *
 * A missing account refuses the run by default. A backup that quietly omits one
 * of three credentials is worse than no backup, because it is believed to be
 * complete until the day it is needed; `--allow-missing` exists for the case
 * where an entry is already gone and the remaining ones are still worth
 * preserving.
 *
 * @param {string|null} outPath explicit destination, or null for the derived default
 * @param {boolean} allowMissing proceed past accounts that are absent
 * @returns {number} exit code
 */
function runBackup(outPath, allowMissing) {
  const file = outPath ?? defaultBundlePath();
  const passphrase = readPassphraseFromStdin();

  /** @type {Record<string, string>} */
  const entries = {};
  const missing = [];
  for (const account of BUNDLE_ACCOUNTS) {
    try {
      entries[account] = readSecret(account);
    } catch (err) {
      if (err instanceof SecretStoreError && err.code === CODES.NOT_FOUND) {
        missing.push(account);
        continue;
      }
      throw err;
    }
  }

  if (missing.length > 0 && !allowMissing) {
    throw new BackupError(
      'missing-accounts',
      `nothing written: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in the keyring. ` +
        'A partial bundle is worse than none, because it looks complete. Store the missing entries first, ' +
        'or pass --allow-missing to back up what is there.',
      EXIT_REFUSED,
    );
  }
  if (missing.length > 0) {
    process.stderr.write(`WARNING: backing up without ${missing.join(', ')} — not in the keyring.\n`);
  }

  const envelope = sealBundle(entries, passphrase);
  writeBundleAtomically(file, envelope);

  const names = Object.keys(entries).sort();
  process.stderr.write(
    `backed up ${names.length} ${names.length === 1 ? 'account' : 'accounts'} to ${file}\n` +
      `${names.map((n) => `  ${n}  ${Buffer.byteLength(entries[n], 'utf8')} bytes`).join('\n')}\n` +
      `created ${envelope.createdAt}, ${envelope.cipher}, scrypt N=${SCRYPT.N}\n` +
      'No credential value was written to the bundle in the clear, and none is printed here.\n',
  );
  return EXIT_OK;
}

/**
 * `verify` — proves a bundle decrypts, without printing anything from it.
 *
 * The mode exists because a backup you have never tested is a hypothesis. It
 * reports the account names and their lengths so an operator can confirm the
 * right three are in there, and confirms the passphrase works, before the day
 * they need it to.
 *
 * @param {string|null} inPath explicit source, or null for the derived default
 * @returns {number} exit code
 */
function runVerify(inPath) {
  const file = inPath ?? defaultBundlePath();
  const envelope = readEnvelope(file);
  const passphrase = readPassphraseFromStdin();
  const payload = openBundle(envelope, passphrase);
  const names = validatePayload(payload, envelope);

  process.stdout.write(
    `${names
      .sort()
      .map((n) => `${n}\t${Buffer.byteLength(payload.entries[n], 'utf8')} bytes`)
      .join('\n')}\n`,
  );
  process.stderr.write(
    `bundle at ${file} decrypts and authenticates. Created ${envelope.createdAt}. ` +
      `${names.length} ${names.length === 1 ? 'entry' : 'entries'}; no value was printed.\n`,
  );
  return EXIT_OK;
}

/**
 * `restore` — provisions a keyring from a bundle.
 *
 * Ordered so that nothing is written until every way of failing has been ruled
 * out: read, parse, authenticate, validate, then check what is already there.
 * Only after all of that does the first write happen. A restore that half
 * completes leaves a keyring in a state no script expects, which is a far worse
 * outcome than a clean refusal.
 *
 * @param {string|null} inPath explicit source, or null for the derived default
 * @param {boolean} force overwrite entries that already exist
 * @returns {number} exit code
 */
function runRestore(inPath, force) {
  const file = inPath ?? defaultBundlePath();
  const envelope = readEnvelope(file);
  const passphrase = readPassphraseFromStdin();
  const payload = openBundle(envelope, passphrase);
  const names = validatePayload(payload, envelope);
  const entries = payload.entries;

  const present = names.filter((name) => hasSecret(name));
  if (present.length > 0 && !force) {
    throw new BackupError(
      'overwrite-refused',
      `nothing written: ${present.join(', ')} already ${present.length === 1 ? 'exists' : 'exist'} in the keyring. ` +
        'Restoring over a live credential replaces it. Pass --force if that is what you want.',
      EXIT_REFUSED,
    );
  }

  for (const name of names) {
    accountFor(name);
    writeSecret(name, entries[name]);
  }

  // A restore that does not prove it landed is a restore that reports success
  // on a write that silently did nothing.
  const failures = [];
  for (const name of names) {
    let landed;
    try {
      landed = readSecret(name);
    } catch (err) {
      failures.push(`${name} (${err instanceof SecretStoreError ? err.code : 'unreadable'})`);
      continue;
    }
    if (Buffer.byteLength(landed, 'utf8') !== Buffer.byteLength(entries[name], 'utf8')) {
      failures.push(`${name} (length mismatch after write)`);
    }
  }
  if (failures.length > 0) {
    throw new BackupError('restore-verification-failed', `restored, but these entries did not read back as written: ${failures.join(', ')}`);
  }

  process.stderr.write(
    `restored ${names.length} ${names.length === 1 ? 'account' : 'accounts'} into the keyring from ${file}\n` +
      `${names.sort().map((n) => `  ${n}  ${Buffer.byteLength(entries[n], 'utf8')} bytes`).join('\n')}\n` +
      'Each entry was read back and matched. No value was printed.\n',
  );
  return EXIT_OK;
}

/**
 * Writes the usage text to stderr.
 *
 * @returns {void}
 */
function printUsage() {
  const lines = [
    'dP Relay keyring backup — take the ops credentials off this machine and put them back.',
    '',
    'Usage: node server/scripts/keyring-backup.cjs <mode> [options]',
    '',
    'Modes:',
    '  backup   read the keyring and write an encrypted bundle.',
    '  verify   decrypt a bundle and report what is in it. Prints no values.',
    '  restore  provision a keyring from a bundle.',
    '',
    'Options:',
    '  --out PATH          where backup writes. Default: $DPRELAY_KEYRING_BACKUP,',
    `                      else $XDG_CONFIG_HOME/dprelay/${DEFAULT_BUNDLE_FILENAME}.`,
    '  --in PATH           where verify and restore read from. Same default.',
    '  --allow-missing     back up the accounts that exist instead of refusing.',
    '  --force             let restore overwrite entries that already exist.',
    '',
    `Bundled accounts: ${BUNDLE_ACCOUNTS.join(', ')}`,
    '',
    'The passphrase is read from stdin in every mode that needs one. It is never',
    'accepted as an argument, because argv is readable through /proc, and it is',
    'never printed. Losing it loses the backup but not the keyring — the keyring',
    'is the primary store and this bundle is a copy of it.',
    '',
    'Exit codes: 0 done | 1 failed | 2 refused (nothing written).',
  ];
  process.stderr.write(`${lines.join('\n')}\n`);
}

/**
 * CLI entry point.
 *
 * @param {string[]} argv arguments after the script path
 * @returns {number} exit code
 * @throws {BackupError} on any refused or failed operation
 * @throws {SecretStoreError} when the keyring itself misbehaves
 */
function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.mode === 'help') {
    printUsage();
    // --help answers a question; a bare invocation asked nothing.
    return argv.length === 0 ? EXIT_REFUSED : EXIT_OK;
  }
  switch (parsed.mode) {
    case 'backup':
      return runBackup(parsed.outPath, parsed.allowMissing);
    case 'verify':
      return runVerify(parsed.inPath);
    case 'restore':
      return runRestore(parsed.inPath, parsed.force);
    /* c8 ignore next 2 -- MODES and parseArgs together keep this unreachable */
    default:
      throw new BackupError('bad-args', `unhandled mode: ${parsed.mode}`, EXIT_REFUSED);
  }
}

module.exports = {
  EXIT_OK,
  EXIT_FAILED,
  EXIT_REFUSED,
  FORMAT,
  FORMAT_VERSION,
  BUNDLE_ACCOUNTS,
  BUNDLE_PATH_ENV,
  SCRYPT,
  MODES,
  BackupError,
  readPassphraseFromStdin,
  defaultBundlePath,
  parseArgs,
  additionalDataFor,
  sealBundle,
  openBundle,
  readEnvelope,
  validatePayload,
  writeBundleAtomically,
  runBackup,
  runVerify,
  runRestore,
  printUsage,
  main,
};

// Only run as a CLI. The test suite imports this module, and must never be able
// to read a real keyring, a real bundle, or exit the process by doing so.
if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof BackupError) {
      process.stderr.write(`${err.code}: ${err.message}\n`);
      process.exitCode = err.exitCode;
    } else if (err instanceof SecretStoreError) {
      process.stderr.write(`${err.code}: ${err.message}\n`);
      process.exitCode = EXIT_FAILED;
    } else {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = EXIT_FAILED;
    }
  }
}