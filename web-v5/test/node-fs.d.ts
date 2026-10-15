/**
 * Minimal ambient declaration for the one `node:fs` call the tests use.
 *
 * web-v5's tsconfig sets `"types": ["vite/client"]` and ships no @types/node,
 * so `readFileSync` would otherwise be a compile error (ISSUE-112 style guard
 * that reads src/styles.css from disk — vitest's CSS pipeline returns an empty
 * string for `styles.css?raw`/`?inline`, so the file has to be read directly).
 * Declaring the exact signature used beats adding a whole type package for it.
 */
declare module "node:fs" {
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
}
