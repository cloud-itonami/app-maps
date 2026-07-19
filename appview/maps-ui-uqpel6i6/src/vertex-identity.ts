export type VertexRecord = Record<string, unknown>;

const SELF_DID_FIELDS: Record<string, string[]> = {
  airport: ["airportDid"],
  airRoute: ["routeDid"],
  aircraft: ["aircraftDid"],
  flightOperation: ["flightDid"],
};

function toMapsActorDid(appId: string): string {
  return `did:web:${appId}.etzhayyim.com`;
}

function toDidSlug(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "node";
}

function toCollectionSlug(collection: string): string {
  return collection
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

function firstDidString(fields: string[], rec: VertexRecord): string {
  for (const field of fields) {
    const value = rec[field];
    if (typeof value === "string" && value.startsWith("did:")) return value;
  }
  return "";
}

function firstStableIdentity(collection: string, rec: VertexRecord): string {
  const collectionIdField = `${collection}Id`;
  const candidates = [
    rec.nodeId,
    rec.id,
    rec[collectionIdField],
    rec.registryNumber,
    rec.nanoid,
    rec.slug,
    rec.name,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
    if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
  }
  return "";
}

export function normalizeMapsVertexIdentity(
  appId: string,
  collection: string,
  rec: VertexRecord,
): VertexRecord {
  const actorDid = toMapsActorDid(appId);
  const normalized: VertexRecord = { ...rec };

  if (typeof normalized.actorId !== "string" || normalized.actorId === "" || normalized.actorId === appId) {
    normalized.actorId = actorDid;
  }

  if (typeof normalized.did === "string" && normalized.did.startsWith("did:")) {
    return normalized;
  }

  const explicitDid = firstDidString(SELF_DID_FIELDS[collection] ?? [], normalized);
  if (explicitDid) {
    normalized.did = explicitDid;
    return normalized;
  }

  const stableIdentity = firstStableIdentity(collection, normalized);
  if (!stableIdentity) return normalized;

  normalized.did = `did:web:${appId}.etzhayyim.com:${toCollectionSlug(collection)}:${toDidSlug(stableIdentity)}`;
  return normalized;
}
