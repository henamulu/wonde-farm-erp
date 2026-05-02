// =============================================================================
// apps/api/src/geom/validate-geom.controller.ts
// =============================================================================
// Live geometry validation endpoint. Runs the same checks that the BEFORE
// INSERT/UPDATE triggers run in postgis-setup.sql, but returns the result
// as structured JSON instead of raising an exception. Used by the web
// editor to show live red/green status as the user draws.
//
// The triggers remain authoritative — this endpoint is purely UX. It must
// never be the only line of defence; the server's INSERT path will catch
// anything that slips past.
// =============================================================================

import {
  Body, Controller, Injectable, Module, Post, UseGuards, ValidationPipe,
  UsePipes, BadRequestException,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsArray, IsEnum, IsObject, IsOptional, IsUUID, ValidateNested,
} from 'class-validator';

import { JwtAuthGuard, AuthUser, CurrentUser } from '../auth/auth.module';
import { PrismaService } from '../prisma/prisma.service';

// -----------------------------------------------------------------------------
// DTOs
// -----------------------------------------------------------------------------

/** A subset of GeoJSON we care about. */
class GeoJsonPolygonDto {
  @IsEnum(['Polygon'])
  type!: 'Polygon';

  @IsArray()
  coordinates!: number[][][];
}

class ValidateGeomDto {
  /** Which entity is being validated. */
  @IsEnum(['parcel', 'plot', 'crop_plan', 'contract'])
  entity!: 'parcel' | 'plot' | 'crop_plan' | 'contract';

  /** GeoJSON polygon in EPSG:4326. */
  @ValidateNested()
  @Type(() => GeoJsonPolygonDto)
  geom!: GeoJsonPolygonDto;

  /** UUID of the parent feature (farm for parcel; parcel for plot; plot for crop_plan). */
  @IsUUID()
  parentId!: string;

  /** When editing an existing row, exclude it from sibling-overlap checks. */
  @IsOptional()
  @IsUUID()
  excludeId?: string;

  /** For crop_plan: needed for season-scoped overlap. */
  @IsOptional()
  @IsUUID()
  seasonId?: string;
}

// -----------------------------------------------------------------------------
// Response shape (shared with the client via packages/sync or packages/shared)
// -----------------------------------------------------------------------------

export interface ValidationError {
  code:
    | 'invalid_geometry'
    | 'wrong_srid'
    | 'outside_parent'
    | 'overlaps_sibling'
    | 'too_small'
    | 'too_large'
    | 'parent_not_found';
  message: string;
  /** Optional details — e.g. for overlap, the conflicting siblings. */
  details?: Record<string, unknown>;
}

export interface ValidationWarning {
  code: 'auto_repaired' | 'near_boundary' | 'unusual_shape';
  message: string;
}

export interface ValidateGeomResponse {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  /** Square metres (geographic, not projected). */
  area_m2: number;
  /** Hectares — convenience. */
  area_ha: number;
  /** If `auto_repaired` was emitted, the cleaned geometry the client should adopt. */
  fixed_geom?: GeoJsonPolygonDto;
}

// -----------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------

@Injectable()
export class ValidateGeomService {
  // Per-entity area sanity bounds (hectares).
  private readonly bounds: Record<string, { min: number; max: number }> = {
    parcel:    { min: 0.001, max: 5_000 },
    plot:      { min: 0.001, max: 1_000 },
    crop_plan: { min: 0.001, max: 1_000 },
    contract:  { min: 0.001, max: 5_000 },
  };

  // Map entity → (table holding it, table holding parent, parent FK column)
  private readonly graph: Record<
    string,
    { childTable: string; parentTable: string; parentFk: string; siblingScope?: string }
  > = {
    parcel:    { childTable: 'parcel',    parentTable: 'farm',   parentFk: 'farm_id' },
    plot:      { childTable: 'plot',      parentTable: 'parcel', parentFk: 'parcel_id' },
    crop_plan: { childTable: 'crop_plan', parentTable: 'plot',   parentFk: 'plot_id', siblingScope: 'season_id' },
    contract:  { childTable: 'contract',  parentTable: 'farm',   parentFk: 'farm_id' /* simplified */ },
  };

  constructor(private prisma: PrismaService) {}

  async validate(u: AuthUser, dto: ValidateGeomDto): Promise<ValidateGeomResponse> {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    return this.prisma.withTenant({ tenantId: u.tenantId, userId: u.id }, async (tx) => {
      const geomJson = JSON.stringify(dto.geom);
      const cfg = this.graph[dto.entity];
      const limits = this.bounds[dto.entity];

      // -- 1. Validity + SRID + repair --
      const repairRows: Array<{
        is_valid: boolean;
        was_valid: boolean;
        fixed: any;
        srid: number;
        area_m2: number;
      }> = await tx.$queryRaw`
        WITH input AS (
          SELECT ST_SetSRID(ST_GeomFromGeoJSON(${geomJson}::text), 4326) AS g
        ),
        fixed AS (
          SELECT
            ST_IsValid(g)                AS was_valid,
            CASE WHEN ST_IsValid(g) THEN g ELSE ST_MakeValid(g) END AS g
          FROM input
        )
        SELECT
          ST_IsValid(g)            AS is_valid,
          was_valid,
          ST_AsGeoJSON(g)::jsonb   AS fixed,
          ST_SRID(g)               AS srid,
          ST_Area(g::geography)    AS area_m2
        FROM fixed
      `;
      const r = repairRows[0];

      if (!r) {
        errors.push({ code: 'invalid_geometry', message: 'failed to parse geometry' });
        return this.fail(errors, warnings, 0);
      }

      if (r.srid !== 4326) {
        errors.push({ code: 'wrong_srid', message: `expected SRID 4326, got ${r.srid}` });
      }

      let fixed_geom: GeoJsonPolygonDto | undefined;
      if (!r.was_valid) {
        if (r.is_valid) {
          warnings.push({
            code: 'auto_repaired',
            message: 'self-intersection auto-repaired; adopt the returned geometry',
          });
          fixed_geom = r.fixed as GeoJsonPolygonDto;
        } else {
          errors.push({
            code: 'invalid_geometry',
            message: 'geometry is invalid and cannot be auto-repaired',
          });
          return this.fail(errors, warnings, r.area_m2 ?? 0, fixed_geom);
        }
      }

      const areaM2 = Number(r.area_m2);
      const areaHa = areaM2 / 10_000;

      // -- 2. Area sanity --
      if (areaHa < limits.min) {
        errors.push({
          code: 'too_small',
          message: `area ${areaHa.toFixed(4)} ha is below minimum ${limits.min} ha`,
        });
      }
      if (areaHa > limits.max) {
        errors.push({
          code: 'too_large',
          message: `area ${areaHa.toFixed(1)} ha exceeds maximum ${limits.max} ha`,
        });
      }

      // -- 3. Containment (must be ST_Within parent, with cm tolerance) --
      const containmentRows: Array<{ within: boolean; near_edge: boolean }> = await tx.$queryRawUnsafe(
        `
        WITH parent AS (
          SELECT geom FROM ${cfg.parentTable}
          WHERE id = $1::uuid AND tenant_id = $2::uuid
            ${cfg.parentTable === 'farm' || cfg.parentTable === 'parcel' || cfg.parentTable === 'plot' ? "AND deleted_at IS NULL" : ""}
        ),
        candidate AS (
          SELECT ST_SetSRID(ST_GeomFromGeoJSON($3::text), 4326) AS g
        )
        SELECT
          ST_Within(c.g, ST_Buffer(p.geom::geography, 0.01)::geometry) AS within,
          ST_DWithin(c.g::geography, ST_Boundary(p.geom)::geography, 1.0) AS near_edge
        FROM candidate c, parent p
        `,
        dto.parentId, u.tenantId, geomJson,
      );

      if (containmentRows.length === 0) {
        errors.push({ code: 'parent_not_found', message: 'parent feature not found in this tenant' });
      } else {
        const c = containmentRows[0];
        if (!c.within) {
          errors.push({ code: 'outside_parent', message: 'geometry is not contained in the parent feature' });
        } else if (c.near_edge) {
          warnings.push({ code: 'near_boundary', message: 'edge is within 1 m of parent boundary' });
        }
      }

      // -- 4. Overlap with siblings --
      // Same logic as the trigger: for plot, no overlap with same-parcel
      // siblings; for crop_plan, no overlap with same-plot/season siblings.
      const overlapClauses: string[] = [`${cfg.parentFk} = $1::uuid`, `tenant_id = $2::uuid`];
      const overlapParams: any[] = [dto.parentId, u.tenantId, geomJson];

      if (cfg.childTable === 'parcel' || cfg.childTable === 'plot' || cfg.childTable === 'crop_plan') {
        overlapClauses.push('deleted_at IS NULL');
      }
      if (dto.excludeId) {
        overlapClauses.push(`id <> $${overlapParams.length + 1}::uuid`);
        overlapParams.push(dto.excludeId);
      }
      if (cfg.siblingScope === 'season_id' && dto.seasonId) {
        overlapClauses.push(`season_id = $${overlapParams.length + 1}::uuid`);
        overlapParams.push(dto.seasonId);
        overlapClauses.push(`status IN ('draft','active')`);
      }

      const overlapSql = `
        WITH candidate AS (
          SELECT ST_SetSRID(ST_GeomFromGeoJSON($3::text), 4326) AS g
        )
        SELECT s.id, s.code,
               ST_Area(ST_Intersection(s.geom, c.g)::geography) AS overlap_m2
          FROM ${cfg.childTable} s, candidate c
         WHERE ${overlapClauses.join(' AND ')}
           AND ST_Overlaps(s.geom, c.g)
         LIMIT 5
      `;
      const overlaps: Array<{ id: string; code: string; overlap_m2: number }> =
        await tx.$queryRawUnsafe(overlapSql, ...overlapParams);

      if (overlaps.length) {
        errors.push({
          code: 'overlaps_sibling',
          message: `overlaps with ${overlaps.length} existing ${cfg.childTable}(s)`,
          details: { conflicts: overlaps.map((o) => ({ id: o.id, code: o.code, overlap_ha: Number(o.overlap_m2) / 10_000 })) },
        });
      }

      return {
        valid: errors.length === 0,
        errors,
        warnings,
        area_m2: areaM2,
        area_ha: Number(areaHa.toFixed(4)),
        fixed_geom,
      };
    });
  }

  private fail(
    errors: ValidationError[],
    warnings: ValidationWarning[],
    area_m2: number,
    fixed_geom?: GeoJsonPolygonDto,
  ): ValidateGeomResponse {
    return {
      valid: false,
      errors,
      warnings,
      area_m2,
      area_ha: Number((area_m2 / 10_000).toFixed(4)),
      fixed_geom,
    };
  }
}

// -----------------------------------------------------------------------------
// Controller
// -----------------------------------------------------------------------------

@Controller('geom')
@UseGuards(JwtAuthGuard)
export class ValidateGeomController {
  constructor(private svc: ValidateGeomService) {}

  @Post('validate')
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  validate(@CurrentUser() u: AuthUser, @Body() dto: ValidateGeomDto) {
    return this.svc.validate(u, dto);
  }
}

@Module({
  controllers: [ValidateGeomController],
  providers: [ValidateGeomService],
  exports: [ValidateGeomService],
})
export class GeomModule {}
