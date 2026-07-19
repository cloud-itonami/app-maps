/**
 * Mirrors the 5 Geo DID Lexicon record shapes:
 *   - com.etzhayyim.maps.region
 *   - com.etzhayyim.maps.geoAlias
 *   - com.etzhayyim.maps.verticalZone
 *   - com.etzhayyim.maps.naturalZone
 *   - com.etzhayyim.maps.layerCoordinator
 *
 * Source lexicons: orgs/etzhayyim/com-etzhayyim-maps/wire/lex/
 */

// ─── Region ──────────────────────────────────────────────────────────

export type AdminLevel =
  | "country"
  | "admin1"
  | "admin2"
  | "admin3"
  | "city"
  | "ward"
  | "village"
  | "zone";

export interface RegionRecord {
  v: 1;
  nanoid: string;
  name: string;
  displayName?: string;
  level: AdminLevel;
  parentDid?: string;
  centerLat?: number;
  centerLng?: number;
  bboxWest?: number;
  bboxSouth?: number;
  bboxEast?: number;
  bboxNorth?: number;
  codes?: Record<string, string>;
  registeredAt: string;
}

/** Canonical DID for a region: did:web:maps.etzhayyim.com:region:{nanoid}. */
export function didForRegion(nanoid: string): string {
  if (!isValidNanoid(nanoid)) {
    throw new Error(`invalid region nanoid: ${nanoid}`);
  }
  return `did:web:maps.etzhayyim.com:region:${nanoid}`;
}

/** Inverse of didForRegion. */
export function nanoidForRegionDid(did: string): string {
  const prefix = "did:web:maps.etzhayyim.com:region:";
  if (!did.startsWith(prefix)) throw new Error(`not a region DID: ${did}`);
  return did.slice(prefix.length);
}

export function isValidNanoid(s: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s) && s.length >= 2 && s.length <= 32;
}

// ─── GeoAlias ────────────────────────────────────────────────────────

export type GeoScheme =
  | "iso3166-1"
  | "iso3166-2"
  | "jis-x0401"
  | "jis-x0402"
  | "fips"
  | "h3"
  | "s2"
  | "geohash"
  | "pluscode"
  | "mgrs"
  | "maidenhead"
  | "utm"
  | "flight-level"
  | "icao-fir"
  | "atmo-layer"
  | "elevation"
  | "depth-band"
  | "infra-depth"
  | "iho-sea"
  | "eez"
  | "bath-zone"
  | "koppen"
  | "wwf-biome"
  | "wwf-ecoregion"
  | "tectonic"
  | "icao-airport"
  | "iata-airport"
  | "unlocode"
  | "iana-tz";

export const GEO_SCHEMES: readonly GeoScheme[] = [
  "iso3166-1",
  "iso3166-2",
  "jis-x0401",
  "jis-x0402",
  "fips",
  "h3",
  "s2",
  "geohash",
  "pluscode",
  "mgrs",
  "maidenhead",
  "utm",
  "flight-level",
  "icao-fir",
  "atmo-layer",
  "elevation",
  "depth-band",
  "infra-depth",
  "iho-sea",
  "eez",
  "bath-zone",
  "koppen",
  "wwf-biome",
  "wwf-ecoregion",
  "tectonic",
  "icao-airport",
  "iata-airport",
  "unlocode",
  "iana-tz",
];

export interface GeoAliasRecord {
  v: 1;
  scheme: GeoScheme;
  code: string;
  aliasKey: string;
  canonicalUri: string;
  canonicalDid?: string;
  registeredAt: string;
}

/** rkey-safe composite: `{scheme}-{code}` with colons → hyphens. */
export function aliasKeyFor(scheme: GeoScheme, code: string): string {
  if (!code) throw new Error(`empty code for scheme ${scheme}`);
  const safe = code.replace(/[:/\s]/g, "-").toLowerCase();
  return `${scheme}-${safe}`;
}

// ─── VerticalZone ────────────────────────────────────────────────────

export type VerticalZoneKind = "atmosphere" | "underground" | "ocean";

export interface VerticalZoneRecord {
  v: 1;
  slug: string;
  kind: VerticalZoneKind;
  name: string;
  minMeters?: number;
  maxMeters?: number;
  description?: string;
  registeredAt: string;
}

// ─── NaturalZone ─────────────────────────────────────────────────────

export type NaturalZoneKind = "koppen" | "biome" | "tectonic";

export interface NaturalZoneRecord {
  v: 1;
  slug: string;
  kind: NaturalZoneKind;
  code: string;
  name: string;
  description?: string;
  registeredAt: string;
}

// ─── LayerCoordinator ────────────────────────────────────────────────

export type LayerSlug =
  | "tile"
  | "poi"
  | "route"
  | "infra"
  | "building"
  | "weather"
  | "sensor"
  | "transport"
  | "geography"
  | "satellite"
  | "event";

export const LAYER_SLUGS: readonly LayerSlug[] = [
  "tile",
  "poi",
  "route",
  "infra",
  "building",
  "weather",
  "sensor",
  "transport",
  "geography",
  "satellite",
  "event",
];

export interface LayerCoordinatorRecord {
  v: 1;
  slug: LayerSlug;
  did: string;
  displayName?: string;
  description?: string;
  registeredAt: string;
}

/** Canonical DID for a KAMI layer: did:web:maps.etzhayyim.com:layer:{slug}. */
export function didForLayer(slug: LayerSlug): string {
  return `did:web:maps.etzhayyim.com:layer:${slug}`;
}
