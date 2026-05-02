// =============================================================================
// apps/worker/src/main.ts
// =============================================================================
// Background worker process. One Node process consuming from multiple
// BullMQ queues, plus a scheduler that registers repeatable jobs at boot.
//
// Run via Docker as `node dist/main.js`. The compose stack already has a
// `worker` service pointing at this entry point.
//
// Health endpoint on port 3001 so Caddy / uptime probes can monitor it.
// =============================================================================

import 'dotenv/config';
import { Logger } from '@nestjs/common';
import http from 'node:http';
import { Queue, QueueEvents, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';

import { PrismaClient } from '@prisma/client';
import { Client as MinioClient } from 'minio';

import {
  Q_NDVI, ndviProcessor,
  Q_REPORTS, reportsProcessor,
  Q_GC, gcProcessor,
  Q_PHOTOS_GC, photosGcProcessor,
  registerSchedules,
} from './queues';

// -----------------------------------------------------------------------------
// BigInt JSON fix (same as api/main.ts) — Prisma server_seq columns
// -----------------------------------------------------------------------------
(BigInt.prototype as any).toJSON = function () { return Number(this); };

// -----------------------------------------------------------------------------
// Shared resources
// -----------------------------------------------------------------------------

const log = new Logger('Worker');

const connection = new IORedis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,             // BullMQ requirement
  enableReadyCheck: true,
});

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

export const minio = new MinioClient({
  endPoint: process.env.MINIO_ENDPOINT!,
  port: Number(process.env.MINIO_PORT ?? 9000),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY!,
  secretKey: process.env.MINIO_SECRET_KEY!,
});

// -----------------------------------------------------------------------------
// Workers — each consumes one queue with its own concurrency setting
// -----------------------------------------------------------------------------

const workers: Worker[] = [];

function startWorker<T>(name: string, processor: (job: Job<T>) => Promise<unknown>, concurrency: number): Worker {
  const w = new Worker<T>(name, processor, {
    connection: connection.duplicate(),
    concurrency,
    autorun: true,
    // Move stalled jobs back to wait after this many seconds of no heartbeat
    stalledInterval: 30_000,
  });
  w.on('completed', (job) => log.log(`✓ ${name}#${job.id} completed in ${(job.finishedOn! - job.processedOn!)}ms`));
  w.on('failed',    (job, err) => log.error(`✗ ${name}#${job?.id} failed: ${err.message}`));
  w.on('error',     (err) => log.error(`worker[${name}] error: ${err.message}`));
  workers.push(w);
  return w;
}

// -----------------------------------------------------------------------------
// Queue events listeners — for centralised observability/log streaming
// -----------------------------------------------------------------------------

const events: QueueEvents[] = [];
function attachEvents(name: string) {
  const e = new QueueEvents(name, { connection: connection.duplicate() });
  e.on('progress', ({ jobId, data }) => log.debug?.(`${name}#${jobId} progress: ${JSON.stringify(data)}`));
  events.push(e);
}

// -----------------------------------------------------------------------------
// Health endpoint — lightweight, doesn't talk to Redis
// -----------------------------------------------------------------------------

function startHealthServer(port: number) {
  return http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/health/ready') {
      const ready = workers.every((w) => w.isRunning());
      res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        status: ready ? 'ok' : 'degraded',
        workers: workers.map((w) => ({ name: w.name, running: w.isRunning() })),
      }));
    } else {
      res.writeHead(404); res.end();
    }
  }).listen(port, () => log.log(`health server on :${port}`));
}

// -----------------------------------------------------------------------------
// Bootstrap
// -----------------------------------------------------------------------------

async function bootstrap() {
  await prisma.$connect();

  // Workers
  startWorker(Q_NDVI,      ndviProcessor,      Number(process.env.WORKER_NDVI_CONCURRENCY    ?? 2));
  startWorker(Q_REPORTS,   reportsProcessor,   Number(process.env.WORKER_REPORTS_CONCURRENCY ?? 4));
  startWorker(Q_GC,        gcProcessor,        Number(process.env.WORKER_GC_CONCURRENCY      ?? 1));
  startWorker(Q_PHOTOS_GC, photosGcProcessor,  Number(process.env.WORKER_PHOTOS_GC_CONCURRENCY ?? 1));

  // Queue events for logs
  for (const q of [Q_NDVI, Q_REPORTS, Q_GC, Q_PHOTOS_GC]) attachEvents(q);

  // Cron schedules
  await registerSchedules(connection);

  startHealthServer(Number(process.env.HEALTH_PORT ?? 3001));

  log.log('worker started');
}

// -----------------------------------------------------------------------------
// Graceful shutdown
// -----------------------------------------------------------------------------

let shuttingDown = false;
const shutdown = async (sig: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.log(`received ${sig}, shutting down`);

  // Stop accepting new jobs first; BullMQ Worker#close() lets the in-flight
  // job finish (with a timeout) then exits.
  await Promise.allSettled(workers.map((w) => w.close()));
  await Promise.allSettled(events.map((e) => e.close()));
  await prisma.$disconnect();
  await connection.quit().catch(() => {});

  log.log('worker stopped');
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT',  () => void shutdown('SIGINT'));
process.on('unhandledRejection', (r) => log.error(`unhandledRejection: ${r}`));
process.on('uncaughtException',  (e) => { log.error(`uncaughtException: ${e}`); process.exit(1); });

bootstrap().catch((err) => {
  log.error(`bootstrap failed: ${err.message}`);
  process.exit(1);
});
