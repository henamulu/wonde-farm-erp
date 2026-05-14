-- =============================================================================
-- Farm ERP — PostGIS, RLS, validation, sync, audit
-- =============================================================================
-- Run AFTER `prisma migrate deploy` has created the base tables.
-- This file is idempotent where reasonable; review before re-running on prod.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Extensions
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;
-- Optional, only if you actually use it:
-- CREATE EXTENSION IF NOT EXISTS timescaledb;

-- -----------------------------------------------------------------------------
-- 2. Tenant context helper
-- -----------------------------------------------------------------------------
-- The application MUST set `app.tenant_id` on every connection it borrows
-- from the pool. Pattern in NestJS with Prisma:
--
--   await prisma.$transaction(async (tx) => {
--     await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
--     // ... all queries inside the transaction see RLS-filtered data
--   });
--
-- The `true` third arg means "local to the transaction" — safe for pgBouncer
-- in transaction-pooling mode.

CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid;
$$;

-- -----------------------------------------------------------------------------
-- 3. Global sync sequence
-- -----------------------------------------------------------------------------
-- Single monotonic sequence used by every syncable table. Mobile clients
-- store the highest server_seq they've seen and ask for "rows newer than X".

CREATE SEQUENCE IF NOT EXISTS global_server_seq;

CREATE OR REPLACE FUNCTION bump_server_seq() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.server_seq := nextval('global_server_seq');
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Apply to every syncable table. Keep this list in sync with prisma schema.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'farm','parcel','plot','infrastructure','sensor',
    'crop_plan','crop_activity','harvest',
    'batch','stock_move',
    'contract','qc_test','attendance'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format($f$
      DROP TRIGGER IF EXISTS %1$I_bump_seq ON %1$I;
      CREATE TRIGGER %1$I_bump_seq
        BEFORE INSERT OR UPDATE ON %1$I
        FOR EACH ROW EXECUTE FUNCTION bump_server_seq();
    $f$, t);
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- 4. PostGIS columns: indexes + generated columns
-- -----------------------------------------------------------------------------
-- GiST indexes for every spatial column we'll query by location.
CREATE INDEX IF NOT EXISTS farm_geom_gix           ON farm USING GIST (geom);
CREATE INDEX IF NOT EXISTS parcel_geom_gix         ON parcel USING GIST (geom);
CREATE INDEX IF NOT EXISTS plot_geom_gix           ON plot USING GIST (geom);
CREATE INDEX IF NOT EXISTS infrastructure_geom_gix ON infrastructure USING GIST (geom);
CREATE INDEX IF NOT EXISTS sensor_geom_gix         ON sensor USING GIST (geom);
CREATE INDEX IF NOT EXISTS crop_plan_geom_gix      ON crop_plan USING GIST (geom);
CREATE INDEX IF NOT EXISTS harvest_geom_gix        ON harvest USING GIST (geom) WHERE geom IS NOT NULL;
CREATE INDEX IF NOT EXISTS warehouse_geom_gix      ON warehouse USING GIST (geom) WHERE geom IS NOT NULL;
CREATE INDEX IF NOT EXISTS attendance_in_geom_gix  ON attendance USING GIST (in_geom) WHERE in_geom IS NOT NULL;
CREATE INDEX IF NOT EXISTS contract_geom_gix       ON contract USING GIST (geom);
CREATE INDEX IF NOT EXISTS outgrower_farm_geom_gix ON outgrower USING GIST (farm_geom) WHERE farm_geom IS NOT NULL;

-- Stored generated columns. Prisma can read these but won't try to write them.
-- Drop and recreate is the simplest path during development; for prod use a
-- migration that adds them with `ADD COLUMN ... GENERATED ALWAYS AS ... STORED`.

ALTER TABLE farm
  DROP COLUMN IF EXISTS centroid,
  DROP COLUMN IF EXISTS area_ha;
ALTER TABLE farm
  ADD COLUMN centroid geometry(Point, 4326)
    GENERATED ALWAYS AS (ST_Centroid(geom)) STORED,
  ADD COLUMN area_ha numeric(12,4)
    GENERATED ALWAYS AS (ST_Area(geom::geography) / 10000.0) STORED;

ALTER TABLE parcel
  DROP COLUMN IF EXISTS area_ha;
ALTER TABLE parcel
  ADD COLUMN area_ha numeric(12,4)
    GENERATED ALWAYS AS (ST_Area(geom::geography) / 10000.0) STORED;

ALTER TABLE plot
  DROP COLUMN IF EXISTS area_ha;
ALTER TABLE plot
  ADD COLUMN area_ha numeric(12,4)
    GENERATED ALWAYS AS (ST_Area(geom::geography) / 10000.0) STORED;

ALTER TABLE crop_plan
  DROP COLUMN IF EXISTS area_ha;
ALTER TABLE crop_plan
  ADD COLUMN area_ha numeric(12,4)
    GENERATED ALWAYS AS (ST_Area(geom::geography) / 10000.0) STORED;

ALTER TABLE contract
  DROP COLUMN IF EXISTS area_ha;
ALTER TABLE contract
  ADD COLUMN area_ha numeric(12,4)
    GENERATED ALWAYS AS (ST_Area(geom::geography) / 10000.0) STORED;

-- -----------------------------------------------------------------------------
-- 5. Geometry validation triggers
-- -----------------------------------------------------------------------------
-- Pattern: BEFORE INSERT/UPDATE on geom — auto-fix invalid, enforce containment
-- in parent feature, optionally check non-overlap with siblings.

-- 5.1 Generic "make valid" helper
CREATE OR REPLACE FUNCTION enforce_valid_geom() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.geom IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT ST_IsValid(NEW.geom) THEN
    NEW.geom := ST_MakeValid(NEW.geom);
  END IF;
  IF NOT ST_IsValid(NEW.geom) THEN
    RAISE EXCEPTION 'geometry is invalid and cannot be repaired: %', ST_IsValidReason(NEW.geom);
  END IF;
  -- Ensure SRID is 4326
  IF ST_SRID(NEW.geom) <> 4326 THEN
    RAISE EXCEPTION 'geometry SRID must be 4326, got %', ST_SRID(NEW.geom);
  END IF;
  RETURN NEW;
END;
$$;

-- 5.2 Parcel must lie within its farm (with small tolerance)
CREATE OR REPLACE FUNCTION validate_parcel_geom() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  parent_geom geometry;
BEGIN
  PERFORM enforce_valid_geom();  -- type fix
  NEW.geom := ST_MakeValid(NEW.geom);

  SELECT geom INTO parent_geom FROM farm WHERE id = NEW.farm_id;
  IF parent_geom IS NULL THEN
    RAISE EXCEPTION 'parent farm % not found', NEW.farm_id;
  END IF;

  -- Buffer ~1cm to absorb floating-point precision noise
  IF NOT ST_Within(NEW.geom, ST_Buffer(parent_geom::geography, 0.01)::geometry) THEN
    RAISE EXCEPTION 'parcel.geom must be within farm.geom';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS parcel_validate_geom ON parcel;
CREATE TRIGGER parcel_validate_geom
  BEFORE INSERT OR UPDATE OF geom ON parcel
  FOR EACH ROW EXECUTE FUNCTION validate_parcel_geom();

-- 5.3 Plot must lie within its parcel + must not overlap siblings
CREATE OR REPLACE FUNCTION validate_plot_geom() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  parent_geom geometry;
  overlap_count int;
BEGIN
  IF NEW.geom IS NULL THEN
    RAISE EXCEPTION 'plot.geom cannot be null';
  END IF;
  IF NOT ST_IsValid(NEW.geom) THEN
    NEW.geom := ST_MakeValid(NEW.geom);
  END IF;
  IF ST_SRID(NEW.geom) <> 4326 THEN
    RAISE EXCEPTION 'plot.geom SRID must be 4326';
  END IF;

  SELECT geom INTO parent_geom FROM parcel WHERE id = NEW.parcel_id;
  IF NOT ST_Within(NEW.geom, ST_Buffer(parent_geom::geography, 0.01)::geometry) THEN
    RAISE EXCEPTION 'plot.geom must be within parcel.geom';
  END IF;

  -- No overlap with sibling plots (other plots in same parcel)
  SELECT count(*) INTO overlap_count
  FROM plot
  WHERE parcel_id = NEW.parcel_id
    AND id <> NEW.id
    AND deleted_at IS NULL
    AND ST_Overlaps(geom, NEW.geom);

  IF overlap_count > 0 THEN
    RAISE EXCEPTION 'plot.geom overlaps with existing plot(s) in same parcel';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS plot_validate_geom ON plot;
CREATE TRIGGER plot_validate_geom
  BEFORE INSERT OR UPDATE OF geom ON plot
  FOR EACH ROW EXECUTE FUNCTION validate_plot_geom();

-- 5.4 Crop plan must lie within its plot, no overlap with active plans on same plot
CREATE OR REPLACE FUNCTION validate_crop_plan_geom() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  parent_geom geometry;
  overlap_count int;
BEGIN
  IF NEW.geom IS NULL THEN
    RAISE EXCEPTION 'crop_plan.geom cannot be null';
  END IF;
  NEW.geom := ST_MakeValid(NEW.geom);

  SELECT geom INTO parent_geom FROM plot WHERE id = NEW.plot_id;
  IF NOT ST_Within(NEW.geom, ST_Buffer(parent_geom::geography, 0.01)::geometry) THEN
    RAISE EXCEPTION 'crop_plan.geom must be within plot.geom';
  END IF;

  -- No overlap with other active/draft plans on same plot in same season
  IF NEW.status IN ('draft','active') THEN
    SELECT count(*) INTO overlap_count
    FROM crop_plan
    WHERE plot_id = NEW.plot_id
      AND season_id = NEW.season_id
      AND id <> NEW.id
      AND status IN ('draft','active')
      AND deleted_at IS NULL
      AND ST_Overlaps(geom, NEW.geom);

    IF overlap_count > 0 THEN
      RAISE EXCEPTION 'crop_plan overlaps with active plan on same plot/season';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS crop_plan_validate_geom ON crop_plan;
CREATE TRIGGER crop_plan_validate_geom
  BEFORE INSERT OR UPDATE OF geom ON crop_plan
  FOR EACH ROW EXECUTE FUNCTION validate_crop_plan_geom();

-- 5.5 Attendance geofence check
CREATE OR REPLACE FUNCTION compute_attendance_geofence() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  any_farm_geom geometry;
BEGIN
  -- Aggregate all farm boundaries this employee could legitimately work on.
  -- Simplification: any farm in the same tenant. For stricter rules,
  -- join through an employee_farm_assignment table.
  SELECT ST_Union(f.geom) INTO any_farm_geom
  FROM farm f
  WHERE f.tenant_id = NEW.tenant_id
    AND f.deleted_at IS NULL;

  IF NEW.in_geom IS NOT NULL AND any_farm_geom IS NOT NULL THEN
    NEW.in_geofence_ok := ST_Within(
      NEW.in_geom,
      ST_Buffer(any_farm_geom::geography, 50)::geometry  -- 50m tolerance
    );
  END IF;
  IF NEW.out_geom IS NOT NULL AND any_farm_geom IS NOT NULL THEN
    NEW.out_geofence_ok := ST_Within(
      NEW.out_geom,
      ST_Buffer(any_farm_geom::geography, 50)::geometry
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS attendance_geofence ON attendance;
CREATE TRIGGER attendance_geofence
  BEFORE INSERT OR UPDATE OF in_geom, out_geom ON attendance
  FOR EACH ROW EXECUTE FUNCTION compute_attendance_geofence();

-- -----------------------------------------------------------------------------
-- 6. Row Level Security
-- -----------------------------------------------------------------------------
-- Apply identical "tenant_id matches session setting" policy to every business
-- table. The service-role connection (used for migrations and cross-tenant
-- jobs) should bypass RLS — see the BYPASSRLS role at the bottom.

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'farm','parcel','plot','infrastructure','sensor',
    'crop','season','crop_plan','crop_activity','harvest',
    'sku','warehouse','batch','stock_move',
    'partner','sales_order',
    'purchase_order',
    'invoice','payment',
    'account','journal','journal_entry','fiscal_period',
    'outgrower','contract','contract_advance','contract_delivery',
    'qc_protocol','qc_test',
    'employee','attendance','payroll_period','payslip',
    'audit_log','compliance_report','sync_checkpoint','sync_conflict'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$I_tenant_isolation ON %1$I;', t);
    EXECUTE format($p$
      CREATE POLICY %1$I_tenant_isolation ON %1$I
        USING (tenant_id = app_tenant_id())
        WITH CHECK (tenant_id = app_tenant_id());
    $p$, t);
  END LOOP;
END $$;

-- Tenant table itself: only superuser/service-role can list tenants.
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_self_only ON tenant;
CREATE POLICY tenant_self_only ON tenant
  USING (id = app_tenant_id());

-- -----------------------------------------------------------------------------
-- 7. Audit log trigger (write-side)
-- -----------------------------------------------------------------------------
-- Fires AFTER any INSERT/UPDATE/DELETE on flagged tables. The NestJS
-- interceptor still adds richer entries (with user context), but this is the
-- DB-level safety net so nothing escapes the audit.

CREATE OR REPLACE FUNCTION write_audit_log() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_action text;
  v_before jsonb;
  v_after  jsonb;
  v_id     text;
  v_tenant uuid;
BEGIN
  v_action := lower(TG_OP);
  IF (TG_OP = 'DELETE') THEN
    v_before := to_jsonb(OLD);
    v_after  := NULL;
    v_id     := OLD.id::text;
    v_tenant := OLD.tenant_id;
  ELSIF (TG_OP = 'UPDATE') THEN
    v_before := to_jsonb(OLD);
    v_after  := to_jsonb(NEW);
    v_id     := NEW.id::text;
    v_tenant := NEW.tenant_id;
  ELSE
    v_before := NULL;
    v_after  := to_jsonb(NEW);
    v_id     := NEW.id::text;
    v_tenant := NEW.tenant_id;
  END IF;

  INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, before, after)
  VALUES (v_tenant, app_user_id(), v_action, TG_TABLE_NAME, v_id, v_before, v_after);

  RETURN COALESCE(NEW, OLD);
END;
$$;

DO $$
DECLARE
  t text;
  audited text[] := ARRAY[
    'farm','parcel','plot',
    'crop_plan','crop_activity','harvest',
    'batch','stock_move',
    'sales_order','purchase_order','invoice','payment',
    'journal_entry',
    'contract','contract_advance','contract_delivery',
    'qc_test','attendance','payslip','compliance_report'
  ];
BEGIN
  FOREACH t IN ARRAY audited LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %1$I_audit ON %1$I;', t);
    EXECUTE format($f$
      CREATE TRIGGER %1$I_audit
        AFTER INSERT OR UPDATE OR DELETE ON %1$I
        FOR EACH ROW EXECUTE FUNCTION write_audit_log();
    $f$, t);
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- 8. Convenience views for analytics / per-plot P&L
-- -----------------------------------------------------------------------------
-- Per-crop-plan financial summary. The killer feature: real numbers tied
-- to a polygon you can render on the map.

CREATE OR REPLACE VIEW v_crop_plan_pnl AS
SELECT
  cp.tenant_id,
  cp.id AS crop_plan_id,
  cp.plot_id,
  cp.season_id,
  cp.status,
  cp.area_ha,
  cp.geom,
  -- Revenue: sum of credit on income accounts tagged with this plan
  COALESCE(SUM(jl.credit_cents) FILTER (WHERE a.type = 'income'), 0)
    - COALESCE(SUM(jl.debit_cents) FILTER (WHERE a.type = 'income'), 0)  AS revenue_cents,
  -- Cost: sum of debit on expense accounts tagged with this plan
  COALESCE(SUM(jl.debit_cents) FILTER (WHERE a.type = 'expense'), 0)
    - COALESCE(SUM(jl.credit_cents) FILTER (WHERE a.type = 'expense'), 0) AS cost_cents,
  -- Yield
  COALESCE((SELECT SUM(quantity_kg) FROM harvest h WHERE h.crop_plan_id = cp.id), 0) AS yield_kg
FROM crop_plan cp
LEFT JOIN journal_line jl ON jl.crop_plan_id = cp.id
LEFT JOIN account a       ON a.id = jl.account_id
LEFT JOIN journal_entry e ON e.id = jl.entry_id AND e.posted = true
WHERE cp.deleted_at IS NULL
GROUP BY cp.id;

-- Active production view — what's planted right now, with crop name resolved.
CREATE OR REPLACE VIEW v_active_production AS
SELECT
  cp.tenant_id,
  cp.id AS crop_plan_id,
  cp.plot_id,
  c.name AS crop_name,
  c.variety,
  cp.status,
  cp.planned_sowing_date,
  cp.planned_harvest_date,
  cp.area_ha,
  cp.geom
FROM crop_plan cp
JOIN crop c ON c.id = cp.crop_id
WHERE cp.status IN ('active','draft')
  AND cp.deleted_at IS NULL;

-- -----------------------------------------------------------------------------
-- 9. Roles
-- -----------------------------------------------------------------------------
-- Two roles in Postgres:
--   - `app_user`: connection role used by the API; subject to RLS
--   - `app_admin`: bypasses RLS, used for migrations & background jobs
--
-- Create them once per cluster:

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'change-me-in-prod';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin') THEN
    CREATE ROLE app_admin LOGIN PASSWORD 'change-me-in-prod' BYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO app_user, app_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user, app_admin;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user, app_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user, app_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user, app_admin;

-- -----------------------------------------------------------------------------
-- 10. Sanity checks
-- -----------------------------------------------------------------------------
-- Run these after a deploy to make sure nothing's misconfigured:
--
--   SELECT tablename, rowsecurity FROM pg_tables
--    WHERE schemaname='public' AND rowsecurity=false;
--   -- ^ should be empty (or only 'tenant', 'role', 'user' depending on choices)
--
--   SELECT relname, relhastriggers FROM pg_class
--    WHERE relname IN ('parcel','plot','crop_plan');
--   -- ^ should all be true
