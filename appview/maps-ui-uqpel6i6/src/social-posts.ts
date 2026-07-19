export type SocialRecord = Record<string, unknown>;

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = asText(value);
    if (text) return text;
  }
  return "";
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

export function buildMapsSocialPost(collection: string, rec: SocialRecord): string | null {
  if (collection === "building") {
    const name = firstText(rec.name, rec.displayName, rec.label, rec.nodeId);
    if (!name) return null;
    const floors = firstNumber(rec.floors, rec.levels, rec.storeys);
    const height = firstNumber(rec.heightM, rec.height, rec.heightMeters);
    const locality = firstText(rec.city, rec.prefecture, rec.country, rec.regionName);
    const details = [
      floors != null ? `${floors}F` : "",
      height != null ? `${height}m` : "",
      locality,
    ].filter(Boolean).join(" / ");
    return `[Building] ${name}${details ? ` (${details})` : ""}\ncc @jinushi.etzhayyim.com`;
  }

  if (collection === "landRegistry") {
    const registryNumber = firstText(rec.registryNumber, rec.nodeId);
    if (!registryNumber) return null;
    const jurisdiction = firstText(rec.jurisdiction, rec.country, rec.regionName);
    const propertyType = firstText(rec.propertyType, rec.landUse, rec.category);
    const details = [jurisdiction, propertyType].filter(Boolean).join(", ");
    return `[LandRegistry] ${registryNumber}${details ? ` (${details})` : ""}\ncc @jinushi.etzhayyim.com`;
  }

  if (collection === "propertyRegistry") {
    const registryNumber = firstText(rec.registryNumber, rec.propertyId, rec.nodeId);
    if (!registryNumber) return null;
    const propertyName = firstText(rec.name, rec.displayName, rec.address);
    const jurisdiction = firstText(rec.jurisdiction, rec.country, rec.regionName);
    const details = [propertyName, jurisdiction].filter(Boolean).join(", ");
    return `[PropertyRegistry] ${registryNumber}${details ? ` (${details})` : ""}\ncc @jinushi.etzhayyim.com`;
  }

  if (collection === "zoningRecord") {
    const landUse = firstText(rec.landUse, rec.zoneType, rec.name);
    if (!landUse) return null;
    const jurisdiction = firstText(rec.jurisdiction, rec.regionName, rec.country);
    const details = [jurisdiction].filter(Boolean).join(", ");
    return `[Zoning] ${landUse}${details ? ` (${details})` : ""}\ncc @jinushi.etzhayyim.com`;
  }

  return null;
}
