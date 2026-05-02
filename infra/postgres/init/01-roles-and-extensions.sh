#!/bin/bash
# =============================================================================
# infra/postgres/init/01-roles-and-extensions.sh
# =============================================================================
# Runs ONCE when the Postgres container starts on an empty data volume.
# Creates the extensions and the two app roles (app_user, app_admin).
#
# After this, you must still run `prisma migrate deploy` to create the
# tables, then apply postgis-setup.sql (RLS, triggers, generated columns)
# and tile-functions.sql. The api-migrate compose service does that for you.
# =============================================================================

set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname farm_erp <<-EOSQL
  -- ------------------------------------------------------------------
  -- Extensions
  -- ------------------------------------------------------------------
  CREATE EXTENSION IF NOT EXISTS postgis;
  CREATE EXTENSION IF NOT EXISTS postgis_topology;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS citext;

  -- ------------------------------------------------------------------
  -- Roles
  --   app_user  → used by the API; subject to RLS
  --   app_admin → used by migrations and background jobs; BYPASSRLS
  -- ------------------------------------------------------------------
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
      CREATE ROLE app_user LOGIN PASSWORD '$APP_USER_PASSWORD';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin') THEN
      CREATE ROLE app_admin LOGIN PASSWORD '$APP_ADMIN_PASSWORD' BYPASSRLS CREATEDB;
    END IF;
  END
  \$\$;

  -- The migrate user owns the schema, so we grant it CREATE / ownership.
  GRANT ALL PRIVILEGES ON DATABASE farm_erp TO app_admin;
  GRANT CONNECT ON DATABASE farm_erp TO app_user;

  -- public schema permissions
  GRANT USAGE ON SCHEMA public TO app_user, app_admin;

  -- Default privileges on objects created LATER by the migrate role
  ALTER DEFAULT PRIVILEGES FOR ROLE app_admin IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
  ALTER DEFAULT PRIVILEGES FOR ROLE app_admin IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO app_user;
  ALTER DEFAULT PRIVILEGES FOR ROLE app_admin IN SCHEMA public
    GRANT EXECUTE ON FUNCTIONS TO app_user;

  -- Tighten template defaults: future databases shouldn't grant PUBLIC
  REVOKE ALL ON SCHEMA public FROM PUBLIC;

  -- ------------------------------------------------------------------
  -- Sanity log
  -- ------------------------------------------------------------------
  SELECT 'extensions: ' || string_agg(extname, ', ' ORDER BY extname)
    FROM pg_extension
   WHERE extname IN ('postgis','pgcrypto','pg_trgm','citext','postgis_topology');
EOSQL

echo "✓ postgres init complete (extensions + app_user + app_admin)"
