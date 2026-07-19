/**
 * Transport Infrastructure Tier B helpers — 12 register helpers covering
 * the full Phase 3 Tier B Transport surface.
 *
 *   LineString: Road / Railway / SeaRoute / AirRoute / BusRoute / Waterway
 *   Point:      Port / Airport / Station / BusStop / Parking / EvCharger
 *
 * Each helper composes registerFeature with the correct label + geometry
 * kind + type-specific properties.
 *
 * Per maps CLAUDE.md §"Transport Intelligence (24)" + MIGRATION-TODO
 * Phase 3 + ADR-2605231400.
 */

import { describe, expect, it } from "vitest";

import { kotoba-datomic } from "@etzhayyim/sdk";

import {
  isValidGeometryGeoJson,
  registerAirRoute,
  registerAirport,
  registerBusRoute,
  registerBusStop,
  registerEvCharger,
  registerParking,
  registerPort,
  registerRailway,
  registerRoad,
  registerSeaRoute,
  registerStation,
  registerWaterway,
  type RegisterFeatureClient,
} from "./index.js";

import { featureSchemaValidator } from "./membrane.js";

const {
  createInMemoryWitnessTransport,
  flattenFleet,
  makeDeterministicTestSigner,
  makeStandardCellHandler,
} = kotoba-datomic;
type FleetCell = kotoba-datomic.FleetCell;

// ─── fixtures ─────────────────────────────────────────────────────────

function mockClient(captured: Array<{ uri: string; cid: string; value: Record<string, unknown> }> = []): RegisterFeatureClient {
  let counter = 0;
  return {
    async write(opts) {
      counter += 1;
      const rkey = opts.rkey ?? `tid-${counter}`;
      const uri = `at://did:web:maps.etzhayyim.com/${opts.collection}/${rkey}`;
      const cid = `bafy-tx-${counter.toString().padStart(8, "0")}`;
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

const TWO_COORDS: readonly (readonly [number, number])[] = [
  [139.0, 35.5],
  [139.5, 35.7],
];

// ─── LineString helpers ─────────────────────────────────────────────

describe("registerRoad", () => {
  it("emits Road LineString with refNumber + surface + lanes", async () => {
    const captured: Array<{ uri: string; cid: string; value: Record<string, unknown> }> = [];
    await registerRoad(
      {
        name: "Route 1",
        coords: TWO_COORDS,
        bboxDegrees: [139.0, 35.5, 139.5, 35.7],
        h3Cell: "8a30d8bd2477fff",
        refNumber: "Route 1",
        surface: "asphalt",
        lanes: 4,
      },
      { client: mockClient(captured) },
    );
    const v = captured[0].value;
    expect(v.label).toBe("Road");
    expect(JSON.parse(v.geometryGeoJson as string).type).toBe("LineString");
    const props = JSON.parse(v.properties as string);
    expect(props.refNumber).toBe("Route 1");
    expect(props.surface).toBe("asphalt");
    expect(props.lanes).toBe(4);
  });

  it("rejects single-coord LineString", async () => {
    await expect(
      registerRoad(
        { name: "x", coords: [[0, 0]], bboxDegrees: [0, 0, 0, 0], h3Cell: "a" },
        { client: mockClient() },
      ),
    ).rejects.toThrow(/≥2 coordinates/);
  });
});

describe("registerRailway", () => {
  it("emits Railway LineString with operator + lineCode + gauge", async () => {
    const captured: Array<{ uri: string; cid: string; value: Record<string, unknown> }> = [];
    await registerRailway(
      {
        name: "JR Yamanote Line",
        coords: TWO_COORDS,
        bboxDegrees: [139.0, 35.5, 139.5, 35.7],
        h3Cell: "8a30d8bd2477fff",
        operator: "JR East",
        lineCode: "JY",
        gaugeMm: 1067,
      },
      { client: mockClient(captured) },
    );
    const v = captured[0].value;
    expect(v.label).toBe("Railway");
    expect(JSON.parse(v.geometryGeoJson as string).type).toBe("LineString");
    const props = JSON.parse(v.properties as string);
    expect(props.operator).toBe("JR East");
    expect(props.lineCode).toBe("JY");
    expect(props.gaugeMm).toBe(1067);
  });
});

describe("registerSeaRoute", () => {
  it("emits SeaRoute LineString with operator + frequency", async () => {
    const captured: Array<{ uri: string; cid: string; value: Record<string, unknown> }> = [];
    await registerSeaRoute(
      {
        name: "Tokyo–Oshima ferry",
        coords: TWO_COORDS,
        bboxDegrees: [139.0, 34.0, 139.6, 35.7],
        h3Cell: "8a30d8bd2477fff",
        operator: "Tokai Kisen",
        frequency: "daily",
        durationMinutes: 105,
      },
      { client: mockClient(captured) },
    );
    const v = captured[0].value;
    expect(v.label).toBe("SeaRoute");
    expect(JSON.parse(v.properties as string).operator).toBe("Tokai Kisen");
    expect(v.h3Resolution).toBe(4); // coarse for ocean-scale
  });
});

describe("registerAirRoute", () => {
  it("emits AirRoute LineString with airline + flight number + equipment", async () => {
    const captured: Array<{ uri: string; cid: string; value: Record<string, unknown> }> = [];
    await registerAirRoute(
      {
        name: "HND→SFO",
        coords: [
          [139.7798, 35.5494], // HND
          [-122.3789, 37.6213], // SFO
        ],
        bboxDegrees: [-122.3789, 35.5494, 139.7798, 37.6213],
        h3Cell: "8a30d8bd2477fff",
        airline: "ANA",
        flightNumber: "NH008",
        durationMinutes: 580,
        equipment: "Boeing 787-9",
      },
      { client: mockClient(captured) },
    );
    const v = captured[0].value;
    expect(v.label).toBe("AirRoute");
    const props = JSON.parse(v.properties as string);
    expect(props.airline).toBe("ANA");
    expect(props.flightNumber).toBe("NH008");
    expect(props.equipment).toBe("Boeing 787-9");
    expect(v.h3Resolution).toBe(3); // global-scale
  });
});

describe("registerBusRoute", () => {
  it("emits BusRoute LineString with operator + ref + serviceDays", async () => {
    const captured: Array<{ uri: string; cid: string; value: Record<string, unknown> }> = [];
    await registerBusRoute(
      {
        name: "Toei #01",
        coords: TWO_COORDS,
        bboxDegrees: [139.0, 35.5, 139.5, 35.7],
        h3Cell: "8a30d8bd2477fff",
        operator: "Toei",
        ref: "01",
        serviceDays: ["mon", "tue", "wed", "thu", "fri"],
      },
      { client: mockClient(captured) },
    );
    const v = captured[0].value;
    expect(v.label).toBe("BusRoute");
    const props = JSON.parse(v.properties as string);
    expect(props.operator).toBe("Toei");
    expect(props.serviceDays).toEqual(["mon", "tue", "wed", "thu", "fri"]);
  });
});

describe("registerWaterway", () => {
  it("emits Waterway LineString with navigable + depth", async () => {
    const captured: Array<{ uri: string; cid: string; value: Record<string, unknown> }> = [];
    await registerWaterway(
      {
        name: "Tone Canal",
        coords: TWO_COORDS,
        bboxDegrees: [139.0, 35.5, 139.5, 35.7],
        h3Cell: "8a30d8bd2477fff",
        navigable: true,
        depthMeters: 4.5,
      },
      { client: mockClient(captured) },
    );
    const v = captured[0].value;
    expect(v.label).toBe("Waterway");
    const props = JSON.parse(v.properties as string);
    expect(props.navigable).toBe(true);
    expect(props.depthMeters).toBe(4.5);
  });
});

// ─── Point helpers ──────────────────────────────────────────────────

describe("registerPort", () => {
  it("emits Port Point with unlocode + operator + portType", async () => {
    const captured: Array<{ uri: string; cid: string; value: Record<string, unknown> }> = [];
    await registerPort(
      {
        name: "Port of Tokyo",
        lng: 139.7768,
        lat: 35.6191,
        h3Cell: "8a30d8bd2477fff",
        unlocode: "JPTYO",
        operator: "Tokyo Port Terminal Co.",
        portType: "cargo+passenger",
      },
      { client: mockClient(captured) },
    );
    const v = captured[0].value;
    expect(v.label).toBe("Port");
    expect(JSON.parse(v.geometryGeoJson as string).type).toBe("Point");
    const props = JSON.parse(v.properties as string);
    expect(props.unlocode).toBe("JPTYO");
  });
});

describe("registerAirport", () => {
  it("emits Airport Point with icao + iata + runway count", async () => {
    const captured: Array<{ uri: string; cid: string; value: Record<string, unknown> }> = [];
    await registerAirport(
      {
        name: "Haneda",
        lng: 139.7798,
        lat: 35.5494,
        h3Cell: "8a30d8bd2477fff",
        icao: "RJTT",
        iata: "HND",
        runwayCount: 4,
      },
      { client: mockClient(captured) },
    );
    const v = captured[0].value;
    expect(v.label).toBe("Airport");
    const props = JSON.parse(v.properties as string);
    expect(props.icao).toBe("RJTT");
    expect(props.iata).toBe("HND");
    expect(props.runwayCount).toBe(4);
  });
});

describe("registerStation", () => {
  it("emits Station Point with operator + lines + accessibility", async () => {
    const captured: Array<{ uri: string; cid: string; value: Record<string, unknown> }> = [];
    await registerStation(
      {
        name: "Tokyo",
        lng: 139.7672,
        lat: 35.6812,
        h3Cell: "8a30d8bd2477fff",
        operator: "JR East",
        lines: ["JY", "JK", "JC", "JT", "JU"],
        wheelchairAccessible: true,
      },
      { client: mockClient(captured) },
    );
    const v = captured[0].value;
    expect(v.label).toBe("Station");
    const props = JSON.parse(v.properties as string);
    expect(props.lines).toEqual(["JY", "JK", "JC", "JT", "JU"]);
    expect(props.wheelchairAccessible).toBe(true);
  });
});

describe("registerBusStop", () => {
  it("emits BusStop Point with operator + lines + shelter", async () => {
    const captured: Array<{ uri: string; cid: string; value: Record<string, unknown> }> = [];
    await registerBusStop(
      {
        name: "Shibuya-eki",
        lng: 139.7016,
        lat: 35.6580,
        h3Cell: "8a30d8bd2477fff",
        operator: "Toei",
        lines: ["01", "06"],
        shelter: true,
      },
      { client: mockClient(captured) },
    );
    const v = captured[0].value;
    expect(v.label).toBe("BusStop");
    const props = JSON.parse(v.properties as string);
    expect(props.shelter).toBe(true);
    expect(v.h3Resolution).toBe(12); // street-level
  });
});

describe("registerParking", () => {
  it("emits Parking Point with type + capacity + fee", async () => {
    const captured: Array<{ uri: string; cid: string; value: Record<string, unknown> }> = [];
    await registerParking(
      {
        name: "Shinjuku Parking Garage",
        lng: 139.7008,
        lat: 35.6896,
        h3Cell: "8a30d8bd2477fff",
        parkingType: "garage",
        capacity: 320,
        fee: true,
      },
      { client: mockClient(captured) },
    );
    const v = captured[0].value;
    expect(v.label).toBe("Parking");
    const props = JSON.parse(v.properties as string);
    expect(props.parkingType).toBe("garage");
    expect(props.capacity).toBe(320);
    expect(props.fee).toBe(true);
  });
});

describe("registerEvCharger", () => {
  it("emits EvCharger Point with operator + chargerType + kw", async () => {
    const captured: Array<{ uri: string; cid: string; value: Record<string, unknown> }> = [];
    await registerEvCharger(
      {
        name: "Shibuya Tesla Supercharger",
        lng: 139.7016,
        lat: 35.6580,
        h3Cell: "8a30d8bd2477fff",
        operator: "Tesla",
        chargerType: "tesla",
        kw: 250,
      },
      { client: mockClient(captured) },
    );
    const v = captured[0].value;
    expect(v.label).toBe("EvCharger");
    const props = JSON.parse(v.properties as string);
    expect(props.chargerType).toBe("tesla");
    expect(props.kw).toBe(250);
  });
});

// ─── L1 witnessed end-to-end ────────────────────────────────────────

describe("L1 witnessed (Tier B) — registerAirport end-to-end", () => {
  it("Haneda Airport with 30-cell fleet → witnessed/accept", async () => {
    const fleet = fleetOf(10, 3);
    const captured: Array<{ uri: string; cid: string; value: Record<string, unknown> }> = [];
    const client = mockClient(captured);
    const transport = createInMemoryWitnessTransport({
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
    const result = await registerAirport(
      {
        name: "Haneda",
        lng: 139.7798,
        lat: 35.5494,
        h3Cell: "8a30d8bd2477fff",
        icao: "RJTT",
        iata: "HND",
        rkey: "haneda-rjtt",
      },
      { client, witness: { fleet, transport } },
    );
    expect(captured[0].value.label).toBe("Airport");
    expect(result.witnessState!.kind).toBe("witnessed");
  });
});

// ─── Geometry validity sweep ────────────────────────────────────────

describe("All 12 Transport helpers emit valid GeoJSON", () => {
  it("LineString + Point outputs all pass isValidGeometryGeoJson", async () => {
    const captured: Array<{ uri: string; cid: string; value: Record<string, unknown> }> = [];
    const client = mockClient(captured);
    const bbox: readonly [number, number, number, number] = [0, 0, 1, 1];
    const cell = "a";

    // 6 LineString features
    await registerRoad({ name: "r", coords: TWO_COORDS, bboxDegrees: bbox, h3Cell: cell }, { client });
    await registerRailway({ name: "r", coords: TWO_COORDS, bboxDegrees: bbox, h3Cell: cell }, { client });
    await registerSeaRoute({ name: "r", coords: TWO_COORDS, bboxDegrees: bbox, h3Cell: cell }, { client });
    await registerAirRoute({ name: "r", coords: TWO_COORDS, bboxDegrees: bbox, h3Cell: cell }, { client });
    await registerBusRoute({ name: "r", coords: TWO_COORDS, bboxDegrees: bbox, h3Cell: cell }, { client });
    await registerWaterway({ name: "r", coords: TWO_COORDS, bboxDegrees: bbox, h3Cell: cell }, { client });

    // 6 Point features
    await registerPort({ name: "p", lng: 0, lat: 0, h3Cell: cell }, { client });
    await registerAirport({ name: "a", lng: 0, lat: 0, h3Cell: cell }, { client });
    await registerStation({ name: "s", lng: 0, lat: 0, h3Cell: cell }, { client });
    await registerBusStop({ name: "b", lng: 0, lat: 0, h3Cell: cell }, { client });
    await registerParking({ name: "p", lng: 0, lat: 0, h3Cell: cell }, { client });
    await registerEvCharger({ name: "e", lng: 0, lat: 0, h3Cell: cell }, { client });

    expect(captured).toHaveLength(12);
    const expectedLabels = [
      "Road", "Railway", "SeaRoute", "AirRoute", "BusRoute", "Waterway",
      "Port", "Airport", "Station", "BusStop", "Parking", "EvCharger",
    ];
    expect(captured.map((c) => c.value.label)).toEqual(expectedLabels);
    for (const c of captured) {
      expect(isValidGeometryGeoJson(c.value.geometryGeoJson as string)).toBe(true);
    }
  });
});

// ─── LineString min-coord enforcement sweep ─────────────────────────

describe("LineString helpers reject single-coord input", () => {
  const lineStringHelpers = [
    ["registerRoad", registerRoad],
    ["registerRailway", registerRailway],
    ["registerSeaRoute", registerSeaRoute],
    ["registerAirRoute", registerAirRoute],
    ["registerBusRoute", registerBusRoute],
    ["registerWaterway", registerWaterway],
  ] as const;

  it.each(lineStringHelpers)("%s rejects 1-coord input", async (_name, helper) => {
    const singleCoord = [[0, 0]] as unknown as ReadonlyArray<readonly [number, number]>;
    await expect(
      helper(
        { name: "x", coords: singleCoord, bboxDegrees: [0, 0, 0, 0], h3Cell: "a" },
        { client: mockClient() },
      ),
    ).rejects.toThrow(/≥2 coordinates/);
  });
});
