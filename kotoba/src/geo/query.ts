/**
 * Query: read Region / GeoAlias / VerticalZone / NaturalZone / LayerCoordinator
 * via @etzhayyim/sdk.read(). Replaces RW handlers register_region /
 * resolve_geo_alias / list_geo_aliases / list_vertical_zones /
 * list_natural_zones / list_layer_coordinators / resolve_zones_3d /
 * list_geo_schemes from maps app.ts.
 *
 * Usage:
 *   pnpm tsx src/geo/query.ts --kind=vertical
 *   pnpm tsx src/geo/query.ts --kind=natural --filter=koppen
 *   pnpm tsx src/geo/query.ts --kind=layer
 *   pnpm tsx src/geo/query.ts --kind=alias --scheme=iso3166-1 --code=JP
 *   pnpm tsx src/geo/query.ts --kind=region --nanoid=jp
 *   pnpm tsx src/geo/query.ts --kind=schemes
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

const COLLECTION_REGION = "com.etzhayyim.maps.region";
const COLLECTION_ALIAS = "com.etzhayyim.maps.geoAlias";
const COLLECTION_VERTICAL = "com.etzhayyim.maps.verticalZone";
const COLLECTION_NATURAL = "com.etzhayyim.maps.naturalZone";
const COLLECTION_LAYER = "com.etzhayyim.maps.layerCoordinator";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");

const e = new Etzhayyim({
  did: process.env.ETZ_READER_DID ?? "did:web:maps.etzhayyim.com",
  pdsUrl: process.env.ETZ_PDS_URL ?? "https://pds.etzhayyim.com",
  ipfsGateway: process.env.ETZ_IPFS_GATEWAY ?? "https://ipfs.etzhayyim.com",
  l2RpcUrl: process.env.ETZ_L2_RPC_URL ?? "https://mainnet.base.org",
});

interface Args {
  kind?: "region" | "alias" | "vertical" | "natural" | "layer" | "schemes";
  scheme?: GeoScheme;
  code?: string;
  nanoid?: string;
  filter?: string;
  prefix?: string;
  limit?: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (const a of argv) {
    const m = a.match(/^--(\w+)(?:=(.*))?$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k === "limit") out.limit = Number(v);
    else (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const kind = args.kind ?? "schemes";

  if (kind === "schemes") {
    const schemes = JSON.parse(await readFile(join(DATA_DIR, "geo-schemes.json"), "utf8"));
    console.log(`[query:schemes] ${schemes.schemes.length} schemes`);
    for (const s of schemes.schemes) {
      console.log(`  ${s.id.padEnd(16)}  ${s.domain.padEnd(12)}  ${s.displayName}`);
    }
    return;
  }

  if (kind === "region") {
    if (!args.nanoid) {
      const { records } = await e.read<RegionRecord>({
        collection: COLLECTION_REGION,
        prefix: args.prefix ?? "",
        limit: args.limit ?? 100,
      });
      console.log(`[query:region] ${records.length} regions`);
      for (const r of records) console.log(`  ${r.value.nanoid.padEnd(12)}  ${r.value.level.padEnd(8)}  ${r.value.name}`);
      return;
    }
    const { records } = await e.read<RegionRecord>({
      collection: COLLECTION_REGION,
      rkey: args.nanoid,
    });
    console.log(JSON.stringify(records[0] ?? null, null, 2));
    return;
  }

  if (kind === "alias") {
    if (args.scheme && args.code) {
      const aliasKey = aliasKeyFor(args.scheme, args.code);
      const { records } = await e.read<GeoAliasRecord>({
        collection: COLLECTION_ALIAS,
        rkey: aliasKey,
      });
      console.log(JSON.stringify(records[0] ?? null, null, 2));
      return;
    }
    const { records } = await e.read<GeoAliasRecord>({
      collection: COLLECTION_ALIAS,
      prefix: args.scheme ? `${args.scheme}-` : (args.prefix ?? ""),
      limit: args.limit ?? 100,
    });
    console.log(`[query:alias] ${records.length} aliases`);
    for (const r of records) console.log(`  ${r.value.aliasKey.padEnd(24)}  → ${r.value.canonicalUri}`);
    return;
  }

  if (kind === "vertical") {
    const { records } = await e.read<VerticalZoneRecord>({
      collection: COLLECTION_VERTICAL,
      prefix: args.filter ? `${args.filter}-` : "",
      limit: args.limit ?? 50,
    });
    console.log(`[query:vertical] ${records.length} zones`);
    for (const r of records) {
      const v = r.value;
      const range = v.minMeters !== undefined ? ` [${v.minMeters}…${v.maxMeters}m]` : "";
      console.log(`  ${v.slug.padEnd(28)}  ${v.kind.padEnd(12)}  ${v.name}${range}`);
    }
    return;
  }

  if (kind === "natural") {
    const { records } = await e.read<NaturalZoneRecord>({
      collection: COLLECTION_NATURAL,
      prefix: args.filter ? `${args.filter}-` : "",
      limit: args.limit ?? 50,
    });
    console.log(`[query:natural] ${records.length} zones`);
    for (const r of records) {
      const v = r.value;
      console.log(`  ${v.slug.padEnd(32)}  ${v.kind.padEnd(10)}  ${v.code.padEnd(4)}  ${v.name}`);
    }
    return;
  }

  if (kind === "layer") {
    const { records } = await e.read<LayerCoordinatorRecord>({
      collection: COLLECTION_LAYER,
      prefix: "",
      limit: args.limit ?? 20,
    });
    console.log(`[query:layer] ${records.length} coordinators`);
    for (const r of records) {
      const v = r.value;
      console.log(`  ${v.slug.padEnd(12)}  ${v.did}`);
      if (v.displayName) console.log(`    ${v.displayName}`);
    }
    return;
  }

  console.error(`unknown kind: ${kind}`);
  process.exit(1);
}

const isMainModule =
  import.meta.url.startsWith("file:") &&
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));
if (isMainModule) {
  main().catch((err) => {
    console.error("[query:geo] fatal:", err);
    process.exit(2);
  });
}
