# =============================================================================
# apps/api/Dockerfile
# =============================================================================
# Multi-stage build for the api workspace inside an npm-workspaces monorepo.
# =============================================================================

# -----------------------------------------------------------------------------
# 1. deps -- install ALL deps for the entire monorepo (workspaces resolve here)
# -----------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app

RUN apk add --no-cache openssl libc6-compat

# Copy ALL workspace manifests first so npm ci can resolve the workspace graph.
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY packages ./packages
COPY apps/api/package.json        ./apps/api/
COPY apps/mobile/package.json     ./apps/mobile/
COPY apps/tileserver/package.json ./apps/tileserver/
COPY apps/web/package.json        ./apps/web/
COPY apps/worker/package.json     ./apps/worker/

RUN npm ci --include=dev

# -----------------------------------------------------------------------------
# 2. builder -- copy sources, generate Prisma, build only the api workspace
# -----------------------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache openssl libc6-compat

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/prisma       ./prisma
COPY --from=deps /app/packages     ./packages

COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY apps/api ./apps/api

ENV NODE_ENV=production
RUN npx prisma generate
RUN npm run build --workspace=apps/api

# Strip dev deps for the runner image
RUN npm prune --omit=dev --workspaces --include-workspace-root

# -----------------------------------------------------------------------------
# 3. runner -- slim production image
# -----------------------------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app

RUN apk add --no-cache postgresql16-client dumb-init openssl libc6-compat tzdata && \
    addgroup -S app && adduser -S app -G app

ENV NODE_ENV=production
ENV TZ=UTC

COPY --from=builder --chown=app:app /app/node_modules           ./node_modules
COPY --from=builder --chown=app:app /app/packages               ./packages
COPY --from=builder --chown=app:app /app/apps/api/dist          ./dist
COPY --from=builder --chown=app:app /app/apps/api/package.json  ./package.json
COPY --from=builder --chown=app:app /app/prisma                 ./prisma

USER app
EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
