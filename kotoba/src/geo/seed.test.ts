import { describe, expect, it } from "vitest";

import { toLayerCoordinator, toNaturalZone, toVerticalZone } from "./seed.js";

describe("toVerticalZone", () => {
  it("preserves all fields + defaults registeredAt", () => {
    const out = toVerticalZone({
      slug: "atmosphere-troposphere",
      kind: "atmosphere",
      name: "Troposphere",
      minMeters: 0,
      maxMeters: 12000,
    });
    expect(out.v).toBe(1);
    expect(out.kind).toBe("atmosphere");
    expect(out.minMeters).toBe(0);
    expect(out.maxMeters).toBe(12000);
    expect(out.registeredAt).toBe("2026-05-23T00:00:00Z");
  });

  it("allows optional minMeters / maxMeters absent", () => {
    const out = toVerticalZone({
      slug: "atmosphere-exosphere",
      kind: "atmosphere",
      name: "Exosphere",
    });
    expect(out.minMeters).toBeUndefined();
    expect(out.maxMeters).toBeUndefined();
  });
});

describe("toNaturalZone", () => {
  it("preserves all fields", () => {
    const out = toNaturalZone({
      slug: "koppen-a",
      kind: "koppen",
      code: "A",
      name: "Tropical climates",
      description: "Köppen A",
    });
    expect(out.code).toBe("A");
    expect(out.description).toBe("Köppen A");
  });

  it("supports all three kinds", () => {
    const koppen = toNaturalZone({ slug: "koppen-b", kind: "koppen", code: "B", name: "Arid" });
    const biome = toNaturalZone({ slug: "biome-tundra", kind: "biome", code: "11", name: "Tundra" });
    const tectonic = toNaturalZone({ slug: "tectonic-pacific", kind: "tectonic", code: "PA", name: "Pacific Plate" });
    expect(koppen.kind).toBe("koppen");
    expect(biome.kind).toBe("biome");
    expect(tectonic.kind).toBe("tectonic");
  });
});

describe("toLayerCoordinator", () => {
  it("derives DID from slug", () => {
    const out = toLayerCoordinator({
      slug: "building",
      displayName: "Building (3D extrusion)",
    });
    expect(out.did).toBe("did:web:maps.etzhayyim.com:layer:building");
    expect(out.displayName).toBe("Building (3D extrusion)");
  });
});
