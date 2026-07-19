/**
 * Programmatic API for Tier B Feature registration.
 *
 *   import { registerFeature } from "@etzhayyim/maps-kotoba";
 *   // via the `feature` namespace exported from the package root.
 *
 * Two conformance modes:
 *
 *   - **L0** (no witness): plain `e.write()` — fast, no quorum. Suitable
 *     for bulk-ingest pods where each row already has external provenance
 *     (geonames / OpenAddresses / etc.) and operator audit is the validation
 *     trail. Set `opts.witness` to `undefined`.
 *
 *   - **L1 witnessed**: full kotoba-datomic `writeWithWitnesses` orchestration.
 *     Suitable for one-shot heritage registrations (Mountain / Building /
 *     PortOfTokyo) where each write is a sovereign claim that benefits
 *     from ≥3-of-5 cell attestation. Set `opts.witness = { fleet, transport }`.
 *
 * Per kotoba-datomic MIGRATION-TODO Phase 3 + ADR-2605231400.
 */

import { kotoba-datomic } from "@etzhayyim/sdk";

type FleetCell = kotoba-datomic.FleetCell;
type QuorumState = kotoba-datomic.QuorumState;
type WitnessTransport = kotoba-datomic.WitnessTransport;
const writeWithWitnesses = kotoba-datomic.writeWithWitnesses;
import {
  bboxFromDegrees,
  pointBbox,
  pointGeometry,
  type FeatureLabel,
  type FeatureRecord,
} from "./types.js";
import { DEFAULT_FEATURE_MEMBRANE_RULE, FEATURE_NSID } from "./membrane.js";

export type {
  FeatureLabel,
  FeatureRecord,
} from "./types.js";
export {
  bboxFromDegrees,
  isValidGeometryGeoJson,
  isValidH3Resolution,
  isValidLabel,
  lineStringGeometry,
  pointBbox,
  pointGeometry,
  polygonGeometry,
} from "./types.js";
export {
  DEFAULT_FEATURE_MEMBRANE_RULE,
  FEATURE_NSID,
  featureSchemaValidator,
} from "./membrane.js";

/** Minimal write-capable surface so this module is testable without a
 *  full Etzhayyim instance. */
export interface RegisterFeatureClient {
  write(opts: { collection: string; record: Record<string, unknown>; rkey?: string }): Promise<{ uri: string; cid: string }>;
}

export interface RegisterFeatureInput {
  label: FeatureLabel;
  /** GeoJSON Geometry encoded as a JSON string. Use `pointGeometry` /
   *  `polygonGeometry` / `lineStringGeometry` helpers. If a `geometry`
   *  shorthand is needed, build via `pointGeometry(lng, lat)` etc. */
  geometryGeoJson: string;
  h3Cell: string;
  h3Resolution: number;
  /** Microdegree bbox. Caller passes ALL or NONE. Use `pointBbox` /
   *  `bboxFromDegrees` helpers. */
  bboxWestE7?: number;
  bboxSouthE7?: number;
  bboxEastE7?: number;
  bboxNorthE7?: number;
  name?: string;
  properties?: string;
  sourceDid?: string;
  createdAt?: string;
  /** Operator-chosen rkey. Lexicon accepts `any` so either TID (append)
   *  or `literal:{slug}` (canonical) is valid. Defaults to undefined →
   *  PDS allocates a TID. */
  rkey?: string;
}

export interface RegisterFeatureOpts {
  client: RegisterFeatureClient;
  /** When present, the write goes through `writeWithWitnesses` with this
   *  fleet + transport. Omit for plain L0 write. */
  witness?: {
    fleet: readonly FleetCell[];
    transport: WitnessTransport;
    /** Override the default membrane rule (e.g., per-NSID custom validator
     *  references or smaller quorum for low-criticality features). */
    rule?: typeof DEFAULT_FEATURE_MEMBRANE_RULE;
    /** Override the orchestrator's wait timeout (default 30s in SDK). */
    timeoutMs?: number;
  };
}

export interface RegisterFeatureResult {
  uri: string;
  cid: string;
  /** Only populated when `opts.witness` was supplied. */
  witnessState?: QuorumState;
}

/**
 * Register a single feature record. Plain L0 by default; opts.witness
 * upgrades to L1-witnessed.
 *
 * The function does NOT compute H3 cells — caller pre-computes via h3-js
 * (TS) or h3-py (Python). Reason: h3 implementations vary across runtimes
 * and forcing a dependency on this module would couple the kotoba SDK
 * to one h3 build.
 */
export async function registerFeature(
  input: RegisterFeatureInput,
  opts: RegisterFeatureOpts,
): Promise<RegisterFeatureResult> {
  const record: FeatureRecord = {
    label: input.label,
    geometryGeoJson: input.geometryGeoJson,
    h3Cell: input.h3Cell,
    h3Resolution: input.h3Resolution,
    bboxWestE7: input.bboxWestE7,
    bboxSouthE7: input.bboxSouthE7,
    bboxEastE7: input.bboxEastE7,
    bboxNorthE7: input.bboxNorthE7,
    name: input.name,
    properties: input.properties,
    sourceDid: input.sourceDid,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };

  if (opts.witness) {
    const rule = opts.witness.rule ?? DEFAULT_FEATURE_MEMBRANE_RULE;
    const result = await writeWithWitnesses({
      client: opts.client,
      writeOpts: {
        collection: FEATURE_NSID,
        record: record as unknown as Record<string, unknown>,
        rkey: input.rkey,
      },
      fleet: opts.witness.fleet,
      rule,
      transport: opts.witness.transport,
      timeoutMs: opts.witness.timeoutMs,
    });
    return {
      uri: result.uri,
      cid: result.cid,
      witnessState: result.state,
    };
  }

  const receipt = await opts.client.write({
    collection: FEATURE_NSID,
    record: record as unknown as Record<string, unknown>,
    rkey: input.rkey,
  });
  return { uri: receipt.uri, cid: receipt.cid };
}

/**
 * Convenience: register a Mountain feature. Saves the caller from
 * remembering the label string + point geometry + bbox encoding.
 *
 * H3 cell is still caller-provided — see registerFeature() rationale.
 */
export async function registerMountain(
  input: {
    name: string;
    lng: number;
    lat: number;
    elevationMeters?: number;
    h3Cell: string;
    h3Resolution?: number;
    sourceDid?: string;
    rkey?: string;
  },
  opts: RegisterFeatureOpts,
): Promise<RegisterFeatureResult> {
  const props: Record<string, unknown> = {};
  if (input.elevationMeters !== undefined) props.elevationMeters = input.elevationMeters;
  return registerFeature(
    {
      label: "Mountain",
      geometryGeoJson: pointGeometry(input.lng, input.lat),
      h3Cell: input.h3Cell,
      h3Resolution: input.h3Resolution ?? 8,
      ...pointBbox(input.lng, input.lat),
      name: input.name,
      properties: JSON.stringify(props),
      sourceDid: input.sourceDid,
      rkey: input.rkey,
    },
    opts,
  );
}

/** Convenience: register a Building feature (polygon). */
export async function registerBuilding(
  input: {
    name: string;
    polygonRings: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
    centerLng: number;
    centerLat: number;
    /** Pass [west, south, east, north] in degrees. */
    bboxDegrees: readonly [number, number, number, number];
    h3Cell: string;
    h3Resolution?: number;
    levels?: number;
    heightMeters?: number;
    sourceDid?: string;
    rkey?: string;
  },
  opts: RegisterFeatureOpts,
): Promise<RegisterFeatureResult> {
  // polygonGeometry is exported alongside; inline import keeps the
  // shorter helper signature for callers.
  const { polygonGeometry } = await import("./types.js");
  const props: Record<string, unknown> = {};
  if (input.levels !== undefined) props.levels = input.levels;
  if (input.heightMeters !== undefined) props.heightMeters = input.heightMeters;
  props.centerLng = input.centerLng;
  props.centerLat = input.centerLat;
  return registerFeature(
    {
      label: "Building",
      geometryGeoJson: polygonGeometry(input.polygonRings),
      h3Cell: input.h3Cell,
      h3Resolution: input.h3Resolution ?? 12,
      ...bboxFromDegrees(...input.bboxDegrees),
      name: input.name,
      properties: JSON.stringify(props),
      sourceDid: input.sourceDid,
      rkey: input.rkey,
    },
    opts,
  );
}
