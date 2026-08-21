# Multi-stage build for React frontend
FROM node:20-alpine AS builder

WORKDIR /app

# Install root-level dependencies (provides zod and shared types deps)
COPY package*.json ./
RUN npm ci

# Copy shared folder (referenced by frontend via ../shared)
COPY shared/ ./shared/

# Copy frontend package files and install frontend dependencies
COPY frontend/package*.json ./frontend/
RUN cd /app/frontend && npm ci

# Copy frontend source
COPY frontend/ ./frontend/

# Copy the build scripts the frontend build calls (write-frontend-version.js
# writes dist/version.json). Kept as its own COPY rather than folded into the
# root package copy above so that editing an unrelated script does not
# invalidate the npm ci layers.
COPY scripts/ ./scripts/

# Which commit this image was built from, served at /version.json so a frontend
# deploy is verifiable with one unauthenticated request. The frontend and
# backend pods roll independently, so the backend's /api/health cannot answer
# for this one.
#
# The COMMIT and not the release version: images are built on the main-branch
# pipeline and semantic-release cuts the tag afterwards, so no version exists
# yet. See scripts/lib/build-revision.js.
#
# Empty default, not a fake sha: anything that is not a commit sha is written as
# `unknown`, so a build argument that never arrives is visible rather than
# silently plausible.
ARG APP_COMMIT_SHA=""
ENV APP_COMMIT_SHA=$APP_COMMIT_SHA

# Build the application
RUN cd /app/frontend && npm run build

# Production stage
FROM nginx:alpine

# Copy built assets from builder stage
COPY --from=builder /app/frontend/dist /usr/share/nginx/html

# Copy custom nginx configuration
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

# Change ownership
RUN chown -R nginx:nginx /usr/share/nginx/html
RUN chown -R nginx:nginx /var/cache/nginx
RUN chown -R nginx:nginx /var/log/nginx
RUN chown -R nginx:nginx /etc/nginx/conf.d
RUN touch /var/run/nginx.pid
RUN chown -R nginx:nginx /var/run/nginx.pid

# Switch to non-root user
USER nginx

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
