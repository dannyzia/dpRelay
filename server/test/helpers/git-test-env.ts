/**
 * The git overrides git exports into a hook environment, shared by every suite
 * that spawns its own repositories (ISSUE-107, T3).
 *
 * Why this lives in one file instead of inline in each suite: four suites
 * re-declared this same six-entry list by hand, and a suite that forgets one
 * entry — or a fifth suite that never learns the list exists — is exactly how
 * the `feat/ops-git-hooks-stage-c-fold` incident happened. git exports `GIT_DIR`
 * into a hook environment, an inherited value defeats the rig's own
 * `git init`, and every `git commit`/`git push` that follows lands on the REAL
 * repository while the assertions still describe a throwaway one: the branch
 * was gutted to 524 files by its own test suite. One list, imported four ways,
 * can only be missed by not importing it.
 *
 * Suites come in two shapes and both are covered here:
 *   - suites that spawn without an explicit `env:` clear the live
 *     `process.env` with `DANGEROUS_GIT_VARS`, because grandchildren forked by
 *     a shell inherit it too;
 *   - suites that hand a child an explicit environment pass
 *     `scrubGitEnv(process.env)`, so the scrub cannot be lost by one call site
 *     that builds `env:` from scratch.
 */

/**
 * Every git override that redirects git at a repository other than the current
 * working directory. Removing any one of them is required, not optional: each
 * alone is enough to defeat a scratch `git init`.
 */
export const DANGEROUS_GIT_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
] as const;

/**
 * A copy of `env` with every dangerous git override removed.
 *
 * Returns a NEW object and never mutates the argument, so a suite can hand the
 * result to a child process without changing how any of its other children
 * run. The default argument is the live process environment, which is what
 * every call site in this suite passes.
 *
 * @param env environment to clean; defaults to `process.env`
 * @returns a clean copy of `env`, safe to give to a spawned child
 */
export function scrubGitEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const clean = { ...env };
  for (const v of DANGEROUS_GIT_VARS) {
    delete clean[v];
  }
  return clean;
}
