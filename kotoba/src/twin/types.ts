/**
 * Mirrors the 3 Digital Twin Lexicon record shapes:
 *   - com.etzhayyim.maps.deviceBinding
 *   - com.etzhayyim.maps.twinState
 *   - com.etzhayyim.maps.sensorAlert
 *
 * Per maps CLAUDE.md §Digital Twin + ADR-2605231400 Phase 3 Tier B.
 *
 * Note: `com.etzhayyim.maps.sensorReading` is intentionally NOT here —
 * high-frequency sensor stream lives in a kotoba-datomic-projection (Tier C)
 * per MIGRATION-TODO OQ-M-5.
 */

// ─── DeviceBinding ───────────────────────────────────────────────────

export type DeviceBindingRelation =
  | "Monitors"
  | "Actuates"
  | "InstalledIn"
  | "InstalledOn"
  | "Mirrors"
  | "Maintains";

export const DEVICE_BINDING_RELATIONS: readonly DeviceBindingRelation[] = [
  "Monitors",
  "Actuates",
  "InstalledIn",
  "InstalledOn",
  "Mirrors",
  "Maintains",
];

export interface DeviceBindingRecord {
  v: 1;
  deviceUri: string;
  assetUri: string;
  relation: DeviceBindingRelation;
  boundAt: string;
  unboundAt?: string;
  operatorDid?: string;
  notes?: string;
  supersededByUri?: string;
}

// ─── TwinState ───────────────────────────────────────────────────────

export type TwinStateKind =
  | "occupancy"
  | "health"
  | "maintenance"
  | "availability"
  | "performance"
  | "custom";

export const TWIN_STATE_KINDS: readonly TwinStateKind[] = [
  "occupancy",
  "health",
  "maintenance",
  "availability",
  "performance",
  "custom",
];

export interface TwinStateRecord {
  v: 1;
  subjectUri: string;
  stateKind: TwinStateKind;
  valueNumeric?: number;
  valueText?: string;
  valueJson?: string;
  unit?: string;
  confidence?: number;
  observedAt: string;
  observerDid?: string;
  sourceDid?: string;
  supersededByUri?: string;
}

/** Confidence must be in [0, 1] when supplied. */
export function isValidConfidence(c: number | undefined): boolean {
  if (c === undefined) return true;
  return typeof c === "number" && c >= 0 && c <= 1;
}

// ─── SensorAlert ─────────────────────────────────────────────────────

export type SensorAlertSeverity = "info" | "warning" | "critical" | "fatal";
export const SENSOR_ALERT_SEVERITIES: readonly SensorAlertSeverity[] = [
  "info",
  "warning",
  "critical",
  "fatal",
];

export type SensorAlertScope =
  | "infrastructure"
  | "safety"
  | "compliance"
  | "environment"
  | "performance"
  | "custom";

export interface SensorAlertRecord {
  v: 1;
  alertId: string;
  subjectUri: string;
  name?: string;
  description?: string;
  condition: string;
  severity: SensorAlertSeverity;
  scope?: SensorAlertScope;
  throttleSeconds?: number;
  notifyDids?: ReadonlyArray<string>;
  registeredAt: string;
  registeredBy?: string;
  supersedesAlertId?: string;
  deactivatedAt?: string;
}

/** alertId — kebab-case, 1-96 chars, no leading/trailing/double hyphens. */
export function isValidAlertId(alertId: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(alertId) && alertId.length <= 96;
}
