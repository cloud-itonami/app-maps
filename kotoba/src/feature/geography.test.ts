/**
 * Geography Intelligence Tier B helpers — registerSpot / registerRiver /
 * registerLake / registerCoastline / registerMaritimeZone / registerAdminArea
 * + listFeatures(label).
 *
 * Per maps CLAUDE.md §"Geography Intelligence (18)" + MIGRATION-TODO
 * Phase 3 Tier B + ADR-2605231400.
 *
 * Each helper composes registerFeature with the correct label + geometry
 * kind; tests assert label/geometry/properties shape and witness flow.
 */

import { describe, expect, it } from "vitest";

import { kotoba-datomic } from "@etzhayyim/sdk";

import {
  isValidGeometryGeoJson,
  registerAdminArea,
  registerCoastline,
  registerLake,
  registerMaritimeZone,
  registerRiver,
  registerSpot,
  listFeatures,
  type ListFeaturesClient,
  type RegisterFeatureClient,
} from "./index.js";

const {
  createInMemoryWitnessTransport,
  flattenFleet,
  makeDeterministicTestSigner,
  makeStandardCellHandler,
} = kotoba-datomic;
type FleetCell = kotoba-datomic.FleetCell;

import { featureSchemaValidator } from "./membrane.js";

// ─── fixtures ─────────────────────────────────────────────────────────

function mockClient(captured: Array<{ uri: string; cid: string; value: Record<string, unknown> }> = []): RegisterFeatureClient {
  let counter = 0;
  return {
    async write(opts) {
      counter += 1;
      const rkey = opts.rkey ?? `tid-${counter}`;
      const uri = `at://did:web:maps.etzhayyim.com/${opts.collection}/${rkey}`;
      const cid = `bafy-geo-${counter.toString().padStart(8, "0")}`;
      captured.push({ uri, cid, value: opts.record });
      return { uri, cid };
    },
  };
}

function fleetOf(nodes: number, cellsPerNode: number): FleetCell[] {
  return flattenFleet(
    Array.from({ length: nodes }, (_, i) => ({
      hostname: `mocknode-${i}.local`,
      cells: Array.from({ length: cellsPerNode }, (_, j) => `MapsFeatureAttestor${j}`),
    })),
  );
}

function allAcceptTransport(fleet: readonly FleetCell[]) {
  return createInMemoryWitnessTransport({
    cellHandlers: new Map(
      fleet.map((cell) => [
        cell.key,
        makeStandardCellHandler({
          cell,
          signer: makeDeterministicTestSigner(cell.cellId),
          validators: { schema: featureSchemaValidator },
        }),
      ]),
    ),
  });
}

// ─── registerSpot ───────────────────────────────────────────────────

describe("registerSpot — L0", () => {
  it("emits a Spot feature with point geometry + category prop", async () => {
    const captured: Array<{ uri: string; cid: string; value: Record<string, unknown> }> = [];
    const client = mockClient(captured);
    await registerSpot(
      {
        name: "明治神宮",
        lng: 139.6993,
        lat: 35.6764,
        category: "shrine",
        h3Cell: "8a30d8bd2477fff",
        rkey: "meiji-jingu",
      },
      { client },
    );
    expect(captured).toHaveLength(1);
    const v = captured[0].value;
    expect(v.label).toBe("Spot");
    const geom = JSON.parse(v.geometryGeoJson as string);
    expect(geom.type).toBe("Point");
    expect(geom.coordinates).toEqual([139.6993, 35.6764]);
    expect(JSON.parse(v.properties as string).category).toBe("shrine");
    expect(v.h3Resolution).toBe(10);
  });
});

// ─── registerRiver ──────────────────────────────────────────────────

describe("registerRiver", () => {
  it("emits LineString geometry from coords", async () => {
    const captured: Array<{ uri: string; cid: string; value: Record<string, unknown> }> = [];
    const client = mockClient(captured);
    await registerRiver(
      {
        name: "Tama River",
        coords: [
          [138.85, 35.85],
          [139.10, 35.75],
          [139.40, 35.65],
          [139.78, 35.53],
        ],
        bboxDegrees: [138.85, 35.53, 139.78, 35.85],
        h3Cell: "8a30d8bd2477fff",
        lengthKm: 138,
      },
      { client },
    );
    const v = captured[0].value;
    expect(v.label).toBe("River");
    const geom = JSON.parse(v.geometryGeoJson as string);
    expect(geom.type).toBe("LineString");
    expect(geom.coordinates).toHaveLength(4);
    expect(JSON.parse(v.properties as string).lengthKm).toBe(138);
  });

  it("rejects single-coord LineString", async () => {
    const client = mockClient();
    await expect(
      registerRiver(
        { name: "x", coords: [[0, 0]], bboxDegrees: [0, 0, 0, 0], h3Cell: "a" },
        { client },
      ),
    ).rejects.toThrow(/≥2 coordinates/);
  });
});

// ─── registerLake ───────────────────────────────────────────────────

describe("registerLake", () => {
  it("emits Polygon geometry with surface area + max depth props", async () => {
    const captured: Array<{ uri: string; cid: string; value: Record<string, unknown> }> = [];
    const client = mockClient(captured);
    const ring: readonly (readonly [number, number])[] = [
      [138.0, 35.45],
      [138.10, 35.45],
      [138.10, 35.55],
      [138.0, 35.55],
      [138.0, 35.45],
    ];
    await registerLake(
      {
        name: "Lake Yamanaka",
        polygonRings: [ring],
        bboxDegrees: [138.0, 35.45, 138.10, 35.55],
        h3Cell: "8a30d8bd2477fff",
        surfaceAreaSqKm: 6.46,
        maxDepthMeters: 13.3,
      },
      { client },
    );
    const v = captured[0].value;
    expect(v.label).toBe("Lake");
    const geom = JSON.parse(v.geometryGeoJson as string);
    expect(geom.type).toBe("Polygon");
    const props = JSON.parse(v.properties as string);
    expect(props.surfaceAreaSqKm).toBe(6.46);
    expect(props.maxDepthMeters).toBe(13.3);
  });
});

// ─── registerCoastline ──────────────────────────────────────────────

describe("registerCoastline", () => {
  it("emits LineString with optional lengthKm prop", async () => {
    const captured: Array<{ uri: string; cid: string; value: Record<string, unknown> }> = [];
    const client = mockClient(captured);
    await registerCoastline(
      {
        name: "Boso Peninsula east coast",
        coords: [
          [140.10, 35.65],
          [140.30, 35.45],
          [140.42, 35.15],
        ],
        bboxDegrees: [140.10, 35.15, 140.42, 35.65],
        h3Cell: "8a30d8bd2477fff",
        lengthKm: 75,
      },
      { client },
    );
    const v = captured[0].value;
    expect(v.label).toBe("Coastline");
    expect(JSON.parse(v.geometryGeoJson as string).type).toBe("LineString");
    expect(JSON.parse(v.properties as string).lengthKm).toBe(75);
  });

  it("rejects single-coord LineString", async () => {
    const client = mockClient();
    await expect(
      registerCoastline(
        { name: "x", coords: [[0, 0]], bboxDegrees: [0, 0, 0, 0], h3Cell: "a" },
        { client },
      ),
    ).rejects.toThrow(/≥2 coordinates/);
  });
});

// ─── registerMaritimeZone ───────────────────────────────────────────

describe("registerMaritimeZone", () => {
  it("emits Polygon for EEZ-style zone with zoneType prop", async () => {
    const captured: Array<{ uri: string; cid: string; value: Record<string, unknown> }> = [];
    const client = mockClient(captured);
    const ring: readonly (readonly [number, number])[] = [
      [122.0, 24.0],
      [154.0, 24.0],
      [154.0, 46.0],
      [122.0, 46.0],
      [122.0, 24.0],
    ];
    await registerMaritimeZone(
      {
        name: "Japan EEZ (approx)",
        polygonRings: [ring],
        bboxDegrees: [122.0, 24.0, 154.0, 46.0],
        h3Cell: "8a30d8bd2477fff",
        zoneType: "eez",
      },
      { client },
    );
    const v = captured[0].value;
    expect(v.label).toBe("MaritimeZone");
    expect(JSON.parse(v.geometryGeoJson as string).type).toBe("Polygon");
    expect(JSON.parse(v.properties as string).zoneType).toBe("eez");
    expect(v.h3Resolution).toBe(4); // coarser default for large zones
  });
});

// ─── registerAdminArea ──────────────────────────────────────────────

describe("registerAdminArea", () => {
  it("emits Polygon with adminLevel + regionDid props", async () => {
    const captured: Array<{ uri: string; cid: string; value: Record<string, unknown> }> = [];
    const client = mockClient(captured);
    const ring: readonly (readonly [number, number])[] = [
      [139.5, 35.5],
      [139.9, 35.5],
      [139.9, 35.8],
      [139.5, 35.8],
      [139.5, 35.5],
    ];
    await registerAdminArea(
      {
        name: "東京都 (approx)",
        polygonRings: [ring],
        bboxDegrees: [139.5, 35.5, 139.9, 35.8],
        h3Cell: "8a30d8bd2477fff",
        adminLevel: "admin1",
        regionDid: "did:web:maps.etzhayyim.com:region:jp-tokyo",
        rkey: "jp-tokyo",
      },
      { client },
    );
    const v = captured[0].value;
    expect(v.label).toBe("AdminArea");
    expect(JSON.parse(v.geometryGeoJson as string).type).toBe("Polygon");
    const props = JSON.parse(v.properties as string);
    expect(props.adminLevel).toBe("admin1");
    expect(props.regionDid).toBe("did:web:maps.etzhayyim.com:region:jp-tokyo");
  });
});

// ─── L1 witnessed — exercise the full path for one helper ───────────

describe("L1 witnessed (Tier B) — registerLake end-to-end", () => {
  it("Lake Yamanaka with 30-cell fleet → witnessed/accept", async () => {
    const fleet = fleetOf(10, 3);
    const captured: Array<{ uri: string; cid: string; value: Record<string, unknown> }> = [];
    const client = mockClient(captured);
    const transport = allAcceptTransport(fleet);
    const ring: readonly (readonly [number, number])[] = [
      [138.85, 35.65],
      [138.90, 35.65],
      [138.90, 35.70],
      [138.85, 35.70],
      [138.85, 35.65],
    ];
    const result = await registerLake(
      {
        name: "Lake Yamanaka",
        polygonRings: [ring],
        bboxDegrees: [138.85, 35.65, 138.90, 35.70],
        h3Cell: "8a30d8bd2477fff",
        surfaceAreaSqKm: 6.46,
        rkey: "lake-yamanaka",
      },
      { client, witness: { fleet, transport } },
    );
    expect(captured).toHaveLength(1);
    expect(captured[0].value.label).toBe("Lake");
    expect(result.witnessState!.kind).toBe("witnessed");
  });
});

// ─── geometry validity sanity ───────────────────────────────────────

describe("geometry validity for every Geography helper output", () => {
  it("all helpers emit isValidGeometryGeoJson outputs", async () => {
    const captured: Array<{ uri: string; cid: string; value: Record<string, unknown> }> = [];
    const client = mockClient(captured);
    const ring: readonly (readonly [number, number])[] = [
      [0, 0], [1, 0], [1, 1], [0, 1], [0, 0],
    ];
    const line: readonly (readonly [number, number])[] = [[0, 0], [1, 1]];

    await registerSpot({ name: "s", lng: 0, lat: 0, h3Cell: "a" }, { client });
    await registerRiver({ name: "r", coords: line, bboxDegrees: [0, 0, 1, 1], h3Cell: "a" }, { client });
    await registerLake({ name: "l", polygonRings: [ring], bboxDegrees: [0, 0, 1, 1], h3Cell: "a" }, { client });
    await registerCoastline({ name: "c", coords: line, bboxDegrees: [0, 0, 1, 1], h3Cell: "a" }, { client });
    await registerMaritimeZone({ name: "m", polygonRings: [ring], bboxDegrees: [0, 0, 1, 1], h3Cell: "a" }, { client });
    await registerAdminArea({ name: "a", polygonRings: [ring], bboxDegrees: [0, 0, 1, 1], h3Cell: "a" }, { client });

    expect(captured).toHaveLength(6);
    for (const c of captured) {
      expect(isValidGeometryGeoJson(c.value.geometryGeoJson as string)).toBe(true);
    }
  });
});

// ─── listFeatures ───────────────────────────────────────────────────

describe("listFeatures (read side, 7-types-in-one)", () => {
  function mockListClient(values: Array<{ uri: string; cid: string; value: any }>): ListFeaturesClient {
    return {
      async read() {
        return { records: values, cursor: undefined };
      },
    };
  }

  it("returns all features when no label filter", async () => {
    const records = [
      { uri: "at://x/c/1", cid: "bafy-1", value: { label: "Spot", name: "A" } },
      { uri: "at://x/c/2", cid: "bafy-2", value: { label: "River", name: "B" } },
      { uri: "at://x/c/3", cid: "bafy-3", value: { label: "Lake", name: "C" } },
    ];
    const out = await listFeatures({ client: mockListClient(records) });
    expect(out.records).toHaveLength(3);
  });

  it("filters by label", async () => {
    const records = [
      { uri: "at://x/c/1", cid: "bafy-1", value: { label: "Spot", name: "A" } },
      { uri: "at://x/c/2", cid: "bafy-2", value: { label: "River", name: "B" } },
      { uri: "at://x/c/3", cid: "bafy-3", value: { label: "Spot", name: "C" } },
    ];
    const out = await listFeatures({ client: mockListClient(records), label: "Spot" });
    expect(out.records).toHaveLength(2);
    expect(out.records.map((r) => r.value.name).sort()).toEqual(["A", "C"]);
  });

  it("propagates cursor + limit to the read client", async () => {
    const captured: Record<string, any> = {};
    const client: ListFeaturesClient = {
      async read(opts) {
        captured.opts = opts;
        return { records: [], cursor: "next-page" };
      },
    };
    const out = await listFeatures({
      client,
      label: "Spot",
      prefix: "myprefix",
      limit: 25,
      cursor: "from-here",
    });
    expect(captured.opts.collection).toBe("com.etzhayyim.maps.feature");
    expect(captured.opts.prefix).toBe("myprefix");
    expect(captured.opts.limit).toBe(25);
    expect(captured.opts.cursor).toBe("from-here");
    expect(out.cursor).toBe("next-page");
  });
});
