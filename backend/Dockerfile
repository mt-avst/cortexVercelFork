# Use Node.js 20 LTS as base image
FROM node:20.20.2-alpine3.22

# Pull in Alpine 3.22.5 package updates (libssl3/libcrypto3 3.5.7-r0, fixes
# CVE-2026-45447). No node:*-alpine3.22 image has been rebuilt against this
# point release yet, so apply it explicitly until the base image catches up.
RUN apk update && apk upgrade --no-cache && rm -rf /var/cache/apk/*

# Phase C (TEMPORARY - remove after the FirstHand data migration completes):
# pg_dump/psql 17.x for scripts/firsthand-data-migrate.mjs, which runs as a
# chart Job streaming the firsthand schema between the two RDS instances.
RUN apk add --no-cache postgresql17-client

# Set working directory
WORKDIR /app

COPY package*.json ./
RUN npm ci
# Copy shared and demo folders (referenced by backend source)
COPY shared/ ./shared/
COPY demo/ ./demo/

WORKDIR /app/backend

COPY backend/package*.json .
RUN npm ci
# Copy backend source
COPY backend/ .

# Build the application with increased memory
RUN NODE_OPTIONS="--max-old-space-size=4096" npm run build

# Remove dev dependencies after build
RUN npm prune --production

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodejs -u 1001

# Change ownership of the app directory
RUN chown -R nodejs:nodejs /app
USER nodejs

# Expose port
EXPOSE 3001

# Start the application
CMD ["npm", "start"]
