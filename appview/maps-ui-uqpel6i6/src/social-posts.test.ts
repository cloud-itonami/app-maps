import { describe, expect, it } from "vitest";

import { buildMapsSocialPost } from "./social-posts";

describe("maps social post formatter", () => {
  it("formats building updates", () => {
    expect(buildMapsSocialPost("building", {
      name: "Tokyo Midtown Yaesu",
      floors: 45,
      heightM: 240,
      city: "Tokyo",
    })).toBe("[Building] Tokyo Midtown Yaesu (45F / 240m / Tokyo)\ncc @jinushi.etzhayyim.com");
  });

  it("formats land registry updates", () => {
    expect(buildMapsSocialPost("landRegistry", {
      registryNumber: "JP-13-0001",
      jurisdiction: "Tokyo",
      propertyType: "residential",
    })).toBe("[LandRegistry] JP-13-0001 (Tokyo, residential)\ncc @jinushi.etzhayyim.com");
  });

  it("ignores unrelated collections", () => {
    expect(buildMapsSocialPost("route", { name: "Test Route" })).toBeNull();
  });
});
