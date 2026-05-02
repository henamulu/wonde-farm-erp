// =============================================================================
// apps/web/src/features/farm-map/useFarmMap.tsx
// =============================================================================
// React 18 + OpenLayers 9+ hook for plot drawing/editing.
// - Renders a map with: basemap, plots tile layer (from pg_tileserv MVT),
//   the parent parcel boundary as a snap target, a drawing layer.
// - Exposes `start`, `cancel`, `commit` plus live `area` and `valid` flags.
//
// Required deps:
//   npm i ol@9 ol-mapbox-style
//   (optional) npm i @turf/area  — we use ol/sphere instead, no extra dep
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import 'ol/ol.css';
import { Feature, Map as OlMap, View } from 'ol';
import { Polygon } from 'ol/geom';
import { fromLonLat, transformExtent } from 'ol/proj';
import { Draw, Modify, Snap } from 'ol/interaction';
import VectorLayer from 'ol/layer/Vector';
import VectorTileLayer from 'ol/layer/VectorTile';
import TileLayer from 'ol/layer/Tile';
import VectorSource from 'ol/source/Vector';
import VectorTileSource from 'ol/source/VectorTile';
import XYZ from 'ol/source/XYZ';
import { MVT } from 'ol/format';
import GeoJSON from 'ol/format/GeoJSON';
import { Style, Fill, Stroke } from 'ol/style';
import { getArea } from 'ol/sphere';
import type { Coordinate } from 'ol/coordinate';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

type GeoJsonPolygon = {
  type: 'Polygon';
  coordinates: number[][][];
};

type GeoJsonFeature = {
  type: 'Feature';
  geometry: GeoJsonPolygon;
  properties?: Record<string, unknown>;
};

export interface UseFarmMapOptions {
  /** Container div ref. */
  container: React.RefObject<HTMLDivElement>;
  /** XYZ basemap URL template, e.g. MapTiler satellite. */
  basemapUrl: string;
  /**
   * pg_tileserv vector tile URL template for existing plots.
   * Example: 'https://api.example.com/public.tile_plots/{z}/{x}/{y}.pbf?farm_id=...'
   */
  plotsTileUrl?: string;
  /**
   * Parent feature (parcel) used as snap target + the geometry we'll
   * validate the new draw against. GeoJSON in EPSG:4326.
   */
  parentGeom?: GeoJsonPolygon | null;
  /**
   * Optional: an existing plot to edit. If provided, the hook starts in
   * "modify" mode rather than expecting `start()`.
   */
  existing?: GeoJsonFeature | null;
  /**
   * Auth header injector for the vector tile loader (so RLS sees tenant).
   * Return a fresh token each time — this is called per tile request.
   */
  getAccessToken?: () => string | null;
  /** Center fallback if neither parent nor existing geom is provided. */
  fallbackCenterLonLat?: [number, number];
  /** Initial zoom level. */
  initialZoom?: number;
}

export interface UseFarmMapApi {
  /** Begin a new polygon draw. */
  start: () => void;
  /** Cancel current draw or unsaved modify. */
  cancel: () => void;
  /** Return the drawn/edited polygon as GeoJSON, or null if invalid/empty. */
  commit: () => GeoJsonFeature | null;
  /** Programmatically clear the drawing layer. */
  clear: () => void;
  /** Live area in hectares (0 when nothing drawn). */
  area: number;
  /** True iff the drawn feature is a valid polygon inside the parent (if given). */
  valid: boolean;
  /** Mode reflecting current state. */
  mode: 'idle' | 'drawing' | 'modifying';
}

// -----------------------------------------------------------------------------
// Styles
// -----------------------------------------------------------------------------

const PLOTS_STYLE = new Style({
  fill: new Fill({ color: 'rgba(34, 139, 34, 0.18)' }),
  stroke: new Stroke({ color: '#1f6f1f', width: 1 }),
});

const PARENT_STYLE = new Style({
  fill: new Fill({ color: 'rgba(255, 200, 0, 0.06)' }),
  stroke: new Stroke({ color: '#cc8800', width: 2, lineDash: [6, 4] }),
});

const DRAW_STYLE = new Style({
  fill: new Fill({ color: 'rgba(31, 119, 255, 0.30)' }),
  stroke: new Stroke({ color: '#1f77ff', width: 2 }),
});

// -----------------------------------------------------------------------------
// Hook
// -----------------------------------------------------------------------------

export function useFarmMap(opts: UseFarmMapOptions): UseFarmMapApi {
  const mapRef = useRef<OlMap | null>(null);
  const drawSourceRef = useRef<VectorSource>(new VectorSource());
  const parentSourceRef = useRef<VectorSource>(new VectorSource());
  const drawRef = useRef<Draw | null>(null);
  const modifyRef = useRef<Modify | null>(null);
  const snapRef = useRef<Snap | null>(null);

  const [area, setArea] = useState(0);
  const [valid, setValid] = useState(false);
  const [mode, setMode] = useState<'idle' | 'drawing' | 'modifying'>('idle');

  const geojson = useMemo(() => new GeoJSON({ dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' }), []);

  // ---------------------------------------------------------------------------
  // Mount: build the map once
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!opts.container.current) return;

    // Basemap
    const basemap = new TileLayer({
      source: new XYZ({ url: opts.basemapUrl, crossOrigin: 'anonymous', maxZoom: 22 }),
    });

    // Plots tile layer (existing plots from pg_tileserv)
    const plotsLayer = opts.plotsTileUrl
      ? new VectorTileLayer({
          source: new VectorTileSource({
            format: new MVT(),
            url: opts.plotsTileUrl,
            tileLoadFunction: (tile, url) => {
              const t = opts.getAccessToken?.();
              const xhr = new XMLHttpRequest();
              xhr.responseType = 'arraybuffer';
              xhr.open('GET', url);
              if (t) xhr.setRequestHeader('Authorization', `Bearer ${t}`);
              xhr.onload = () => {
                if (xhr.status === 200) {
                  (tile as any).setLoader((extent: any, _res: any, projection: any) => {
                    const format = (tile as any).getFormat();
                    const features = format.readFeatures(xhr.response, {
                      extent, featureProjection: projection,
                    });
                    (tile as any).setFeatures(features);
                  });
                  (tile as any).load();
                } else {
                  (tile as any).setState(3); // ERROR
                }
              };
              xhr.send();
            },
          }),
          style: PLOTS_STYLE,
        })
      : null;

    // Parent (parcel) outline
    const parentLayer = new VectorLayer({
      source: parentSourceRef.current,
      style: PARENT_STYLE,
    });

    // Drawing layer
    const drawLayer = new VectorLayer({
      source: drawSourceRef.current,
      style: DRAW_STYLE,
    });

    // Determine initial view
    const center: Coordinate = opts.fallbackCenterLonLat
      ? fromLonLat(opts.fallbackCenterLonLat)
      : fromLonLat([0, 0]);

    const map = new OlMap({
      target: opts.container.current,
      layers: [basemap, ...(plotsLayer ? [plotsLayer] : []), parentLayer, drawLayer],
      view: new View({
        center,
        zoom: opts.initialZoom ?? 14,
        maxZoom: 22,
      }),
    });
    mapRef.current = map;

    return () => {
      drawSourceRef.current.clear();
      parentSourceRef.current.clear();
      map.setTarget(undefined);
      mapRef.current = null;
    };
    // We deliberately mount-once. Prop changes are handled in subsequent effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // Sync parent geometry → parent source + fit view
  // ---------------------------------------------------------------------------
  useEffect(() => {
    parentSourceRef.current.clear();
    if (!opts.parentGeom) return;

    const feature = geojson.readFeature({
      type: 'Feature', geometry: opts.parentGeom, properties: {},
    } as GeoJsonFeature);
    parentSourceRef.current.addFeature(feature);

    const map = mapRef.current;
    if (map && feature.getGeometry()) {
      const ext = feature.getGeometry()!.getExtent();
      map.getView().fit(ext, { padding: [40, 40, 40, 40], maxZoom: 18 });
    }
  }, [opts.parentGeom, geojson]);

  // ---------------------------------------------------------------------------
  // Sync `existing` geometry into the draw source (edit mode)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    drawSourceRef.current.clear();
    if (!opts.existing) {
      setArea(0);
      setValid(false);
      setMode('idle');
      return;
    }
    const f = geojson.readFeature(opts.existing);
    drawSourceRef.current.addFeature(f);
    setMode('modifying');
    recomputeMetrics();
    enableModify();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.existing]);

  // ---------------------------------------------------------------------------
  // Metrics recompute (area + validity)
  // ---------------------------------------------------------------------------
  const recomputeMetrics = useCallback(() => {
    const features = drawSourceRef.current.getFeatures();
    if (!features.length) {
      setArea(0); setValid(false); return;
    }
    const f = features[0];
    const geom = f.getGeometry();
    if (!(geom instanceof Polygon)) { setArea(0); setValid(false); return; }

    // ol/sphere getArea: for projected coords, pass projection so it converts.
    const m2 = getArea(geom, { projection: 'EPSG:3857' });
    const ha = m2 / 10000;
    setArea(ha);

    // Validity: simple polygon + (if parent given) within parent
    const ringCount = geom.getCoordinates().length;
    let isValid = ringCount >= 1 && ha > 0.0001;
    if (isValid && opts.parentGeom) {
      const parent = parentSourceRef.current.getFeatures()[0]?.getGeometry();
      if (parent) {
        // crude containment check: every drawn vertex must be inside parent
        const verts = geom.getCoordinates()[0];
        isValid = verts.every((v) => parent.intersectsCoordinate(v));
      }
    }
    setValid(isValid);
  }, [opts.parentGeom]);

  // ---------------------------------------------------------------------------
  // Interaction helpers
  // ---------------------------------------------------------------------------

  const removeAllInteractions = useCallback(() => {
    const map = mapRef.current; if (!map) return;
    if (drawRef.current) { map.removeInteraction(drawRef.current); drawRef.current = null; }
    if (modifyRef.current) { map.removeInteraction(modifyRef.current); modifyRef.current = null; }
    if (snapRef.current) { map.removeInteraction(snapRef.current); snapRef.current = null; }
  }, []);

  const enableModify = useCallback(() => {
    const map = mapRef.current; if (!map) return;
    removeAllInteractions();

    const modify = new Modify({ source: drawSourceRef.current });
    modify.on('modifyend', recomputeMetrics);
    map.addInteraction(modify);
    modifyRef.current = modify;

    // Snap to parent + drawn feature
    const snap = new Snap({ source: parentSourceRef.current });
    map.addInteraction(snap);
    snapRef.current = snap;
  }, [recomputeMetrics, removeAllInteractions]);

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  const start = useCallback(() => {
    const map = mapRef.current; if (!map) return;
    drawSourceRef.current.clear();
    removeAllInteractions();

    const draw = new Draw({
      source: drawSourceRef.current,
      type: 'Polygon',
    });
    draw.on('drawend', () => {
      setMode('modifying');
      // Defer until feature is in the source
      setTimeout(() => {
        recomputeMetrics();
        enableModify();
      }, 0);
    });
    map.addInteraction(draw);
    drawRef.current = draw;

    // Snap to parent boundary while drawing
    const snap = new Snap({ source: parentSourceRef.current });
    map.addInteraction(snap);
    snapRef.current = snap;

    setMode('drawing');
  }, [enableModify, recomputeMetrics, removeAllInteractions]);

  const cancel = useCallback(() => {
    removeAllInteractions();
    drawSourceRef.current.clear();
    setArea(0); setValid(false);
    setMode('idle');
  }, [removeAllInteractions]);

  const clear = useCallback(() => {
    drawSourceRef.current.clear();
    setArea(0); setValid(false);
  }, []);

  const commit = useCallback((): GeoJsonFeature | null => {
    const features = drawSourceRef.current.getFeatures();
    if (!features.length || !valid) return null;
    const f = features[0];
    const out = geojson.writeFeatureObject(f, {
      featureProjection: 'EPSG:3857',
      dataProjection: 'EPSG:4326',
      decimals: 7,
    }) as GeoJsonFeature;
    return out;
  }, [geojson, valid]);

  return { start, cancel, commit, clear, area, valid, mode };
}

// =============================================================================
// Demo consumer component
// =============================================================================
// Drop this into a page route to verify the hook end-to-end. Replace the
// constants with your real basemap, tile, and parcel.
// =============================================================================

import { useRef } from 'react';

interface PlotEditorProps {
  parentGeom: GeoJsonPolygon;
  parcelId: string;
  onSaved?: (saved: { id: string; area_ha: number }) => void;
}

export function PlotEditor({ parentGeom, parcelId, onSaved }: PlotEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const map = useFarmMap({
    container: containerRef,
    basemapUrl: 'https://api.maptiler.com/maps/satellite/{z}/{x}/{y}.jpg?key=YOUR_KEY',
    plotsTileUrl: `https://api.example.com/public.tile_plots/{z}/{x}/{y}.pbf?parcel_id=${parcelId}`,
    parentGeom,
    getAccessToken: () => localStorage.getItem('access_token'),
    initialZoom: 16,
  });

  async function save() {
    const feature = map.commit();
    if (!feature) return;

    const res = await fetch('/api/plots', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${localStorage.getItem('access_token')}`,
      },
      body: JSON.stringify({
        parcel_id: parcelId,
        code: `P-${Date.now()}`,
        geom: feature.geometry,
      }),
    });
    if (!res.ok) {
      console.error(await res.text());
      return;
    }
    const json = await res.json();
    onSaved?.(json);
    map.cancel();
  }

  return (
    <div className="relative h-screen w-full">
      <div ref={containerRef} className="h-full w-full" />

      <div className="absolute top-4 left-4 flex flex-col gap-2 rounded-md bg-white/95 p-3 shadow-md">
        <div className="text-sm font-medium">Plot editor</div>
        <div className="text-xs text-gray-600">
          Mode: <span className="font-mono">{map.mode}</span>
        </div>
        <div className="text-xs text-gray-600">
          Area: <span className="font-mono">{map.area.toFixed(3)} ha</span>
        </div>
        <div className="text-xs">
          {map.valid
            ? <span className="text-green-700">✓ valid</span>
            : <span className="text-amber-700">⚠ outside parcel or invalid</span>}
        </div>

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
                disabled={!map.valid}
                className="rounded bg-green-600 px-3 py-1.5 text-sm text-white hover:bg-green-700 disabled:opacity-50"
              >
                Save
              </button>
              <button
                onClick={map.cancel}
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
