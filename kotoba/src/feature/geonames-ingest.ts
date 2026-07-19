/**
 * GeoNames TSV → com.etzhayyim.maps.feature bulk ingest.
 *
 * Sibling of `registry/wikidata-ingest.ts` for the spatial-feature
 * registry. Connects the Phase 1 Tier A source DID
 * `did:web:maps.etzhayyim.com:registry:geonames:bulk` to the Phase 3
 * Tier B `registerFeature` path. The TSV row → FeatureRecord transform
 * is pure (testable without I/O); the bulk helper composes it with
 * `registerFeature`.
 *
 * Expected row shape (one TSV line, ≥19 tab-separated columns) per the
 * GeoNames dump format (https://download.geonames.org/export/dump/readme.txt):
 *
 *   0  geonameid          (integer id)
 *   1  name               (UTF-8)
 *   2  asciiname
 *   3  alternatenames     ('|' joined)
 *   4  latitude           (signed decimal)
 *   5  longitude          (signed decimal)
 *   6  feature class      (1 char: P/A/T/H/L/R/S/U/V)
 *   7  feature code       (e.g. PPL / ADM1 / PEAK)
 *   8  country code       (ISO 3166-1 alpha-2)
 *   ...
 *   14 population         (integer)
 *
 * Feature class → FeatureLabel mapping (matches geonames_dumper.py's
 * `_FCL_LABEL` so a row maps identically through either the legacy
 * psycopg2 path or this kotoba path):
 *
 *   P → Place      (populated places)
 *   A → AdminArea  (admin boundaries)
 *   T → Mountain   (peaks, hills, ridges)
 *   H → River      (streams, lakes, sea — Hydrographic)
 *   L → Spot       (parks, areas)
 *   R → Road       (roads, railroads)
 *   S → Building   (spots, buildings, farms)
 *   U → Spot       (underwater)
 *   V → Spot       (forest, heath)
 *
 * Operator workflow (per e7m-dataset/README.md):
 *
 *   e7m-dataset pull geonames --dataset cities1000
 *   # writes datasets-staging/geonames-cities1000-{ts}/cities1000.txt
 *
 *   # Curate + datalad save + publish-ipfs (per ADR-2605241500)
 *
 *   # Then feed cities1000.txt into the bulk ingest:
 *   const text = fs.readFileSync("cities1000.txt", "utf8");
 *   const rows = parseGeoNamesTsv(text);
 *   const stats = await ingestPlacesFromGeoNames(rows, { client });
 */

import {
  pointBbox,
  pointGeometry,
  registerFeature,
  type FeatureLabel,
  type RegisterFeatureClient,
} from "./index.js";

export const GEONAMES_SOURCE_DID = "did:web:maps.etzhayyim.com:registry:geonames:bulk";

// ─── row shape + parsing ─────────────────────────────────────────────

export interface GeoNamesRow {
  geonameid: string;
  name: string;
  asciiname?: string;
  altnames?: string;
  lat: number;
  lng: number;
  fcl: string;
  fcode: string;
  country?: string;
  population?: number;
}

/** Parse one TSV line into a GeoNamesRow. Returns null when the row has
 *  fewer than 19 columns, an unparseable coord, missing id, or
 *  lat=0/lng=0 (which is the GeoNames sentinel for "missing"). */
export function parseGeoNamesLine(line: string): GeoNamesRow | null {
  const fields = line.replace(/\r$/, "").split("\t");
  if (fields.length < 19) return null;
  const geonameid = fields[0]?.trim();
  const name = fields[1]?.trim();
  if (!geonameid || !name) return null;
  const lat = Number(fields[4]);
  const lng = Number(fields[5]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;
  const populationRaw = fields[14]?.trim();
  const population = populationRaw && /^-?\d+$/.test(populationRaw)
    ? Number(populationRaw)
    : undefined;
  return {
    geonameid,
    name: name.slice(0, 200),
    asciiname: fields[2]?.trim() || undefined,
    altnames: fields[3]?.trim() || undefined,
    lat,
    lng,
    fcl: fields[6]?.trim() || "",
    fcode: fields[7]?.trim() || "",
    country: (fields[8]?.trim() || "").slice(0, 8) || undefined,
    population,
  };
}

/** Parse a full TSV text (skipping blank lines). */
export function parseGeoNamesTsv(text: string): GeoNamesRow[] {
  const out: GeoNamesRow[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    const r = parseGeoNamesLine(raw);
    if (r) out.push(r);
  }
  return out;
}

// ─── feature class → label discriminator ─────────────────────────────

export const FCL_LABEL_MAP: Readonly<Record<string, FeatureLabel>> = {
  P: "Place",
  A: "AdminArea",
  T: "Mountain",
  H: "River",
  L: "Spot",
  R: "Road",
  S: "Building",
  U: "Spot",
  V: "Spot",
};

/** Map a GeoNames feature class to one of the lexicon's FeatureLabel
 *  values. Unknown classes → 'Spot' as a catch-all (matches the legacy
 *  geonames_dumper.py default). */
export function fclToLabel(fcl: string): FeatureLabel {
  return FCL_LABEL_MAP[fcl] ?? "Spot";
}

// ─── converter ───────────────────────────────────────────────────────

export interface GeoNamesConverterOptions {
  /** Override the source DID (default: GEONAMES_SOURCE_DID). */
  sourceDid?: string;
  /** H3 resolution + cell. Caller pre-computes via h3-js because the
   *  kotoba SDK is intentionally h3-binding-agnostic (mirrors the
   *  geonames_dumper.py / `_h3_cell` pattern). */
  h3Resolution?: number;
  /** Caller-supplied h3 lookup. If absent, the converter emits a
   *  placeholder cell `unknown-res{N}` so the record still validates
   *  the lexicon's string-typed `h3Cell` field — same fallback the
   *  Python ingestion uses when h3-py isn't installed. */
  h3Cell?: (lat: number, lng: number, resolution: number) => string;
  /** rkey prefix; default `geonames-`. Final rkey = `${prefix}${geonameid}`. */
  rkeyPrefix?: string;
  /** Override `createdAt`; default `new Date().toISOString()`. */
  createdAt?: string;
}

export interface ConvertedFeature {
  /** registerFeature() input — caller passes this directly. */
  input: Parameters<typeof registerFeature>[0];
  geonameid: string;
  label: FeatureLabel;
}

/** Pure GeoNames row → registerFeature input. Returns null when the row
 *  produces no usable label (caller-defined skip categories). */
export function geonamesRowToFeature(
  row: GeoNamesRow,
  opts: GeoNamesConverterOptions = {},
): ConvertedFeature | null {
  if (!row.fcl) return null;
  const label = fclToLabel(row.fcl);
  const resolution = opts.h3Resolution ?? 8;
  const h3Cell = opts.h3Cell ? opts.h3Cell(row.lat, row.lng, resolution) : `unknown-res${resolution}`;
  const props: Record<string, unknown> = {
    category: `geonames-${row.fcl.toLowerCase() || "other"}`,
    description: `${row.fcode} pop=${row.population ?? 0} cc=${row.country ?? ""}`.slice(0, 500),
  };
  if (row.country !== undefined) props.country = row.country;
  if (row.population !== undefined) props.population = row.population;
  if (row.asciiname && row.asciiname !== row.name) props.asciiname = row.asciiname;
  return {
    geonameid: row.geonameid,
    label,
    input: {
      label,
      geometryGeoJson: pointGeometry(row.lng, row.lat),
      h3Cell,
      h3Resolution: resolution,
      ...pointBbox(row.lng, row.lat),
      name: row.name,
      properties: JSON.stringify(props),
      sourceDid: opts.sourceDid ?? GEONAMES_SOURCE_DID,
      createdAt: opts.createdAt,
      rkey: `${opts.rkeyPrefix ?? "geonames-"}${row.geonameid}`,
    },
  };
}

// ─── bulk ingest ─────────────────────────────────────────────────────

export interface BulkGeoNamesIngestOpts {
  client: RegisterFeatureClient;
  converter?: GeoNamesConverterOptions;
  /** Restrict to specific labels (e.g., ["Place", "Mountain"] for a
   *  cities + peaks ingest). Default: accept all 7. */
  labelFilter?: ReadonlyArray<FeatureLabel>;
  /** Cap total writes (useful when smoke-testing a large dump). */
  maxRecords?: number;
  /** Abort after N failures. Default: never. */
  failFastAfter?: number;
}

export interface BulkGeoNamesIngestStats {
  totalRows: number;
  skippedNoFcl: number;
  skippedLabelFilter: number;
  skippedMaxRecords: number;
  attempted: number;
  ok: number;
  failed: number;
  failures: Array<{ geonameid: string; name: string; error: string }>;
  /** rkey of every successfully written record (one per row). */
  rkeys: string[];
  /** Per-label tally of ok writes. */
  labelCounts: Record<string, number>;
}

export async function ingestPlacesFromGeoNames(
  rows: ReadonlyArray<GeoNamesRow>,
  opts: BulkGeoNamesIngestOpts,
): Promise<BulkGeoNamesIngestStats> {
  const stats: BulkGeoNamesIngestStats = {
    totalRows: rows.length,
    skippedNoFcl: 0,
    skippedLabelFilter: 0,
    skippedMaxRecords: 0,
    attempted: 0,
    ok: 0,
    failed: 0,
    failures: [],
    rkeys: [],
    labelCounts: {},
  };
  const labelFilter = opts.labelFilter && new Set(opts.labelFilter);
  for (const row of rows) {
    const converted = geonamesRowToFeature(row, opts.converter);
    if (!converted) {
      stats.skippedNoFcl += 1;
      continue;
    }
    if (labelFilter && !labelFilter.has(converted.label)) {
      stats.skippedLabelFilter += 1;
      continue;
    }
    if (opts.maxRecords !== undefined && stats.ok + stats.failed >= opts.maxRecords) {
      stats.skippedMaxRecords += 1;
      continue;
    }
    stats.attempted += 1;
    try {
      await registerFeature(converted.input, { client: opts.client });
      stats.ok += 1;
      stats.rkeys.push(converted.input.rkey!);
      stats.labelCounts[converted.label] = (stats.labelCounts[converted.label] ?? 0) + 1;
    } catch (caught) {
      stats.failed += 1;
      stats.failures.push({
        geonameid: converted.geonameid,
        name: converted.input.name ?? row.name,
        error: (caught as Error).message,
      });
      if (opts.failFastAfter !== undefined && stats.failed >= opts.failFastAfter) {
        break;
      }
    }
  }
  return stats;
}
