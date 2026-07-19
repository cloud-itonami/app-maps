import { describe, expect, it } from "vitest";

import { normalizeMapsVertexIdentity } from "./vertex-identity";

describe("maps vertex identity", () => {
  it("normalizes actorId to the maps actor DID and derives a DID from nodeId", () => {
    expect(normalizeMapsVertexIdentity("maps", "building", {
      actorId: "maps",
      nodeId: "bldg:tokyo-station",
      name: "Tokyo Station",
    })).toEqual({
      actorId: "did:web:maps.etzhayyim.com",
      nodeId: "bldg:tokyo-station",
      name: "Tokyo Station",
      did: "did:web:maps.etzhayyim.com:building:bldg-tokyo-station",
    });
  });

  it("promotes explicit collection DID fields to canonical did", () => {
    expect(normalizeMapsVertexIdentity("maps", "airport", {
      actorId: "maps",
      airportDid: "did:web:maps.etzhayyim.com:airport:haneda",
      nodeId: "airport:apt-1",
    })).toEqual({
      actorId: "did:web:maps.etzhayyim.com",
      airportDid: "did:web:maps.etzhayyim.com:airport:haneda",
      nodeId: "airport:apt-1",
      did: "did:web:maps.etzhayyim.com:airport:haneda",
    });
  });

  it("preserves explicitly provided actor DID and vertex DID", () => {
    expect(normalizeMapsVertexIdentity("maps", "propertyRegistry", {
      actorId: "did:web:maps.etzhayyim.com",
      did: "did:web:maps.etzhayyim.com:property-registry:jp-123",
      registryNumber: "JP-123",
    })).toEqual({
      actorId: "did:web:maps.etzhayyim.com",
      did: "did:web:maps.etzhayyim.com:property-registry:jp-123",
      registryNumber: "JP-123",
    });
  });
});
