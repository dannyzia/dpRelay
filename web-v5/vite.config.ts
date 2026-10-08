import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Vite + Vitest share this config so tests run through the same transform
 * pipeline as the build (identical to how the server suite runs vitest).
 * `node` environment is enough: component tests render via
 * react-dom/server (no DOM), and api-client tests polyfill sessionStorage
 * in test/setup.ts — keeping jsdom out of the dependency tree.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    setupFiles: ["test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
