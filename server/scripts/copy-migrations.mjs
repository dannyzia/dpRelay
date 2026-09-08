// Copies SQL migrations into dist/ — tsc only compiles TS, it drops .sql assets.
// Cross-platform (no cp dependency) so it works on dev machines and Render alike.
import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
cpSync(join(root, "src", "migrations"), join(root, "dist", "migrations"), {
  recursive: true,
});
console.log("migrations copied → dist/migrations");
