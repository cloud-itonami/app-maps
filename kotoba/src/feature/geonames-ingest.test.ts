/**
 * GeoNames TSV → registerFeature bulk ingest tests.
 *
 * Mirrors registry/wikidata-ingest.test.ts — pure converter unit tests
 * + E2E bulk smoke against a mock RegisterFeatureClient.
 */

import { describe, expect, it } from "vitest";

import {
  FCL_LABEL_MAP,
  GEONAMES_SOURCE_DID,
  fclToLabel,
  geonamesRowToFeature,
  ingestPlacesFromGeoNames,
  parseGeoNamesLine,
  parseGeoNamesTsv,
  type GeoNamesRow,
} from "./geonames-ingest.js";
import type { RegisterFeatureClient } from "./index.js";

// ─── fixtures ─────────────────────────────────────────────────────────

/** A representative GeoNames TSV line. The file has 19+ tab-separated
 *  fields; we lay them out per the documented format. */
function tsvLine(fields: ReadonlyArray<string>): string {
  // Pad to 19 columns so parseGeoNamesLine accepts it.
  const padded = [...fields];
  while (padded.length < 19) padded.push("");
  return padded.join("\t");
}

const TOKYO_TSV = tsvLine([
  "1850147", "Tokyo", "Tokyo", "Tokyo|東京",
  "35.6895", "139.69171",
  "P", "PPLC",
  "JP", "", "", "", "", "",
  "8336599",
]);
const FUJI_TSV = tsvLine([
  "1851632", "Mount Fuji", "Mount Fuji", "Fuji|富士山",
  "35.36083", "138.72778",
  "T", "PEAK",
  "JP", "", "", "", "", "",
  "0",
]);
const TAMA_RIVER_TSV = tsvLine([
  "1851077", "Tama-gawa", "Tama-gawa", "Tama River",
  "35.535", "139.785",
  "H", "STM",
  "JP", "", "", "", "", "",
  "0",
]);
const SHINJUKU_STA_TSV = tsvLine([
  "1851234", "Shinjuku Station", "Shinjuku Station", "",
  "35.6896", "139.7006",
  "S", "RSTN",
  "JP", "", "", "", "", "",
  "0",
]);
const TOKYO_PREF_TSV = tsvLine([
  "1850144", "Tokyo Metropolis", "Tokyo Metropolis", "",
  "35.689722", "139.692222",
  "A", "ADM1",
  "JP", "", "", "", "", "",
  "13921000",
]);

// ─── parseGeoNamesLine ──────────────────────────────────────────────

describe("parseGeoNamesLine", () => {
  it("parses a well-formed Tokyo line", () => {
    const row = parseGeoNamesLine(TOKYO_TSV);
    expect(row).not.toBeNull();
    expect(row!.geonameid).toBe("1850147");
    expect(row!.name).toBe("Tokyo");
    expect(row!.lat).toBeCloseTo(35.6895, 4);
    expect(row!.lng).toBeCloseTo(139.69171, 5);
    expect(row!.fcl).toBe("P");
    expect(row!.fcode).toBe("PPLC");
    expect(row!.country).toBe("JP");
    expect(row!.population).toBe(8336599);
  });

  it("returns null for <19 columns", () => {
    expect(parseGeoNamesLine("1\t2\t3")).toBeNull();
  });

  it("returns null for lat=0 lng=0 (GeoNames sentinel)", () => {
    const zero = tsvLine([
      "1", "Zero", "", "",
      "0", "0",
      "P", "PPL",
      "", "", "", "", "", "",
      "0",
    ]);
    expect(parseGeoNamesLine(zero)).toBeNull();
  });

  it("returns null for missing geonameid", () => {
    const noId = tsvLine([
      "", "X", "X", "",
      "1.0", "2.0",
      "P", "PPL",
      "JP", "", "", "", "", "",
      "0",
    ]);
    expect(parseGeoNamesLine(noId)).toBeNull();
  });

  it("returns null for missing name", () => {
    const noName = tsvLine([
      "1", "", "", "",
      "1.0", "2.0",
      "P", "PPL",
      "JP", "", "", "", "", "",
      "0",
    ]);
    expect(parseGeoNamesLine(noName)).toBeNull();
  });

  it("returns null for non-numeric coords", () => {
    const bad = tsvLine([
      "1", "X", "", "",
      "north", "east",
      "P", "PPL",
      "JP", "", "", "", "", "",
      "0",
    ]);
    expect(parseGeoNamesLine(bad)).toBeNull();
  });

  it("handles non-integer / empty population gracefully", () => {
    const line = tsvLine([
      "1", "X", "X", "",
      "1.0", "2.0",
      "P", "PPL",
      "JP", "", "", "", "", "",
      "",
    ]);
    const r = parseGeoNamesLine(line);
    expect(r!.population).toBeUndefined();
  });

  it("strips trailing \\r (Windows line endings)", () => {
    const r = parseGeoNamesLine(TOKYO_TSV + "\r");
    expect(r).not.toBeNull();
    expect(r!.name).toBe("Tokyo");
  });
});

// ─── parseGeoNamesTsv ──────────────────────────────────────────────

describe("parseGeoNamesTsv", () => {
  it("parses multiple lines + skips blanks + skips invalid rows", () => {
    const text = [TOKYO_TSV, "", FUJI_TSV, "garbage line"].join("\n");
    const rows = parseGeoNamesTsv(text);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.name)).toEqual(["Tokyo", "Mount Fuji"]);
  });
});

// ─── fcl → label mapping ────────────────────────────────────────────

describe("fclToLabel", () => {
  it.each([
    ["P", "Place"],
    ["A", "AdminArea"],
    ["T", "Mountain"],
    ["H", "River"],
    ["L", "Spot"],
    ["R", "Road"],
    ["S", "Building"],
    ["U", "Spot"],
    ["V", "Spot"],
    ["?", "Spot"], // unknown → catch-all
    ["", "Spot"],
  ])("fclToLabel(%j) === %j", (fcl, expected) => {
    expect(fclToLabel(fcl)).toBe(expected);
  });

  it("FCL_LABEL_MAP has 9 entries covering all documented classes", () => {
    expect(Object.keys(FCL_LABEL_MAP).sort()).toEqual(
      ["A", "H", "L", "P", "R", "S", "T", "U", "V"],
    );
  });
});

// ─── geonamesRowToFeature (pure converter) ──────────────────────────

describe("geonamesRowToFeature", () => {
  it("Tokyo (Place) → Place feature with Point geometry + population prop", () => {
    const row = parseGeoNamesLine(TOKYO_TSV)!;
    const conv = geonamesRowToFeature(row);
    expect(conv).not.toBeNull();
    if (!conv) return;
    expect(conv.label).toBe("Place");
    expect(conv.input.label).toBe("Place");
    expect(conv.input.name).toBe("Tokyo");
    expect(conv.input.rkey).toBe("geonames-1850147");
    expect(conv.input.sourceDid).toBe(GEONAMES_SOURCE_DID);
    const geom = JSON.parse(conv.input.geometryGeoJson);
    expect(geom.type).toBe("Point");
    expect(geom.coordinates).toEqual([139.69171, 35.6895]);
    const props = JSON.parse(conv.input.properties!);
    expect(props.category).toBe("geonames-p");
    expect(props.population).toBe(8336599);
    expect(props.country).toBe("JP");
  });

  it("Fuji (T) → Mountain", () => {
    const row = parseGeoNamesLine(FUJI_TSV)!;
    expect(geonamesRowToFeature(row)!.label).toBe("Mountain");
  });

  it("Tama-gawa (H) → River", () => {
    const row = parseGeoNamesLine(TAMA_RIVER_TSV)!;
    expect(geonamesRowToFeature(row)!.label).toBe("River");
  });

  it("Shinjuku Station (S RSTN) → Building", () => {
    const row = parseGeoNamesLine(SHINJUKU_STA_TSV)!;
    expect(geonamesRowToFeature(row)!.label).toBe("Building");
  });

  it("Tokyo Metropolis (A ADM1) → AdminArea", () => {
    const row = parseGeoNamesLine(TOKYO_PREF_TSV)!;
    expect(geonamesRowToFeature(row)!.label).toBe("AdminArea");
  });

  it("uses caller-provided h3Cell function when given", () => {
    const row = parseGeoNamesLine(TOKYO_TSV)!;
    const conv = geonamesRowToFeature(row, {
      h3Cell: (lat, lng, r) => `h3-${lat.toFixed(2)}-${lng.toFixed(2)}-${r}`,
      h3Resolution: 9,
    });
    expect(conv!.input.h3Cell).toBe("h3-35.69-139.69-9");
    expect(conv!.input.h3Resolution).toBe(9);
  });

  it("falls back to unknown-res placeholder when no h3Cell function", () => {
    const row = parseGeoNamesLine(TOKYO_TSV)!;
    const conv = geonamesRowToFeature(row, { h3Resolution: 10 });
    expect(conv!.input.h3Cell).toBe("unknown-res10");
  });

  it("returns null on missing fcl (row.fcl=\"\")", () => {
    const row: GeoNamesRow = {
      geonameid: "1",
      name: "x",
      lat: 1,
      lng: 2,
      fcl: "",
      fcode: "",
    };
    expect(geonamesRowToFeature(row)).toBeNull();
  });

  it("respects sourceDid override", () => {
    const row = parseGeoNamesLine(TOKYO_TSV)!;
    const conv = geonamesRowToFeature(row, { sourceDid: "did:web:custom" });
    expect(conv!.input.sourceDid).toBe("did:web:custom");
  });
});

// ─── ingestPlacesFromGeoNames (E2E smoke) ─────────────────────────

function mockClient(captured: Array<{ collection: string; rkey?: string; value: Record<string, unknown> }> = []): RegisterFeatureClient {
  let counter = 0;
  return {
    async write(opts) {
      counter += 1;
      captured.push({ collection: opts.collection, rkey: opts.rkey, value: opts.record });
      return {
        uri: `at://did:web:maps.etzhayyim.com/${opts.collection}/${opts.rkey ?? `tid-${counter}`}`,
        cid: `bafy-gn-${counter.toString().padStart(8, "0")}`,
      };
    },
  };
}

describe("ingestPlacesFromGeoNames — E2E smoke (5 representative rows)", () => {
  const fixtureRows = parseGeoNamesTsv(
    [TOKYO_TSV, FUJI_TSV, TAMA_RIVER_TSV, SHINJUKU_STA_TSV, TOKYO_PREF_TSV].join("\n"),
  );

  it("5 rows → 5 features, label discriminator covers Place/Mountain/River/Building/AdminArea", async () => {
    const captured: Array<{ collection: string; rkey?: string; value: Record<string, unknown> }> = [];
    const stats = await ingestPlacesFromGeoNames(fixtureRows, { client: mockClient(captured) });
    expect(stats.totalRows).toBe(5);
    expect(stats.attempted).toBe(5);
    expect(stats.ok).toBe(5);
    expect(stats.failed).toBe(0);
    expect(captured).toHaveLength(5);
    expect(captured.every((c) => c.collection === "com.etzhayyim.maps.feature")).toBe(true);
    const labels = captured.map((c) => c.value.label).sort();
    expect(labels).toEqual(["AdminArea", "Building", "Mountain", "Place", "River"]);
    expect(stats.labelCounts).toEqual({
      Place: 1, Mountain: 1, River: 1, Building: 1, AdminArea: 1,
    });
  });

  it("rkeys are geonames-{geonameid} (idempotent re-ingest)", async () => {
    const stats = await ingestPlacesFromGeoNames(fixtureRows, { client: mockClient() });
    expect(stats.rkeys.sort()).toEqual([
      "geonames-1850144",
      "geonames-1850147",
      "geonames-1851077",
      "geonames-1851234",
      "geonames-1851632",
    ]);
  });

  it("labelFilter restricts to subset (e.g., Place + Mountain only)", async () => {
    const captured: Array<{ collection: string; rkey?: string; value: Record<string, unknown> }> = [];
    const stats = await ingestPlacesFromGeoNames(fixtureRows, {
      client: mockClient(captured),
      labelFilter: ["Place", "Mountain"],
    });
    expect(stats.ok).toBe(2);
    expect(stats.skippedLabelFilter).toBe(3);
    expect(captured.map((c) => c.value.label).sort()).toEqual(["Mountain", "Place"]);
  });

  it("maxRecords caps the run", async () => {
    const stats = await ingestPlacesFromGeoNames(fixtureRows, {
      client: mockClient(),
      maxRecords: 2,
    });
    expect(stats.ok).toBe(2);
    expect(stats.skippedMaxRecords).toBe(3);
  });

  it("failFastAfter aborts on first failure", async () => {
    const breakingClient: RegisterFeatureClient = {
      async write() {
        throw new Error("PDS 500");
      },
    };
    const stats = await ingestPlacesFromGeoNames(fixtureRows, {
      client: breakingClient,
      failFastAfter: 1,
    });
    expect(stats.attempted).toBe(1);
    expect(stats.failed).toBe(1);
  });

  it("source DID is consistently set on every record", async () => {
    const captured: Array<{ value: Record<string, unknown> }> = [];
    await ingestPlacesFromGeoNames(fixtureRows, { client: mockClient(captured as any) });
    for (const c of captured) {
      expect(c.value.sourceDid).toBe(GEONAMES_SOURCE_DID);
    }
  });
});

describe("ingestPlacesFromGeoNames — h3 hook integration", () => {
  it("caller-provided h3 lookup is used for every row", async () => {
    const fixtureRows = parseGeoNamesTsv([TOKYO_TSV, FUJI_TSV].join("\n"));
    const captured: Array<{ value: Record<string, unknown> }> = [];
    await ingestPlacesFromGeoNames(fixtureRows, {
      client: mockClient(captured as any),
      converter: {
        h3Cell: (lat, lng, r) => `fake-h3-${lat.toFixed(2)}-${lng.toFixed(2)}-r${r}`,
        h3Resolution: 9,
      },
    });
    for (const c of captured) {
      expect((c.value.h3Cell as string).startsWith("fake-h3-")).toBe(true);
      expect(c.value.h3Resolution).toBe(9);
    }
  });
});
