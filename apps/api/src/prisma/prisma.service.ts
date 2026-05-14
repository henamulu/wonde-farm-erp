// =============================================================================
// apps/api/src/prisma/prisma.service.ts
// =============================================================================

import { Global, Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/** The transactional client surface (no $connect / $transaction / etc). */
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
   * `app.user_id` set as session-local GUCs.
   */
  async withTenant<T>(
    ctx: TenantContext,
    fn: (tx: PrismaTx) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (tx: PrismaTx) => {
      await (tx as PrismaClient).$executeRaw`SELECT set_config('app.tenant_id', ${ctx.tenantId}, true)`;
      if (ctx.userId) {
        await (tx as PrismaClient).$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
      }
      return fn(tx);
    }, {
      timeout: 30_000,
      maxWait: 10_000,
    });
  }

  async withTenantAsAdmin<T>(
    tenantId: string,
    fn: (tx: PrismaTx) => Promise<T>,
  ): Promise<T> {
    return this.withTenant(
      { tenantId, userId: '00000000-0000-0000-0000-000000000001' },
      fn,
    );
  }

  async raw(): Promise<this> {
    return this;
  }
}
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
