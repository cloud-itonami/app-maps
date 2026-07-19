/**
 * Pure-helper tests — slug↔DID round-trip + TTL syntax validation.
 *
 * These lock down the DID-shape invariants for com.etzhayyim.maps.source
 * so the seeder cannot silently mis-route a source DID. Failures here
 * indicate the slug grammar changed deliberately (rare — usually a new
 * registry category) or the maps CLAUDE.md source DID list drifted.
 */

import { describe, expect, it } from "vitest";

import { didForSlug, isValidTtl, slugForDid } from "./types.js";

describe("didForSlug", () => {
  it.each([
    ["geocode", "did:web:maps.etzhayyim.com:geocode"],
    ["weather", "did:web:maps.etzhayyim.com:weather"],
    ["ip-geolocation", "did:web:maps.etzhayyim.com:ip:geolocation"],
    ["registry-openflights", "did:web:maps.etzhayyim.com:registry:openflights"],
    ["registry-osm-ferry", "did:web:maps.etzhayyim.com:registry:osm:ferry"],
    ["registry-jp-moj", "did:web:maps.etzhayyim.com:registry:jp:moj"],
    ["registry-jp-nta", "did:web:maps.etzhayyim.com:registry:jp:nta"],
    ["registry-uk-ch", "did:web:maps.etzhayyim.com:registry:uk:ch"],
    ["registry-us-edgar", "did:web:maps.etzhayyim.com:registry:us:edgar"],
    ["registry-eu-br", "did:web:maps.etzhayyim.com:registry:eu:br"],
    ["registry-openaddresses", "did:web:maps.etzhayyim.com:registry:openaddresses"],
    ["registry-gleif", "did:web:maps.etzhayyim.com:registry:gleif"],
    ["registry-opencorporates", "did:web:maps.etzhayyim.com:registry:opencorporates"],
    ["registry-wikidata", "did:web:maps.etzhayyim.com:registry:wikidata"],
    ["registry-osm", "did:web:maps.etzhayyim.com:registry:osm"],
    ["street-view", "did:web:maps.etzhayyim.com:street:view"],
    ["user-post", "did:web:maps.etzhayyim.com:user:post"],
    ["satellite", "did:web:maps.etzhayyim.com:satellite"],
    ["seismic", "did:web:maps.etzhayyim.com:seismic"],
    ["gtfs", "did:web:maps.etzhayyim.com:gtfs"],
    ["infrastructure", "did:web:maps.etzhayyim.com:infrastructure"],
    ["tile", "did:web:maps.etzhayyim.com:tile"],
    ["planet", "did:web:maps.etzhayyim.com:planet"],
    ["mapraly", "did:web:maps.etzhayyim.com:mapraly"],
    ["vision", "did:web:maps.etzhayyim.com:vision"],
  ])("didForSlug(%s) === %s", (slug, expected) => {
    expect(didForSlug(slug)).toBe(expected);
  });

  it.each([
    [""],
    ["Geocode"],
    ["with_underscore"],
    ["with space"],
    ["UPPER"],
    ["leading-"],
    ["-trailing"],
    ["registry/openflights"],
  ])("rejects invalid slug %j", (slug) => {
    expect(() => didForSlug(slug)).toThrow(/invalid source slug/);
  });
});

describe("slugForDid", () => {
  it.each([
    ["did:web:maps.etzhayyim.com:geocode", "geocode"],
    ["did:web:maps.etzhayyim.com:registry:openflights", "registry-openflights"],
    ["did:web:maps.etzhayyim.com:registry:osm:ferry", "registry-osm-ferry"],
  ])("slugForDid(%s) === %s", (did, expected) => {
    expect(slugForDid(did)).toBe(expected);
  });

  it("rejects non-maps DID", () => {
    expect(() => slugForDid("did:web:site.etzhayyim.com")).toThrow(/not a maps path-DID/);
    expect(() => slugForDid("did:plc:abc123")).toThrow(/not a maps path-DID/);
  });
});

describe("isValidTtl", () => {
  it.each([
    "permanent",
    "PT15M",
    "PT1H",
    "P1D",
    "P7D",
    "P30D",
  ])("accepts %s", (ttl) => {
    expect(isValidTtl(ttl)).toBe(true);
  });

  it.each([
    "",
    "forever",
    "1h",
    "P-1D",
    "PT",
  ])("rejects %j", (ttl) => {
    expect(isValidTtl(ttl)).toBe(false);
  });
});
