// Projection from com.etzhayyim.apps.maps.{entity} domain records → vertex_spatial row.
// ADR-0036: domain writes bypass PDS + graph-worker and INSERT directly via
// Hyperdrive Kysely. This mirrors 50-infra/cloudflare/workers/graph/worker.ts
// `buildConventionRow` + `mapsEntityToLabel`.

const MAPS_CONTROL_PLANE_ENTITIES = new Set<string>([
  "mapsSource", "mapsJob", "mapsDataset",
]);

const MAPS_ENTITY_TO_LABEL_SPECIAL: Record<string, string> = {
  asset: "PhysicalAsset",
};

// Typed columns on vertex_spatial. Everything else in `rec` goes into `props` JSON.
const VERTEX_SPATIAL_TYPED_COLS = new Set<string>([
  "vertex_id", "_seq", "created_date", "sensitivity_ord", "owner_did",
  "rkey", "repo", "label", "did", "name", "display_name", "description",
  "category", "lat", "lng", "geohash", "status", "source", "source_did",
  "node_label", "country", "region_id", "zone_type", "admin_level",
  "props", "collection",
]);

// Fields that are structural / identity only and should never leak into `props`.
const STRUCTURAL_FIELDS = new Set<string>([
  "nodeId", "rkey", "did", "label", "nodeLabel",
]);

function camelToSnake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

export function mapsEntityForCollection(collection: string): string | null {
  const m = collection.match(/^com\.etzhayyim\.apps\.maps\.([^.]+)$/);
  return m ? m[1] : null;
}

export function isMapsControlPlaneEntity(entity: string): boolean {
  return MAPS_CONTROL_PLANE_ENTITIES.has(entity);
}

export function mapsEntityToLabel(entity: string): string {
  if (MAPS_ENTITY_TO_LABEL_SPECIAL[entity]) return MAPS_ENTITY_TO_LABEL_SPECIAL[entity];
  return entity.charAt(0).toUpperCase() + entity.slice(1);
}

export function firstStableRkey(collection: string, rec: Record<string, unknown>): string {
  const candidates = [
    rec.nodeId, rec.id, rec[`${collection}Id`], rec.registryNumber,
    rec.nanoid, rec.slug, rec.name,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.replace(/[^a-zA-Z0-9._:-]+/g, "-").slice(0, 128);
    if (typeof c === "number" && Number.isFinite(c)) return String(c);
  }
  return "";
}

export type VertexSpatialProjection = {
  row: Record<string, unknown>;
  label: string;
  rkey: string;
  vertexId: string;
};

/**
 * Project a domain record (as passed to sdk.pds.createRecord) into a
 * vertex_spatial row. Returns null for control-plane entities — caller is
 * responsible for routing those to their typed tables.
 *
 * @param repoDid DID of the writer (e.g. did:web:maps.etzhayyim.com or sub-DID)
 * @param entity entity name (maps collection slug, e.g. "building", "source")
 * @param rec   record payload (camelCase JS object, same as legacy write())
 */
export function projectToVertexSpatial(
  repoDid: string,
  entity: string,
  rec: Record<string, unknown>,
): VertexSpatialProjection {
  const label = mapsEntityToLabel(entity);
  const collection = `com.etzhayyim.apps.maps.${entity}`;
  let rkey = firstStableRkey(entity, rec);
  if (!rkey) rkey = `${entity}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const vertexId = `at://${repoDid}/${collection}/${rkey}`;
  const createdDate = new Date().toISOString().slice(0, 10);

  const row: Record<string, unknown> = {
    vertex_id: vertexId,
    rkey,
    repo: repoDid,
    created_date: createdDate,
    sensitivity_ord: 300,
    owner_did: repoDid,
    label,
    collection,
  };

  const extraProps: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (v === null || v === undefined) continue;
    if (k === "props" && typeof v === "string") {
      try { Object.assign(extraProps, JSON.parse(v)); continue; } catch { /* fall through */ }
    }
    const snake = camelToSnake(k);
    if (VERTEX_SPATIAL_TYPED_COLS.has(snake)) {
      row[snake] = v;
      continue;
    }
    if (VERTEX_SPATIAL_TYPED_COLS.has(k)) {
      row[k] = v;
      continue;
    }
    if (STRUCTURAL_FIELDS.has(k)) continue;
    extraProps[k] = v;
  }
  // camelCase overrides (explicit — match graph-worker)
  if (rec.displayName !== undefined) row.display_name = rec.displayName;
  if (rec.sourceDid !== undefined) row.source_did = rec.sourceDid;
  if (rec.nodeLabel !== undefined) row.node_label = rec.nodeLabel;
  if (rec.regionId !== undefined) row.region_id = rec.regionId;
  if (rec.zoneType !== undefined) row.zone_type = rec.zoneType;
  if (rec.adminLevel !== undefined) row.admin_level = rec.adminLevel;

  if (Object.keys(extraProps).length > 0) {
    row.props = JSON.stringify(extraProps);
  }
  return { row, label, rkey, vertexId };
}
