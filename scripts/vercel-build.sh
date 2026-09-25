#!/usr/bin/env bash
# Vercel build: compile the API, build the SPA, migrate this deployment's database.
#
# Each preview gets its own Neon branch (Neon <-> Vercel integration), so
# migrating here migrates only that branch. Production migrates BEFORE the new
# build is promoted, which is safe only because Cortex migrations are additive
# and idempotent (docs/adr/0005) - the running version keeps working against
# the newer schema. Same chain the Kubera initContainer runs on every pod start.
set -euo pipefail

npm --prefix backend run build
npm --prefix frontend run build

if [ -n "${DATABASE_URL:-}${POSTGRES_URL:-}${POSTGRESQL_URL:-}${DB_URL:-}" ]; then
  npm --prefix backend run migrate
  npm --prefix backend run seed
  npm --prefix backend run migrate:firsthand
else
  echo "vercel-build: no database URL in this build's environment - skipping migrations."
  echo "vercel-build: connect Neon to the project (Storage tab) so each deployment gets one."
fi
