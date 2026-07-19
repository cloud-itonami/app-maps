/**
 * Mirrors the 3 Registry & Legal Entity Lexicon record shapes:
 *   - com.etzhayyim.maps.legalEntity
 *   - com.etzhayyim.maps.registry
 *   - com.etzhayyim.maps.ownership
 *
 * Source lexicons: orgs/etzhayyim/com-etzhayyim-maps/wire/lex/
 */

// ─── LegalEntity ─────────────────────────────────────────────────────

export type LegalEntityType =
  | "LegalEntity"
  | "Operator"
  | "PropertyOwner"
  | "Corporation"
  | "GovernmentBody"
  | "PublicUtility";

export const LEGAL_ENTITY_TYPES: readonly LegalEntityType[] = [
  "LegalEntity",
  "Operator",
  "PropertyOwner",
  "Corporation",
  "GovernmentBody",
  "PublicUtility",
];

export type IndustryScheme = "isic-rev4" | "naics" | "sic" | "jsic" | "other";

export interface LegalEntityRecord {
  v: 1;
  entityKey: string;
  entityType: LegalEntityType;
  name: string;
  displayName?: string;
  registrationNumber?: string;
  jurisdiction?: string;
  country?: string;
  lei?: string;
  taxId?: string;
  industryCode?: string;
  industryScheme?: IndustryScheme;
  sourceDid?: string;
  registeredAt: string;
  supersedesEntityKey?: string;
}

/** kebab-case entity-type slug used in entityKey prefixing. */
export function entityTypeSlug(t: LegalEntityType): string {
  return t.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
}

/**
 * Derive a stable entityKey from (entityType, identifier). Prefers LEI
 * when available, falls back to registration number, then taxId.
 */
export function entityKeyFor(
  entityType: LegalEntityType,
  identifier: { lei?: string; registrationNumber?: string; taxId?: string },
): string {
  const id = (identifier.lei ?? identifier.registrationNumber ?? identifier.taxId ?? "").trim();
  if (!id) {
    throw new Error(`cannot derive entityKey for ${entityType}: no lei/registrationNumber/taxId`);
  }
  const safe = id.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!safe) {
    throw new Error(`identifier reduces to empty after sanitisation: ${id}`);
  }
  return `${entityTypeSlug(entityType)}-${safe}`;
}

/** LEI is 20-char alphanumeric. ISO 17442 has a checksum but we keep this
 *  syntactic only — full mod-97 validation lives in the LangGraph cell. */
export function isValidLei(s: string): boolean {
  return /^[A-Z0-9]{20}$/.test(s);
}

// ─── Registry ────────────────────────────────────────────────────────

export type RegistryType =
  | "LandRegistry"
  | "PropertyRegistry"
  | "BusinessRegistry"
  | "VehicleRegistry"
  | "ConstructionPermit"
  | "OperatingLicense"
  | "EnvironmentalPermit"
  | "ZoningRecord";

export const REGISTRY_TYPES: readonly RegistryType[] = [
  "LandRegistry",
  "PropertyRegistry",
  "BusinessRegistry",
  "VehicleRegistry",
  "ConstructionPermit",
  "OperatingLicense",
  "EnvironmentalPermit",
  "ZoningRecord",
];

export interface RegistryRecord {
  v: 1;
  registryKey: string;
  registryType: RegistryType;
  registryNumber: string;
  jurisdiction: string;
  propertyType?: string;
  parcelNumber?: string;
  landAreaSqm?: number;
  assessedValueUsdc?: number;
  regionDid?: string;
  geoLat?: number;
  geoLng?: number;
  validFrom?: string;
  validUntil?: string;
  sourceDid?: string;
  registeredAt: string;
  supersedesRegistryKey?: string;
}

export function registryTypeSlug(t: RegistryType): string {
  return t.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
}

export function registryKeyFor(registryType: RegistryType, registryNumber: string): string {
  const safe = registryNumber.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!safe) {
    throw new Error(`registryNumber reduces to empty after sanitisation: ${registryNumber}`);
  }
  return `${registryTypeSlug(registryType)}-${safe}`;
}

// ─── Ownership ───────────────────────────────────────────────────────

export type OwnershipRelation =
  | "OwnsProperty"
  | "TransferredTo"
  | "InheritedBy"
  | "ForeclosedBy"
  | "LeasedTo";

export const OWNERSHIP_RELATIONS: readonly OwnershipRelation[] = [
  "OwnsProperty",
  "TransferredTo",
  "InheritedBy",
  "ForeclosedBy",
  "LeasedTo",
];

export interface OwnershipRecord {
  v: 1;
  subjectUri: string;
  objectUri: string;
  relation: OwnershipRelation;
  sharePctBps?: number;
  effectiveDate: string;
  registryRef?: string;
  sourceDid?: string;
  supersededByUri?: string;
}

/** sharePctBps must be in [0, 10000]; integer. */
export function isValidSharePctBps(n: number | undefined): boolean {
  if (n === undefined) return true;
  return Number.isInteger(n) && n >= 0 && n <= 10000;
}
