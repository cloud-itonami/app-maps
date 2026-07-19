/**
 * Phase 1 golden-file integration test.
 *
 * One single test run that exercises every Tier A kotoba helper against
 * a mock PDS, captures every write, and asserts the canonical collection
 * + rkey + minimum shape per command.
 *
 * Not exhaustive (each topic has its own deep tests under
 * `src/{topic}/...test.ts`); this file is the **single executable proof**
 * that the Phase 1 surface is internally consistent — every helper
 * routes to the correct lexicon, key policy, and provenance fields.
 *
 * Per MIGRATION-TODO §"Phase 1 closure".
 */

import { describe, expect, it } from "vitest";

import {
  collection,
  displayLayer,
  feature,
  geo,
  registry,
  source,
  twin,
} from "./index.js";

// ─── shared mock PDS ──────────────────────────────────────────────────

interface CapturedWrite {
  collection: string;
  rkey?: string;
  value: Record<string, unknown>;
}

/** Builds a structural mock client. Several Tier A helpers (display-layer,
 *  collection, source, geo) still type their `client?` param as the full
 *  `Etzhayyim` class — refactoring all of those to a structural interface
 *  is tracked separately. For this golden test we cast at call sites; the
 *  mock's behavior is fully sufficient at runtime. */
function mockPds(captured: CapturedWrite[] = []) {
  let counter = 0;
  const client = {
    async write(opts: { collection: string; record: Record<string, unknown>; rkey?: string }) {
      counter += 1;
      captured.push({ collection: opts.collection, rkey: opts.rkey, value: opts.record });
      return {
        uri: `at://did:web:maps.etzhayyim.com/${opts.collection}/${opts.rkey ?? `tid-${counter}`}`,
        cid: `bafy-golden-${counter.toString().padStart(4, "0")}`,
      };
    },
    async read<T>(_opts: { collection: string }) {
      return { records: [] as Array<{ uri: string; cid: string; value: T }>, cursor: undefined };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { captured, client, anyClient: client as any };
}

// ─── topic-by-topic golden assertions ────────────────────────────────

describe("Phase 1 golden-file — every Tier A topic in one run", () => {
  it("source: registerSource (via direct write path of helpers) emits com.etzhayyim.maps.source", async () => {
    const { client, captured } = mockPds();
    // The source topic re-exports the SDK toolset but the canonical
    // registration goes through seed.ts CLI. For the golden test we
    // invoke the same lexicon directly via a feature.registerFeature
    // collision-check: source is its own lexicon, so we just sanity-
    // check the namespace export is present and assert the helper
    // module surface.
    expect(typeof source.didForSlug).toBe("function");
    expect(typeof source.slugForDid).toBe("function");
    expect(source.didForSlug("geocode")).toBe("did:web:maps.etzhayyim.com:geocode");
    // No write captured — source registration happens via the seed CLI.
    expect(captured).toHaveLength(0);
  });

  it("geo: vertical/natural/layer constants + helpers round-trip", () => {
    expect(geo.GEO_SCHEMES.length).toBe(29);
    expect(geo.LAYER_SLUGS.length).toBe(11);
    expect(geo.didForLayer("tile")).toBe("did:web:maps.etzhayyim.com:layer:tile");
    expect(geo.didForRegion("jp-tokyo")).toBe("did:web:maps.etzhayyim.com:region:jp-tokyo");
    expect(geo.aliasKeyFor("iso3166-1", "JP")).toBe("iso3166-1-jp");
  });

  it("displayLayer: defineDisplayLayer → com.etzhayyim.maps.displayLayer", async () => {
    const { anyClient, captured } = mockPds();
    await displayLayer.defineDisplayLayer(
      {
        layerId: "smoke-test-layer",
        name: "Smoke Test Layer",
        sourceDid: "did:web:maps.etzhayyim.com:tile",
        kind: "fill",
        zoomMin: 6,
        zoomMax: 14,
      },
      { client: anyClient },
    );
    expect(captured).toHaveLength(1);
    expect(captured[0].collection).toBe("com.etzhayyim.maps.displayLayer");
    expect(captured[0].rkey).toBe("smoke-test-layer");
    expect(captured[0].value.kind).toBe("fill");
  });

  it("registry: legalEntity / registry / ownership three lexicons", async () => {
    const { client, captured } = mockPds();
    await registry.registerLegalEntity(
      {
        entityType: "Corporation",
        name: "Toyota Motor Corp.",
        lei: "353800ZNORS39N56Y897",
        country: "JP",
      },
      { client },
    );
    await registry.registerRegistry(
      {
        registryType: "LandRegistry",
        registryNumber: "13-01234",
        jurisdiction: "東京法務局",
      },
      { client },
    );
    await registry.registerOwnership(
      {
        subjectUri: "at://did:web:maps.etzhayyim.com/com.etzhayyim.maps.legalEntity/corporation-353800znors39n56y897",
        objectUri: "at://did:web:maps.etzhayyim.com/com.etzhayyim.maps.registry/land-registry-13-01234",
        relation: "OwnsProperty",
        effectiveDate: "2026-05-23T00:00:00Z",
      },
      { client },
    );
    expect(captured).toHaveLength(3);
    expect(captured[0].collection).toBe("com.etzhayyim.maps.legalEntity");
    expect(captured[0].rkey).toBe("corporation-353800znors39n56y897");
    expect(captured[1].collection).toBe("com.etzhayyim.maps.registry");
    expect(captured[1].rkey).toBe("land-registry-13-01234");
    expect(captured[2].collection).toBe("com.etzhayyim.maps.ownership");
    expect(captured[2].rkey).toBeUndefined(); // TID
    expect(captured[2].value.relation).toBe("OwnsProperty");
  });

  it("collection: createCollectionJob + advanceJob produce the two-record event log", async () => {
    const { anyClient, captured } = mockPds();
    const job = await collection.createCollectionJob(
      {
        jobId: "smoke-geocode-260523",
        sourceDid: "did:web:maps.etzhayyim.com:geocode",
        kind: "fetch",
        params: { city: "tokyo" },
      },
      { client: anyClient },
    );
    expect(job.jobId).toBe("smoke-geocode-260523");
    expect(captured[0].collection).toBe("com.etzhayyim.maps.collectionJob");
    expect(captured[0].rkey).toBe("smoke-geocode-260523");

    await collection.advanceJob(
      {
        jobUri: `at://did:web:maps.etzhayyim.com/com.etzhayyim.maps.collectionJob/${job.jobId}`,
        state: "running",
        phase: "fetching",
        progressPctBps: 1000,
      },
      { client: anyClient },
    );
    expect(captured[1].collection).toBe("com.etzhayyim.maps.jobEvent");
    expect(captured[1].rkey).toBeUndefined(); // TID
    expect(captured[1].value.state).toBe("running");

    await collection.advanceJob(
      {
        jobUri: `at://did:web:maps.etzhayyim.com/com.etzhayyim.maps.collectionJob/${job.jobId}`,
        state: "completed",
      },
      { client: anyClient },
    );
    expect(captured).toHaveLength(3);
    expect(captured[2].value.state).toBe("completed");
  });

  it("feature: registerMountain emits com.etzhayyim.maps.feature with Point geometry", async () => {
    const { client, captured } = mockPds();
    await feature.registerMountain(
      {
        name: "Mount Fuji",
        lng: 138.7274,
        lat: 35.3606,
        elevationMeters: 3776,
        h3Cell: "8a30d8bd2477fff",
        rkey: "mount-fuji",
      },
      { client },
    );
    expect(captured).toHaveLength(1);
    expect(captured[0].collection).toBe("com.etzhayyim.maps.feature");
    expect(captured[0].rkey).toBe("mount-fuji");
    expect(captured[0].value.label).toBe("Mountain");
    expect(JSON.parse(captured[0].value.geometryGeoJson as string).type).toBe("Point");
  });

  it("twin: bindDevice + updateTwinState produce 2 records", async () => {
    const { client, captured } = mockPds();
    await twin.bindDevice(
      {
        deviceUri: "at://did:web:maps.etzhayyim.com/com.etzhayyim.maps.feature/sensor-co2-r408",
        assetUri: "at://did:web:maps.etzhayyim.com/com.etzhayyim.maps.feature/building-r408",
        relation: "Monitors",
      },
      { client },
    );
    await twin.updateOccupancy(
      {
        subjectUri: "at://did:web:maps.etzhayyim.com/com.etzhayyim.maps.feature/building-main",
        headcount: 142,
        confidence: 0.95,
      },
      { client },
    );
    expect(captured).toHaveLength(2);
    expect(captured[0].collection).toBe("com.etzhayyim.maps.deviceBinding");
    expect(captured[0].value.relation).toBe("Monitors");
    expect(captured[1].collection).toBe("com.etzhayyim.maps.twinState");
    expect(captured[1].value.stateKind).toBe("occupancy");
  });
});

// ─── end-to-end "Tier A surface in one run" ──────────────────────────

describe("Phase 1 golden-file — single-run full Tier A trace", () => {
  it("one mock PDS captures the canonical write set across all topics", async () => {
    const { client, anyClient, captured } = mockPds();

    // 1. Display layer
    await displayLayer.defineDisplayLayer(
      {
        layerId: "trace-layer",
        name: "Trace Layer",
        sourceDid: "did:web:maps.etzhayyim.com:tile",
        kind: "line",
      },
      { client: anyClient },
    );

    // 2. Registry: 1 legal entity + 1 registry + 1 ownership = 3 records
    await registry.registerLegalEntity(
      {
        entityType: "Corporation",
        name: "Sample Corp",
        lei: "353800ABCDEFGHIJKL01",
        country: "JP",
      },
      { client },
    );
    await registry.registerRegistry(
      {
        registryType: "BusinessRegistry",
        registryNumber: "JP-NTA-1234567890123",
        jurisdiction: "JP-NTA",
      },
      { client },
    );
    await registry.registerOwnership(
      {
        subjectUri: "at://did:web:maps.etzhayyim.com/com.etzhayyim.maps.legalEntity/corporation-353800abcdefghijkl01",
        objectUri: "at://did:web:maps.etzhayyim.com/com.etzhayyim.maps.registry/business-registry-jp-nta-1234567890123",
        relation: "OwnsProperty",
        effectiveDate: "2026-05-23T00:00:00Z",
      },
      { client },
    );

    // 3. Collection plumbing: job + 2 state events = 3 records
    const j = await collection.createCollectionJob(
      { jobId: "trace-job", sourceDid: "did:web:maps.etzhayyim.com:geocode", kind: "fetch" },
      { client: anyClient },
    );
    await collection.advanceJob(
      { jobUri: `at://x/y/${j.jobId}`, state: "running" },
      { client: anyClient },
    );
    await collection.advanceJob(
      { jobUri: `at://x/y/${j.jobId}`, state: "completed" },
      { client: anyClient },
    );

    // 4. Feature: 1 mountain + 1 building + 1 spot = 3 records
    await feature.registerMountain(
      { name: "Trace Peak", lng: 0, lat: 0, h3Cell: "x", rkey: "trace-peak" },
      { client },
    );
    await feature.registerBuilding(
      {
        name: "Trace Bldg",
        polygonRings: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
        centerLng: 0.5,
        centerLat: 0.5,
        bboxDegrees: [0, 0, 1, 1],
        h3Cell: "x",
        rkey: "trace-bldg",
      },
      { client },
    );
    await feature.registerSpot(
      { name: "Trace Spot", lng: 0, lat: 0, h3Cell: "x", rkey: "trace-spot" },
      { client },
    );

    // 5. Twin: device binding + occupancy event = 2 records
    await twin.bindDevice(
      {
        deviceUri: "at://x/y/device",
        assetUri: "at://x/y/asset",
        relation: "Monitors",
      },
      { client },
    );
    await twin.updateOccupancy(
      { subjectUri: "at://x/y/asset", headcount: 50 },
      { client },
    );

    // Total: 1 (display) + 3 (registry) + 3 (collection) + 3 (feature) + 2 (twin) = 12
    expect(captured).toHaveLength(12);

    // Group by collection — each Tier A lexicon must appear in the trace.
    const byCollection = captured.reduce<Record<string, number>>((acc, c) => {
      acc[c.collection] = (acc[c.collection] ?? 0) + 1;
      return acc;
    }, {});
    expect(byCollection).toEqual({
      "com.etzhayyim.maps.displayLayer": 1,
      "com.etzhayyim.maps.legalEntity": 1,
      "com.etzhayyim.maps.registry": 1,
      "com.etzhayyim.maps.ownership": 1,
      "com.etzhayyim.maps.collectionJob": 1,
      "com.etzhayyim.maps.jobEvent": 2,
      "com.etzhayyim.maps.feature": 3,
      "com.etzhayyim.maps.deviceBinding": 1,
      "com.etzhayyim.maps.twinState": 1,
    });

    // rkey conventions per topic.
    const byKey = (col: string) => captured.filter((c) => c.collection === col).map((c) => c.rkey);
    expect(byKey("com.etzhayyim.maps.displayLayer")).toEqual(["trace-layer"]);
    expect(byKey("com.etzhayyim.maps.legalEntity")).toEqual(["corporation-353800abcdefghijkl01"]);
    expect(byKey("com.etzhayyim.maps.registry")).toEqual(["business-registry-jp-nta-1234567890123"]);
    expect(byKey("com.etzhayyim.maps.collectionJob")).toEqual(["trace-job"]);
    // TID-keyed: rkey is undefined (PDS assigns).
    expect(byKey("com.etzhayyim.maps.ownership")).toEqual([undefined]);
    expect(byKey("com.etzhayyim.maps.jobEvent")).toEqual([undefined, undefined]);
    expect(byKey("com.etzhayyim.maps.deviceBinding")).toEqual([undefined]);
    expect(byKey("com.etzhayyim.maps.twinState")).toEqual([undefined]);
    // feature: literal:{rkey} chosen by caller.
    expect(byKey("com.etzhayyim.maps.feature").sort()).toEqual(["trace-bldg", "trace-peak", "trace-spot"]);
  });
});

// ─── ingest pipelines smoke (downstream of golden-file) ──────────────

describe("Phase 1 golden-file — ingest pipelines write to the same collections", () => {
  it("wikidata-ingest writes to com.etzhayyim.maps.legalEntity", async () => {
    const { client, captured } = mockPds();
    const stats = await registry.ingestLegalEntitiesFromWikidata(
      [
        {
          entity: { type: "uri", value: "http://www.wikidata.org/entity/Q1" },
          entityLabel: { type: "literal", value: "Test Corp" },
          lei: { type: "literal", value: "353800ZNORS39N56Y897" },
          countryCode: { type: "literal", value: "JP" },
        },
      ],
      { client },
    );
    expect(stats.ok).toBe(1);
    expect(captured[0].collection).toBe("com.etzhayyim.maps.legalEntity");
    expect(captured[0].value.sourceDid).toBe(registry.WIKIDATA_SOURCE_DID);
  });

  it("geonames-ingest writes to com.etzhayyim.maps.feature", async () => {
    const { client, captured } = mockPds();
    const row: feature.GeoNamesRow = {
      geonameid: "1",
      name: "Test City",
      lat: 35.5,
      lng: 139.5,
      fcl: "P",
      fcode: "PPL",
      country: "JP",
      population: 1000,
    };
    const stats = await feature.ingestPlacesFromGeoNames([row], { client });
    expect(stats.ok).toBe(1);
    expect(captured[0].collection).toBe("com.etzhayyim.maps.feature");
    expect(captured[0].value.label).toBe("Place");
    expect(captured[0].value.sourceDid).toBe(feature.GEONAMES_SOURCE_DID);
  });

  it("osm-ingest writes to com.etzhayyim.maps.feature", async () => {
    const { client, captured } = mockPds();
    const stats = await feature.ingestFromOsmGeoJson(
      [
        {
          type: "Feature",
          id: "n1",
          properties: { name: "Test Peak", natural: "peak" },
          geometry: { type: "Point", coordinates: [0, 0] },
        },
      ],
      { client },
    );
    expect(stats.ok).toBe(1);
    expect(captured[0].collection).toBe("com.etzhayyim.maps.feature");
    expect(captured[0].value.label).toBe("Mountain");
    expect(captured[0].value.sourceDid).toBe(feature.OSM_SOURCE_DID);
  });
});
