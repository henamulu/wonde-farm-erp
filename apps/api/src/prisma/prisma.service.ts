// =============================================================================
// apps/api/src/prisma/prisma.service.ts
// =============================================================================
// PrismaService that knows about tenant + user context for RLS.
//
// Every query that touches business data must run inside `withTenant(...)`,
// which wraps the work in a transaction and SETs `app.tenant_id` /
// `app.user_id` GUCs that postgis-setup.sql's RLS policies and audit
// triggers rely on.
//
// Background jobs (no user) use `withTenantAsAdmin(...)` which sets the
// tenant but no user — those connections should ideally use the `app_admin`
// role with BYPASSRLS for cross-tenant work.
// =============================================================================

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

export type PrismaTx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

export interface TenantContext {
  tenantId: string;
  userId?: string;
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: process.env.NODE_ENV === 'development'
        ? ['query', 'error', 'warn']
        : ['error', 'warn'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Run `fn` inside a transaction with `app.tenant_id` and (if provided)
   * `app.user_id` set as session-local GUCs. RLS policies and the audit
   * trigger pick these up automatically.
   *
   * IMPORTANT: pgBouncer must be in *transaction* pooling mode (not session)
   * for `set_config(..., true)` to scope correctly. Session pooling would
   * leak the GUC across requests.
   */
  async withTenant<T>(
    ctx: TenantContext,
    fn: (tx: PrismaTx) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${ctx.tenantId}, true)`;
      if (ctx.userId) {
        await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
      }
      return fn(tx as unknown as PrismaTx);
    }, {
      // Slow geometry inserts can run long; default 5s is too tight.
      timeout: 30_000,
      maxWait: 10_000,
    });
  }

  /**
   * Same as `withTenant` but also sets a "system" user id. Use for sync
   * jobs, scheduled tasks, webhook handlers — anywhere there's no real
   * authenticated user but we still want clean audit lines.
   */
  async withTenantAsAdmin<T>(
    tenantId: string,
    fn: (tx: PrismaTx) => Promise<T>,
  ): Promise<T> {
    return this.withTenant({ tenantId, userId: '00000000-0000-0000-0000-000000000001' }, fn);
  }

  /**
   * Escape hatch for cross-tenant work (auth, tenant provisioning, billing).
   * Does NOT set GUCs. Caller MUST be running as the `app_admin` Postgres
   * role (BYPASSRLS) — otherwise queries will silently return empty results.
   */
  async raw(): Promise<this> {
    return this;
  }
}
