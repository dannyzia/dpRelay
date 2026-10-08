/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Build-time API base; empty/absent = same origin. */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
