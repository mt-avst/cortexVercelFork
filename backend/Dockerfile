# Use Node.js 20 LTS as base image
FROM node:20.20.2-alpine3.22

# Pull in Alpine 3.22.5 package updates (libssl3/libcrypto3 3.5.7-r0, fixes
# CVE-2026-45447). No node:*-alpine3.22 image has been rebuilt against this
# point release yet, so apply it explicitly until the base image catches up.
RUN apk update && apk upgrade --no-cache && rm -rf /var/cache/apk/*

# The npm CLI bundled with node:20.20.2 vendors vulnerable copies of tar,
# glob, minimatch, sigstore, cross-spawn and brace-expansion (16 HIGH + 1
# CRITICAL trivy findings) - upgrade npm itself until a rebuilt base image
# ships with a patched CLI. npm is runtime-load-bearing here (CMD npm start).
# Exact pin for reproducible image builds - bump deliberately, in git.
RUN npm install -g npm@11.18.0 && npm cache clean --force

# Set working directory
WORKDIR /app

COPY package*.json ./
# Full install, dev dependencies included: the build genuinely needs them.
# shared/ has no package.json of its own, so its sources resolve types by
# walking up to /app/node_modules - shared/types/index.ts and
# shared/test-utils/index.ts both import from express, and tsc fails with
# "Cannot find module 'express'" if @types/express is not here. They are pruned
# after the build instead, further down.
RUN npm ci
# Copy shared and demo folders (referenced by backend source)
COPY shared/ ./shared/
COPY demo/ ./demo/

WORKDIR /app/backend

COPY backend/package*.json .
RUN npm ci
# Copy backend source. This includes backend/certs/rds-global-bundle.pem, the
# AWS RDS trust store - the RDS roots are private and self-signed, so Node
# cannot verify an RDS certificate without it. Shipping it in the image is what
# makes DB_TLS_VERIFY=1 a one-variable change rather than a piece of cluster
# work. See backend/src/config/dbTls.ts.
COPY backend/ .

# Build the application with increased memory
RUN NODE_OPTIONS="--max-old-space-size=4096" npm run build

# Remove dev dependencies after build.
#
# TWO prunes, because there are two node_modules trees and this one only ever
# reached the backend's. /app/node_modules keeps the root's tooling - ESLint,
# a TypeScript compiler, Playwright - which is needed to BUILD (see above) and
# by nothing at runtime. Left unpruned it is ~36MB and 100+ packages of pure
# scan surface in the shipped image, in a file that already fights 16 HIGH +
# 1 CRITICAL trivy findings in the bundled npm CLI.
#
# The root's real runtime dependencies, pg and zod, are `dependencies` rather
# than devDependencies and so survive the prune - which matters, because
# shared/ resolves zod from here at runtime too.
RUN npm prune --production
RUN cd /app && npm prune --omit=dev

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodejs -u 1001

# Change ownership of the app directory
RUN chown -R nodejs:nodejs /app
USER nodejs

# Expose port
EXPOSE 3001

# Which commit this image was built from, surfaced at GET /api/health so a
# deploy is verifiable from outside with one unauthenticated request rather
# than inferred from a green pipeline and a guess at the ArgoCD lag.
#
# The COMMIT and not the release version, because the version does not exist
# yet at this point: images are built on the main-branch pipeline and
# semantic-release cuts the tag afterwards, so CI_COMMIT_REF_NAME here is
# `main`. See backend/src/utils/buildInfo.ts for the full reasoning and for
# how a version is recovered from the sha.
#
# Declared LAST so that changing commit does not invalidate the cached layers
# for npm ci and the build above. Defaults to empty rather than to a fake sha:
# buildInfo.ts reports `unknown` for anything that is not a commit sha, so a
# build argument that never arrives is visible rather than silently plausible.
ARG APP_COMMIT_SHA=""
ENV APP_COMMIT_SHA=$APP_COMMIT_SHA

# Defence in depth for the mock-data gate in utils/database.ts: with no
# NODE_ENV and no database configured, the app would serve demo fixtures.
# Kubera sets NODE_ENV=production explicitly; this makes the image safe on
# its own rather than relying on that.
ENV NODE_ENV=production

# Start the application
CMD ["npm", "start"]
