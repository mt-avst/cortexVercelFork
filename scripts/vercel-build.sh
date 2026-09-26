#!/usr/bin/env bash
# Vercel build: compile the API, build the SPA, migrate this deployment's Neon database.
#
# Each preview gets its own Neon branch (Neon <-> Vercel integration), so
# migrating here migrates only that branch. Production migrates BEFORE the new
# build is promoted, which is safe only because Cortex migrations are additive
# and idempotent (docs/adr/0005) - the running version keeps working against
# the newer schema. Same chain the Kubera initContainer runs on every pod start.
set -euo pipefail

# The commit this build is from, for frontend/dist/version.json and the API's
# /api/health `revision` - the Dockerfile's APP_COMMIT_SHA build arg on Kubera.
export APP_COMMIT_SHA="${APP_COMMIT_SHA:-${VERCEL_GIT_COMMIT_SHA:-}}"

# Neon is the only database on Vercel, from the variables its integration sets
# (backend/src/config/databaseUrl.ts). No Neon connection is a failed build, not
# a deployment that ships and then crashes on its first request.
if [ -z "${DATABASE_URL:-}${POSTGRES_URL:-}" ]; then
  echo "vercel-build: no DATABASE_URL or POSTGRES_URL for this environment." >&2
  echo "vercel-build: connect Neon in the project's Storage tab (Production and Preview) and redeploy." >&2
  exit 1
fi

npm --prefix backend run build
npm --prefix frontend run build

npm --prefix backend run migrate
npm --prefix backend run seed
npm --prefix backend run migrate:firsthand
