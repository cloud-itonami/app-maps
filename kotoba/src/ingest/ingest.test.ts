/**
 * Phase 3 Tier B ingest helpers — Vision / Satellite / Mapraly / WebCrawl.
 * All four record kinds carry a `payloadKind` discriminator referring to
 * a DataLad-pinned dataset (per ADR-2605241500), raw IPFS CID, external
 * URL, or inline content.
 */

import { describe, expect, it } from "vitest";

import { kotoba-datomic } from "@etzhayyim/sdk";

import {
  isValidIngestId,
  isValidPctBps,
  registerMapralyPoi,
  registerSatelliteScene,
  registerVisionResult,
  registerWebCrawlGeoEntity,
  validateSatellitePayloadRef,
  validateVisionPayloadRef,
  type IngestClient,
} from "./index.js";

const {
  createInMemoryWitnessTransport,
  flattenFleet,
  makeDeterministicTestSigner,
  makeStandardCellHandler,
} = kotoba-datomic;
type FleetCell = kotoba-datomic.FleetCell;
type MembraneRule = kotoba-datomic.MembraneRule;

// ─── fixtures ─────────────────────────────────────────────────────────

function mockClient(
  captured: Array<{ collection: string; rkey?: string; value: Record<string, unknown> }> = [],
): IngestClient {
  let counter = 0;
  return {
    async write(opts) {
      counter += 1;
      captured.push({ collection: opts.collection, rkey: opts.rkey, value: opts.record });
      return {
        uri: `at://did:web:maps.etzhayyim.com/${opts.collection}/${opts.rkey ?? `tid-${counter}`}`,
        cid: `bafy-ingest-${counter.toString().padStart(8, "0")}`,
      };
    },
  };
}

function fleetOf(nodes: number, cellsPerNode: number): FleetCell[] {
  return flattenFleet(
    Array.from({ length: nodes }, (_, i) => ({
      hostname: `mocknode-${i}.local`,
      cells: Array.from({ length: cellsPerNode }, (_, j) => `MapsIngestAttestor${j}`),
    })),
  );
}

function mockRule(nsid: string): MembraneRule {
  return {
    v: 1, nsid,
    schemaRef: { path: "x", contentHash: "0".repeat(64), version: "1.0.0" },
    policyRef: { path: "y", contentHash: "0".repeat(64), version: "1.0.0" },
    cellRef: { path: "z/", contentHash: "0".repeat(64), version: "abcdef0" },
    quorumSize: 5, quorumThreshold: 3, escalationPolicy: "council",
    registeredAt: "2026-05-23T00:00:00Z",
  };
}

const DATASET_PIN_URI = "at://did:web:etzhayyim.com/com.etzhayyim.substrate.datasetPin/r0001";

// ─── id + pctBps + payloadRef validators ────────────────────────────

describe("isValidIngestId", () => {
  it.each([
    ["vision-r0001", true],
    ["sentinel-2-t54sue-260523", true],
    ["UPPER", false],
    ["with_underscore", false],
    ["", false],
  ])("isValidIngestId(%j) === %s", (s, expected) => {
    expect(isValidIngestId(s)).toBe(expected);
  });
});

describe("isValidPctBps", () => {
  it.each([
    [undefined, true], [0, true], [10000, true],
    [-1, false], [10001, false], [50.5, false],
  ])("isValidPctBps(%s) === %s", (n, expected) => {
    expect(isValidPctBps(n as number | undefined)).toBe(expected);
  });
});

describe("validateVisionPayloadRef", () => {
  it("accepts datalad-pin with datasetPinUri", () => {
    expect(validateVisionPayloadRef({
      payloadKind: "datalad-pin", datasetPinUri: DATASET_PIN_URI,
    })).toBeNull();
  });
  it("rejects datalad-pin without datasetPinUri", () => {
    expect(validateVisionPayloadRef({ payloadKind: "datalad-pin" })).toMatch(/datasetPinUri/);
  });
  it("accepts inline within 16KB", () => {
    expect(validateVisionPayloadRef({ payloadKind: "inline", inlineJson: "{\"x\":1}" })).toBeNull();
  });
  it("rejects inline >16KB", () => {
    expect(validateVisionPayloadRef({ payloadKind: "inline", inlineJson: "x".repeat(16385) })).toMatch(/16KB/);
  });
  it("rejects ipfs without payloadCid", () => {
    expect(validateVisionPayloadRef({ payloadKind: "ipfs" })).toMatch(/payloadCid/);
  });
});

describe("validateSatellitePayloadRef", () => {
  it("accepts stac-url (most common path)", () => {
    expect(validateSatellitePayloadRef({
      payloadKind: "stac-url",
      stacItemUrl: "https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a/items/S2A_...",
    })).toBeNull();
  });
  it("accepts datalad-pin with datasetPinUri", () => {
    expect(validateSatellitePayloadRef({
      payloadKind: "datalad-pin", datasetPinUri: DATASET_PIN_URI,
    })).toBeNull();
  });
  it("rejects ipfs without assetCids", () => {
    expect(validateSatellitePayloadRef({ payloadKind: "ipfs" })).toMatch(/assetCids/);
  });
});

// ─── registerVisionResult ────────────────────────────────────────────

describe("registerVisionResult", () => {
  it("datalad-pin: stores resultId + datasetPinUri + entities", async () => {
    const captured: Array<{ collection: string; rkey?: string; value: Record<string, unknown> }> = [];
    await registerVisionResult(
      {
        resultId: "fuji-classify-r0001",
        analysisKind: "classification",
        visionModel: "qwen3-vl-8b",
        entities: [{ label: "snow-cap", confidence: 0.98 }, { label: "summit-shrine", confidence: 0.85 }],
        confidence: 0.92,
        payloadKind: "datalad-pin",
        datasetPinUri: DATASET_PIN_URI,
        datasetPath: "vision-2026Q2/qwen3-vl/r0001.json",
        sourceDid: "did:web:maps.etzhayyim.com:vision",
      },
      { client: mockClient(captured) },
    );
    expect(captured[0].collection).toBe("com.etzhayyim.maps.visionResult");
    expect(captured[0].rkey).toBe("fuji-classify-r0001");
    const v = captured[0].value;
    expect(v.analysisKind).toBe("classification");
    expect(v.payloadKind).toBe("datalad-pin");
    expect(v.datasetPinUri).toBe(DATASET_PIN_URI);
    expect((v.entities as VisionEntity[])).toHaveLength(2);
  });

  it("rejects invalid resultId", async () => {
    await expect(
      registerVisionResult(
        {
          resultId: "UPPER-CASE",
          analysisKind: "classification",
          visionModel: "qwen3-vl-8b",
          payloadKind: "datalad-pin",
          datasetPinUri: DATASET_PIN_URI,
        },
        { client: mockClient() },
      ),
    ).rejects.toThrow(/invalid resultId/);
  });

  it("rejects datalad-pin without datasetPinUri", async () => {
    await expect(
      registerVisionResult(
        { resultId: "x", analysisKind: "ocr", visionModel: "qwen3-vl-8b", payloadKind: "datalad-pin" },
        { client: mockClient() },
      ),
    ).rejects.toThrow(/datasetPinUri/);
  });

  it("inline payload happy path", async () => {
    const captured: Array<{ value: Record<string, unknown> }> = [];
    await registerVisionResult(
      {
        resultId: "small-r0002",
        analysisKind: "caption",
        visionModel: "qwen3-vl-8b",
        payloadKind: "inline",
        inlineJson: JSON.stringify({ caption: "a brief view of Mt. Fuji" }),
      },
      { client: mockClient(captured as any) },
    );
    expect(captured[0].value.payloadKind).toBe("inline");
  });
});

// ─── registerSatelliteScene ──────────────────────────────────────────

describe("registerSatelliteScene", () => {
  it("stac-url: most common path for ESA / USGS scenes", async () => {
    const captured: Array<{ collection: string; rkey?: string; value: Record<string, unknown> }> = [];
    await registerSatelliteScene(
      {
        sceneId: "S2A_MSIL2A_20260523T012345_N0509_R046_T54SUE_20260523T030000",
        sensor: "sentinel-2",
        stacCollectionId: "sentinel-2-l2a",
        bboxWestE7: 1390000000,
        bboxSouthE7: 350000000,
        bboxEastE7: 1395000000,
        bboxNorthE7: 355000000,
        acquiredAt: "2026-05-23T01:23:45Z",
        cloudCoverPctBps: 1250,
        payloadKind: "stac-url",
        stacItemUrl: "https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a/items/S2A_MSIL2A_20260523T012345",
        sourceDid: "did:web:maps.etzhayyim.com:satellite",
      },
      { client: mockClient(captured) },
    );
    expect(captured[0].rkey).toBe("S2A_MSIL2A_20260523T012345_N0509_R046_T54SUE_20260523T030000");
    expect(captured[0].value.sensor).toBe("sentinel-2");
    expect(captured[0].value.cloudCoverPctBps).toBe(1250);
  });

  it("datalad-pin: mirrored asset path", async () => {
    const captured: Array<{ value: Record<string, unknown> }> = [];
    await registerSatelliteScene(
      {
        sceneId: "LC09_L2SP_001234_20260523_02_T1",
        sensor: "landsat-9",
        bboxWestE7: 0, bboxSouthE7: 0, bboxEastE7: 1000000, bboxNorthE7: 1000000,
        acquiredAt: "2026-05-23T10:00:00Z",
        payloadKind: "datalad-pin",
        datasetPinUri: DATASET_PIN_URI,
      },
      { client: mockClient(captured as any) },
    );
    expect(captured[0].value.payloadKind).toBe("datalad-pin");
  });

  it("rejects cloudCoverPctBps out of range", async () => {
    await expect(
      registerSatelliteScene(
        {
          sceneId: "x", sensor: "sentinel-2",
          bboxWestE7: 0, bboxSouthE7: 0, bboxEastE7: 1, bboxNorthE7: 1,
          acquiredAt: "2026-05-23T00:00:00Z",
          cloudCoverPctBps: 12000,
          payloadKind: "stac-url", stacItemUrl: "https://x.test",
        },
        { client: mockClient() },
      ),
    ).rejects.toThrow(/cloudCoverPctBps/);
  });
});

// ─── registerMapralyPoi ──────────────────────────────────────────────

describe("registerMapralyPoi", () => {
  it("happy path with photo CIDs", async () => {
    const captured: Array<{ value: Record<string, unknown> }> = [];
    await registerMapralyPoi(
      {
        poiId: "ginza-cafe-001",
        name: "Cafe de l'Ambre",
        category: "food.cafe",
        lng: 139.7635,
        lat: 35.6717,
        rating: 4.6,
        batchId: "ginza-2026-05",
        photoPayloadKind: "ipfs",
        photoCids: ["bafyreidemo1", "bafyreidemo2"],
      },
      { client: mockClient(captured as any) },
    );
    const v = captured[0].value;
    expect(v.poiId).toBe("ginza-cafe-001");
    expect(v.rating).toBe(4.6);
    expect((v.photoCids as string[])).toHaveLength(2);
  });

  it("rejects datalad-pin without datasetPinUri", async () => {
    await expect(
      registerMapralyPoi(
        {
          poiId: "x", name: "x", category: "x", lng: 0, lat: 0,
          photoPayloadKind: "datalad-pin",
        },
        { client: mockClient() },
      ),
    ).rejects.toThrow(/datasetPinUri/);
  });

  it("rejects out-of-range rating", async () => {
    await expect(
      registerMapralyPoi(
        { poiId: "x", name: "x", category: "x", lng: 0, lat: 0, rating: 6 },
        { client: mockClient() },
      ),
    ).rejects.toThrow(/rating/);
  });
});

// ─── registerWebCrawlGeoEntity ──────────────────────────────────────

describe("registerWebCrawlGeoEntity", () => {
  it("cross-actor wet reference path (site.etzhayyim.com)", async () => {
    const captured: Array<{ value: Record<string, unknown> }> = [];
    await registerWebCrawlGeoEntity(
      {
        entityId: "gsi-station-tokyo-001",
        name: "Tokyo Reference Station",
        entityType: "facility",
        domain: "gsi.go.jp",
        lng: 139.7426,
        lat: 35.65696,
        nerConfidence: 0.97,
        wetPayloadKind: "cross-actor",
        wetRecordUri: "at://did:web:site.etzhayyim.com/com.etzhayyim.site.wetRecord/r0042",
        crawledAt: "2026-05-23T00:00:00Z",
      },
      { client: mockClient(captured as any) },
    );
    expect(captured[0].value.wetPayloadKind).toBe("cross-actor");
    expect(captured[0].value.wetRecordUri).toContain("site.etzhayyim.com");
  });

  it("inline snippet within 4KB cap", async () => {
    const captured: Array<{ value: Record<string, unknown> }> = [];
    await registerWebCrawlGeoEntity(
      {
        entityId: "wiki-fuji",
        name: "Fuji",
        entityType: "geographic-feature",
        domain: "wikipedia.org",
        wetPayloadKind: "inline",
        inlineSnippet: "...Mount Fuji is an active stratovolcano on Honshu, the highest in Japan at 3776 m...",
        crawledAt: "2026-05-23T00:00:00Z",
      },
      { client: mockClient(captured as any) },
    );
    expect(captured[0].value.wetPayloadKind).toBe("inline");
  });

  it("rejects inline snippet > 4KB", async () => {
    await expect(
      registerWebCrawlGeoEntity(
        {
          entityId: "x", name: "x", entityType: "place", domain: "x",
          wetPayloadKind: "inline", inlineSnippet: "x".repeat(4097),
          crawledAt: "2026-05-23T00:00:00Z",
        },
        { client: mockClient() },
      ),
    ).rejects.toThrow(/4KB/);
  });

  it("rejects nerConfidence out of range", async () => {
    await expect(
      registerWebCrawlGeoEntity(
        {
          entityId: "x", name: "x", entityType: "place", domain: "x",
          nerConfidence: 1.5, crawledAt: "2026-05-23T00:00:00Z",
        },
        { client: mockClient() },
      ),
    ).rejects.toThrow(/nerConfidence/);
  });
});

// ─── L1 witnessed end-to-end ────────────────────────────────────────

describe("L1 witnessed end-to-end — registerSatelliteScene", () => {
  it("Sentinel-2 scene with 30-cell fleet → witnessed/accept", async () => {
    const fleet = fleetOf(10, 3);
    const transport = createInMemoryWitnessTransport({
      cellHandlers: new Map(
        fleet.map((cell) => [
          cell.key,
          makeStandardCellHandler({
            cell,
            signer: makeDeterministicTestSigner(cell.cellId),
            validators: {},
          }),
        ]),
      ),
    });
    const result = await registerSatelliteScene(
      {
        sceneId: "S2A_MSIL2A_20260523_T54SUE_smoke",
        sensor: "sentinel-2",
        bboxWestE7: 1390000000, bboxSouthE7: 350000000, bboxEastE7: 1395000000, bboxNorthE7: 355000000,
        acquiredAt: "2026-05-23T01:23:45Z",
        cloudCoverPctBps: 500,
        payloadKind: "stac-url",
        stacItemUrl: "https://test.example/stac/sentinel-2-l2a/items/x",
      },
      { client: mockClient(), witness: { fleet, transport, rule: mockRule("com.etzhayyim.maps.satelliteScene") } },
    );
    expect(result.witnessState!.kind).toBe("witnessed");
  });
});

type VisionEntity = { label: string; confidence?: number };
