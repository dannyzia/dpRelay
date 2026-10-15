/**
 * Dual-build post-step.
 *
 * tsc cannot emit a package.json boundary, but Node picks the module system
 * from the NEAREST package.json. This package is `"type": "module"` (so
 * dist/esm/*.js loads as ESM), which would also make dist/cjs/*.js parse as
 * ESM — `require()` would then throw ERR_REQUIRE_ESM, and TypeScript would
 * treat the CJS .d.ts files as ESM declarations under node16 resolution.
 * Writing `{"type":"commonjs"}` inside dist/cjs is what makes the CommonJS
 * half of the distribution actually load as CommonJS.
 */
import { writeFileSync } from "node:fs";

const target = new URL("../dist/cjs/package.json", import.meta.url);
writeFileSync(target, `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`);
console.log("dist/cjs/package.json written (type: commonjs)");
