// =============================================================================
// e2e/helpers/map.ts
// =============================================================================
// Drives the OpenLayers map canvas. The canvas is opaque to DOM selectors,
// so we need to:
//   1. Read the map's current projection state from the page
//   2. Convert geographic coords (lon, lat) to viewport pixels
//   3. Translate viewport pixels to page pixels via the canvas bounding rect
//   4. Use page.mouse to click at those page pixels
//
// This relies on a small instrumentation hook in useFarmMap.tsx that exposes
// `window.__farmMapTest` when running in test mode. See the patch at the
// bottom of this file.
// =============================================================================

import { Page, expect } from '@playwright/test';

interface PixelHelperResult {
  x: number;
  y: number;
}

/**
 * Wait until the OpenLayers map is mounted and ready for interaction.
 * The map exposes itself via `window.__farmMapTest` once it has finished
 * fitting the view to the parent geometry.
 */
export async function waitForMapReady(page: Page, timeoutMs = 15_000): Promise<void> {
  await expect.poll(
    () => page.evaluate(() => Boolean((window as any).__farmMapTest?.ready?.())),
    {
      message: 'map test helper not exposed — did you patch useFarmMap?',
      timeout: timeoutMs,
      intervals: [100, 200, 500, 1000],
    },
  ).toBe(true);
}

/**
 * Convert a [lon, lat] to a page-relative {x, y} the next click should hit.
 */
async function pageCoords(page: Page, lon: number, lat: number): Promise<PixelHelperResult> {
  return await page.evaluate(([lon, lat]) => {
    const t = (window as any).__farmMapTest;
    if (!t) throw new Error('test helper missing');
    const [px, py] = t.pixelFor(lon, lat);
    const r = t.rect();
    return { x: r.x + px, y: r.y + py };
  }, [lon, lat] as [number, number]);
}

/**
 * Draw a polygon by clicking each vertex in order and double-clicking the
 * last one to finish. OpenLayers' Draw interaction treats double-click as
 * "complete the polygon".
 *
 * Tip: pass at least 4 distinct vertices. OL refuses to finish a polygon
 * with fewer than 3 unique points, and double-click on a point colocated
 * with the previous vertex is interpreted as "remove the last vertex".
 */
export async function drawPolygon(page: Page, vertices: Array<[number, number]>): Promise<void> {
  if (vertices.length < 3) throw new Error(`polygon needs at least 3 vertices, got ${vertices.length}`);

  for (let i = 0; i < vertices.length; i++) {
    const [lon, lat] = vertices[i];
    const { x, y } = await pageCoords(page, lon, lat);

    if (i === vertices.length - 1) {
      // Final vertex — double-click to finish the polygon
      await page.mouse.dblclick(x, y, { delay: 30 });
    } else {
      // OL needs a small breathing room between mousedown/mouseup to register
      // a vertex; default `click` works most of the time but explicit
      // down/up pairs are more reliable across OS scheduling jitter.
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.up();
    }
    // Small idle so OL re-renders before the next interaction
    await page.waitForTimeout(60);
  }
}

/**
 * Modify a vertex by dragging it. Useful for "edit existing plot" tests.
 * `fromLonLat` is a current vertex of the polygon; `toLonLat` is where to
 * drop it.
 */
export async function dragVertex(page: Page, fromLonLat: [number, number], toLonLat: [number, number]): Promise<void> {
  const a = await pageCoords(page, fromLonLat[0], fromLonLat[1]);
  const b = await pageCoords(page, toLonLat[0],   toLonLat[1]);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  // Move in steps so OL's Modify interaction tracks the drag
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
}

/**
 * Read the area (in hectares) the map currently reports. This reflects
 * `getArea` on the drawn feature, projected through ol/sphere.
 */
export async function readReportedArea(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const el = document.querySelector('[data-testid="map-area"]');
    if (!el) return NaN;
    const m = /([\d.]+)\s*ha/.exec(el.textContent ?? '');
    return m ? Number(m[1]) : NaN;
  });
}

/**
 * Read the current draw mode from the UI.
 */
export async function readMode(page: Page): Promise<'idle' | 'drawing' | 'modifying'> {
  return await page.evaluate(() => {
    const el = document.querySelector('[data-testid="map-mode"]');
    return (el?.textContent?.trim() ?? 'idle') as 'idle' | 'drawing' | 'modifying';
  });
}

// =============================================================================
// Patch you need to apply to apps/web/src/features/farm-map/useFarmMap.tsx
// =============================================================================
// Inside the mount-once useEffect, AFTER `mapRef.current = map;`, add:
//
//     // -- E2E test instrumentation --
//     // Only exposed in dev/test builds. Delete or guard with NODE_ENV
//     // check in production.
//     if (import.meta.env.MODE !== 'production') {
//       (window as any).__farmMapTest = {
//         ready: () => true,
//         pixelFor: (lon: number, lat: number) =>
//           map.getPixelFromCoordinate(fromLonLat([lon, lat])),
//         rect: () => {
//           const r = (map.getTargetElement() as HTMLElement).getBoundingClientRect();
//           return { x: r.left, y: r.top, width: r.width, height: r.height };
//         },
//         // Optional: read the GeoJSON of whatever's been drawn
//         currentDrawing: () => {
//           const f = drawSourceRef.current.getFeatures()[0];
//           if (!f) return null;
//           return new GeoJSON({
//             dataProjection: 'EPSG:4326',
//             featureProjection: 'EPSG:3857',
//           }).writeFeatureObject(f, { decimals: 7 });
//         },
//       };
//     }
//
// Also add data-testids to the toolbar markers in PlotEditor / PlotEditorLive:
//   <span data-testid="map-mode">{map.mode}</span>
//   <span data-testid="map-area">{map.area.toFixed(3)} ha</span>
//   <div data-testid="validation-pill" data-state={validate.state.status}>...</div>
//   <button data-testid="btn-draw">Draw new plot</button>
//   <button data-testid="btn-save">Save</button>
//   <button data-testid="btn-cancel">Cancel</button>
//
// =============================================================================
