/**
 * Pure-helper tests for feature lexicon types.
 *
 * Lexicon shape validation lives in `membrane.test.ts` (featureSchemaValidator).
 * Integration of registerFeature + writeWithWitnesses lives in
 * `witnessed.test.ts` — the load-bearing end-to-end Tier B demo.
 */

import { describe, expect, it } from "vitest";

import {
  bboxFromDegrees,
  isValidGeometryGeoJson,
  isValidH3Resolution,
  isValidLabel,
  lineStringGeometry,
  pointBbox,
  pointGeometry,
  polygonGeometry,
} from "./types.js";

describe("pointGeometry", () => {
  it("emits GeoJSON Point with lng-first coordinates", () => {
    const g = JSON.parse(pointGeometry(139.69171, 35.6895));
    expect(g.type).toBe("Point");
    expect(g.coordinates).toEqual([139.69171, 35.6895]);
  });
});

describe("lineStringGeometry", () => {
  it("preserves coord order", () => {
    const g = JSON.parse(lineStringGeometry([[0, 0], [1, 1], [2, 2]]));
    expect(g.type).toBe("LineString");
    expect(g.coordinates).toEqual([[0, 0], [1, 1], [2, 2]]);
  });
});

describe("polygonGeometry", () => {
  it("emits Polygon with rings array", () => {
    const ring: readonly (readonly [number, number])[] = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
    const g = JSON.parse(polygonGeometry([ring]));
    expect(g.type).toBe("Polygon");
    expect(g.coordinates).toHaveLength(1);
    expect(g.coordinates[0]).toEqual([[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]);
  });
});

describe("pointBbox", () => {
  it("microdegree-encodes, west=east, south=north", () => {
    const b = pointBbox(139.69171, 35.6895);
    expect(b.bboxWestE7).toBe(1396917100);
    expect(b.bboxSouthE7).toBe(356895000);
    expect(b.bboxEastE7).toBe(b.bboxWestE7);
    expect(b.bboxNorthE7).toBe(b.bboxSouthE7);
  });

  it("handles negative coords (Southern / Western hemisphere)", () => {
    const b = pointBbox(-122.4194, 37.7749);
    expect(b.bboxWestE7).toBe(-1224194000);
    expect(b.bboxSouthE7).toBe(377749000);
  });
});

describe("bboxFromDegrees", () => {
  it("preserves the [w, s, e, n] tuple in microdegrees", () => {
    const b = bboxFromDegrees(139.5, 35.5, 139.9, 35.8);
    expect(b.bboxWestE7).toBe(1395000000);
    expect(b.bboxSouthE7).toBe(355000000);
    expect(b.bboxEastE7).toBe(1399000000);
    expect(b.bboxNorthE7).toBe(358000000);
  });
});

describe("isValidLabel", () => {
  it.each([
    ["Mountain", true],
    ["Building", true],
    ["A", true],
    ["x".repeat(64), true],
    ["", false],
    ["x".repeat(65), false],
  ])("isValidLabel(%j) === %s", (label, expected) => {
    expect(isValidLabel(label as string)).toBe(expected);
  });
});

describe("isValidH3Resolution", () => {
  it.each([
    [0, true],
    [8, true],
    [15, true],
    [-1, false],
    [16, false],
    [8.5, false],
  ])("isValidH3Resolution(%s) === %s", (r, expected) => {
    expect(isValidH3Resolution(r)).toBe(expected);
  });
});

describe("isValidGeometryGeoJson", () => {
  it("accepts standard GeoJSON Geometry types", () => {
    expect(isValidGeometryGeoJson(pointGeometry(0, 0))).toBe(true);
    expect(isValidGeometryGeoJson(lineStringGeometry([[0, 0], [1, 1]]))).toBe(true);
    expect(isValidGeometryGeoJson(polygonGeometry([[[0, 0], [1, 0], [1, 1], [0, 0]]]))).toBe(true);
    expect(isValidGeometryGeoJson(JSON.stringify({ type: "MultiPolygon", coordinates: [] }))).toBe(true);
  });

  it.each([
    ["not json", false],
    ["null", false],
    ["[1, 2, 3]", false],
    [JSON.stringify({ coordinates: [0, 0] }), false], // no type
    [JSON.stringify({ type: "Foo", coordinates: [] }), false], // unknown type
  ])("rejects %j", (s, expected) => {
    expect(isValidGeometryGeoJson(s)).toBe(expected);
  });
});
