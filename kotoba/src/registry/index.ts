/**
 * Programmatic API for Registry & Legal Entity (Tier A).
 *
 *   import { registerLegalEntity, listLegalEntities, getLegalEntity,
 *            registerRegistry, listRegistries, getRegistry,
 *            registerOwnership, ownershipChain, entityHistory }
 *     from "@etzhayyim/maps-kotoba";
 *   // via the `registry` namespace exported from the package root.
 */

import { Etzhayyim } from "@etzhayyim/sdk";
import {
  entityKeyFor,
  registryKeyFor,
  type IndustryScheme,
  type LegalEntityRecord,
  type LegalEntityType,
  type OwnershipRecord,
  type OwnershipRelation,
  type RegistryRecord,
  type RegistryType,
} from "./types.js";

export type {
  IndustryScheme,
  LegalEntityRecord,
  LegalEntityType,
  OwnershipRecord,
  OwnershipRelation,
  RegistryRecord,
  RegistryType,
} from "./types.js";
export {
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

const COLLECTION_ENTITY = "com.etzhayyim.maps.legalEntity";
const COLLECTION_REGISTRY = "com.etzhayyim.maps.registry";
const COLLECTION_OWNERSHIP = "com.etzhayyim.maps.ownership";

function defaultClient(): Etzhayyim {
  return new Etzhayyim({
    did: "did:web:maps.etzhayyim.com",
    pdsUrl: "https://pds.etzhayyim.com",
    ipfsGateway: "https://ipfs.etzhayyim.com",
    l2RpcUrl: "https://mainnet.base.org",
  });
}

// ─── LegalEntity ─────────────────────────────────────────────────────

export interface RegisterLegalEntityInput {
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
  registeredAt?: string;
  supersedesEntityKey?: string;
}

export async function registerLegalEntity(
  input: RegisterLegalEntityInput,
  opts: { client?: Etzhayyim } = {},
): Promise<{ entityKey: string }> {
  const entityKey = entityKeyFor(input.entityType, {
    lei: input.lei,
    registrationNumber: input.registrationNumber,
    taxId: input.taxId,
  });
  const record: LegalEntityRecord = {
    v: 1,
    entityKey,
    entityType: input.entityType,
    name: input.name,
    displayName: input.displayName,
    registrationNumber: input.registrationNumber,
    jurisdiction: input.jurisdiction,
    country: input.country,
    lei: input.lei,
    taxId: input.taxId,
    industryCode: input.industryCode,
    industryScheme: input.industryScheme,
    sourceDid: input.sourceDid,
    registeredAt: input.registeredAt ?? new Date().toISOString(),
    supersedesEntityKey: input.supersedesEntityKey,
  };
  const e = opts.client ?? defaultClient();
  await e.write({
    collection: COLLECTION_ENTITY,
    record: record as unknown as Record<string, unknown>,
    rkey: entityKey,
  });
  return { entityKey };
}

export async function getLegalEntity(
  entityKey: string,
  opts: { client?: Etzhayyim } = {},
): Promise<LegalEntityRecord | null> {
  const e = opts.client ?? defaultClient();
  const { records } = await e.read<LegalEntityRecord>({
    collection: COLLECTION_ENTITY,
    rkey: entityKey,
  });
  return records[0]?.value ?? null;
}

export interface ListOpts {
  prefix?: string;
  limit?: number;
  client?: Etzhayyim;
}

export async function listLegalEntities(opts: ListOpts = {}): Promise<LegalEntityRecord[]> {
  const e = opts.client ?? defaultClient();
  const { records } = await e.read<LegalEntityRecord>({
    collection: COLLECTION_ENTITY,
    prefix: opts.prefix ?? "",
    limit: opts.limit ?? 100,
  });
  return records.map((r) => r.value);
}

// ─── Registry ────────────────────────────────────────────────────────

export interface RegisterRegistryInput {
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
  registeredAt?: string;
  supersedesRegistryKey?: string;
}

export async function registerRegistry(
  input: RegisterRegistryInput,
  opts: { client?: Etzhayyim } = {},
): Promise<{ registryKey: string }> {
  const registryKey = registryKeyFor(input.registryType, input.registryNumber);
  const record: RegistryRecord = {
    v: 1,
    registryKey,
    registryType: input.registryType,
    registryNumber: input.registryNumber,
    jurisdiction: input.jurisdiction,
    propertyType: input.propertyType,
    parcelNumber: input.parcelNumber,
    landAreaSqm: input.landAreaSqm,
    assessedValueUsdc: input.assessedValueUsdc,
    regionDid: input.regionDid,
    geoLat: input.geoLat,
    geoLng: input.geoLng,
    validFrom: input.validFrom,
    validUntil: input.validUntil,
    sourceDid: input.sourceDid,
    registeredAt: input.registeredAt ?? new Date().toISOString(),
    supersedesRegistryKey: input.supersedesRegistryKey,
  };
  const e = opts.client ?? defaultClient();
  await e.write({
    collection: COLLECTION_REGISTRY,
    record: record as unknown as Record<string, unknown>,
    rkey: registryKey,
  });
  return { registryKey };
}

export async function getRegistry(
  registryKey: string,
  opts: { client?: Etzhayyim } = {},
): Promise<RegistryRecord | null> {
  const e = opts.client ?? defaultClient();
  const { records } = await e.read<RegistryRecord>({
    collection: COLLECTION_REGISTRY,
    rkey: registryKey,
  });
  return records[0]?.value ?? null;
}

export async function listRegistries(opts: ListOpts = {}): Promise<RegistryRecord[]> {
  const e = opts.client ?? defaultClient();
  const { records } = await e.read<RegistryRecord>({
    collection: COLLECTION_REGISTRY,
    prefix: opts.prefix ?? "",
    limit: opts.limit ?? 100,
  });
  return records.map((r) => r.value);
}

// ─── Ownership ───────────────────────────────────────────────────────

export interface RegisterOwnershipInput {
  subjectUri: string;
  objectUri: string;
  relation: OwnershipRelation;
  sharePctBps?: number;
  effectiveDate: string;
  registryRef?: string;
  sourceDid?: string;
}

export async function registerOwnership(
  input: RegisterOwnershipInput,
  opts: { client?: Etzhayyim } = {},
): Promise<void> {
  const record: OwnershipRecord = {
    v: 1,
    subjectUri: input.subjectUri,
    objectUri: input.objectUri,
    relation: input.relation,
    sharePctBps: input.sharePctBps,
    effectiveDate: input.effectiveDate,
    registryRef: input.registryRef,
    sourceDid: input.sourceDid,
  };
  const e = opts.client ?? defaultClient();
  // rkey omitted → SDK assigns a TID (the lexicon specifies key: 'tid')
  await e.write({
    collection: COLLECTION_OWNERSHIP,
    record: record as unknown as Record<string, unknown>,
  });
}

/**
 * Ownership chain for a registry record — every ownership event whose
 * `objectUri` matches `objectUri`, sorted ascending by `effectiveDate`.
 * Replaces the RW `ownershipChain` recursive query.
 */
export async function ownershipChain(
  objectUri: string,
  opts: { limit?: number; client?: Etzhayyim } = {},
): Promise<OwnershipRecord[]> {
  const e = opts.client ?? defaultClient();
  const { records } = await e.read<OwnershipRecord>({
    collection: COLLECTION_OWNERSHIP,
    prefix: "",
    limit: opts.limit ?? 500,
  });
  return records
    .map((r) => r.value)
    .filter((v) => v.objectUri === objectUri)
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
}

/**
 * Entity history — every ownership event where this entity was the
 * subject, sorted ascending by `effectiveDate`. Replaces the RW
 * `entityHistory` query.
 */
export async function entityHistory(
  subjectUri: string,
  opts: { limit?: number; client?: Etzhayyim } = {},
): Promise<OwnershipRecord[]> {
  const e = opts.client ?? defaultClient();
  const { records } = await e.read<OwnershipRecord>({
    collection: COLLECTION_OWNERSHIP,
    prefix: "",
    limit: opts.limit ?? 500,
  });
  return records
    .map((r) => r.value)
    .filter((v) => v.subjectUri === subjectUri)
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
}
