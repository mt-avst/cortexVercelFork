/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string
  readonly VITE_API_BASE_URL: string
  readonly VITE_AUTH_BASE_URL: string
  readonly VITE_ENVIRONMENT: string
  readonly VITE_ENABLE_ANALYTICS: string
  readonly VITE_ENABLE_DEBUG: string
  /** Set to 'true' to show Demo Access pills on landing (e.g. staging). Hidden in production when unset. */
  readonly VITE_SHOW_DEMO_LOGIN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

