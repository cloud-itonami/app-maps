/**
 * Query: list / get LegalEntity / Registry / Ownership records.
 * Replaces the 22 RW handlers register/list × 11 entity+registry types
 * + registerOwnership + ownershipChain + entityHistory + seedGlobalRegistries.
 *
 * Usage:
 *   pnpm tsx src/registry/query.ts --kind=entity --prefix=corporation-
 *   pnpm tsx src/registry/query.ts --kind=entity --entityKey=corporation-549300abc1234567890z
 *   pnpm tsx src/registry/query.ts --kind=registry --prefix=land-registry-
 *   pnpm tsx src/registry/query.ts --kind=registry --registryKey=land-registry-13-01234
 *   pnpm tsx src/registry/query.ts --kind=ownership --subject=at://...
 *   pnpm tsx src/registry/query.ts --kind=ownership --object=at://...
 */

import { Etzhayyim } from "@etzhayyim/sdk";
import type {
  LegalEntityRecord,
  OwnershipRecord,
  RegistryRecord,
} from "./types.js";

const COLLECTION_ENTITY = "com.etzhayyim.maps.legalEntity";
const COLLECTION_REGISTRY = "com.etzhayyim.maps.registry";
const COLLECTION_OWNERSHIP = "com.etzhayyim.maps.ownership";

const e = new Etzhayyim({
  did: process.env.ETZ_READER_DID ?? "did:web:maps.etzhayyim.com",
  pdsUrl: process.env.ETZ_PDS_URL ?? "https://pds.etzhayyim.com",
  ipfsGateway: process.env.ETZ_IPFS_GATEWAY ?? "https://ipfs.etzhayyim.com",
  l2RpcUrl: process.env.ETZ_L2_RPC_URL ?? "https://mainnet.base.org",
});

interface Args {
  kind?: "entity" | "registry" | "ownership";
  entityKey?: string;
  registryKey?: string;
  subject?: string;
  object?: string;
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
  const kind = args.kind ?? "entity";

  if (kind === "entity") {
    if (args.entityKey) {
      const { records } = await e.read<LegalEntityRecord>({
        collection: COLLECTION_ENTITY,
        rkey: args.entityKey,
      });
      console.log(JSON.stringify(records[0] ?? null, null, 2));
      return;
    }
    const { records } = await e.read<LegalEntityRecord>({
      collection: COLLECTION_ENTITY,
      prefix: args.prefix ?? "",
      limit: args.limit ?? 100,
    });
    console.log(`[query:entity] ${records.length} entities`);
    for (const r of records) {
      const v = r.value;
      console.log(`  ${v.entityKey.padEnd(48)}  ${v.entityType.padEnd(14)}  ${v.name}`);
    }
    return;
  }

  if (kind === "registry") {
    if (args.registryKey) {
      const { records } = await e.read<RegistryRecord>({
        collection: COLLECTION_REGISTRY,
        rkey: args.registryKey,
      });
      console.log(JSON.stringify(records[0] ?? null, null, 2));
      return;
    }
    const { records } = await e.read<RegistryRecord>({
      collection: COLLECTION_REGISTRY,
      prefix: args.prefix ?? "",
      limit: args.limit ?? 100,
    });
    console.log(`[query:registry] ${records.length} registries`);
    for (const r of records) {
      const v = r.value;
      console.log(`  ${v.registryKey.padEnd(48)}  ${v.registryType.padEnd(18)}  ${v.jurisdiction}`);
    }
    return;
  }

  if (kind === "ownership") {
    // Ownership rkey is TID; need full-collection scan with post-filter on subject/object.
    const { records } = await e.read<OwnershipRecord>({
      collection: COLLECTION_OWNERSHIP,
      prefix: "",
      limit: args.limit ?? 500,
    });
    const filtered = records.filter((r) => {
      if (args.subject && r.value.subjectUri !== args.subject) return false;
      if (args.object && r.value.objectUri !== args.object) return false;
      return true;
    });
    // Sort by effectiveDate ascending — gives the ownership chain in order.
    filtered.sort((a, b) => a.value.effectiveDate.localeCompare(b.value.effectiveDate));
    console.log(`[query:ownership] ${filtered.length}/${records.length} records`);
    for (const r of filtered) {
      const v = r.value;
      const share = v.sharePctBps !== undefined ? ` ${(v.sharePctBps / 100).toFixed(2)}%` : "";
      console.log(`  ${v.effectiveDate}  ${v.relation.padEnd(14)}${share}`);
      console.log(`    subject: ${v.subjectUri}`);
      console.log(`    object:  ${v.objectUri}`);
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
    console.error("[query:registry] fatal:", err);
    process.exit(2);
  });
}
