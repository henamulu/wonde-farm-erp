#!/usr/bin/env bash
# =============================================================================
# BOOTSTRAP.sh
# =============================================================================
# Adds all of the scaffolded code to your wonde-farm-erp repo as a series of
# logical, conventional commits. Run this from the root of an empty (or
# almost-empty) clone of the repo.
#
# Usage:
#   1.  git clone git@github.com:henamulu/wonde-farm-erp.git
#   2.  cd wonde-farm-erp
#   3.  Extract the tarball ON TOP of the repo:
#         tar -xzf /path/to/wonde-farm-erp.tar.gz --strip-components=1
#   4.  bash BOOTSTRAP.sh
#   5.  Inspect with `git log --oneline`, then push:
#         git push -u origin main
# =============================================================================

set -euo pipefail

if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "✗ not in a git repo. cd into your wonde-farm-erp clone first."
  exit 1
fi

# Configure the user if not set (use repo-local config so we don't touch global)
if ! git config user.email > /dev/null 2>&1; then
  git config user.email "henok@example.com"
  git config user.name  "Henok Mulu"
fi

# -- 1. Initial scaffolding (root files, package.json, .gitignore, README, docs) --
git add .gitignore README.md package.json tsconfig.json tsconfig.base.json \
        .env.example docs/ 2>/dev/null || true
git commit -m "chore: initial monorepo scaffolding

- Root package.json with npm workspaces
- TypeScript project references
- README + architecture document
- .gitignore + .env.example"

# -- 2. Database: Prisma schema, raw SQL, seed --
git add prisma/
git commit -m "feat(prisma): schema, PostGIS setup, tile functions, seed

- 35-model Prisma schema with multi-tenancy, RLS-ready
- postgis-setup.sql: extensions, generated columns (area_ha, centroid),
  validation triggers (parcel/plot/crop_plan containment + overlap),
  RLS policies, audit log trigger, sync sequence
- tile-functions.sql: 9 pg_tileserv-compatible MVT functions
- seed-ethiopia.sql + seed.ts: 497 ha real farm boundary near Mizan Teferi
- fixtures/farm-boundary.geojson: original Nov 2022 survey (EPSG:32637)"

# -- 3. API --
git add apps/api/
git commit -m "feat(api): NestJS bootstrap with auth, sync, geom validation

- main.ts: helmet, compression, cookies, BigInt JSON fix, CORS, Swagger
- app.module.ts: ConfigModule + Joi validation, throttler, health endpoints
- prisma.service.ts: tenant-scoped withTenant() helper for RLS
- auth.module.ts: JWT strategy + guards + login service
- sync.module.ts: pull/push/manifest with idempotent client_id pattern
- validate-geom.controller.ts: live GeoJSON validation matching trigger logic
- common/global-exception.filter.ts: consistent JSON error shape"

# -- 4. Tileserver --
git add apps/tileserver/
git commit -m "feat(tileserver): tenant-aware MVT vector tile server

Custom Fastify server replaces pg_tileserv to maintain RLS isolation.
Each tile request opens a transaction, sets app.tenant_id from the JWT,
calls the corresponding tile_* function in PostGIS. Includes per-tenant
ETag caching with 5s in-process version cache for burst loads."

# -- 5. Worker --
git add apps/worker/
git commit -m "feat(worker): BullMQ background jobs with cron schedules

- ndvi: per-farm Sentinel-2 fetch + COG storage (provider stub)
- reports: weekly P&L per crop_plan from v_crop_plan_pnl view
- gc: nightly sync_conflict + audit_log retention pruning
- photos_gc: 6-hourly orphan MinIO object cleanup
- Health endpoint on :3001, graceful shutdown, idempotent schedules"

# -- 6. Web --
git add apps/web/
git commit -m "feat(web): OpenLayers plot editor with live validation

- useFarmMap: draw/modify/snap interactions, live area in hectares,
  vector tile layer for existing plots, parent geom snap target
- useDebouncedValidate: debounced server-side validation with cancellation,
  drives the red/green pill in the editor toolbar
- PlotEditorLive: full editor component with state-machine UI"

# -- 7. Mobile --
git add apps/mobile/
git commit -m "feat(mobile): offline-first sync engine + photo capture

- WatermelonDB schema for plots, crop_activities, mutation_queue,
  photo_queue, sync_conflicts
- SyncEngine state machine: idle → manifest → pulling → pushing → photos
- Custom delta-sync over REST, server-wins for masters,
  client-create-only for activities/harvests/qc/attendance
- Mutation queue with idempotent client_id, exponential backoff
- usePhotoCapture: expo-camera + GPS tagging + queued upload via presigned PUT"

# -- 8. Infrastructure --
git add docker-compose.yml infra/
git commit -m "feat(infra): Docker compose stack with Caddy + Mosquitto

- Postgres+PostGIS, MinIO, Mosquitto, Redis, API, Worker, Tileserver, Caddy
- Internal network isolation; only Caddy exposes 80/443
- Healthchecks gate dependent services
- Profile-based one-shots for migrate + seed
- MinIO bucket bootstrap, MinIO public URL via PUBLIC_BASE_URL
- Caddy reverse-proxies /api, /tiles, /storage with auto-HTTPS
- Postgres init creates app_user (RLS) and app_admin (BYPASSRLS) roles"

# -- 9. CI/CD --
git add .github/
git commit -m "ci: GitHub Actions for lint, test, build, deploy

- ci.yml: lint + typecheck + tests against real PostGIS service
  (full prisma migrate + postgis-setup + tile-functions + seed +
  jest + tileserver smoke test)
- deploy.yml: matrix-build (api, tileserver, worker), push to GHCR,
  SSH-deploy to Hetzner with health check + automatic image pruning"

# -- 10. E2E tests --
git add e2e/
git commit -m "test(e2e): Playwright spec for plot draw → validate → save

- Single-worker config (shared DB state)
- globalSetup re-seeds DB and captures auth state once
- helpers/map.ts: lon/lat → canvas pixel for OpenLayers Draw interaction
- helpers/api.ts: direct API verification + tile pipeline check
- specs/plot-editor.spec.ts: full happy-path including tile invalidation"

# -- Catch any stragglers --
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -m "chore: remaining files"
fi

echo
echo "✓ Done. Review with:"
echo "    git log --oneline"
echo
echo "Push to origin with:"
echo "    git push -u origin main"
