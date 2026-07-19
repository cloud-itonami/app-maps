/**
 * Seed converter test — toMapsSource maps a SourceSeed into the
 * Lexicon record shape correctly. Pure: no PDS write.
 */

import { describe, expect, it } from "vitest";

import { toMapsSource } from "./seed.js";

describe("toMapsSource", () => {
  it("derives DID from slug when missing", () => {
    const out = toMapsSource({
      slug: "geocode",
      displayName: "Geocoding",
      externalSource: "Nominatim",
      ttl: "permanent",
      status: "active",
    });
    expect(out.did).toBe("did:web:maps.etzhayyim.com:geocode");
    expect(out.v).toBe(1);
    expect(out.registeredAt).toBe("2026-05-23T00:00:00Z");
  });

  it("preserves explicit DID when provided", () => {
    const out = toMapsSource({
      slug: "geocode",
      did: "did:web:maps.etzhayyim.com:legacy:geocode",
      displayName: "Geocoding (legacy alias)",
      externalSource: "Nominatim",
      ttl: "permanent",
      status: "deprecated",
    });
    expect(out.did).toBe("did:web:maps.etzhayyim.com:legacy:geocode");
    expect(out.status).toBe("deprecated");
  });

  it("rejects invalid ttl", () => {
    expect(() =>
      toMapsSource({
        slug: "weather",
        displayName: "W",
        externalSource: "x",
        ttl: "1 hour",
        status: "active",
      }),
    ).toThrow(/invalid ttl/);
  });

  it("preserves notes + supersedesDid + license + category", () => {
    const out = toMapsSource({
      slug: "registry-gleif",
      displayName: "GLEIF",
      externalSource: "GLEIF",
      ttl: "P30D",
      license: "CC0-1.0",
      category: "registry",
      status: "active",
      supersedesDid: "did:web:maps.etzhayyim.com:registry:gleif:v0",
      notes: "P0",
    });
    expect(out.license).toBe("CC0-1.0");
    expect(out.category).toBe("registry");
    expect(out.supersedesDid).toBe("did:web:maps.etzhayyim.com:registry:gleif:v0");
    expect(out.notes).toBe("P0");
  });

  it("respects explicit registeredAt", () => {
    const out = toMapsSource({
      slug: "tile",
      displayName: "Tile",
      externalSource: "OpenFreeMap",
      ttl: "P30D",
      status: "active",
      registeredAt: "2025-12-01T00:00:00Z",
    });
    expect(out.registeredAt).toBe("2025-12-01T00:00:00Z");
  });
});
