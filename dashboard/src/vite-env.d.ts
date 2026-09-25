/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the dP Relay v5 API (build-time; see .env.example). */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
