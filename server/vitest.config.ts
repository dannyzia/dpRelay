import { defineConfig } from "vitest/config";

/**
 * The suite previously ran with no config at all. ISSUE-50 needs one so the
 * run ends with a leak assertion (test/global-setup.ts): if any test scratch
 * directory survives the run, `npm test` fails and names it.
 */
export default defineConfig({
  test: {
    globalSetup: ["test/global-setup.ts"],
  },
});
