// =============================================================================
// prisma/seed.ts
// =============================================================================
// Programmatic seed for any farm-boundary GeoJSON. Used as `prisma db seed`
// or `npm run seed -- --geojson path/to/boundary.geojson`.
//
// Required deps:
//   npm i -D ts-node @types/node
//   npm i proj4 @turf/area @turf/centroid @turf/bbox
//             @turf/intersect @turf/bbox-polygon
//   npm i bcrypt @types/bcrypt
//   npm i tsx                      # nicer than ts-node for one-off scripts
//
// In package.json:
//   "prisma": { "seed": "tsx prisma/seed.ts" }
// =============================================================================

import { PrismaClient } from '@prisma/client';
import { hash } from 'bcrypt';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import proj4 from 'proj4';

import area from '@turf/area';
import bbox from '@turf/bbox';
import bboxPolygon from '@turf/bbox-polygon';
import centroid from '@turf/centroid';
import intersect from '@turf/intersect';
import { feature, polygon, multiPolygon, featureCollection } from '@turf/helpers';
import type { Feature, MultiPolygon as TMultiPolygon, Polygon as TPolygon } from 'geojson';

// -----------------------------------------------------------------------------
// Config: deterministic UUIDs so reseeding produces the same ids every time
// -----------------------------------------------------------------------------

const IDS = {
  tenant:        '00000000-0000-4000-8000-000000000001',
  ownerUser:     '00000000-0000-4000-8000-000000000010',
  workerUser:    '00000000-0000-4000-8000-000000000011',
  farm:          '00000000-0000-4000-8000-000000000020',
  season:        '00000000-0000-4000-8000-000000000050',
  cropCoffee:    '00000000-0000-4000-8000-000000000061',
  cropMaize:     '00000000-0000-4000-8000-000000000062',
  cropTeff:      '00000000-0000-4000-8000-000000000063',
  warehouse:     '00000000-0000-4000-8000-000000000081',
  partnerCustomer:'00000000-0000-4000-8000-000000000601',
  partnerVendor: '00000000-0000-4000-8000-000000000602',
  roleOwner:     '00000000-0000-4000-8000-000000000101',
  roleAgronomist:'00000000-0000-4000-8000-000000000102',
  roleField:     '00000000-0000-4000-8000-000000000103',
  roleAccount:   '00000000-0000-4000-8000-000000000104',
  roleWh:        '00000000-0000-4000-8000-000000000105',
};

const parcelId = (i: number) => `00000000-0000-4000-8000-${(0x031 + i).toString(16).padStart(12, '0')}`;
const plotId   = (i: number) => `00000000-0000-4000-8000-${(0x041 + i).toString(16).padStart(12, '0')}`;
const cropPlanId = (i: number) => `00000000-0000-4000-8000-${(0x501 + i).toString(16).padStart(12, '0')}`;

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

interface Args { geojsonPath: string; sourceSrid: number | null }
function parseArgs(): Args {
  const args = process.argv.slice(2);
  let geojsonPath = './prisma/fixtures/farm-boundary.geojson';
  let sourceSrid: number | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--geojson' && args[i + 1]) { geojsonPath = args[++i]; }
    else if (args[i] === '--srid' && args[i + 1]) { sourceSrid = Number(args[++i]); }
  }
  return { geojsonPath: resolve(geojsonPath), sourceSrid };
}

// -----------------------------------------------------------------------------
// Coordinate transforms — accept GeoJSON in any UTM zone, convert to 4326
// -----------------------------------------------------------------------------

const WGS84 = '+proj=longlat +datum=WGS84 +no_defs';
function utmDef(epsg: number): string {
  // Northern hemisphere UTM zones are EPSG 32601-32660 (zones 1..60)
  const zone = epsg - 32600;
  if (zone < 1 || zone > 60) throw new Error(`unsupported source SRID ${epsg}`);
  return `+proj=utm +zone=${zone} +datum=WGS84 +units=m +no_defs`;
}

function detectSrid(gj: any): number {
  if (gj?.crs?.properties?.name) {
    const m = /EPSG::?(\d+)/.exec(gj.crs.properties.name);
    if (m) return Number(m[1]);
  }
  return 4326; // assume WGS84 if no CRS declared
}

function reprojectCoords(coords: number[][][], from: string): number[][][] {
  return coords.map((ring) => ring.map(([x, y]) => proj4(from, WGS84, [x, y])));
}

function reprojectGeometry(
  geom: TPolygon | TMultiPolygon,
  fromSrid: number,
): TPolygon | TMultiPolygon {
  if (fromSrid === 4326) return geom;
  const fromDef = utmDef(fromSrid);
  if (geom.type === 'Polygon') {
    return { type: 'Polygon', coordinates: reprojectCoords(geom.coordinates, fromDef) };
  }
  return {
    type: 'MultiPolygon',
    coordinates: geom.coordinates.map((poly) => reprojectCoords(poly, fromDef)),
  };
}

// -----------------------------------------------------------------------------
// Subdivision: slice the farm into N horizontal bands, intersect each with
// the boundary. Returns parcel polygons and 1-2 plot polygons per parcel.
// -----------------------------------------------------------------------------

interface ParcelSpec { code: string; name: string; crop: 'coffee' | 'maize' | 'teff' | 'homestead'; bandTop: number; bandBottom: number; }
interface ParcelOut { code: string; name: string; crop: ParcelSpec['crop']; geom: TPolygon; areaHa: number; plots: PlotOut[]; }
interface PlotOut { code: string; geom: TPolygon; areaHa: number; }

const PARCEL_SPECS: ParcelSpec[] = [
  { code: 'A', name: 'North coffee block',         crop: 'coffee',    bandTop: 0.00, bandBottom: 0.25 },
  { code: 'B', name: 'Mid-north coffee block',     crop: 'coffee',    bandTop: 0.25, bandBottom: 0.50 },
  { code: 'C', name: 'Mid-south maize field',      crop: 'maize',     bandTop: 0.50, bandBottom: 0.70 },
  { code: 'D', name: 'South teff field',           crop: 'teff',      bandTop: 0.70, bandBottom: 0.90 },
  { code: 'E', name: 'Homestead & infrastructure', crop: 'homestead', bandTop: 0.90, bandBottom: 1.00 },
];

function asPolygonFeature(geom: TPolygon | TMultiPolygon): Feature<TPolygon> {
  if (geom.type === 'Polygon') return polygon(geom.coordinates);
  // For MultiPolygon, use the largest polygon (the trigger is also picky about MP geom for parcels)
  let best = geom.coordinates[0]; let bestArea = 0;
  for (const ring of geom.coordinates) {
    const f = polygon(ring);
    const a = area(f);
    if (a > bestArea) { bestArea = a; best = ring; }
  }
  return polygon(best);
}

function subdivide(farm: Feature<TPolygon>): ParcelOut[] {
  const [minX, minY, maxX, maxY] = bbox(farm);
  const totalH = maxY - minY;
  const out: ParcelOut[] = [];

  for (const spec of PARCEL_SPECS) {
    const yHigh = maxY - totalH * spec.bandTop;
    const yLow  = maxY - totalH * spec.bandBottom;
    const slicer = bboxPolygon([minX - 0.001, yLow, maxX + 0.001, yHigh]);
    const cut = intersect(featureCollection([farm, slicer]));
    if (!cut) continue;

    const parcelGeom = asPolygonFeature(cut.geometry as TPolygon | TMultiPolygon);
    const parcelAreaHa = area(parcelGeom) / 10_000;

    // Plots: A and B → split E/W; C, D, E → single plot = whole parcel
    const plots: PlotOut[] = [];
    if (spec.code === 'A' || spec.code === 'B') {
      const [pminX, pminY, pmaxX, pmaxY] = bbox(parcelGeom);
      const midX = (pminX + pmaxX) / 2;
      const westSlicer = bboxPolygon([pminX - 0.001, pminY - 0.001, midX,        pmaxY + 0.001]);
      const eastSlicer = bboxPolygon([midX,         pminY - 0.001, pmaxX + 0.001, pmaxY + 0.001]);
      const west = intersect(featureCollection([parcelGeom, westSlicer]));
      const east = intersect(featureCollection([parcelGeom, eastSlicer]));
      if (west) {
        const w = asPolygonFeature(west.geometry as TPolygon | TMultiPolygon);
        plots.push({ code: `${spec.code}1`, geom: w.geometry, areaHa: area(w) / 10_000 });
      }
      if (east) {
        const e = asPolygonFeature(east.geometry as TPolygon | TMultiPolygon);
        plots.push({ code: `${spec.code}2`, geom: e.geometry, areaHa: area(e) / 10_000 });
      }
    } else {
      plots.push({ code: `${spec.code}1`, geom: parcelGeom.geometry, areaHa: parcelAreaHa });
    }

    out.push({
      code: spec.code, name: spec.name, crop: spec.crop,
      geom: parcelGeom.geometry, areaHa: parcelAreaHa, plots,
    });
  }
  return out;
}

// -----------------------------------------------------------------------------
// Prisma raw helpers — Prisma can't write geom directly, so we go via SQL
// -----------------------------------------------------------------------------

const prisma = new PrismaClient();

async function execAdmin<T>(fn: () => Promise<T>): Promise<T> {
  // Tip: in dev, run this script as a Postgres user with BYPASSRLS,
  // OR set app.tenant_id session-wide before each transaction.
  await prisma.$executeRawUnsafe(`SET app.tenant_id = '${IDS.tenant}'`);
  return fn();
}

async function insertGeomRow(opts: {
  table: string;
  cols: Record<string, unknown>;
  geomCols: Record<string, { type: string; geom: TPolygon | TMultiPolygon }>;
}) {
  const colNames: string[] = [];
  const placeholders: string[] = [];
  const values: any[] = [];

  for (const [k, v] of Object.entries(opts.cols)) {
    colNames.push(`"${k}"`);
    values.push(v);
    placeholders.push(`$${values.length}`);
  }
  for (const [k, { geom }] of Object.entries(opts.geomCols)) {
    colNames.push(`"${k}"`);
    values.push(JSON.stringify(geom));
    // ST_Multi wraps polygons into MultiPolygon when the column requires it;
    // PostGIS will downcast cleanly for Polygon columns too.
    placeholders.push(`ST_SetSRID(ST_GeomFromGeoJSON($${values.length}), 4326)`);
  }

  const sql = `INSERT INTO ${opts.table} (${colNames.join(', ')})
               VALUES (${placeholders.join(', ')})`;
  await prisma.$executeRawUnsafe(sql, ...values);
}

// -----------------------------------------------------------------------------
// Main seed
// -----------------------------------------------------------------------------

async function main() {
  const args = parseArgs();
  const raw = JSON.parse(readFileSync(args.geojsonPath, 'utf-8'));
  const sourceSrid = args.sourceSrid ?? detectSrid(raw);

  const inputFeature: Feature<TPolygon | TMultiPolygon> =
    raw.type === 'FeatureCollection' ? raw.features[0] : raw;
  const reprojected = reprojectGeometry(inputFeature.geometry, sourceSrid);

  // Single-polygon outline used for slicing (we'll store as MultiPolygon).
  const farmOutline =
    reprojected.type === 'Polygon'
      ? polygon(reprojected.coordinates)
      : asPolygonFeature(reprojected);

  const farmAreaHa = area(farmOutline) / 10_000;
  const c = centroid(farmOutline).geometry.coordinates;
  console.log(`Farm: ${farmAreaHa.toFixed(1)} ha, centroid ${c[1].toFixed(5)}°N ${c[0].toFixed(5)}°E`);

  const parcels = subdivide(farmOutline);
  console.log(`Subdivided into ${parcels.length} parcels, ${parcels.reduce((n, p) => n + p.plots.length, 0)} plots`);

  await execAdmin(async () => {
    // Wipe prior seed (CASCADE through FK). Run as a single transaction.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`DELETE FROM tenant WHERE id = ${IDS.tenant}::uuid`;

      // 1. Tenant
      await tx.$executeRaw`
        INSERT INTO tenant (id, slug, name, country_code, default_srid, metric_srid, locale, timezone, status)
        VALUES (${IDS.tenant}::uuid, 'mizan-investment', 'Mizan Investment Farm', 'ET',
                4326, ${sourceSrid >= 32600 ? sourceSrid : 32637}, 'en', 'Africa/Addis_Ababa', 'active')
      `;

      // 2. Roles (idempotent)
      await tx.$executeRaw`
        INSERT INTO role (id, tenant_id, code, name, scopes) VALUES
          (${IDS.roleOwner}::uuid,      NULL, 'owner',           'Owner',           ARRAY['*']),
          (${IDS.roleAgronomist}::uuid, NULL, 'agronomist',      'Agronomist',      ARRAY['production:*']),
          (${IDS.roleField}::uuid,      NULL, 'field_worker',    'Field worker',    ARRAY['activity:create']),
          (${IDS.roleAccount}::uuid,    NULL, 'accountant',      'Accountant',      ARRAY['accounting:*']),
          (${IDS.roleWh}::uuid,         NULL, 'warehouse_keeper','Warehouse',       ARRAY['inventory:*'])
        ON CONFLICT (id) DO NOTHING
      `;

      // 3. Users
      const ownerHash = await hash('changeme', 12);
      const workerHash = await hash('changeme', 12);
      await tx.$executeRaw`
        INSERT INTO "user" (id, tenant_id, email, password_hash, full_name, locale, status) VALUES
          (${IDS.ownerUser}::uuid,  ${IDS.tenant}::uuid, 'owner@mizan-investment.test',
             ${ownerHash}, 'Henok (Owner)', 'en', 'active'),
          (${IDS.workerUser}::uuid, ${IDS.tenant}::uuid, 'abebe@mizan-investment.test',
             ${workerHash}, 'Abebe Tadesse', 'en', 'active')
      `;
      await tx.$executeRaw`
        INSERT INTO user_role (user_id, role_id) VALUES
          (${IDS.ownerUser}::uuid,  ${IDS.roleOwner}::uuid),
          (${IDS.workerUser}::uuid, ${IDS.roleField}::uuid)
      `;

      // 4. Crops
      await tx.$executeRaw`
        INSERT INTO crop (id, tenant_id, name, variety, category, cycle_days, metadata) VALUES
          (${IDS.cropCoffee}::uuid, ${IDS.tenant}::uuid, 'Coffee', 'Arabica heirloom', 'cash_crop', 1095, '{"perennial":true}'::jsonb),
          (${IDS.cropMaize}::uuid,  ${IDS.tenant}::uuid, 'Maize',  'BH-660', 'cereal',  130, '{}'::jsonb),
          (${IDS.cropTeff}::uuid,   ${IDS.tenant}::uuid, 'Teff',   'DZ-Cr-37', 'cereal', 110, '{}'::jsonb)
      `;

      // 5. Season
      await tx.$executeRaw`
        INSERT INTO season (id, tenant_id, name, start_date, end_date, status)
        VALUES (${IDS.season}::uuid, ${IDS.tenant}::uuid, 'Meher 2026', '2026-04-01'::date, '2026-12-31'::date, 'active')
      `;
    });

    // 6. Farm — written via raw SQL because of the geometry column
    await insertGeomRow({
      table: 'farm',
      cols: {
        id: IDS.farm, tenant_id: IDS.tenant,
        code: 'MZN-INV-001', name: 'Mizan Investment Farm',
        altitude_m: 1450, agro_zone: 'Sub-humid midland',
        certifications: JSON.stringify([{ scheme: '4C', since: '2023-01-01' }]),
      },
      geomCols: {
        geom: { type: 'MultiPolygon', geom: multiPolygon([farmOutline.geometry.coordinates]).geometry },
      },
    });

    // 7. Parcels
    for (let i = 0; i < parcels.length; i++) {
      const p = parcels[i];
      await insertGeomRow({
        table: 'parcel',
        cols: {
          id: parcelId(i), tenant_id: IDS.tenant, farm_id: IDS.farm,
          code: p.code, name: p.name,
          soil_type: 'Andosol', soil_ph: 5.7, slope_pct: 6.0, irrigated: false,
        },
        geomCols: { geom: { type: 'Polygon', geom: p.geom } },
      });
    }

    // 8. Plots
    let plotIdx = 0;
    const plotIdMap = new Map<string, string>(); // 'A1' → uuid
    for (let pi = 0; pi < parcels.length; pi++) {
      const parent = parcels[pi];
      for (const plot of parent.plots) {
        const id = plotId(plotIdx++);
        plotIdMap.set(plot.code, id);
        await insertGeomRow({
          table: 'plot',
          cols: {
            id, tenant_id: IDS.tenant, parcel_id: parcelId(pi),
            code: plot.code,
          },
          geomCols: { geom: { type: 'Polygon', geom: plot.geom } },
        });
      }
    }

    // 9. Crop plans (skip homestead)
    let cpIdx = 0;
    for (let pi = 0; pi < parcels.length; pi++) {
      const parent = parcels[pi];
      if (parent.crop === 'homestead') continue;
      const cropId = parent.crop === 'coffee' ? IDS.cropCoffee
                  : parent.crop === 'maize'   ? IDS.cropMaize
                  : IDS.cropTeff;
      const yieldMap = { coffee: 1700, maize: 4500, teff: 1200 } as const;
      const sowing   = parent.crop === 'coffee' ? null
                     : parent.crop === 'maize'  ? '2026-06-05'
                     : '2026-07-10';
      const harvest  = parent.crop === 'coffee' ? '2026-10-15'
                     : parent.crop === 'maize'  ? '2026-10-20'
                     : '2026-12-05';
      for (const plot of parent.plots) {
        const cpUuid = cropPlanId(cpIdx++);
        await insertGeomRow({
          table: 'crop_plan',
          cols: {
            id: cpUuid, tenant_id: IDS.tenant,
            plot_id: plotIdMap.get(plot.code)!,
            crop_id: cropId, season_id: IDS.season,
            planned_sowing_date: sowing,
            planned_harvest_date: harvest,
            expected_yield_kg_ha: yieldMap[parent.crop as keyof typeof yieldMap],
            status: 'active',
          },
          geomCols: { geom: { type: 'Polygon', geom: plot.geom } },
        });
        await prisma.$executeRaw`
          UPDATE plot SET current_crop_plan_id = ${cpUuid}::uuid
           WHERE id = ${plotIdMap.get(plot.code)!}::uuid
        `;
      }
    }

    // 10. Bump server seq above seeded data
    await prisma.$executeRaw`
      SELECT setval('global_server_seq', GREATEST(
        (SELECT COALESCE(MAX(server_seq), 0) FROM farm),
        (SELECT COALESCE(MAX(server_seq), 0) FROM parcel),
        (SELECT COALESCE(MAX(server_seq), 0) FROM plot),
        (SELECT COALESCE(MAX(server_seq), 0) FROM crop_plan),
        1000
      ))
    `;
  });

  console.log('✓ Seed complete');
  console.log(`  Login: owner@mizan-investment.test / changeme`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
