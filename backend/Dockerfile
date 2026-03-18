# Use Node.js 18 LTS as base image
FROM docker.adaptavist.net/node:18-alpine

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
