# Farm ERP – Full-Stack Architecture & Implementation Plan

A GIS-native, offline-capable ERP for farm operations. Every operational entity (crop plan, harvest, contract, activity, attendance) is anchored to a geometry in PostGIS, so the map *is* the system, not a layer on top of it.

This builds on the existing `farm.samariaerp.org` baseline (React 18 + NestJS + PostGIS on Hetzner) and replaces it with a multi-tenant, mobile-first, GIS-first architecture.

---

## 1. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              CLIENTS                                     │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────┐   │
│  │  Web (React)     │  │ Mobile (RN)      │  │  Public Portal       │   │
│  │  Office / Admin  │  │ Field workers    │  │  (outgrowers, audit) │   │
│  └────────┬─────────┘  └────────┬─────────┘  └──────────┬───────────┘   │
└───────────┼─────────────────────┼───────────────────────┼───────────────┘
            │                     │                       │
            │       HTTPS (REST + JSON, JWT)              │
            │                     │                       │
┌───────────▼─────────────────────▼───────────────────────▼───────────────┐
│                          API GATEWAY (Nginx)                             │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
   ┌───────────────────────────┼─────────────────────────────────────┐
   │                           │                                     │
┌──▼──────────────┐  ┌─────────▼──────────────┐   ┌──────────────────▼─┐
│ NestJS API      │  │ Tile / Feature Server  │   │  Sync API           │
│ (modular        │  │ pg_tileserv +          │   │  (delta endpoints   │
│  monolith)      │  │ pg_featureserv         │   │   for mobile)       │
└──┬──────────────┘  └─────────┬──────────────┘   └──────────┬──────────┘
   │                           │                              │
   └───────────────────────────┼──────────────────────────────┘
                               │
                  ┌────────────▼─────────────┐
                  │  PostgreSQL 16 + PostGIS │
                  │  Row-Level Security      │
                  │  TimescaleDB (sensors)   │
                  └────────────┬─────────────┘
                               │
   ┌───────────────────────────┼─────────────────────────────┐
   │                           │                             │
┌──▼──────┐  ┌──────────┐  ┌───▼─────┐  ┌────────────┐  ┌────▼──────┐
│ Redis   │  │ MinIO    │  │ BullMQ  │  │ MQTT       │  │ Mailer    │
│ (cache, │  │ (photos, │  │ (jobs,  │  │ (Mosquitto │  │ (Postmark │
│  pub/   │  │  docs,   │  │  reports│  │  for IoT)  │  │  / SES)   │
│  sub)   │  │  MBTiles)│  │  sync)  │  │            │  │           │
└─────────┘  └──────────┘  └─────────┘  └────────────┘  └───────────┘
```

Start as a **modular monolith**. Split into services only when traffic patterns force it (sync, tile serving, and report generation are the obvious first split points).

---

## 2. Tech Stack

### Backend
- **Framework**: NestJS 10+ (TypeScript), modular monolith with feature modules per ERP module
- **ORM**: Prisma (better DX, migrations) — or TypeORM if you need rawer Postgres/PostGIS access. Prisma's `Unsupported("geometry")` works fine if you keep spatial logic in repository methods.
- **DB**: PostgreSQL 16 + PostGIS 3.4 + TimescaleDB (for sensor time series) + pgvector (for future ML)
- **Auth**: JWT (access ~15min) + refresh tokens (httpOnly cookies for web, secure store for mobile), RBAC + ABAC, optional TOTP MFA
- **Validation**: Zod or class-validator
- **API spec**: OpenAPI 3.1 auto-generated from decorators
- **Queues**: BullMQ + Redis (report generation, sync reconciliation, email/SMS, satellite imagery fetch)
- **File storage**: MinIO (S3-compatible, self-hosted on Hetzner)
- **Search**: Postgres FTS first; Meilisearch only if you outgrow it

### GIS Layer
- **Tile server**: `pg_tileserv` (MVT vector tiles direct from PostGIS) — fast, simple, perfect for thousands of plots
- **Feature server**: `pg_featureserv` (OGC API Features) for read; custom NestJS REST endpoints for writes (so you keep validation, audit, transactions)
- **Optional**: GeoServer if you need WMS/WFS-T for ArcGIS/QGIS interop or external clients
- **Coordinate strategy**: store all geometry in EPSG:4326 (WGS84); for area/distance use `ST_Area(geom::geography)` or project to local UTM (Ethiopia: EPSG:32636/32637; Spain mainland: EPSG:25830)

### Web Frontend
- **Framework**: React 18 + Vite + TypeScript
- **State**: TanStack Query (server state) + Zustand (UI state). Skip Redux.
- **UI**: Tailwind + shadcn/ui (you already use it)
- **Forms**: React Hook Form + Zod
- **Tables**: TanStack Table
- **Maps**: **OpenLayers** as primary (you have deep expertise) + **MapLibre GL** for vector-tile-heavy views (better perf for live sensor overlays, NDVI rasters)
- **Charts**: Recharts for dashboards, ECharts for heavier analytics

### Mobile
- **Framework**: React Native (Expo prebuild, so you get native modules when needed)
- **Local DB**: WatermelonDB (LokiJS-backed, sync-friendly) — or RxDB if you prefer reactive queries
- **Maps**: MapLibre Native + offline MBTiles bundled in MinIO
- **Storage**: MMKV for KV, FileSystem for media, SQLite via WatermelonDB
- **Sync**: custom delta-sync over REST (see §6)
- **Camera**: `expo-camera` with EXIF GPS preservation
- **Background**: `expo-background-fetch` for sync, `expo-location` (background) for geofenced attendance

### DevOps
- **Hosting**: Hetzner Cloud (CCX series for prod) + Storage Box for backups
- **Orchestration**: Docker Compose initially → K3s when multi-tenant scale demands it
- **Reverse proxy**: Nginx + Let's Encrypt (or Caddy for simpler config)
- **CI/CD**: GitHub Actions → build, test, push to Hetzner registry, deploy via Ansible or Coolify
- **Backups**: WAL-G or pgBackRest → Hetzner Storage Box (encrypted), nightly dumps + continuous WAL
- **Observability**: Prometheus + Grafana + Loki + Tempo (or Grafana Cloud free tier), Sentry for errors

---

## 3. Core Data Model

Multi-tenant from day one: every business table has `tenant_id` + Postgres Row-Level Security policies.

### 3.1 Spatial backbone

```sql
-- Tenancy
CREATE TABLE tenant (
  id            UUID PRIMARY KEY,
  slug          TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  country_code  TEXT NOT NULL,
  default_srid  INTEGER NOT NULL DEFAULT 4326,
  metric_srid   INTEGER NOT NULL  -- e.g. 32637 for Mizan area
);

-- Farm: top-level land asset
CREATE TABLE farm (
  id            UUID PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenant(id),
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  owner_id      UUID,
  geom          geometry(MultiPolygon, 4326) NOT NULL,
  centroid      geometry(Point, 4326) GENERATED ALWAYS AS (ST_Centroid(geom)) STORED,
  area_ha       NUMERIC GENERATED ALWAYS AS (ST_Area(geom::geography)/10000.0) STORED,
  altitude_m    NUMERIC,
  agro_zone     TEXT,
  certifications JSONB,    -- organic, GlobalGAP, Rainforest...
  UNIQUE(tenant_id, code)
);
CREATE INDEX ON farm USING GIST (geom);

-- Parcel: cadastral or operational subdivision
CREATE TABLE parcel (
  id            UUID PRIMARY KEY,
  tenant_id     UUID NOT NULL,
  farm_id       UUID NOT NULL REFERENCES farm(id),
  code          TEXT NOT NULL,
  name          TEXT,
  geom          geometry(Polygon, 4326) NOT NULL,
  area_ha       NUMERIC GENERATED ALWAYS AS (ST_Area(geom::geography)/10000.0) STORED,
  soil_type     TEXT,
  soil_ph       NUMERIC,
  slope_pct     NUMERIC,
  irrigated     BOOLEAN DEFAULT false,
  cadastral_ref TEXT      -- SIGPAC ref, Catastro ref, ELAP ref, etc.
);
CREATE INDEX ON parcel USING GIST (geom);

-- Plot: operational unit (where a single crop plan lives)
CREATE TABLE plot (
  id            UUID PRIMARY KEY,
  tenant_id     UUID NOT NULL,
  parcel_id     UUID NOT NULL REFERENCES parcel(id),
  code          TEXT NOT NULL,
  geom          geometry(Polygon, 4326) NOT NULL,
  area_ha       NUMERIC GENERATED ALWAYS AS (ST_Area(geom::geography)/10000.0) STORED,
  current_crop_plan_id UUID
);
CREATE INDEX ON plot USING GIST (geom);

-- Infrastructure: warehouses, sheds, irrigation, roads, fences, water points
CREATE TABLE infrastructure (
  id            UUID PRIMARY KEY,
  tenant_id     UUID NOT NULL,
  farm_id       UUID NOT NULL,
  type          TEXT NOT NULL,  -- warehouse | shed | well | pump | road | fence | gate
  name          TEXT,
  geom          geometry(Geometry, 4326) NOT NULL,  -- could be point/line/polygon
  attributes    JSONB
);
CREATE INDEX ON infrastructure USING GIST (geom);

-- Sensor: IoT device locations (time-series data goes to TimescaleDB)
CREATE TABLE sensor (
  id            UUID PRIMARY KEY,
  tenant_id     UUID NOT NULL,
  farm_id       UUID NOT NULL,
  type          TEXT NOT NULL,  -- soil_moisture | temp | rain | weather_station | gps_tracker
  device_id     TEXT UNIQUE NOT NULL,
  geom          geometry(Point, 4326) NOT NULL,
  installed_at  TIMESTAMPTZ
);
```

Validation rules to enforce in NestJS service layer (or Postgres triggers):

- `parcel.geom` must be `ST_Within(parcel.geom, farm.geom)` (allow tiny tolerance via `ST_Buffer`)
- `plot.geom` must be `ST_Within(plot.geom, parcel.geom)`
- No two `plot.geom` of the same `parcel_id` may overlap (`ST_Overlaps` check)
- All geometries must be `ST_IsValid` — auto-fix with `ST_MakeValid` on ingest

### 3.2 Production

```sql
CREATE TABLE crop (
  id            UUID PRIMARY KEY,
  tenant_id     UUID,
  name          TEXT NOT NULL,
  variety       TEXT,
  cycle_days    INTEGER,
  category      TEXT  -- cereal | legume | vegetable | fruit | cash_crop
);

CREATE TABLE season (
  id            UUID PRIMARY KEY,
  tenant_id     UUID,
  name          TEXT NOT NULL,    -- "Belg 2026", "Meher 2025/26"
  start_date    DATE,
  end_date      DATE
);

CREATE TABLE crop_plan (
  id              UUID PRIMARY KEY,
  tenant_id       UUID,
  plot_id         UUID NOT NULL REFERENCES plot(id),
  crop_id         UUID NOT NULL,
  season_id       UUID NOT NULL,
  geom            geometry(Polygon, 4326) NOT NULL, -- can be subset of plot
  area_ha         NUMERIC GENERATED ALWAYS AS (ST_Area(geom::geography)/10000.0) STORED,
  planned_sowing  DATE,
  planned_harvest DATE,
  expected_yield_kg_ha NUMERIC,
  status          TEXT,  -- draft | active | harvested | cancelled
  budget_id       UUID
);
CREATE INDEX ON crop_plan USING GIST (geom);

CREATE TABLE crop_activity (
  id              UUID PRIMARY KEY,
  tenant_id       UUID,
  crop_plan_id    UUID REFERENCES crop_plan(id),
  type            TEXT,  -- land_prep | sowing | fertilizing | spraying | weeding | irrigating | scouting | harvesting
  scheduled_at    TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  performed_by    UUID,           -- employee
  inputs_used     JSONB,          -- batch_ids + quantities
  geom_track      geometry(MultiLineString, 4326), -- GPS track from mobile
  geom_point      geometry(Point, 4326),           -- single capture point
  photos          JSONB,          -- MinIO keys
  notes           TEXT
);

CREATE TABLE harvest (
  id              UUID PRIMARY KEY,
  tenant_id       UUID,
  crop_plan_id    UUID,
  harvested_at    TIMESTAMPTZ,
  quantity_kg     NUMERIC,
  moisture_pct    NUMERIC,
  quality_grade   TEXT,
  produced_batch_id UUID,         -- creates an inventory batch
  geom            geometry(Polygon, 4326)  -- area actually harvested
);
```

### 3.3 Inventory

```sql
CREATE TABLE warehouse (
  id          UUID PRIMARY KEY,
  tenant_id   UUID,
  farm_id     UUID,
  name        TEXT,
  geom        geometry(Point, 4326),
  capacity    JSONB
);

CREATE TABLE batch (
  id            UUID PRIMARY KEY,
  tenant_id     UUID,
  sku_id        UUID NOT NULL,
  lot_number    TEXT NOT NULL,
  origin        TEXT,             -- harvest | purchase | production
  origin_ref_id UUID,             -- harvest_id or purchase_order_line_id
  produced_at   DATE,
  expiry_at     DATE,
  attributes    JSONB             -- moisture, grade, residue tests...
);

CREATE TABLE stock (
  batch_id      UUID,
  warehouse_id  UUID,
  quantity      NUMERIC,
  uom           TEXT,
  PRIMARY KEY (batch_id, warehouse_id)
);

CREATE TABLE stock_move (
  id            UUID PRIMARY KEY,
  tenant_id     UUID,
  batch_id      UUID,
  from_wh_id    UUID,
  to_wh_id      UUID,
  qty           NUMERIC,
  type          TEXT,             -- in | out | transfer | adjust
  ref_doc       JSONB,
  posted_at     TIMESTAMPTZ
);
```

### 3.4 Sales, Purchases, Accounting

Standard double-entry layout — no GIS dependency, but link partners and deliveries to geometries where useful (delivery addresses, vendor farms for traceability).

```sql
partner(id, type, name, tax_id, address, geom Point, …)

sales_order(id, partner_id, season_id, status, total, …) + sales_order_line(...)
purchase_order(id, partner_id, status, total, …) + purchase_order_line(...)
invoice(id, partner_id, kind [customer|vendor], status, due_date, total, …) + invoice_line(...)
payment(id, partner_id, method, amount, posted_at, …)

account(id, code, name, type [asset|liability|equity|income|expense], parent_id)
journal(id, code, name, type)
journal_entry(id, date, journal_id, ref, posted)
journal_line(entry_id, account_id, partner_id, debit, credit, analytic_tags JSONB)
fiscal_period(id, name, start, end, closed)
```

Tag every journal line with analytic dimensions: `crop_plan_id`, `parcel_id`, `season_id`, `cost_center`. That's how you get **per-plot P&L** — the killer feature for a farm ERP.

### 3.5 Contract Farming

```sql
outgrower(id, partner_id, farm_geom Polygon, kyc_documents JSONB, …)
contract(
  id, outgrower_id, season_id, crop_id,
  area_ha, geom Polygon,
  expected_yield_kg, price_model JSONB,    -- fixed | market+bonus | floor+ceiling
  advances_total, status
)
contract_advance(id, contract_id, type [seed|fertilizer|cash], amount, delivered_at)
contract_delivery(id, contract_id, batch_id, qty_kg, qc_grade, paid_amount)
```

Outgrower farms get drawn on the same map as your own. Filtering by `is_owned vs contract` is just a column.

### 3.6 Quality Control

```sql
qc_protocol(id, name, applies_to, parameters JSONB)
qc_test(id, protocol_id, target [batch|harvest|plot], target_id,
        results JSONB, pass BOOLEAN, tested_at, tested_by)
```

### 3.7 HR

```sql
employee(id, partner_id, role, hired_at, salary_model, …)
attendance(id, employee_id, in_at, out_at,
           in_geom Point, out_geom Point,
           in_geofence_ok BOOLEAN, out_geofence_ok BOOLEAN)
task_assignment(id, employee_id, crop_activity_id, planned_at, status)
payroll_period(id, start, end, closed)
payslip(id, period_id, employee_id, gross, deductions JSONB, net, paid_at)
```

`in_geofence_ok` is computed via `ST_Within(in_geom, farm.geom)` at check-in — proves the worker was actually on site.

### 3.8 Compliance & Audit

```sql
audit_log(id, tenant_id, user_id, action, entity, entity_id,
          before JSONB, after JSONB, ip, user_agent, occurred_at)

compliance_report(id, tenant_id, kind, period, payload JSONB,
                  submitted_at, external_ref)
```

Append-only; partitioned by month. Every write goes through a NestJS interceptor that emits to this table.

---

## 4. Module Breakdown

| Module | Core entities | GIS link | Key flows |
|---|---|---|---|
| **Farm Profile** | farm, parcel, infrastructure, certifications | Draw/import farm boundary, parcels, infrastructure points/lines | Import KML/Shapefile/GeoJSON; cadastral lookup; certification expiry alerts |
| **Planning** | season, crop_plan, crop_rotation_history | Plan = polygon on a plot | Draft → review → activate; rotation conflict warnings (last 3 seasons); budget per plan |
| **Production** | crop_activity, harvest, input_application | Activities tracked with GPS point or track | Schedule from plan → assign to worker → mobile capture → close activity → consume inventory |
| **Contract Farming** | outgrower, contract, advance, delivery | Outgrower plot polygons on same map | KYC → contract draw → advance issue → harvest delivery → settlement |
| **Inventory** | sku, batch, stock, stock_move, warehouse | Warehouse points; batch traceability back to plot polygon | Receive → store → transfer → issue → adjust; FEFO/FIFO |
| **Sales & Purchases** | partner, sales/purchase orders, invoice, payment | Delivery address geom; vendor location | Quote → order → delivery → invoice → payment → reconciliation |
| **Accounting** | account, journal, entry, period | Analytic tags reference geom-bearing entities | Auto-posting from operations; period close; financial statements; per-plot/per-crop P&L |
| **Quality Control** | qc_protocol, qc_test | Tests linked to batch → harvest → plot | Define protocol → schedule on batch → record results → block stock if fail |
| **HR** | employee, attendance, task_assignment, payslip | Geofenced attendance; per-task GPS track | Roster → assign → check-in (geofenced) → complete task → payroll |
| **Compliance** | compliance_report, audit_log | Reports often need geometries (e.g. SIGPAC declarations) | Generate from data → review → export PDF/XML → submit to authority |

---

## 5. GIS Architecture (the differentiator)

### 5.1 Drawing & editing on the web

```
User clicks "New Crop Plan"
  ↓
Map enters draw mode (OpenLayers Draw interaction, snapping enabled)
  ↓
Plot polygon shown as snap target; basemap = satellite + cadastral overlay
  ↓
On finish: client validates locally (simplification, self-intersection)
  ↓
POST /api/crop-plans { plot_id, crop_id, season_id, geom: GeoJSON }
  ↓
NestJS validates server-side:
  - ST_IsValid; auto-fix with ST_MakeValid
  - ST_Within(new_geom, plot.geom) with small tolerance
  - No overlap with active plans on same plot
  - Optional: minimum area threshold
  ↓
Insert; emit audit log; return entity with computed area_ha
  ↓
Tile cache invalidated for affected zoom levels
```

### 5.2 Tile pipeline

Two layers of tiles:

1. **Base imagery**: pre-cached Sentinel-2 + OSM via MapTiler self-hosted OR proxied through your API with a CDN cache.
2. **Operational vector tiles** (what changes): served from PostGIS via `pg_tileserv` directly. Each module exposes a function:

```sql
CREATE OR REPLACE FUNCTION public.active_crop_plans(z int, x int, y int, query_params json)
RETURNS bytea AS $$
  SELECT ST_AsMVT(t, 'active_crop_plans', 4096, 'geom') FROM (
    SELECT id, crop_id, status, area_ha,
           ST_AsMVTGeom(geom, ST_TileEnvelope(z,x,y), 4096, 64, true) AS geom
    FROM crop_plan
    WHERE status = 'active'
      AND geom && ST_TileEnvelope(z,x,y)
      AND tenant_id = current_setting('app.tenant_id')::uuid
  ) t WHERE geom IS NOT NULL;
$$ LANGUAGE sql STABLE PARALLEL SAFE;
```

`pg_tileserv` exposes that as `/public.active_crop_plans/{z}/{x}/{y}.pbf` automatically. RLS handles tenant isolation; you just need to set `app.tenant_id` from the JWT in a connection-pool hook.

### 5.3 Spatial analyses you'll want from day one

- **Per-plot area** — `ST_Area(geom::geography)` (handles large geographies correctly)
- **Crop rotation conflicts** — query past `crop_plan` rows whose `geom` intersects current draw with same crop family in last N seasons
- **Sensor coverage** — Voronoi tessellation of sensors, intersected with parcel
- **Buffer / setback rules** — `ST_Buffer` water bodies, check pesticide-application activities don't fall within
- **Yield heatmap** — `kg/ha` per plot/plan, joined to `crop_plan.geom`, colored on map
- **NDVI overlay** — fetch Sentinel-2 NDVI tiles for the farm bbox via Sentinel Hub, store as COG in MinIO, serve with `titiler` (FastAPI side-service)
- **Geofence breach** — attendance check-in `ST_Within` farm or assigned-plot polygon

### 5.4 Import / export

- **Import**: Shapefile (zipped), KML, KMZ, GeoJSON, GeoPackage, CSV with WKT. Use `gdal-async` in a Node side-process or a Python microservice (`fiona`, `geopandas`) called via BullMQ.
- **Export**: GeoJSON, GeoPackage, Shapefile, KML, plus PDF map exports (use `puppeteer` headless to print a styled OpenLayers view — same trick as your RPGUR print widget but cleaner because you control the whole stack).
- **Cadastral connectors**:
  - **Spain**: Catastro WMS/WFS (`http://ovc.catastro.meh.es/...`), SIGPAC WMS (national + autonomous communities)
  - **Ethiopia**: ELAP integration if the project gets official; otherwise manual import
  - **Galicia / Asturias**: you already have these from RPGUR work

---

## 6. Mobile / Offline-First Strategy

This is what makes or breaks the field side.

### 6.1 What's stored locally

- All master data the user might need offline: assigned crop_plans, plots, employees, SKUs, partners, QC protocols
- Pre-rendered **MBTiles** of the farm bounding box (zoom 10–18) bundled per farm, ~50–500 MB depending on size — downloadable when on Wi-Fi
- All draft activities, attendance records, harvests, QC tests, photos created by this user

### 6.2 Sync protocol

Custom delta sync over REST. Two endpoints per syncable entity:

```
GET  /sync/pull?since=<server_seq>&entities=crop_plan,activity,...
POST /sync/push   { mutations: [{ entity, op, id, payload, client_ts }] }
```

Each row carries `server_seq BIGINT GENERATED ALWAYS AS IDENTITY` and `updated_at`. Pull is `WHERE server_seq > :since AND user_can_see(:user, row)`. Push is processed in a single transaction per batch with conflict detection:

- **Master data** (farm, parcel, plot, partner, crop): server-wins always
- **Operational records** (activity, attendance, harvest, qc_test): client-creates-only when offline; server assigns final id, returns mapping
- **Geometry edits** offline (rare for field workers; usually planners): last-write-wins on `updated_at`, with a `conflicts` queue surfaced to admin if both sides changed the same row

Photos sync separately via direct MinIO PUT with presigned URLs once payload sync confirms.

### 6.3 Offline UX

- "Sync" status pill always visible: ✓ synced / ⟳ pending N / ⚠ conflicts
- All buttons work offline; queued actions are clearly tagged
- GPS tracks recorded continuously while activity is "in progress" (battery-aware)
- Voice notes attached to activities for low-literacy workers

### 6.4 RN libraries that have proven themselves

- WatermelonDB for sync-friendly local SQLite
- MapLibre Native (`@maplibre/maplibre-react-native`) for offline maps + MBTiles
- `react-native-mmkv` for tiny KV (auth tokens, settings)
- `react-native-reanimated` + `react-native-gesture-handler` for the polish
- `expo-camera`, `expo-location`, `expo-task-manager` for background

---

## 7. External Integrations

### 7.1 Operational
- **Weather forecast & history**: NASA POWER (free, daily, global), Open-Meteo (free, hourly forecast), AccuWeather (commercial). Cache locally; trigger crop-activity reschedule alerts when adverse weather predicted.
- **Satellite imagery / NDVI**: Sentinel Hub or Copernicus Data Space (free for Sentinel-2). Pull weekly mosaic for farm bbox, compute NDVI/NDWI, store as COG, surface in dashboard.
- **IoT sensors**: MQTT broker (Mosquitto) inside your stack; ingest soil moisture, weather station, GPS trackers; The Things Network for LoRaWAN devices.

### 7.2 Mapping
- **Basemaps**: OSM (self-hosted tiles via tile server), MapTiler, Mapbox, ESRI World Imagery
- **Cadastral**: Catastro (Spain), SIGPAC (Spain agriculture), regional services for Galicia/Asturias

### 7.3 Financial
- **Payments**: Stripe (cards, EU/global), telebirr (Ethiopia), M-Pesa (East Africa), PayPal, SEPA via your bank's PSD2 API
- **Banking**: Plaid (US/EU), GoCardless for SEPA DD, regional aggregators (TrueLayer in EU)
- **E-invoicing / Tax**:
  - **Spain**: SII (AEAT), Verifactu / TicketBAI (depending on autonomous community), FACe for public-sector invoicing
  - **Ethiopia**: ERCA receipt printer integration, VAT reporting
  - Use a connector service so country-specific logic is isolated
- **Accounting export**: QuickBooks, Xero, Holded (Spain SMB-popular), Odoo via XML-RPC, SAP Business One

### 7.4 Identity & Documents
- **SSO**: Google Workspace, Microsoft 365 (for office staff)
- **E-signature**: AutoFirma/Cl@ve (Spain public sector), DocuSign, BankID (Nordic clients if any)
- **Document OCR**: Mindee or Google Document AI for vendor invoices

### 7.5 Communications
- **SMS**: Twilio (global), Africa's Talking (East Africa, much cheaper for ET)
- **Email**: Postmark (transactional), AWS SES (volume)
- **Push**: Expo Push Notifications (FCM + APNs in one)
- **Voice/IVR**: optional, Twilio or Africa's Talking

### 7.6 Analytics & ML (later phases)
- **Yield prediction**: train on historical harvest + NDVI + weather; serve via FastAPI sidecar with scikit-learn or LightGBM
- **Disease detection**: photo upload → CNN inference (TF.js on mobile for offline; or server PyTorch)
- **BI**: Metabase or Apache Superset connected read-only to a replicated warehouse

---

## 8. Security & Multi-Tenancy

- **RLS everywhere**: every business table has `tenant_id`; policy: `USING (tenant_id = current_setting('app.tenant_id')::uuid)`. Connection pool sets it from JWT on checkout.
- **RBAC**: roles (owner, agronomist, accountant, warehouse_keeper, field_worker, outgrower, auditor) + per-module permissions
- **ABAC overlays**: e.g. "agronomist can only see plots tagged with their region"
- **Audit log**: append-only, partitioned monthly, NestJS interceptor on all mutating endpoints
- **At rest**: Postgres TDE not needed if disk-encrypted (LUKS on Hetzner); MinIO server-side encryption
- **In transit**: TLS 1.3, HSTS, certificate pinning on mobile for API host
- **Secrets**: not in env files in prod — use Doppler, Infisical, or HashiCorp Vault
- **GDPR**: data export per partner (right of access), deletion workflow with soft-delete + 30-day purge job
- **PII**: encrypt KYC documents at rest (envelope encryption), separate MinIO bucket with stricter ACL

---

## 9. Deployment Topology (Hetzner-first, since you know it)

**Single-tenant / first customer (now)**:
- 1× CCX23 (4 vCPU, 16 GB) running everything via Docker Compose
- Hetzner Storage Box for backups
- Cloudflare in front for DDoS + cache
- Total: ~€30–40/month

**Multi-tenant SaaS (year 1)**:
- 2× CCX33 app nodes behind a Hetzner load balancer (NestJS, pg_tileserv stateless)
- 1× CCX33 dedicated Postgres (or Hetzner Cloud Managed Postgres when GA)
- 1× small node for MinIO + Mosquitto + monitoring
- Read replica + WAL-G to Hetzner Object Storage
- ~€150–250/month

**At ~50+ tenants**: K3s on 3+ nodes, Postgres separated (still self-managed; Patroni for HA), separate read replica for analytics, Cloudflare R2 or AWS S3 for objects if egress becomes an issue.

---

## 10. Phased Roadmap

| Phase | Duration | Scope |
|---|---|---|
| **0 – Foundation** | 2 wks | Repo skeleton, auth, tenancy + RLS, CI/CD, base map shell, audit log infra |
| **1 – MVP** | 8–10 wks | Farm Profile (draw/import), Planning Module (crop_plan with geom), Production (basic activities), Inventory (warehouse, batch, simple moves), Web only |
| **2 – Mobile & Field** | 6–8 wks | RN app, offline sync engine, MBTiles per farm, mobile activity capture with GPS+photos, attendance with geofence, push notifications |
| **3 – Commercial** | 6–8 wks | Sales & Purchases, Customer/Vendor invoicing, Payments, Accounting (chart of accounts, journals, period close), per-plot P&L |
| **4 – Quality & Compliance** | 4–6 wks | QC protocols & tests, traceability (batch → harvest → plot polygon), country-specific compliance reports & e-invoicing connectors |
| **5 – Contract Farming** | 4–6 wks | Outgrower onboarding, contracts, advances, deliveries, settlement, separate outgrower portal |
| **6 – HR & Payroll** | 4 wks | Employee master, task assignment, attendance review, payslip generation, country-specific tax tables |
| **7 – Advanced GIS / Analytics** | ongoing | NDVI pipeline, yield heatmaps, IoT ingestion + dashboards, predictive yield, disease photo classification |

Phases 1–2 deliver something genuinely useful on their own — that's your "demo-able product" target around month 4.

---

## 11. Recommended Repo Structure (monorepo)

```
farm-erp/
├── apps/
│   ├── api/              NestJS API (modular monolith)
│   ├── web/              React + Vite admin/office
│   ├── mobile/           React Native / Expo
│   ├── portal/           Public/outgrower portal (Next.js or shared with web)
│   ├── tile/             pg_tileserv config (or wrapper service)
│   └── worker/           BullMQ worker (reports, sync, satellite, compliance)
├── packages/
│   ├── shared/           Zod schemas, types, OpenAPI client
│   ├── ui/               shared shadcn components
│   ├── gis/              OpenLayers / MapLibre helpers, draw/edit hooks
│   ├── sync/             delta-sync protocol (used by api + mobile)
│   └── i18n/             translations (es / en / am / om / orm if Ethiopia ops)
├── infra/
│   ├── docker/           Dockerfiles, compose.*.yml
│   ├── ansible/          provisioning + deploy
│   └── k8s/              when you migrate
├── db/
│   ├── migrations/       Prisma migrations
│   ├── seeds/
│   └── functions/        PostGIS SQL functions (tile functions, validation triggers)
└── docs/
    ├── architecture/
    └── adr/              Architecture Decision Records
```

---

## 12. Decisions to lock in early (write ADRs)

1. **Prisma vs TypeORM** — Prisma + raw SQL for spatial is fine; pick now to avoid migrations rework.
2. **WatermelonDB vs RxDB** — try one early; switching costs are real.
3. **Single tile server vs per-tenant** — single + RLS is much simpler; benchmark first.
4. **Modular monolith vs microservices** — monolith. Don't split until you have evidence.
5. **Multi-tenancy: shared schema (RLS) vs schema-per-tenant vs DB-per-tenant** — shared schema + RLS for SaaS scale; DB-per-tenant only if a regulated client demands it.
6. **Offline conflict resolution rules per entity** — document explicitly per table; don't leave it for "later".

---

## 13. Things often overlooked in farm ERPs (don't be that vendor)

- **Units of measure are messy**: kg vs quintal vs sack; surface in ha vs acre vs *gasha* (Ethiopia) vs *fanega* (some Spanish regions). Build a UoM service from day 1.
- **Languages**: Spanish, English, Amharic, Afaan Oromoo for Ethiopia. RTL not needed but right script is.
- **Low-literacy UX**: icon-first mobile screens, voice notes, photo-first.
- **Connectivity reality**: assume 2G/no-signal frequently; everything must be operable offline, sync in batches, and survive abrupt kills.
- **Calendar systems**: Ethiopia uses the Ethiopian calendar — display both, store in ISO.
- **Data sovereignty**: Ethiopian or EU clients may require data stays in-country/region. Design tenancy so a tenant can be pinned to a region.
- **Backups customers can verify**: a "download my data" button (GeoPackage + JSON dump) builds trust faster than any SLA doc.

---

## 14. What to build first this week (if you want to start)

1. Repo skeleton with the structure above (1 day)
2. Tenant + auth + RLS pattern with one protected entity end-to-end (1 day)
3. Farm + parcel CRUD with PostGIS validation triggers + an OpenLayers draw page (2 days)
4. `pg_tileserv` wired up serving farms/parcels as MVT, basemap from MapTiler (1 day)
5. CI deploying to a Hetzner staging box on every push (1 day)

That's a week. After that the modular work parallelizes well — you can hire the junior dev (PHP/Vue skill is fine if they pick up TS quickly) on Phase 1 inventory or Phase 2 mobile screens while you focus on GIS and accounting.
