/**
 * Wikidata SPARQL → com.etzhayyim.maps.legalEntity bulk ingest.
 *
 * Connects the Phase 1 Tier A source DID
 * `did:web:maps.etzhayyim.com:registry:wikidata` to the Phase 3 Tier B
 * registry write surface. The transform from a Wikidata SPARQL binding
 * to a LegalEntity record is a pure function (testable without I/O);
 * the bulk ingest helper composes it with `registerLegalEntity`.
 *
 * Expected binding shape (matches the canned `legal-entities-with-lei`
 * query in 70-tools/e7m-dataset/src/e7m_dataset/fetchers/wikidata.py):
 *
 *   {
 *     "entity":      {"type":"uri",     "value":"http://www.wikidata.org/entity/Q486156"},
 *     "entityLabel": {"type":"literal", "value":"Toyota"},
 *     "lei":         {"type":"literal", "value":"353800ZNORS39N56Y897"},
 *     "countryCode": {"type":"literal", "value":"JP"},
 *     "inception":   {"type":"literal", "value":"1937-08-28T00:00:00Z"}
 *   }
 *
 * Operator workflow (per e7m-dataset/README.md):
 *
 *   e7m-dataset pull wikidata --query legal-entities-with-lei --limit 5000
 *   # → writes datasets-staging/wikidata-legal-entities-with-lei-{ts}/result.jsonl
 *
 *   # Curate + datalad save + publish-ipfs (operator)
 *
 *   # Then feed result.jsonl into the bulk ingest:
 *   const bindings = readJsonlFile("...result.jsonl");
 *   const stats = await ingestLegalEntitiesFromWikidata(bindings, { client });
 *
 * Per maps MIGRATION-TODO + ADR-2605231400 + ADR-2605241500.
 */

import {
  isValidLei,
  registerLegalEntity,
  type LegalEntityRecord,
  type RegistryClient,
} from "./index.js";

const WIKIDATA_SOURCE_DID = "did:web:maps.etzhayyim.com:registry:wikidata";

/** Loose SPARQL JSON binding shape. Wikidata returns one of these for
 *  each variable in the SELECT. Fields are optional because OPTIONAL
 *  clauses produce undefined for unmatched bindings. */
export interface WikidataSparqlBinding {
  entity?: { type: string; value: string };
  entityLabel?: { type: string; value: string };
  lei?: { type: string; value: string };
  countryCode?: { type: string; value: string };
  inception?: { type: string; value: string };
  // Allow extra keys (some queries add more variables; we ignore them).
  [k: string]: { type: string; value: string } | undefined;
}

export interface WikidataConverterOptions {
  /** Override the `entityType` discriminator. Default `Corporation`
   *  because the canned query filters wd:Q4830453 (business enterprise). */
  entityType?: "LegalEntity" | "Operator" | "PropertyOwner" | "Corporation" | "GovernmentBody" | "PublicUtility";
  /** Provenance source DID. Default `did:web:maps.etzhayyim.com:registry:wikidata`. */
  sourceDid?: string;
  /** Fallback registeredAt when the binding has no `inception`. Default `new Date().toISOString()`. */
  fallbackRegisteredAt?: string;
}

export interface ConvertedLegalEntity {
  /** RegisterLegalEntity input — caller passes this directly to the helper. */
  input: {
    entityType: NonNullable<WikidataConverterOptions["entityType"]>;
    name: string;
    lei?: string;
    country?: string;
    sourceDid: string;
    registeredAt: string;
    jurisdiction?: string;
  };
  /** Wikidata QID for traceability (not part of the record). */
  qid: string | null;
}

/** QID parser — `http://www.wikidata.org/entity/Q12345` → `Q12345`. */
export function qidFromEntityUri(uri: string | undefined): string | null {
  if (!uri) return null;
  const m = uri.match(/^https?:\/\/www\.wikidata\.org\/entity\/(Q\d+)$/);
  return m ? m[1] : null;
}

/** Pure converter. Returns null when the binding lacks the minimum
 *  required fields (entityLabel + lei). Caller should skip these rows. */
export function bindingToLegalEntity(
  binding: WikidataSparqlBinding,
  opts: WikidataConverterOptions = {},
): ConvertedLegalEntity | null {
  const name = binding.entityLabel?.value?.trim();
  const lei = binding.lei?.value?.trim();
  if (!name || !lei) return null;
  if (!isValidLei(lei)) return null;
  const country = binding.countryCode?.value?.trim() || undefined;
  const inception = binding.inception?.value?.trim();
  const registeredAt = inception || opts.fallbackRegisteredAt || new Date().toISOString();
  return {
    qid: qidFromEntityUri(binding.entity?.value),
    input: {
      entityType: opts.entityType ?? "Corporation",
      name,
      lei,
      country,
      sourceDid: opts.sourceDid ?? WIKIDATA_SOURCE_DID,
      registeredAt,
      jurisdiction: country ? `Wikidata (${country})` : "Wikidata",
    },
  };
}

/** Outcome of a bulk ingest run. */
export interface BulkIngestStats {
  totalBindings: number;
  skippedNoLei: number;
  skippedInvalidLei: number;
  attempted: number;
  ok: number;
  failed: number;
  failures: Array<{ qid: string | null; name: string; lei?: string; error: string }>;
  /** entityKey of every successfully written record. */
  entityKeys: string[];
}

export interface BulkIngestOpts {
  client: RegistryClient;
  converter?: WikidataConverterOptions;
  /** Stop iteration after N failures. Default: never. */
  failFastAfter?: number;
}

/** Bulk ingest. Reads each binding via the pure converter and writes
 *  via registerLegalEntity. Failures are accumulated (not thrown) so
 *  callers see the full picture; set `failFastAfter` to abort early. */
export async function ingestLegalEntitiesFromWikidata(
  bindings: ReadonlyArray<WikidataSparqlBinding>,
  opts: BulkIngestOpts,
): Promise<BulkIngestStats> {
  const stats: BulkIngestStats = {
    totalBindings: bindings.length,
    skippedNoLei: 0,
    skippedInvalidLei: 0,
    attempted: 0,
    ok: 0,
    failed: 0,
    failures: [],
    entityKeys: [],
  };
  for (const b of bindings) {
    const name = b.entityLabel?.value?.trim();
    const lei = b.lei?.value?.trim();
    if (!name || !lei) {
      stats.skippedNoLei += 1;
      continue;
    }
    if (!isValidLei(lei)) {
      stats.skippedInvalidLei += 1;
      continue;
    }
    const converted = bindingToLegalEntity(b, opts.converter);
    if (!converted) {
      stats.skippedNoLei += 1;
      continue;
    }
    stats.attempted += 1;
    try {
      const result = await registerLegalEntity(converted.input, { client: opts.client });
      stats.ok += 1;
      stats.entityKeys.push(result.entityKey);
    } catch (caught) {
      stats.failed += 1;
      stats.failures.push({
        qid: converted.qid,
        name: converted.input.name,
        lei: converted.input.lei,
        error: (caught as Error).message,
      });
      if (opts.failFastAfter !== undefined && stats.failed >= opts.failFastAfter) {
        break;
      }
    }
  }
  return stats;
}

/** Convenience: parse a JSONL line stream (e.g., the file written by
 *  `e7m-dataset pull wikidata`) into bindings. One JSON object per line. */
export function parseJsonlBindings(jsonl: string): WikidataSparqlBinding[] {
  const out: WikidataSparqlBinding[] = [];
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    out.push(JSON.parse(trimmed) as WikidataSparqlBinding);
  }
  return out;
}

export { WIKIDATA_SOURCE_DID };
