import { describe, expect, it } from "vitest";

import {
  DEVICE_BINDING_RELATIONS,
  SENSOR_ALERT_SEVERITIES,
  TWIN_STATE_KINDS,
  isValidAlertId,
  isValidConfidence,
} from "./types.js";

describe("DEVICE_BINDING_RELATIONS", () => {
  it("has 6 unique values matching the lexicon knownValues", () => {
    expect(DEVICE_BINDING_RELATIONS).toHaveLength(6);
    expect(new Set(DEVICE_BINDING_RELATIONS).size).toBe(6);
    expect(DEVICE_BINDING_RELATIONS).toContain("Monitors");
    expect(DEVICE_BINDING_RELATIONS).toContain("Actuates");
  });
});

describe("TWIN_STATE_KINDS", () => {
  it("has 6 unique values", () => {
    expect(TWIN_STATE_KINDS).toHaveLength(6);
    expect(new Set(TWIN_STATE_KINDS).size).toBe(6);
    expect(TWIN_STATE_KINDS).toContain("occupancy");
    expect(TWIN_STATE_KINDS).toContain("health");
  });
});

describe("SENSOR_ALERT_SEVERITIES", () => {
  it("has 4 unique values ordered low → high", () => {
    expect(SENSOR_ALERT_SEVERITIES).toEqual(["info", "warning", "critical", "fatal"]);
  });
});

describe("isValidConfidence", () => {
  it.each([
    [undefined, true],
    [0, true],
    [0.5, true],
    [1, true],
    [-0.1, false],
    [1.1, false],
  ])("isValidConfidence(%s) === %s", (c, expected) => {
    expect(isValidConfidence(c as number | undefined)).toBe(expected);
  });
});

describe("isValidAlertId", () => {
  it.each([
    ["fire-room-203", true],
    ["co2-too-high", true],
    ["a", true],
    ["", false],
    ["UPPER", false],
    ["with_underscore", false],
    ["-leading", false],
    ["trailing-", false],
    ["double--hyphen", false],
  ])("isValidAlertId(%j) === %s", (s, expected) => {
    expect(isValidAlertId(s)).toBe(expected);
  });

  it("rejects > 96 chars", () => {
    expect(isValidAlertId("a".repeat(97))).toBe(false);
  });
});
