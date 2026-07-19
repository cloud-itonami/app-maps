/**
 * Mirrors com.etzhayyim.maps.feature record shape.
 * Source lexicon: orgs/etzhayyim/com-etzhayyim-maps/wire/lex/feature.json
 *
 * This is the Tier B target lexicon: one record per spatial feature, used
 * for Geography Intelligence (spot/river/lake/coastline/mountain/etc.) +
 * Transport infrastructure register-side + Building / Floor / Asset
 * registrations. Discriminated by `label` (Mountain / Building / Road / …).
 *
 * Per kotoba-datomic Phase 3 (Tier B, witnessed writes) — see
 * 60-apps/etzhayyim-project-maps/MIGRATION-TODO.md and ADR-2605231400.
 */

/** A subset of the labels enumerated by the lexicon's `label` description.
 *  Not exhaustive — lexicon accepts any 1-64 char string. This union
 *  captures the common ones for compile-time autocompletion. */
export type FeatureLabel =
  | "Building"
  | "Road"
  | "River"
  | "Place"
  | "AdminArea"
  | "Spot"
  | "Port"
  | "Airport"
  | "Station"
  | "Coastline"
  | "Mountain"
  | "Lake"
  | "Railway"
  | "SeaRoute"
  | "AirRoute"
  | "BusRoute"
  | "BusStop"
  | "Parking"
  | "EvCharger"
  | "MaritimeZone"
  | string;

export interface FeatureRecord {
  /** Feature kind (label). */
  label: FeatureLabel;

  /** GeoJSON Geometry encoded as a JSON string (lexicon disallows nested
   *  float arrays directly). Use `pointGeometry` / `polygonGeometry`
   *  helpers below to produce the canonical form. */
  geometryGeoJson: string;

  /** H3 cell id at the declared resolution. Helpers in geonames port
   *  show the production h3-js / h3-py call. */
  h3Cell: string;

  /** H3 resolution (0-15). 8 ≈ neighborhood, 10 ≈ block, 12 ≈ building. */
  h3Resolution: number;

  bboxWestE7?: number;
  bboxSouthE7?: number;
  bboxEastE7?: number;
  bboxNorthE7?: number;

  name?: string;

  /** Arbitrary feature properties as JSON-encoded string. <16 KB. */
  properties?: string;

  /** Provenance DID. e.g. `did:web:maps.etzhayyim.com:registry:geonames`. */
  sourceDid?: string;

  /** ISO datetime. Required at write-time by callers; defaulted in
   *  `registerFeature` if omitted. */
  createdAt?: string;
}

// ─── geometry helpers ────────────────────────────────────────────────

/** GeoJSON Point as a canonical JSON string (lng, lat order per RFC 7946). */
export function pointGeometry(lng: number, lat: number): string {
  return JSON.stringify({ type: "Point", coordinates: [lng, lat] });
}

/** GeoJSON LineString as a canonical JSON string. Each coord is [lng, lat]. */
export function lineStringGeometry(coords: ReadonlyArray<readonly [number, number]>): string {
  return JSON.stringify({ type: "LineString", coordinates: coords });
}

/** GeoJSON Polygon as a canonical JSON string. Rings are arrays of [lng, lat]. */
export function polygonGeometry(rings: ReadonlyArray<ReadonlyArray<readonly [number, number]>>): string {
  return JSON.stringify({ type: "Polygon", coordinates: rings });
}

/** Microdegree-encoded bbox for a single point — west=east, south=north. */
export function pointBbox(lng: number, lat: number): {
  bboxWestE7: number;
  bboxSouthE7: number;
  bboxEastE7: number;
  bboxNorthE7: number;
} {
  const wE7 = Math.round(lng * 1e7);
  const sE7 = Math.round(lat * 1e7);
  return { bboxWestE7: wE7, bboxSouthE7: sE7, bboxEastE7: wE7, bboxNorthE7: sE7 };
}

/** Microdegree-encoded bbox for a [west, south, east, north] tuple in degrees. */
export function bboxFromDegrees(
  west: number,
  south: number,
  east: number,
  north: number,
): {
  bboxWestE7: number;
  bboxSouthE7: number;
  bboxEastE7: number;
  bboxNorthE7: number;
} {
  return {
    bboxWestE7: Math.round(west * 1e7),
    bboxSouthE7: Math.round(south * 1e7),
    bboxEastE7: Math.round(east * 1e7),
    bboxNorthE7: Math.round(north * 1e7),
  };
}

// ─── validation helpers ─────────────────────────────────────────────

/** Sanity-check a candidate label string against the lexicon constraint
 *  (1-64 chars). Does NOT enforce the FeatureLabel union — the lexicon
 *  accepts any 64-char string by design. */
export function isValidLabel(label: string): boolean {
  return typeof label === "string" && label.length >= 1 && label.length <= 64;
}

/** Sanity-check H3 resolution. */
export function isValidH3Resolution(r: number): boolean {
  return Number.isInteger(r) && r >= 0 && r <= 15;
}

/** Sanity-check that geometryGeoJson is parseable JSON with a `type` field
 *  in the GeoJSON Geometry enum. */
export function isValidGeometryGeoJson(g: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(g);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== "string") return false;
  return [
    "Point",
    "LineString",
    "Polygon",
    "MultiPoint",
    "MultiLineString",
    "MultiPolygon",
    "GeometryCollection",
  ].includes(type);
}
