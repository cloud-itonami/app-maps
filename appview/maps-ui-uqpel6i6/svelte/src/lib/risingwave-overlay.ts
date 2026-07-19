/**
 * RisingWave-native vector overlay for KAMI.
 *
 * Replaces the external MVT tile dependency (tiles-maps.etzhayyim.com) with a
 * direct XRPC query to com.etzhayyim.apps.maps.tileGeoJson. On every moveend we
 * fetch per-label GeoJSON for the current viewport bbox and feed it into
 * KAMI's existing GeoJSON layer path (circle/line/fill). No WASM change
 * required.
 *
 * Layer mapping (graph label → KAMI layer type + paint):
 *   AdminArea  → fill   (pale outline)
 *   Coastline  → line   (dark blue)
 *   River      → line   (mid blue)
 *   Road       → line   (amber)
 *   Railway    → line   (gray)
 *   Building   → fill   (warm gray; 3D extrude pending WASM support)
 *   Place      → circle (cyan)
 */
import type { KamiMapBridge } from "./kami-bridge";

type FeatureCollection = {
  type: "FeatureCollection";
  features: unknown[];
};

type LayerDef = {
  label: string;
  type: "fill" | "line" | "circle";
  paint: Record<string, unknown>;
  minzoom?: number;
};

const LAYERS: LayerDef[] = [
  { label: "AdminArea", type: "fill",   paint: { "fill-color": "#1f2937", "fill-opacity": 0.12 }, minzoom: 3 },
  { label: "Coastline", type: "line",   paint: { "line-color": "#1e3a8a", "line-width": 1.2 },    minzoom: 2 },
  { label: "River",     type: "line",   paint: { "line-color": "#2563eb", "line-width": 1.0 },    minzoom: 6 },
  { label: "Road",      type: "line",   paint: { "line-color": "#f59e0b", "line-width": 1.4 },    minzoom: 10 },
  { label: "Railway",   type: "line",   paint: { "line-color": "#9ca3af", "line-width": 1.0 },    minzoom: 10 },
  // Building is handled separately as a 3D extrusion layer (see extrudeBuildings below).
  { label: "Place",     type: "circle", paint: { "circle-color": "#22d3ee", "circle-radius": 3 }, minzoom: 8 },
];

// "500km 以下は全て 3D" — any viewport whose diagonal is shorter than this
// activates 3D extrusion for all supported labels. Above this, the map falls
// back to flat 2D overlay so we don't spam the graph with country-scale queries.
const THREED_MAX_DIAGONAL_KM = 500;

/** Labels that render as 3D extrusion when the viewport is small enough, with
 *  their default world-space height (used when the row has no explicit height). */
const EXTRUDE_LABELS: Array<{ label: string; layerId: string; color: string; opacity: number; defaultHeight: number }> = [
  { label: "Building", layerId: "rw-layer-Building-3d", color: "#78716c", opacity: 0.9,  defaultHeight: 9 },
  { label: "Mountain", layerId: "rw-layer-Mountain-3d", color: "#6b7280", opacity: 0.75, defaultHeight: 400 },
  { label: "Port",     layerId: "rw-layer-Port-3d",     color: "#64748b", opacity: 0.7,  defaultHeight: 20 },
  { label: "Airport",  layerId: "rw-layer-Airport-3d",  color: "#cbd5e1", opacity: 0.6,  defaultHeight: 6 },
  { label: "Station",  layerId: "rw-layer-Station-3d",  color: "#a1a1aa", opacity: 0.75, defaultHeight: 12 },
  { label: "Building3d", layerId: "rw-layer-Structure-3d", color: "#78716c", opacity: 0.9, defaultHeight: 9 },
];

/** Haversine-ish planar approximation of great-circle distance in km. */
function diagonalKm(sw: { lng: number; lat: number }, ne: { lng: number; lat: number }): number {
  const midLat = (sw.lat + ne.lat) * 0.5 * Math.PI / 180;
  const kmPerDegLat = 110.574;
  const kmPerDegLng = 111.320 * Math.cos(midLat);
  const dx = (ne.lng - sw.lng) * kmPerDegLng;
  const dy = (ne.lat - sw.lat) * kmPerDegLat;
  return Math.hypot(dx, dy);
}

/** Convert extrusion feature properties to world-space height. */
function extractHeight(props: Record<string, unknown> | undefined, defaultHeight: number): number {
  if (!props) return defaultHeight;
  const h = Number((props as { heightM?: unknown; height_m?: unknown }).heightM
    ?? (props as { height_m?: unknown }).height_m);
  if (Number.isFinite(h) && h > 0) return h;
  const lv = Number((props as { levels?: unknown; floors?: unknown }).levels
    ?? (props as { floors?: unknown }).floors);
  if (Number.isFinite(lv) && lv > 0) return lv * 3;
  return defaultHeight;
}

const SOURCE_PREFIX = "rw-";
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

export type XrpcFetch = (nsid: string, params: Record<string, unknown>) => Promise<unknown>;

export function applyRisingWaveOverlay(
  map: KamiMapBridge,
  xrpc: XrpcFetch,
): () => void {
  // Register empty GeoJSON sources + layers up front.
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

  let pending = false;
  let lastKey = "";

  const refresh = async () => {
    if (pending) return;
    pending = true;
    try {
      const vp = map.getViewport();
      const bounds = map.getBounds();
      const sw = bounds.getSouthWest();
      const ne = bounds.getNorthEast();
      const zoom = Math.floor(vp.zoom);
      const visible = LAYERS.filter((l) => (l.minzoom ?? 0) <= zoom).map((l) => l.label);
      if (visible.length === 0) return;
      const key = `${zoom}|${sw.lng.toFixed(3)},${sw.lat.toFixed(3)}|${ne.lng.toFixed(3)},${ne.lat.toFixed(3)}|${visible.join(",")}`;
      if (key === lastKey) return;
      lastKey = key;

      const diagKm = diagonalKm(sw, ne);
      const threeDActive = diagKm <= THREED_MAX_DIAGONAL_KM;
      const labels = [...visible];
      if (threeDActive) {
        for (const e of EXTRUDE_LABELS) {
          if (!labels.includes(e.label)) labels.push(e.label);
        }
      }
      const res = await xrpc("com.etzhayyim.apps.maps.tileGeoJson", {
        west: sw.lng, south: sw.lat, east: ne.lng, north: ne.lat,
        labels, zoom, limit: 1000,
      }) as { layers?: Record<string, FeatureCollection> };
      const layers = res?.layers ?? {};
      for (const l of LAYERS) {
        const srcId = SOURCE_PREFIX + l.label;
        const fc = layers[l.label] ?? EMPTY;
        const src = map.getSource(srcId);
        if (src && typeof src.setData === "function") src.setData(fc as never);
      }

      // ── Multi-label 3D extrusion (WASM-native) ──
      // Viewport < 500 km diagonal → any label with polygon or point geometry
      // is extruded as a 3D mesh using its height_m / levels or a sane default.
      const addExtrude = (map as unknown as {
        addExtrudeLayer?: (id: string, r: [number, number][][], h: number[], c?: string, o?: number) => void;
      }).addExtrudeLayer;
      for (const e of EXTRUDE_LABELS) {
        if (!threeDActive) { try { map.removeLayer(e.layerId); } catch {} continue; }
        const fc = layers[e.label];
        if (!fc || fc.features.length === 0 || typeof addExtrude !== "function") {
          try { map.removeLayer(e.layerId); } catch {}
          continue;
        }
        const rings: [number, number][][] = [];
        const heights: number[] = [];
        for (const f of fc.features as Array<{
          geometry?: { type: string; coordinates: unknown };
          properties?: Record<string, unknown>;
        }>) {
          const g = f.geometry;
          if (!g) continue;
          const h = extractHeight(f.properties, e.defaultHeight);
          if (g.type === "Polygon") {
            const outer = (g.coordinates as [number, number][][])[0];
            if (outer && outer.length >= 3) { rings.push(outer); heights.push(h); }
          } else if (g.type === "MultiPolygon") {
            for (const poly of g.coordinates as [number, number][][][]) {
              const outer = poly[0];
              if (outer && outer.length >= 3) { rings.push(outer); heights.push(h); }
            }
          } else if (g.type === "Point") {
            // Point features get a tiny square footprint so they show as a 3D pin.
            const [lng, lat] = g.coordinates as [number, number];
            const dLng = 0.00015; const dLat = 0.00012;
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
      // Transient graph errors shouldn't block the map; log and retry on next moveend.
      console.warn("rw-overlay: refresh failed", err);
    } finally {
      pending = false;
    }
  };

  const onMove = () => { void refresh(); };
  map.on("moveend", onMove);
  void refresh();

  return () => {
    map.off("moveend", onMove);
    for (const l of LAYERS) {
      try { map.removeLayer(`rw-layer-${l.label}`); } catch { /* ignore */ }
      try { map.removeSource(SOURCE_PREFIX + l.label); } catch { /* ignore */ }
    }
  };
}
