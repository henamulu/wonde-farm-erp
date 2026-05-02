# =============================================================================
# apps/api/Dockerfile
# =============================================================================
# Multi-stage build:
#   1. deps    — install all deps (dev + prod) for building
#   2. builder — generate Prisma client, compile TS
#   3. runner  — slim production image, only prod deps + dist
#
# psql is included in the runner stage because the api-migrate one-shot
# service needs it to apply postgis-setup.sql / tile-functions.sql.
# =============================================================================

# -----------------------------------------------------------------------------
# 1. deps
# -----------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app

# OpenSSL needed by Prisma; tini for proper signal handling later
RUN apk add --no-cache openssl libc6-compat

COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY packages ./packages
RUN npm ci --include=dev

# -----------------------------------------------------------------------------
# 2. builder
# -----------------------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache openssl libc6-compat

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/prisma ./prisma
COPY . .

ENV NODE_ENV=production
RUN npx prisma generate
RUN npm run build  # produces dist/main.js + dist/worker.js

# Strip dev deps for the runner image
RUN npm prune --omit=dev

# -----------------------------------------------------------------------------
# 3. runner
# -----------------------------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app

# psql for migrations, dumb-init for proper PID-1 signal handling
RUN apk add --no-cache postgresql16-client dumb-init openssl libc6-compat tzdata && \
    addgroup -S app && adduser -S app -G app

ENV NODE_ENV=production
ENV TZ=UTC

# Production deps + compiled output
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/dist         ./dist
COPY --from=builder --chown=app:app /app/prisma       ./prisma
COPY --from=builder --chown=app:app /app/package.json ./package.json

# Copy the SQL files used by api-migrate
# (these live next to schema.prisma in the repo)
COPY --from=builder --chown=app:app /app/prisma/postgis-setup.sql  ./prisma/postgis-setup.sql
COPY --from=builder --chown=app:app /app/prisma/tile-functions.sql ./prisma/tile-functions.sql

USER app
EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
