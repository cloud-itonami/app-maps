/**
 * Query: list / get display layers via @etzhayyim/sdk.read().
 * Replaces RW handlers `display_layer_define` (write) + `list_display_layers` (read).
 *
 * Usage:
 *   pnpm tsx src/display-layer/query.ts                          # all layers
 *   pnpm tsx src/display-layer/query.ts --layerId=tokyo-real-estate
 *   pnpm tsx src/display-layer/query.ts --kind=heatmap           # post-filter
 *   pnpm tsx src/display-layer/query.ts --source-prefix=did:web:maps.etzhayyim.com:seismic
 */

import { Etzhayyim } from "@etzhayyim/sdk";
import type { DisplayLayerKind, DisplayLayerRecord } from "./types.js";

const COLLECTION = "com.etzhayyim.maps.displayLayer";

const e = new Etzhayyim({
  did: process.env.ETZ_READER_DID ?? "did:web:maps.etzhayyim.com",
  pdsUrl: process.env.ETZ_PDS_URL ?? "https://pds.etzhayyim.com",
  ipfsGateway: process.env.ETZ_IPFS_GATEWAY ?? "https://ipfs.etzhayyim.com",
  l2RpcUrl: process.env.ETZ_L2_RPC_URL ?? "https://mainnet.base.org",
});

interface Args {
  layerId?: string;
  prefix?: string;
  kind?: DisplayLayerKind;
  sourcePrefix?: string;
  limit?: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (const a of argv) {
    const m = a.match(/^--([\w-]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, k, v] = m;
    const key = k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    if (key === "limit") out.limit = Number(v);
    else (out as Record<string, unknown>)[key] = v;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.layerId) {
    const { records } = await e.read<DisplayLayerRecord>({
      collection: COLLECTION,
      rkey: args.layerId,
    });
    console.log(JSON.stringify(records[0] ?? null, null, 2));
    return;
  }

  const { records, cursor } = await e.read<DisplayLayerRecord>({
    collection: COLLECTION,
    prefix: args.prefix ?? "",
    limit: args.limit ?? 100,
  });

  const filtered = records.filter((r) => {
    if (args.kind && r.value.kind !== args.kind) return false;
    if (args.sourcePrefix && !r.value.sourceDid.startsWith(args.sourcePrefix)) return false;
    return true;
  });

  console.log(`[query:display-layer] ${filtered.length}/${records.length} layers`);
  for (const r of filtered) {
    const v = r.value;
    const zoom = v.zoomMin !== undefined || v.zoomMax !== undefined ? ` [z${v.zoomMin ?? 0}-${v.zoomMax ?? 24}]` : "";
    console.log(`  ${v.layerId.padEnd(36)}  ${v.kind.padEnd(8)}${zoom}  ${v.name}`);
    console.log(`    source: ${v.sourceDid}`);
  }
  if (cursor) console.log(`[query:display-layer] next cursor: ${cursor}`);
}

const isMainModule =
  import.meta.url.startsWith("file:") &&
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));
if (isMainModule) {
  main().catch((err) => {
    console.error("[query:display-layer] fatal:", err);
    process.exit(2);
  });
}
