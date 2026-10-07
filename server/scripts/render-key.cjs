/**
 * The one place every ops script resolves the Render API key from.
 *
 * The key used to live inline in `.kilo/kilo.jsonc`, and eleven scripts each
 * re-implemented "read the JSONC, strip // comments, drill into
 * mcp.render.environment.RENDER_API_KEY". That put a live production credential
 * in a file that is only *accidentally* gitignored, and it meant a script had to
 * be inside a clone of this exact repo, on a machine with that exact home
 * directory, before it could run at all.
 *
 * It then lived in `~/.config/dprelay/render-api-key` at mode 0600, which stops
 * other users but not backups, sync agents, or a stolen already-unlocked
 * laptop. It now lives in the login keyring; see `server/scripts/secret-store.cjs`.
 *
 * Resolution order, first hit wins:
 *
 *   1. `RENDER_API_KEY`      — CI, containers, an exported shell.
 *   2. `$RENDER_API_KEY_FILE`— an explicit path, for a headless runner that
 *      cannot reach a session keyring at all.
 *   3. the OS keyring        — the owner's own machine, via secret-store.cjs.
 *
 * Both file paths are explicit operator choices. There is deliberately no
 * implicit default file and no legacy `.kilo/kilo.jsonc` fallback any more: a
 * silent downgrade to a plaintext copy is exactly the behaviour this migration
 * exists to remove, and an unmigrated checkout is better served by a clear
 * error naming the command that fixes it.
 *
 * The value is never logged, and no error message here embeds it — a script
 * that prints its own resolution failure must not print the secret it failed to
 * find. Callers get the key or an `Error` naming the sources that were tried.
 *
 * Written as CommonJS with no imports of its own beyond node builtins and the
 * local secret store, so that plain `node script.cjs` works and the TypeScript
 * selftest can pull it in through `createRequire` without a build step.
 */
const { readFileSync, statSync } = require('node:fs');

const { readSecret, SecretStoreError } = require('./secret-store.cjs');

/** Env var naming an explicit key file, so CI and containers can point anywhere. */
const KEY_FILE_ENV = 'RENDER_API_KEY_FILE';

/**
 * Keyring account holding the Render API key.
 *
 * A literal rather than an import, because this is the same string the bash
 * wrapper next to the MCP server has to hardcode; `server/test/secret-store.test.ts`
 * asserts it is one of secret-store's ACCOUNTS, so the two cannot drift apart
 * silently.
 */
const RENDER_KEY_ACCOUNT = 'render-api-key';

/**
 * A world- or group-readable key file is a leak waiting to happen, so it is
 * reported — as a warning on stderr, never as a hard failure. Refusing outright
 * would break a legitimate shared-box setup over a mode bit the operator can
 * fix, and silently accepting it would leave the whole migration cosmetic.
 *
 * @param {string} file absolute path to the key file
 * @returns {string|null} the warning text, or null when the mode is safe
 */
function keyFileModeWarning(file) {
  let mode;
  try {
    mode = statSync(file).mode & 0o777;
  } catch {
    return null; // unreadable: the caller reports that with a better message.
  }
  if (mode & 0o077) {
    return `WARNING: ${file} is mode ${mode.toString(8).padStart(3, '0')} — readable beyond you. Run: chmod 600 ${file}`;
  }
  return null;
}

/**
 * Reads an explicitly-named key file, treating an empty file as absent.
 *
 * An empty file is the exact state left behind by a half-finished migration or
 * an editor that truncated it, and treating it as a valid key would produce a
 * 401 from Render instead of a message that says where to put the key.
 *
 * @param {string} file path to read
 * @returns {string} the trimmed key
 * @throws {Error} when the file is missing, unreadable, or blank
 */
function readKeyFile(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : 'unknown';
    throw new Error(`cannot read Render API key from ${file} (${code})`);
  }
  const key = raw.trim();
  if (key === '') throw new Error(`${file} is empty — put the Render API key in it, one line, no quotes`);
  const warning = keyFileModeWarning(file);
  if (warning) process.stderr.write(`${warning}\n`);
  return key;
}

/**
 * The Render API key, or a thrown error naming every source that was tried.
 *
 * Never cached here: caching is the caller's choice, and a module-level cache
 * would freeze the key for the life of a long-lived process — which is exactly
 * the trap the lazy read in `set-alert-channel.cjs` already had to undo.
 *
 * @param {object} [opts]
 * @param {Record<string, string|undefined>} [opts.env] environment to read; defaults to `process.env`
 * @returns {string} the Render API key
 * @throws {Error} when no source supplies a key
 */
function resolveRenderApiKey(opts = {}) {
  const env = opts.env ?? process.env;

  const fromEnv = env.RENDER_API_KEY;
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim();

  const explicit = env[KEY_FILE_ENV];
  if (explicit !== undefined && explicit.trim() !== '') {
    return readKeyFile(explicit.trim());
  }

  let key;
  try {
    // The keyring is the owner's own store and is not whitespace-padded, but
    // trim anyway: a stray newline here would surface as an opaque Render 401.
    key = readSecret(RENDER_KEY_ACCOUNT, { env }).trim();
  } catch (err) {
    if (err instanceof SecretStoreError) {
      throw new Error(
        `no Render API key. The login keyring could not supply one (${err.code}: ${err.message}). ` +
          `For a headless runner with no session keyring, set ${KEY_FILE_ENV} or RENDER_API_KEY instead.`,
      );
    }
    throw err;
  }

  if (key === '') {
    throw new Error(
      `the keyring returned an empty Render API key — re-store it with: secret-tool store --label='dP Relay render-api-key' service dprelay account ${RENDER_KEY_ACCOUNT}`,
    );
  }
  return key;
}

module.exports = { resolveRenderApiKey, KEY_FILE_ENV };
