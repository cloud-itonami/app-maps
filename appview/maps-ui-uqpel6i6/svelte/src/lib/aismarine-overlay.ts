/**
 * aismarine vessel overlay for KAMI (ADR-2605011500).
 *
 * Two layers, switched by zoom:
 *   - low zoom (< MIN_ZOOM_VESSELS, 8 by default) → density polygons from
 *     `getVesselDensityTile`. Phase 1: 0.1°×0.1° lat/lon grid rectangles
 *     (cellSchema='grid_0p1deg', backed by mv_vessel_density_grid). Phase 2
 *     will introduce H3 res-6 hex polygons (cellSchema='h3_r6') once a
 *     RisingWave Python/Rust UDF wraps `h3o`.
 *   - high zoom (>= MIN_ZOOM_VESSELS) → individual vessel circles from
 *     `queryVesselsBbox` (mv_vessel_latest_position SELECT)
 *
 * Color = vessel_type_class. Density opacity = log-scaled vessel_count.
 *
 * Refresh: on every moveend; cache key = floor(zoom)|sw|ne|mode → skip
 * duplicate fetch when the user pans inside the same key. The aisstream
 * consumer is itself ~30s-fresh by the time it lands in RW, so a 30s
 * polling interval makes no sense — moveend is enough.
 */
import {
  aismarineQueryVesselsBbox,
  aismarineGetVesselDensityTile,
  type VesselFeature,
  type VesselDensityCell,
  type VesselDensityCellSchema,
} from './api';
import type { KamiMapBridge } from './kami-bridge';

const MIN_ZOOM_VESSELS = 8;
const MAX_VESSELS_PER_FETCH = 5000;
const SOURCE_VESSELS = 'aismarine-vessels';
const SOURCE_DENSITY = 'aismarine-density';
const SOURCE_TRACK = 'aismarine-vessel-track';
const SOURCE_SELECTED = 'aismarine-vessel-selected';
const LAYER_VESSELS = 'aismarine-vessels-layer';
const LAYER_VESSELS_HIT = 'aismarine-vessels-hit-layer';   // invisible large click target
const LAYER_DENSITY = 'aismarine-density-layer';
const LAYER_TRACK = 'aismarine-vessel-track-layer';
const LAYER_SELECTED_RING = 'aismarine-vessel-selected-ring';   // glowing halo
const LAYER_SELECTED_DOT = 'aismarine-vessel-selected-dot';     // bright fill

// vessel_type_class → fill color (from vessel_type_class SQL UDF).
// Colors picked for high contrast against satellite imagery (deep navy
// water + brown/green land). Unknown defaults to bright magenta so that
// NOAA-only rows (no Type-5 master) still pop against any basemap.
const TYPE_CLASS_COLOR: Record<string, string> = {
  cargo: '#10b981',           // emerald
  tanker: '#ef4444',          // red
  passenger: '#3b82f6',       // sapphire blue
  highspeed: '#f59e0b',       // amber
  sailing_pleasure: '#a78bfa',// violet
  fishing: '#22d3ee',         // cyan
  tug: '#84cc16',             // lime
  military: '#fde047',        // bright yellow (was navy — invisible on water)
  pilot: '#fbbf24',           // amber-light
  sar: '#dc2626',             // crimson
  lawenforcement: '#fef3c7',  // pale gold
  other: '#fb923c',           // orange
  unknown: '#f472b6',         // pink — clearly distinct from any basemap
};

function colorFor(typeClass: string): string {
  return TYPE_CLASS_COLOR[typeClass] ?? TYPE_CLASS_COLOR.unknown;
}

const EMPTY_FC = { type: 'FeatureCollection' as const, features: [] };

export type VesselClickHandler = (vessel: VesselFeature['properties']) => void;

export type AismarineOverlayControl = {
  /** Tear down all sources/layers/listeners. */
  destroy: () => void;
  /** Render a polyline of [lon, lat] points as the active vessel track. */
  showTrack: (points: Array<[number, number]>) => void;
  /** Clear the track overlay (e.g. when the detail panel is closed). */
  clearTrack: () => void;
  /** Highlight a vessel at [lon, lat] with a glowing yellow ring. */
  selectVessel: (lonLat: [number, number]) => void;
  /** Clear the selection ring. */
  clearSelection: () => void;
  /** Toggle layer visibility without tearing down sources/listeners. */
  setVisible: (visible: boolean) => void;
};

export function applyAismarineOverlay(
  map: KamiMapBridge,
  opts: { onVesselClick?: VesselClickHandler } = {},
): AismarineOverlayControl {
  // Vessel circle source + layer (high zoom).
  map.addSource(SOURCE_VESSELS, { type: 'geojson', data: EMPTY_FC } as never);
  map.addLayer({
    id: LAYER_VESSELS,
    type: 'circle',
    source: SOURCE_VESSELS,
    minzoom: MIN_ZOOM_VESSELS,
    paint: {
      'circle-color': [
        'match',
        ['get', 'type_class'],
        'cargo', TYPE_CLASS_COLOR.cargo,
        'tanker', TYPE_CLASS_COLOR.tanker,
        'passenger', TYPE_CLASS_COLOR.passenger,
        'highspeed', TYPE_CLASS_COLOR.highspeed,
        'fishing', TYPE_CLASS_COLOR.fishing,
        'tug', TYPE_CLASS_COLOR.tug,
        'military', TYPE_CLASS_COLOR.military,
        'pilot', TYPE_CLASS_COLOR.pilot,
        'sar', TYPE_CLASS_COLOR.sar,
        'lawenforcement', TYPE_CLASS_COLOR.lawenforcement,
        'other', TYPE_CLASS_COLOR.other,
        'sailing_pleasure', TYPE_CLASS_COLOR.sailing_pleasure,
        TYPE_CLASS_COLOR.unknown,
      ],
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        MIN_ZOOM_VESSELS, 5,
        10, 6,
        12, 8,
        14, 11,
        16, 14,
      ],
      'circle-stroke-width': 1.5,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-opacity': 0.95,
      'circle-opacity': 0.92,
      'circle-pitch-alignment': 'viewport',
    },
  } as never);

  // Invisible "hit halo" layer that sits *under* LAYER_VESSELS and gives the
  // click handler 2× the visible radius worth of selectable area. Without
  // this, a 6-8 px circle at zoom 12-13 is too small to hit reliably with a
  // mouse — especially with the AUTO TILT camera. The layer is fully
  // transparent (circle-opacity: 0) so it has no visual presence.
  map.addLayer({
    id: LAYER_VESSELS_HIT,
    type: 'circle',
    source: SOURCE_VESSELS,
    minzoom: MIN_ZOOM_VESSELS,
    paint: {
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        MIN_ZOOM_VESSELS, 12,
        10, 14,
        12, 18,
        14, 22,
        16, 26,
      ],
      'circle-color': '#000000',
      'circle-opacity': 0,
      'circle-stroke-width': 0,
      'circle-pitch-alignment': 'viewport',
    },
  } as never);

  // Selected-vessel highlight (rendered on top of LAYER_VESSELS). Source
  // populated by selectVessel() / clearSelection().
  map.addSource(SOURCE_SELECTED, { type: 'geojson', data: EMPTY_FC } as never);
  map.addLayer({
    id: LAYER_SELECTED_RING,
    type: 'circle',
    source: SOURCE_SELECTED,
    paint: {
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        MIN_ZOOM_VESSELS, 14,
        12, 22,
        16, 30,
      ],
      'circle-color': '#fde047',
      'circle-opacity': 0.20,
      'circle-stroke-width': 3,
      'circle-stroke-color': '#fde047',
      'circle-stroke-opacity': 0.95,
      'circle-pitch-alignment': 'viewport',
    },
  } as never);
  map.addLayer({
    id: LAYER_SELECTED_DOT,
    type: 'circle',
    source: SOURCE_SELECTED,
    paint: {
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        MIN_ZOOM_VESSELS, 5,
        14, 11,
        16, 14,
      ],
      'circle-color': '#fde047',
      'circle-opacity': 1,
      'circle-stroke-width': 2,
      'circle-stroke-color': '#1f2937',
      'circle-pitch-alignment': 'viewport',
    },
  } as never);

  // Active-vessel track polyline (rendered above vessel circles when a
  // vessel is selected). Empty until showTrack() is called.
  map.addSource(SOURCE_TRACK, { type: 'geojson', data: EMPTY_FC } as never);
  map.addLayer({
    id: LAYER_TRACK,
    type: 'line',
    source: SOURCE_TRACK,
    paint: {
      'line-color': '#fde047',
      'line-width': 3,
      'line-opacity': 0.9,
      'line-blur': 0.5,
    },
  } as never);

  // Density hex source + fill layer (low zoom).
  map.addSource(SOURCE_DENSITY, { type: 'geojson', data: EMPTY_FC } as never);
  map.addLayer({
    id: LAYER_DENSITY,
    type: 'fill',
    source: SOURCE_DENSITY,
    maxzoom: MIN_ZOOM_VESSELS,
    paint: {
      // Heatmap-style density: log-vessel-count → cyan→amber→red ramp.
      'fill-color': [
        'interpolate', ['linear'],
        ['log10', ['max', 1, ['get', 'vessel_count']]],
        0,   '#22d3ee',  // cyan (1 vessel)
        1.0, '#10b981',  // emerald (10)
        1.7, '#fbbf24',  // amber (50)
        2.3, '#f97316',  // orange (200)
        3.0, '#dc2626',  // red (1000+)
      ],
      'fill-opacity': [
        'interpolate', ['linear'],
        ['log10', ['max', 1, ['get', 'vessel_count']]],
        0,   0.30,
        1.0, 0.45,
        2.0, 0.65,
        3.0, 0.85,
      ],
      'fill-outline-color': '#ffffff',
    },
  } as never);

  // Click handler — forward circle clicks to host so the appshell can open
  // a vessel detail panel via aismarineGetVesselDetail. Bind to the
  // invisible hit layer so users can click the halo around a vessel
  // (2× radius) instead of the visible circle.
  const mapEvents = map as unknown as {
    on?: (event: string, layerId: string, handler: (e: { features?: Array<{ properties?: unknown }> }) => void) => void;
    off?: (event: string, layerId: string, handler: (e: { features?: Array<{ properties?: unknown }> }) => void) => void;
    getCanvas?: () => HTMLCanvasElement | undefined;
  };
  const onLayer = mapEvents.on;
  if (typeof onLayer === 'function') {
    if (opts.onVesselClick) {
      onLayer.call(map, 'click', LAYER_VESSELS_HIT, (e) => {
        const feat = e.features?.[0];
        if (feat && feat.properties) {
          opts.onVesselClick!(feat.properties as VesselFeature['properties']);
        }
      });
    }
    // Cursor feedback — pointer when hovering a vessel.
    onLayer.call(map, 'mouseenter', LAYER_VESSELS_HIT, () => {
      const c = mapEvents.getCanvas?.();
      if (c) c.style.cursor = 'pointer';
    });
    onLayer.call(map, 'mouseleave', LAYER_VESSELS_HIT, () => {
      const c = mapEvents.getCanvas?.();
      if (c) c.style.cursor = '';
    });
  }

  // Phase 2-only: h3-js is loaded lazily for `cellSchema='h3_r6'`. Phase 1
  // ('grid_0p1deg') is rendered without it. h3-js stays in package.json so the
  // import resolves the moment Phase 2 ships.
  let cellToBoundaryFn: ((h3: string, geoJson?: boolean) => number[][]) | null = null;
  const ensureH3 = () => {
    if (cellToBoundaryFn !== null) return Promise.resolve();
    return import('h3-js').then((m) => {
      cellToBoundaryFn = (h3: string, geoJson = true) => (m.cellToBoundary(h3, geoJson) as number[][]);
    }).catch(() => {
      cellToBoundaryFn = null;
    });
  };

  let pending = false;
  let lastKey = '';

  const refresh = async () => {
    if (pending) return;
    pending = true;
    try {
      const vp = map.getViewport();
      const bounds = map.getBounds();
      const sw = bounds.getSouthWest();
      const ne = bounds.getNorthEast();
      const zoom = Math.floor(vp.zoom);
      const mode = zoom >= MIN_ZOOM_VESSELS ? 'vessels' : 'density';
      const key = `${mode}|${zoom}|${sw.lng.toFixed(2)},${sw.lat.toFixed(2)}|${ne.lng.toFixed(2)},${ne.lat.toFixed(2)}`;
      if (key === lastKey) return;
      lastKey = key;

      const bbox: [number, number, number, number] = [sw.lng, sw.lat, ne.lng, ne.lat];

      if (mode === 'vessels') {
        const res = await aismarineQueryVesselsBbox({ bbox, limit: MAX_VESSELS_PER_FETCH });
        const fc = { type: 'FeatureCollection' as const, features: res.features };
        const src = map.getSource(SOURCE_VESSELS);
        if (src && typeof src.setData === 'function') src.setData(fc as never);
        // Clear density layer when zooming in.
        const dsrc = map.getSource(SOURCE_DENSITY);
        if (dsrc && typeof dsrc.setData === 'function') dsrc.setData(EMPTY_FC as never);
        return;
      }

      // Density mode. h3Resolution is forwarded for Phase 2 forward-compat;
      // server picks the schema and tells us via cellSchema in the response.
      const h3Resolution = zoom <= 2 ? 3 : zoom <= 4 ? 4 : zoom <= 6 ? 5 : 6;
      const res = await aismarineGetVesselDensityTile({
        bbox,
        h3Resolution,
        windowMinutes: 60,
      });
      if (res.cellSchema === 'h3_r6') await ensureH3();
      const features = densityCellsToFeatures(res.cells, res.cellSchema, cellToBoundaryFn);
      const fc = { type: 'FeatureCollection' as const, features };
      const dsrc = map.getSource(SOURCE_DENSITY);
      if (dsrc && typeof dsrc.setData === 'function') dsrc.setData(fc as never);
      // Clear vessel circles when zoomed out.
      const vsrc = map.getSource(SOURCE_VESSELS);
      if (vsrc && typeof vsrc.setData === 'function') vsrc.setData(EMPTY_FC as never);
    } finally {
      pending = false;
    }
  };

  // Subscribe to map events.
  const onMoveend = (map as unknown as {
    on?: (event: string, handler: () => void) => void;
  }).on;
  if (typeof onMoveend === 'function') {
    onMoveend.call(map, 'moveend', refresh);
  }
  // Initial paint.
  void refresh();

  const setTrackData = (fc: unknown) => {
    const tsrc = map.getSource(SOURCE_TRACK);
    if (tsrc && typeof tsrc.setData === 'function') tsrc.setData(fc as never);
  };
  const showTrack = (points: Array<[number, number]>) => {
    if (!Array.isArray(points) || points.length < 2) {
      setTrackData(EMPTY_FC);
      return;
    }
    setTrackData({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: points },
        properties: {},
      }],
    });
  };
  const clearTrack = () => setTrackData(EMPTY_FC);

  const setSelectedData = (fc: unknown) => {
    const ssrc = map.getSource(SOURCE_SELECTED);
    if (ssrc && typeof ssrc.setData === 'function') ssrc.setData(fc as never);
  };
  const selectVessel = (lonLat: [number, number]) => {
    if (!Array.isArray(lonLat) || lonLat.length !== 2) {
      setSelectedData(EMPTY_FC);
      return;
    }
    setSelectedData({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: lonLat },
        properties: {},
      }],
    });
  };
  const clearSelection = () => setSelectedData(EMPTY_FC);

  const setVisible = (visible: boolean) => {
    const v = visible ? 'visible' : 'none';
    const setLayoutFn = (map as unknown as {
      setLayoutProperty?: (id: string, name: string, value: unknown) => void;
    }).setLayoutProperty;
    if (typeof setLayoutFn !== 'function') return;
    for (const layer of [LAYER_VESSELS, LAYER_VESSELS_HIT, LAYER_DENSITY, LAYER_TRACK, LAYER_SELECTED_RING, LAYER_SELECTED_DOT]) {
      try { setLayoutFn.call(map, layer, 'visibility', v); } catch {}
    }
  };

  return {
    destroy: () => {
      try { map.removeLayer(LAYER_SELECTED_DOT); } catch {}
      try { map.removeLayer(LAYER_SELECTED_RING); } catch {}
      try { map.removeLayer(LAYER_TRACK); } catch {}
      try { map.removeLayer(LAYER_VESSELS_HIT); } catch {}
      try { map.removeLayer(LAYER_VESSELS); } catch {}
      try { map.removeLayer(LAYER_DENSITY); } catch {}
      try { (map as unknown as { removeSource?: (id: string) => void }).removeSource?.(SOURCE_SELECTED); } catch {}
      try { (map as unknown as { removeSource?: (id: string) => void }).removeSource?.(SOURCE_TRACK); } catch {}
      try { (map as unknown as { removeSource?: (id: string) => void }).removeSource?.(SOURCE_VESSELS); } catch {}
      try { (map as unknown as { removeSource?: (id: string) => void }).removeSource?.(SOURCE_DENSITY); } catch {}
    },
    showTrack,
    clearTrack,
    selectVessel,
    clearSelection,
    setVisible,
  };
}

function densityCellsToFeatures(
  cells: VesselDensityCell[],
  schema: VesselDensityCellSchema,
  cellToBoundary: ((h3: string, geoJson?: boolean) => number[][]) | null,
): unknown[] {
  if (cells.length === 0) return [];

  // Phase 1: 0.1° lat/lon grid → axis-aligned rectangles. lat_bin/lon_bin are
  // the south-west corner; +0.1° in each direction gives the cell.
  if (schema === 'grid_0p1deg') {
    const features: unknown[] = [];
    for (const c of cells) {
      if (typeof c.lat_bin !== 'number' || typeof c.lon_bin !== 'number') continue;
      const w = c.lon_bin;
      const s = c.lat_bin;
      const e = w + 0.1;
      const n = s + 0.1;
      features.push({
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
        },
        properties: {
          cell_id: c.cell_id,
          vessel_count: c.vessel_count,
          hit_count: c.hit_count,
          byClass: c.byClass,
        },
      });
    }
    return features;
  }

  // Phase 2: H3 hex polygons via h3-js cellToBoundary.
  if (schema === 'h3_r6') {
    if (!cellToBoundary) return [];
    const features: unknown[] = [];
    for (const c of cells) {
      let ring: number[][];
      try {
        ring = cellToBoundary(c.cell_id, true);
      } catch {
        continue;
      }
      if (!Array.isArray(ring) || ring.length < 3) continue;
      const closed = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
        ? ring
        : [...ring, ring[0]];
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [closed] },
        properties: {
          cell_id: c.cell_id,
          vessel_count: c.vessel_count,
          hit_count: c.hit_count,
          byClass: c.byClass,
        },
      });
    }
    return features;
  }

  return [];
}

export { TYPE_CLASS_COLOR, MIN_ZOOM_VESSELS, colorFor };
