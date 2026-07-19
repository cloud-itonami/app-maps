/**
 * Seeder: 24 maps source DIDs → AT Records via @etzhayyim/sdk.
 *
 * Replaces the RW seed path (registerSource → vertex_maps_source) with
 * a straight-line PDS write loop. Idempotent: rkey derives from `slug`
 * so re-running is a no-op past the first run. The 24 source entries
 * live in `60-apps/etzhayyim-project-maps/kotoba/data/sources.json`;
 * this seeder reads them, derives the DID via slug→DID mapping, and
 * writes to PDS.
 *
 * Usage:
 *   pnpm tsx src/seed.ts                       # all 24 sources
 *   pnpm tsx src/seed.ts --only=geocode        # one specific source
 *   pnpm tsx src/seed.ts --category=registry   # all registry-* sources
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Etzhayyim } from "@etzhayyim/sdk";
import { didForSlug, isValidTtl, type MapsSource, type MapsSourceCategory, type MapsSourceStatus } from "./types.js";

const COLLECTION = "com.etzhayyim.maps.source";
const REGISTERED_AT_DEFAULT = "2026-05-23T00:00:00Z";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCES_FILE = join(__dirname, "..", "..", "data", "sources.json");

const e = new Etzhayyim({
  did: process.env.ETZ_SEEDER_DID ?? "did:web:maps.etzhayyim.com",
  pdsUrl: process.env.ETZ_PDS_URL ?? "https://pds.etzhayyim.com",
  ipfsApiUrl: process.env.ETZ_IPFS_API_URL,
  l2RpcUrl: process.env.ETZ_L2_RPC_URL ?? "https://mainnet.base.org",
  anchorContract:
    (process.env.ETZ_ANCHOR_CONTRACT as `0x${string}` | undefined) ??
    undefined,
});

interface SourceSeed {
  slug: string;
  did?: string;
  displayName: string;
  externalSource: string;
  ttl: string;
  license?: string;
  category?: MapsSourceCategory;
  status: MapsSourceStatus;
  registeredAt?: string;
  supersedesDid?: string;
  notes?: string;
}

interface SourcesFile {
  sources: SourceSeed[];
}

interface Args {
  sourcesFile?: string;
  only?: string;
  category?: string;
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

export function toMapsSource(src: SourceSeed): MapsSource {
  const did = src.did ?? didForSlug(src.slug);
  if (!isValidTtl(src.ttl)) {
    throw new Error(`invalid ttl for slug ${src.slug}: ${src.ttl}`);
  }
  return {
    v: 1,
    slug: src.slug,
    did,
    displayName: src.displayName,
    externalSource: src.externalSource,
    ttl: src.ttl,
    license: src.license,
    category: src.category,
    status: src.status,
    registeredAt: src.registeredAt ?? REGISTERED_AT_DEFAULT,
    supersedesDid: src.supersedesDid,
    notes: src.notes,
  };
}

async function loadSources(file: string): Promise<SourceSeed[]> {
  const raw = await readFile(file, "utf8");
  const parsed = JSON.parse(raw) as SourcesFile;
  return parsed.sources.slice().sort((a, b) => a.slug.localeCompare(b.slug));
}

async function seedOne(src: SourceSeed): Promise<void> {
  const record = toMapsSource(src);
  await e.write({
    collection: COLLECTION,
    record: record as unknown as Record<string, unknown>,
    rkey: record.slug,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourcesFile = args.sourcesFile ?? DEFAULT_SOURCES_FILE;
  const sources = await loadSources(sourcesFile);
  console.log(`[seed] loaded ${sources.length} maps sources from ${sourcesFile}`);

  const filtered = sources.filter((s) => {
    if (args.only) return s.slug === args.only;
    if (args.category) return s.category === args.category;
    return true;
  });
  if (filtered.length === 0) {
    console.error("[seed] no sources match filter");
    process.exit(1);
  }
  console.log(`[seed] writing ${filtered.length} records (filter: ${JSON.stringify(args)})`);

  let okCount = 0;
  let errCount = 0;
  for (const src of filtered) {
    try {
      await seedOne(src);
      okCount += 1;
    } catch (err) {
      errCount += 1;
      console.error(`[seed] FAILED slug=${src.slug}: ${(err as Error).message}`);
    }
  }
  console.log(`[seed] DONE  ok=${okCount}  err=${errCount}`);
}

const isMainModule =
  import.meta.url.startsWith("file:") &&
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));
if (isMainModule) {
  main().catch((err) => {
    console.error("[seed] fatal:", err);
    process.exit(2);
  });
}
