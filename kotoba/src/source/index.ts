/**
 * @etzhayyim/maps-kotoba
 *
 * Programmatic entry points for the maps Tier A surfaces. Apps embedding
 * read access import from here:
 *
 *   import { listSources, getSource } from "@etzhayyim/maps-kotoba";
 */

export type {
  MapsSource,
  MapsSourceCategory,
  MapsSourceStatus,
} from "./types.js";
export { didForSlug, isValidTtl, slugForDid } from "./types.js";

import { Etzhayyim } from "@etzhayyim/sdk";
import type { MapsSource } from "./types.js";

const COLLECTION = "com.etzhayyim.maps.source";

function defaultClient(): Etzhayyim {
  return new Etzhayyim({
    did: "did:web:maps.etzhayyim.com",
    pdsUrl: "https://pds.etzhayyim.com",
    ipfsGateway: "https://ipfs.etzhayyim.com",
    l2RpcUrl: "https://mainnet.base.org",
  });
}

export interface ListSourcesOpts {
  prefix?: string;
  limit?: number;
  client?: Etzhayyim;
}

export async function listSources(opts: ListSourcesOpts = {}): Promise<MapsSource[]> {
  const e = opts.client ?? defaultClient();
  const { records } = await e.read<MapsSource>({
    collection: COLLECTION,
    prefix: opts.prefix ?? "",
    limit: opts.limit ?? 100,
    fetchBlobs: false,
  });
  return records.map((r) => r.value);
}

export async function getSource(
  slug: string,
  opts: { client?: Etzhayyim } = {},
): Promise<MapsSource | null> {
  const e = opts.client ?? defaultClient();
  const { records } = await e.read<MapsSource>({
    collection: COLLECTION,
    rkey: slug,
    fetchBlobs: false,
  });
  return records[0]?.value ?? null;
}

/**
 * Resolve a source DID → MapsSource record. Inverse helper for callers
 * that have a DID in hand (e.g., a collection job record references the
 * source by DID) and need the registry metadata.
 */
export async function resolveSourceDid(
  did: string,
  opts: { client?: Etzhayyim } = {},
): Promise<MapsSource | null> {
  // Maps DIDs round-trip via the slug→did encoding, so derive the slug
  // and do a direct rkey lookup. For non-maps DIDs (e.g., cross-actor
  // did:web:site.etzhayyim.com) return null — the caller should look
  // them up in the appropriate sibling registry.
  if (!did.startsWith("did:web:maps.etzhayyim.com:")) return null;
  const slug = did.slice("did:web:maps.etzhayyim.com:".length).replace(/:/g, "-");
  return getSource(slug, opts);
}
