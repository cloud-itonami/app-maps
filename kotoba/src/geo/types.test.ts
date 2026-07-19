import { describe, expect, it } from "vitest";

import {
  GEO_SCHEMES,
  LAYER_SLUGS,
  aliasKeyFor,
  didForLayer,
  didForRegion,
  isValidNanoid,
  nanoidForRegionDid,
} from "./types.js";

describe("didForRegion / nanoidForRegionDid round-trip", () => {
  it.each([
    ["jp", "did:web:maps.etzhayyim.com:region:jp"],
    ["jp-tokyo", "did:web:maps.etzhayyim.com:region:jp-tokyo"],
    ["us-ca-sf", "did:web:maps.etzhayyim.com:region:us-ca-sf"],
    ["xyz123", "did:web:maps.etzhayyim.com:region:xyz123"],
  ])("didForRegion(%s) === %s", (nanoid, expected) => {
    expect(didForRegion(nanoid)).toBe(expected);
    expect(nanoidForRegionDid(expected)).toBe(nanoid);
  });

  it.each([
    ["JP"],
    ["jp_underscore"],
    ["leading-"],
    ["-trailing"],
    ["a"],
    [""],
  ])("rejects invalid nanoid %j", (nanoid) => {
    expect(() => didForRegion(nanoid)).toThrow(/invalid region nanoid/);
  });

  it("rejects non-region DID", () => {
    expect(() => nanoidForRegionDid("did:web:maps.etzhayyim.com:layer:tile")).toThrow(/not a region DID/);
  });
});

describe("isValidNanoid", () => {
  it.each([
    ["jp", true],
    ["jp-tokyo", true],
    ["us-ca-san-francisco", true],
    ["abcd", true],
    ["abc", true],
    ["ab", true],
    ["a", false],
    ["", false],
    ["JP", false],
    ["jp_tokyo", false],
    ["leading-", false],
    ["-trailing", false],
  ])("isValidNanoid(%j) === %s", (s, expected) => {
    expect(isValidNanoid(s)).toBe(expected);
  });
});

describe("aliasKeyFor", () => {
  it.each([
    ["iso3166-1", "JP", "iso3166-1-jp"],
    ["iso3166-2", "JP-13", "iso3166-2-jp-13"],
    ["jis-x0401", "13", "jis-x0401-13"],
    ["unlocode", "JPTYO", "unlocode-jptyo"],
    ["iana-tz", "Asia/Tokyo", "iana-tz-asia-tokyo"],
    ["iata-airport", "HND", "iata-airport-hnd"],
    ["icao-airport", "RJTT", "icao-airport-rjtt"],
    ["koppen", "Cfa", "koppen-cfa"],
    ["mgrs", "54S UE 8889 4789", "mgrs-54s-ue-8889-4789"],
  ])("aliasKeyFor(%s, %s) === %s", (scheme, code, expected) => {
    // @ts-expect-error — narrow scheme literal for test input
    expect(aliasKeyFor(scheme, code)).toBe(expected);
  });

  it("rejects empty code", () => {
    expect(() => aliasKeyFor("koppen", "")).toThrow(/empty code/);
  });
});

describe("constants", () => {
  it("GEO_SCHEMES has 29 entries", () => {
    expect(GEO_SCHEMES).toHaveLength(29);
  });

  it("LAYER_SLUGS has 11 entries", () => {
    expect(LAYER_SLUGS).toHaveLength(11);
  });

  it("all GEO_SCHEMES are unique", () => {
    const set = new Set(GEO_SCHEMES);
    expect(set.size).toBe(GEO_SCHEMES.length);
  });

  it("all LAYER_SLUGS are unique", () => {
    const set = new Set(LAYER_SLUGS);
    expect(set.size).toBe(LAYER_SLUGS.length);
  });
});

describe("didForLayer", () => {
  it.each([
    ["tile" as const, "did:web:maps.etzhayyim.com:layer:tile"],
    ["building" as const, "did:web:maps.etzhayyim.com:layer:building"],
    ["satellite" as const, "did:web:maps.etzhayyim.com:layer:satellite"],
  ])("didForLayer(%s) === %s", (slug, expected) => {
    expect(didForLayer(slug)).toBe(expected);
  });
});
