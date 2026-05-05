# =============================================================================
# apps/tileserver/Dockerfile
# =============================================================================
# Builds the tileserver using the root lockfile + workspace install.
# Build context must be the repo root (not apps/tileserver).
# =============================================================================

FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache openssl libc6-compat

# Pull root manifests + the tileserver workspace manifest
COPY package.json package-lock.json ./
COPY apps/tileserver/package.json ./apps/tileserver/

# Install only the tileserver workspace's deps + its dev deps (we need tsc)
RUN npm ci --include=dev --workspace=@farm-erp/tileserver --include-workspace-root

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY apps/tileserver ./apps/tileserver

RUN npm run build --workspace=@farm-erp/tileserver
RUN npm prune --omit=dev --workspace=@farm-erp/tileserver

FROM node:22-alpine AS runner
WORKDIR /app
RUN apk add --no-cache dumb-init openssl libc6-compat tzdata && \
    addgroup -S app && adduser -S app -G app
ENV NODE_ENV=production
ENV TZ=UTC

COPY --from=builder --chown=app:app /app/node_modules                       ./node_modules
COPY --from=builder --chown=app:app /app/apps/tileserver/dist               ./dist
COPY --from=builder --chown=app:app /app/apps/tileserver/package.json       ./package.json

USER app
EXPOSE 7800
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
