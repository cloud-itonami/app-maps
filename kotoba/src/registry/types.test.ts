import { describe, expect, it } from "vitest";

import {
  LEGAL_ENTITY_TYPES,
  OWNERSHIP_RELATIONS,
  REGISTRY_TYPES,
  entityKeyFor,
  entityTypeSlug,
  isValidLei,
  isValidSharePctBps,
  registryKeyFor,
  registryTypeSlug,
} from "./types.js";

describe("entityTypeSlug", () => {
  it.each([
    ["LegalEntity" as const, "legal-entity"],
    ["Operator" as const, "operator"],
    ["PropertyOwner" as const, "property-owner"],
    ["Corporation" as const, "corporation"],
    ["GovernmentBody" as const, "government-body"],
    ["PublicUtility" as const, "public-utility"],
  ])("entityTypeSlug(%s) === %s", (t, expected) => {
    expect(entityTypeSlug(t)).toBe(expected);
  });
});

describe("entityKeyFor", () => {
  it("prefers LEI over registrationNumber over taxId", () => {
    const k = entityKeyFor("Corporation", {
      lei: "549300ABC1234567890Z",
      registrationNumber: "12345",
      taxId: "xxx-yyy",
    });
    expect(k).toBe("corporation-549300abc1234567890z");
  });

  it("falls back to registrationNumber when LEI missing", () => {
    const k = entityKeyFor("PropertyOwner", { registrationNumber: "JP/13/01234" });
    expect(k).toBe("property-owner-jp-13-01234");
  });

  it("falls back to taxId when LEI + regNumber missing", () => {
    const k = entityKeyFor("LegalEntity", { taxId: "EIN 12-3456789" });
    expect(k).toBe("legal-entity-ein-12-3456789");
  });

  it("collapses runs of non-alphanumeric to single hyphen", () => {
    const k = entityKeyFor("Corporation", { registrationNumber: "AB---CD//EF  GH" });
    expect(k).toBe("corporation-ab-cd-ef-gh");
  });

  it("rejects missing identifier", () => {
    expect(() => entityKeyFor("Operator", {})).toThrow(/no lei\/registrationNumber\/taxId/);
  });

  it("rejects identifier that sanitises to empty", () => {
    expect(() => entityKeyFor("Operator", { registrationNumber: "///" })).toThrow(
      /reduces to empty/,
    );
  });
});

describe("isValidLei", () => {
  it.each([
    ["549300ABC1234567890Z", true],
    ["12345678901234567890", true],
    ["abc", false],
    ["549300abc1234567890Z", false],
    ["549300ABC1234567890", false],
    ["549300ABC1234567890ZZ", false],
    ["", false],
  ])("isValidLei(%s) === %s", (s, expected) => {
    expect(isValidLei(s)).toBe(expected);
  });
});

describe("registryKeyFor", () => {
  it.each([
    ["LandRegistry" as const, "13-01234", "land-registry-13-01234"],
    ["BusinessRegistry" as const, "GB-12345678", "business-registry-gb-12345678"],
    ["OperatingLicense" as const, "JP/13/EMS/00789", "operating-license-jp-13-ems-00789"],
    ["ZoningRecord" as const, "Tokyo  Ginza   1-Chome", "zoning-record-tokyo-ginza-1-chome"],
  ])("registryKeyFor(%s, %s) === %s", (type, num, expected) => {
    expect(registryKeyFor(type, num)).toBe(expected);
  });

  it("rejects empty registryNumber", () => {
    expect(() => registryKeyFor("LandRegistry", "///")).toThrow(/reduces to empty/);
  });
});

describe("registryTypeSlug", () => {
  it.each([
    ["LandRegistry" as const, "land-registry"],
    ["EnvironmentalPermit" as const, "environmental-permit"],
    ["ConstructionPermit" as const, "construction-permit"],
  ])("registryTypeSlug(%s) === %s", (t, expected) => {
    expect(registryTypeSlug(t)).toBe(expected);
  });
});

describe("isValidSharePctBps", () => {
  it.each([
    [undefined, true],
    [0, true],
    [5000, true],
    [10000, true],
    [-1, false],
    [10001, false],
    [50.5, false],
    [Number.NaN, false],
  ])("isValidSharePctBps(%s) === %s", (n, expected) => {
    expect(isValidSharePctBps(n as number | undefined)).toBe(expected);
  });
});

describe("constants", () => {
  it("LEGAL_ENTITY_TYPES has 6 unique entries", () => {
    expect(LEGAL_ENTITY_TYPES).toHaveLength(6);
    expect(new Set(LEGAL_ENTITY_TYPES).size).toBe(6);
  });
  it("REGISTRY_TYPES has 8 unique entries", () => {
    expect(REGISTRY_TYPES).toHaveLength(8);
    expect(new Set(REGISTRY_TYPES).size).toBe(8);
  });
  it("OWNERSHIP_RELATIONS has 5 unique entries", () => {
    expect(OWNERSHIP_RELATIONS).toHaveLength(5);
    expect(new Set(OWNERSHIP_RELATIONS).size).toBe(5);
  });
});
