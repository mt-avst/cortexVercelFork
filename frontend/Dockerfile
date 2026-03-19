# Multi-stage build for React frontend
FROM docker.adaptavist.net/node:22-alpine AS builder

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

ARG VITE_API_URL
ENV VITE_API_URL=${VITE_API_URL}

# Build the application
RUN cd /app/frontend && npm run build

# Production stage
FROM docker.adaptavist.net/nginx:alpine

# Copy built assets from builder stage
COPY --from=builder /app/frontend/dist /usr/share/nginx/html

# Copy custom nginx configuration
COPY frontend/nginx.conf.template /etc/nginx/templates/default.conf.template

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
