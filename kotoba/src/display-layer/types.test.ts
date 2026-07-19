import { describe, expect, it } from "vitest";

import { DISPLAY_LAYER_KINDS, isValidLayerId, isValidZoomRange } from "./types.js";

describe("isValidLayerId", () => {
  it.each([
    ["tokyo-real-estate", true],
    ["seismic-7day", true],
    ["a", true],
    ["", false],
    ["UPPER", false],
    ["with_underscore", false],
    ["-leading", false],
    ["trailing-", false],
    ["double--hyphen", false],
    ["with space", false],
  ])("isValidLayerId(%j) === %s", (id, expected) => {
    expect(isValidLayerId(id)).toBe(expected);
  });

  it("rejects > 96 chars", () => {
    const tooLong = "a".repeat(97);
    expect(isValidLayerId(tooLong)).toBe(false);
  });
});

describe("isValidZoomRange", () => {
  it.each([
    [undefined, undefined, true],
    [0, 24, true],
    [5, 15, true],
    [10, 10, true],
    [-1, 10, false],
    [0, 25, false],
    [10, 5, false],
    [5.5, 10, false],
    [5, 10.2, false],
  ])("isValidZoomRange(%s, %s) === %s", (lo, hi, expected) => {
    expect(isValidZoomRange(lo, hi)).toBe(expected);
  });
});

describe("DISPLAY_LAYER_KINDS", () => {
  it("has 8 known kinds, all unique", () => {
    expect(DISPLAY_LAYER_KINDS).toHaveLength(8);
    expect(new Set(DISPLAY_LAYER_KINDS).size).toBe(DISPLAY_LAYER_KINDS.length);
  });
});
