/**
 * Regenerates docs/Plan/27-OPENAPI-SPEC.json from the live route table.
 * The committed spec is a contract: a unit test fails when routes drift from it,
 * so adding a route means running this rather than hand-editing the JSON.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../app.js";

/** server/src/scripts -> repo root, so the committed spec lands in docs/Plan. */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

async function main(): Promise<void> {
  const dbPath = join(mkdtempSync(join(tmpdir(), "dprelay-spec-")), "spec.db");
  const app = buildApp({
    dbPath,
    env: { JWT_SECRET: "spec-gen-only-secret-0123456789abcdef0123456789" },
  });
  await app.ready();
  const spec = (await app.inject({ method: "GET", url: "/docs/json" })).json();
  writeFileSync(join(repoRoot, "docs/Plan/27-OPENAPI-SPEC.json"), JSON.stringify(spec, null, 2) + "\n");
  await app.close();
  console.log("regenerated docs/Plan/27-OPENAPI-SPEC.json");
  // buildApp leaves background handles (job runner, litestream) registered on the
  // process, so a clean close still does not let the event loop drain. Exit hard
  // once the file is safely on disk; this is a one-shot generator, not a server.
  process.exit(0);
}

void main();
