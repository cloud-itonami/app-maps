/**
 * Mirrors the com.etzhayyim.maps.source Lexicon record shape.
 * Source: orgs/etzhayyim/com-etzhayyim-maps/wire/lex/source.json
 *
 * One record per external API the maps app replaces with a path-based DID.
 * Append-only with `supersedesDid` for revision lineage.
 */
export interface MapsSource {
  /** Schema version. Current: 1. */
  v: 1;

  /** Stable rkey-safe slug. Format: kebab-case. Matches the path segment under did:web:maps.etzhayyim.com (or 'registry-{name}' for nested registries). */
  slug: string;

  /** Canonical path-based DID. did:web:maps.etzhayyim.com[:registry]:{slug-with-colons}. */
  did: string;

  /** Human-readable name. */
  displayName: string;

  /** The external API or dataset this DID replaces. */
  externalSource: string;

  /** ISO 8601 duration (e.g. 'PT1H', 'P7D') or the literal 'permanent'. */
  ttl: string;

  /** Upstream license (e.g. 'ODbL', 'CC-BY-4.0', 'public-domain'). */
  license?: string;

  /** Coarse category. */
  category?: MapsSourceCategory;

  /** Operational status. */
  status: MapsSourceStatus;

  /** ISO datetime when this source entry was registered. */
  registeredAt: string;

  /** Earlier DID this record replaces (slug change, license re-issue). */
  supersedesDid?: string;

  /** Free-form operator notes. */
  notes?: string;
}

export type MapsSourceCategory =
  | "geocode"
  | "weather"
  | "infrastructure"
  | "transport"
  | "satellite"
  | "vision"
  | "hazard"
  | "registry"
  | "crawl"
  | "user"
  | "other";

export type MapsSourceStatus =
  | "active"
  | "deprecated"
  | "experimental"
  | "paused";

/**
 * Pure helper: derive the canonical DID from a slug.
 *
 *   "geocode"            → did:web:maps.etzhayyim.com:geocode
 *   "registry-openflights" → did:web:maps.etzhayyim.com:registry:openflights
 *   "registry-osm-ferry"   → did:web:maps.etzhayyim.com:registry:osm:ferry
 *
 * Slug → DID path-segment join: kebab segments become colon-separated.
 */
export function didForSlug(slug: string): string {
  if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error(`invalid source slug (kebab-case required, no leading/trailing/consecutive hyphens): ${slug}`);
  }
  const path = slug.replace(/-/g, ":");
  return `did:web:maps.etzhayyim.com:${path}`;
}

/**
 * Pure helper: derive the slug back from a maps-owned DID. Inverse of
 * `didForSlug`. Throws if the DID is not a maps.etzhayyim.com path-DID.
 */
export function slugForDid(did: string): string {
  const prefix = "did:web:maps.etzhayyim.com:";
  if (!did.startsWith(prefix)) {
    throw new Error(`not a maps path-DID: ${did}`);
  }
  return did.slice(prefix.length).replace(/:/g, "-");
}

/**
 * Pure helper: is the TTL string a recognised form? Used to lock the
 * lexicon's free-form `ttl` field to a small, machine-checkable surface.
 */
export function isValidTtl(ttl: string): boolean {
  if (ttl === "permanent") return true;
  return /^PT?\d+[YMWDHMS]$/.test(ttl) || /^P\d+[YMWD]T\d+[HMS]$/.test(ttl);
}
