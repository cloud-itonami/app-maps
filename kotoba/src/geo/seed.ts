/**
 * Seeder: 14 vertical zones + 34 natural zones + 11 layer coordinators → AT Records.
 *
 * Region + GeoAlias records are NOT seeded here — they're produced by the
 * bulk pipeline (Wikidata SPARQL → site pipeline) per maps CLAUDE.md §DID Count.
 * This seeder covers only the constant fixtures.
 *
 * Usage:
 *   pnpm tsx src/geo/seed.ts                              # all three groups
 *   pnpm tsx src/geo/seed.ts --group=vertical             # only vertical zones
 *   pnpm tsx src/geo/seed.ts --group=natural --kind=biome # subset
 *   pnpm tsx src/geo/seed.ts --group=layer
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Etzhayyim } from "@etzhayyim/sdk";
import {
  didForLayer,
  type LayerCoordinatorRecord,
  type LayerSlug,
  type NaturalZoneRecord,
  type NaturalZoneKind,
  type VerticalZoneRecord,
  type VerticalZoneKind,
} from "./types.js";

const COLLECTION_VERTICAL = "com.etzhayyim.maps.verticalZone";
const COLLECTION_NATURAL = "com.etzhayyim.maps.naturalZone";
const COLLECTION_LAYER = "com.etzhayyim.maps.layerCoordinator";
const REGISTERED_AT_DEFAULT = "2026-05-23T00:00:00Z";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");

const e = new Etzhayyim({
  did: process.env.ETZ_SEEDER_DID ?? "did:web:maps.etzhayyim.com",
  pdsUrl: process.env.ETZ_PDS_URL ?? "https://pds.etzhayyim.com",
  ipfsApiUrl: process.env.ETZ_IPFS_API_URL,
  l2RpcUrl: process.env.ETZ_L2_RPC_URL ?? "https://mainnet.base.org",
  anchorContract:
    (process.env.ETZ_ANCHOR_CONTRACT as `0x${string}` | undefined) ??
    undefined,
});

interface VerticalSeed {
  slug: string;
  kind: VerticalZoneKind;
  name: string;
  minMeters?: number;
  maxMeters?: number;
  description?: string;
}

interface NaturalSeed {
  slug: string;
  kind: NaturalZoneKind;
  code: string;
  name: string;
  description?: string;
}

interface LayerSeed {
  slug: LayerSlug;
  displayName?: string;
  description?: string;
}

export function toVerticalZone(src: VerticalSeed): VerticalZoneRecord {
  return {
    v: 1,
    slug: src.slug,
    kind: src.kind,
    name: src.name,
    minMeters: src.minMeters,
    maxMeters: src.maxMeters,
    description: src.description,
    registeredAt: REGISTERED_AT_DEFAULT,
  };
}

export function toNaturalZone(src: NaturalSeed): NaturalZoneRecord {
  return {
    v: 1,
    slug: src.slug,
    kind: src.kind,
    code: src.code,
    name: src.name,
    description: src.description,
    registeredAt: REGISTERED_AT_DEFAULT,
  };
}

export function toLayerCoordinator(src: LayerSeed): LayerCoordinatorRecord {
  return {
    v: 1,
    slug: src.slug,
    did: didForLayer(src.slug),
    displayName: src.displayName,
    description: src.description,
    registeredAt: REGISTERED_AT_DEFAULT,
  };
}

async function loadJson<T>(filename: string): Promise<T> {
  return JSON.parse(await readFile(join(DATA_DIR, filename), "utf8")) as T;
}

interface Args {
  group?: "vertical" | "natural" | "layer";
  kind?: string;
  only?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (const a of argv) {
    const m = a.match(/^--(\w+)(?:=(.*))?$/);
    if (!m) continue;
    const [, k, v] = m;
    (out as Record<string, string | undefined>)[k] = v;
  }
  return out;
}

async function seedVertical(args: Args): Promise<{ ok: number; err: number }> {
  const { zones } = await loadJson<{ zones: VerticalSeed[] }>("vertical-zones.json");
  const filtered = zones.filter((z) => {
    if (args.kind && z.kind !== args.kind) return false;
    if (args.only && z.slug !== args.only) return false;
    return true;
  });
  let ok = 0;
  let err = 0;
  for (const z of filtered) {
    try {
      await e.write({
        collection: COLLECTION_VERTICAL,
        record: toVerticalZone(z) as unknown as Record<string, unknown>,
        rkey: z.slug,
      });
      ok++;
    } catch (caught) {
      err++;
      console.error(`[seed:vertical] FAILED slug=${z.slug}: ${(caught as Error).message}`);
    }
  }
  console.log(`[seed:vertical] ok=${ok} err=${err}`);
  return { ok, err };
}

async function seedNatural(args: Args): Promise<{ ok: number; err: number }> {
  const { zones } = await loadJson<{ zones: NaturalSeed[] }>("natural-zones.json");
  const filtered = zones.filter((z) => {
    if (args.kind && z.kind !== args.kind) return false;
    if (args.only && z.slug !== args.only) return false;
    return true;
  });
  let ok = 0;
  let err = 0;
  for (const z of filtered) {
    try {
      await e.write({
        collection: COLLECTION_NATURAL,
        record: toNaturalZone(z) as unknown as Record<string, unknown>,
        rkey: z.slug,
      });
      ok++;
    } catch (caught) {
      err++;
      console.error(`[seed:natural] FAILED slug=${z.slug}: ${(caught as Error).message}`);
    }
  }
  console.log(`[seed:natural] ok=${ok} err=${err}`);
  return { ok, err };
}

async function seedLayer(args: Args): Promise<{ ok: number; err: number }> {
  const { coordinators } = await loadJson<{ coordinators: LayerSeed[] }>("layer-coordinators.json");
  const filtered = coordinators.filter((c) => {
    if (args.only && c.slug !== args.only) return false;
    return true;
  });
  let ok = 0;
  let err = 0;
  for (const c of filtered) {
    try {
      await e.write({
        collection: COLLECTION_LAYER,
        record: toLayerCoordinator(c) as unknown as Record<string, unknown>,
        rkey: c.slug,
      });
      ok++;
    } catch (caught) {
      err++;
      console.error(`[seed:layer] FAILED slug=${c.slug}: ${(caught as Error).message}`);
    }
  }
  console.log(`[seed:layer] ok=${ok} err=${err}`);
  return { ok, err };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runs: Array<Promise<{ ok: number; err: number }>> = [];
  if (!args.group || args.group === "vertical") runs.push(seedVertical(args));
  if (!args.group || args.group === "natural") runs.push(seedNatural(args));
  if (!args.group || args.group === "layer") runs.push(seedLayer(args));
  const results = await Promise.all(runs);
  const total = results.reduce((acc, r) => ({ ok: acc.ok + r.ok, err: acc.err + r.err }), { ok: 0, err: 0 });
  console.log(`[seed:geo] DONE total ok=${total.ok} err=${total.err}`);
}

const isMainModule =
  import.meta.url.startsWith("file:") &&
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));
if (isMainModule) {
  main().catch((err) => {
    console.error("[seed:geo] fatal:", err);
    process.exit(2);
  });
}
