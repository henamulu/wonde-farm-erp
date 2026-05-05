# =============================================================================
# apps/worker/Dockerfile
# =============================================================================

FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache openssl libc6-compat

COPY package.json package-lock.json ./
COPY apps/worker/package.json ./apps/worker/
COPY prisma ./prisma

RUN npm ci --include=dev --workspace=@farm-erp/worker --include-workspace-root

FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache openssl libc6-compat
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY prisma ./prisma
COPY apps/worker ./apps/worker

ENV NODE_ENV=production
RUN npx prisma generate
RUN npm run build --workspace=@farm-erp/worker
RUN npm prune --omit=dev --workspace=@farm-erp/worker

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
COPY --from=builder --chown=app:app /app/apps/worker/package.json ./package.json

USER app
EXPOSE 3001
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]