-- =============================================================================
-- Farm ERP — pg_tileserv MVT functions
-- =============================================================================
-- These functions are auto-discovered by pg_tileserv and exposed as
--
--   GET /public.<function_name>/{z}/{x}/{y}.pbf?param=value
--
-- pg_tileserv connects as `app_user`. For RLS isolation to work, you have
-- two options:
--
--   A. Per-connection JWT injection: pg_tileserv supports `CustomScript`
--      (preview) — set `app.tenant_id` from a JWT claim on each request.
--   B. Token-bearing path: front pg_tileserv with Nginx, terminate JWT there,
--      and pass tenant via header → use a proxy script to set the GUC.
--
-- Either way, the functions assume `app_tenant_id()` returns the current
-- tenant's UUID (defined in postgis-setup.sql).
--
-- All functions are STABLE PARALLEL SAFE so pg_tileserv can cache them.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Farms — outer boundary, name, area
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tile_farms(
  z integer, x integer, y integer,
  query_params json DEFAULT '{}'::json
)
RETURNS bytea
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  WITH bounds AS (
    SELECT ST_TileEnvelope(z, x, y) AS env
  ),
  mvtgeom AS (
    SELECT
      f.id,
      f.code,
      f.name,
      f.area_ha::float8 AS area_ha,
      ST_AsMVTGeom(
        ST_Transform(f.geom, 3857),
        bounds.env,
        4096, 64, true
      ) AS geom
    FROM farm f, bounds
    WHERE f.deleted_at IS NULL
      AND f.tenant_id = app_tenant_id()
      AND ST_Transform(f.geom, 3857) && bounds.env
  )
  SELECT ST_AsMVT(mvtgeom.*, 'farms', 4096, 'geom')
  FROM mvtgeom
  WHERE geom IS NOT NULL;
$$;

COMMENT ON FUNCTION public.tile_farms(integer,integer,integer,json) IS
  'Farm boundaries. Tile layer name: "farms". Properties: id, code, name, area_ha.';

-- -----------------------------------------------------------------------------
-- 2. Parcels
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tile_parcels(
  z integer, x integer, y integer,
  farm_id uuid DEFAULT NULL
)
RETURNS bytea
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  WITH bounds AS (
    SELECT ST_TileEnvelope(z, x, y) AS env
  ),
  mvtgeom AS (
    SELECT
      p.id,
      p.farm_id,
      p.code,
      p.name,
      p.area_ha::float8 AS area_ha,
      p.soil_type,
      p.irrigated,
      ST_AsMVTGeom(
        ST_Transform(p.geom, 3857),
        bounds.env,
        4096, 64, true
      ) AS geom
    FROM parcel p, bounds
    WHERE p.deleted_at IS NULL
      AND p.tenant_id = app_tenant_id()
      AND (tile_parcels.farm_id IS NULL OR p.farm_id = tile_parcels.farm_id)
      AND ST_Transform(p.geom, 3857) && bounds.env
  )
  SELECT ST_AsMVT(mvtgeom.*, 'parcels', 4096, 'geom')
  FROM mvtgeom
  WHERE geom IS NOT NULL;
$$;

COMMENT ON FUNCTION public.tile_parcels(integer,integer,integer,uuid) IS
  'Parcel boundaries. Optional ?farm_id= to filter. Layer name: "parcels".';

-- -----------------------------------------------------------------------------
-- 3. Plots
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tile_plots(
  z integer, x integer, y integer,
  farm_id uuid DEFAULT NULL,
  parcel_id uuid DEFAULT NULL
)
RETURNS bytea
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  WITH bounds AS (
    SELECT ST_TileEnvelope(z, x, y) AS env
  ),
  mvtgeom AS (
    SELECT
      p.id,
      p.parcel_id,
      pa.farm_id,
      p.code,
      p.area_ha::float8 AS area_ha,
      p.current_crop_plan_id,
      ST_AsMVTGeom(
        ST_Transform(p.geom, 3857),
        bounds.env,
        4096, 64, true
      ) AS geom
    FROM plot p
    JOIN parcel pa ON pa.id = p.parcel_id, bounds
    WHERE p.deleted_at IS NULL
      AND p.tenant_id = app_tenant_id()
      AND (tile_plots.farm_id IS NULL OR pa.farm_id = tile_plots.farm_id)
      AND (tile_plots.parcel_id IS NULL OR p.parcel_id = tile_plots.parcel_id)
      AND ST_Transform(p.geom, 3857) && bounds.env
  )
  SELECT ST_AsMVT(mvtgeom.*, 'plots', 4096, 'geom')
  FROM mvtgeom
  WHERE geom IS NOT NULL;
$$;

-- -----------------------------------------------------------------------------
-- 4. Active crop plans (with crop info, color-codable on client)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tile_crop_plans(
  z integer, x integer, y integer,
  season_id uuid DEFAULT NULL,
  status text DEFAULT 'active'
)
RETURNS bytea
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  WITH bounds AS (
    SELECT ST_TileEnvelope(z, x, y) AS env
  ),
  mvtgeom AS (
    SELECT
      cp.id,
      cp.plot_id,
      cp.crop_id,
      c.name AS crop_name,
      c.category AS crop_category,
      cp.season_id,
      cp.status,
      cp.area_ha::float8 AS area_ha,
      cp.planned_sowing_date,
      cp.planned_harvest_date,
      ST_AsMVTGeom(
        ST_Transform(cp.geom, 3857),
        bounds.env,
        4096, 64, true
      ) AS geom
    FROM crop_plan cp
    JOIN crop c ON c.id = cp.crop_id, bounds
    WHERE cp.deleted_at IS NULL
      AND cp.tenant_id = app_tenant_id()
      AND (tile_crop_plans.season_id IS NULL OR cp.season_id = tile_crop_plans.season_id)
      AND (tile_crop_plans.status   IS NULL OR cp.status    = tile_crop_plans.status)
      AND ST_Transform(cp.geom, 3857) && bounds.env
  )
  SELECT ST_AsMVT(mvtgeom.*, 'crop_plans', 4096, 'geom')
  FROM mvtgeom
  WHERE geom IS NOT NULL;
$$;

-- -----------------------------------------------------------------------------
-- 5. Infrastructure (mixed point/line/polygon)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tile_infrastructure(
  z integer, x integer, y integer,
  farm_id uuid DEFAULT NULL,
  type_filter text DEFAULT NULL
)
RETURNS bytea
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  WITH bounds AS (
    SELECT ST_TileEnvelope(z, x, y) AS env
  ),
  mvtgeom AS (
    SELECT
      i.id,
      i.farm_id,
      i.type,
      i.name,
      ST_AsMVTGeom(
        ST_Transform(i.geom, 3857),
        bounds.env,
        4096, 64, true
      ) AS geom
    FROM infrastructure i, bounds
    WHERE i.deleted_at IS NULL
      AND i.tenant_id = app_tenant_id()
      AND (tile_infrastructure.farm_id IS NULL OR i.farm_id = tile_infrastructure.farm_id)
      AND (tile_infrastructure.type_filter IS NULL OR i.type = tile_infrastructure.type_filter)
      AND ST_Transform(i.geom, 3857) && bounds.env
  )
  SELECT ST_AsMVT(mvtgeom.*, 'infrastructure', 4096, 'geom')
  FROM mvtgeom
  WHERE geom IS NOT NULL;
$$;

-- -----------------------------------------------------------------------------
-- 6. Sensors with last-reading cluster info
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tile_sensors(
  z integer, x integer, y integer,
  type_filter text DEFAULT NULL
)
RETURNS bytea
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  WITH bounds AS (
    SELECT ST_TileEnvelope(z, x, y) AS env
  ),
  mvtgeom AS (
    SELECT
      s.id,
      s.farm_id,
      s.type,
      s.device_id,
      s.status,
      ST_AsMVTGeom(
        ST_Transform(s.geom, 3857),
        bounds.env,
        4096, 64, true
      ) AS geom
    FROM sensor s, bounds
    WHERE s.tenant_id = app_tenant_id()
      AND (tile_sensors.type_filter IS NULL OR s.type = tile_sensors.type_filter)
      AND ST_Transform(s.geom, 3857) && bounds.env
  )
  SELECT ST_AsMVT(mvtgeom.*, 'sensors', 4096, 'geom')
  FROM mvtgeom
  WHERE geom IS NOT NULL;
$$;

-- -----------------------------------------------------------------------------
-- 7. Yield heatmap by crop plan
-- -----------------------------------------------------------------------------
-- Joins crop_plan polygons with their cumulative harvest yield.
-- Useful at low zooms for "where did we produce the most this season".
CREATE OR REPLACE FUNCTION public.tile_yield_heatmap(
  z integer, x integer, y integer,
  season_id uuid DEFAULT NULL
)
RETURNS bytea
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  WITH bounds AS (
    SELECT ST_TileEnvelope(z, x, y) AS env
  ),
  yield AS (
    SELECT
      cp.id AS crop_plan_id,
      cp.geom,
      cp.area_ha,
      COALESCE(SUM(h.quantity_kg), 0) AS total_kg
    FROM crop_plan cp
    LEFT JOIN harvest h ON h.crop_plan_id = cp.id
    WHERE cp.tenant_id = app_tenant_id()
      AND cp.deleted_at IS NULL
      AND (tile_yield_heatmap.season_id IS NULL OR cp.season_id = tile_yield_heatmap.season_id)
    GROUP BY cp.id
  ),
  mvtgeom AS (
    SELECT
      y.crop_plan_id,
      y.area_ha::float8 AS area_ha,
      y.total_kg::float8 AS total_kg,
      CASE WHEN y.area_ha > 0 THEN (y.total_kg / y.area_ha)::float8 ELSE 0 END AS kg_per_ha,
      ST_AsMVTGeom(
        ST_Transform(y.geom, 3857),
        bounds.env,
        4096, 64, true
      ) AS geom
    FROM yield y, bounds
    WHERE ST_Transform(y.geom, 3857) && bounds.env
  )
  SELECT ST_AsMVT(mvtgeom.*, 'yield_heatmap', 4096, 'geom')
  FROM mvtgeom
  WHERE geom IS NOT NULL;
$$;

-- -----------------------------------------------------------------------------
-- 8. Outgrower contract polygons
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tile_contracts(
  z integer, x integer, y integer,
  season_id uuid DEFAULT NULL,
  status text DEFAULT NULL
)
RETURNS bytea
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  WITH bounds AS (
    SELECT ST_TileEnvelope(z, x, y) AS env
  ),
  mvtgeom AS (
    SELECT
      c.id,
      c.outgrower_id,
      c.season_id,
      c.crop_id,
      cr.name AS crop_name,
      c.status,
      c.area_ha::float8 AS area_ha,
      c.expected_yield_kg::float8 AS expected_yield_kg,
      ST_AsMVTGeom(
        ST_Transform(c.geom, 3857),
        bounds.env,
        4096, 64, true
      ) AS geom
    FROM contract c
    JOIN crop cr ON cr.id = c.crop_id, bounds
    WHERE c.tenant_id = app_tenant_id()
      AND (tile_contracts.season_id IS NULL OR c.season_id = tile_contracts.season_id)
      AND (tile_contracts.status    IS NULL OR c.status    = tile_contracts.status)
      AND ST_Transform(c.geom, 3857) && bounds.env
  )
  SELECT ST_AsMVT(mvtgeom.*, 'contracts', 4096, 'geom')
  FROM mvtgeom
  WHERE geom IS NOT NULL;
$$;

-- -----------------------------------------------------------------------------
-- 9. Recent activity tracks (mobile GPS captures)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tile_activity_tracks(
  z integer, x integer, y integer,
  days int DEFAULT 7
)
RETURNS bytea
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  WITH bounds AS (
    SELECT ST_TileEnvelope(z, x, y) AS env
  ),
  src AS (
    SELECT
      ca.id,
      ca.crop_plan_id,
      ca.type,
      ca.performed_by_id,
      ca.completed_at,
      ca.geom_track AS geom
    FROM crop_activity ca
    WHERE ca.tenant_id = app_tenant_id()
      AND ca.geom_track IS NOT NULL
      AND ca.completed_at >= now() - (tile_activity_tracks.days || ' days')::interval
    UNION ALL
    SELECT
      ca.id,
      ca.crop_plan_id,
      ca.type,
      ca.performed_by_id,
      ca.completed_at,
      ca.geom_point AS geom
    FROM crop_activity ca
    WHERE ca.tenant_id = app_tenant_id()
      AND ca.geom_point IS NOT NULL
      AND ca.geom_track IS NULL
      AND ca.completed_at >= now() - (tile_activity_tracks.days || ' days')::interval
  ),
  mvtgeom AS (
    SELECT
      s.id,
      s.crop_plan_id,
      s.type,
      s.performed_by_id,
      ST_AsMVTGeom(
        ST_Transform(s.geom, 3857),
        bounds.env,
        4096, 64, true
      ) AS geom
    FROM src s, bounds
    WHERE ST_Transform(s.geom, 3857) && bounds.env
  )
  SELECT ST_AsMVT(mvtgeom.*, 'activity_tracks', 4096, 'geom')
  FROM mvtgeom
  WHERE geom IS NOT NULL;
$$;

-- -----------------------------------------------------------------------------
-- 10. Single-tenant tile cache helper
-- -----------------------------------------------------------------------------
-- pg_tileserv has its own LRU. If you front it with Nginx, set:
--
--   add_header Cache-Control "private, max-age=60" always;
--
-- and invalidate by appending a `?v=<server_seq>` cache-buster from the client
-- whenever a write succeeds. The MAX(server_seq) per layer is the cleanest
-- versioning signal.

CREATE OR REPLACE FUNCTION public.tile_layer_versions()
RETURNS TABLE(layer text, version bigint)
LANGUAGE sql STABLE AS $$
  SELECT 'farms'      AS layer, COALESCE(MAX(server_seq),0) FROM farm
   WHERE tenant_id = app_tenant_id() AND deleted_at IS NULL
  UNION ALL
  SELECT 'parcels',   COALESCE(MAX(server_seq),0) FROM parcel
   WHERE tenant_id = app_tenant_id() AND deleted_at IS NULL
  UNION ALL
  SELECT 'plots',     COALESCE(MAX(server_seq),0) FROM plot
   WHERE tenant_id = app_tenant_id() AND deleted_at IS NULL
  UNION ALL
  SELECT 'crop_plans',COALESCE(MAX(server_seq),0) FROM crop_plan
   WHERE tenant_id = app_tenant_id() AND deleted_at IS NULL
  UNION ALL
  SELECT 'contracts', COALESCE(MAX(server_seq),0) FROM contract
   WHERE tenant_id = app_tenant_id();
$$;

-- =============================================================================
-- Quick test:
--   SELECT length(public.tile_farms(0, 0, 0));   -- world tile, should be > 0
--   SELECT * FROM public.tile_layer_versions();
-- =============================================================================
