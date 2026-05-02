# Wonde Farm ERP

GIS-native, offline-first ERP for farm operations. Every operational entity (crop plan, harvest, contract, activity, attendance) is anchored to a geometry in PostGIS — the map *is* the system, not a layer on top of it.

> **Status**: Early scaffolding. Schema, infrastructure, and core flows are implemented; many feature modules are stubs. See [`docs/architecture.md`](docs/architecture.md) for the full plan.

---

## Quick start (local)

Prerequisites: Docker, Node 22+, npm.

```bash
# 1. Configure secrets
cp .env.example .env
# edit .env — set passwords, JWT secrets (use `openssl rand -base64 48`)

# 2. Boot infrastructure
docker compose up -d postgres minio mosquitto redis
docker compose run --rm minio-init

# 3. Apply schema, RLS triggers, tile functions
docker compose --profile migrate run --rm api-migrate

# 4. Seed the demo tenant (497 ha farm near Mizan Teferi, Ethiopia)
docker compose --profile seed run --rm api-seed

# 5. Bring up the API, worker, tileserver, and Caddy
docker compose up -d

# 6. Verify
curl http://localhost/health      # → "ok"
```

Login as `owner@mizan-investment.test` / `changeme`.

---

## Repository layout

```
wonde-farm-erp/
├── apps/
│   ├── api/           NestJS REST API (auth, sync, geom validation)
│   ├── tileserver/    Tenant-aware MVT vector tile server
│   ├── worker/        BullMQ background jobs (NDVI, reports, GC)
│   ├── web/           React + OpenLayers admin UI
│   └── mobile/        React Native + WatermelonDB (offline-first)
├── prisma/            Schema, migrations, raw PostGIS SQL, seed
├── e2e/               Playwright end-to-end tests
├── infra/             Caddy, Postgres init, Mosquitto config
├── .github/workflows/ CI + Hetzner deploy pipelines
└── docs/              Architecture document
```

---

## What's where

| You want to… | Look at |
|---|---|
| Understand the architecture | [`docs/architecture.md`](docs/architecture.md) |
| Modify the data model | [`prisma/schema.prisma`](prisma/schema.prisma) |
| Add a tile layer | [`prisma/tile-functions.sql`](prisma/tile-functions.sql) + [`apps/tileserver/src/server.ts`](apps/tileserver/src/server.ts) |
| Add an API endpoint | [`apps/api/src/`](apps/api/src/) |
| Add a background job | [`apps/worker/src/queues.ts`](apps/worker/src/queues.ts) |
| Test a draw/edit flow | [`e2e/specs/`](e2e/specs/) |
| Deploy to production | Push to `main` — see [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) |

---

## Tech stack

- **Database**: PostgreSQL 16 + PostGIS 3.4 (RLS multi-tenancy, generated columns, validation triggers)
- **API**: NestJS 10 + Prisma 5 (modular monolith)
- **Tile server**: Fastify + native `pg`, custom MVT renderer with per-tenant ETag caching
- **Worker**: BullMQ + Redis
- **Web**: React 18 + Vite + OpenLayers 10 + Tailwind + shadcn/ui
- **Mobile**: React Native + Expo + WatermelonDB + MapLibre Native
- **Object storage**: MinIO (S3-compatible)
- **Reverse proxy**: Caddy (automatic HTTPS)
- **Hosting**: Hetzner Cloud

---

## Deploy

The `.github/workflows/deploy.yml` workflow builds images, pushes to GHCR, and SSH-deploys to a Hetzner box on every push to `main`.

Required GitHub Secrets:

- `HETZNER_HOST` — IP/DNS of the production box
- `HETZNER_USER` — non-root user with docker access
- `HETZNER_SSH_KEY` — private key
- `HETZNER_SSH_PORT` — optional, default 22

One-time Hetzner box prep is documented in `deploy.yml`.

---

## License

UNLICENSED — proprietary.
