import { describe, expect, it } from "vitest";

import { extractGeomFromRow, parseProps } from "./geometry";

describe("geometry decode", () => {
  it("accepts props already materialized as an object", () => {
    expect(parseProps({ foo: "bar" })).toEqual({ foo: "bar" });
  });

  it("decodes nested GeoJSON stored as a JSON string inside props.geometry", () => {
    const row = {
      props: JSON.stringify({
        geometry: JSON.stringify({
          type: "Polygon",
          coordinates: [[[139.0, 35.0], [140.0, 35.0], [140.0, 36.0], [139.0, 35.0]]],
        }),
      }),
      lat: "35.25",
      lng: "139.25",
    };

    expect(extractGeomFromRow(row)).toEqual({
      type: "Polygon",
      coordinates: [[[139.0, 35.0], [140.0, 35.0], [140.0, 36.0], [139.0, 35.0]]],
    });
  });

  it("falls back to point geometry when no polygon is present", () => {
    expect(extractGeomFromRow({ lat: "35.6812", lng: "139.7671" })).toEqual({
      type: "Point",
      coordinates: [139.7671, 35.6812],
    });
  });
});
