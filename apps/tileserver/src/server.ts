// =============================================================================
// apps/tileserver/src/server.ts
// =============================================================================
// Tiny tile server that serves MVT tiles from the existing PostGIS
// `tile_*` functions WITH proper RLS isolation. Replaces pg_tileserv.
//
// Why not pg_tileserv?
//   pg_tileserv pools its own connections and offers no per-request hook
//   to set the `app.tenant_id` GUC our RLS policies depend on. We'd have
//   to disable RLS on tile functions and trust a proxy — same security
//   posture, more moving parts. A 100-line custom server is simpler.
//
// What this does:
//   1. Validates a JWT (same secret as the API)
//   2. Extracts tenant_id from the JWT claim
//   3. Acquires a Postgres connection, opens a transaction, sets
//      app.tenant_id LOCALLY for that transaction
//   4. Calls the matching `tile_<layer>(z,x,y, ...)` function
//   5. Returns the MVT bytes with strong ETag/cache headers
//
// Required deps:
//   npm i fastify @fastify/cors @fastify/jwt pg
// =============================================================================

import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import jwtPlugin from '@fastify/jwt';
import { Pool, PoolClient } from 'pg';
import { createHash } from 'node:crypto';

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};

const PORT     = Number(env('PORT', '7800'));
const DB_URL   = env('DATABASE_URL'); // app_user role; RLS applies
const JWT_SEC  = env('JWT_ACCESS_SECRET');
const POOL_MAX = Number(env('PG_POOL_MAX', '20'));
const CORS_ORIGINS = env('CORS_ORIGINS', '*').split(',').map((s) => s.trim());

// -----------------------------------------------------------------------------
// Layer registry — explicit allow-list of which functions are exposed.
// Adding a new tile function to PostGIS is not enough; it has to land here
// to be reachable. This is a deliberate guard against accidental data
// leaks via "any function whose name starts with tile_".
// -----------------------------------------------------------------------------

interface LayerSpec {
  /** Postgres function name (without `public.`). */
  fn: string;
  /** Allowed query parameters and how to bind them. */
  params: Array<{ name: string; cast: 'uuid' | 'text' | 'int' | 'bool' }>;
  /** Optional: name of the underlying table for ETag / version detection. */
  versionTable?: string;
}

const LAYERS: Record<string, LayerSpec> = {
  farms:           { fn: 'tile_farms',           params: [], versionTable: 'farm' },
  parcels:         { fn: 'tile_parcels',         params: [{ name: 'farm_id', cast: 'uuid' }], versionTable: 'parcel' },
  plots:           { fn: 'tile_plots',           params: [
                       { name: 'farm_id',   cast: 'uuid' },
                       { name: 'parcel_id', cast: 'uuid' },
                     ], versionTable: 'plot' },
  crop_plans:      { fn: 'tile_crop_plans',      params: [
                       { name: 'season_id', cast: 'uuid' },
                       { name: 'status',    cast: 'text' },
                     ], versionTable: 'crop_plan' },
  infrastructure:  { fn: 'tile_infrastructure',  params: [
                       { name: 'farm_id',     cast: 'uuid' },
                       { name: 'type_filter', cast: 'text' },
                     ] },
  sensors:         { fn: 'tile_sensors',         params: [{ name: 'type_filter', cast: 'text' }] },
  yield_heatmap:   { fn: 'tile_yield_heatmap',   params: [{ name: 'season_id', cast: 'uuid' }] },
  contracts:       { fn: 'tile_contracts',       params: [
                       { name: 'season_id', cast: 'uuid' },
                       { name: 'status',    cast: 'text' },
                     ], versionTable: 'contract' },
  activity_tracks: { fn: 'tile_activity_tracks', params: [{ name: 'days', cast: 'int' }] },
};

// -----------------------------------------------------------------------------
// Fastify app
// -----------------------------------------------------------------------------

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  trustProxy: true,        // we sit behind Caddy
  disableRequestLogging: false,
});

await app.register(cors, {
  origin: CORS_ORIGINS.length === 1 && CORS_ORIGINS[0] === '*' ? true : CORS_ORIGINS,
  credentials: true,
});

await app.register(jwtPlugin, {
  secret: JWT_SEC,
  verify: { algorithms: ['HS256'] },
});

// -----------------------------------------------------------------------------
// Postgres pool — single shared pool, transactions per request
// -----------------------------------------------------------------------------

const pool = new Pool({
  connectionString: DB_URL,
  max: POOL_MAX,
  idleTimeoutMillis: 30_000,
  // Important: tile generation can be CPU-bound on Postgres. If your DB
  // is small, drop POOL_MAX so MVT generation doesn't starve the API.
});

pool.on('error', (err) => app.log.error({ err }, 'pg pool error'));

interface JwtClaims { sub: string; tid: string; roles: string[] }

// -----------------------------------------------------------------------------
// Tile route
// -----------------------------------------------------------------------------
// GET /:layer/:z/:x/:y.pbf?<filters>
//   - Authorization: Bearer <jwt> OR Cookie: access_token=<jwt>
//   - If-None-Match: <etag>     → may return 304
// -----------------------------------------------------------------------------

app.get<{
  Params: { layer: string; z: string; x: string; y: string };
}>('/:layer/:z/:x/:y.pbf', async (req, reply) => {
  const { layer } = req.params;
  const z = Number(req.params.z);
  const x = Number(req.params.x);
  const y = Number(req.params.y);

  // ---- 1. Validate route ----
  const spec = LAYERS[layer];
  if (!spec) return reply.code(404).send({ error: { code: 'unknown_layer' } });
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) {
    return reply.code(400).send({ error: { code: 'bad_tile_coords' } });
  }
  if (z < 0 || z > 22 || x < 0 || y < 0 || x >= (1 << z) || y >= (1 << z)) {
    return reply.code(400).send({ error: { code: 'tile_out_of_range' } });
  }

  // ---- 2. Auth ----
  const claims = await verifyJwt(req, reply);
  if (!claims) return; // verifyJwt already replied

  // ---- 3. Parse + cast query parameters ----
  const args: any[] = [z, x, y];
  for (const p of spec.params) {
    const raw = (req.query as Record<string, string | undefined>)[p.name];
    args.push(raw === undefined ? null : castParam(raw, p.cast));
  }

  // ---- 4. ETag short-circuit ----
  let etag: string | undefined;
  if (spec.versionTable) {
    etag = await computeEtag(claims.tid, spec.versionTable, layer, z, x, y, spec, args);
    if (etag && req.headers['if-none-match'] === etag) {
      return reply
        .header('etag', etag)
        .header('cache-control', 'private, max-age=60, must-revalidate')
        .code(304)
        .send();
    }
  }

  // ---- 5. Render the tile ----
  const bytes = await renderTile(claims.tid, spec.fn, args);

  // Empty tile (no features in this bbox) → return zero-length 204. Most
  // map clients treat empty 200 and 204 the same; 204 saves a few bytes.
  if (bytes.length === 0) {
    return reply.code(204).header('cache-control', 'private, max-age=60').send();
  }

  reply
    .header('content-type', 'application/vnd.mapbox-vector-tile')
    .header('cache-control', 'private, max-age=60, must-revalidate')
    .header('content-encoding', 'identity'); // PostGIS already produces uncompressed MVT

  if (etag) reply.header('etag', etag);
  return reply.send(bytes);
});

// -----------------------------------------------------------------------------
// Health
// -----------------------------------------------------------------------------

app.get('/health', async () => ({ status: 'ok' }));
app.get('/health/ready', async (_req, reply) => {
  try {
    await pool.query('SELECT 1');
    return { status: 'ok' };
  } catch (err: any) {
    return reply.code(503).send({ status: 'degraded', error: err.message });
  }
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function verifyJwt(req: FastifyRequest, reply: FastifyReply): Promise<JwtClaims | null> {
  // Prefer Authorization header; fall back to cookie
  let token: string | undefined;
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) token = auth.slice(7);
  else token = parseCookie(req.headers.cookie ?? '', 'access_token');

  if (!token) {
    reply.code(401).send({ error: { code: 'unauthenticated' } });
    return null;
  }
  try {
    const claims = await app.jwt.verify<JwtClaims>(token);
    if (!claims?.tid || !claims?.sub) {
      reply.code(401).send({ error: { code: 'malformed_token' } });
      return null;
    }
    return claims;
  } catch (err: any) {
    reply.code(401).send({ error: { code: 'invalid_token', message: err.message } });
    return null;
  }
}

function parseCookie(header: string, name: string): string | undefined {
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function castParam(raw: string, cast: 'uuid' | 'text' | 'int' | 'bool'): any {
  switch (cast) {
    case 'uuid':
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
        throw new Error('invalid uuid');
      }
      return raw;
    case 'int':  { const n = parseInt(raw, 10); if (Number.isNaN(n)) throw new Error('invalid int'); return n; }
    case 'bool': return raw === 'true' || raw === '1';
    case 'text': return raw.slice(0, 256); // bound the input
  }
}

async function withTenant<T>(
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function renderTile(tenantId: string, fn: string, args: any[]): Promise<Buffer> {
  return withTenant(tenantId, async (client) => {
    const placeholders = args.map((_, i) => `$${i + 1}`).join(',');
    const sql = `SELECT public.${fn}(${placeholders}) AS mvt`;
    const r = await client.query<{ mvt: Buffer | null }>(sql, args);
    return r.rows[0]?.mvt ?? Buffer.alloc(0);
  });
}

/**
 * ETag = sha256(tenant_id || layer || z || x || y || max(server_seq) of underlying table).
 * That gives us "client cached version is still current" semantics with
 * automatic invalidation as soon as anyone writes to the table.
 *
 * The MAX(server_seq) query is cheap because we have a btree index on it.
 * Cache the result in-process for 5s to absorb burst traffic from a single
 * map view loading dozens of tiles at once.
 */
const versionCache = new Map<string, { v: string; expiresAt: number }>();

async function computeEtag(
  tenantId: string, table: string, layer: string,
  z: number, x: number, y: number,
  _spec: LayerSpec, args: any[],
): Promise<string | undefined> {
  try {
    const cacheKey = `${tenantId}:${table}`;
    let version: string | undefined;
    const hit = versionCache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) {
      version = hit.v;
    } else {
      const v = await withTenant(tenantId, async (c) => {
        const r = await c.query<{ s: string | null }>(
          `SELECT COALESCE(MAX(server_seq), 0)::text AS s FROM ${table}`,
        );
        return r.rows[0]?.s ?? '0';
      });
      version = v;
      versionCache.set(cacheKey, { v, expiresAt: Date.now() + 5_000 });
    }

    // Include tile coords + filter args so different param combos don't
    // collide on the same etag.
    const argsKey = JSON.stringify(args.slice(3)); // skip z/x/y already covered
    const h = createHash('sha256')
      .update(`${tenantId}:${layer}:${z}:${x}:${y}:${version}:${argsKey}`)
      .digest('base64url')
      .slice(0, 22);
    return `"${h}"`;
  } catch (err) {
    app.log.warn({ err }, 'etag computation failed; serving without etag');
    return undefined;
  }
}

// -----------------------------------------------------------------------------
// Lifecycle
// -----------------------------------------------------------------------------

const shutdown = async (sig: string) => {
  app.log.info({ sig }, 'shutting down');
  try { await app.close(); } catch (e) { app.log.warn({ e }, 'fastify close failed'); }
  try { await pool.end();  } catch (e) { app.log.warn({ e }, 'pg pool close failed'); }
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT',  () => void shutdown('SIGINT'));

await app.listen({ port: PORT, host: '0.0.0.0' });
app.log.info(`tileserver listening on :${PORT} (layers: ${Object.keys(LAYERS).join(', ')})`);
