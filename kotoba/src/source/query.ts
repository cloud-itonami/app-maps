/**
 * Query: MST scan via @etzhayyim/sdk.read() over com.etzhayyim.maps.source.
 *
 * Replaces the RW query path (`createKyselyDb(...).selectFrom("vertex_maps_source")...`)
 * with a direct PDS read. Sources use rkey == slug so:
 *
 *   prefix "registry-"  → all registry-* sources (12 records)
 *   rkey   "geocode"    → exact source
 *
 * Category-level scans (`--category=registry`) post-filter the response
 * after a prefix scan — there's no second index. Acceptable: 24 total
 * records, full-scan is cheap.
 *
 * Usage:
 *   pnpm tsx src/query.ts                       # all sources
 *   pnpm tsx src/query.ts --slug=geocode        # exact lookup
 *   pnpm tsx src/query.ts --prefix=registry-    # all registry-* sources
 *   pnpm tsx src/query.ts --category=satellite  # post-filter by category
 */

import { Etzhayyim } from "@etzhayyim/sdk";
import type { MapsSource } from "./types.js";

const COLLECTION = "com.etzhayyim.maps.source";

const e = new Etzhayyim({
  did: process.env.ETZ_READER_DID ?? "did:web:maps.etzhayyim.com",
  pdsUrl: process.env.ETZ_PDS_URL ?? "https://pds.etzhayyim.com",
  ipfsGateway: process.env.ETZ_IPFS_GATEWAY ?? "https://ipfs.etzhayyim.com",
  l2RpcUrl: process.env.ETZ_L2_RPC_URL ?? "https://mainnet.base.org",
});

interface Args {
  prefix?: string;
  slug?: string;
  category?: string;
  status?: string;
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

  if (args.slug) {
    const { records } = await e.read<MapsSource>({
      collection: COLLECTION,
      rkey: args.slug,
      fetchBlobs: false,
    });
    console.log(JSON.stringify(records[0] ?? null, null, 2));
    return;
  }

  const prefix = args.prefix ?? "";
  const { records, cursor } = await e.read<MapsSource>({
    collection: COLLECTION,
    prefix,
    limit: args.limit ?? 100,
    fetchBlobs: false,
  });

  const filtered = records.filter((r) => {
    if (args.category && r.value.category !== args.category) return false;
    if (args.status && r.value.status !== args.status) return false;
    return true;
  });

  console.log(
    `[query] prefix=${JSON.stringify(prefix)} category=${args.category ?? "*"} status=${args.status ?? "*"} → ${filtered.length}/${records.length} records`,
  );
  for (const r of filtered) {
    const v = r.value;
    console.log(`  ${v.slug.padEnd(28)}  ${v.status.padEnd(13)}  ${v.did}`);
    console.log(`    ${v.displayName} (${v.externalSource})`);
  }
  if (cursor) console.log(`[query] next cursor: ${cursor}`);
}

const isMainModule =
  import.meta.url.startsWith("file:") &&
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));
if (isMainModule) {
  main().catch((err) => {
    console.error("[query] fatal:", err);
    process.exit(2);
  });
}
