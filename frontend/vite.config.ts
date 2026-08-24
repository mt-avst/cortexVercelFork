import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig(() => ({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  // shared/config/environment.ts calls frontendEnvSchema.parse(process.env)
  // in validateFrontendEnvironment, and api.ts calls it at module scope. The
  // production build removes every process.env reference - grep all 34 built
  // chunks and there are none - so only the dev server leaves the bare reference
  // standing, where it throws "process is not defined" before the app renders.
  // That is why local work moved to `vite preview` and paid a full rebuild per
  // change.
  //
  // `define` does not fix it: Vite leaves a bare `process.env` alone in serve
  // mode, verified by curling the transformed module and finding the reference
  // still there. Injecting the shim into the dev HTML does work, and `apply:
  // 'serve'` means the plugin cannot reach the build at all.
  //
  // An empty object is the correct shim rather than a stand-in for real values:
  // every field in frontendEnvSchema has a .catch() or is .optional(), so
  // parsing {} yields the documented defaults (VITE_API_URL ->
  // http://localhost:3001, VITE_ENVIRONMENT -> development), which is the same
  // outcome the build already produces.
  plugins: [
    react(),
    {
      name: 'dev-process-env-shim',
      apply: 'serve' as const,
      transformIndexHtml() {
        return [
          {
            tag: 'script',
            injectTo: 'head-prepend' as const,
            children: 'window.process = window.process || { env: {} };',
          },
        ];
      },
    },
  ],
  server: {
    port: 3000,
    // Fail loudly on a taken port rather than drifting to the next one, which
    // on this stack is 3001 - the backend.
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:3001',
      '/auth': 'http://localhost:3001',
    },
  },
  build: {
    outDir: 'dist',
  },
}))

