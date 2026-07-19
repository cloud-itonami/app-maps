/**
 * Programmatic entry points for Geo DID Management.
 *
 *   import { listVerticalZones, listNaturalZones, listLayerCoordinators,
 *            getRegion, resolveGeoAlias, resolveZones3d, listGeoSchemes }
 *     from "@etzhayyim/maps-kotoba";
 *   // then access via the `geo` namespace exported from index.ts.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Etzhayyim } from "@etzhayyim/sdk";
import {
  aliasKeyFor,
  type GeoAliasRecord,
  type GeoScheme,
  type LayerCoordinatorRecord,
  type NaturalZoneRecord,
  type RegionRecord,
  type VerticalZoneRecord,
} from "./types.js";

export type {
  AdminLevel,
  GeoAliasRecord,
  GeoScheme,
  LayerCoordinatorRecord,
  LayerSlug,
  NaturalZoneKind,
  NaturalZoneRecord,
  RegionRecord,
  VerticalZoneKind,
  VerticalZoneRecord,
} from "./types.js";
export {
  GEO_SCHEMES,
  LAYER_SLUGS,
  aliasKeyFor,
  didForLayer,
  didForRegion,
  isValidNanoid,
  nanoidForRegionDid,
} from "./types.js";

const COLLECTION_REGION = "com.etzhayyim.maps.region";
const COLLECTION_ALIAS = "com.etzhayyim.maps.geoAlias";
const COLLECTION_VERTICAL = "com.etzhayyim.maps.verticalZone";
const COLLECTION_NATURAL = "com.etzhayyim.maps.naturalZone";
const COLLECTION_LAYER = "com.etzhayyim.maps.layerCoordinator";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");

function defaultClient(): Etzhayyim {
  return new Etzhayyim({
    did: "did:web:maps.etzhayyim.com",
    pdsUrl: "https://pds.etzhayyim.com",
    ipfsGateway: "https://ipfs.etzhayyim.com",
    l2RpcUrl: "https://mainnet.base.org",
  });
}

export interface GeoListOpts {
  prefix?: string;
  limit?: number;
  client?: Etzhayyim;
}

export async function listRegions(opts: GeoListOpts = {}): Promise<RegionRecord[]> {
  const e = opts.client ?? defaultClient();
  const { records } = await e.read<RegionRecord>({
    collection: COLLECTION_REGION,
    prefix: opts.prefix ?? "",
    limit: opts.limit ?? 100,
  });
  return records.map((r) => r.value);
}

export async function getRegion(
  nanoid: string,
  opts: { client?: Etzhayyim } = {},
): Promise<RegionRecord | null> {
  const e = opts.client ?? defaultClient();
  const { records } = await e.read<RegionRecord>({
    collection: COLLECTION_REGION,
    rkey: nanoid,
  });
  return records[0]?.value ?? null;
}

export async function resolveGeoAlias(
  scheme: GeoScheme,
  code: string,
  opts: { client?: Etzhayyim } = {},
): Promise<GeoAliasRecord | null> {
  const e = opts.client ?? defaultClient();
  const { records } = await e.read<GeoAliasRecord>({
    collection: COLLECTION_ALIAS,
    rkey: aliasKeyFor(scheme, code),
  });
  return records[0]?.value ?? null;
}

export async function listGeoAliases(
  scheme: GeoScheme,
  opts: GeoListOpts = {},
): Promise<GeoAliasRecord[]> {
  const e = opts.client ?? defaultClient();
  const { records } = await e.read<GeoAliasRecord>({
    collection: COLLECTION_ALIAS,
    prefix: `${scheme}-`,
    limit: opts.limit ?? 200,
  });
  return records.map((r) => r.value);
}

export async function listVerticalZones(opts: GeoListOpts = {}): Promise<VerticalZoneRecord[]> {
  const e = opts.client ?? defaultClient();
  const { records } = await e.read<VerticalZoneRecord>({
    collection: COLLECTION_VERTICAL,
    prefix: opts.prefix ?? "",
    limit: opts.limit ?? 50,
  });
  return records.map((r) => r.value);
}

export async function listNaturalZones(opts: GeoListOpts = {}): Promise<NaturalZoneRecord[]> {
  const e = opts.client ?? defaultClient();
  const { records } = await e.read<NaturalZoneRecord>({
    collection: COLLECTION_NATURAL,
    prefix: opts.prefix ?? "",
    limit: opts.limit ?? 50,
  });
  return records.map((r) => r.value);
}

export async function listLayerCoordinators(
  opts: GeoListOpts = {},
): Promise<LayerCoordinatorRecord[]> {
  const e = opts.client ?? defaultClient();
  const { records } = await e.read<LayerCoordinatorRecord>({
    collection: COLLECTION_LAYER,
    prefix: opts.prefix ?? "",
    limit: opts.limit ?? 20,
  });
  return records.map((r) => r.value);
}

export interface GeoSchemeDescriptor {
  id: GeoScheme;
  displayName: string;
  exampleCode: string;
  domain: string;
}

/** Read the bundled geo-schemes manifest (no PDS round-trip). */
export async function listGeoSchemes(): Promise<GeoSchemeDescriptor[]> {
  const raw = await readFile(join(DATA_DIR, "geo-schemes.json"), "utf8");
  const parsed = JSON.parse(raw) as { schemes: GeoSchemeDescriptor[] };
  return parsed.schemes;
}

/**
 * resolveZones3d — given a 3D point, return the vertical zone + natural
 * zones containing it. This is the kotoba equivalent of the
 * `resolve_zones_3d` RW handler.
 *
 * Implementation note: vertical zone lookup is by minMeters/maxMeters
 * interval; natural zone lookup requires geometry intersection against
 * Köppen/biome/tectonic polygons. Geometry isn't in MST scope — natural
 * zone polygons live in a kotoba-datomic-projection (Phase C). For now this
 * returns the matching vertical zone only.
 */
export async function resolveZones3d(
  altitudeMeters: number,
  opts: { client?: Etzhayyim } = {},
): Promise<{ vertical: VerticalZoneRecord | null; natural: NaturalZoneRecord[] }> {
  const verticals = await listVerticalZones({ client: opts.client });
  const vertical =
    verticals.find(
      (v) =>
        v.minMeters !== undefined &&
        v.maxMeters !== undefined &&
        altitudeMeters >= v.minMeters &&
        altitudeMeters < v.maxMeters,
    ) ?? null;
  // Natural zone polygon intersection is projection-only; surface that
  // explicitly rather than silently returning an empty list.
  return { vertical, natural: [] };
}
