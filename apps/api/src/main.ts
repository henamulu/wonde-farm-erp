// =============================================================================
// apps/api/src/main.ts
// =============================================================================
// Production bootstrap.
// =============================================================================

import { NestFactory } from '@nestjs/core';
import { Logger, VersioningType } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';

import { AppModule } from './app.module';

// -----------------------------------------------------------------------------
// BigInt -> JSON. Prisma returns BigInt for `server_seq` columns; without
// this, JSON.stringify throws "Do not know how to serialize a BigInt".
// Must run before any Prisma query is serialized.
// -----------------------------------------------------------------------------
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function (this: bigint) {
  return Number(this);
};

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  const cfg = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  app.set('trust proxy', 1);
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(compression({ threshold: 1024 }));
  app.use(cookieParser());

  app.useBodyParser('json', { limit: '10mb' });
  app.useBodyParser('urlencoded', { limit: '10mb', extended: true });

  const allowedOrigins = (cfg.get<string>('CORS_ORIGINS') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  app.enableCors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Device-Id'],
    exposedHeaders: ['X-Server-Seq'],
    maxAge: 600,
  });

  app.setGlobalPrefix('', { exclude: ['health', 'health/(.*)'] });
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
    prefix: 'v',
  });

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

  app.enableShutdownHooks();

  const port = cfg.get<number>('PORT') ?? 3000;
  await app.listen(port, '0.0.0.0');

  logger.log(`API listening on :${port}`);
  logger.log(`Public base URL: ${cfg.get('PUBLIC_BASE_URL')}`);
  logger.log(`CORS origins: ${allowedOrigins.join(', ') || '(none)'}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal: bootstrap failed', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('uncaughtException:', err);
  process.exit(1);
});
