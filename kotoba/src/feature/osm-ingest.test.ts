/**
 * OSM GeoJSON → registerFeature bulk ingest tests.
 *
 * Pure converter tests + E2E bulk smoke against a mock RegisterFeatureClient.
 * Fixtures use small representative OSM tag sets (boundary / highway / railway
 * / waterway / natural / building / aeroway / public_transport).
 */

import { describe, expect, it } from "vitest";

import {
  OSM_SOURCE_DID,
  defaultTagToLabel,
  ingestFromOsmGeoJson,
  osmFeatureToRegisterInput,
  rkeyFromOsmId,
  type OsmGeoJsonFeature,
} from "./osm-ingest.js";
import type { RegisterFeatureClient } from "./index.js";

// ─── fixtures ─────────────────────────────────────────────────────────

function fc<T extends OsmGeoJsonFeature>(...features: T[]): T[] {
  return features;
}

const TOKYO_BOUNDARY: OsmGeoJsonFeature = {
  type: "Feature",
  id: "r1543125",
  properties: {
    name: "東京都",
    "name:en": "Tokyo",
    boundary: "administrative",
    admin_level: "4",
  },
  geometry: {
    type: "Polygon",
    coordinates: [[[139.5, 35.5], [139.9, 35.5], [139.9, 35.8], [139.5, 35.8], [139.5, 35.5]]],
  },
};

const ROUTE_1_ROAD: OsmGeoJsonFeature = {
  type: "Feature",
  id: "w123456",
  properties: {
    name: "Route 1",
    highway: "primary",
    ref: "1",
  },
  geometry: {
    type: "LineString",
    coordinates: [[139.0, 35.5], [139.5, 35.7]],
  },
};

const YAMANOTE_RAIL: OsmGeoJsonFeature = {
  type: "Feature",
  id: "w234567",
  properties: {
    name: "JR Yamanote Line",
    railway: "rail",
    operator: "JR East",
  },
  geometry: {
    type: "LineString",
    coordinates: [[139.701, 35.658], [139.767, 35.681]],
  },
};

const TAMA_RIVER_OSM: OsmGeoJsonFeature = {
  type: "Feature",
  id: "w345678",
  properties: { name: "Tama-gawa", waterway: "river" },
  geometry: { type: "LineString", coordinates: [[138.85, 35.85], [139.78, 35.53]] },
};

const FUJI_PEAK: OsmGeoJsonFeature = {
  type: "Feature",
  id: "n456789",
  properties: { name: "Mount Fuji", natural: "peak", ele: "3776" },
  geometry: { type: "Point", coordinates: [138.7274, 35.3606] },
};

const HND_AIRPORT: OsmGeoJsonFeature = {
  type: "Feature",
  id: "w567890",
  properties: { name: "Haneda", aeroway: "aerodrome", iata: "HND", icao: "RJTT" },
  geometry: { type: "Polygon", coordinates: [[[139.77, 35.54], [139.79, 35.54], [139.79, 35.56], [139.77, 35.56], [139.77, 35.54]]] },
};

const SHINJUKU_STA_OSM: OsmGeoJsonFeature = {
  type: "Feature",
  id: "n678901",
  properties: { name: "Shinjuku", railway: "station", public_transport: "station", train: "yes" },
  geometry: { type: "Point", coordinates: [139.7006, 35.6896] },
};

const TOKYO_BUS_STOP: OsmGeoJsonFeature = {
  type: "Feature",
  id: "n789012",
  properties: { name: "渋谷駅前", highway: "bus_stop" },
  geometry: { type: "Point", coordinates: [139.7016, 35.6580] },
};

const KASUMIGASEKI_BUILDING: OsmGeoJsonFeature = {
  type: "Feature",
  id: "w890123",
  properties: { name: "霞が関ビル", building: "office" },
  geometry: {
    type: "Polygon",
    coordinates: [[[139.74, 35.673], [139.741, 35.673], [139.741, 35.674], [139.74, 35.674], [139.74, 35.673]]],
  },
};

const TAMARIVER_TOWN: OsmGeoJsonFeature = {
  type: "Feature",
  id: "n901234",
  properties: { name: "Tamarí", place: "town", population: "1234" },
  geometry: { type: "Point", coordinates: [139.5, 35.6] },
};

const NO_USEFUL_TAGS: OsmGeoJsonFeature = {
  type: "Feature",
  id: "n111111",
  properties: { source: "survey" }, // no tag the mapper picks up
  geometry: { type: "Point", coordinates: [0, 0] },
};

// ─── defaultTagToLabel ──────────────────────────────────────────────

describe("defaultTagToLabel", () => {
  it.each([
    [{ boundary: "administrative", admin_level: "4" }, "AdminArea"],
    [{ highway: "primary" }, "Road"],
    [{ railway: "rail" }, "Railway"],
    [{ waterway: "river" }, "River"],
    [{ waterway: "canal" }, "Waterway"],
    [{ natural: "peak" }, "Mountain"],
    [{ natural: "volcano" }, "Mountain"],
    [{ natural: "water", water: "lake" }, "Lake"],
    [{ natural: "coastline" }, "Coastline"],
    [{ aeroway: "aerodrome" }, "Airport"],
    [{ harbour: "yes" }, "Port"],
    [{ "seamark:type": "harbour" }, "Port"],
    [{ landuse: "port" }, "Port"],
    [{ railway: "station" }, "Railway"], // railway-key matches Railway first
    [{ public_transport: "station", train: "yes" }, "Station"],
    [{ highway: "bus_stop" }, "Road"],   // highway matches Road first
    [{ public_transport: "platform", bus: "yes" }, "BusStop"],
    [{ amenity: "parking" }, "Parking"],
    [{ amenity: "charging_station" }, "EvCharger"],
    [{ building: "office" }, "Building"],
    [{ place: "city" }, "Place"],
    [{ place: "village" }, "Place"],
    [{ boundary: "maritime" }, "MaritimeZone"],
    [{ amenity: "school" }, "Spot"],
    [{ leisure: "park" }, "Spot"],
    [{ tourism: "museum" }, "Spot"],
  ])("tagToLabel(%j) === %j", (tags, expected) => {
    expect(defaultTagToLabel(tags)).toBe(expected);
  });

  it("returns null for tags the mapper doesn't recognize", () => {
    expect(defaultTagToLabel({ source: "survey" })).toBeNull();
    expect(defaultTagToLabel({})).toBeNull();
  });
});

// ─── rkeyFromOsmId ──────────────────────────────────────────────────

describe("rkeyFromOsmId", () => {
  it.each([
    ["n12345", "osm-n12345"],
    ["w67890", "osm-w67890"],
    ["r54321", "osm-r54321"],
  ])("rkeyFromOsmId(%j) === %j", (osmId, expected) => {
    expect(rkeyFromOsmId(osmId)).toBe(expected);
  });

  it("returns undefined for invalid / missing ids", () => {
    expect(rkeyFromOsmId(undefined)).toBeUndefined();
    expect(rkeyFromOsmId("x999")).toBeUndefined();
    expect(rkeyFromOsmId("")).toBeUndefined();
  });

  it("respects custom prefix", () => {
    expect(rkeyFromOsmId("n12345", "osm-jp-")).toBe("osm-jp-n12345");
  });
});

// ─── osmFeatureToRegisterInput ──────────────────────────────────────

describe("osmFeatureToRegisterInput", () => {
  it("Tokyo polygon → AdminArea with name + bbox + sourceDid", () => {
    const conv = osmFeatureToRegisterInput(TOKYO_BOUNDARY);
    expect(conv).not.toBeNull();
    if (!conv) return;
    expect(conv.label).toBe("AdminArea");
    expect(conv.input.label).toBe("AdminArea");
    expect(conv.input.name).toBe("東京都");
    expect(conv.input.rkey).toBe("osm-r1543125");
    expect(conv.input.sourceDid).toBe(OSM_SOURCE_DID);
    expect(JSON.parse(conv.input.geometryGeoJson).type).toBe("Polygon");
    expect(conv.input.bboxWestE7).toBe(1395000000);
    expect(conv.input.bboxNorthE7).toBe(358000000);
  });

  it("Road LineString → Road", () => {
    const conv = osmFeatureToRegisterInput(ROUTE_1_ROAD);
    expect(conv!.label).toBe("Road");
    expect(JSON.parse(conv!.input.geometryGeoJson).type).toBe("LineString");
  });

  it("Railway LineString → Railway", () => {
    expect(osmFeatureToRegisterInput(YAMANOTE_RAIL)!.label).toBe("Railway");
  });

  it("River LineString → River", () => {
    expect(osmFeatureToRegisterInput(TAMA_RIVER_OSM)!.label).toBe("River");
  });

  it("Peak Point → Mountain", () => {
    expect(osmFeatureToRegisterInput(FUJI_PEAK)!.label).toBe("Mountain");
  });

  it("aerodrome polygon → Airport", () => {
    expect(osmFeatureToRegisterInput(HND_AIRPORT)!.label).toBe("Airport");
  });

  it("railway=station Point → Railway (railway-key wins over station discriminator)", () => {
    // Documented quirk: a station-tagged node with `railway=station` lands
    // as Railway because the first tag the mapper hits is `railway`.
    // Operators wanting Station label pass `tagToLabel` override.
    expect(osmFeatureToRegisterInput(SHINJUKU_STA_OSM)!.label).toBe("Railway");
  });

  it("bus_stop Point with overridden tagToLabel routes to BusStop", () => {
    const conv = osmFeatureToRegisterInput(TOKYO_BUS_STOP, {
      tagToLabel: (tags) => (tags.highway === "bus_stop" ? "BusStop" : null),
    });
    expect(conv!.label).toBe("BusStop");
  });

  it("Building polygon → Building", () => {
    expect(osmFeatureToRegisterInput(KASUMIGASEKI_BUILDING)!.label).toBe("Building");
  });

  it("place=town Point → Place", () => {
    expect(osmFeatureToRegisterInput(TAMARIVER_TOWN)!.label).toBe("Place");
  });

  it("returns null when no tag triggers a label", () => {
    expect(osmFeatureToRegisterInput(NO_USEFUL_TAGS)).toBeNull();
  });

  it("falls back to name:en when name absent", () => {
    const f: OsmGeoJsonFeature = {
      type: "Feature",
      id: "n1",
      properties: { "name:en": "English Only", natural: "peak" },
      geometry: { type: "Point", coordinates: [0, 0] },
    };
    expect(osmFeatureToRegisterInput(f)!.input.name).toBe("English Only");
  });

  it("uses caller-provided h3 lookup", () => {
    const conv = osmFeatureToRegisterInput(FUJI_PEAK, {
      h3Cell: (lat, lng, r) => `h3-${lat.toFixed(2)}-${lng.toFixed(2)}-${r}`,
      h3Resolution: 10,
    });
    expect(conv!.input.h3Cell).toBe("h3-35.36-138.73-10");
    expect(conv!.input.h3Resolution).toBe(10);
  });

  it("falls back to unknown-res placeholder when no h3 lookup", () => {
    const conv = osmFeatureToRegisterInput(FUJI_PEAK, { h3Resolution: 9 });
    expect(conv!.input.h3Cell).toBe("unknown-res9");
  });

  it("Polygon bbox spans the ring (microdegree-encoded)", () => {
    const conv = osmFeatureToRegisterInput(TOKYO_BOUNDARY);
    expect(conv!.input.bboxWestE7).toBe(1395000000);
    expect(conv!.input.bboxSouthE7).toBe(355000000);
    expect(conv!.input.bboxEastE7).toBe(1399000000);
    expect(conv!.input.bboxNorthE7).toBe(358000000);
  });

  it("MultiPolygon geometry passes through verbatim", () => {
    const mp: OsmGeoJsonFeature = {
      type: "Feature",
      id: "r9999",
      properties: { boundary: "administrative", admin_level: "6" },
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
          [[[2, 2], [3, 2], [3, 3], [2, 3], [2, 2]]],
        ],
      },
    };
    const conv = osmFeatureToRegisterInput(mp);
    const geom = JSON.parse(conv!.input.geometryGeoJson);
    expect(geom.type).toBe("MultiPolygon");
    expect(geom.coordinates).toHaveLength(2);
  });
});

// ─── ingestFromOsmGeoJson (E2E smoke) ──────────────────────────────

function mockClient(captured: Array<{ collection: string; rkey?: string; value: Record<string, unknown> }> = []): RegisterFeatureClient {
  let counter = 0;
  return {
    async write(opts) {
      counter += 1;
      captured.push({ collection: opts.collection, rkey: opts.rkey, value: opts.record });
      return {
        uri: `at://did:web:maps.etzhayyim.com/${opts.collection}/${opts.rkey ?? `tid-${counter}`}`,
        cid: `bafy-osm-${counter.toString().padStart(8, "0")}`,
      };
    },
  };
}

describe("ingestFromOsmGeoJson — E2E smoke", () => {
  const features = fc(
    TOKYO_BOUNDARY,    // AdminArea
    ROUTE_1_ROAD,      // Road
    YAMANOTE_RAIL,     // Railway
    TAMA_RIVER_OSM,    // River
    FUJI_PEAK,         // Mountain
    HND_AIRPORT,       // Airport
    KASUMIGASEKI_BUILDING, // Building
    TAMARIVER_TOWN,    // Place
    NO_USEFUL_TAGS,    // skipped
  );

  it("9 features in / 8 written (1 skipped no-label)", async () => {
    const captured: Array<{ collection: string; rkey?: string; value: Record<string, unknown> }> = [];
    const stats = await ingestFromOsmGeoJson(features, { client: mockClient(captured) });
    expect(stats.totalFeatures).toBe(9);
    expect(stats.skippedNoLabel).toBe(1);
    expect(stats.attempted).toBe(8);
    expect(stats.ok).toBe(8);
    expect(stats.failed).toBe(0);
    expect(captured).toHaveLength(8);
    expect(captured.every((c) => c.collection === "com.etzhayyim.maps.feature")).toBe(true);
    expect(stats.labelCounts).toEqual({
      AdminArea: 1, Road: 1, Railway: 1, River: 1,
      Mountain: 1, Airport: 1, Building: 1, Place: 1,
    });
  });

  it("labelFilter narrows to subset", async () => {
    const stats = await ingestFromOsmGeoJson(features, {
      client: mockClient(),
      labelFilter: ["Road", "Railway"],
    });
    // YAMANOTE_RAIL railway=rail → Railway. SHINJUKU_STA railway=station also matches Railway
    // (but SHINJUKU_STA is not in the fixtures here). So Railway = 1 (YAMANOTE_RAIL).
    expect(stats.ok).toBe(2);
    expect(stats.skippedLabelFilter).toBe(6);
    expect(stats.labelCounts).toEqual({ Road: 1, Railway: 1 });
  });

  it("maxRecords caps the run", async () => {
    const stats = await ingestFromOsmGeoJson(features, {
      client: mockClient(),
      maxRecords: 3,
    });
    expect(stats.ok).toBe(3);
    expect(stats.skippedMaxRecords).toBeGreaterThan(0);
  });

  it("every record carries the OSM source DID", async () => {
    const captured: Array<{ value: Record<string, unknown> }> = [];
    await ingestFromOsmGeoJson(features, { client: mockClient(captured as any) });
    for (const c of captured) {
      expect(c.value.sourceDid).toBe(OSM_SOURCE_DID);
    }
  });

  it("failFastAfter aborts on first failure", async () => {
    const breakingClient: RegisterFeatureClient = {
      async write() {
        throw new Error("PDS 500");
      },
    };
    const stats = await ingestFromOsmGeoJson(features, {
      client: breakingClient,
      failFastAfter: 1,
    });
    expect(stats.failed).toBe(1);
    expect(stats.attempted).toBe(1);
  });
});
