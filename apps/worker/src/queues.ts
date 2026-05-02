// =============================================================================
// apps/worker/src/queues.ts
// =============================================================================
// Job processors + schedule registration.
//
// Queues:
//   ndvi       — fetch Sentinel-2 imagery, compute NDVI, store as COG
//   reports    — generate scheduled reports (weekly P&L per crop_plan, etc.)
//   gc         — generic GC (sync_conflict pruning, audit_log retention)
//   photos_gc  — find orphan MinIO objects + delete them
//
// Each processor is an async function the BullMQ Worker calls. Throwing
// from a processor makes BullMQ retry per the job's `attempts` config;
// returning normally completes the job.
// =============================================================================

import { Job, Queue } from 'bullmq';
import IORedis from 'ioredis';
import { Logger } from '@nestjs/common';
import { prisma, minio } from './main';

const log = new Logger('Jobs');

// -----------------------------------------------------------------------------
// Queue names — exported so producers (the API) can enqueue ad-hoc jobs too.
// Pattern: when an agronomist clicks "refresh NDVI now" in the UI, the API
// calls Queue.add(Q_NDVI, {...}). Same code path as the scheduled trigger.
// -----------------------------------------------------------------------------

export const Q_NDVI      = 'ndvi';
export const Q_REPORTS   = 'reports';
export const Q_GC        = 'gc';
export const Q_PHOTOS_GC = 'photos_gc';

// -----------------------------------------------------------------------------
// Helper: open a per-tenant transaction for raw queries with RLS enforced
// -----------------------------------------------------------------------------

async function withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn();
  }, { timeout: 60_000 });
}

// =============================================================================
// 1. NDVI fetcher
// =============================================================================
// Fetches a Sentinel-2 L2A scene covering the farm's bounding box for a
// given week, computes NDVI, stores the result as a Cloud-Optimized GeoTIFF
// in MinIO, and records the snapshot in `ndvi_snapshot`.
//
// The `fetchSentinelNdvi` function is provider-agnostic — implement it
// against Copernicus Data Space Ecosystem (free) or Sentinel Hub (paid,
// nicer API). I've left a clear seam.
// =============================================================================

export interface NdviJobData {
  tenantId: string;
  farmId: string;
  /** ISO date for the requested observation window centre. */
  date: string;
  /** ± days around `date` to search for cloud-free scene. */
  windowDays?: number;
}

export async function ndviProcessor(job: Job<NdviJobData>): Promise<{ key: string; cloud_pct: number }> {
  const { tenantId, farmId, date, windowDays = 7 } = job.data;
  job.log(`NDVI tenant=${tenantId} farm=${farmId} date=${date}`);

  // ---- 1. Look up farm bounding box (geographic) ----
  const farms = await withTenant(tenantId, () => prisma.$queryRaw<Array<{
    id: string; bbox_geojson: any; area_ha: number;
  }>>`
    SELECT id,
           ST_AsGeoJSON(ST_Envelope(geom))::jsonb AS bbox_geojson,
           area_ha
      FROM farm
     WHERE id = ${farmId}::uuid
       AND tenant_id = ${tenantId}::uuid
       AND deleted_at IS NULL
  `);
  const farm = farms[0];
  if (!farm) throw new Error(`farm ${farmId} not found`);

  await job.updateProgress(10);

  // ---- 2. Fetch raster from Sentinel provider ----
  // This returns a GeoTIFF buffer of single-band NDVI values [-1, 1] mapped
  // to int8 [-100, 100]. Implement against your chosen provider.
  const { tiff, observedAt, cloudPct } = await fetchSentinelNdvi({
    bbox: farm.bbox_geojson,
    date, windowDays,
  });

  await job.updateProgress(60);

  // ---- 3. Convert to Cloud-Optimized GeoTIFF + upload to MinIO ----
  // Easiest path: shell out to gdal_translate with COG driver. We assume
  // the worker image has gdal-bin installed (add `RUN apk add gdal` to its
  // Dockerfile). Skipping the conversion command for brevity — see the
  // worker Dockerfile.
  const cogBuf = await convertToCog(tiff);
  const key = `tenants/${tenantId}/ndvi/${farmId}/${date}.tif`;
  await minio.putObject(process.env.MINIO_BUCKET ?? 'farm-erp-uploads', key, cogBuf, cogBuf.length, {
    'Content-Type': 'image/tiff',
    'x-amz-meta-tenant': tenantId,
    'x-amz-meta-farm-id': farmId,
    'x-amz-meta-observed-at': observedAt,
    'x-amz-meta-cloud-pct': String(cloudPct),
  });

  await job.updateProgress(80);

  // ---- 4. Record metadata row ----
  // Add this table to schema.prisma:
  //   model NdviSnapshot {
  //     id BigInt @id @default(autoincrement())
  //     tenantId String @map("tenant_id") @db.Uuid
  //     farmId   String @map("farm_id") @db.Uuid
  //     observedAt DateTime
  //     cloudPct  Decimal? @db.Decimal(5,2)
  //     fileKey   String
  //     createdAt DateTime @default(now())
  //     @@index([tenantId, farmId, observedAt])
  //     @@map("ndvi_snapshot")
  //   }
  await withTenant(tenantId, async () => {
    await prisma.$executeRaw`
      INSERT INTO ndvi_snapshot (tenant_id, farm_id, observed_at, cloud_pct, file_key)
      VALUES (${tenantId}::uuid, ${farmId}::uuid, ${observedAt}::timestamptz, ${cloudPct}, ${key})
      ON CONFLICT DO NOTHING
    `;
  });

  await job.updateProgress(100);
  return { key, cloud_pct: cloudPct };
}

// ---- Provider abstraction ----
// Real implementation: signed POST to Sentinel Hub Process API or
// Copernicus DataSpace OData → download → process → return TIFF.
async function fetchSentinelNdvi(_opts: {
  bbox: any; date: string; windowDays: number;
}): Promise<{ tiff: Buffer; observedAt: string; cloudPct: number }> {
  // TODO: real impl. Below is a stub that returns a tiny 1×1 TIFF so
  // schedules can cycle without blowing up before you wire credentials.
  log.warn('fetchSentinelNdvi: STUB — wire to Copernicus/Sentinel Hub before prod');
  const stub = Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00]); // valid TIFF header
  return { tiff: stub, observedAt: new Date().toISOString(), cloudPct: 0 };
}

async function convertToCog(input: Buffer): Promise<Buffer> {
  // Real impl: write `input` to /tmp/in.tif, exec `gdal_translate -of COG`,
  // read /tmp/out.tif. Or use a pure-JS COG writer (none are mature).
  // For now, pass through.
  return input;
}

// =============================================================================
// 2. Reports — weekly P&L per crop_plan, exported as PDF to MinIO
// =============================================================================

export interface ReportJobData {
  tenantId: string;
  kind: 'weekly_pnl' | 'monthly_inventory' | 'compliance_export';
  /** ISO date — start of the period. */
  periodStart: string;
  /** Optional recipient — emails the link if present. */
  notifyUserId?: string;
}

export async function reportsProcessor(job: Job<ReportJobData>): Promise<{ key: string; rows: number }> {
  const { tenantId, kind, periodStart } = job.data;
  job.log(`report ${kind} tenant=${tenantId} from=${periodStart}`);

  let key: string; let rows = 0;

  switch (kind) {
    case 'weekly_pnl': {
      // Pull the per-crop-plan P&L from the convenience view we set up in postgis-setup.sql
      const data = await withTenant(tenantId, () => prisma.$queryRaw<Array<{
        crop_plan_id: string; status: string; area_ha: number;
        revenue_cents: number; cost_cents: number; yield_kg: number;
      }>>`
        SELECT crop_plan_id, status, area_ha, revenue_cents, cost_cents, yield_kg
          FROM v_crop_plan_pnl
         WHERE tenant_id = ${tenantId}::uuid
      `);
      rows = data.length;

      // Render to PDF. In production: spawn puppeteer or hit a `/internal/render`
      // endpoint on the API that uses Handlebars + html-pdf. Here we emit
      // CSV as a placeholder.
      const csv = [
        'crop_plan_id,status,area_ha,revenue,cost,yield_kg',
        ...data.map((r) =>
          [r.crop_plan_id, r.status, r.area_ha, r.revenue_cents/100, r.cost_cents/100, r.yield_kg].join(','),
        ),
      ].join('\n');
      const buf = Buffer.from(csv, 'utf-8');
      key = `tenants/${tenantId}/reports/weekly-pnl-${periodStart}.csv`;
      await minio.putObject(process.env.MINIO_BUCKET!, key, buf, buf.length, {
        'Content-Type': 'text/csv',
      });
      break;
    }
    case 'monthly_inventory':
    case 'compliance_export':
      throw new Error(`report kind ${kind} not yet implemented`);
  }

  // Persist to compliance_report so the user can find it in the UI
  await withTenant(tenantId, async () => {
    await prisma.$executeRaw`
      INSERT INTO compliance_report (id, tenant_id, kind, period_start, period_end, payload, status, file_key)
      VALUES (
        gen_random_uuid(), ${tenantId}::uuid, ${kind},
        ${periodStart}::date,
        (${periodStart}::date + INTERVAL '7 days')::date,
        ${JSON.stringify({ rows })}::jsonb,
        'draft',
        ${key}
      )
    `;
  });

  return { key, rows };
}

// =============================================================================
// 3. GC — sync_conflict + audit_log retention
// =============================================================================

export interface GcJobData {
  /** Optional tenant scope; null = run across all tenants (admin job). */
  tenantId?: string;
  /** Days to keep before pruning. */
  conflictRetentionDays?: number;
  auditRetentionDays?: number;
}

export async function gcProcessor(job: Job<GcJobData>): Promise<{ conflicts: number; audit: number }> {
  const conflictDays = job.data.conflictRetentionDays ?? 30;
  const auditDays    = job.data.auditRetentionDays    ?? 365;

  // GC runs as superuser — we want it to span ALL tenants. So we use raw
  // queries WITHOUT setting app.tenant_id and rely on running as `app_admin`.
  const conflicts: number = await prisma.$executeRaw`
    DELETE FROM sync_conflict
     WHERE resolved_at IS NOT NULL
       AND resolved_at < NOW() - (${conflictDays}::int || ' days')::interval
  `;

  const audit: number = await prisma.$executeRaw`
    DELETE FROM audit_log
     WHERE occurred_at < NOW() - (${auditDays}::int || ' days')::interval
  `;

  job.log(`GC: ${conflicts} conflicts, ${audit} audit_log rows deleted`);
  return { conflicts: Number(conflicts), audit: Number(audit) };
}

// =============================================================================
// 4. Photos GC — orphan MinIO objects with no row referencing them
// =============================================================================
// An "orphan" is a key in the uploads bucket that:
//   - doesn't appear in any photo_queue.remote_key (it was never confirmed)
//   - AND was uploaded more than 24h ago (allow in-flight uploads to finish)
//
// We list MinIO via the streaming API; for each candidate we check if
// any row references the key. If not, delete it.
// =============================================================================

export interface PhotosGcJobData {
  bucket?: string;
  /** Skip objects newer than this many hours (default 24). */
  graceHours?: number;
}

export async function photosGcProcessor(job: Job<PhotosGcJobData>): Promise<{ checked: number; deleted: number }> {
  const bucket = job.data.bucket ?? process.env.MINIO_BUCKET ?? 'farm-erp-uploads';
  const graceMs = (job.data.graceHours ?? 24) * 3600_000;
  const cutoff = Date.now() - graceMs;

  let checked = 0;
  let deleted = 0;

  const stream = minio.listObjectsV2(bucket, '', true);
  // We accumulate candidates in batches to avoid per-object DB round-trips.
  const batch: Array<{ key: string; size: number }> = [];

  await new Promise<void>((resolve, reject) => {
    stream.on('data', async (obj) => {
      checked++;
      if (!obj.lastModified || obj.lastModified.getTime() > cutoff) return;
      batch.push({ key: obj.name!, size: obj.size ?? 0 });
      if (batch.length >= 200) {
        stream.pause();
        await processBatch(batch.splice(0)).then((d) => deleted += d).finally(() => stream.resume());
      }
    });
    stream.on('end',   () => resolve());
    stream.on('error', (err) => reject(err));
  });

  if (batch.length) deleted += await processBatch(batch);

  job.log(`photos_gc: checked=${checked} deleted=${deleted}`);
  return { checked, deleted };

  async function processBatch(items: typeof batch): Promise<number> {
    if (!items.length) return 0;
    // Find which keys ARE referenced. Anything missing from the result is
    // an orphan candidate.
    const keys = items.map((i) => i.key);
    const referenced: Array<{ key: string }> = await prisma.$queryRaw`
      SELECT DISTINCT key FROM (
        SELECT remote_key AS key FROM photo_queue WHERE remote_key = ANY(${keys}::text[])
        UNION ALL
        -- Also check inline photo references on rows that store {key,...} arrays:
        SELECT jsonb_array_elements(photos)->>'key' AS key
          FROM crop_activity
         WHERE photos @> ANY(SELECT jsonb_build_array(jsonb_build_object('key', k)) FROM unnest(${keys}::text[]) k)
      ) refs
      WHERE key = ANY(${keys}::text[])
    `;
    const refSet = new Set(referenced.map((r) => r.key));
    const orphans = items.filter((i) => !refSet.has(i.key));
    if (!orphans.length) return 0;

    // MinIO supports bulk remove
    const errors = await new Promise<Array<{ name?: string; error?: Error }>>((resolve) => {
      const errs: Array<{ name?: string; error?: Error }> = [];
      const r = minio.removeObjects(bucket, orphans.map((o) => o.key));
      r.then(() => resolve(errs)).catch((err) => { errs.push({ error: err }); resolve(errs); });
    });
    if (errors.length) log.warn(`photos_gc: ${errors.length} delete errors`);
    return orphans.length - errors.length;
  }
}

// =============================================================================
// Schedules — repeatable jobs registered at boot
// =============================================================================
// BullMQ stores the schedule in Redis under each queue's `repeat` key.
// `jobId` makes the schedule entry stable: re-running this function on
// boot does NOT create duplicate schedules.
// =============================================================================

export async function registerSchedules(connection: IORedis): Promise<void> {
  const ndvi      = new Queue<NdviJobData>     (Q_NDVI,      { connection: connection.duplicate() });
  const reports   = new Queue<ReportJobData>   (Q_REPORTS,   { connection: connection.duplicate() });
  const gc        = new Queue<GcJobData>       (Q_GC,        { connection: connection.duplicate() });
  const photos    = new Queue<PhotosGcJobData> (Q_PHOTOS_GC, { connection: connection.duplicate() });

  // ---- NDVI: per active farm, weekly on Mondays 03:00 UTC ----
  // We can't know the list of farms at module-load. The pattern: a single
  // "ndvi-tick" job runs on cron; its processor enqueues per-farm jobs.
  // Here we register the tick job into the GC queue (cheap, idempotent).
  await ndvi.add(
    'ndvi-tick',
    { tenantId: '__tick__', farmId: '__tick__', date: 'weekly' },
    {
      jobId: 'sched:ndvi-tick',
      repeat: { pattern: '0 3 * * 1', tz: 'UTC' }, // Mon 03:00 UTC
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 50 },
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
    },
  );

  // ---- Reports: weekly P&L every Monday 04:00 UTC, fan out per tenant ----
  await reports.add(
    'reports-tick',
    { tenantId: '__tick__', kind: 'weekly_pnl', periodStart: '__tick__' },
    {
      jobId: 'sched:reports-weekly',
      repeat: { pattern: '0 4 * * 1', tz: 'UTC' },
      removeOnComplete: { count: 50 },
      attempts: 2,
    },
  );

  // ---- GC: nightly at 02:00 UTC ----
  await gc.add(
    'gc-nightly',
    { conflictRetentionDays: 30, auditRetentionDays: 365 },
    {
      jobId: 'sched:gc-nightly',
      repeat: { pattern: '0 2 * * *', tz: 'UTC' },
      removeOnComplete: { count: 30 },
      attempts: 1,
    },
  );

  // ---- Photos GC: every 6 hours ----
  await photos.add(
    'photos-gc',
    { graceHours: 24 },
    {
      jobId: 'sched:photos-gc',
      repeat: { pattern: '0 */6 * * *', tz: 'UTC' },
      removeOnComplete: { count: 30 },
      attempts: 1,
    },
  );

  // The "tick" jobs above are placeholders. The actual fan-out happens in
  // tickProcessor below — replace ndviProcessor with this if you want the
  // tick pattern. For real use you'd have:
  //
  //   const tenants = await prisma.tenant.findMany();
  //   for (const t of tenants) {
  //     const farms = await prisma.farm.findMany({ where: { tenantId: t.id } });
  //     for (const f of farms) await ndvi.add('ndvi-fetch', { tenantId: t.id, farmId: f.id, date: today() });
  //   }

  log.log('schedules registered');

  // Important: don't `await queue.close()` here — the producers stay open
  // for the lifetime of the process so the API can also enqueue ad-hoc.
}

const log = new Logger('Schedules');
