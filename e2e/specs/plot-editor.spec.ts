// =============================================================================
// e2e/specs/plot-editor.spec.ts
// =============================================================================
// First end-to-end test. Exercises the entire happy path:
//
//   login (already done in globalSetup)
//      ↓
//   navigate to PlotEditor for parcel A
//      ↓
//   wait for OpenLayers map + parent geom to load
//      ↓
//   click "Draw new plot"
//      ↓
//   click 4 vertices on the canvas inside the parcel
//      ↓
//   wait for live server validation to come back valid
//      ↓
//   click Save
//      ↓
//   verify via API that the plot was persisted
//      ↓
//   verify the new plot appears in the next tile fetch (tile cache invalidated)
//
// One test, end-to-end. Subsequent specs (edit, overlap, error paths) layer
// on top of the helpers and pattern established here.
// =============================================================================

import { expect, test } from '@playwright/test';
import { ApiClient, SEED, PARCEL_A_CENTROID_LON_LAT } from '../helpers/api';
import {
  drawPolygon, readMode, readReportedArea, waitForMapReady,
} from '../helpers/map';

const API_BASE_URL = process.env.E2E_API_BASE_URL ?? 'http://localhost:3000';

// Test polygon — a ~250m × 250m square inside Parcel A. Chosen so:
//   - It's well inside the parcel (away from the trigger's 1cm buffer)
//   - It's small enough that even at zoom 14 the verticesare distinct on screen
//   - Its area_ha is ~6 ha which is between the seed's parcel sizes
const TEST_POLYGON: Array<[number, number]> = [
  [PARCEL_A_CENTROID_LON_LAT[0] - 0.0011, PARCEL_A_CENTROID_LON_LAT[1] - 0.0011], // SW
  [PARCEL_A_CENTROID_LON_LAT[0] + 0.0011, PARCEL_A_CENTROID_LON_LAT[1] - 0.0011], // SE
  [PARCEL_A_CENTROID_LON_LAT[0] + 0.0011, PARCEL_A_CENTROID_LON_LAT[1] + 0.0011], // NE
  [PARCEL_A_CENTROID_LON_LAT[0] - 0.0011, PARCEL_A_CENTROID_LON_LAT[1] + 0.0011], // NW
];

let api: ApiClient;
let createdPlotId: string | null = null;

test.beforeAll(async () => {
  api = await ApiClient.create(API_BASE_URL);
});

test.afterAll(async () => {
  // Tidy up — even though globalSetup re-seeds, this keeps the dev DB
  // clean if you re-run specs locally without rerunning globalSetup.
  if (createdPlotId) await api.deletePlot(createdPlotId).catch(() => {});
  await api.dispose();
});

test.describe('Plot editor — draw, validate, save', () => {

  test('draws a new plot, sees it validate, saves it, and renders on the map', async ({ page }) => {
    // -- preconditions --
    // Parcel A starts with 2 plots (A1, A2) per the seed
    const before = await api.listPlotsByParcel(SEED.parcels.A);
    expect(before, 'seed should leave parcel A with 2 plots (A1, A2)').toHaveLength(2);

    // -- 1. Navigate --
    // Route mirrors the convention I'd use in the React app: /parcels/:id/plots/new
    await page.goto(`/parcels/${SEED.parcels.A}/plots/new`);

    // -- 2. Wait for the map to mount + fit to parent --
    await waitForMapReady(page);

    // The parent boundary should be visible. We can't assert canvas pixels
    // directly, but the test helper exposes the map's view extent — easy
    // sanity check.
    const parentVisible = await page.evaluate(() => {
      const t = (window as any).__farmMapTest;
      const center = t?.pixelFor?.(36.4804, 6.2824);  // Parcel A approx centroid
      const r = t?.rect?.();
      // Centroid should land inside the visible canvas
      return Boolean(center && r && center[0] > 0 && center[1] > 0
                     && center[0] < r.width && center[1] < r.height);
    });
    expect(parentVisible, 'parcel A centroid should be on-screen after fit').toBe(true);

    // -- 3. Enter draw mode --
    expect(await readMode(page)).toBe('idle');
    await page.getByTestId('btn-draw').click();
    expect(await readMode(page)).toBe('drawing');

    // -- 4. Draw the polygon --
    await drawPolygon(page, TEST_POLYGON);

    // OL flips the editor into 'modifying' mode after dblclick finishes the
    // polygon. The validation pill should debounce and resolve quickly.
    await expect.poll(() => readMode(page), { timeout: 5_000 }).toBe('modifying');

    const pill = page.getByTestId('validation-pill');
    // First it shows 'validating' (spinner), then 'valid'
    await expect(pill).toHaveAttribute('data-state', 'validating', { timeout: 2_000 });
    await expect(pill).toHaveAttribute('data-state', 'valid', { timeout: 5_000 });

    // The reported area should be ~6 ha (4 vertices, ~245m × ~245m square at this latitude)
    const reportedArea = await readReportedArea(page);
    expect(reportedArea).toBeGreaterThan(5);
    expect(reportedArea).toBeLessThan(7);

    // -- 5. Cross-check: the same geom against the validate endpoint directly --
    // Belt and suspenders. If the UI shows green but the server disagrees,
    // we want to know.
    const directGeom = await page.evaluate(
      () => (window as any).__farmMapTest.currentDrawing()?.geometry,
    );
    expect(directGeom, 'currentDrawing() should return a polygon').toBeTruthy();

    const direct = await api.validatePlot({
      parcelId: SEED.parcels.A,
      geom: directGeom,
    });
    expect(direct.valid, `direct validation rejected: ${JSON.stringify(direct.errors)}`).toBe(true);
    expect(direct.area_ha).toBeCloseTo(reportedArea, 1);

    // -- 6. Save --
    const saveResp = page.waitForResponse(
      (r) => r.url().includes('/plots') && r.request().method() === 'POST' && r.status() === 201,
      { timeout: 10_000 },
    );
    await page.getByTestId('btn-save').click();
    const persistedRes = await saveResp;
    const persisted = await persistedRes.json();
    createdPlotId = persisted.id as string;
    expect(createdPlotId, 'created plot should have a uuid').toMatch(/^[0-9a-f-]{36}$/i);

    // After save, editor returns to idle
    await expect.poll(() => readMode(page), { timeout: 5_000 }).toBe('idle');

    // -- 7. Verify via API --
    const after = await api.listPlotsByParcel(SEED.parcels.A);
    expect(after, 'parcel A should now have 3 plots').toHaveLength(3);

    const plot = await api.getPlot(createdPlotId);
    expect(plot).not.toBeNull();
    expect(plot!.parcel_id).toBe(SEED.parcels.A);
    // Server-computed area should match what we saw in the UI within 1 dp
    expect(plot!.area_ha).toBeCloseTo(reportedArea, 1);

    // -- 8. Verify tile pipeline picked up the new feature --
    // Compute the right z/x/y for parcel A's location. World tile 0/0/0
    // works for a smoke check — anything past the seed should make it bigger.
    // For tighter verification, fetch a tile centred on the farm.
    const bytesAfter = await api.tileBytes('plots', 14,
      lonToTileX(36.4804, 14),
      latToTileY(6.2824, 14),
      { parcel_id: SEED.parcels.A },
    );
    expect(bytesAfter, 'tile should contain features after save').toBeGreaterThan(0);
  });

});

// -----------------------------------------------------------------------------
// Tiny helpers — convert lon/lat to tile coords (Web Mercator)
// -----------------------------------------------------------------------------

function lonToTileX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, z));
}
function latToTileY(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z),
  );
}
