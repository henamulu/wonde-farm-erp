-- =============================================================================
-- Farm ERP — seed: actual 497 ha investment near Mizan Teferi
-- =============================================================================
-- Uses the real farm boundary supplied by the owner (Nov 2022 survey,
-- originally in EPSG:32637, transformed to WGS84 here).
--
-- Farm: 496.93 ha total, centroid 6.25000°N 36.47036°E
-- Parcels: 5 (7 plots)
-- =============================================================================

BEGIN;
SET LOCAL ROLE app_admin;

\set tenant_id        '00000000-0000-4000-8000-000000000001'
\set owner_user_id    '00000000-0000-4000-8000-000000000010'
\set worker_user_id   '00000000-0000-4000-8000-000000000011'
\set farm_id          '00000000-0000-4000-8000-000000000020'
\set season_id        '00000000-0000-4000-8000-000000000050'
\set crop_coffee_id   '00000000-0000-4000-8000-000000000061'
\set crop_maize_id    '00000000-0000-4000-8000-000000000062'
\set crop_teff_id     '00000000-0000-4000-8000-000000000063'

-- Wipe prior seed
DELETE FROM tenant WHERE id = :'tenant_id';

-- 1. Tenant — note metric_srid=32637 (UTM Zone 37N) for this farm's location
INSERT INTO tenant (id, slug, name, country_code, default_srid, metric_srid, locale, timezone, status)
VALUES (
  :'tenant_id', 'mizan-investment', 'Mizan Investment Farm', 'ET',
  4326, 32637,
  'en', 'Africa/Addis_Ababa', 'active'
);

-- 2. Roles
INSERT INTO role (id, tenant_id, code, name, scopes) VALUES
  ('00000000-0000-4000-8000-000000000101', NULL, 'owner',          'Owner',          ARRAY['*']),
  ('00000000-0000-4000-8000-000000000102', NULL, 'agronomist',     'Agronomist',     ARRAY['production:*','plot:read']),
  ('00000000-0000-4000-8000-000000000103', NULL, 'field_worker',   'Field worker',   ARRAY['activity:create','attendance:create','harvest:create']),
  ('00000000-0000-4000-8000-000000000104', NULL, 'accountant',     'Accountant',     ARRAY['accounting:*','invoice:*','payment:*']),
  ('00000000-0000-4000-8000-000000000105', NULL, 'warehouse_keeper','Warehouse',     ARRAY['inventory:*'])
ON CONFLICT DO NOTHING;

-- 3. Users (password "changeme" — replace immediately)
INSERT INTO "user" (id, tenant_id, email, password_hash, full_name, locale, status) VALUES
  (:'owner_user_id',  :'tenant_id', 'owner@mizan-investment.test',
     crypt('changeme', gen_salt('bf', 12)), 'Henok (Owner)',  'en', 'active'),
  (:'worker_user_id', :'tenant_id', 'abebe@mizan-investment.test',
     crypt('changeme', gen_salt('bf', 12)), 'Abebe Tadesse',  'en', 'active');

INSERT INTO user_role (user_id, role_id) VALUES
  (:'owner_user_id',  '00000000-0000-4000-8000-000000000101'),
  (:'worker_user_id', '00000000-0000-4000-8000-000000000103');

-- 4. Crops
INSERT INTO crop (id, tenant_id, name, variety, category, cycle_days, metadata) VALUES
  (:'crop_coffee_id', :'tenant_id', 'Coffee', 'Arabica heirloom', 'cash_crop', 1095, '{"perennial": true}'),
  (:'crop_maize_id',  :'tenant_id', 'Maize',  'BH-660',           'cereal',     130, '{}'),
  (:'crop_teff_id',   :'tenant_id', 'Teff',   'DZ-Cr-37',         'cereal',     110, '{}');

-- 5. Season
INSERT INTO season (id, tenant_id, name, start_date, end_date, status)
VALUES (:'season_id', :'tenant_id', 'Meher 2026', '2026-04-01', '2026-12-31', 'active');

-- =============================================================================
-- 6. Farm — actual 497 ha boundary (originally EPSG:32637, here in 4326)
-- =============================================================================
INSERT INTO farm (id, tenant_id, code, name, geom, altitude_m, agro_zone, certifications)
VALUES (
  :'farm_id', :'tenant_id',
  'MZN-INV-001', 'Mizan Investment Farm',
  ST_Multi(ST_GeomFromText(
    'POLYGON((36.4824378 6.2852843,
      36.4829733 6.2828557,
      36.4830042 6.2820786,
      36.4825855 6.2808565,
      36.4825611 6.2803051,
      36.4819959 6.2776273,
      36.4820046 6.2758288,
      36.4823845 6.2738152,
      36.4828732 6.2698501,
      36.4831158 6.2663446,
      36.4830583 6.2651694,
      36.4831074 6.2643473,
      36.4817727 6.2639251,
      36.4803186 6.2601494,
      36.4781957 6.2564790,
      36.4753984 6.2521908,
      36.4675048 6.2353068,
      36.4663939 6.2315509,
      36.4627934 6.2252976,
      36.4585282 6.2164475,
      36.4532670 6.2212933,
      36.4540860 6.2237555,
      36.4548838 6.2268592,
      36.4559342 6.2281566,
      36.4571282 6.2296264,
      36.4590010 6.2326811,
      36.4672445 6.2462500,
      36.4704598 6.2518597,
      36.4712033 6.2531195,
      36.4756222 6.2601359,
      36.4769137 6.2639018,
      36.4776308 6.2669147,
      36.4778849 6.2685427,
      36.4781342 6.2730356,
      36.4780172 6.2748336,
      36.4777847 6.2781131,
      36.4775533 6.2792597,
      36.4772303 6.2806952,
      36.4775958 6.2816911,
      36.4782857 6.2828602,
      36.4789180 6.2847070,
      36.4789921 6.2862166,
      36.4795752 6.2881695,
      36.4811798 6.2917270,
      36.4798903 6.2911376,
      36.4796772 6.2921124,
      36.4805699 6.2924240,
      36.4827588 6.2935725,
      36.4825472 6.2919364,
      36.4825269 6.2908968,
      36.4822264 6.2901347,
      36.4821425 6.2884731,
      36.4825685 6.2862700,
      36.4824378 6.2852843))',
    4326)),
  1450, 'Sub-humid midland',
  '[{"scheme":"4C","since":"2023-01-01"}]'::jsonb
);

-- =============================================================================
-- 7. Parcels (actual subdivisions, all within farm boundary)
-- =============================================================================

-- Parcel A: North coffee block — 84.38 ha (coffee)
INSERT INTO parcel (id, tenant_id, farm_id, code, name, geom, soil_type, soil_ph, slope_pct, irrigated)
VALUES (
  '00000000-0000-4000-8000-000000000031', :'tenant_id', :'farm_id',
  'A', 'North coffee block',
  ST_GeomFromText(
    'POLYGON((36.4829733 6.2828557,
      36.4830042 6.2820786,
      36.4825855 6.2808565,
      36.4825611 6.2803051,
      36.4819959 6.2776273,
      36.4820046 6.2758288,
      36.4822897 6.2743180,
      36.4780521 6.2742976,
      36.4780172 6.2748336,
      36.4777847 6.2781131,
      36.4775533 6.2792597,
      36.4772303 6.2806952,
      36.4775958 6.2816911,
      36.4782857 6.2828602,
      36.4789180 6.2847070,
      36.4789921 6.2862166,
      36.4795752 6.2881695,
      36.4811798 6.2917270,
      36.4798903 6.2911376,
      36.4796772 6.2921124,
      36.4805699 6.2924240,
      36.4827588 6.2935725,
      36.4825472 6.2919364,
      36.4825269 6.2908968,
      36.4822264 6.2901347,
      36.4821425 6.2884731,
      36.4825685 6.2862700,
      36.4824378 6.2852843,
      36.4829733 6.2828557))',
    4326),
  'Andosol', 5.7, 6.0, false
);

-- Parcel B: Mid-north coffee block — 116.44 ha (coffee)
INSERT INTO parcel (id, tenant_id, farm_id, code, name, geom, soil_type, soil_ph, slope_pct, irrigated)
VALUES (
  '00000000-0000-4000-8000-000000000032', :'tenant_id', :'farm_id',
  'B', 'Mid-north coffee block',
  ST_GeomFromText(
    'POLYGON((36.4823845 6.2738152,
      36.4828732 6.2698501,
      36.4831158 6.2663446,
      36.4830583 6.2651694,
      36.4831074 6.2643473,
      36.4817727 6.2639251,
      36.4803186 6.2601494,
      36.4781957 6.2564790,
      36.4772581 6.2550416,
      36.4723991 6.2550182,
      36.4756222 6.2601359,
      36.4769137 6.2639018,
      36.4776308 6.2669147,
      36.4778849 6.2685427,
      36.4781342 6.2730356,
      36.4780521 6.2742976,
      36.4822897 6.2743180,
      36.4823845 6.2738152))',
    4326),
  'Andosol', 5.7, 6.0, false
);

-- Parcel C: Mid-south maize field — 101.26 ha (maize)
INSERT INTO parcel (id, tenant_id, farm_id, code, name, geom, soil_type, soil_ph, slope_pct, irrigated)
VALUES (
  '00000000-0000-4000-8000-000000000033', :'tenant_id', :'farm_id',
  'C', 'Mid-south maize field',
  ST_GeomFromText(
    'POLYGON((36.4753984 6.2521908,
      36.4695132 6.2396027,
      36.4631875 6.2395722,
      36.4672445 6.2462500,
      36.4704598 6.2518597,
      36.4712033 6.2531195,
      36.4723991 6.2550182,
      36.4772581 6.2550416,
      36.4753984 6.2521908))',
    4326),
  'Andosol', 5.7, 6.0, false
);

-- Parcel D: South teff field — 144.98 ha (teff)
INSERT INTO parcel (id, tenant_id, farm_id, code, name, geom, soil_type, soil_ph, slope_pct, irrigated)
VALUES (
  '00000000-0000-4000-8000-000000000034', :'tenant_id', :'farm_id',
  'D', 'South teff field',
  ST_GeomFromText(
    'POLYGON((36.4675048 6.2353068,
      36.4663939 6.2315509,
      36.4627934 6.2252976,
      36.4622481 6.2241661,
      36.4541816 6.2241273,
      36.4548838 6.2268592,
      36.4559342 6.2281566,
      36.4571282 6.2296264,
      36.4590010 6.2326811,
      36.4631875 6.2395722,
      36.4695132 6.2396027,
      36.4675048 6.2353068))',
    4326),
  'Andosol', 5.7, 6.0, false
);

-- Parcel E: Homestead & infrastructure — 49.86 ha (homestead)
INSERT INTO parcel (id, tenant_id, farm_id, code, name, geom, soil_type, soil_ph, slope_pct, irrigated)
VALUES (
  '00000000-0000-4000-8000-000000000035', :'tenant_id', :'farm_id',
  'E', 'Homestead & infrastructure',
  ST_GeomFromText(
    'POLYGON((36.4585282 6.2164475,
      36.4532670 6.2212933,
      36.4540860 6.2237555,
      36.4541816 6.2241273,
      36.4622481 6.2241661,
      36.4585282 6.2164475))',
    4326),
  'Andosol', 5.7, 6.0, false
);

-- =============================================================================
-- 8. Plots
-- =============================================================================

-- Plot A1 — 32.84 ha
INSERT INTO plot (id, tenant_id, parcel_id, code, geom)
VALUES (
  '00000000-0000-4000-8000-000000000041', :'tenant_id', '00000000-0000-4000-8000-000000000031',
  'A1',
  ST_GeomFromText(
    'POLYGON((36.4780521 6.2742976,
      36.4780172 6.2748336,
      36.4777847 6.2781131,
      36.4775533 6.2792597,
      36.4772303 6.2806952,
      36.4775958 6.2816911,
      36.4782857 6.2828602,
      36.4789180 6.2847070,
      36.4789921 6.2862166,
      36.4795752 6.2881695,
      36.4800792 6.2892869,
      36.4801513 6.2743077,
      36.4780521 6.2742976))',
    4326)
);

-- Plot A2 — 51.18 ha
INSERT INTO plot (id, tenant_id, parcel_id, code, geom)
VALUES (
  '00000000-0000-4000-8000-000000000042', :'tenant_id', '00000000-0000-4000-8000-000000000031',
  'A2',
  ST_GeomFromText(
    'POLYGON((36.4830042 6.2820786,
      36.4825855 6.2808565,
      36.4825611 6.2803051,
      36.4819959 6.2776273,
      36.4820046 6.2758288,
      36.4822897 6.2743180,
      36.4801513 6.2743077,
      36.4800792 6.2892869,
      36.4811798 6.2917270,
      36.4800699 6.2912197,
      36.4800649 6.2922478,
      36.4805699 6.2924240,
      36.4827588 6.2935725,
      36.4825472 6.2919364,
      36.4825269 6.2908968,
      36.4822264 6.2901347,
      36.4821425 6.2884731,
      36.4825685 6.2862700,
      36.4824378 6.2852843,
      36.4829733 6.2828557,
      36.4830042 6.2820786))',
    4326)
);

-- Plot B1 — 31.83 ha
INSERT INTO plot (id, tenant_id, parcel_id, code, geom)
VALUES (
  '00000000-0000-4000-8000-000000000043', :'tenant_id', '00000000-0000-4000-8000-000000000032',
  'B1',
  ST_GeomFromText(
    'POLYGON((36.4772581 6.2550416,
      36.4723991 6.2550182,
      36.4756222 6.2601359,
      36.4769137 6.2639018,
      36.4776308 6.2669147,
      36.4777246 6.2675157,
      36.4777806 6.2558427,
      36.4772581 6.2550416))',
    4326)
);

-- Plot B2 — 84.61 ha
INSERT INTO plot (id, tenant_id, parcel_id, code, geom)
VALUES (
  '00000000-0000-4000-8000-000000000044', :'tenant_id', '00000000-0000-4000-8000-000000000032',
  'B2',
  ST_GeomFromText(
    'POLYGON((36.4828732 6.2698501,
      36.4831158 6.2663446,
      36.4830583 6.2651694,
      36.4831074 6.2643473,
      36.4817727 6.2639251,
      36.4803186 6.2601494,
      36.4781957 6.2564790,
      36.4777806 6.2558427,
      36.4777246 6.2675157,
      36.4778849 6.2685427,
      36.4781342 6.2730356,
      36.4780521 6.2742976,
      36.4822897 6.2743180,
      36.4823845 6.2738152,
      36.4828732 6.2698501))',
    4326)
);

-- Plot C1 — 101.26 ha
INSERT INTO plot (id, tenant_id, parcel_id, code, geom)
VALUES (
  '00000000-0000-4000-8000-000000000045', :'tenant_id', '00000000-0000-4000-8000-000000000033',
  'C1',
  ST_GeomFromText(
    'POLYGON((36.4753984 6.2521908,
      36.4695132 6.2396027,
      36.4631875 6.2395722,
      36.4672445 6.2462500,
      36.4704598 6.2518597,
      36.4712033 6.2531195,
      36.4723991 6.2550182,
      36.4772581 6.2550416,
      36.4753984 6.2521908))',
    4326)
);

-- Plot D1 — 144.98 ha
INSERT INTO plot (id, tenant_id, parcel_id, code, geom)
VALUES (
  '00000000-0000-4000-8000-000000000046', :'tenant_id', '00000000-0000-4000-8000-000000000034',
  'D1',
  ST_GeomFromText(
    'POLYGON((36.4675048 6.2353068,
      36.4663939 6.2315509,
      36.4627934 6.2252976,
      36.4622481 6.2241661,
      36.4541816 6.2241273,
      36.4548838 6.2268592,
      36.4559342 6.2281566,
      36.4571282 6.2296264,
      36.4590010 6.2326811,
      36.4631875 6.2395722,
      36.4695132 6.2396027,
      36.4675048 6.2353068))',
    4326)
);

-- Plot E1 — 49.86 ha
INSERT INTO plot (id, tenant_id, parcel_id, code, geom)
VALUES (
  '00000000-0000-4000-8000-000000000047', :'tenant_id', '00000000-0000-4000-8000-000000000035',
  'E1',
  ST_GeomFromText(
    'POLYGON((36.4585282 6.2164475,
      36.4532670 6.2212933,
      36.4540860 6.2237555,
      36.4541816 6.2241273,
      36.4622481 6.2241661,
      36.4585282 6.2164475))',
    4326)
);

-- =============================================================================
-- 9. Infrastructure (POIs in the homestead parcel)
-- =============================================================================
INSERT INTO infrastructure (id, tenant_id, farm_id, type, name, geom, attributes) VALUES
  ('00000000-0000-4000-8000-000000000071', :'tenant_id', :'farm_id', 'warehouse',
     'Main store',  ST_GeomFromText('POINT(36.457612 6.221351)', 4326), '{}'),
  ('00000000-0000-4000-8000-000000000072', :'tenant_id', :'farm_id', 'shed',
     'Drying shed', ST_GeomFromText('POINT(36.457912 6.221351)', 4326), '{}'),
  ('00000000-0000-4000-8000-000000000073', :'tenant_id', :'farm_id', 'well',
     'Hand-pump well', ST_GeomFromText('POINT(36.478977 6.264620)', 4326), '{"depth_m": 28}'),
  ('00000000-0000-4000-8000-000000000074', :'tenant_id', :'farm_id', 'shed',
     'Field office (north)', ST_GeomFromText('POINT(36.480433 6.282377)', 4326), '{}');

INSERT INTO warehouse (id, tenant_id, farm_id, code, name, geom, capacity)
VALUES (
  '00000000-0000-4000-8000-000000000081', :'tenant_id', :'farm_id',
  'WH-MAIN', 'Main store',
  ST_GeomFromText('POINT(36.457612 6.221351)', 4326),
  '{"capacity_kg": 80000}'::jsonb
);

-- =============================================================================
-- 10. Chart of accounts
-- =============================================================================
INSERT INTO account (id, tenant_id, code, name, type) VALUES
  ('00000000-0000-4000-8000-000000000201', :'tenant_id', '1000', 'Cash',                   'asset'),
  ('00000000-0000-4000-8000-000000000202', :'tenant_id', '1100', 'Bank',                   'asset'),
  ('00000000-0000-4000-8000-000000000203', :'tenant_id', '1300', 'Inventory — Coffee',     'asset'),
  ('00000000-0000-4000-8000-000000000204', :'tenant_id', '1310', 'Inventory — Cereals',    'asset'),
  ('00000000-0000-4000-8000-000000000205', :'tenant_id', '4000', 'Sales — Coffee',         'income'),
  ('00000000-0000-4000-8000-000000000206', :'tenant_id', '4100', 'Sales — Cereals',        'income'),
  ('00000000-0000-4000-8000-000000000207', :'tenant_id', '5000', 'Inputs — Seeds',         'expense'),
  ('00000000-0000-4000-8000-000000000208', :'tenant_id', '5010', 'Inputs — Fertilizer',    'expense'),
  ('00000000-0000-4000-8000-000000000209', :'tenant_id', '5020', 'Inputs — Pesticides',    'expense'),
  ('00000000-0000-4000-8000-000000000210', :'tenant_id', '6000', 'Labour',                 'expense'),
  ('00000000-0000-4000-8000-000000000211', :'tenant_id', '6500', 'Fuel & power',           'expense');

INSERT INTO journal (id, tenant_id, code, name, type) VALUES
  ('00000000-0000-4000-8000-000000000301', :'tenant_id', 'GEN', 'General',   'general'),
  ('00000000-0000-4000-8000-000000000302', :'tenant_id', 'SAL', 'Sales',     'sales'),
  ('00000000-0000-4000-8000-000000000303', :'tenant_id', 'PUR', 'Purchases', 'purchases'),
  ('00000000-0000-4000-8000-000000000304', :'tenant_id', 'BNK', 'Bank',      'bank');

-- =============================================================================
-- 11. SKUs
-- =============================================================================
INSERT INTO sku (id, tenant_id, code, name, category, base_uom, attributes) VALUES
  ('00000000-0000-4000-8000-000000000401', :'tenant_id', 'CFR-A',  'Coffee — red cherry, washing-grade',  'finished_good', 'kg', '{"grade":"A"}'),
  ('00000000-0000-4000-8000-000000000402', :'tenant_id', 'MZE-W',  'Maize — white shelled',               'finished_good', 'kg', '{}'),
  ('00000000-0000-4000-8000-000000000403', :'tenant_id', 'TEF-W',  'Teff — white',                        'finished_good', 'kg', '{}'),
  ('00000000-0000-4000-8000-000000000404', :'tenant_id', 'FRT-NPK','NPK 17-17-17 fertilizer',             'fertilizer',    'kg', '{}'),
  ('00000000-0000-4000-8000-000000000405', :'tenant_id', 'PST-GLY','Glyphosate 360 g/L',                  'pesticide',     'L',  '{}');

-- =============================================================================
-- 12. Crop plans (Meher 2026)
-- =============================================================================

-- Plot A1 → coffee (32.84 ha, expected 1700 kg/ha = ~55,828 kg)
INSERT INTO crop_plan (id, tenant_id, plot_id, crop_id, season_id, geom,
                       planned_sowing_date, planned_harvest_date, expected_yield_kg_ha, status)
VALUES (
  '00000000-0000-4000-8000-000000001281', :'tenant_id', '00000000-0000-4000-8000-000000000041', :'crop_coffee_id', :'season_id',
  (SELECT geom FROM plot WHERE id = '00000000-0000-4000-8000-000000000041'),
  NULL, '2026-10-15', 1700, 'active'
);
UPDATE plot SET current_crop_plan_id = '00000000-0000-4000-8000-000000001281' WHERE id = '00000000-0000-4000-8000-000000000041';

-- Plot A2 → coffee (51.18 ha, expected 1700 kg/ha = ~87,006 kg)
INSERT INTO crop_plan (id, tenant_id, plot_id, crop_id, season_id, geom,
                       planned_sowing_date, planned_harvest_date, expected_yield_kg_ha, status)
VALUES (
  '00000000-0000-4000-8000-000000001282', :'tenant_id', '00000000-0000-4000-8000-000000000042', :'crop_coffee_id', :'season_id',
  (SELECT geom FROM plot WHERE id = '00000000-0000-4000-8000-000000000042'),
  NULL, '2026-10-15', 1700, 'active'
);
UPDATE plot SET current_crop_plan_id = '00000000-0000-4000-8000-000000001282' WHERE id = '00000000-0000-4000-8000-000000000042';

-- Plot B1 → coffee (31.83 ha, expected 1700 kg/ha = ~54,111 kg)
INSERT INTO crop_plan (id, tenant_id, plot_id, crop_id, season_id, geom,
                       planned_sowing_date, planned_harvest_date, expected_yield_kg_ha, status)
VALUES (
  '00000000-0000-4000-8000-000000001283', :'tenant_id', '00000000-0000-4000-8000-000000000043', :'crop_coffee_id', :'season_id',
  (SELECT geom FROM plot WHERE id = '00000000-0000-4000-8000-000000000043'),
  NULL, '2026-10-15', 1700, 'active'
);
UPDATE plot SET current_crop_plan_id = '00000000-0000-4000-8000-000000001283' WHERE id = '00000000-0000-4000-8000-000000000043';

-- Plot B2 → coffee (84.61 ha, expected 1700 kg/ha = ~143,837 kg)
INSERT INTO crop_plan (id, tenant_id, plot_id, crop_id, season_id, geom,
                       planned_sowing_date, planned_harvest_date, expected_yield_kg_ha, status)
VALUES (
  '00000000-0000-4000-8000-000000001284', :'tenant_id', '00000000-0000-4000-8000-000000000044', :'crop_coffee_id', :'season_id',
  (SELECT geom FROM plot WHERE id = '00000000-0000-4000-8000-000000000044'),
  NULL, '2026-10-15', 1700, 'active'
);
UPDATE plot SET current_crop_plan_id = '00000000-0000-4000-8000-000000001284' WHERE id = '00000000-0000-4000-8000-000000000044';

-- Plot C1 → maize (101.26 ha, expected 4500 kg/ha = ~455,670 kg)
INSERT INTO crop_plan (id, tenant_id, plot_id, crop_id, season_id, geom,
                       planned_sowing_date, planned_harvest_date, expected_yield_kg_ha, status)
VALUES (
  '00000000-0000-4000-8000-000000001285', :'tenant_id', '00000000-0000-4000-8000-000000000045', :'crop_maize_id', :'season_id',
  (SELECT geom FROM plot WHERE id = '00000000-0000-4000-8000-000000000045'),
  '2026-06-05', '2026-10-20', 4500, 'active'
);
UPDATE plot SET current_crop_plan_id = '00000000-0000-4000-8000-000000001285' WHERE id = '00000000-0000-4000-8000-000000000045';

-- Plot D1 → teff (144.98 ha, expected 1200 kg/ha = ~173,976 kg)
INSERT INTO crop_plan (id, tenant_id, plot_id, crop_id, season_id, geom,
                       planned_sowing_date, planned_harvest_date, expected_yield_kg_ha, status)
VALUES (
  '00000000-0000-4000-8000-000000001286', :'tenant_id', '00000000-0000-4000-8000-000000000046', :'crop_teff_id', :'season_id',
  (SELECT geom FROM plot WHERE id = '00000000-0000-4000-8000-000000000046'),
  '2026-07-10', '2026-12-05', 1200, 'active'
);
UPDATE plot SET current_crop_plan_id = '00000000-0000-4000-8000-000000001286' WHERE id = '00000000-0000-4000-8000-000000000046';

-- =============================================================================
-- 13. Partners + employees
-- =============================================================================
INSERT INTO partner (id, tenant_id, type, name, tax_id, email, phone, address, geom) VALUES
  ('00000000-0000-4000-8000-000000000601', :'tenant_id', 'customer', 'Sidamo Coffee Exporters PLC',
     '0001234567', 'orders@sidamoexp.test', '+251911234567',
     '{"city":"Addis Ababa","country":"ET"}'::jsonb,
     ST_GeomFromText('POINT(38.74 9.03)', 4326)),
  ('00000000-0000-4000-8000-000000000602', :'tenant_id', 'vendor',   'AgroChem Ethiopia',
     '0007654321', 'sales@agrochem.test', '+251911765432',
     '{"city":"Addis Ababa","country":"ET"}'::jsonb,
     ST_GeomFromText('POINT(38.76 9.01)', 4326));

INSERT INTO employee (id, tenant_id, user_id, code, full_name, role, hired_at, salary_model, status) VALUES
  ('00000000-0000-4000-8000-000000000701', :'tenant_id', :'worker_user_id',
     'E-001', 'Abebe Tadesse',   'field_worker', '2024-03-15',
     '{"type":"daily","rate_cents":15000,"currency":"ETB"}'::jsonb, 'active'),
  ('00000000-0000-4000-8000-000000000702', :'tenant_id', NULL,
     'E-002', 'Tigist Bekele',   'field_worker', '2024-04-01',
     '{"type":"daily","rate_cents":15000,"currency":"ETB"}'::jsonb, 'active'),
  ('00000000-0000-4000-8000-000000000703', :'tenant_id', NULL,
     'E-003', 'Hailu Mekonnen',  'agronomist',   '2023-09-01',
     '{"type":"monthly","rate_cents":1200000,"currency":"ETB"}'::jsonb, 'active'),
  ('00000000-0000-4000-8000-000000000704', :'tenant_id', NULL,
     'E-004', 'Selamawit Girma', 'warehouse_keeper','2023-11-10',
     '{"type":"monthly","rate_cents":900000,"currency":"ETB"}'::jsonb, 'active');

-- =============================================================================
-- 14. Sample activities (so dashboards have data on day 1)
-- =============================================================================
INSERT INTO crop_activity (id, tenant_id, crop_plan_id, type, scheduled_at, started_at, completed_at,
                           performed_by_id, geom_point, status, notes)
VALUES (
  '00000000-0000-4000-8000-000000002049', :'tenant_id',
  '00000000-0000-4000-8000-000000001285', 'sowing',
  '2026-06-05 06:00:00+03', '2026-06-05 06:30:00+03', '2026-06-05 11:00:00+03',
  '00000000-0000-4000-8000-000000000701', ST_GeomFromText('POINT(36.4628 6.2384)', 4326),
  'done', 'Maize sown across plot C1, BH-660 variety'
);
INSERT INTO crop_activity (id, tenant_id, crop_plan_id, type, scheduled_at, started_at, completed_at,
                           performed_by_id, geom_point, status, notes)
VALUES (
  '00000000-0000-4000-8000-000000002050', :'tenant_id',
  '00000000-0000-4000-8000-000000001285', 'fertilizing',
  '2026-06-25 06:00:00+03', '2026-06-25 06:30:00+03', '2026-06-25 11:00:00+03',
  '00000000-0000-4000-8000-000000000701', ST_GeomFromText('POINT(36.4625 6.239)', 4326),
  'done', 'Top-dress urea on maize'
);
INSERT INTO crop_activity (id, tenant_id, crop_plan_id, type, scheduled_at, started_at, completed_at,
                           performed_by_id, geom_point, status, notes)
VALUES (
  '00000000-0000-4000-8000-000000002051', :'tenant_id',
  '00000000-0000-4000-8000-000000001283', 'scouting',
  '2026-08-10 06:00:00+03', '2026-08-10 06:30:00+03', '2026-08-10 11:00:00+03',
  '00000000-0000-4000-8000-000000000703', ST_GeomFromText('POINT(36.47 6.27)', 4326),
  'done', 'CBD checked, no symptoms; coffee berries forming well'
);

-- =============================================================================
-- 15. Bump global server_seq above any seeded rows
-- =============================================================================
SELECT setval('global_server_seq', GREATEST(
  (SELECT COALESCE(MAX(server_seq), 0) FROM farm),
  (SELECT COALESCE(MAX(server_seq), 0) FROM parcel),
  (SELECT COALESCE(MAX(server_seq), 0) FROM plot),
  (SELECT COALESCE(MAX(server_seq), 0) FROM crop_plan),
  (SELECT COALESCE(MAX(server_seq), 0) FROM crop_activity),
  1000
));

RESET ROLE;
COMMIT;

-- =============================================================================
-- Sanity checks (run with app.tenant_id set):
-- =============================================================================
-- SET app.tenant_id = '00000000-0000-4000-8000-000000000001';
-- SELECT name, area_ha FROM farm;
-- SELECT code, area_ha FROM parcel ORDER BY code;
-- SELECT code, area_ha FROM plot ORDER BY code;
-- SELECT cp.id, c.name AS crop, p.code AS plot, cp.area_ha, cp.status
--   FROM crop_plan cp JOIN crop c ON c.id = cp.crop_id
--   JOIN plot p ON p.id = cp.plot_id ORDER BY p.code;
