export type GeoJsonGeom =
  | { type: "Point"; coordinates: [number, number] }
  | { type: "LineString"; coordinates: [number, number][] }
  | { type: "MultiLineString"; coordinates: [number, number][][] }
  | { type: "Polygon"; coordinates: [number, number][][] }
  | { type: "MultiPolygon"; coordinates: [number, number][][][] };

export type AnyRow = Record<string, unknown>;

export function parseProps(props: unknown): Record<string, unknown> {
  if (!props) return {};
  if (typeof props === "object" && !Array.isArray(props)) {
    return props as Record<string, unknown>;
  }
  if (typeof props !== "string" || props.length === 0) return {};
  try {
    const parsed = JSON.parse(props) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore malformed props payloads.
  }
  return {};
}

export function extractGeomFromRow(row: AnyRow): GeoJsonGeom | null {
  const props = parseProps(row.props);
  let g = (props as { geometry?: unknown; geom?: unknown }).geometry
    ?? (props as { geom?: unknown }).geom;
  if (typeof g === "string" && g.trim() !== "") {
    try {
      g = JSON.parse(g) as unknown;
    } catch {
      g = null;
    }
  }
  if (g && typeof g === "object" && typeof (g as { type?: unknown }).type === "string"
    && Array.isArray((g as { coordinates?: unknown }).coordinates)) {
    return g as GeoJsonGeom;
  }
  const lat = Number(row.lat);
  const lng = Number(row.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return { type: "Point", coordinates: [lng, lat] };
  }
  return null;
}
