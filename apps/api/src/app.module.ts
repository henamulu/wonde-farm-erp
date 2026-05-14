// =============================================================================
// apps/api/src/app.module.ts
// =============================================================================
// Wires all feature modules, applies global guards, registers the config
// surface, and exposes /health for Caddy + uptime monitors.
// =============================================================================

import { Controller, Get, Module } from '@nestjs/common';
import { APP_GUARD, APP_FILTER, APP_PIPE } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ValidationPipe } from '@nestjs/common';

import * as Joi from 'joi';

import { PrismaModule, PrismaService } from './prisma/prisma.service';
import { AuthModule, JwtAuthGuard } from './auth/auth.module';
import { SyncModule } from './sync/sync.module';
import { GeomModule } from './geom/validate-geom.controller';
// import { TenantModule } from './tenant/tenant.module';            // signup, billing
// import { PlotsModule } from './plots/plots.module';               // CRUD + tile invalidation
// import { CropPlansModule } from './crop-plans/crop-plans.module';
// import { ActivitiesModule } from './activities/activities.module';
// import { InventoryModule } from './inventory/inventory.module';
// import { AccountingModule } from './accounting/accounting.module';
// import { ReportsModule } from './reports/reports.module';
// import { WebhooksModule } from './webhooks/webhooks.module';      // weather, payments, MQTT bridge

import { GlobalExceptionFilter } from './common/global-exception.filter';

// -----------------------------------------------------------------------------
// Config validation — fail fast at boot if anything's missing
// -----------------------------------------------------------------------------
const ENV_SCHEMA = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('production'),
  PORT: Joi.number().default(3000),

  DATABASE_URL: Joi.string().uri().required(),
  DATABASE_ADMIN_URL: Joi.string().uri().required(),

  JWT_ACCESS_SECRET: Joi.string().min(32).required(),
  JWT_REFRESH_SECRET: Joi.string().min(32).required(),

  MINIO_ENDPOINT: Joi.string().required(),
  MINIO_PORT: Joi.number().default(9000),
  MINIO_USE_SSL: Joi.boolean().default(false),
  MINIO_ACCESS_KEY: Joi.string().required(),
  MINIO_SECRET_KEY: Joi.string().required(),
  MINIO_BUCKET: Joi.string().default('farm-erp-uploads'),

  REDIS_URL: Joi.string().uri().required(),
  MQTT_URL: Joi.string().uri().optional(),

  PUBLIC_BASE_URL: Joi.string().uri().required(),
  CORS_ORIGINS: Joi.string().required(),     // comma-separated
});

// -----------------------------------------------------------------------------
// Health controller — kept tiny on purpose
// -----------------------------------------------------------------------------
// Distinguishes liveness (process is up) from readiness (deps are reachable).
@Controller('health')
class HealthController {
  constructor(private prisma: PrismaService) {}

  @Get()
  liveness() {
    return { status: 'ok', uptime_s: process.uptime() };
  }

  @Get('ready')
  async readiness() {
    const checks: Record<string, 'ok' | string> = {};
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.postgres = 'ok';
    } catch (e: any) { checks.postgres = e.message; }
    const ok = Object.values(checks).every((v) => v === 'ok');
    return { status: ok ? 'ok' : 'degraded', checks };
  }
}

// -----------------------------------------------------------------------------
// AppModule
// -----------------------------------------------------------------------------
@Module({
  imports: [
    PrismaModule,
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: ENV_SCHEMA,
      validationOptions: { allowUnknown: true, abortEarly: false },
      cache: true,
    }),

    // Throttler: per-IP rate limit. Fine-tune per controller with @Throttle.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => [
        // Default: 120 req/min per IP. Sync push gets its own override.
        { name: 'default', ttl: 60_000, limit: 120 },
      ],
    }),

    AuthModule,
    SyncModule,
    GeomModule,
    // TenantModule, PlotsModule, CropPlansModule, ActivitiesModule,
    // InventoryModule, AccountingModule, ReportsModule, WebhooksModule,
  ],

  controllers: [HealthController],

  providers: [
    // Global guards — order matters: throttle first, then auth.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },

    // Single global filter for consistent JSON error shape
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },

    // Strict global pipe: trims unknown DTO fields, transforms types,
    // surfaces validation errors as 400 with a clean payload
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    },
  ],

  
})
export class AppModule {}
