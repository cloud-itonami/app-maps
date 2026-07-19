/**
 * First real dataset E2E smoke — Wikidata SPARQL bindings → registerLegalEntity.
 *
 * Exercises the path that an operator runs end-to-end after
 * `e7m-dataset pull wikidata --query legal-entities-with-lei`:
 *
 *   1. Read the result.jsonl from the staging dir.
 *   2. parseJsonlBindings → WikidataSparqlBinding[]
 *   3. ingestLegalEntitiesFromWikidata → registerLegalEntity per row
 *   4. Each record carries `sourceDid = did:web:maps.etzhayyim.com:registry:wikidata`
 *      so the Phase 1 Tier A source DID registry + Phase 3 Tier B entity
 *      registry stay connected by provenance.
 *
 * All substrate I/O is mocked — this is the architectural proof, not a
 * live PDS smoke.
 */

import { describe, expect, it } from "vitest";

import {
  WIKIDATA_SOURCE_DID,
  bindingToLegalEntity,
  ingestLegalEntitiesFromWikidata,
  parseJsonlBindings,
  qidFromEntityUri,
  type WikidataSparqlBinding,
} from "./wikidata-ingest.js";
import type { RegistryClient } from "./index.js";

// ─── fixtures: representative Wikidata bindings ──────────────────────

function binding(
  qid: string,
  label: string,
  lei: string,
  country?: string,
  inception?: string,
): WikidataSparqlBinding {
  const b: WikidataSparqlBinding = {
    entity: { type: "uri", value: `http://www.wikidata.org/entity/${qid}` },
    entityLabel: { type: "literal", value: label },
    lei: { type: "literal", value: lei },
  };
  if (country) b.countryCode = { type: "literal", value: country };
  if (inception) b.inception = { type: "literal", value: inception };
  return b;
}

const FIXTURE_BINDINGS: ReadonlyArray<WikidataSparqlBinding> = [
  // Realistic LEIs come from GLEIF lookups; the values here are
  // 20-char-alphanumeric shaped for isValidLei() but not real LEI codes
  // (we don't want test data to imply attestation about real entities).
  binding("Q486156", "Toyota Motor Corp.", "353800ZNORS39N56Y897", "JP", "1937-08-28T00:00:00Z"),
  binding("Q41478",  "Sony Group Corp.",   "549300L2BIPCDSRC9T59", "JP", "1946-05-07T00:00:00Z"),
  binding("Q34448",  "JR East",            "549300VYABCD12345678", "JP", "1987-04-01T00:00:00Z"),
  binding("Q484",    "Hitachi",            "353800ZZ123456789012", "JP", "1910-02-01T00:00:00Z"),
  binding("Q104842", "Mitsubishi Corp.",   "549300X1Y2Z3A4B5C6D7", "JP", "1954-07-01T00:00:00Z"),
];

function mockClient(captured: Array<{ collection: string; rkey?: string; value: Record<string, unknown> }> = []): RegistryClient {
  let counter = 0;
  return {
    async write(opts) {
      counter += 1;
      captured.push({ collection: opts.collection, rkey: opts.rkey, value: opts.record });
      return {
        uri: `at://did:web:maps.etzhayyim.com/${opts.collection}/${opts.rkey ?? `tid-${counter}`}`,
        cid: `bafy-wd-${counter.toString().padStart(8, "0")}`,
      };
    },
    async read() {
      return { records: [], cursor: undefined };
    },
  };
}

// ─── pure helpers ────────────────────────────────────────────────────

describe("qidFromEntityUri", () => {
  it.each([
    ["http://www.wikidata.org/entity/Q486156", "Q486156"],
    ["https://www.wikidata.org/entity/Q1", "Q1"],
    ["http://www.wikidata.org/entity/L42", null], // not a Q-item (lexeme)
    ["not a uri", null],
    [undefined, null],
  ])("qidFromEntityUri(%j) === %j", (uri, expected) => {
    expect(qidFromEntityUri(uri as string | undefined)).toBe(expected);
  });
});

describe("bindingToLegalEntity (pure converter)", () => {
  it("Toyota → Corporation with LEI, country, inception preserved", () => {
    const conv = bindingToLegalEntity(FIXTURE_BINDINGS[0]);
    expect(conv).not.toBeNull();
    if (!conv) return;
    expect(conv.qid).toBe("Q486156");
    expect(conv.input.entityType).toBe("Corporation");
    expect(conv.input.name).toBe("Toyota Motor Corp.");
    expect(conv.input.lei).toBe("353800ZNORS39N56Y897");
    expect(conv.input.country).toBe("JP");
    expect(conv.input.registeredAt).toBe("1937-08-28T00:00:00Z");
    expect(conv.input.sourceDid).toBe(WIKIDATA_SOURCE_DID);
    expect(conv.input.jurisdiction).toBe("Wikidata (JP)");
  });

  it("skips bindings without LEI", () => {
    const b: WikidataSparqlBinding = {
      entity: { type: "uri", value: "http://www.wikidata.org/entity/Q999" },
      entityLabel: { type: "literal", value: "No-LEI Co" },
    };
    expect(bindingToLegalEntity(b)).toBeNull();
  });

  it("skips bindings with invalid LEI", () => {
    const b: WikidataSparqlBinding = {
      entity: { type: "uri", value: "http://www.wikidata.org/entity/Q1" },
      entityLabel: { type: "literal", value: "Bogus" },
      lei: { type: "literal", value: "too-short" },
    };
    expect(bindingToLegalEntity(b)).toBeNull();
  });

  it("falls back to provided registeredAt when no inception", () => {
    const b = binding("Q1", "Foo Corp", "353800ZNORS39N56Y897"); // no country, no inception
    const conv = bindingToLegalEntity(b, { fallbackRegisteredAt: "2026-05-23T00:00:00Z" });
    expect(conv!.input.registeredAt).toBe("2026-05-23T00:00:00Z");
    expect(conv!.input.country).toBeUndefined();
    expect(conv!.input.jurisdiction).toBe("Wikidata");
  });

  it("respects entityType override", () => {
    const conv = bindingToLegalEntity(FIXTURE_BINDINGS[0], { entityType: "Operator" });
    expect(conv!.input.entityType).toBe("Operator");
  });

  it("respects sourceDid override", () => {
    const conv = bindingToLegalEntity(FIXTURE_BINDINGS[0], { sourceDid: "did:web:opt.example" });
    expect(conv!.input.sourceDid).toBe("did:web:opt.example");
  });
});

describe("parseJsonlBindings", () => {
  it("parses one JSON object per line", () => {
    const jsonl = FIXTURE_BINDINGS.map((b) => JSON.stringify(b)).join("\n");
    const parsed = parseJsonlBindings(jsonl);
    expect(parsed).toHaveLength(FIXTURE_BINDINGS.length);
    expect(parsed[0].entityLabel?.value).toBe("Toyota Motor Corp.");
  });

  it("skips empty lines + trailing newline", () => {
    const jsonl = `${JSON.stringify(FIXTURE_BINDINGS[0])}\n\n${JSON.stringify(FIXTURE_BINDINGS[1])}\n`;
    const parsed = parseJsonlBindings(jsonl);
    expect(parsed).toHaveLength(2);
  });
});

// ─── E2E bulk ingest (the headline smoke) ──────────────────────────

describe("ingestLegalEntitiesFromWikidata — E2E smoke", () => {
  it("5 bindings → 5 LegalEntity records with correct shape + sourceDid", async () => {
    const captured: Array<{ collection: string; rkey?: string; value: Record<string, unknown> }> = [];
    const client = mockClient(captured);

    const stats = await ingestLegalEntitiesFromWikidata(FIXTURE_BINDINGS, { client });

    expect(stats.totalBindings).toBe(5);
    expect(stats.skippedNoLei).toBe(0);
    expect(stats.skippedInvalidLei).toBe(0);
    expect(stats.attempted).toBe(5);
    expect(stats.ok).toBe(5);
    expect(stats.failed).toBe(0);
    expect(stats.entityKeys).toHaveLength(5);

    // Each captured row has the right collection + label + provenance.
    for (const c of captured) {
      expect(c.collection).toBe("com.etzhayyim.maps.legalEntity");
      expect(c.value.entityType).toBe("Corporation");
      expect(c.value.sourceDid).toBe(WIKIDATA_SOURCE_DID);
      expect(c.value.country).toBe("JP");
      expect(c.value.lei).toMatch(/^[A-Z0-9]{20}$/);
    }

    // entityKeys all start with the corporation slug + lei segment.
    for (const ek of stats.entityKeys) {
      expect(ek.startsWith("corporation-")).toBe(true);
    }
  });

  it("mixed valid/invalid input → tracks skip + ok counts", async () => {
    const mixed: WikidataSparqlBinding[] = [
      ...FIXTURE_BINDINGS.slice(0, 2),
      // No LEI:
      { entity: { type: "uri", value: "http://www.wikidata.org/entity/Q999" }, entityLabel: { type: "literal", value: "No-LEI Co" } },
      // Invalid LEI (too short):
      { entity: { type: "uri", value: "http://www.wikidata.org/entity/Q888" }, entityLabel: { type: "literal", value: "Bad-LEI" }, lei: { type: "literal", value: "short" } },
      // No label:
      { entity: { type: "uri", value: "http://www.wikidata.org/entity/Q777" }, lei: { type: "literal", value: "353800ZNORS39N56Y897" } },
      ...FIXTURE_BINDINGS.slice(2),
    ];
    const stats = await ingestLegalEntitiesFromWikidata(mixed, { client: mockClient() });
    expect(stats.totalBindings).toBe(8);
    expect(stats.skippedNoLei).toBe(2);          // no-LEI + no-label
    expect(stats.skippedInvalidLei).toBe(1);
    expect(stats.attempted).toBe(5);
    expect(stats.ok).toBe(5);
  });

  it("accumulates failures from PDS write errors without throwing", async () => {
    let call = 0;
    const flakyClient: RegistryClient = {
      async write(opts) {
        call += 1;
        if (call === 3) throw new Error("PDS 500 — flaky");
        return { uri: `at://x/y/${call}`, cid: `bafy-${call}` };
      },
      async read() {
        return { records: [], cursor: undefined };
      },
    };
    const stats = await ingestLegalEntitiesFromWikidata(FIXTURE_BINDINGS, { client: flakyClient });
    expect(stats.attempted).toBe(5);
    expect(stats.ok).toBe(4);
    expect(stats.failed).toBe(1);
    expect(stats.failures).toHaveLength(1);
    expect(stats.failures[0].error).toMatch(/PDS 500/);
  });

  it("failFastAfter=1 stops on first failure", async () => {
    const breakingClient: RegistryClient = {
      async write() {
        throw new Error("always fail");
      },
      async read() {
        return { records: [], cursor: undefined };
      },
    };
    const stats = await ingestLegalEntitiesFromWikidata(FIXTURE_BINDINGS, {
      client: breakingClient,
      failFastAfter: 1,
    });
    expect(stats.failed).toBe(1);
    expect(stats.attempted).toBe(1); // bailed after first
  });
});

// Note: registerLegalEntity is currently Tier A (no witness path). When
// it's lifted to Tier B (likely follow-up — high-stakes LEI assertions
// benefit from quorum), the wikidata-ingest helper will route through
// the same opts.witness shape used by feature / twin / ingest modules.
