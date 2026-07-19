/**
 * Programmatic API for Digital Twin lexicons.
 *
 *   import { twin } from "@etzhayyim/maps-kotoba";
 *   await twin.bindDevice({...}, {client});
 *   await twin.updateTwinState({...}, {client});
 *   await twin.updateOccupancy({...}, {client});
 *   await twin.setSensorAlert({...}, {client});
 *
 * All three lexicons support L0 (plain write) + L1 (witnessed via
 * `opts.witness = {fleet, transport, rule}`). Witness path is identical
 * to the Geography / Transport feature helpers; see
 * `60-apps/etzhayyim-project-maps/kotoba/src/feature/witnessed.test.ts`
 * for the canonical end-to-end demo.
 *
 * Per maps CLAUDE.md §Digital Twin + ADR-2605231400.
 */

import { kotoba-datomic } from "@etzhayyim/sdk";

type FleetCell = kotoba-datomic.FleetCell;
type QuorumState = kotoba-datomic.QuorumState;
type WitnessTransport = kotoba-datomic.WitnessTransport;
type MembraneRule = kotoba-datomic.MembraneRule;
const writeWithWitnesses = kotoba-datomic.writeWithWitnesses;

import {
  isValidAlertId,
  isValidConfidence,
  type DeviceBindingRecord,
  type DeviceBindingRelation,
  type SensorAlertRecord,
  type SensorAlertScope,
  type SensorAlertSeverity,
  type TwinStateKind,
  type TwinStateRecord,
} from "./types.js";

export type {
  DeviceBindingRecord,
  DeviceBindingRelation,
  SensorAlertRecord,
  SensorAlertScope,
  SensorAlertSeverity,
  TwinStateKind,
  TwinStateRecord,
} from "./types.js";
export {
  DEVICE_BINDING_RELATIONS,
  SENSOR_ALERT_SEVERITIES,
  TWIN_STATE_KINDS,
  isValidAlertId,
  isValidConfidence,
} from "./types.js";

const COLLECTION_DEVICE_BINDING = "com.etzhayyim.maps.deviceBinding";
const COLLECTION_TWIN_STATE = "com.etzhayyim.maps.twinState";
const COLLECTION_SENSOR_ALERT = "com.etzhayyim.maps.sensorAlert";

/** Minimal write-capable surface, mirrors the rest of the kotoba package. */
export interface TwinClient {
  write(opts: { collection: string; record: Record<string, unknown>; rkey?: string }): Promise<{ uri: string; cid: string }>;
}

export interface TwinWitnessOpts {
  fleet: readonly FleetCell[];
  transport: WitnessTransport;
  rule: MembraneRule;
  timeoutMs?: number;
}

export interface TwinOpts {
  client: TwinClient;
  witness?: TwinWitnessOpts;
}

export interface TwinResult {
  uri: string;
  cid: string;
  witnessState?: QuorumState;
}

async function _write(
  collection: string,
  record: Record<string, unknown>,
  rkey: string | undefined,
  opts: TwinOpts,
): Promise<TwinResult> {
  if (opts.witness) {
    const r = await writeWithWitnesses({
      client: opts.client,
      writeOpts: { collection, record, rkey },
      fleet: opts.witness.fleet,
      rule: opts.witness.rule,
      transport: opts.witness.transport,
      timeoutMs: opts.witness.timeoutMs,
    });
    return { uri: r.uri, cid: r.cid, witnessState: r.state };
  }
  const receipt = await opts.client.write({ collection, record, rkey });
  return { uri: receipt.uri, cid: receipt.cid };
}

// ─── bindDevice ───────────────────────────────────────────────────

export interface BindDeviceInput {
  deviceUri: string;
  assetUri: string;
  relation: DeviceBindingRelation;
  boundAt?: string;
  operatorDid?: string;
  notes?: string;
}

export async function bindDevice(
  input: BindDeviceInput,
  opts: TwinOpts,
): Promise<TwinResult> {
  const record: DeviceBindingRecord = {
    v: 1,
    deviceUri: input.deviceUri,
    assetUri: input.assetUri,
    relation: input.relation,
    boundAt: input.boundAt ?? new Date().toISOString(),
    operatorDid: input.operatorDid,
    notes: input.notes,
  };
  return _write(
    COLLECTION_DEVICE_BINDING,
    record as unknown as Record<string, unknown>,
    undefined, // TID rkey
    opts,
  );
}

// ─── updateTwinState ──────────────────────────────────────────────

export interface UpdateTwinStateInput {
  subjectUri: string;
  stateKind: TwinStateKind;
  valueNumeric?: number;
  valueText?: string;
  valueJson?: string;
  unit?: string;
  confidence?: number;
  observedAt?: string;
  observerDid?: string;
  sourceDid?: string;
}

export async function updateTwinState(
  input: UpdateTwinStateInput,
  opts: TwinOpts,
): Promise<TwinResult> {
  if (!isValidConfidence(input.confidence)) {
    throw new Error(`updateTwinState: confidence must be in [0, 1], got ${input.confidence}`);
  }
  const record: TwinStateRecord = {
    v: 1,
    subjectUri: input.subjectUri,
    stateKind: input.stateKind,
    valueNumeric: input.valueNumeric,
    valueText: input.valueText,
    valueJson: input.valueJson,
    unit: input.unit,
    confidence: input.confidence,
    observedAt: input.observedAt ?? new Date().toISOString(),
    observerDid: input.observerDid,
    sourceDid: input.sourceDid,
  };
  return _write(
    COLLECTION_TWIN_STATE,
    record as unknown as Record<string, unknown>,
    undefined, // TID rkey
    opts,
  );
}

/** Convenience: occupancy as a discriminator of twinState. Same surface,
 *  ensures `stateKind = "occupancy"` and headcount lands in
 *  `valueNumeric` with `unit = "count"` by default. */
export async function updateOccupancy(
  input: {
    subjectUri: string;
    headcount: number;
    observedAt?: string;
    observerDid?: string;
    sourceDid?: string;
    confidence?: number;
  },
  opts: TwinOpts,
): Promise<TwinResult> {
  return updateTwinState(
    {
      subjectUri: input.subjectUri,
      stateKind: "occupancy",
      valueNumeric: input.headcount,
      unit: "count",
      confidence: input.confidence,
      observedAt: input.observedAt,
      observerDid: input.observerDid,
      sourceDid: input.sourceDid,
    },
    opts,
  );
}

// ─── setSensorAlert ──────────────────────────────────────────────

export interface SetSensorAlertInput {
  alertId: string;
  subjectUri: string;
  name?: string;
  description?: string;
  condition: string;
  severity: SensorAlertSeverity;
  scope?: SensorAlertScope;
  throttleSeconds?: number;
  notifyDids?: ReadonlyArray<string>;
  registeredAt?: string;
  registeredBy?: string;
  supersedesAlertId?: string;
}

export async function setSensorAlert(
  input: SetSensorAlertInput,
  opts: TwinOpts,
): Promise<TwinResult> {
  if (!isValidAlertId(input.alertId)) {
    throw new Error(`setSensorAlert: invalid alertId: ${input.alertId}`);
  }
  if (input.throttleSeconds !== undefined && (!Number.isInteger(input.throttleSeconds) || input.throttleSeconds < 0)) {
    throw new Error(`setSensorAlert: throttleSeconds must be a non-negative integer`);
  }
  if (input.notifyDids && input.notifyDids.length > 20) {
    throw new Error(`setSensorAlert: notifyDids exceeds 20-DID lexicon cap`);
  }
  const record: SensorAlertRecord = {
    v: 1,
    alertId: input.alertId,
    subjectUri: input.subjectUri,
    name: input.name,
    description: input.description,
    condition: input.condition,
    severity: input.severity,
    scope: input.scope,
    throttleSeconds: input.throttleSeconds,
    notifyDids: input.notifyDids,
    registeredAt: input.registeredAt ?? new Date().toISOString(),
    registeredBy: input.registeredBy,
    supersedesAlertId: input.supersedesAlertId,
  };
  return _write(
    COLLECTION_SENSOR_ALERT,
    record as unknown as Record<string, unknown>,
    input.alertId,
    opts,
  );
}
