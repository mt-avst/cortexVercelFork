// Vercel Function entry: the whole Express API (backend/) served as one function.
// vercel.json rewrites /api/* and /auth/* here; Express still sees the original
// path, so every route mounts exactly as it does on Kubera.
//
// Requires the COMPILED backend: vercel.json's buildCommand runs `tsc` in
// backend/ before Vercel bundles this function, so dist/ exists when the
// bundler traces this require.

// Same-origin redirects need to know this deployment's own address. On Kubera
// CORS_ORIGIN is set per environment; on Vercel the address differs per branch,
// so derive it from what the platform provides unless it was set explicitly.
// Runs before the backend config module validates the environment.
if (!process.env.CORS_ORIGIN) {
  const host =
    process.env.VERCEL_ENV === 'production'
      ? process.env.VERCEL_PROJECT_PRODUCTION_URL
      : process.env.VERCEL_BRANCH_URL || process.env.VERCEL_URL;
  if (host) {
    process.env.CORS_ORIGIN = `https://${host}`;
    if (!process.env.FRONTEND_URL) process.env.FRONTEND_URL = process.env.CORS_ORIGIN;
  }
}

module.exports = require('../backend/dist/backend/src/index.js').default;
