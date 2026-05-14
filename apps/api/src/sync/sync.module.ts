// =============================================================================
// apps/api/src/sync/sync.module.ts
// =============================================================================
// Order matters: classes must be defined BEFORE they're referenced by
// decorators on other classes. Service first, then controller, then module.
// =============================================================================

import {
  BadRequestException, Body, Controller, Injectable, Logger, Module, Post,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { JwtAuthGuard, AuthUser, CurrentUser } from '../auth/auth.module';
import { PrismaService, PrismaTx } from '../prisma/prisma.service';

type SyncTable = string;

const WRITE_POLICY: Record<string, ('create' | 'update')[]> = {
  crop_activity: ['create', 'update'],
  harvest:       ['create'],
  qc_test:       ['create'],
  attendance:    ['create', 'update'],
  stock_move:    ['create'],
};

interface TableMeta {
  table: string;
  geomColumns: Record<string, string>;
  jsonColumns: string[];
  pullable: boolean;
}

const TABLE_META: Record<string, TableMeta> = {
  crop:           { table: 'crop',           geomColumns: {}, jsonColumns: ['metadata'], pullable: true },
  season:         { table: 'season',         geomColumns: {}, jsonColumns: [], pullable: true },
  sku:            { table: 'sku',            geomColumns: {}, jsonColumns: ['attributes'], pullable: true },
  qc_protocol:    { table: 'qc_protocol',    geomColumns: {}, jsonColumns: ['parameters'], pullable: true },
  account:        { table: 'account',        geomColumns: {}, jsonColumns: [], pullable: true },
  warehouse:      { table: 'warehouse',      geomColumns: { geom: 'Point' }, jsonColumns: ['capacity'], pullable: true },
  partner:        { table: 'partner',        geomColumns: { geom: 'Point' }, jsonColumns: ['address','metadata'], pullable: true },
  employee:       { table: 'employee',       geomColumns: {}, jsonColumns: ['salary_model'], pullable: true },
  farm:           { table: 'farm',           geomColumns: { geom: 'MultiPolygon' }, jsonColumns: ['certifications'], pullable: true },
  parcel:         { table: 'parcel',         geomColumns: { geom: 'Polygon' }, jsonColumns: [], pullable: true },
  plot:           { table: 'plot',           geomColumns: { geom: 'Polygon' }, jsonColumns: [], pullable: true },
  infrastructure: { table: 'infrastructure', geomColumns: { geom: 'Geometry' }, jsonColumns: ['attributes'], pullable: true },
  crop_plan:      { table: 'crop_plan',      geomColumns: { geom: 'Polygon' }, jsonColumns: [], pullable: true },
  crop_activity:  { table: 'crop_activity',  geomColumns: { geom_track: 'MultiLineString', geom_point: 'Point' }, jsonColumns: ['inputs_used','photos'], pullable: true },
  harvest:        { table: 'harvest',        geomColumns: { geom: 'Polygon' }, jsonColumns: [], pullable: true },
  qc_test:        { table: 'qc_test',        geomColumns: {}, jsonColumns: ['results'], pullable: true },
  attendance:     { table: 'attendance',     geomColumns: { in_geom: 'Point', out_geom: 'Point' }, jsonColumns: [], pullable: true },
  stock_move:     { table: 'stock_move',     geomColumns: {}, jsonColumns: ['ref_doc'], pullable: true },
};

// -----------------------------------------------------------------------------
// SyncService — must be defined BEFORE SyncController (which depends on it)
// -----------------------------------------------------------------------------

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);
  private readonly schemaVersion = '2026.05.01';
  private readonly hardLimit = 1000;

  constructor(private prisma: PrismaService) {}

  async manifest(u: AuthUser): Promise<any> {
    return this.prisma.withTenant({ tenantId: u.tenantId, userId: u.id }, async (tx) => {
      const rows: Array<{ layer: string; version: number }> = await tx.$queryRaw`SELECT * FROM public.tile_layer_versions()`;
      const versions = Object.fromEntries(rows.map((r) => [r.layer, r.version]));
      return {
        server_now: new Date().toISOString(),
        schema_version: this.schemaVersion,
        table_versions: versions,
        must_resync: false,
      };
    });
  }

  async pull(u: AuthUser, req: any): Promise<any> {
    const limit = Math.min(req.limit ?? 500, this.hardLimit);
    const tables = (req.tables ?? Object.keys(TABLE_META)) as string[];
    const cursor = req.cursor ?? 0;

    return this.prisma.withTenant({ tenantId: u.tenantId, userId: u.id }, async (tx) => {
      return {
        rows: [],
        next_cursor: cursor,
        has_more: false,
        server_now: new Date().toISOString(),
      };
    });
  }

  async push(u: AuthUser, req: any): Promise<any> {
    if (!Array.isArray(req.mutations) || req.mutations.length > 200) {
      throw new BadRequestException('mutations[] required, max 200 per request');
    }
    return { results: [], high_water: 0 };
  }
}

// -----------------------------------------------------------------------------
// PhotosService
// -----------------------------------------------------------------------------

@Injectable()
export class PhotosService {
  constructor(private prisma: PrismaService) {}

  async presign(u: AuthUser, filenames: string[]) {
    return filenames.map((f) => {
      const key = `tenants/${u.tenantId}/uploads/${randomUUID()}-${f}`;
      return {
        filename: f, key,
        url: `https://minio.example.local/${key}?presigned`,
        expires_in: 900,
        headers: { 'Content-Type': 'image/jpeg' },
      };
    });
  }

  async confirm(u: AuthUser, body: { client_id: string; table: string; photos: any[] }) {
    return { ok: true };
  }
}

// -----------------------------------------------------------------------------
// SyncController — depends on SyncService, defined AFTER it
// -----------------------------------------------------------------------------

@Controller('sync')
@UseGuards(JwtAuthGuard)
export class SyncController {
  constructor(private sync: SyncService) {}

  @Post('manifest')
  manifest(@CurrentUser() u: AuthUser): Promise<any> {
    return this.sync.manifest(u);
  }

  @Post('pull')
  pull(@CurrentUser() u: AuthUser, @Body() body: any): Promise<any> {
    return this.sync.pull(u, body);
  }

  @Post('push')
  push(@CurrentUser() u: AuthUser, @Body() body: any): Promise<any> {
    return this.sync.push(u, body);
  }
}

// -----------------------------------------------------------------------------
// Module — references all of the above
// -----------------------------------------------------------------------------

@Module({
  controllers: [SyncController],
  providers: [SyncService, PhotosService],
  exports: [SyncService],
})
export class SyncModule {}
