/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the optional XinChao-Cut backend (e.g. http://127.0.0.1:8000). */
  readonly VITE_BACKEND_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
