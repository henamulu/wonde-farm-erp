# =============================================================================
# apps/tileserver/Dockerfile
# =============================================================================
# Tiny Fastify service. Single-stage build is fine here — the deps are small.
# =============================================================================

FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache openssl libc6-compat
COPY apps/tileserver/package.json apps/tileserver/package-lock.json* ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY apps/tileserver ./
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runner
WORKDIR /app
RUN apk add --no-cache dumb-init openssl libc6-compat tzdata && \
    addgroup -S app && adduser -S app -G app
ENV NODE_ENV=production
ENV TZ=UTC

COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/dist         ./dist
COPY --from=builder --chown=app:app /app/package.json ./package.json

USER app
EXPOSE 7800
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
