import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Cloudflare Pages static SPA: the API base is baked at build time from
// VITE_API_BASE_URL (dashboard/.env.example documents it; `npm run build`
// defaults it to the production API so a no-env build is deployable as-is).
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist" },
});
