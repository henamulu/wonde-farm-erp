# =============================================================================
# apps/worker/Dockerfile
# =============================================================================
# Worker image. Includes GDAL CLI (for COG conversion in the NDVI job) and
# psql (handy for ad-hoc queries from inside the container).
# =============================================================================

FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache openssl libc6-compat
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY packages ./packages
RUN npm ci --include=dev

FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache openssl libc6-compat
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/prisma ./prisma
COPY . .
ENV NODE_ENV=production
RUN npx prisma generate
# We assume the monorepo build emits dist/main.js for each app; adjust the
# build script if you use a different output layout.
RUN npm run build --workspace=apps/worker
RUN npm prune --omit=dev

FROM node:22-alpine AS runner
WORKDIR /app
RUN apk add --no-cache \
        dumb-init \
        openssl \
        libc6-compat \
        tzdata \
        gdal-tools \
        postgresql16-client && \
    addgroup -S app && adduser -S app -G app

ENV NODE_ENV=production
ENV TZ=UTC

COPY --from=builder --chown=app:app /app/node_modules           ./node_modules
COPY --from=builder --chown=app:app /app/apps/worker/dist       ./dist
COPY --from=builder --chown=app:app /app/prisma                 ./prisma
COPY --from=builder --chown=app:app /app/package.json           ./package.json

USER app
EXPOSE 3001
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
