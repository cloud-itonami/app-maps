/**
 * kami-openmaptiles-style
 * ------------------------
 * Registers the OpenMapTiles-schema → kami layer set on a KamiMapBridge.
 *
 * Source: one vector tileset served by maps-tile-server-t1l3srv0
 *   (https://tiles-maps.etzhayyim.com/v1/{z}/{x}/{y}.pbf)
 *
 * kami-bridge.realizeVectorLayer() fetches tiles from `src.tiles[]` and
 * dispatches to kami-map WASM's decode_mvt_layer(z, x, y, source-layer, pbf)
 * — which already speaks standard MVT (TLV + zigzag). We just declare which
 * OpenMapTiles source-layers to render and with what paint.
 *
 * Colour table matches the tile-server's /v1/style.json so native MapLibre
 * clients and kami render consistently.
 *
 * Usage (from App.svelte, once parent agent wires it up):
 *   import { applyOpenMapTilesStyle } from "$lib/kami-openmaptiles-style";
 *   applyOpenMapTilesStyle(map, cfg.mapTileUrl);
 */

import type { KamiMapBridge, LayerSpec } from './kami-bridge';

const SOURCE_ID = 'openmaptiles';

/** Per-layer spec. `filter` is evaluated per-feature inside kami-bridge.ts. */
interface OMTLayer {
  id: string;
  type: 'fill' | 'line' | 'circle';
  sourceLayer: string;
  paint: Record<string, unknown>;
  minzoom?: number;
  maxzoom?: number;
  filter?: unknown[];
}

const OMT_LAYERS: OMTLayer[] = [
  // ── water ──────────────────────────────────────────────────────────────────
  {
    id: 'omt-water',
    type: 'fill',
    sourceLayer: 'water',
    paint: { 'fill-color': '#a0c8e0', 'fill-opacity': 1.0 },
    minzoom: 0,
  },

  // ── landuse / landcover ────────────────────────────────────────────────────
  {
    id: 'omt-landcover',
    type: 'fill',
    sourceLayer: 'landcover',
    paint: { 'fill-color': '#dbe7c9', 'fill-opacity': 0.85 },
    minzoom: 0,
  },
  {
    id: 'omt-park',
    type: 'fill',
    sourceLayer: 'landuse',
    paint: { 'fill-color': '#cfe6bf', 'fill-opacity': 0.95 },
    minzoom: 7,
    filter: ['==', 'class', 'park'],
  },
  {
    id: 'omt-developed',
    type: 'fill',
    sourceLayer: 'landuse',
    paint: { 'fill-color': '#d9d0c1', 'fill-opacity': 0.38 },
    minzoom: 5,
    filter: ['in', 'class', 'residential', 'industrial', 'commercial'],
  },

  // ── transportation ─────────────────────────────────────────────────────────
  {
    id: 'omt-road-major',
    type: 'line',
    sourceLayer: 'transportation',
    paint: { 'line-color': '#d28f4a', 'line-width': 3.2 },
    minzoom: 6,
    filter: ['in', 'class', 'motorway', 'trunk', 'primary'],
  },
  {
    id: 'omt-road-minor',
    type: 'line',
    sourceLayer: 'transportation',
    paint: { 'line-color': '#efe3c8', 'line-width': 1.6 },
    minzoom: 9,
    filter: ['in', 'class', 'secondary', 'tertiary', 'minor', 'service'],
  },
  {
    id: 'omt-rail',
    type: 'line',
    sourceLayer: 'transportation',
    paint: { 'line-color': '#7d6f6f', 'line-width': 1.2 },
    minzoom: 8,
    filter: ['in', 'class', 'rail', 'transit'],
  },

  // ── buildings ──────────────────────────────────────────────────────────────
  {
    id: 'omt-building',
    type: 'fill',
    sourceLayer: 'building',
    paint: { 'fill-color': '#d0c8b8', 'fill-opacity': 0.9 },
    minzoom: 13,
  },

  // ── boundaries ─────────────────────────────────────────────────────────────
  {
    id: 'omt-boundary',
    type: 'line',
    sourceLayer: 'boundary',
    paint: { 'line-color': '#777777', 'line-width': 1 },
    minzoom: 3,
  },
];

/**
 * Register the OpenMapTiles-schema source + layer set on a KamiMapBridge.
 *
 * @param map           KamiMapBridge instance
 * @param tileTemplate  tile URL template, e.g.
 *                      "https://tiles-maps.etzhayyim.com/v1/{z}/{x}/{y}.pbf"
 */
export function applyOpenMapTilesStyle(
  map: KamiMapBridge,
  tileTemplate: string,
): void {
  if (!tileTemplate || typeof tileTemplate !== 'string') {
    console.warn('kami-openmaptiles-style: tileTemplate is required');
    return;
  }

  // One vector source feeds all layers.
  map.addSource(SOURCE_ID, {
    type: 'vector',
    tiles: [tileTemplate],
    minzoom: 0,
    maxzoom: 14,
  } as never);

  for (const layer of OMT_LAYERS) {
    const spec: LayerSpec = {
      id: layer.id,
      type: layer.type,
      source: SOURCE_ID,
      'source-layer': layer.sourceLayer,
      paint: layer.paint,
    };
    if (typeof layer.minzoom === 'number') spec.minzoom = layer.minzoom;
    if (typeof layer.maxzoom === 'number') spec.maxzoom = layer.maxzoom;
    if (layer.filter) spec.filter = layer.filter;
    map.addLayer(spec);
  }
}

/**
 * Reverse: remove all OMT layers + the source. Useful when swapping the
 * active tile provider at runtime.
 */
export function removeOpenMapTilesStyle(map: KamiMapBridge): void {
  for (const layer of OMT_LAYERS) {
    try {
      map.removeLayer(layer.id);
    } catch {
      // ignore — layer may not exist
    }
  }
  try {
    map.removeSource(SOURCE_ID);
  } catch {
    // ignore
  }
}

/** Exported for tests / docs parity with tile-server /v1/style.json. */
export const OPENMAPTILES_LAYERS: ReadonlyArray<OMTLayer> = OMT_LAYERS;
