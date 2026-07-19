/**
 * Default `MembraneRule` + `SchemaValidator` for com.etzhayyim.maps.feature.
 *
 * In production the rule is an `com.etzhayyim.kotoba-datomic.membraneRule` record
 * published in PDS by an operator; orchestrators load it at startup. For
 * the kotoba reference + integration tests, this module exports a
 * default rule fixture with placeholder contentHash values. Operators
 * override with the real rule loaded from PDS.
 *
 * Per kotoba-datomic SPEC §4 + ADR-2605231400.
 */

import { isValidGeometryGeoJson, isValidH3Resolution, isValidLabel, type FeatureRecord } from "./types.js";
import type { kotoba-datomic } from "@etzhayyim/sdk";

type MembraneRule = kotoba-datomic.MembraneRule;
type SchemaValidator = kotoba-datomic.SchemaValidator;

export const FEATURE_NSID = "com.etzhayyim.maps.feature";

/** Placeholder content hashes — replace with sha256 of the real
 *  Lexicon JSON / Rego module / cell directory at publication time. */
export const DEFAULT_FEATURE_MEMBRANE_RULE: MembraneRule = {
  v: 1,
  nsid: FEATURE_NSID,
  schemaRef: {
    path: "orgs/etzhayyim/com-etzhayyim-maps/wire/lex/feature.json",
    contentHash: "0".repeat(64),
    version: "1.0.0",
  },
  policyRef: {
    path: "00-contracts/policies/com/etzhayyim/maps/feature.rego",
    contentHash: "0".repeat(64),
    version: "1.0.0",
  },
  cellRef: {
    path: "40-engine/kotoba/crates/kotoba-kotodama/cells/maps_feature_attestor/",
    contentHash: "0".repeat(64),
    version: "0000000",
  },
  quorumSize: 5,
  quorumThreshold: 3,
  escalationPolicy: "council",
  registeredAt: "2026-05-23T00:00:00Z",
};

/** Schema validator that checks the lexicon's required fields. Use as
 *  the `schema` plug-in for `produceAttestation` / `validateAgainstMembrane`. */
export const featureSchemaValidator: SchemaValidator = async (record: Record<string, unknown>, _rule: MembraneRule) => {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return { layer: "schema", verdict: "reject", reason: "record must be a non-null plain object" };
  }
  const r = record as Partial<FeatureRecord>;
  if (typeof r.label !== "string" || !isValidLabel(r.label)) {
    return { layer: "schema", verdict: "reject", reason: "label must be a 1-64 char string" };
  }
  if (typeof r.geometryGeoJson !== "string" || !isValidGeometryGeoJson(r.geometryGeoJson)) {
    return { layer: "schema", verdict: "reject", reason: "geometryGeoJson must be a parseable GeoJSON Geometry JSON string" };
  }
  if (typeof r.h3Cell !== "string" || r.h3Cell.length === 0 || r.h3Cell.length > 32) {
    return { layer: "schema", verdict: "reject", reason: "h3Cell must be a 1-32 char string" };
  }
  if (typeof r.h3Resolution !== "number" || !isValidH3Resolution(r.h3Resolution)) {
    return { layer: "schema", verdict: "reject", reason: "h3Resolution must be an integer 0-15" };
  }
  // Optional bbox: if any provided, all four must be integers.
  const bboxFields = [r.bboxWestE7, r.bboxSouthE7, r.bboxEastE7, r.bboxNorthE7];
  const present = bboxFields.filter((x) => x !== undefined);
  if (present.length > 0 && present.length !== 4) {
    return { layer: "schema", verdict: "reject", reason: "bbox{West,South,East,North}E7 must all be set or all absent" };
  }
  if (present.length === 4 && !present.every((x) => Number.isInteger(x))) {
    return { layer: "schema", verdict: "reject", reason: "bbox*E7 must be integers (microdegrees)" };
  }
  return { layer: "schema", verdict: "accept" };
};
