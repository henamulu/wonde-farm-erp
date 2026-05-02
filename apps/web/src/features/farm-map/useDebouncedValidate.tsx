// =============================================================================
// apps/web/src/features/farm-map/useDebouncedValidate.tsx
// =============================================================================
// Live geometry validation against the server. Wraps the /geom/validate
// endpoint with debouncing, request cancellation, and a small state machine
// so the UI can show idle / validating / valid / invalid without flicker.
//
// Pair with `useFarmMap` — call `setGeom(geojson)` from the modify handler.
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// -----------------------------------------------------------------------------
// Shared types — should live in packages/shared so the server and client
// agree. Duplicated here for the example.
// -----------------------------------------------------------------------------

export type ValidationErrorCode =
  | 'invalid_geometry'
  | 'wrong_srid'
  | 'outside_parent'
  | 'overlaps_sibling'
  | 'too_small'
  | 'too_large'
  | 'parent_not_found';

export interface ValidationError {
  code: ValidationErrorCode;
  message: string;
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
  area_m2: number;
  area_ha: number;
  fixed_geom?: { type: 'Polygon'; coordinates: number[][][] };
}

export type ValidateState =
  | { status: 'idle' }
  | { status: 'validating' }
  | { status: 'valid'; result: ValidateGeomResponse }
  | { status: 'invalid'; result: ValidateGeomResponse }
  | { status: 'error'; message: string };

// -----------------------------------------------------------------------------
// Hook
// -----------------------------------------------------------------------------

export interface UseDebouncedValidateOptions {
  /** Endpoint URL — typically '/api/geom/validate'. */
  endpoint: string;
  /** What is being drawn. */
  entity: 'parcel' | 'plot' | 'crop_plan' | 'contract';
  /** Parent id (farm for parcel, parcel for plot, plot for crop_plan). */
  parentId: string;
  /** Existing row id when editing — excluded from sibling overlap checks. */
  excludeId?: string;
  /** crop_plan only: season scope for sibling overlap. */
  seasonId?: string;
  /** Bearer token getter (called per request). */
  getAccessToken: () => string | null;
  /** ms before firing after last edit. Default 350. */
  debounceMs?: number;
}

export interface UseDebouncedValidateApi {
  state: ValidateState;
  /** Push a new geometry to validate. Pass null to reset to idle. */
  setGeom: (geom: { type: 'Polygon'; coordinates: number[][][] } | null) => void;
  /** Force-cancel any pending request and clear state. */
  reset: () => void;
}

export function useDebouncedValidate(
  opts: UseDebouncedValidateOptions,
): UseDebouncedValidateApi {
  const [state, setState] = useState<ValidateState>({ status: 'idle' });
  const timerRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const debounceMs = opts.debounceMs ?? 350;

  // Stable hash so we skip duplicate validations of the same geometry.
  const lastHashRef = useRef<string | null>(null);

  const cancelInFlight = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    cancelInFlight();
    lastHashRef.current = null;
    setState({ status: 'idle' });
  }, [cancelInFlight]);

  useEffect(() => {
    return () => cancelInFlight();
  }, [cancelInFlight]);

  const setGeom = useCallback<UseDebouncedValidateApi['setGeom']>(
    (geom) => {
      cancelInFlight();
      if (!geom) {
        lastHashRef.current = null;
        setState({ status: 'idle' });
        return;
      }

      // Skip identical geometries (modify event without coordinate change).
      const hash = JSON.stringify(geom.coordinates);
      if (hash === lastHashRef.current && state.status !== 'error') return;
      lastHashRef.current = hash;

      setState({ status: 'validating' });

      timerRef.current = window.setTimeout(async () => {
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        try {
          const res = await fetch(opts.endpoint, {
            method: 'POST',
            signal: ctrl.signal,
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${opts.getAccessToken() ?? ''}`,
            },
            body: JSON.stringify({
              entity:    opts.entity,
              geom,
              parentId:  opts.parentId,
              excludeId: opts.excludeId,
              seasonId:  opts.seasonId,
            }),
          });
          if (!res.ok) {
            setState({ status: 'error', message: `HTTP ${res.status}` });
            return;
          }
          const result: ValidateGeomResponse = await res.json();
          setState({ status: result.valid ? 'valid' : 'invalid', result });
        } catch (err: any) {
          if (err?.name === 'AbortError') return;
          setState({ status: 'error', message: err?.message ?? 'network error' });
        } finally {
          if (abortRef.current === ctrl) abortRef.current = null;
        }
      }, debounceMs);
    },
    // we intentionally omit `state.status` from deps — we read it fresh inside
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      opts.endpoint, opts.entity, opts.parentId, opts.excludeId,
      opts.seasonId, opts.getAccessToken, debounceMs, cancelInFlight,
    ],
  );

  return { state, setGeom, reset };
}

// =============================================================================
// Integration with useFarmMap — drop-in replacement for PlotEditor showing
// live validation on every modify event.
// =============================================================================

import { useRef } from 'react';
import { useFarmMap } from './useFarmMap'; // adjust import path

interface PlotEditorProps {
  parentParcelId: string;
  parentGeom: { type: 'Polygon'; coordinates: number[][][] };
  existingPlotId?: string;
  onSaved?: (saved: { id: string; area_ha: number }) => void;
}

export function PlotEditorLive({
  parentParcelId, parentGeom, existingPlotId, onSaved,
}: PlotEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const map = useFarmMap({
    container: containerRef,
    basemapUrl: 'https://api.maptiler.com/maps/satellite/{z}/{x}/{y}.jpg?key=YOUR_KEY',
    plotsTileUrl: `/api/tiles/public.tile_plots/{z}/{x}/{y}.pbf?parcel_id=${parentParcelId}`,
    parentGeom,
    getAccessToken: () => localStorage.getItem('access_token'),
    initialZoom: 14,
  });

  const validate = useDebouncedValidate({
    endpoint: '/api/geom/validate',
    entity: 'plot',
    parentId: parentParcelId,
    excludeId: existingPlotId,
    getAccessToken: () => localStorage.getItem('access_token'),
  });

  // Whenever the drawn geometry changes, push it through validation.
  // We piggy-back on `map.area` as a cheap change-detect trigger; in real
  // code expose an onChange hook from useFarmMap for the GeoJSON itself.
  useEffect(() => {
    if (map.mode === 'idle') {
      validate.reset();
      return;
    }
    const feat = map.commit(); // commit() returns null when invalid client-side
    // Even if client-side is "invalid", we still want to validate so the
    // user gets a real reason from the server. Re-implement commit() so it
    // returns the GeoJSON regardless of validity, or expose a peek method.
    // For brevity, this example only validates client-valid geometries.
    if (feat) validate.setGeom(feat.geometry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map.area, map.mode]);

  async function save() {
    if (validate.state.status !== 'valid') return;
    const feature = map.commit();
    if (!feature) return;

    const res = await fetch('/api/plots', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${localStorage.getItem('access_token')}`,
      },
      body: JSON.stringify({
        parcel_id: parentParcelId,
        code: `P-${Date.now()}`,
        geom: feature.geometry,
      }),
    });
    if (!res.ok) { console.error(await res.text()); return; }
    onSaved?.(await res.json());
    map.cancel();
    validate.reset();
  }

  return (
    <div className="relative h-screen w-full">
      <div ref={containerRef} className="h-full w-full" />

      <div className="absolute top-4 left-4 flex w-80 flex-col gap-2 rounded-md bg-white/95 p-3 shadow-md">
        <div className="text-sm font-medium">Plot editor</div>

        <div className="flex items-center justify-between text-xs text-gray-600">
          <span>Mode</span>
          <span className="font-mono">{map.mode}</span>
        </div>
        <div className="flex items-center justify-between text-xs text-gray-600">
          <span>Area (client)</span>
          <span className="font-mono">{map.area.toFixed(3)} ha</span>
        </div>

        {/* Live validation pill */}
        <ValidationPill state={validate.state} />

        {/* Errors / warnings details */}
        {(validate.state.status === 'invalid' || validate.state.status === 'valid') && (
          <ValidationDetails result={validate.state.result} />
        )}

        <div className="mt-2 flex gap-2">
          {map.mode === 'idle' && (
            <button
              onClick={map.start}
              className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
            >
              Draw new plot
            </button>
          )}
          {map.mode !== 'idle' && (
            <>
              <button
                onClick={save}
                disabled={validate.state.status !== 'valid'}
                className="rounded bg-green-600 px-3 py-1.5 text-sm text-white hover:bg-green-700 disabled:opacity-50"
              >
                Save
              </button>
              <button
                onClick={() => { map.cancel(); validate.reset(); }}
                className="rounded bg-gray-200 px-3 py-1.5 text-sm hover:bg-gray-300"
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ValidationPill({ state }: { state: ValidateState }) {
  const styles: Record<ValidateState['status'], { color: string; label: string }> = {
    idle:       { color: 'bg-gray-200 text-gray-700',     label: 'Idle' },
    validating: { color: 'bg-blue-100 text-blue-800',     label: 'Validating…' },
    valid:      { color: 'bg-green-100 text-green-800',   label: '✓ Valid' },
    invalid:    { color: 'bg-amber-100 text-amber-800',   label: '✗ Invalid' },
    error:      { color: 'bg-red-100 text-red-800',       label: '⚠ Error' },
  };
  const s = styles[state.status];
  return (
    <div className={`inline-flex w-fit rounded-full px-2.5 py-0.5 text-xs font-medium ${s.color}`}>
      {s.label}
    </div>
  );
}

function ValidationDetails({ result }: { result: ValidateGeomResponse }) {
  return (
    <div className="space-y-1.5 text-xs">
      <div className="flex justify-between text-gray-600">
        <span>Area (server)</span>
        <span className="font-mono">{result.area_ha.toFixed(3)} ha</span>
      </div>
      {result.errors.map((e, i) => (
        <div key={i} className="rounded bg-red-50 px-2 py-1 text-red-800">
          <span className="font-mono">{e.code}</span>: {e.message}
        </div>
      ))}
      {result.warnings.map((w, i) => (
        <div key={i} className="rounded bg-amber-50 px-2 py-1 text-amber-800">
          <span className="font-mono">{w.code}</span>: {w.message}
        </div>
      ))}
    </div>
  );
}
