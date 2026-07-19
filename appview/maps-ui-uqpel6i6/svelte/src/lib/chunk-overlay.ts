/**
 * Forward-topology chunk overlay for KAMI.
 *
// CHARTER-VIOLATION §substrate (centralized DB forbidden — migrate to AT MST + IPFS + Base L2)
 * Replaces the bbox-per-moveend risingwave-overlay with an H3-indexed chunk
 * cache. The client computes `visibleH3Cells` for the current viewport + LOD,
 * fetches only missing cells via `com.etzhayyim.apps.maps.getChunk`, keeps them in
 * an LRU cache keyed by h3Cell (stable across pans), and rebuilds GeoJSON /
 * extrusion layers by unioning cached cell features per label.
 *
 * Design: 90-docs/260417-maps-forward-topology-raw-to-webgpu.md.
 *
 * Shannon win: cell keys are stable → cache hit rate approaches 100% when the
 * user pans within the same LOD. bbox-keyed overlay re-queried on every
 * moveend; chunk-keyed fetches only the strip of new cells entering view.
 */
import { polygonToCells, cellToBoundary } from "h3-js";
import type { KamiMapBridge } from "./kami-bridge";

export type Geom =
  | { type: "Point"; coordinates: [number, number] }
  | { type: "LineString"; coordinates: [number, number][] }
  | { type: "MultiLineString"; coordinates: [number, number][][] }
  | { type: "Polygon"; coordinates: [number, number][][] }
  | { type: "MultiPolygon"; coordinates: [number, number][][][] };
export type Feature = { type: "Feature"; geometry: Geom; properties?: Record<string, unknown> };

/** Zoom → H3 resolution (LOD). Matches design doc table L0-L5. */
function zoomToLod(zoom: number): number {
  if (zoom < 3) return 2;
  if (zoom < 6) return 4;
  if (zoom < 10) return 6;
  if (zoom < 14) return 8;
  if (zoom < 17) return 10;
  return 12;
}

// Hybrid 2D-fill / 3D-extrude layer table. Wide polygons (admin, coastline,
// roads) render as traditional 2D so they are immune to the shader f32
// view-matrix precision collapse that hits extrude meshes at zoom ≥ 10.
// Buildings and other per-POI footprints extrude because they stay local.
type LayerDef = {
  label: string;
  type: "fill" | "line" | "circle";
  paint: Record<string, unknown>;
  minzoom?: number;
  /** Per-zoom fetch cap. Pairs are [zoomFloor, limit] in ascending zoom order;
   *  the first pair whose zoomFloor ≤ current zoom wins. Omitted = uniform
   *  DEFAULT_PER_LABEL_LIMIT. Effect: world-scale requests shrink AdminArea to
   *  a handful per chunk while street-scale Road can fetch thousands. */
  limitByZoom?: Array<[number, number]>;
};

const LAYERS: LayerDef[] = [
  { label: "AdminArea", type: "fill",   paint: { "fill-color": "#1f2937", "fill-opacity": 0.12 }, minzoom: 3,
    limitByZoom: [[3, 40], [6, 200], [10, 800]] },
  { label: "Coastline", type: "line",   paint: { "line-color": "#1e3a8a", "line-width": 1.2 },    minzoom: 2,
    limitByZoom: [[2, 100], [6, 500], [10, 1500]] },
  { label: "River",     type: "line",   paint: { "line-color": "#2563eb", "line-width": 1.0 },    minzoom: 6,
    limitByZoom: [[6, 100], [10, 500], [14, 1500]] },
  { label: "Road",      type: "line",   paint: { "line-color": "#f59e0b", "line-width": 1.4 },    minzoom: 10,
    limitByZoom: [[10, 300], [14, 1500], [17, 3000]] },
  { label: "Railway",   type: "line",   paint: { "line-color": "#9ca3af", "line-width": 1.0 },    minzoom: 10,
    limitByZoom: [[10, 100], [14, 500]] },
  { label: "Place",     type: "circle", paint: { "circle-color": "#22d3ee", "circle-radius": 3 }, minzoom: 13,
    limitByZoom: [[13, 100], [15, 500], [17, 2000]] },
];

const DEFAULT_PER_LABEL_LIMIT = 1000;
function resolveLimit(def: LayerDef | undefined, zoom: number): number {
  if (!def?.limitByZoom) return DEFAULT_PER_LABEL_LIMIT;
  let out = DEFAULT_PER_LABEL_LIMIT;
  for (const [z, lim] of def.limitByZoom) if (z <= zoom) out = lim;
  return out;
}

const EXTRUDE_LABELS: Array<{ label: string; layerId: string; color: string; opacity: number; defaultHeight: number }> = [
  { label: "Building", layerId: "rw-layer-Building-3d", color: "#78716c", opacity: 0.9,  defaultHeight: 9 },
  { label: "Mountain", layerId: "rw-layer-Mountain-3d", color: "#6b7280", opacity: 0.75, defaultHeight: 400 },
  { label: "Port",     layerId: "rw-layer-Port-3d",     color: "#64748b", opacity: 0.7,  defaultHeight: 20 },
  { label: "Airport",  layerId: "rw-layer-Airport-3d",  color: "#cbd5e1", opacity: 0.6,  defaultHeight: 6 },
  { label: "Station",  layerId: "rw-layer-Station-3d",  color: "#a1a1aa", opacity: 0.75, defaultHeight: 12 },
];
const SOURCE_PREFIX = "rw-";
const EMPTY = { type: "FeatureCollection" as const, features: [] as unknown[] };

// Screen-space grid clustering (Option #3). Bucket Point features into
// zoom-scaled grid cells and emit either a single raw feature (count=1) or a
// synthetic cluster feature (count>1) whose coordinate is the mean of the
// bucket. Bucket size is half a degree at zoom 0 and halves each zoom level,
// so it tracks screen pixels roughly. Runs per-refresh, no deps, O(N).
const CLUSTERABLE_POINT_LABELS = new Set(["Place", "Spot", "Airport", "Station", "Port"]);
const CLUSTER_ENABLED_MAX_ZOOM = 14;
function gridSizeDeg(zoom: number): number {
  // 360 / (2^zoom * ~8) ≈ one cluster per 45 screen-pixels at any zoom.
  return 360 / (Math.pow(2, zoom) * 8);
}
function clusterPointFeatures(feats: Feature[], zoom: number): Feature[] {
  if (zoom >= CLUSTER_ENABLED_MAX_ZOOM || feats.length < 8) return feats;
  const step = gridSizeDeg(zoom);
  if (!Number.isFinite(step) || step <= 0) return feats;
  type Bucket = { sumX: number; sumY: number; count: number; sample: Feature };
  const buckets = new Map<string, Bucket>();
  const passthrough: Feature[] = [];
  for (const f of feats) {
    const g = f.geometry;
    if (!g || g.type !== "Point") { passthrough.push(f); continue; }
    const [x, y] = g.coordinates as [number, number];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const gx = Math.floor(x / step), gy = Math.floor(y / step);
    const key = `${gx}|${gy}`;
    const b = buckets.get(key);
    if (b) { b.sumX += x; b.sumY += y; b.count++; }
    else buckets.set(key, { sumX: x, sumY: y, count: 1, sample: f });
  }
  const out: Feature[] = [...passthrough];
  for (const b of buckets.values()) {
    if (b.count === 1) { out.push(b.sample); continue; }
    out.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [b.sumX / b.count, b.sumY / b.count] },
      properties: { cluster: true, point_count: b.count, ...(b.sample.properties ?? {}) },
    });
  }
  return out;
}

const THREED_MAX_DIAGONAL_KM = 500;
const CHUNK_CACHE_SIZE = 1024;
const CELL_REQUEST_BATCH = 64;

function extractHeight(props: Record<string, unknown> | undefined, defaultHeight: number): number {
  if (!props) return defaultHeight;
  const h = Number((props as { heightM?: unknown }).heightM);
  if (Number.isFinite(h) && h > 0) return h;
  const lv = Number((props as { levels?: unknown; floors?: unknown }).levels
    ?? (props as { floors?: unknown }).floors);
  if (Number.isFinite(lv) && lv > 0) return lv * 3;
  return defaultHeight;
}

function diagonalKm(sw: { lng: number; lat: number }, ne: { lng: number; lat: number }): number {
  const midLat = (sw.lat + ne.lat) * 0.5 * Math.PI / 180;
  const kmPerDegLat = 110.574;
  const kmPerDegLng = 111.320 * Math.cos(midLat);
  const dx = (ne.lng - sw.lng) * kmPerDegLng;
  const dy = (ne.lat - sw.lat) * kmPerDegLat;
  return Math.hypot(dx, dy);
}

/** Compute H3 cells covering the viewport. Uses polygonToCells with a ring
 *  buffer slightly larger than the viewport so edge cells don't pop as the
 *  user pans. */
function visibleH3Cells(
  sw: { lng: number; lat: number },
  ne: { lng: number; lat: number },
  lod: number,
  maxCells = 64,
): string[] {
  // Expand by 10% to include border cells.
  const dLng = (ne.lng - sw.lng) * 0.1;
  const dLat = (ne.lat - sw.lat) * 0.1;
  const w = sw.lng - dLng, e = ne.lng + dLng;
  const s = sw.lat - dLat, n = ne.lat + dLat;
  const boundary: [number, number][] = [
    [s, w], [s, e], [n, e], [n, w],
  ];
  let cells: string[];
  try {
    cells = polygonToCells(boundary, lod, false);
  } catch {
    return [];
  }
  if (cells.length <= maxCells) return cells;
  // Too many cells at this LOD — fall back to coarser resolution.
  if (lod <= 2) return cells.slice(0, maxCells);
  return visibleH3Cells(sw, ne, lod - 2, maxCells);
}

/** Typed XRPC fetcher — the caller provides the actual transport. */
export type GetChunkFetch = (
  params: { h3Cells: string[]; lod: number; labels: string[]; limit?: number; limitByLabel?: Record<string, number> },
) => Promise<{ chunks: Record<string, Record<string, Feature[]>>; total: number }>;

interface CachedChunk {
  cellId: string;
  lod: number;
  labels: Record<string, Feature[]>;
  fetchedAt: number;
}

/** Widen a polyline into a rectangular strip (closed ring) so it can be
 *  extruded. `halfWidthDeg` is the perpendicular offset in degrees on each
 *  side of the line. Emits one ring per segment so sharp turns don't
 *  collapse. */
function lineToStrips(
  coords: [number, number][],
  halfWidthDeg: number,
): [number, number][][] {
  const out: [number, number][][] = [];
  for (let i = 0; i + 1 < coords.length; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    // Perpendicular (rotate 90° CCW): (-dy, dx) / len
    const nx = -dy / len;
    const ny = dx / len;
    const ox = nx * halfWidthDeg;
    const oy = ny * halfWidthDeg;
    out.push([
      [a[0] + ox, a[1] + oy],
      [b[0] + ox, b[1] + oy],
      [b[0] - ox, b[1] - oy],
      [a[0] - ox, a[1] - oy],
    ]);
  }
  return out;
}

/** Live debug stats. Attached to window.__chunkStats for the debug HUD. */
export type ChunkStats = {
  lastFetchMs: number;
  totalFetchMs: number;
  fetchCount: number;
  cellsRequested: number;
  cellsCacheHit: number;
  featuresPerLabel: Record<string, number>;
  currentZoom: number;
  currentLod: number;
  currentCells: number;
  cacheSize: number;
  lastRefreshMs: number;
  error?: string;
};

export function applyChunkOverlay(
  map: KamiMapBridge,
  fetchChunk: GetChunkFetch,
): () => void {
  const stats: ChunkStats = {
    lastFetchMs: 0, totalFetchMs: 0, fetchCount: 0,
    cellsRequested: 0, cellsCacheHit: 0,
    featuresPerLabel: {}, currentZoom: 0, currentLod: 0, currentCells: 0,
    cacheSize: 0, lastRefreshMs: 0,
  };
  if (typeof window !== "undefined") {
    (window as unknown as { __chunkStats?: ChunkStats }).__chunkStats = stats;
  }
  for (const l of LAYERS) {
    const srcId = SOURCE_PREFIX + l.label;
    map.addSource(srcId, { type: "geojson", data: EMPTY } as never);
    map.addLayer({
      id: `rw-layer-${l.label}`,
      type: l.type,
      source: srcId,
      paint: l.paint,
      ...(l.minzoom != null ? { minzoom: l.minzoom } : {}),
    } as never);
  }

  // LRU cache keyed by `${lod}|${cellId}`. Value = merged labels map.
  const cache = new Map<string, CachedChunk>();
  const inflight = new Map<string, Promise<void>>();
  let pending = false;
  let refreshRequested = false;

  const cacheKey = (lod: number, cell: string) => `${lod}|${cell}`;

  const ensureCells = async (lod: number, cells: string[], labels: string[], zoomHint: number): Promise<void> => {
    const missing = cells.filter((c) => !cache.has(cacheKey(lod, c)));
    if (missing.length === 0) return;
    // Coalesce concurrent fetches for overlapping sets.
    const pendingKeys = missing.map((c) => cacheKey(lod, c));
    const existing = pendingKeys.map((k) => inflight.get(k)).filter(Boolean);
    if (existing.length === pendingKeys.length) {
      await Promise.all(existing as Promise<void>[]);
      return;
    }

    // Batch by CELL_REQUEST_BATCH to stay under the 128-cell lexicon cap.
    const batches: string[][] = [];
    for (let i = 0; i < missing.length; i += CELL_REQUEST_BATCH) {
      batches.push(missing.slice(i, i + CELL_REQUEST_BATCH));
    }
    // Per-label limit derived from the current zoom.
    const limitByLabel: Record<string, number> = {};
    for (const label of labels) {
      const def = LAYERS.find((l) => l.label === label);
      limitByLabel[label] = resolveLimit(def, zoomHint);
    }
    const maxLabelLimit = Math.max(DEFAULT_PER_LABEL_LIMIT, ...Object.values(limitByLabel));
    for (const batch of batches) {
      const promise = (async () => {
        const t0 = performance.now();
        try {
          const res = await fetchChunk({ h3Cells: batch, lod, labels, limit: maxLabelLimit, limitByLabel });
          const ms = performance.now() - t0;
          stats.lastFetchMs = ms;
          stats.totalFetchMs += ms;
          stats.fetchCount++;
          stats.cellsRequested += batch.length;
          const now = Date.now();
          for (const cell of batch) {
            const chunkLabels = res.chunks[cell] ?? {};
            cache.set(cacheKey(lod, cell), { cellId: cell, lod, labels: chunkLabels, fetchedAt: now });
          }
        } catch (err) {
          console.warn("chunk-overlay: fetch failed", err);
        }
        // LRU eviction
        while (cache.size > CHUNK_CACHE_SIZE) {
          const oldest = cache.keys().next().value as string | undefined;
          if (!oldest) break;
          cache.delete(oldest);
        }
      })();
      for (const key of batch.map((c) => cacheKey(lod, c))) {
        inflight.set(key, promise);
      }
      await promise;
      for (const key of batch.map((c) => cacheKey(lod, c))) {
        inflight.delete(key);
      }
    }
  };

  /** Gather all features for a label across the given cells. */
  const unionLabel = (lod: number, cells: string[], label: string): Feature[] => {
    const out: Feature[] = [];
    for (const cell of cells) {
      const c = cache.get(cacheKey(lod, cell));
      if (!c) continue;
      const feats = c.labels[label];
      if (feats) out.push(...feats);
    }
    return out;
  };

  const addExtrude = (map as unknown as {
    addExtrudeLayer?: (id: string, r: [number, number][][], h: number[], c?: string, o?: number) => void;
  }).addExtrudeLayer;

  const refresh = async () => {
    if (pending) {
      refreshRequested = true;
      return;
    }
    pending = true;
    const tRefresh = performance.now();
    try {
      const vp = map.getViewport();
      const bounds = map.getBounds();
      const sw = bounds.getSouthWest();
      const ne = bounds.getNorthEast();
      const zoom = Math.floor(vp.zoom);
      const lod = zoomToLod(zoom);
      const diagKm = diagonalKm(sw, ne);
      const threeDActive = diagKm <= THREED_MAX_DIAGONAL_KM;

      const visible2d = LAYERS.filter((l) => (l.minzoom ?? 0) <= zoom).map((l) => l.label);
      const visible3d = threeDActive ? EXTRUDE_LABELS.map((e) => e.label) : [];
      const allLabels = [...new Set([...visible2d, ...visible3d])];
      if (allLabels.length === 0) return;

      const cells = visibleH3Cells(sw, ne, lod);
      if (cells.length === 0) return;
      stats.currentZoom = zoom;
      stats.currentLod = lod;
      stats.currentCells = cells.length;
      stats.cellsCacheHit = cells.filter((c) => cache.has(cacheKey(lod, c))).length;
      await ensureCells(lod, cells, allLabels, zoom);

      const perLabel: Record<string, number> = {};
      for (const l of LAYERS) {
        const srcId = SOURCE_PREFIX + l.label;
        let feats = unionLabel(lod, cells, l.label);
        // Declutter: collapse dense Point clouds into grid clusters at
        // low/mid zoom so we ship one cluster marker per screen cell
        // instead of a carpet of overlapping dots.
        if (CLUSTERABLE_POINT_LABELS.has(l.label)) {
          feats = clusterPointFeatures(feats, zoom);
        }
        perLabel[l.label] = feats.length;
        const fc = { type: "FeatureCollection" as const, features: feats };
        const src = map.getSource(srcId);
        if (src && typeof src.setData === "function") src.setData(fc as never);
      }
      stats.featuresPerLabel = perLabel;
      stats.cacheSize = cache.size;
      stats.lastRefreshMs = performance.now() - tRefresh;

      for (const e of EXTRUDE_LABELS) {
        if (!threeDActive || typeof addExtrude !== "function") {
          try { map.removeLayer(e.layerId); } catch {}
          continue;
        }
        const feats = unionLabel(lod, cells, e.label);
        if (feats.length === 0) {
          try { map.removeLayer(e.layerId); } catch {}
          continue;
        }
        const rings: [number, number][][] = [];
        const heights: number[] = [];
        for (const f of feats) {
          const g = f.geometry;
          if (!g) continue;
          const h = extractHeight(f.properties, e.defaultHeight);
          if (g.type === "Polygon") {
            const outer = g.coordinates[0];
            if (outer && outer.length >= 3) { rings.push(outer); heights.push(h); }
          } else if (g.type === "MultiPolygon") {
            for (const poly of g.coordinates) {
              const outer = poly[0];
              if (outer && outer.length >= 3) { rings.push(outer); heights.push(h); }
            }
          } else if (g.type === "Point") {
            const [lng, lat] = g.coordinates;
            const dLng = 0.00015, dLat = 0.00012;
            rings.push([
              [lng - dLng, lat - dLat],
              [lng + dLng, lat - dLat],
              [lng + dLng, lat + dLat],
              [lng - dLng, lat + dLat],
            ]);
            heights.push(h);
          }
        }
        if (rings.length > 0) {
          addExtrude.call(map, e.layerId, rings, heights, e.color, e.opacity);
        } else {
          try { map.removeLayer(e.layerId); } catch {}
        }
      }
    } catch (err) {
      console.warn("chunk-overlay: refresh failed", err);
    } finally {
      pending = false;
      if (refreshRequested) {
        refreshRequested = false;
        void refresh();
      }
    }
  };

  const onMove = () => { void refresh(); };
  map.on("moveend", onMove);
  void refresh();

  return () => {
    map.off("moveend", onMove);
    for (const e of EXTRUDE_LABELS) {
      try { map.removeLayer(e.layerId); } catch {}
    }
    cache.clear();
  };
}

// Export for debugging / test.
export { visibleH3Cells, zoomToLod };
