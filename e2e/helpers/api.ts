// =============================================================================
// e2e/helpers/api.ts
// =============================================================================
// Direct API client used by specs to verify state without driving the UI.
// "After clicking Save, was the plot actually persisted?" — that question
// shouldn't depend on whether the UI updates correctly.
// =============================================================================

import { APIRequestContext, request as PWRequest, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TOKEN_PATH = resolve(__dirname, '..', '.artifacts', 'access-token.txt');

export interface PlotSummary {
  id: string;
  parcel_id: string;
  code: string;
  area_ha: number;
}

export class ApiClient {
  private constructor(
    private ctx: APIRequestContext,
    private token: string,
  ) {}

  static async create(apiBaseUrl: string): Promise<ApiClient> {
    const token = readFileSync(TOKEN_PATH, 'utf-8').trim();
    const ctx = await PWRequest.newContext({
      baseURL: apiBaseUrl,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });
    return new ApiClient(ctx, token);
  }

  async dispose() { await this.ctx.dispose(); }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async listPlotsByParcel(parcelId: string): Promise<PlotSummary[]> {
    const res = await this.ctx.get(`/v1/plots`, { params: { parcel_id: parcelId } });
    expect(res.ok(), `listPlots failed: ${res.status()}`).toBe(true);
    return await res.json();
  }

  async getPlot(plotId: string): Promise<PlotSummary | null> {
    const res = await this.ctx.get(`/v1/plots/${plotId}`);
    if (res.status() === 404) return null;
    expect(res.ok(), `getPlot failed: ${res.status()}`).toBe(true);
    return await res.json();
  }

  // ---------------------------------------------------------------------------
  // Writes — used to set up test fixtures the UI couldn't easily produce
  // ---------------------------------------------------------------------------

  async deletePlot(plotId: string): Promise<void> {
    const res = await this.ctx.delete(`/v1/plots/${plotId}`);
    // 404 is fine — already gone
    if (!res.ok() && res.status() !== 404) {
      throw new Error(`deletePlot failed: ${res.status()} ${await res.text()}`);
    }
  }

  /** Validate a geometry without persisting — same endpoint the UI uses. */
  async validatePlot(opts: {
    parcelId: string;
    geom: { type: 'Polygon'; coordinates: number[][][] };
    excludeId?: string;
  }) {
    const res = await this.ctx.post('/v1/geom/validate', {
      data: {
        entity: 'plot',
        parentId: opts.parcelId,
        excludeId: opts.excludeId,
        geom: opts.geom,
      },
    });
    expect(res.ok(), `validate failed: ${res.status()}`).toBe(true);
    return await res.json() as {
      valid: boolean;
      area_ha: number;
      errors: Array<{ code: string; message: string }>;
      warnings: Array<{ code: string; message: string }>;
    };
  }

  // ---------------------------------------------------------------------------
  // Tile pipeline — verify a freshly-saved plot shows up in vector tiles
  // ---------------------------------------------------------------------------

  /**
   * Fetches an MVT tile and returns its byte length. > 0 means the layer
   * has features in this tile. Useful as a smoke check that pg_tileserv
   * (or our custom tileserver) sees the new feature.
   */
  async tileBytes(layer: string, z: number, x: number, y: number, params: Record<string, string> = {}): Promise<number> {
    const search = new URLSearchParams(params).toString();
    const url = `/tiles/${layer}/${z}/${x}/${y}.pbf${search ? '?' + search : ''}`;
    const res = await this.ctx.get(url);
    if (res.status() === 304 || res.status() === 204) return 0;
    expect(res.ok(), `tile fetch failed: ${res.status()}`).toBe(true);
    return (await res.body()).length;
  }
}

// -----------------------------------------------------------------------------
// Stable IDs from the seed — used as "I know X exists" anchors in specs
// -----------------------------------------------------------------------------
export const SEED = {
  tenant:       '00000000-0000-4000-8000-000000000001',
  owner:        '00000000-0000-4000-8000-000000000010',
  farm:         '00000000-0000-4000-8000-000000000020',
  parcels: {
    A: '00000000-0000-4000-8000-000000000031', // North coffee block
    B: '00000000-0000-4000-8000-000000000032',
    C: '00000000-0000-4000-8000-000000000033',
    D: '00000000-0000-4000-8000-000000000034',
    E: '00000000-0000-4000-8000-000000000035',
  },
} as const;

// Approximate centroid of parcel A — used by the map helper to position
// drawn shapes. These coords are inside the actual farm boundary.
export const PARCEL_A_CENTROID_LON_LAT: [number, number] = [36.4804, 6.2824];
