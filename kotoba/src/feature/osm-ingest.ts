/**
 * OSM GeoJSON → com.etzhayyim.maps.feature bulk ingest.
 *
 * Sibling of `geonames-ingest.ts` for OpenStreetMap. Consumes a GeoJSON
 * FeatureCollection produced by `osmium export -f geojson` (operator-side
 * subprocess against a Geofabrik PBF) — no PBF parsing in TS, which
 * keeps the kotoba SDK free of native dependencies.
 *
 * Operator workflow (per e7m-dataset/README.md):
 *
 *   e7m-dataset pull osm --region japan
 *   # writes datasets-staging/osm-asia-japan-{ts}/asia-japan-latest.osm.pbf
 *
 *   osmium export \
 *     -f geojson \
 *     -c <type-filter.json> \
 *     -o <subdataset>/japan-features.geojson \
 *     <staging>/asia-japan-latest.osm.pbf
 *
 *   # datalad save + e7m-dataset publish-ipfs (ADR-2605241500)
 *
 *   const text = fs.readFileSync("japan-features.geojson", "utf8");
 *   const fc: OsmFeatureCollection = JSON.parse(text);
 *   const stats = await ingestFromOsmGeoJson(fc.features, { client });
 *
 * Tag → FeatureLabel mapping handles the most common OSM kinds. The
 * default is `Spot` (a catch-all) so unmapped features still land in
 * the registry with their geometry intact; the operator can override
 * `tagToLabel` to refine semantics.
 *
 * Source DID: `did:web:maps.etzhayyim.com:registry:osm` (matches the
 * Phase 1 Tier A source registry seed under `data/sources.json`).
 */

import {
  bboxFromDegrees,
  lineStringGeometry,
  pointBbox,
  pointGeometry,
  polygonGeometry,
  registerFeature,
  type FeatureLabel,
  type RegisterFeatureClient,
} from "./index.js";

export const OSM_SOURCE_DID = "did:web:maps.etzhayyim.com:registry:osm";

// ─── GeoJSON shapes (osmium export schema) ──────────────────────────

export interface OsmGeoJsonGeometry {
  type: "Point" | "LineString" | "Polygon" | "MultiPolygon" | "MultiLineString";
  coordinates: unknown;
}

export interface OsmGeoJsonFeature {
  type: "Feature";
  /** osmium-generated id like 'n12345' / 'w67890' / 'r54321' (n=node, w=way, r=relation). */
  id?: string;
  geometry: OsmGeoJsonGeometry;
  properties: Record<string, unknown>;
}

export interface OsmFeatureCollection {
  type: "FeatureCollection";
  features: OsmGeoJsonFeature[];
}

// ─── tag → label discriminator ──────────────────────────────────────

/** Default tag→label mapper. Order matters: first match wins. */
export function defaultTagToLabel(tags: Record<string, unknown>): FeatureLabel | null {
  const t = (k: string): string | undefined =>
    typeof tags[k] === "string" ? (tags[k] as string) : undefined;
  // Administrative boundaries first — admin_level governs nesting.
  if (t("boundary") === "administrative") return "AdminArea";
  // Mountain peaks.
  if (t("natural") === "peak" || t("natural") === "volcano") return "Mountain";
  // Rivers + waterways.
  const waterway = t("waterway");
  if (waterway === "river" || waterway === "stream") return "River";
  if (waterway && waterway !== "river" && waterway !== "stream") return "Waterway";
  if (t("natural") === "water" && t("water") === "lake") return "Lake";
  if (t("natural") === "coastline") return "Coastline";
  // Roads + railways.
  if (t("highway")) return "Road";
  if (t("railway")) return "Railway";
  // Aviation + maritime infrastructure.
  if (t("aeroway") === "aerodrome") return "Airport";
  if (t("harbour") === "yes" || t("seamark:type") === "harbour" || t("landuse") === "port") return "Port";
  // Transit nodes.
  if (t("railway") === "station" || (t("public_transport") === "station" && t("train") === "yes")) return "Station";
  if (
    t("highway") === "bus_stop" ||
    (t("public_transport") === "platform" && t("bus") === "yes")
  ) {
    return "BusStop";
  }
  // Generic amenities.
  if (t("amenity") === "parking") return "Parking";
  if (t("amenity") === "charging_station") return "EvCharger";
  // Buildings + named places.
  if (t("building")) return "Building";
  const place = t("place");
  if (place && ["city", "town", "village", "hamlet", "suburb", "neighbourhood"].includes(place)) {
    return "Place";
  }
  // EEZ / national waters / IHO seas (rare in osmium output, but covered).
  if (t("boundary") === "maritime") return "MaritimeZone";
  // Fallback: everything else with geometry becomes a Spot.
  if (t("amenity") || t("leisure") || t("tourism") || t("shop") || t("natural")) return "Spot";
  // No useful tags → caller-decides (return null so bulk skip-counts it).
  return null;
}

// ─── id helpers ─────────────────────────────────────────────────────

/** Build an rkey from an osmium feature id like 'n12345' / 'w67890' / 'r54321'.
 *  Returns `osm-n12345`. Falls back to TID when caller passed undefined. */
export function rkeyFromOsmId(osmId: string | undefined, prefix = "osm-"): string | undefined {
  if (!osmId || !/^[nwr]\d+$/.test(osmId)) return undefined;
  return `${prefix}${osmId}`;
}

// ─── converter ───────────────────────────────────────────────────────

export interface OsmConverterOptions {
  sourceDid?: string;
  /** Override the tag mapper (e.g., to add `boundary=protected_area → Spot`). */
  tagToLabel?: (tags: Record<string, unknown>) => FeatureLabel | null;
  /** H3 resolution + lookup. Defaults to `unknown-res{N}` placeholder. */
  h3Resolution?: number;
  h3Cell?: (lat: number, lng: number, resolution: number) => string;
  rkeyPrefix?: string;
  createdAt?: string;
}

export interface ConvertedOsmFeature {
  input: Parameters<typeof registerFeature>[0];
  label: FeatureLabel;
  osmId?: string;
}

/** Stringify geometry. For Polygon / MultiPolygon / etc. we trust the
 *  osmium-emitted GeoJSON and pass it through verbatim. For Point /
 *  LineString we re-serialize via the canonical helpers (which use the
 *  same JSON.stringify; this preserves the rest of the pipeline's
 *  geometry shape contract). */
function serializeGeometry(geom: OsmGeoJsonGeometry): string {
  if (geom.type === "Point") {
    const [lng, lat] = geom.coordinates as [number, number];
    return pointGeometry(lng, lat);
  }
  if (geom.type === "LineString") {
    return lineStringGeometry(geom.coordinates as ReadonlyArray<readonly [number, number]>);
  }
  if (geom.type === "Polygon") {
    return polygonGeometry(geom.coordinates as ReadonlyArray<ReadonlyArray<readonly [number, number]>>);
  }
  // MultiPolygon / MultiLineString / etc. — stringify as-is. The lexicon's
  // geometryGeoJson field accepts any GeoJSON Geometry JSON; downstream
  // consumers parse via JSON.parse.
  return JSON.stringify(geom);
}

/** Compute a bbox from a geometry's coordinates. Returns the
 *  microdegree-encoded bbox object suitable for spreading into the
 *  registerFeature input. */
function geometryBbox(geom: OsmGeoJsonGeometry): {
  bboxWestE7: number;
  bboxSouthE7: number;
  bboxEastE7: number;
  bboxNorthE7: number;
} {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  const visit = (coords: unknown): void => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === "number" && typeof coords[1] === "number") {
      const [lng, lat] = coords as [number, number];
      if (lng < west) west = lng;
      if (lng > east) east = lng;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
      return;
    }
    for (const c of coords) visit(c);
  };
  visit(geom.coordinates);
  if (geom.type === "Point") {
    const [lng, lat] = geom.coordinates as [number, number];
    return pointBbox(lng, lat);
  }
  if (!Number.isFinite(west)) {
    // Degenerate / empty geometry — emit zero bbox so the lexicon
    // schema check still passes (record otherwise rejected with
    // "partial bbox" error).
    return { bboxWestE7: 0, bboxSouthE7: 0, bboxEastE7: 0, bboxNorthE7: 0 };
  }
  return bboxFromDegrees(west, south, east, north);
}

/** Representative-point center for h3 / displayName lookup. */
function representativeLngLat(geom: OsmGeoJsonGeometry): { lng: number; lat: number } | null {
  if (geom.type === "Point") {
    const [lng, lat] = geom.coordinates as [number, number];
    return { lng, lat };
  }
  // Use the geometry's centroid as a coarse representative — works for
  // h3 lookup at the resolution we care about (≤12). True centroid
  // computation is overkill for the kotoba path.
  const bbox = geometryBbox(geom);
  if (bbox.bboxWestE7 === 0 && bbox.bboxEastE7 === 0 && bbox.bboxSouthE7 === 0 && bbox.bboxNorthE7 === 0) {
    return null;
  }
  return {
    lng: (bbox.bboxWestE7 + bbox.bboxEastE7) / 2 / 1e7,
    lat: (bbox.bboxSouthE7 + bbox.bboxNorthE7) / 2 / 1e7,
  };
}

export function osmFeatureToRegisterInput(
  feature: OsmGeoJsonFeature,
  opts: OsmConverterOptions = {},
): ConvertedOsmFeature | null {
  const tagMapper = opts.tagToLabel ?? defaultTagToLabel;
  const label = tagMapper(feature.properties);
  if (!label) return null;

  const resolution = opts.h3Resolution ?? 8;
  const center = representativeLngLat(feature.geometry);
  const h3Cell =
    opts.h3Cell && center
      ? opts.h3Cell(center.lat, center.lng, resolution)
      : `unknown-res${resolution}`;

  // Properties JSON encoding — pass through the OSM tags as-is (the
  // lexicon field is a free-form JSON string).
  const props: Record<string, unknown> = { ...feature.properties };
  // Promote common ID fields to top-level for downstream filtering.
  if (feature.id) props.osmId = feature.id;

  return {
    label,
    osmId: feature.id,
    input: {
      label,
      geometryGeoJson: serializeGeometry(feature.geometry),
      h3Cell,
      h3Resolution: resolution,
      ...geometryBbox(feature.geometry),
      name:
        (typeof feature.properties.name === "string" && feature.properties.name) ||
        (typeof feature.properties["name:en"] === "string" &&
          (feature.properties["name:en"] as string)) ||
        undefined,
      properties: JSON.stringify(props),
      sourceDid: opts.sourceDid ?? OSM_SOURCE_DID,
      createdAt: opts.createdAt,
      rkey: rkeyFromOsmId(feature.id, opts.rkeyPrefix),
    },
  };
}

// ─── bulk ingest ─────────────────────────────────────────────────────

export interface BulkOsmIngestOpts {
  client: RegisterFeatureClient;
  converter?: OsmConverterOptions;
  /** Restrict to specific labels (e.g., for cities-only or roads-only runs). */
  labelFilter?: ReadonlyArray<FeatureLabel>;
  maxRecords?: number;
  failFastAfter?: number;
}

export interface BulkOsmIngestStats {
  totalFeatures: number;
  skippedNoLabel: number;
  skippedLabelFilter: number;
  skippedMaxRecords: number;
  attempted: number;
  ok: number;
  failed: number;
  failures: Array<{ osmId?: string; label?: FeatureLabel; error: string }>;
  labelCounts: Record<string, number>;
}

export async function ingestFromOsmGeoJson(
  features: ReadonlyArray<OsmGeoJsonFeature>,
  opts: BulkOsmIngestOpts,
): Promise<BulkOsmIngestStats> {
  const stats: BulkOsmIngestStats = {
    totalFeatures: features.length,
    skippedNoLabel: 0,
    skippedLabelFilter: 0,
    skippedMaxRecords: 0,
    attempted: 0,
    ok: 0,
    failed: 0,
    failures: [],
    labelCounts: {},
  };
  const labelFilter = opts.labelFilter && new Set(opts.labelFilter);
  for (const f of features) {
    const conv = osmFeatureToRegisterInput(f, opts.converter);
    if (!conv) {
      stats.skippedNoLabel += 1;
      continue;
    }
    if (labelFilter && !labelFilter.has(conv.label)) {
      stats.skippedLabelFilter += 1;
      continue;
    }
    if (opts.maxRecords !== undefined && stats.ok + stats.failed >= opts.maxRecords) {
      stats.skippedMaxRecords += 1;
      continue;
    }
    stats.attempted += 1;
    try {
      await registerFeature(conv.input, { client: opts.client });
      stats.ok += 1;
      stats.labelCounts[conv.label] = (stats.labelCounts[conv.label] ?? 0) + 1;
    } catch (caught) {
      stats.failed += 1;
      stats.failures.push({
        osmId: conv.osmId,
        label: conv.label,
        error: (caught as Error).message,
      });
      if (opts.failFastAfter !== undefined && stats.failed >= opts.failFastAfter) {
        break;
      }
    }
  }
  return stats;
}
