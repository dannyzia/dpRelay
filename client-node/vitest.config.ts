import { defineConfig } from "vitest/config";

/**
 * Node-environment unit + contract tests for the SDK.
 *
 * Coverage thresholds are pinned at 100% for statements, branches, functions
 * and lines because ISSUE-115 requires the whole client surface — including
 * every error-handling branch — to be exercised. A new branch that ships
 * untested fails `npm test` instead of silently eroding the guarantee.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
