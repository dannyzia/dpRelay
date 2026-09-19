/**
 * Boot-script regression tests (ISSUE-13): scripts/start-server.mjs is the
 * Render entrypoint but sits outside every other gate — tsc does not check
 * .mjs and the unit suites never spawn it — so a syntax slip there merged to
 * master undetected. These tests pin (1) syntax validity and (2) the fix that
 * unblocked deploys: litestream must be spawned from the downloaded binary
 * path, never bare from PATH (Render's Node image has no litestream binary).
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(serverRoot, "scripts", "start-server.mjs");

describe("boot script (scripts/start-server.mjs)", () => {
  it("is syntactically valid (tsc does not cover .mjs)", () => {
    expect(() =>
      execFileSync(process.execPath, ["--check", scriptPath], { stdio: "pipe" }),
    ).not.toThrow();
  });

  it("spawns the bundled litestream binary by path, never bare from PATH", () => {
    const src = readFileSync(scriptPath, "utf8");
    // Both spawn sites (restore + replicate) target the downloaded binary.
    expect(src).toMatch(/run\(\[\s*\n\s*litestreamPath,/g);
    // A bare "litestream" string as the spawn target is the ENOENT bug shape.
    expect(src).not.toMatch(/run\(\s*\[?\s*"litestream"/);
  });
});
