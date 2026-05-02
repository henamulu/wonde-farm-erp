// =============================================================================
// apps/api/src/main.ts
// =============================================================================
// Production bootstrap. Runs in this order:
//   1. Patch BigInt → JSON (must be before any Prisma query returns)
//   2. NestFactory create
//   3. Security middleware (helmet, compression, cookies)
//   4. CORS with allow-list
//   5. Swagger (only in non-prod or behind a flag)
//   6. Graceful shutdown wired to SIGTERM/SIGINT
// =============================================================================

// -----------------------------------------------------------------------------
// 1. BigInt → JSON. Prisma returns BigInt for `server_seq` columns; without
//    this, JSON.stringify throws "Do not know how to serialize a BigInt".
// -----------------------------------------------------------------------------
(BigInt.prototype as any).toJSON = function () {
  // 2^53 - 1 = 9_007_199_254_740_991 → fine for the global_server_seq lifetime
  // of any human-scale farm ERP. If you're worried, return this.toString().
  return Number(this);
};

import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';

import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    // We use the default Nest logger here; in real prod swap to nestjs-pino.
  });
  const cfg = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  // ---------------------------------------------------------------------------
  // Express-level middlewares
  // ---------------------------------------------------------------------------
  app.set('trust proxy', 1);  // Caddy is in front; trust X-Forwarded-* once
  app.use(
    helmet({
      // We let Caddy set HSTS/CSP at the edge so it's consistent across all
      // services, including pg_tileserv and MinIO.
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(compression({ threshold: 1024 }));
  app.use(cookieParser());

  // Strip body size limits to a sensible default — sync push can be large.
  app.useBodyParser('json', { limit: '10mb' });
  app.useBodyParser('urlencoded', { limit: '10mb', extended: true });

  // ---------------------------------------------------------------------------
  // CORS
  // ---------------------------------------------------------------------------
  const allowedOrigins = (cfg.get<string>('CORS_ORIGINS') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  app.enableCors({
    origin: (origin, cb) => {
      // Allow no-origin (mobile apps, curl) and explicitly allow-listed origins
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Device-Id'],
    exposedHeaders: ['X-Server-Seq'],
    maxAge: 600,
  });

  // ---------------------------------------------------------------------------
  // API versioning + global prefix
  // ---------------------------------------------------------------------------
  app.setGlobalPrefix('', { exclude: ['health', 'health/(.*)'] });
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
    prefix: 'v',
  });

  // ---------------------------------------------------------------------------
  // Swagger / OpenAPI — disabled in production unless explicitly enabled
  // ---------------------------------------------------------------------------
  if (cfg.get('NODE_ENV') !== 'production' || process.env.ENABLE_DOCS === '1') {
    const docCfg = new DocumentBuilder()
      .setTitle('Farm ERP API')
      .setDescription('Internal API for the Farm ERP. Authenticated endpoints require a JWT Bearer token.')
      .setVersion('1.0')
      .addBearerAuth()
      .addCookieAuth('access_token')
      .build();
    const doc = SwaggerModule.createDocument(app, docCfg);
    SwaggerModule.setup('docs', app, doc, {
      swaggerOptions: { persistAuthorization: true },
    });
    logger.log('Swagger UI mounted at /docs');
  }

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------
  app.enableShutdownHooks();
  // Nest already wires SIGTERM/SIGINT → app.close() via enableShutdownHooks().
  // The PrismaService.OnModuleDestroy will close DB connections cleanly.
  // BullMQ workers (apps/worker) handle their own draining in worker.ts.

  // ---------------------------------------------------------------------------
  // Listen
  // ---------------------------------------------------------------------------
  const port = cfg.get<number>('PORT') ?? 3000;
  await app.listen(port, '0.0.0.0');

  logger.log(`API listening on :${port}`);
  logger.log(`Public base URL: ${cfg.get('PUBLIC_BASE_URL')}`);
  logger.log(`CORS origins: ${allowedOrigins.join(', ') || '(none)'}`);
}

// Top-level error capture so a bootstrap crash gets logged
bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal: bootstrap failed', err);
  process.exit(1);
});

// -----------------------------------------------------------------------------
// Don't let an unhandled rejection silently kill the process during sync.
// -----------------------------------------------------------------------------
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('uncaughtException:', err);
  // Better to crash and restart cleanly than continue in unknown state
  process.exit(1);
});
