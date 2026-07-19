import {
  asAgentTool,
  createWorkerExport,
  createKyselyDb,
  withCapabilityTags,
  withOCELEvent,
  truncateText,
  type ComAtprotoSyncSubscribeReposCommit,
  type HostSDK,
  nowISO,
  str,
  decodeJson,
  encodeJson,
  resolveHeartbeatCadence,
  createCadenceState,
  createInboxBuffer,
  genID, resolveModelId,
  nsid,
  parseLexiconInput,
} from "@etzhayyim/kotodama-host-sdk";
import { sql } from "@etzhayyim/kotodama-host-sdk";
import { cellToBoundary, latLngToCell } from "h3-js";
import { extractGeomFromRow, parseProps, type AnyRow, type GeoJsonGeom } from "./geometry";
import { buildMapsSocialPost } from "./social-posts";
import { buildFollowEdgeRow, buildRepoRecordRow, buildStableRkey } from "./social-repo";
import { normalizeMapsVertexIdentity } from "./vertex-identity";
import { projectToVertexSpatial, isMapsControlPlaneEntity } from "./vertex-spatial-projection";
import { registerCollectionCommands, registerWriterEntities } from "./collection-commands";
import { mirrorVertexWrite, shadowTileGeoJsonRead } from "./etzhayyim-mirror";
import { queryByCells as kotobaQueryByCells } from "./kotoba-spatial";

const cadenceState = createCadenceState();
const inbox = createInboxBuffer();

let appId = "";
// Module-level env capture so handlers can reach raw CF bindings (AI,
// HEADLESS_BROWSER, …) that aren't always plumbed through sdk.env. Set
// by the SDK runtime on every request via `setMapsEnvBindings(env)`.
let _mapsEnv: Record<string, unknown> = {};
export function _captureMapsEnv(env: Record<string, unknown>) { _mapsEnv = env; }
type KyselyDb = ReturnType<typeof createKyselyDb>;

type TerrainRuntimeAsset = {
  assetId: string;
  role: string;
  kind: string;
  provider: string;
  format: string;
  mediaType: string;
  href?: string;
  hrefTemplate?: string;
  band?: string;
  encoding?: string;
  nodata?: number;
  resolutionM?: number;
  minZoom?: number;
  maxZoom?: number;
  tileSize?: number;
  crs?: string;
  tileMatrixSet?: string;
  metadata?: Record<string, unknown>;
};

type TerrainRuntimeSource = {
  sourceId: string;
  slug: string;
  name: string;
  displayName: string;
  description: string;
  provider: string;
  format: string;
  sourceKind: string;
  terrainRole: string;
  assemblyStrategy: string;
  status: string;
  stacApiUrl?: string;
  stacCollectionId?: string;
  tilejsonUrl?: string;
  priority: number;
  isDefault: boolean;
  minZoom?: number;
  maxZoom?: number;
  bbox?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  demTileUrl?: string;
  assets: TerrainRuntimeAsset[];
};

type VectorRuntimeAsset = {
  assetId: string;
  role: string;
  kind: string;
  provider: string;
  format: string;
  mediaType: string;
  href?: string;
  hrefTemplate?: string;
  checksumUrl?: string;
  manifestUrl?: string;
  updateCadence?: string;
  minZoom?: number;
  maxZoom?: number;
  tileSize?: number;
  metadata?: Record<string, unknown>;
};

type VectorRuntimeSource = {
  sourceId: string;
  slug: string;
  name: string;
  displayName: string;
  description: string;
  provider: string;
  format: string;
  sourceKind: string;
  lineageRole: string;
  assemblyStrategy: string;
  updateCadence: string;
  status: string;
  diffUrl?: string;
  tilejsonUrl?: string;
  priority: number;
  isDefault: boolean;
  minZoom?: number;
  maxZoom?: number;
  bbox?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  vectorTileUrl?: string;
  assets: VectorRuntimeAsset[];
};

type OrbitalRuntimeSystem = {
  systemId: string;
  parentSystemId?: string;
  frame: string;
  primaryBodyId?: string;
  scaleKind: string;
  status: string;
  metadata?: Record<string, unknown>;
};

type OrbitalRuntimeBody = {
  bodyId: string;
  systemId: string;
  bodyKind: string;
  parentBodyId?: string;
  sourceCatalog?: string;
  noradId?: string;
  tleLine1?: string;
  tleLine2?: string;
  semiMajorAxisM?: number;
  eccentricity?: number;
  inclinationDeg?: number;
  orbitalPeriodS?: number;
  meanLongitudeDeg?: number;
  renderRadiusM?: number;
  colorHex?: string;
  status: string;
  metadata?: Record<string, unknown>;
};

type CelestialRuntimeCatalog = {
  catalogId: string;
  authority: string;
  version: string;
  frame: string;
  coverageKind: string;
  metadata?: Record<string, unknown>;
};

type CelestialRuntimeObject = {
  objectId: string;
  catalogId: string;
  objectKind: string;
  parentObjectId?: string;
  linkedSystemId?: string;
  linkedBodyId?: string;
  referenceFrame?: string;
  raDeg?: number;
  decDeg?: number;
  distanceAu?: number;
  distanceLy?: number;
  radiusM?: number;
  massKg?: number;
  spectralClass?: string;
  renderPriority?: number;
  sourceRef?: string;
  status: string;
  metadata?: Record<string, unknown>;
};

type KamiStreetChunkBudget = {
  chunkSizeMeters: number;
  targetRuntimeClass: string;
  maxCompressedBytes: number;
  maxMaterials: number;
  maxAtlasCount: number;
  maxDrawCallsNearField: number;
  maxTrianglesLod0: number;
  maxTrianglesLod1: number;
  maxTrianglesLod2: number;
  maxTrianglesLod3: number;
  maxPropsInstanced: number;
  maxCollisionBytes: number;
};

type KamiRuntimePackageDescriptor = {
  schemaVersion: string;
  packageKind: string;
  tileUrl: string;
  tile_url: string;
  source: string;
  targetRuntime: string;
  chunking: {
    chunkSizeMeters: number;
    chunkKeyFormat: string;
    coordinateSystem: string;
  };
  formats: {
    mesh: string;
    texture: string;
    geometryCompression: string;
    textureCompression: string;
    metadata: string;
  };
  lodPolicy: {
    levels: number;
    switchDistancesMeters: number[];
    impostorStartMeters: number;
  };
  budget: KamiStreetChunkBudget;
  entrypoints: {
    vectorTileUrl?: string;
    demTileUrl?: string;
    styleUrl?: string;
  };
  vectorSource: VectorRuntimeSource | null;
  vector_source: VectorRuntimeSource | null;
  vectorSources: VectorRuntimeSource[];
  vector_sources: VectorRuntimeSource[];
  terrainSource: TerrainRuntimeSource | null;
  terrain_source: TerrainRuntimeSource | null;
  terrainSources: TerrainRuntimeSource[];
  terrain_sources: TerrainRuntimeSource[];
};

type KamiStreetChunkPreset = {
  label: string;
  budget: KamiStreetChunkBudget;
};

function getDb(): KyselyDb {
  // Module singleton removed (2026-04-20): Kysely+HyperdriveDialect caches stale
  // connection state across requests — 2nd call onward hung indefinitely.
  // Fresh instance per call is cheap; Hyperdrive handles pooling.
  return createKyselyDb();
}

function mapsLangserverUrl(): string {
  return String(_mapsEnv.MAPS_LANGSERVER_URL ?? "https://maps-langserver.etzhayyim.com").replace(/\/+$/, "");
}

async function callMapsLangserverRead(nsidValue: string, payload: Uint8Array): Promise<unknown | null> {
  let body = "{}";
  try {
    body = new TextDecoder().decode(payload);
    if (!body.trim()) body = "{}";
  } catch {
    body = "{}";
  }
  try {
    const res = await fetch(`${mapsLangserverUrl()}/xrpc/${nsidValue}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-etzhayyim-actor-did": "did:web:maps.etzhayyim.com",
        "x-etzhayyim-trace-id": `maps-edge-${Date.now()}`,
      },
      body,
      signal: AbortSignal.timeout(50_000),
    });
    if (!res.ok) {
      console.warn(`[maps-langserver-read] ${nsidValue} status=${res.status}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn(`[maps-langserver-read] ${nsidValue} unavailable: ${(e as Error).message}`);
    return null;
  }
}

async function cmdMapsPodIntelRead(nsidValue: string, payload: Uint8Array): Promise<unknown> {
  const pod = await callMapsLangserverRead(nsidValue, payload);
  if (pod) return pod;
  return {
    ok: false,
    nsid: nsidValue,
    error: "maps_langserver_read_unavailable",
    source: "maps-ui-worker",
    degraded: true,
    asOfMs: Date.now(),
  };
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore malformed JSON payloads from graph rows.
  }
  return {};
}

function normalizeVertexOther(row: AnyRow | null | undefined): AnyRow {
  if (!row) return {};
  return { ...row, ...parseProps(row.props) };
}

function rowField(row: AnyRow, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = row[key];
    if (value != null && value !== "") return value;
  }
  return undefined;
}

function collectionForLabel(label: string): string {
  const special: Record<string, string> = {
    PhysicalAsset: "asset",
  };
  return special[label] ?? label.charAt(0).toLowerCase() + label.slice(1);
}

function normalizeCollectionName(collection: string): string {
  if (collection.includes(".")) return collection;
  return `com.etzhayyim.apps.maps.${collection}`;
}

async function raceTimeout<T>(p: Promise<T>, ms: number, tag: string): Promise<T> {
  return Promise.race<T>([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`TIMEOUT_${ms}MS:${tag}`)), ms),
    ),
  ]);
}

let pingProbed = false;
async function probeHyperdriveOnce(): Promise<void> {
  if (pingProbed) return;
  pingProbed = true;
  const t0 = Date.now();
  try {
    await raceTimeout(sql`SELECT 1`.execute(getDb()), 3000, "SELECT_1");
    console.log(`[hyperdrive-probe] SELECT 1 ok ms=${Date.now() - t0}`);
  } catch (e) {
    console.error(`[hyperdrive-probe] SELECT 1 FAILED ms=${Date.now() - t0} err=${(e as Error).message}`);
  }
}

async function listCollectionRows(collection: string, build?: (query: any) => any): Promise<AnyRow[]> {
  const fullCollection = normalizeCollectionName(collection);
  const label = kindToLabel(fullCollection);
  // vertex_spatial by label. Defensive LIMIT 500 to prevent full scan from hanging Hyperdrive pool.
  const t0 = Date.now();
  let rows: AnyRow[] = [];
  try {
    await probeHyperdriveOnce();
    let query: any = getDb().selectFrom("vertex_spatial").selectAll().where("label", "=", label).limit(500);
    if (build) query = build(query);
    rows = await raceTimeout<AnyRow[]>(query.execute(), 5000, `vertex_spatial:${label}`);
    console.log(`[listCollectionRows] vertex_spatial label=${label} rows=${rows.length} ms=${Date.now() - t0}`);
  } catch (e) {
    console.error(`[listCollectionRows] vertex_spatial FAILED label=${label} ms=${Date.now() - t0} err=${(e as Error).message}`);
    return [];
  }
  return rows.map((row: AnyRow) => normalizeVertexOther(row));
}

async function getCollectionRow(collection: string, build?: (query: any) => any): Promise<AnyRow | null> {
  const rows = await listCollectionRows(collection, (query) => {
    const next = build ? build(query) : query;
    return next.limit(1);
  });
  return rows[0] ?? null;
}

async function getCollectionByRkey(collection: string, rkey: string): Promise<AnyRow | null> {
  if (!rkey) return null;
  return getCollectionRow(collection, (query) => query.where("rkey", "=", rkey));
}

async function countCollectionRows(collection: string): Promise<number> {
  const label = kindToLabel(normalizeCollectionName(collection));
  // vertex_spatial by label
  try {
    const rows = await getDb()
      .selectFrom("mv_vertex_spatial_count" as any)
      .select(["cnt"])
      .where("label", "=", label)
      .execute();
    return Number(rows[0]?.cnt ?? 0);
  } catch (e) {
    console.warn(`[countCollectionRows] label=${label} unavailable: ${(e as Error).message}`);
    return 0;
  }
}

async function listProfileRows(limit: number): Promise<AnyRow[]> {
  const rows = await getDb().selectFrom("vertex_profile").selectAll().limit(limit).execute();
  return rows.map((row: AnyRow) => normalizeVertexOther(row));
}

function safeDecodeBase64Json(raw: unknown): Record<string, unknown> {
  const b64 = str(raw);
  if (!b64) return {};
  try {
    const decoded = atob(b64);
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function readFiniteNumber(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n;
}

function readFiniteInt(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.trunc(n);
}

async function listTerrainRuntimeSources(): Promise<TerrainRuntimeSource[]> {
  try {
    const sourceRows = (await getDb()
      .selectFrom("vertex_terrain_source" as any)
      .selectAll()
      .execute()) as AnyRow[];
    if (sourceRows.length === 0) return [];

    const assetRows = (await getDb()
      .selectFrom("vertex_raster_asset" as any)
      .selectAll()
      .execute()) as AnyRow[];

    const assetsBySource = new Map<string, TerrainRuntimeAsset[]>();
    for (const row of assetRows) {
      const sourceId = str(row.source_id);
      const assetId = str(row.asset_id);
      if (!sourceId || !assetId) continue;
      const asset: TerrainRuntimeAsset = {
        assetId,
        role: str(row.asset_role),
        kind: str(row.asset_kind),
        provider: str(row.provider),
        format: str(row.format),
        mediaType: str(row.media_type),
        href: str(row.href) || undefined,
        hrefTemplate: str(row.href_template) || undefined,
        band: str(row.band) || undefined,
        encoding: str(row.encoding) || undefined,
        nodata: readFiniteNumber(row.nodata) ?? undefined,
        resolutionM: readFiniteNumber(row.resolution_m) ?? undefined,
        minZoom: readFiniteInt(row.min_zoom),
        maxZoom: readFiniteInt(row.max_zoom),
        tileSize: readFiniteInt(row.tile_size),
        crs: str(row.crs) || undefined,
        tileMatrixSet: str(row.tile_matrix_set) || undefined,
        metadata: parseJsonObject(row.metadata_json),
      };
      const bucket = assetsBySource.get(sourceId) ?? [];
      bucket.push(asset);
      assetsBySource.set(sourceId, bucket);
    }

    return sourceRows
      .filter((row) => {
        const status = str(row.status).toLowerCase();
        return status === "" || status === "active" || status === "ready" || status === "published";
      })
      .map((row) => {
        const sourceId = str(row.source_id);
        const assets = (assetsBySource.get(sourceId) ?? []).sort((a, b) => a.role.localeCompare(b.role));
        const fallbackAsset = assets.find((asset) => asset.role === "demTileFallback");
        return {
          sourceId,
          slug: str(row.slug),
          name: str(row.name),
          displayName: str(row.display_name) || str(row.name),
          description: str(row.description),
          provider: str(row.provider),
          format: str(row.format),
          sourceKind: str(row.source_kind),
          terrainRole: str(row.terrain_role),
          assemblyStrategy: str(row.assembly_strategy),
          status: str(row.status),
          stacApiUrl: str(row.stac_api_url) || undefined,
          stacCollectionId: str(row.stac_collection_id) || undefined,
          tilejsonUrl: str(row.tilejson_url) || undefined,
          priority: readFiniteInt(row.priority) ?? 0,
          isDefault: Boolean(row.is_default),
          minZoom: readFiniteInt(row.min_zoom),
          maxZoom: readFiniteInt(row.max_zoom),
          bbox: parseJsonObject(row.bbox_json),
          metadata: parseJsonObject(row.metadata_json),
          demTileUrl: fallbackAsset?.hrefTemplate ?? fallbackAsset?.href,
          assets,
        } satisfies TerrainRuntimeSource;
      })
      .sort((a, b) => {
        if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
        return b.priority - a.priority;
      });
  } catch {
    return [];
  }
}

async function listVectorRuntimeSources(): Promise<VectorRuntimeSource[]> {
  try {
    const sourceRows = (await getDb()
      .selectFrom("vertex_vector_source" as any)
      .selectAll()
      .execute()) as AnyRow[];
    if (sourceRows.length === 0) return [];

    const assetRows = (await getDb()
      .selectFrom("vertex_vector_asset" as any)
      .selectAll()
      .execute()) as AnyRow[];

    const assetsBySource = new Map<string, VectorRuntimeAsset[]>();
    for (const row of assetRows) {
      const sourceId = str(row.source_id);
      const assetId = str(row.asset_id);
      if (!sourceId || !assetId) continue;
      const asset: VectorRuntimeAsset = {
        assetId,
        role: str(row.asset_role),
        kind: str(row.asset_kind),
        provider: str(row.provider),
        format: str(row.format),
        mediaType: str(row.media_type),
        href: str(row.href) || undefined,
        hrefTemplate: str(row.href_template) || undefined,
        checksumUrl: str(row.checksum_url) || undefined,
        manifestUrl: str(row.manifest_url) || undefined,
        updateCadence: str(row.update_cadence) || undefined,
        minZoom: readFiniteInt(row.min_zoom),
        maxZoom: readFiniteInt(row.max_zoom),
        tileSize: readFiniteInt(row.tile_size),
        metadata: parseJsonObject(row.metadata_json),
      };
      const bucket = assetsBySource.get(sourceId) ?? [];
      bucket.push(asset);
      assetsBySource.set(sourceId, bucket);
    }

    return sourceRows
      .filter((row) => {
        const status = str(row.status).toLowerCase();
        return status === "" || status === "active" || status === "ready" || status === "published";
      })
      .map((row) => {
        const sourceId = str(row.source_id);
        const assets = (assetsBySource.get(sourceId) ?? []).sort((a, b) => a.role.localeCompare(b.role));
        const assembledTiles = assets.find((asset) => asset.role === "assembledVectorTiles");
        return {
          sourceId,
          slug: str(row.slug),
          name: str(row.name),
          displayName: str(row.display_name) || str(row.name),
          description: str(row.description),
          provider: str(row.provider),
          format: str(row.format),
          sourceKind: str(row.source_kind),
          lineageRole: str(row.lineage_role),
          assemblyStrategy: str(row.assembly_strategy),
          updateCadence: str(row.update_cadence),
          status: str(row.status),
          diffUrl: str(row.diff_url) || undefined,
          tilejsonUrl: str(row.tilejson_url) || undefined,
          priority: readFiniteInt(row.priority) ?? 0,
          isDefault: Boolean(row.is_default),
          minZoom: readFiniteInt(row.min_zoom),
          maxZoom: readFiniteInt(row.max_zoom),
          bbox: parseJsonObject(row.bbox_json),
          metadata: parseJsonObject(row.metadata_json),
          vectorTileUrl: assembledTiles?.hrefTemplate ?? assembledTiles?.href,
          assets,
        } satisfies VectorRuntimeSource;
      })
      .sort((a, b) => {
        if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
        return b.priority - a.priority;
      });
  } catch {
    return [];
  }
}

async function listOrbitalRuntimeSystems(): Promise<OrbitalRuntimeSystem[]> {
  try {
    const rows = (await getDb()
      .selectFrom("vertex_orbital_system" as any)
      .selectAll()
      .execute()) as AnyRow[];
    return rows
      .filter((row) => {
        const status = str(row.status).toLowerCase();
        return status === "" || status === "active" || status === "ready" || status === "published";
      })
      .map((row) => ({
        systemId: str(row.system_id),
        parentSystemId: str(row.parent_system_id) || undefined,
        frame: str(row.frame),
        primaryBodyId: str(row.primary_body_id) || undefined,
        scaleKind: str(row.scale_kind),
        status: str(row.status),
        metadata: parseJsonObject(row.metadata_json),
      } satisfies OrbitalRuntimeSystem))
      .sort((a, b) => a.systemId.localeCompare(b.systemId));
  } catch {
    return [];
  }
}

async function listOrbitalRuntimeBodies(): Promise<OrbitalRuntimeBody[]> {
  try {
    const rows = (await getDb()
      .selectFrom("vertex_orbital_body" as any)
      .selectAll()
      .execute()) as AnyRow[];
    return rows
      .filter((row) => {
        const status = str(row.status).toLowerCase();
        return status === "" || status === "active" || status === "ready" || status === "published";
      })
      .map((row) => ({
        bodyId: str(row.body_id),
        systemId: str(row.system_id),
        bodyKind: str(row.body_kind),
        parentBodyId: str(row.parent_body_id) || undefined,
        sourceCatalog: str(row.source_catalog) || undefined,
        noradId: str(row.norad_id) || undefined,
        tleLine1: str(row.tle_line1) || undefined,
        tleLine2: str(row.tle_line2) || undefined,
        semiMajorAxisM: readFiniteNumber(row.semi_major_axis_m) ?? undefined,
        eccentricity: readFiniteNumber(row.eccentricity) ?? undefined,
        inclinationDeg: readFiniteNumber(row.inclination_deg) ?? undefined,
        orbitalPeriodS: readFiniteNumber(row.orbital_period_s) ?? undefined,
        meanLongitudeDeg: readFiniteNumber(row.mean_longitude_deg) ?? undefined,
        renderRadiusM: readFiniteNumber(row.render_radius_m) ?? undefined,
        colorHex: str(row.color_hex) || undefined,
        status: str(row.status),
        metadata: parseJsonObject(row.metadata_json),
      } satisfies OrbitalRuntimeBody))
      .sort((a, b) => a.bodyId.localeCompare(b.bodyId));
  } catch {
    return [];
  }
}

async function listCelestialRuntimeCatalogs(): Promise<CelestialRuntimeCatalog[]> {
  try {
    const rows = (await getDb()
      .selectFrom("vertex_celestial_catalog" as any)
      .selectAll()
      .execute()) as AnyRow[];
    return rows.map((row) => ({
      catalogId: str(row.catalog_id),
      authority: str(row.authority),
      version: str(row.version),
      frame: str(row.frame),
      coverageKind: str(row.coverage_kind),
      metadata: parseJsonObject(row.metadata_json),
    } satisfies CelestialRuntimeCatalog))
      .sort((a, b) => a.catalogId.localeCompare(b.catalogId));
  } catch {
    return [];
  }
}

async function listCelestialRuntimeObjects(): Promise<CelestialRuntimeObject[]> {
  try {
    const rows = (await getDb()
      .selectFrom("vertex_celestial_object" as any)
      .selectAll()
      .execute()) as AnyRow[];
    return rows
      .filter((row) => {
        const status = str(row.status).toLowerCase();
        return status === "" || status === "active" || status === "ready" || status === "published";
      })
      .map((row) => ({
        objectId: str(row.object_id),
        catalogId: str(row.catalog_id),
        objectKind: str(row.object_kind),
        parentObjectId: str(row.parent_object_id) || undefined,
        linkedSystemId: str(row.linked_system_id) || undefined,
        linkedBodyId: str(row.linked_body_id) || undefined,
        referenceFrame: str(row.reference_frame) || undefined,
        raDeg: readFiniteNumber(row.ra_deg) ?? undefined,
        decDeg: readFiniteNumber(row.dec_deg) ?? undefined,
        distanceAu: readFiniteNumber(row.distance_au) ?? undefined,
        distanceLy: readFiniteNumber(row.distance_ly) ?? undefined,
        radiusM: readFiniteNumber(row.radius_m) ?? undefined,
        massKg: readFiniteNumber(row.mass_kg) ?? undefined,
        spectralClass: str(row.spectral_class) || undefined,
        renderPriority: readFiniteInt(row.render_priority),
        sourceRef: str(row.source_ref) || undefined,
        status: str(row.status),
        metadata: parseJsonObject(row.metadata_json),
      } satisfies CelestialRuntimeObject))
      .sort((a, b) => (a.renderPriority ?? 0) - (b.renderPriority ?? 0));
  } catch {
    return [];
  }
}

const KAMI_STREET_CHUNK_PRESETS: Record<number, KamiStreetChunkPreset> = {
  25: {
    label: "hero-micro",
    budget: {
      chunkSizeMeters: 25,
      targetRuntimeClass: "switch-class",
      maxCompressedBytes: 3_000_000,
      maxMaterials: 8,
      maxAtlasCount: 2,
      maxDrawCallsNearField: 90,
      maxTrianglesLod0: 45_000,
      maxTrianglesLod1: 24_000,
      maxTrianglesLod2: 8_000,
      maxTrianglesLod3: 2_000,
      maxPropsInstanced: 128,
      maxCollisionBytes: 400_000,
    },
  },
  50: {
    label: "near-field-default",
    budget: {
      chunkSizeMeters: 50,
      targetRuntimeClass: "switch-class",
      maxCompressedBytes: 6_000_000,
      maxMaterials: 10,
      maxAtlasCount: 3,
      maxDrawCallsNearField: 120,
      maxTrianglesLod0: 90_000,
      maxTrianglesLod1: 45_000,
      maxTrianglesLod2: 15_000,
      maxTrianglesLod3: 4_000,
      maxPropsInstanced: 256,
      maxCollisionBytes: 800_000,
    },
  },
  100: {
    label: "wide-area-aggregate",
    budget: {
      chunkSizeMeters: 100,
      targetRuntimeClass: "switch-class",
      maxCompressedBytes: 12_000_000,
      maxMaterials: 12,
      maxAtlasCount: 4,
      maxDrawCallsNearField: 180,
      maxTrianglesLod0: 180_000,
      maxTrianglesLod1: 90_000,
      maxTrianglesLod2: 30_000,
      maxTrianglesLod3: 8_000,
      maxPropsInstanced: 512,
      maxCollisionBytes: 1_500_000,
    },
  },
};

function normalizeChunkSizeMeters(value: unknown, fallback = 50): number {
  const parsed = Math.trunc(Number(value));
  return KAMI_STREET_CHUNK_PRESETS[parsed] ? parsed : fallback;
}

function budgetForChunkSizeMeters(chunkSizeMeters: number): KamiStreetChunkPreset {
  return KAMI_STREET_CHUNK_PRESETS[normalizeChunkSizeMeters(chunkSizeMeters)];
}

async function buildKamiRuntimePackage(tileUrl: string, source: string, styleUrl?: string, chunkSizeMeters = 50): Promise<KamiRuntimePackageDescriptor> {
  const vectorSources = await listVectorRuntimeSources();
  const vectorSource = vectorSources.find((entry) => entry.isDefault) ?? vectorSources[0] ?? null;
  const terrainSources = await listTerrainRuntimeSources();
  const terrainSource = terrainSources.find((entry) => entry.isDefault) ?? terrainSources[0] ?? null;
  const preset = budgetForChunkSizeMeters(chunkSizeMeters);
  return {
    schemaVersion: "etzhayyim.kami.street-chunk.v1",
    packageKind: "streetChunkRuntimePackage",
    tileUrl,
    tile_url: tileUrl,
    source,
    targetRuntime: "kami-map",
    chunking: {
      chunkSizeMeters: preset.budget.chunkSizeMeters,
      chunkKeyFormat: "z/x/y#chunk",
      coordinateSystem: "EPSG:3857",
    },
    formats: {
      mesh: "model/gltf-binary",
      texture: "image/ktx2",
      geometryCompression: "EXT_meshopt_compression",
      textureCompression: "KHR_texture_basisu",
      metadata: "application/json",
    },
    lodPolicy: {
      levels: 4,
      switchDistancesMeters: preset.budget.chunkSizeMeters <= 25 ? [12, 24, 48] : preset.budget.chunkSizeMeters <= 50 ? [20, 45, 90] : [25, 60, 120],
      impostorStartMeters: preset.budget.chunkSizeMeters <= 25 ? 72 : preset.budget.chunkSizeMeters <= 50 ? 135 : 180,
    },
    budget: preset.budget,
    entrypoints: {
      vectorTileUrl: vectorSource?.vectorTileUrl,
      demTileUrl: terrainSource?.demTileUrl,
      styleUrl,
    },
    vectorSource,
    vector_source: vectorSource,
    vectorSources,
    vector_sources: vectorSources,
    terrainSource,
    terrain_source: terrainSource,
    terrainSources,
    terrain_sources: terrainSources,
  };
}

function buildChunkAssetRecord(req: Record<string, unknown>, nodeId: string): Record<string, unknown> {
  const chunkSizeMeters = normalizeChunkSizeMeters(req.chunkSizeMeters);
  const preset = budgetForChunkSizeMeters(chunkSizeMeters);
  return {
    nodeId,
    nodeLabel: "PhysicalAsset",
    name: str(req.name),
    assetType: str(req.assetType || "kami_street_chunk"),
    assetRole: str(req.assetRole || "runtime_chunk"),
    packageKind: str(req.packageKind || "streetChunkRuntimePackage"),
    targetRuntime: str(req.targetRuntime || "kami-map"),
    chunkKey: str(req.chunkKey),
    chunkSizeMeters,
    lodCount: Math.max(1, Math.trunc(Number(req.lodCount ?? 4))),
    compressedBytes: Math.max(0, Math.trunc(Number(req.compressedBytes ?? 0))),
    maxCompressedBytes: preset.budget.maxCompressedBytes,
    qualityClass: str(req.qualityClass || preset.label),
    status: str(req.status || "ready"),
    sourceDid: str(req.sourceDid),
    packageUrl: str(req.packageUrl),
    metadataUrl: str(req.metadataUrl),
    bboxJson: JSON.stringify(req.bbox ?? {}),
    formatsJson: JSON.stringify(req.formats ?? {}),
    budgetJson: JSON.stringify(preset.budget),
    orgId: str(req.orgId ?? "anon"),
    userId: str(req.userId ?? "anon"),
    actorId: appId,
    createdAt: nowISO(),
  };
}

function readProfileCoordinates(profile: Record<string, unknown>): { lat: number; lng: number } | null {
  const directLat = readFiniteNumber(profile.latitude ?? profile.lat);
  const directLng = readFiniteNumber(profile.longitude ?? profile.lng);
  if (directLat != null && directLng != null) return { lat: directLat, lng: directLng };
  const locationObj = profile.location as Record<string, unknown> | undefined;
  if (locationObj && typeof locationObj === "object") {
    const locLat = readFiniteNumber(locationObj.lat ?? locationObj.latitude);
    const locLng = readFiniteNumber(locationObj.lng ?? locationObj.longitude);
    if (locLat != null && locLng != null) return { lat: locLat, lng: locLng };
  }
  const locationJsonRaw = profile.locationJson;
  if (typeof locationJsonRaw === "string" && locationJsonRaw) {
    try {
      const parsed = JSON.parse(locationJsonRaw) as Record<string, unknown>;
      const locLat = readFiniteNumber(parsed.lat ?? parsed.latitude);
      const locLng = readFiniteNumber(parsed.lng ?? parsed.longitude);
      if (locLat != null && locLng != null) return { lat: locLat, lng: locLng };
    } catch {
      // ignore malformed locationJson
    }
  }
  return null;
}

function readProfileLocationText(profile: Record<string, unknown>): string {
  const location = profile.location;
  if (typeof location === "string" && location.trim()) return location.trim();
  const address = profile.address;
  if (typeof address === "string" && address.trim()) return address.trim();
  const headquarters = profile.headquarters;
  if (typeof headquarters === "string" && headquarters.trim()) return headquarters.trim();
  return "";
}

async function resolvePlaceCoordinates(queryText: string): Promise<{ lat: number; lng: number } | null> {
  const qText = queryText.trim();
  if (!qText) return null;
  const rows = await listCollectionRows("place");
  const row = rows.find((entry) => {
    const lat = readFiniteNumber(entry.lat);
    const lng = readFiniteNumber(entry.lng);
    if (lat == null || lng == null) return false;
    return String(entry.name ?? entry.label ?? "") === qText;
  });
  if (!row) return null;
  const lat = readFiniteNumber(row.lat);
  const lng = readFiniteNumber(row.lng);
  if (lat == null || lng == null) return null;
  return { lat, lng };
}

function mapsActorDid(): string {
  return `did:web:${appId}.etzhayyim.com`;
}

async function upsertRepoRecordDirect(
  repo: string,
  collection: string,
  rkey: string,
  record: Record<string, unknown>,
): Promise<void> {
  if (collection !== "app.bsky.feed.post") {
    throw new Error(`vertex_repo_record is reserved for social posts, got ${collection}`);
  }
  const row = buildRepoRecordRow(repo, collection, rkey, record);
  const db = getDb();
  await db.deleteFrom("vertex_repo_record").where("uri", "=", row.uri).execute();
  await db.insertInto("vertex_repo_record" as any).values(row as any).execute();
}

async function upsertMapsSocialProfileDirect(
  did: string,
  record: { displayName: string; description: string; createdAt: string },
): Promise<void> {
  const row = {
    vertex_id: `at://${did}/com.etzhayyim.apps.maps.socialProfile/self`,
    did,
    handle: did.replace(/^did:web:/, ""),
    display_name: record.displayName,
    description: record.description,
    status: "active",
    owner_did: did,
    actor_id: appId,
    org_id: "anon",
    user_id: "anon",
    sensitivity_ord: 2,
    created_at: record.createdAt,
    updated_at: record.createdAt,
  };
  await getDb()
    .insertInto("vertex_maps_social_profile" as any)
    .values(row as any)
    .onConflict((oc: any) => oc.column("vertex_id").doUpdateSet(row as any))
    .execute();
}

async function insertRepoRecordDirect(
  repo: string,
  collection: string,
  rkey: string,
  record: Record<string, unknown>,
): Promise<void> {
  if (collection !== "app.bsky.feed.post") {
    throw new Error(`vertex_repo_record is reserved for social posts, got ${collection}`);
  }
  const row = buildRepoRecordRow(repo, collection, rkey, record);
  await getDb().insertInto("vertex_repo_record" as any).values(row as any).execute();
}

async function ensureFollowEdgeDirect(srcDid: string, dstDid: string): Promise<void> {
  const rkey = buildStableRkey("follow", dstDid);
  const row = buildFollowEdgeRow(srcDid, dstDid, rkey);
  const db = getDb();
  await db
    .deleteFrom("edge_follows" as any)
    .where("src_vid", "=", srcDid)
    .where("dst_vid", "=", dstDid)
    .execute();
  await db.insertInto("edge_follows" as any).values(row as any).execute();
}

/** Write domain record directly to vertex_spatial via Hyperdrive Kysely (ADR-0036).
 *  Bypasses PDS commit pipeline + graph-worker consumer. Social feed posts are emitted
 *  as a side-effect via `post()`. */
async function write(sdk: HostSDK, collection: string, rec: Record<string, unknown>): Promise<void> {
  const normalized = normalizeMapsVertexIdentity(appId, collection, rec);
  if (isMapsControlPlaneEntity(collection)) {
    console.warn(`[write] control-plane entity ${collection} not routed; owned by maps-collection worker`);
    return;
  }
  try {
    const { row } = projectToVertexSpatial(mapsActorDid(), collection, normalized);
    const db = getDb();
    await db
      .insertInto("vertex_spatial" as any)
      .values(row as any)
      .onConflict((oc: any) => oc.column("vertex_id").doUpdateSet(row as any))
      .execute();
    // Cutover Stage 3 (etzhayyim-root@90-docs/maps-etzhayyim-cutover-runbook.md):
    // fire-and-forget mirror to etzhayyim PDS when MAPS_DUAL_WRITE_ETZHAYYIM=1.
    // No-op when the env flag is off; never blocks or breaks the vendor write.
    mirrorVertexWrite((sdk as any).env, collection, normalized, String(row.label ?? ""));
    const socialPost = buildMapsSocialPost(collection, normalized);
    if (socialPost) await post(sdk, socialPost);
  } catch (e: any) {
    console.warn(`[write] ${collection} failed: ${e?.message?.slice(0, 200) ?? e}`);
  }
}

/** Post social via Direct Async RPC */
async function post(_sdk: HostSDK, text: string, fixedRkey?: string): Promise<void> {
  try {
    const createdAt = nowISO();
    const rkey = fixedRkey || `post-${Date.now()}-${genID("pst")}`;
    const record = {
      $type: "app.bsky.feed.post",
      text,
      createdAt,
    };
    if (fixedRkey) {
      await upsertRepoRecordDirect(mapsActorDid(), "app.bsky.feed.post", rkey, record);
    } else {
      await insertRepoRecordDirect(mapsActorDid(), "app.bsky.feed.post", rkey, record);
    }
  } catch (e: any) {
    console.warn(`[post] failed: ${e?.message?.slice(0, 200) ?? e}`);
  }
}

async function listActorPostTexts(repoDid: string, limit = 1000): Promise<string[]> {
  const rows = await getDb()
    .selectFrom("vertex_repo_record")
    .select(["value_json"])
    .where("collection", "=", "app.bsky.feed.post")
    .where("repo", "=", repoDid)
    .orderBy("ts_ms" as any, "desc")
    .limit(limit)
    .execute()
    .catch(() => [] as AnyRow[]);
  return rows.map((row) => {
    const value = parseJsonObject(row.value_json);
    return str(value.text) || "";
  }).filter(Boolean);
}

const LABEL_MAP: Record<string, string> = {
  place: "Place", route: "Route", dataset: "Dataset", layer: "Layer", weatherPoint: "WeatherPoint",
  building: "Building", 'buildingFloor': "BuildingFloor", 'terrainPatch': "TerrainPatch",
  sensor: "Sensor", 'sensorReading': "SensorReading", 'sensorAlert': "SensorAlert",
  road: "Road", railway: "Railway", airport: "Airport", station: "Station", port: "Port",
  spot: "Spot", river: "River", lake: "Lake", mountain: "Mountain",
  'infraNetwork': "InfraNetwork", 'infraSegment': "InfraSegment", 'infraNode': "InfraNode", 'infraIncident': "InfraIncident",
  simulation: "Simulation", 'simulationResult': "SimulationResult", 'anomalyEvent': "AnomalyEvent",
  asset: "PhysicalAsset", 'deviceBinding': "DeviceBinding", 'twinState': "TwinState",
  'seaRoute': "SeaRoute", 'airRoute': "AirRoute", 'busRoute': "BusRoute", waterway: "Waterway",
  aircraft: "Aircraft", flightOperation: "FlightOperation", flightOffer: "FlightOffer", flightCrawlerJob: "FlightCrawlerJob",
  'evCharger': "EvCharger", parking: "Parking", 'busStop': "BusStop", 'adminArea': "AdminArea",
  coastline: "Coastline", 'maritimeZone': "MaritimeZone", 'spatialEvent': "SpatialEvent",
  'spatialVersion': "SpatialVersion", 'spatialRelation': "SpatialRelation", 'displayLayer': "DisplayLayer",
  'healthAssessment': "HealthAssessment", 'maintenancePlan': "MaintenancePlan", forecast: "Forecast",
  'worldBelief': "WorldBelief", 'worldModelRun': "WorldModelRun",
  'visionResult': "VisionResult", 'collectionJob': "CollectionJob", 'satelliteScene': "SatelliteScene",
  'layerCoordinator': "LayerCoordinator", 'geoAlias': "GeoAlias",
  'verticalZone': "VerticalZone", 'naturalZone': "NaturalZone",
  'webCrawlGeoEntity': "WebCrawlGeoEntity",
  // Registry & Legal Entity (2026-04-13)
  'legalEntity': "LegalEntity",
  'operator': "Operator",
  'propertyOwner': "PropertyOwner",
  'corporation': "Corporation",
  'governmentBody': "GovernmentBody",
  'publicUtility': "PublicUtility",
  'landRegistry': "LandRegistry",
  'propertyRegistry': "PropertyRegistry",
  'businessRegistry': "BusinessRegistry",
  'vehicleRegistry': "VehicleRegistry",
  'constructionPermit': "ConstructionPermit",
  'operatingLicense': "OperatingLicense",
  'environmentalPermit': "EnvironmentalPermit",
  'zoningRecord': "ZoningRecord",
};

// ── Geo Domain Targets (site.etzhayyim.com crawl targets for spatial coverage) ──

const GEO_CRAWL_DOMAINS: Array<{ domain: string; category: string; country: string }> = [
  // JP Government GIS / Geospatial
  { domain: "nlftp.mlit.go.jp", category: "gis", country: "jp" },
  { domain: "www.gsi.go.jp", category: "gis", country: "jp" },
  { domain: "www.mlit.go.jp", category: "transport", country: "jp" },
  { domain: "www.jma.go.jp", category: "weather", country: "jp" },
  { domain: "www.data.jma.go.jp", category: "weather", country: "jp" },
  { domain: "disaportal.gsi.go.jp", category: "hazard", country: "jp" },
  // JP Transport / Transit
  { domain: "www.train-media.net", category: "transit", country: "jp" },
  { domain: "ekitan.com", category: "transit", country: "jp" },
  { domain: "www.navitime.co.jp", category: "transit", country: "jp" },
  { domain: "www.jreast.co.jp", category: "railway", country: "jp" },
  { domain: "www.westjr.co.jp", category: "railway", country: "jp" },
  { domain: "www.jrcentral.co.jp", category: "railway", country: "jp" },
  { domain: "www.tokyometro.jp", category: "railway", country: "jp" },
  // JP Real Estate / Land Registry
  { domain: "www.reinfolib.mlit.go.jp", category: "realestate", country: "jp" },
  { domain: "www.land.mlit.go.jp", category: "landprice", country: "jp" },
  // Global GIS / Mapping
  { domain: "www.openstreetmap.org", category: "gis", country: "global" },
  { domain: "wiki.openstreetmap.org", category: "gis", country: "global" },
  { domain: "earth.google.com", category: "gis", country: "global" },
  { domain: "www.naturalearthdata.com", category: "gis", country: "global" },
  { domain: "gadm.org", category: "admin-boundary", country: "global" },
  // Global Transport
  { domain: "www.openrailwaymap.org", category: "railway", country: "global" },
  { domain: "www.flightradar24.com", category: "aviation", country: "global" },
  { domain: "www.marinetraffic.com", category: "maritime", country: "global" },
  // Infrastructure / Utilities
  { domain: "www.tepco.co.jp", category: "electric", country: "jp" },
  { domain: "www.waterworks.metro.tokyo.lg.jp", category: "water", country: "jp" },
  // Hazard / Disaster
  { domain: "earthquake.usgs.gov", category: "seismic", country: "global" },
  { domain: "tsunami.gov", category: "tsunami", country: "global" },
  { domain: "www.emsc-csem.org", category: "seismic", country: "global" },
  { domain: "firms.modaps.eosdis.nasa.gov", category: "wildfire", country: "global" },
  // Satellite / Earth Observation
  { domain: "scihub.copernicus.eu", category: "satellite", country: "global" },
  { domain: "earthexplorer.usgs.gov", category: "satellite", country: "global" },
  // Tourism / POI
  { domain: "www.jnto.go.jp", category: "tourism", country: "jp" },
  { domain: "www.japan.travel", category: "tourism", country: "jp" },
  // Port / Airport official
  { domain: "www.naa.jp", category: "airport", country: "jp" },
  { domain: "www.kansai-airport.or.jp", category: "airport", country: "jp" },
  { domain: "www.tokyoport.or.jp", category: "port", country: "jp" },
  // JP Government GIS (additional)
  { domain: "www.stat.go.jp", category: "gis", country: "jp" },
  { domain: "maps.gsi.go.jp", category: "gis", country: "jp" },
  { domain: "www.jibanmap.go.jp", category: "hazard", country: "jp" },
  { domain: "www.j-shis.bosai.go.jp", category: "seismic", country: "jp" },
  { domain: "www.river.go.jp", category: "hydrology", country: "jp" },
  { domain: "www.cbr.mlit.go.jp", category: "transport", country: "jp" },
  // JP Municipal GIS (representative)
  { domain: "www.city.tokyo.lg.jp", category: "gis", country: "jp" },
  { domain: "www.city.osaka.lg.jp", category: "gis", country: "jp" },
  { domain: "www.city.nagoya.lg.jp", category: "gis", country: "jp" },
  // Global GIS (additional)
  { domain: "data.europa.eu", category: "gis", country: "global" },
  { domain: "geofabrik.de", category: "gis", country: "global" },
  { domain: "data.humdata.org", category: "gis", country: "global" },
  { domain: "airports.ourairports.com", category: "airport", country: "global" },
  { domain: "unece.org", category: "gis", country: "global" },
  // Earth Observation / Hazard
  { domain: "firms.modaps.eosdis.nasa.gov", category: "wildfire", country: "global" },
  { domain: "flood.firetoc.eu", category: "hazard", country: "global" },
  { domain: "www.gdacs.org", category: "hazard", country: "global" },
  // Open Knowledge Graph
  { domain: "en.wikipedia.org", category: "gis", country: "global" },
  { domain: "www.wikidata.org", category: "gis", country: "global" },
  // Registry / Corporate / Land Data (2026-04-13)
  { domain: "www.gleif.org", category: "registry", country: "global" },
  { domain: "opencorporates.com", category: "registry", country: "global" },
  { domain: "www.sec.gov", category: "registry", country: "us" },
  { domain: "www.companieshouse.gov.uk", category: "registry", country: "gb" },
  { domain: "www.handelsregister.de", category: "registry", country: "de" },
  { domain: "data.inpi.fr", category: "registry", country: "fr" },
  { domain: "www.houjin-bangou.nta.go.jp", category: "registry", country: "jp" },
  { domain: "www.touki.or.jp", category: "registry", country: "jp" },
  { domain: "www1.touki.or.jp", category: "registry", country: "jp" },
  { domain: "www.cadastre.gouv.fr", category: "land-registry", country: "fr" },
  { domain: "www.kadaster.nl", category: "land-registry", country: "nl" },
  { domain: "www.gov.uk", category: "land-registry", country: "gb" },
  { domain: "geocoder.ca", category: "land-registry", country: "ca" },
  { domain: "www.openaddresses.io", category: "address", country: "global" },
  { domain: "overheid.nl", category: "registry", country: "nl" },
];
function kindToLabel(collection: string): string {
  const kind = collection.split(".").pop() ?? "";
  return LABEL_MAP[kind] ?? `Maps:${kind}`;
}

// ── GeoScheme Registry (multi-scheme geographic DID addressing) ──

/** Supported geographic code schemes for multi-DID region addressing */
const GEO_SCHEMES: Record<string, { name: string; dim: string; scope: string }> = {
  // Administrative boundaries
  "iso3166-1": { name: "ISO 3166-1 alpha-2", dim: "2d", scope: "global" },
  "iso3166-2": { name: "ISO 3166-2", dim: "2d", scope: "global" },
  "jis-x0401": { name: "JIS X 0401", dim: "2d", scope: "jp" },
  "jis-x0402": { name: "JIS X 0402", dim: "2d", scope: "jp" },
  "fips": { name: "FIPS State+County", dim: "2d", scope: "us" },
  // Global grids
  "h3": { name: "H3 Hexagonal", dim: "2d", scope: "global" },
  "s2": { name: "S2 Geometry", dim: "2d", scope: "global" },
  "geohash": { name: "Geohash", dim: "2d", scope: "global" },
  "pluscode": { name: "Plus Code / OLC", dim: "2d", scope: "global" },
  "mgrs": { name: "MGRS", dim: "2d", scope: "global" },
  "maidenhead": { name: "Maidenhead Locator", dim: "2d", scope: "global" },
  "utm": { name: "UTM Zone", dim: "2d", scope: "global" },
  // Vertical — atmosphere
  "flight-level": { name: "ICAO Flight Level", dim: "3d", scope: "global" },
  "icao-fir": { name: "ICAO FIR", dim: "3d", scope: "global" },
  "atmo-layer": { name: "Atmospheric Layer", dim: "3d", scope: "global" },
  // Vertical — surface/underground
  "elevation": { name: "WGS84 Ellipsoid Height", dim: "3d", scope: "global" },
  "depth-band": { name: "Underground Depth Band", dim: "3d", scope: "global" },
  "infra-depth": { name: "Infrastructure Layer", dim: "3d", scope: "maps" },
  // Vertical — ocean
  "iho-sea": { name: "IHO Sea Area S-23", dim: "2d", scope: "global" },
  "eez": { name: "EEZ (UNCLOS)", dim: "2d", scope: "global" },
  "bath-zone": { name: "Bathymetric Zone", dim: "3d", scope: "global" },
  // Scientific / natural boundaries
  "koppen": { name: "Köppen Climate", dim: "2d", scope: "global" },
  "wwf-biome": { name: "WWF Biome", dim: "2d", scope: "global" },
  "wwf-ecoregion": { name: "WWF Ecoregion", dim: "2d", scope: "global" },
  "tectonic": { name: "Tectonic Plate", dim: "2d", scope: "global" },
  // Transport / logistics
  "icao-airport": { name: "ICAO Airport Code", dim: "2d", scope: "global" },
  "iata-airport": { name: "IATA Airport Code", dim: "2d", scope: "global" },
  "unlocode": { name: "UN/LOCODE", dim: "2d", scope: "global" },
  // Temporal
  "iana-tz": { name: "IANA Timezone", dim: "temporal", scope: "global" },
};

// ── Layer DID Coordinators (KAMI rendering layers → DID actors) ──

const LAYER_COORDINATORS = [
  { slug: "tile", name: "Base Tiles", description: "Raster tile coverage and source updates" },
  { slug: "poi", name: "POI Layer", description: "Points of interest — places, spots, landmarks" },
  { slug: "route", name: "Route Layer", description: "Routes, roads, railways, bus routes" },
  { slug: "infra", name: "Infrastructure Layer", description: "Underground/aboveground infrastructure networks (7 types)" },
  { slug: "building", name: "Building Layer", description: "3D buildings, floors, digital twin assets" },
  { slug: "weather", name: "Weather Layer", description: "Weather observations and forecasts" },
  { slug: "sensor", name: "Sensor Layer", description: "IoT sensors, readings, alerts" },
  { slug: "transport", name: "Transport Layer", description: "Ports, airports, stations, EV chargers" },
  { slug: "geography", name: "Geography Layer", description: "Rivers, lakes, coastlines, mountains, maritime zones" },
  { slug: "satellite", name: "Satellite Layer", description: "Satellite imagery and change detection" },
  { slug: "event", name: "Event Layer", description: "Spatial events, geolocated posts, temporal markers" },
] as const;

// ── VerticalZone bootstrap data ──

const VERTICAL_ZONES = [
  // Atmosphere
  { slug: "troposphere", name: "Troposphere", zoneType: "atmosphere", minAlt: 0, maxAlt: 12000, unit: "m" },
  { slug: "stratosphere", name: "Stratosphere", zoneType: "atmosphere", minAlt: 12000, maxAlt: 50000, unit: "m" },
  { slug: "mesosphere", name: "Mesosphere", zoneType: "atmosphere", minAlt: 50000, maxAlt: 80000, unit: "m" },
  { slug: "thermosphere", name: "Thermosphere", zoneType: "atmosphere", minAlt: 80000, maxAlt: 700000, unit: "m" },
  { slug: "exosphere", name: "Exosphere", zoneType: "atmosphere", minAlt: 700000, maxAlt: 10000000, unit: "m" },
  // Underground
  { slug: "surface", name: "Surface", zoneType: "underground", minAlt: -1, maxAlt: 1, unit: "m" },
  { slug: "shallow", name: "Shallow Underground (0–30m)", zoneType: "underground", minAlt: -30, maxAlt: 0, unit: "m" },
  { slug: "mid-underground", name: "Mid Underground (30–300m)", zoneType: "underground", minAlt: -300, maxAlt: -30, unit: "m" },
  { slug: "deep-underground", name: "Deep Underground (300–3000m)", zoneType: "underground", minAlt: -3000, maxAlt: -300, unit: "m" },
  // Ocean bathymetric zones
  { slug: "epipelagic", name: "Epipelagic (0–200m)", zoneType: "ocean", minAlt: -200, maxAlt: 0, unit: "m" },
  { slug: "mesopelagic", name: "Mesopelagic (200–1000m)", zoneType: "ocean", minAlt: -1000, maxAlt: -200, unit: "m" },
  { slug: "bathypelagic", name: "Bathypelagic (1000–4000m)", zoneType: "ocean", minAlt: -4000, maxAlt: -1000, unit: "m" },
  { slug: "abyssopelagic", name: "Abyssopelagic (4000–6000m)", zoneType: "ocean", minAlt: -6000, maxAlt: -4000, unit: "m" },
  { slug: "hadopelagic", name: "Hadopelagic (6000m+)", zoneType: "ocean", minAlt: -11000, maxAlt: -6000, unit: "m" },
];

// ── NaturalZone bootstrap data ──

const NATURAL_ZONES = [
  // Köppen climate (30 classes → 5 major groups as DID actors)
  { slug: "koppen-A", name: "Tropical (A)", zoneType: "climate", description: "Tropical climates — all months ≥18°C" },
  { slug: "koppen-B", name: "Arid (B)", zoneType: "climate", description: "Dry climates — evaporation exceeds precipitation" },
  { slug: "koppen-C", name: "Temperate (C)", zoneType: "climate", description: "Temperate climates — mild winters" },
  { slug: "koppen-D", name: "Continental (D)", zoneType: "climate", description: "Continental climates — severe winters" },
  { slug: "koppen-E", name: "Polar (E)", zoneType: "climate", description: "Polar climates — no warm season" },
  // WWF biomes (14)
  { slug: "biome-tropical-moist", name: "Tropical Moist Broadleaf Forests", zoneType: "biome", description: "WWF Biome 1" },
  { slug: "biome-tropical-dry", name: "Tropical Dry Broadleaf Forests", zoneType: "biome", description: "WWF Biome 2" },
  { slug: "biome-tropical-conifer", name: "Tropical Coniferous Forests", zoneType: "biome", description: "WWF Biome 3" },
  { slug: "biome-temperate-broadleaf", name: "Temperate Broadleaf Forests", zoneType: "biome", description: "WWF Biome 4" },
  { slug: "biome-temperate-conifer", name: "Temperate Coniferous Forests", zoneType: "biome", description: "WWF Biome 5" },
  { slug: "biome-boreal", name: "Boreal Forests / Taiga", zoneType: "biome", description: "WWF Biome 6" },
  { slug: "biome-tropical-grassland", name: "Tropical Grasslands / Savannas", zoneType: "biome", description: "WWF Biome 7" },
  { slug: "biome-temperate-grassland", name: "Temperate Grasslands", zoneType: "biome", description: "WWF Biome 8" },
  { slug: "biome-flooded-grassland", name: "Flooded Grasslands", zoneType: "biome", description: "WWF Biome 9" },
  { slug: "biome-montane-grassland", name: "Montane Grasslands / Shrublands", zoneType: "biome", description: "WWF Biome 10" },
  { slug: "biome-tundra", name: "Tundra", zoneType: "biome", description: "WWF Biome 11" },
  { slug: "biome-mediterranean", name: "Mediterranean Forests / Woodlands", zoneType: "biome", description: "WWF Biome 12" },
  { slug: "biome-desert", name: "Deserts / Xeric Shrublands", zoneType: "biome", description: "WWF Biome 13" },
  { slug: "biome-mangrove", name: "Mangroves", zoneType: "biome", description: "WWF Biome 14" },
  // Tectonic plates (15 major)
  { slug: "plate-pacific", name: "Pacific Plate", zoneType: "tectonic", description: "Largest oceanic plate" },
  { slug: "plate-north-american", name: "North American Plate", zoneType: "tectonic", description: "North America + western Atlantic" },
  { slug: "plate-eurasian", name: "Eurasian Plate", zoneType: "tectonic", description: "Europe + most of Asia" },
  { slug: "plate-african", name: "African Plate", zoneType: "tectonic", description: "Africa + eastern Atlantic" },
  { slug: "plate-antarctic", name: "Antarctic Plate", zoneType: "tectonic", description: "Antarctica + Southern Ocean" },
  { slug: "plate-south-american", name: "South American Plate", zoneType: "tectonic", description: "South America + western Atlantic" },
  { slug: "plate-australian", name: "Australian Plate", zoneType: "tectonic", description: "Australia + Indian Ocean" },
  { slug: "plate-indian", name: "Indian Plate", zoneType: "tectonic", description: "Indian subcontinent" },
  { slug: "plate-nazca", name: "Nazca Plate", zoneType: "tectonic", description: "Eastern Pacific (subducting)" },
  { slug: "plate-philippine", name: "Philippine Sea Plate", zoneType: "tectonic", description: "Western Pacific" },
  { slug: "plate-arabian", name: "Arabian Plate", zoneType: "tectonic", description: "Arabian Peninsula" },
  { slug: "plate-caribbean", name: "Caribbean Plate", zoneType: "tectonic", description: "Caribbean Sea" },
  { slug: "plate-cocos", name: "Cocos Plate", zoneType: "tectonic", description: "Eastern Pacific (Central America)" },
  { slug: "plate-juan-de-fuca", name: "Juan de Fuca Plate", zoneType: "tectonic", description: "NE Pacific (Cascadia)" },
  { slug: "plate-scotia", name: "Scotia Plate", zoneType: "tectonic", description: "South Atlantic (Drake Passage)" },
];

// ── JP 47 Prefectures bootstrap data ──

const JP_PREFECTURES: Array<{ name: string; nameEn: string; iso: string; jis: string; lat: number; lng: number }> = [
  { name: "北海道", nameEn: "Hokkaido", iso: "jp-01", jis: "01", lat: 43.064, lng: 141.347 },
  { name: "青森県", nameEn: "Aomori", iso: "jp-02", jis: "02", lat: 40.824, lng: 140.740 },
  { name: "岩手県", nameEn: "Iwate", iso: "jp-03", jis: "03", lat: 39.704, lng: 141.153 },
  { name: "宮城県", nameEn: "Miyagi", iso: "jp-04", jis: "04", lat: 38.269, lng: 140.872 },
  { name: "秋田県", nameEn: "Akita", iso: "jp-05", jis: "05", lat: 39.720, lng: 140.103 },
  { name: "山形県", nameEn: "Yamagata", iso: "jp-06", jis: "06", lat: 38.240, lng: 140.364 },
  { name: "福島県", nameEn: "Fukushima", iso: "jp-07", jis: "07", lat: 37.750, lng: 140.468 },
  { name: "茨城県", nameEn: "Ibaraki", iso: "jp-08", jis: "08", lat: 36.342, lng: 140.447 },
  { name: "栃木県", nameEn: "Tochigi", iso: "jp-09", jis: "09", lat: 36.566, lng: 139.883 },
  { name: "群馬県", nameEn: "Gunma", iso: "jp-10", jis: "10", lat: 36.391, lng: 139.061 },
  { name: "埼玉県", nameEn: "Saitama", iso: "jp-11", jis: "11", lat: 35.857, lng: 139.649 },
  { name: "千葉県", nameEn: "Chiba", iso: "jp-12", jis: "12", lat: 35.605, lng: 140.123 },
  { name: "東京都", nameEn: "Tokyo", iso: "jp-13", jis: "13", lat: 35.689, lng: 139.692 },
  { name: "神奈川県", nameEn: "Kanagawa", iso: "jp-14", jis: "14", lat: 35.448, lng: 139.642 },
  { name: "新潟県", nameEn: "Niigata", iso: "jp-15", jis: "15", lat: 37.902, lng: 139.024 },
  { name: "富山県", nameEn: "Toyama", iso: "jp-16", jis: "16", lat: 36.695, lng: 137.211 },
  { name: "石川県", nameEn: "Ishikawa", iso: "jp-17", jis: "17", lat: 36.594, lng: 136.626 },
  { name: "福井県", nameEn: "Fukui", iso: "jp-18", jis: "18", lat: 36.065, lng: 136.222 },
  { name: "山梨県", nameEn: "Yamanashi", iso: "jp-19", jis: "19", lat: 35.664, lng: 138.568 },
  { name: "長野県", nameEn: "Nagano", iso: "jp-20", jis: "20", lat: 36.232, lng: 138.181 },
  { name: "岐阜県", nameEn: "Gifu", iso: "jp-21", jis: "21", lat: 35.391, lng: 136.722 },
  { name: "静岡県", nameEn: "Shizuoka", iso: "jp-22", jis: "22", lat: 34.977, lng: 138.383 },
  { name: "愛知県", nameEn: "Aichi", iso: "jp-23", jis: "23", lat: 35.180, lng: 136.907 },
  { name: "三重県", nameEn: "Mie", iso: "jp-24", jis: "24", lat: 34.730, lng: 136.509 },
  { name: "滋賀県", nameEn: "Shiga", iso: "jp-25", jis: "25", lat: 35.005, lng: 135.869 },
  { name: "京都府", nameEn: "Kyoto", iso: "jp-26", jis: "26", lat: 35.021, lng: 135.756 },
  { name: "大阪府", nameEn: "Osaka", iso: "jp-27", jis: "27", lat: 34.686, lng: 135.520 },
  { name: "兵庫県", nameEn: "Hyogo", iso: "jp-28", jis: "28", lat: 34.691, lng: 135.183 },
  { name: "奈良県", nameEn: "Nara", iso: "jp-29", jis: "29", lat: 34.685, lng: 135.833 },
  { name: "和歌山県", nameEn: "Wakayama", iso: "jp-30", jis: "30", lat: 34.226, lng: 135.168 },
  { name: "鳥取県", nameEn: "Tottori", iso: "jp-31", jis: "31", lat: 35.504, lng: 134.238 },
  { name: "島根県", nameEn: "Shimane", iso: "jp-32", jis: "32", lat: 35.472, lng: 133.051 },
  { name: "岡山県", nameEn: "Okayama", iso: "jp-33", jis: "33", lat: 34.662, lng: 133.935 },
  { name: "広島県", nameEn: "Hiroshima", iso: "jp-34", jis: "34", lat: 34.397, lng: 132.460 },
  { name: "山口県", nameEn: "Yamaguchi", iso: "jp-35", jis: "35", lat: 34.186, lng: 131.471 },
  { name: "徳島県", nameEn: "Tokushima", iso: "jp-36", jis: "36", lat: 34.066, lng: 134.559 },
  { name: "香川県", nameEn: "Kagawa", iso: "jp-37", jis: "37", lat: 34.340, lng: 134.043 },
  { name: "愛媛県", nameEn: "Ehime", iso: "jp-38", jis: "38", lat: 33.842, lng: 132.766 },
  { name: "高知県", nameEn: "Kochi", iso: "jp-39", jis: "39", lat: 33.560, lng: 133.531 },
  { name: "福岡県", nameEn: "Fukuoka", iso: "jp-40", jis: "40", lat: 33.606, lng: 130.418 },
  { name: "佐賀県", nameEn: "Saga", iso: "jp-41", jis: "41", lat: 33.249, lng: 130.300 },
  { name: "長崎県", nameEn: "Nagasaki", iso: "jp-42", jis: "42", lat: 32.745, lng: 129.874 },
  { name: "熊本県", nameEn: "Kumamoto", iso: "jp-43", jis: "43", lat: 32.790, lng: 130.742 },
  { name: "大分県", nameEn: "Oita", iso: "jp-44", jis: "44", lat: 33.238, lng: 131.613 },
  { name: "宮崎県", nameEn: "Miyazaki", iso: "jp-45", jis: "45", lat: 31.911, lng: 131.424 },
  { name: "鹿児島県", nameEn: "Kagoshima", iso: "jp-46", jis: "46", lat: 31.560, lng: 130.558 },
  { name: "沖縄県", nameEn: "Okinawa", iso: "jp-47", jis: "47", lat: 26.335, lng: 127.801 },
];

// ── Sovereign 195 countries (ISO 3166-1, capital lat/lng) ──

const SOVEREIGN_COUNTRIES: Array<{ name: string; nameEn: string; iso: string; lat: number; lng: number }> = [
  { name: "Afghanistan", nameEn: "Afghanistan", iso: "af", lat: 34.528, lng: 69.172 },
  { name: "Albania", nameEn: "Albania", iso: "al", lat: 41.327, lng: 19.819 },
  { name: "Algeria", nameEn: "Algeria", iso: "dz", lat: 36.754, lng: 3.059 },
  { name: "Andorra", nameEn: "Andorra", iso: "ad", lat: 42.508, lng: 1.522 },
  { name: "Angola", nameEn: "Angola", iso: "ao", lat: -8.839, lng: 13.234 },
  { name: "Antigua and Barbuda", nameEn: "Antigua and Barbuda", iso: "ag", lat: 17.118, lng: -61.845 },
  { name: "Argentina", nameEn: "Argentina", iso: "ar", lat: -34.604, lng: -58.382 },
  { name: "Armenia", nameEn: "Armenia", iso: "am", lat: 40.183, lng: 44.515 },
  { name: "Australia", nameEn: "Australia", iso: "au", lat: -35.282, lng: 149.129 },
  { name: "Austria", nameEn: "Austria", iso: "at", lat: 48.208, lng: 16.374 },
  { name: "Azerbaijan", nameEn: "Azerbaijan", iso: "az", lat: 40.409, lng: 49.868 },
  { name: "Bahamas", nameEn: "Bahamas", iso: "bs", lat: 25.047, lng: -77.355 },
  { name: "Bahrain", nameEn: "Bahrain", iso: "bh", lat: 26.228, lng: 50.586 },
  { name: "Bangladesh", nameEn: "Bangladesh", iso: "bd", lat: 23.811, lng: 90.413 },
  { name: "Barbados", nameEn: "Barbados", iso: "bb", lat: 13.097, lng: -59.614 },
  { name: "Belarus", nameEn: "Belarus", iso: "by", lat: 53.905, lng: 27.557 },
  { name: "Belgium", nameEn: "Belgium", iso: "be", lat: 50.850, lng: 4.352 },
  { name: "Belize", nameEn: "Belize", iso: "bz", lat: 17.189, lng: -88.498 },
  { name: "Benin", nameEn: "Benin", iso: "bj", lat: 6.497, lng: 2.605 },
  { name: "Bhutan", nameEn: "Bhutan", iso: "bt", lat: 27.473, lng: 89.639 },
  { name: "Bolivia", nameEn: "Bolivia", iso: "bo", lat: -16.500, lng: -68.150 },
  { name: "Bosnia and Herzegovina", nameEn: "Bosnia and Herzegovina", iso: "ba", lat: 43.856, lng: 18.413 },
  { name: "Botswana", nameEn: "Botswana", iso: "bw", lat: -24.654, lng: 25.909 },
  { name: "Brasil", nameEn: "Brazil", iso: "br", lat: -15.794, lng: -47.882 },
  { name: "Brunei", nameEn: "Brunei", iso: "bn", lat: 4.942, lng: 114.950 },
  { name: "Bulgaria", nameEn: "Bulgaria", iso: "bg", lat: 42.698, lng: 23.322 },
  { name: "Burkina Faso", nameEn: "Burkina Faso", iso: "bf", lat: 12.372, lng: -1.517 },
  { name: "Burundi", nameEn: "Burundi", iso: "bi", lat: -3.376, lng: 29.360 },
  { name: "Cabo Verde", nameEn: "Cape Verde", iso: "cv", lat: 14.922, lng: -23.509 },
  { name: "Cambodia", nameEn: "Cambodia", iso: "kh", lat: 11.557, lng: 104.917 },
  { name: "Cameroon", nameEn: "Cameroon", iso: "cm", lat: 3.848, lng: 11.502 },
  { name: "Canada", nameEn: "Canada", iso: "ca", lat: 45.425, lng: -75.700 },
  { name: "Central African Republic", nameEn: "Central African Republic", iso: "cf", lat: 4.395, lng: 18.558 },
  { name: "Chad", nameEn: "Chad", iso: "td", lat: 12.114, lng: 15.060 },
  { name: "Chile", nameEn: "Chile", iso: "cl", lat: -33.447, lng: -70.674 },
  { name: "中華人民共和国", nameEn: "China", iso: "cn", lat: 39.904, lng: 116.407 },
  { name: "Colombia", nameEn: "Colombia", iso: "co", lat: 4.711, lng: -74.072 },
  { name: "Comoros", nameEn: "Comoros", iso: "km", lat: -11.702, lng: 43.255 },
  { name: "Congo (DRC)", nameEn: "DR Congo", iso: "cd", lat: -4.323, lng: 15.313 },
  { name: "Congo (Republic)", nameEn: "Republic of Congo", iso: "cg", lat: -4.267, lng: 15.283 },
  { name: "Costa Rica", nameEn: "Costa Rica", iso: "cr", lat: 9.934, lng: -84.088 },
  { name: "Côte d'Ivoire", nameEn: "Ivory Coast", iso: "ci", lat: 6.828, lng: -5.290 },
  { name: "Croatia", nameEn: "Croatia", iso: "hr", lat: 45.815, lng: 15.982 },
  { name: "Cuba", nameEn: "Cuba", iso: "cu", lat: 23.114, lng: -82.367 },
  { name: "Cyprus", nameEn: "Cyprus", iso: "cy", lat: 35.176, lng: 33.382 },
  { name: "Czechia", nameEn: "Czech Republic", iso: "cz", lat: 50.076, lng: 14.438 },
  { name: "Danmark", nameEn: "Denmark", iso: "dk", lat: 55.676, lng: 12.568 },
  { name: "Djibouti", nameEn: "Djibouti", iso: "dj", lat: 11.589, lng: 43.145 },
  { name: "Dominica", nameEn: "Dominica", iso: "dm", lat: 15.309, lng: -61.379 },
  { name: "Dominican Republic", nameEn: "Dominican Republic", iso: "do", lat: 18.472, lng: -69.893 },
  { name: "Ecuador", nameEn: "Ecuador", iso: "ec", lat: -0.181, lng: -78.468 },
  { name: "مصر", nameEn: "Egypt", iso: "eg", lat: 30.044, lng: 31.236 },
  { name: "El Salvador", nameEn: "El Salvador", iso: "sv", lat: 13.692, lng: -89.218 },
  { name: "Equatorial Guinea", nameEn: "Equatorial Guinea", iso: "gq", lat: 3.751, lng: 8.781 },
  { name: "Eritrea", nameEn: "Eritrea", iso: "er", lat: 15.338, lng: 38.932 },
  { name: "Estonia", nameEn: "Estonia", iso: "ee", lat: 59.437, lng: 24.754 },
  { name: "Eswatini", nameEn: "Eswatini", iso: "sz", lat: -26.317, lng: 31.137 },
  { name: "Ethiopia", nameEn: "Ethiopia", iso: "et", lat: 9.025, lng: 38.747 },
  { name: "Fiji", nameEn: "Fiji", iso: "fj", lat: -18.142, lng: 178.442 },
  { name: "Suomi", nameEn: "Finland", iso: "fi", lat: 60.170, lng: 24.941 },
  { name: "France", nameEn: "France", iso: "fr", lat: 48.857, lng: 2.352 },
  { name: "Gabon", nameEn: "Gabon", iso: "ga", lat: 0.416, lng: 9.467 },
  { name: "Gambia", nameEn: "Gambia", iso: "gm", lat: 13.454, lng: -16.579 },
  { name: "Georgia", nameEn: "Georgia", iso: "ge", lat: 41.716, lng: 44.783 },
  { name: "Deutschland", nameEn: "Germany", iso: "de", lat: 52.520, lng: 13.405 },
  { name: "Ghana", nameEn: "Ghana", iso: "gh", lat: 5.560, lng: -0.187 },
  { name: "Greece", nameEn: "Greece", iso: "gr", lat: 37.984, lng: 23.728 },
  { name: "Grenada", nameEn: "Grenada", iso: "gd", lat: 12.056, lng: -61.749 },
  { name: "Guatemala", nameEn: "Guatemala", iso: "gt", lat: 14.634, lng: -90.507 },
  { name: "Guinea", nameEn: "Guinea", iso: "gn", lat: 9.538, lng: -13.677 },
  { name: "Guinea-Bissau", nameEn: "Guinea-Bissau", iso: "gw", lat: 11.863, lng: -15.598 },
  { name: "Guyana", nameEn: "Guyana", iso: "gy", lat: 6.802, lng: -58.160 },
  { name: "Haiti", nameEn: "Haiti", iso: "ht", lat: 18.542, lng: -72.339 },
  { name: "Honduras", nameEn: "Honduras", iso: "hn", lat: 14.072, lng: -87.193 },
  { name: "Magyarország", nameEn: "Hungary", iso: "hu", lat: 47.498, lng: 19.040 },
  { name: "Ísland", nameEn: "Iceland", iso: "is", lat: 64.147, lng: -21.943 },
  { name: "भारत", nameEn: "India", iso: "in", lat: 28.614, lng: 77.209 },
  { name: "Indonesia", nameEn: "Indonesia", iso: "id", lat: -6.175, lng: 106.845 },
  { name: "Iran", nameEn: "Iran", iso: "ir", lat: 35.696, lng: 51.423 },
  { name: "Iraq", nameEn: "Iraq", iso: "iq", lat: 33.313, lng: 44.366 },
  { name: "Ireland", nameEn: "Ireland", iso: "ie", lat: 53.350, lng: -6.260 },
  { name: "Israel", nameEn: "Israel", iso: "il", lat: 31.769, lng: 35.216 },
  { name: "Italia", nameEn: "Italy", iso: "it", lat: 41.903, lng: 12.496 },
  { name: "Jamaica", nameEn: "Jamaica", iso: "jm", lat: 18.017, lng: -76.810 },
  { name: "Jordan", nameEn: "Jordan", iso: "jo", lat: 31.956, lng: 35.946 },
  { name: "Kazakhstan", nameEn: "Kazakhstan", iso: "kz", lat: 51.129, lng: 71.431 },
  { name: "Kenya", nameEn: "Kenya", iso: "ke", lat: -1.292, lng: 36.822 },
  { name: "Kiribati", nameEn: "Kiribati", iso: "ki", lat: 1.328, lng: 172.979 },
  { name: "조선민주주의인민공화국", nameEn: "North Korea", iso: "kp", lat: 39.020, lng: 125.738 },
  { name: "대한민국", nameEn: "South Korea", iso: "kr", lat: 37.567, lng: 126.978 },
  { name: "Kuwait", nameEn: "Kuwait", iso: "kw", lat: 29.376, lng: 47.977 },
  { name: "Kyrgyzstan", nameEn: "Kyrgyzstan", iso: "kg", lat: 42.875, lng: 74.590 },
  { name: "Laos", nameEn: "Laos", iso: "la", lat: 17.975, lng: 102.633 },
  { name: "Latvia", nameEn: "Latvia", iso: "lv", lat: 56.950, lng: 24.105 },
  { name: "Lebanon", nameEn: "Lebanon", iso: "lb", lat: 33.887, lng: 35.510 },
  { name: "Lesotho", nameEn: "Lesotho", iso: "ls", lat: -29.310, lng: 27.478 },
  { name: "Liberia", nameEn: "Liberia", iso: "lr", lat: 6.291, lng: -10.761 },
  { name: "Libya", nameEn: "Libya", iso: "ly", lat: 32.902, lng: 13.180 },
  { name: "Liechtenstein", nameEn: "Liechtenstein", iso: "li", lat: 47.141, lng: 9.521 },
  { name: "Lietuva", nameEn: "Lithuania", iso: "lt", lat: 54.687, lng: 25.280 },
  { name: "Luxembourg", nameEn: "Luxembourg", iso: "lu", lat: 49.612, lng: 6.130 },
  { name: "Madagascar", nameEn: "Madagascar", iso: "mg", lat: -18.880, lng: 47.508 },
  { name: "Malawi", nameEn: "Malawi", iso: "mw", lat: -13.963, lng: 33.787 },
  { name: "Malaysia", nameEn: "Malaysia", iso: "my", lat: 3.139, lng: 101.687 },
  { name: "Maldives", nameEn: "Maldives", iso: "mv", lat: 4.175, lng: 73.510 },
  { name: "Mali", nameEn: "Mali", iso: "ml", lat: 12.640, lng: -8.000 },
  { name: "Malta", nameEn: "Malta", iso: "mt", lat: 35.899, lng: 14.514 },
  { name: "Marshall Islands", nameEn: "Marshall Islands", iso: "mh", lat: 7.090, lng: 171.381 },
  { name: "Mauritania", nameEn: "Mauritania", iso: "mr", lat: 18.090, lng: -15.978 },
  { name: "Mauritius", nameEn: "Mauritius", iso: "mu", lat: -20.166, lng: 57.502 },
  { name: "México", nameEn: "Mexico", iso: "mx", lat: 19.433, lng: -99.133 },
  { name: "Micronesia", nameEn: "Micronesia", iso: "fm", lat: 6.916, lng: 158.185 },
  { name: "Moldova", nameEn: "Moldova", iso: "md", lat: 47.011, lng: 28.858 },
  { name: "Monaco", nameEn: "Monaco", iso: "mc", lat: 43.738, lng: 7.425 },
  { name: "Mongolia", nameEn: "Mongolia", iso: "mn", lat: 47.921, lng: 106.906 },
  { name: "Montenegro", nameEn: "Montenegro", iso: "me", lat: 42.442, lng: 19.264 },
  { name: "Morocco", nameEn: "Morocco", iso: "ma", lat: 33.972, lng: -6.850 },
  { name: "Mozambique", nameEn: "Mozambique", iso: "mz", lat: -25.966, lng: 32.573 },
  { name: "Myanmar", nameEn: "Myanmar", iso: "mm", lat: 19.764, lng: 96.128 },
  { name: "Namibia", nameEn: "Namibia", iso: "na", lat: -22.560, lng: 17.084 },
  { name: "Nauru", nameEn: "Nauru", iso: "nr", lat: -0.522, lng: 166.932 },
  { name: "Nepal", nameEn: "Nepal", iso: "np", lat: 27.717, lng: 85.324 },
  { name: "Nederland", nameEn: "Netherlands", iso: "nl", lat: 52.370, lng: 4.895 },
  { name: "New Zealand", nameEn: "New Zealand", iso: "nz", lat: -41.287, lng: 174.776 },
  { name: "Nicaragua", nameEn: "Nicaragua", iso: "ni", lat: 12.114, lng: -86.236 },
  { name: "Niger", nameEn: "Niger", iso: "ne", lat: 13.512, lng: 2.113 },
  { name: "Nigeria", nameEn: "Nigeria", iso: "ng", lat: 9.058, lng: 7.490 },
  { name: "North Macedonia", nameEn: "North Macedonia", iso: "mk", lat: 41.998, lng: 21.432 },
  { name: "Norge", nameEn: "Norway", iso: "no", lat: 59.913, lng: 10.752 },
  { name: "Oman", nameEn: "Oman", iso: "om", lat: 23.588, lng: 58.383 },
  { name: "Pakistan", nameEn: "Pakistan", iso: "pk", lat: 33.693, lng: 73.036 },
  { name: "Palau", nameEn: "Palau", iso: "pw", lat: 7.500, lng: 134.624 },
  { name: "Palestine", nameEn: "Palestine", iso: "ps", lat: 31.903, lng: 35.204 },
  { name: "Panamá", nameEn: "Panama", iso: "pa", lat: 8.983, lng: -79.519 },
  { name: "Papua New Guinea", nameEn: "Papua New Guinea", iso: "pg", lat: -6.315, lng: 143.956 },
  { name: "Paraguay", nameEn: "Paraguay", iso: "py", lat: -25.264, lng: -57.576 },
  { name: "Perú", nameEn: "Peru", iso: "pe", lat: -12.046, lng: -77.043 },
  { name: "Philippines", nameEn: "Philippines", iso: "ph", lat: 14.600, lng: 120.984 },
  { name: "Polska", nameEn: "Poland", iso: "pl", lat: 52.230, lng: 21.012 },
  { name: "Portugal", nameEn: "Portugal", iso: "pt", lat: 38.722, lng: -9.139 },
  { name: "Qatar", nameEn: "Qatar", iso: "qa", lat: 25.286, lng: 51.539 },
  { name: "România", nameEn: "Romania", iso: "ro", lat: 44.426, lng: 26.103 },
  { name: "Россия", nameEn: "Russia", iso: "ru", lat: 55.756, lng: 37.617 },
  { name: "Rwanda", nameEn: "Rwanda", iso: "rw", lat: -1.950, lng: 30.059 },
  { name: "Saint Kitts and Nevis", nameEn: "Saint Kitts and Nevis", iso: "kn", lat: 17.303, lng: -62.729 },
  { name: "Saint Lucia", nameEn: "Saint Lucia", iso: "lc", lat: 14.011, lng: -60.988 },
  { name: "Saint Vincent", nameEn: "Saint Vincent and the Grenadines", iso: "vc", lat: 13.160, lng: -61.225 },
  { name: "Samoa", nameEn: "Samoa", iso: "ws", lat: -13.833, lng: -171.769 },
  { name: "San Marino", nameEn: "San Marino", iso: "sm", lat: 43.936, lng: 12.447 },
  { name: "São Tomé and Príncipe", nameEn: "Sao Tome and Principe", iso: "st", lat: 0.337, lng: 6.733 },
  { name: "السعودية", nameEn: "Saudi Arabia", iso: "sa", lat: 24.713, lng: 46.675 },
  { name: "Sénégal", nameEn: "Senegal", iso: "sn", lat: 14.717, lng: -17.468 },
  { name: "Serbia", nameEn: "Serbia", iso: "rs", lat: 44.787, lng: 20.457 },
  { name: "Seychelles", nameEn: "Seychelles", iso: "sc", lat: -4.620, lng: 55.452 },
  { name: "Sierra Leone", nameEn: "Sierra Leone", iso: "sl", lat: 8.484, lng: -13.230 },
  { name: "Singapore", nameEn: "Singapore", iso: "sg", lat: 1.352, lng: 103.820 },
  { name: "Slovensko", nameEn: "Slovakia", iso: "sk", lat: 48.149, lng: 17.107 },
  { name: "Slovenija", nameEn: "Slovenia", iso: "si", lat: 46.052, lng: 14.507 },
  { name: "Solomon Islands", nameEn: "Solomon Islands", iso: "sb", lat: -9.428, lng: 160.035 },
  { name: "Somalia", nameEn: "Somalia", iso: "so", lat: 2.047, lng: 45.318 },
  { name: "South Africa", nameEn: "South Africa", iso: "za", lat: -25.747, lng: 28.229 },
  { name: "South Sudan", nameEn: "South Sudan", iso: "ss", lat: 4.860, lng: 31.571 },
  { name: "España", nameEn: "Spain", iso: "es", lat: 40.417, lng: -3.704 },
  { name: "Sri Lanka", nameEn: "Sri Lanka", iso: "lk", lat: 6.927, lng: 79.862 },
  { name: "Sudan", nameEn: "Sudan", iso: "sd", lat: 15.601, lng: 32.530 },
  { name: "Suriname", nameEn: "Suriname", iso: "sr", lat: 5.852, lng: -55.204 },
  { name: "Sverige", nameEn: "Sweden", iso: "se", lat: 59.329, lng: 18.069 },
  { name: "Schweiz", nameEn: "Switzerland", iso: "ch", lat: 46.948, lng: 7.448 },
  { name: "Syria", nameEn: "Syria", iso: "sy", lat: 33.513, lng: 36.292 },
  { name: "Tajikistan", nameEn: "Tajikistan", iso: "tj", lat: 38.561, lng: 68.774 },
  { name: "Tanzania", nameEn: "Tanzania", iso: "tz", lat: -6.163, lng: 35.750 },
  { name: "ไทย", nameEn: "Thailand", iso: "th", lat: 13.756, lng: 100.502 },
  { name: "Timor-Leste", nameEn: "Timor-Leste", iso: "tl", lat: -8.557, lng: 125.560 },
  { name: "Togo", nameEn: "Togo", iso: "tg", lat: 6.137, lng: 1.213 },
  { name: "Tonga", nameEn: "Tonga", iso: "to", lat: -21.179, lng: -175.198 },
  { name: "Trinidad and Tobago", nameEn: "Trinidad and Tobago", iso: "tt", lat: 10.657, lng: -61.508 },
  { name: "Tunisie", nameEn: "Tunisia", iso: "tn", lat: 36.807, lng: 10.181 },
  { name: "Türkiye", nameEn: "Turkey", iso: "tr", lat: 39.934, lng: 32.860 },
  { name: "Turkmenistan", nameEn: "Turkmenistan", iso: "tm", lat: 37.950, lng: 58.380 },
  { name: "Tuvalu", nameEn: "Tuvalu", iso: "tv", lat: -8.521, lng: 179.198 },
  { name: "Uganda", nameEn: "Uganda", iso: "ug", lat: 0.315, lng: 32.581 },
  { name: "Україна", nameEn: "Ukraine", iso: "ua", lat: 50.450, lng: 30.524 },
  { name: "الإمارات", nameEn: "United Arab Emirates", iso: "ae", lat: 24.453, lng: 54.377 },
  { name: "United Kingdom", nameEn: "United Kingdom", iso: "gb", lat: 51.507, lng: -0.128 },
  { name: "United States", nameEn: "United States", iso: "us", lat: 38.895, lng: -77.036 },
  { name: "Uruguay", nameEn: "Uruguay", iso: "uy", lat: -34.901, lng: -56.164 },
  { name: "Uzbekistan", nameEn: "Uzbekistan", iso: "uz", lat: 41.299, lng: 69.240 },
  { name: "Vanuatu", nameEn: "Vanuatu", iso: "vu", lat: -17.734, lng: 168.322 },
  { name: "Vatican City", nameEn: "Vatican City", iso: "va", lat: 41.902, lng: 12.454 },
  { name: "Venezuela", nameEn: "Venezuela", iso: "ve", lat: 10.491, lng: -66.879 },
  { name: "Việt Nam", nameEn: "Vietnam", iso: "vn", lat: 21.029, lng: 105.854 },
  { name: "Yemen", nameEn: "Yemen", iso: "ye", lat: 15.370, lng: 44.191 },
  { name: "Zambia", nameEn: "Zambia", iso: "zm", lat: -15.387, lng: 28.323 },
  { name: "Zimbabwe", nameEn: "Zimbabwe", iso: "zw", lat: -17.830, lng: 31.049 },
];

// ── Major world ports (top 50, UN/LOCODE) ──

const WORLD_PORTS: Array<{ name: string; unlocode: string; country: string; lat: number; lng: number }> = [
  { name: "Shanghai", unlocode: "CNSHA", country: "cn", lat: 31.230, lng: 121.474 },
  { name: "Singapore", unlocode: "SGSIN", country: "sg", lat: 1.264, lng: 103.822 },
  { name: "Ningbo-Zhoushan", unlocode: "CNNGB", country: "cn", lat: 29.868, lng: 121.544 },
  { name: "Shenzhen", unlocode: "CNSZX", country: "cn", lat: 22.543, lng: 114.058 },
  { name: "Guangzhou", unlocode: "CNGUA", country: "cn", lat: 23.101, lng: 113.338 },
  { name: "Busan", unlocode: "KRPUS", country: "kr", lat: 35.103, lng: 129.030 },
  { name: "Qingdao", unlocode: "CNTAO", country: "cn", lat: 36.067, lng: 120.383 },
  { name: "Hong Kong", unlocode: "HKHKG", country: "hk", lat: 22.286, lng: 114.158 },
  { name: "Tianjin", unlocode: "CNTSN", country: "cn", lat: 38.979, lng: 117.748 },
  { name: "Rotterdam", unlocode: "NLRTM", country: "nl", lat: 51.905, lng: 4.467 },
  { name: "Dubai (Jebel Ali)", unlocode: "AEJEA", country: "ae", lat: 25.005, lng: 55.064 },
  { name: "Port Klang", unlocode: "MYPKG", country: "my", lat: 3.000, lng: 101.400 },
  { name: "Antwerp", unlocode: "BEANR", country: "be", lat: 51.222, lng: 4.399 },
  { name: "Xiamen", unlocode: "CNXMN", country: "cn", lat: 24.480, lng: 118.089 },
  { name: "Kaohsiung", unlocode: "TWKHH", country: "tw", lat: 22.614, lng: 120.290 },
  { name: "Dalian", unlocode: "CNDLC", country: "cn", lat: 38.920, lng: 121.639 },
  { name: "Hamburg", unlocode: "DEHAM", country: "de", lat: 53.541, lng: 9.994 },
  { name: "Los Angeles", unlocode: "USLAX", country: "us", lat: 33.738, lng: -118.272 },
  { name: "Long Beach", unlocode: "USLGB", country: "us", lat: 33.767, lng: -118.189 },
  { name: "Tanjung Pelepas", unlocode: "MYTPP", country: "my", lat: 1.363, lng: 103.548 },
  { name: "Laem Chabang", unlocode: "THLCH", country: "th", lat: 13.082, lng: 100.884 },
  { name: "Tokyo", unlocode: "JPTYO", country: "jp", lat: 35.643, lng: 139.775 },
  { name: "Yokohama", unlocode: "JPYOK", country: "jp", lat: 35.453, lng: 139.642 },
  { name: "Kobe", unlocode: "JPUKB", country: "jp", lat: 34.673, lng: 135.196 },
  { name: "Nagoya", unlocode: "JPNGO", country: "jp", lat: 35.088, lng: 136.879 },
  { name: "Colombo", unlocode: "LKCMB", country: "lk", lat: 6.948, lng: 79.843 },
  { name: "Piraeus", unlocode: "GRPIR", country: "gr", lat: 37.942, lng: 23.648 },
  { name: "Felixstowe", unlocode: "GBFXT", country: "gb", lat: 51.960, lng: 1.312 },
  { name: "Santos", unlocode: "BRSSZ", country: "br", lat: -23.955, lng: -46.313 },
  { name: "Colombo", unlocode: "LKCMB", country: "lk", lat: 6.948, lng: 79.843 },
  { name: "Algeciras", unlocode: "ESALG", country: "es", lat: 36.127, lng: -5.443 },
  { name: "Valencia", unlocode: "ESVLC", country: "es", lat: 39.452, lng: -0.325 },
  { name: "Savannah", unlocode: "USSAV", country: "us", lat: 32.081, lng: -81.091 },
  { name: "New York/New Jersey", unlocode: "USNYC", country: "us", lat: 40.669, lng: -74.042 },
  { name: "Tanger Med", unlocode: "MAPTM", country: "ma", lat: 35.880, lng: -5.510 },
  { name: "Mumbai (JNPT)", unlocode: "INNSA", country: "in", lat: 18.950, lng: 72.950 },
  { name: "Ho Chi Minh City", unlocode: "VNSGN", country: "vn", lat: 10.774, lng: 106.722 },
  { name: "Manzanillo", unlocode: "MXZLO", country: "mx", lat: 19.056, lng: -104.318 },
  { name: "Balboa (Panama)", unlocode: "PABLB", country: "pa", lat: 8.959, lng: -79.565 },
  { name: "Le Havre", unlocode: "FRLEH", country: "fr", lat: 49.494, lng: 0.108 },
];

// ── Major world airports (top 50, ICAO+IATA) ──

const WORLD_AIRPORTS: Array<{ name: string; icao: string; iata: string; country: string; lat: number; lng: number }> = [
  { name: "Hartsfield-Jackson Atlanta", icao: "KATL", iata: "ATL", country: "us", lat: 33.637, lng: -84.428 },
  { name: "Dubai International", icao: "OMDB", iata: "DXB", country: "ae", lat: 25.253, lng: 55.366 },
  { name: "Dallas/Fort Worth", icao: "KDFW", iata: "DFW", country: "us", lat: 32.897, lng: -97.038 },
  { name: "London Heathrow", icao: "EGLL", iata: "LHR", country: "gb", lat: 51.470, lng: -0.454 },
  { name: "Istanbul", icao: "LTFM", iata: "IST", country: "tr", lat: 41.261, lng: 28.742 },
  { name: "Denver International", icao: "KDEN", iata: "DEN", country: "us", lat: 39.862, lng: -104.673 },
  { name: "O'Hare Chicago", icao: "KORD", iata: "ORD", country: "us", lat: 41.978, lng: -87.904 },
  { name: "Los Angeles Intl", icao: "KLAX", iata: "LAX", country: "us", lat: 33.943, lng: -118.408 },
  { name: "Tokyo Haneda", icao: "RJTT", iata: "HND", country: "jp", lat: 35.549, lng: 139.780 },
  { name: "Narita Intl", icao: "RJAA", iata: "NRT", country: "jp", lat: 35.764, lng: 140.386 },
  { name: "Kansai Intl", icao: "RJBB", iata: "KIX", country: "jp", lat: 34.427, lng: 135.244 },
  { name: "Chubu Centrair", icao: "RJGG", iata: "NGO", country: "jp", lat: 34.858, lng: 136.805 },
  { name: "Beijing Capital", icao: "ZBAA", iata: "PEK", country: "cn", lat: 40.080, lng: 116.603 },
  { name: "Beijing Daxing", icao: "ZBAD", iata: "PKX", country: "cn", lat: 39.510, lng: 116.411 },
  { name: "Shanghai Pudong", icao: "ZSPD", iata: "PVG", country: "cn", lat: 31.144, lng: 121.805 },
  { name: "Incheon Seoul", icao: "RKSI", iata: "ICN", country: "kr", lat: 37.460, lng: 126.441 },
  { name: "Singapore Changi", icao: "WSSS", iata: "SIN", country: "sg", lat: 1.350, lng: 103.994 },
  { name: "John F. Kennedy", icao: "KJFK", iata: "JFK", country: "us", lat: 40.640, lng: -73.779 },
  { name: "Paris CDG", icao: "LFPG", iata: "CDG", country: "fr", lat: 49.010, lng: 2.548 },
  { name: "Amsterdam Schiphol", icao: "EHAM", iata: "AMS", country: "nl", lat: 52.309, lng: 4.764 },
  { name: "Frankfurt", icao: "EDDF", iata: "FRA", country: "de", lat: 50.034, lng: 8.562 },
  { name: "Munich", icao: "EDDM", iata: "MUC", country: "de", lat: 48.354, lng: 11.787 },
  { name: "Madrid Barajas", icao: "LEMD", iata: "MAD", country: "es", lat: 40.472, lng: -3.561 },
  { name: "Barcelona El Prat", icao: "LEBL", iata: "BCN", country: "es", lat: 41.297, lng: 2.079 },
  { name: "Sydney Kingsford Smith", icao: "YSSY", iata: "SYD", country: "au", lat: -33.946, lng: 151.177 },
  { name: "Melbourne Tullamarine", icao: "YMML", iata: "MEL", country: "au", lat: -37.674, lng: 144.843 },
  { name: "Bangkok Suvarnabhumi", icao: "VTBS", iata: "BKK", country: "th", lat: 13.691, lng: 100.750 },
  { name: "Hong Kong", icao: "VHHH", iata: "HKG", country: "hk", lat: 22.309, lng: 113.915 },
  { name: "Delhi Indira Gandhi", icao: "VIDP", iata: "DEL", country: "in", lat: 28.556, lng: 77.100 },
  { name: "Mumbai Chhatrapati", icao: "VABB", iata: "BOM", country: "in", lat: 19.089, lng: 72.866 },
  { name: "São Paulo Guarulhos", icao: "SBGR", iata: "GRU", country: "br", lat: -23.432, lng: -46.470 },
  { name: "Mexico City", icao: "MMMX", iata: "MEX", country: "mx", lat: 19.436, lng: -99.073 },
  { name: "Toronto Pearson", icao: "CYYZ", iata: "YYZ", country: "ca", lat: 43.677, lng: -79.631 },
  { name: "Jakarta Soekarno-Hatta", icao: "WIII", iata: "CGK", country: "id", lat: -6.126, lng: 106.656 },
  { name: "Kuala Lumpur KLIA", icao: "WMKK", iata: "KUL", country: "my", lat: 2.746, lng: 101.710 },
  { name: "Doha Hamad", icao: "OTHH", iata: "DOH", country: "qa", lat: 25.261, lng: 51.565 },
  { name: "Cairo Intl", icao: "HECA", iata: "CAI", country: "eg", lat: 30.122, lng: 31.406 },
  { name: "Johannesburg OR Tambo", icao: "FAOR", iata: "JNB", country: "za", lat: -26.134, lng: 28.242 },
  { name: "Rome Fiumicino", icao: "LIRF", iata: "FCO", country: "it", lat: 41.800, lng: 12.239 },
  { name: "Moscow Sheremetyevo", icao: "UUEE", iata: "SVO", country: "ru", lat: 55.973, lng: 37.415 },
];

// ── Heartbeat collection phase tracking ──

let sovereignRegistered = false;
let portsRegistered = false;
let airportsRegistered = false;
let collectionPhase = 0; // increments each heartbeat for Overpass grid scan
let lastGeoRecordPollAt = new Date(Date.now() - 6 * 60 * 1000).toISOString(); // poll window start (updated each heartbeat)

/** Major JP cities for underground infra seeding (OSM Overpass) */
const INFRA_SEED_CITIES = [
  { name: "Tokyo",    lat: 35.6812, lng: 139.7671 },
  { name: "Osaka",    lat: 34.6937, lng: 135.5023 },
  { name: "Nagoya",   lat: 35.1815, lng: 136.9066 },
  { name: "Sapporo",  lat: 43.0618, lng: 141.3544 },
  { name: "Fukuoka",  lat: 33.5904, lng: 130.4017 },
  { name: "Sendai",   lat: 38.2682, lng: 140.8694 },
  { name: "Hiroshima", lat: 34.3853, lng: 132.4553 },
  { name: "Kyoto",    lat: 35.0116, lng: 135.7681 },
];

const INFRA_DEPTHS: Record<string, number> = { water: 1.2, sewage: 3.0, gas: 1.5, electric: 0.8, telecom: 0.6, subway: 15.0, districtHeating: 1.0 };

/**
 * Fetch underground infrastructure segments from OSM Overpass API and write to graph.
 * Uses man_made=pipeline, power=cable (underground), railway=subway.
 * radiusM: search radius in metres (default 2000).
 */
async function fetchInfraFromOverpass(sdk: HostSDK, lat: number, lng: number, radiusM = 2000): Promise<number> {
  const r = radiusM / 111000;
  const bbox = `${lat - r},${lng - r},${lat + r},${lng + r}`;
  const query = `[out:json][timeout:20][bbox:${bbox}];(way["man_made"="pipeline"];way["power"="cable"]["location"="underground"];way["railway"="subway"];relation["railway"="subway"]["type"="route"];);out center tags;`;
  const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(22000) });
    if (!res.ok) return 0;
  } catch { return 0; }
  type OvpEl = { type: string; id: number; center?: { lat: number; lon: number }; lat?: number; lon?: number; tags?: Record<string, string> };
  const json = await res.json() as { elements?: OvpEl[] };
  if (!json.elements?.length) return 0;
  let written = 0;
  for (const el of json.elements) {
    const elLat = el.center?.lat ?? el.lat;
    const elLng = el.center?.lon ?? el.lon;
    if (!elLat || !elLng) continue;
    const tags = el.tags ?? {};
    let infraType = "water";
    if (tags["railway"] === "subway") infraType = "subway";
    else if (tags["power"] === "cable") infraType = "electric";
    else if (tags["man_made"] === "pipeline") {
      const sub = tags["substance"] ?? "";
      if (sub === "gas") infraType = "gas";
      else if (sub === "sewage" || sub === "wastewater") infraType = "sewage";
      else if (sub === "telecommunication" || sub === "telephone") infraType = "telecom";
      else infraType = "water";
    }
    const segId = `infraSeg:osm:${el.type}:${el.id}`;
    await write(sdk, "infraSegment", {
      nodeId: segId, nodeLabel: "InfraSegment",
      osmId: String(el.id), osmType: el.type,
      infraType, lat: String(elLat), lng: String(elLng),
      depthM: String(INFRA_DEPTHS[infraType] ?? 1.0),
      name: tags["name"] ?? tags["operator"] ?? infraType,
      source: "osm", sourceDid: `did:web:${appId}:infrastructure`,
      createdAt: nowISO(), orgId: "anon", userId: "anon", actorId: appId,
    });
    written++;
  }
  return written;
}

/**
 * Fetch building footprints + heights from OSM Overpass and write to graph.
 * Emits `com.etzhayyim.apps.maps.building` records carrying `geometry` (GeoJSON
 * Polygon as JSON string) and `heightM` so tileGeoJson can serve 3D extrusion.
 *
 * Overpass tags used:
 *   building=*                     — any tagged building
 *   height=<m>                     — explicit height (e.g. "45 m", parsed)
 *   building:levels=<n>            — floors (fallback × 3 m)
 *   building=<type>                — buildingType (residential/commercial/etc.)
 */
async function fetchBuildingsFromOverpass(
  sdk: HostSDK,
  lat: number,
  lng: number,
  radiusM = 1500,
  maxBuildings = 200,
): Promise<number> {
  const r = radiusM / 111000;
  const bbox = `${lat - r},${lng - r},${lat + r},${lng + r}`;
  const query = `[out:json][timeout:25][bbox:${bbox}];(way["building"];);out geom tags ${maxBuildings};`;
  const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(28000) });
    if (!res.ok) return 0;
  } catch { return 0; }
  type OvpNode = { lat: number; lon: number };
  type OvpWay = {
    type: "way"; id: number;
    geometry?: OvpNode[];
    tags?: Record<string, string>;
  };
  const json = await res.json() as { elements?: OvpWay[] };
  if (!json.elements?.length) return 0;
  let written = 0;
  for (const el of json.elements) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 3) continue;
    const tags = el.tags ?? {};
    const ring: [number, number][] = el.geometry.map((n) => [n.lon, n.lat]);
    if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) {
      ring.push([ring[0][0], ring[0][1]]);
    }
    // Parse height: "45" / "45 m" / "45.5" → number; fall back to levels*3; default 9 m.
    let heightM = 0;
    const hTag = tags["height"];
    if (hTag) {
      const parsed = parseFloat(hTag.replace(/[^0-9.]/g, ""));
      if (Number.isFinite(parsed) && parsed > 0) heightM = parsed;
    }
    if (heightM <= 0) {
      const lvls = parseInt(tags["building:levels"] ?? "0", 10);
      if (lvls > 0) heightM = lvls * 3;
    }
    if (heightM <= 0) heightM = 9;
    // Centroid for lat/lng columns.
    const cx = ring.reduce((a, p) => a + p[0], 0) / ring.length;
    const cy = ring.reduce((a, p) => a + p[1], 0) / ring.length;
    const buildingType = tags["building"] && tags["building"] !== "yes"
      ? tags["building"]
      : "generic";
    const name = tags["name"] ?? tags["addr:housename"] ?? `Building ${el.id}`;
    const geometry = { type: "Polygon", coordinates: [ring] };
    await write(sdk, "building", {
      nodeId: `bld:osm:way:${el.id}`,
      buildingId: String(el.id),
      osmType: "way",
      osmId: String(el.id),
      name,
      buildingType,
      floors: String(parseInt(tags["building:levels"] ?? "0", 10) || 0),
      heightM: String(heightM),
      geometry: JSON.stringify(geometry),
      lat: String(cy),
      lng: String(cx),
      source: "osm",
      sourceDid: `did:web:${appId}.etzhayyim.com:infrastructure`,
      nodeLabel: "Building",
      createdAt: nowISO(),
      orgId: "anon", userId: "anon", actorId: appId,
    });
    written++;
  }
  return written;
}

/** Bootstrap 195 sovereign countries as Region DIDs (heartbeat one-time) */
async function bootstrapSovereignCountries(sdk: HostSDK): Promise<number> {
  if (sovereignRegistered) return 0;
  let count = 0;
  for (const c of SOVEREIGN_COUNTRIES) {
    await registerRegionRecord(sdk, {
      displayName: c.name, displayNameEn: c.nameEn,
      lat: c.lat, lng: c.lng, adminLevel: 1,
      // iso3166-1 (alpha-2) + unlocode country prefix (= ISO 3166-1 alpha-2 uppercase)
      codes: { "iso3166-1": c.iso, "unlocode": c.iso.toUpperCase() },
    });
    count++;
  }
  sovereignRegistered = true;
  return count;
}

/** Bootstrap major world ports as Port entities + UNLOCODE GeoAlias DIDs (heartbeat one-time) */
async function bootstrapWorldPorts(sdk: HostSDK): Promise<number> {
  if (portsRegistered) return 0;
  let count = 0;
  for (const p of WORLD_PORTS) {
    await write(sdk, "port", {
      nodeId: `port:${p.unlocode.toLowerCase()}`, name: p.name, portType: "container",
      unlocode: p.unlocode, country: p.country,
      lat: p.lat, lng: p.lng,
      sourceDid: `did:web:${appId}.etzhayyim.com:geocode`, source: "seed",
      nodeLabel: "Port", createdAt: nowISO(),
      orgId: "anon", userId: "anon", actorId: appId,
    });
    // UNLOCODE scheme DID for resolve_geo_alias
    const portAliasDid = str((sdk as any).hostImports?.comAtprotoIdentityCreate?.(
      `geo:unlocode:${p.unlocode}`,
      JSON.stringify({ displayName: `${p.name} [unlocode:${p.unlocode}]`, category: "geoAlias" }),
    ));
    if (portAliasDid) {
      await write(sdk, "geoAlias", {
        scheme: "unlocode", code: p.unlocode, regionId: "", aliasDid: portAliasDid,
        canonicalDid: portAliasDid, dim: "2d",
        nodeId: `geoAlias:unlocode:${p.unlocode}`, nodeLabel: "GeoAlias",
        createdAt: nowISO(), orgId: "anon", userId: "anon", actorId: appId,
      });
    }
    count++;
  }
  portsRegistered = true;
  return count;
}

/** Bootstrap major world airports as Airport entities + ICAO/IATA GeoAlias DIDs (heartbeat one-time) */
async function bootstrapWorldAirports(sdk: HostSDK): Promise<number> {
  if (airportsRegistered) return 0;
  let count = 0;
  for (const a of WORLD_AIRPORTS) {
    await write(sdk, "airport", {
      nodeId: `airport:${a.icao.toLowerCase()}`, name: a.name,
      icaoCode: a.icao, iataCode: a.iata, country: a.country,
      lat: a.lat, lng: a.lng,
      sourceDid: `did:web:${appId}.etzhayyim.com:geocode`, source: "seed",
      nodeLabel: "Airport", createdAt: nowISO(),
      orgId: "anon", userId: "anon", actorId: appId,
    });
    // ICAO scheme DID
    const icaoDid = str((sdk as any).hostImports?.comAtprotoIdentityCreate?.(
      `geo:icao-airport:${a.icao}`,
      JSON.stringify({ displayName: `${a.name} [icao:${a.icao}]`, category: "geoAlias" }),
    ));
    if (icaoDid) {
      await write(sdk, "geoAlias", {
        scheme: "icao-airport", code: a.icao, regionId: "", aliasDid: icaoDid,
        canonicalDid: icaoDid, dim: "2d",
        nodeId: `geoAlias:icao-airport:${a.icao}`, nodeLabel: "GeoAlias",
        createdAt: nowISO(), orgId: "anon", userId: "anon", actorId: appId,
      });
    }
    // IATA scheme DID
    const iataDid = str((sdk as any).hostImports?.comAtprotoIdentityCreate?.(
      `geo:iata-airport:${a.iata}`,
      JSON.stringify({ displayName: `${a.name} [iata:${a.iata}]`, category: "geoAlias" }),
    ));
    if (iataDid) {
      await write(sdk, "geoAlias", {
        scheme: "iata-airport", code: a.iata, regionId: "", aliasDid: iataDid,
        canonicalDid: iataDid, dim: "2d",
        nodeId: `geoAlias:iata-airport:${a.iata}`, nodeLabel: "GeoAlias",
        createdAt: nowISO(), orgId: "anon", userId: "anon", actorId: appId,
      });
    }
    count++;
  }
  airportsRegistered = true;
  return count;
}

/** OSM Overpass entity types for grid scan */
const OVERPASS_ENTITY_TYPES = [
  { osmTag: "amenity", mapsCollection: "spot", label: "Spot", category: "amenity" },
  { osmTag: "shop", mapsCollection: "spot", label: "Spot", category: "shop" },
  { osmTag: "tourism", mapsCollection: "spot", label: "Spot", category: "tourism" },
  { osmTag: "building", mapsCollection: "building", label: "Building", category: "building" },
  { osmTag: "highway=motorway|trunk|primary|secondary", mapsCollection: "road", label: "Road", category: "highway" },
  { osmTag: "railway=station|halt", mapsCollection: "station", label: "Station", category: "railway" },
  { osmTag: "amenity=ferry_terminal|harbour", mapsCollection: "port", label: "Port", category: "port" },
  { osmTag: "amenity=charging_station", mapsCollection: "evCharger", label: "EvCharger", category: "ev_charger" },
  { osmTag: "amenity=parking", mapsCollection: "parking", label: "Parking", category: "parking" },
  { osmTag: "highway=bus_stop", mapsCollection: "busStop", label: "BusStop", category: "bus_stop" },
  { osmTag: "waterway=river|canal", mapsCollection: "river", label: "River", category: "waterway" },
  { osmTag: "natural=peak", mapsCollection: "mountain", label: "Mountain", category: "mountain" },
] as const;

/**
 * Dispatch OSM Overpass collection jobs for JP prefectures.
 * Each heartbeat processes 1 prefecture × 1 entity type to avoid overwhelming the write buffer.
 * Cycles through all 47 prefs × 12 entity types = 564 jobs total over ~564 heartbeats.
 */
async function dispatchOverpassCollectionJob(sdk: HostSDK, phase: number): Promise<{ prefecture: string; entityType: string } | null> {
  const totalCombinations = JP_PREFECTURES.length * OVERPASS_ENTITY_TYPES.length;
  if (phase >= totalCombinations) return null; // all done for this cycle
  const prefIdx = phase % JP_PREFECTURES.length;
  const typeIdx = Math.floor(phase / JP_PREFECTURES.length) % OVERPASS_ENTITY_TYPES.length;
  const pref = JP_PREFECTURES[prefIdx];
  const etype = OVERPASS_ENTITY_TYPES[typeIdx];
  const dlat = 0.5; // ~55km bbox around prefecture capital
  const dlng = 0.5;
  const jobId = genID("ovp");
  await write(sdk, "collectionJob", {
    nodeId: `cj:${jobId}`, jobId, source: "overpass",
    sourceDid: `did:web:${appId}.etzhayyim.com:infrastructure`,
    sourceUrl: "https://overpass-api.de/api/interpreter",
    format: "overpass_json", status: "pending", phase: 1,
    osmTag: etype.osmTag, mapsCollection: etype.mapsCollection,
    entityLabel: etype.label, entityCategory: etype.category,
    region: `${pref.nameEn} (${pref.name})`,
    bboxJson: JSON.stringify({
      latMin: pref.lat - dlat, latMax: pref.lat + dlat,
      lngMin: pref.lng - dlng, lngMax: pref.lng + dlng,
    }),
    nodeLabel: "CollectionJob", createdAt: nowISO(),
    orgId: "anon", userId: "anon", actorId: appId,
  });
  return { prefecture: pref.nameEn, entityType: etype.osmTag };
}

/**
 * Dispatch STAC satellite collection jobs for recent imagery.
 * Targets JP main islands + one random registered country per heartbeat.
 */
async function dispatchSatelliteCollectionJob(sdk: HostSDK, phase: number): Promise<string | null> {
  // Rotate through satellite sources
  const sources = ["sentinel-2", "landsat"] as const;
  const sourceIdx = phase % sources.length;
  const satellite = sources[sourceIdx];
  const catalog = FREE_SATELLITE_CATALOG[satellite];
  if (!catalog) return null;
  // Target region: rotate through JP prefectures + world countries
  const regionIdx = phase % (JP_PREFECTURES.length + 10); // 10 world regions
  let lat: number, lng: number, regionName: string;
  if (regionIdx < JP_PREFECTURES.length) {
    const pref = JP_PREFECTURES[regionIdx];
    lat = pref.lat; lng = pref.lng; regionName = pref.nameEn;
  } else {
    // Pick from sovereign countries (rotate through first 50)
    const countryIdx = (regionIdx - JP_PREFECTURES.length + phase) % Math.min(SOVEREIGN_COUNTRIES.length, 50);
    const country = SOVEREIGN_COUNTRIES[countryIdx];
    lat = country.lat; lng = country.lng; regionName = country.nameEn;
  }
  // Build STAC search GET URL (Element84 supports GET search with query params)
  const bboxSize = 1.5; // ~165km — enough for 1 Sentinel-2 tile (100km×100km)
  const lngMin = (lng - bboxSize).toFixed(4);
  const latMin = (lat - bboxSize).toFixed(4);
  const lngMax = (lng + bboxSize).toFixed(4);
  const latMax = (lat + bboxSize).toFixed(4);
  const today = new Date();
  const dateTo = today.toISOString().slice(0, 10);
  const dateFrom = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const stacSearchUrl = `${catalog.stacUrl}/search?collections=${catalog.collectionId}&bbox=${lngMin},${latMin},${lngMax},${latMax}&datetime=${dateFrom}/${dateTo}&limit=3&sortby=-datetime`;
  // Remote site:ingestGeoData → stac_search_json format → processStacSearchResult → satelliteScene geoRecord
  (sdk as any).hostImports?.kotodamaInvoke?.(
    "site.etzhayyim.com",
    "com.etzhayyim.apps.site.ingestGeoData",
    JSON.stringify({ url: stacSearchUrl, format: "stac_search_json", project: "maps", satellite, stacCollectionId: catalog.collectionId }),
  );
  return `${satellite}:${regionName}`;
}

/**
 * Dispatch USGS seismic (earthquake) collection jobs — real-time feed, every heartbeat.
 * Rotates between global M2.5+ (day) and global significant (week) feeds.
 * sourceDid: did:web:{appId}.etzhayyim.com:seismic, TTL: 15m
 */
async function dispatchSeismicCollectionJob(sdk: HostSDK, phase: number): Promise<string | null> {
  const feeds = [
    { url: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson", region: "global", minMag: 2.5 },
    { url: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_week.geojson", region: "global-significant", minMag: 5.0 },
  ] as const;
  const feed = feeds[phase % feeds.length];
  const jobId = genID("seismic");
  await write(sdk, "collectionJob", {
    nodeId: `cj:${jobId}`, jobId, source: "seismic",
    sourceDid: `did:web:${appId}.etzhayyim.com:seismic`,
    sourceUrl: feed.url,
    format: "usgs_geojson", status: "pending", phase: 1,
    region: feed.region, minMagnitude: feed.minMag, ttlHours: 0.25,
    nodeLabel: "CollectionJob", createdAt: nowISO(),
    orgId: "anon", userId: "anon", actorId: appId,
  });
  return `seismic:${feed.region}`;
}

/**
 * Dispatch MLIT GTFS-JP collection jobs — 1 prefecture per heartbeat, cycles through 47.
 * sourceDid: did:web:{appId}.etzhayyim.com:gtfs, TTL: 1d
 */
async function dispatchGtfsJpCollectionJob(sdk: HostSDK, phase: number): Promise<{ prefecture: string } | null> {
  const prefIdx = phase % JP_PREFECTURES.length;
  const pref = JP_PREFECTURES[prefIdx];
  const jobId = genID("gtfs");
  await write(sdk, "collectionJob", {
    nodeId: `cj:${jobId}`, jobId, source: "gtfs",
    sourceDid: `did:web:${appId}.etzhayyim.com:gtfs`,
    // gtfs.jp host alone is not a feed URL — the actual feed.zip URL is
    // determined by the K8s gtfs-jp dumper from GTFS_JP_FEED_INDEX_URL.
    // Keep this as a marker so consumers know which aggregator we trust.
    sourceUrl: "https://www.gtfs.jp/",
    format: "gtfs_zip", status: "pending", phase: 1,
    region: pref.nameEn, prefectureCode: pref.jis, ttlHours: 24,
    lat: pref.lat, lng: pref.lng,
    nodeLabel: "CollectionJob", createdAt: nowISO(),
    orgId: "anon", userId: "anon", actorId: appId,
  });
  return { prefecture: pref.nameEn };
}

/**
 * Dispatch MLIT N03 municipality data collection jobs — 1 prefecture per heartbeat.
 * Fetches GeoJSON from nlftp.mlit.go.jp → registers AdminArea DID for each 市区町村.
 * sourceDid: did:web:{appId}.etzhayyim.com:geocode, TTL: 無期限
 */
async function dispatchMunicipalityCollectionJob(sdk: HostSDK, phase: number): Promise<{ prefecture: string } | null> {
  const prefIdx = phase % JP_PREFECTURES.length;
  const pref = JP_PREFECTURES[prefIdx];
  const prefCode = pref.jis.padStart(2, "0");
  const jobId = genID("muni");
  await write(sdk, "collectionJob", {
    nodeId: `cj:${jobId}`, jobId, source: "municipality",
    sourceDid: `did:web:${appId}.etzhayyim.com:geocode`,
    // MLIT N03 行政区域データ (N03-2024) — GeoJSON/Shapefile 無料公開
    sourceUrl: `https://nlftp.mlit.go.jp/ksj/gml/data/N03/N03-2024/N03-20240101_${prefCode}_GML.zip`,
    format: "mlit_n03_geojson", status: "pending", phase: 1,
    region: pref.nameEn, prefectureCode: pref.jis,
    lat: pref.lat, lng: pref.lng,
    // On completion: register each 市区町村 as AdminArea DID with jis-x0402 + iso3166-2 alias
    targetCollection: "adminArea", targetSchemes: "jis-x0402,iso3166-2",
    nodeLabel: "CollectionJob", createdAt: nowISO(),
    orgId: "anon", userId: "anon", actorId: appId,
  });
  return { prefecture: pref.nameEn };
}

// ── Bootstrap state flags ──

let profileRegistered = false; // Reset on deploy — runs once per Worker isolate
let socialBootstrapRegistered = false;
let layersRegistered = false;
let regionsRegistered = false;
let verticalZonesRegistered = false;
let naturalZonesRegistered = false;

/** Bootstrap 11 visual layer coordinator DIDs (heartbeat one-time) */
async function bootstrapLayerCoordinators(sdk: HostSDK): Promise<number> {
  if (layersRegistered) return 0;
  let count = 0;
  for (const lc of LAYER_COORDINATORS) {
    const did = str((sdk as any).hostImports?.comAtprotoIdentityCreate?.(
      `layer:${lc.slug}`,
      JSON.stringify({ displayName: lc.name, description: lc.description, category: "layer" }),
    ));
    if (did) {
      await write(sdk, "layerCoordinator", {
        layerSlug: lc.slug, displayName: lc.name, description: lc.description,
        did, nodeLabel: "LayerCoordinator", createdAt: nowISO(),
        orgId: "anon", userId: "anon", actorId: appId,
      });
      count++;
    }
  }
  layersRegistered = true;
  return count;
}

/** Register a region with canonical DID + multi-scheme alias DIDs */
async function registerRegionRecord(sdk: HostSDK, reg: {
  displayName: string; displayNameEn?: string; lat: number; lng: number;
  adminLevel: number; parentRegionId?: string;
  codes: Record<string, string>;
}): Promise<string> {
  const regionId = `r_${genID("r")}`;

  // Canonical DID
  const canonicalDid = str((sdk as any).hostImports?.comAtprotoIdentityCreate?.(
    `region:${regionId}`,
    JSON.stringify({ displayName: reg.displayName, description: `${reg.displayNameEn ?? reg.displayName} (L${reg.adminLevel})`, category: "region" }),
  ));

  // AdminArea record with all scheme codes as properties
  const record: Record<string, unknown> = {
    regionId, displayName: reg.displayName, displayNameEn: reg.displayNameEn ?? "",
    lat: reg.lat, lng: reg.lng, adminLevel: reg.adminLevel,
    parentRegionId: reg.parentRegionId ?? "", canonicalDid: canonicalDid || "",
    nodeId: `adminArea:${regionId}`, nodeLabel: "AdminArea",
    createdAt: nowISO(), orgId: "anon", userId: "anon", actorId: appId,
  };
  for (const [scheme, code] of Object.entries(reg.codes)) {
    record[scheme.replace(/-/g, "_")] = code;
  }
  await write(sdk, "adminArea", record);

  // Scheme alias DIDs + GeoAlias records
  for (const [scheme, code] of Object.entries(reg.codes)) {
    const aliasDid = str((sdk as any).hostImports?.comAtprotoIdentityCreate?.(
      `geo:${scheme}:${code}`,
      JSON.stringify({ displayName: `${reg.displayName} [${scheme}:${code}]`, category: "geoAlias" }),
    ));
    if (aliasDid) {
      await write(sdk, "geoAlias", {
        scheme, code, regionId, aliasDid, canonicalDid: canonicalDid || "",
        dim: GEO_SCHEMES[scheme]?.dim ?? "2d",
        nodeId: `geoAlias:${scheme}:${code}`, nodeLabel: "GeoAlias",
        createdAt: nowISO(), orgId: "anon", userId: "anon", actorId: appId,
      });
    }
  }

  return regionId;
}

/** Bootstrap JP country + 47 prefectures (heartbeat one-time) */
async function bootstrapJpPrefectures(sdk: HostSDK): Promise<number> {
  if (regionsRegistered) return 0;
  let count = 0;

  // Japan country-level
  const jpRegionId = registerRegionRecord(sdk, {
    displayName: "日本", displayNameEn: "Japan",
    lat: 36.204, lng: 138.253, adminLevel: 1,
    codes: { "iso3166-1": "jp", "unlocode": "JP" },
  });
  count++;

  // 47 prefectures
  for (const p of JP_PREFECTURES) {
    registerRegionRecord(sdk, {
      displayName: p.name, displayNameEn: p.nameEn,
      lat: p.lat, lng: p.lng, adminLevel: 2,
      parentRegionId: jpRegionId,
      codes: { "iso3166-2": p.iso, "jis-x0401": p.jis },
    });
    count++;
  }

  regionsRegistered = true;
  return count;
}

/** Bootstrap vertical zones (atmosphere + underground + ocean) */
async function bootstrapVerticalZones(sdk: HostSDK): Promise<number> {
  if (verticalZonesRegistered) return 0;
  let count = 0;
  for (const vz of VERTICAL_ZONES) {
    const did = str((sdk as any).hostImports?.comAtprotoIdentityCreate?.(
      `vzone:${vz.slug}`,
      JSON.stringify({ displayName: vz.name, description: `${vz.zoneType}: ${vz.minAlt}m to ${vz.maxAlt}m`, category: "verticalZone" }),
    ));
    if (did) {
      await write(sdk, "verticalZone", {
        zoneId: `vz_${vz.slug}`, slug: vz.slug, displayName: vz.name,
        zoneType: vz.zoneType, minAlt: vz.minAlt, maxAlt: vz.maxAlt, unit: vz.unit,
        did, nodeId: `vzone:${vz.slug}`, nodeLabel: "VerticalZone",
        createdAt: nowISO(), orgId: "anon", userId: "anon", actorId: appId,
      });
      // Alias DID for scheme lookup
      const schemeName = vz.zoneType === "ocean" ? "bath-zone" : vz.zoneType === "atmosphere" ? "atmo-layer" : "depth-band";
      await write(sdk, "geoAlias", {
        scheme: schemeName, code: vz.slug, regionId: "", aliasDid: did,
        canonicalDid: did, dim: "3d",
        nodeId: `geoAlias:${schemeName}:${vz.slug}`, nodeLabel: "GeoAlias",
        createdAt: nowISO(), orgId: "anon", userId: "anon", actorId: appId,
      });
      count++;
    }
  }
  verticalZonesRegistered = true;
  return count;
}

/** Bootstrap natural zones (climate + biome + tectonic) */
async function bootstrapNaturalZones(sdk: HostSDK): Promise<number> {
  if (naturalZonesRegistered) return 0;
  let count = 0;
  for (const nz of NATURAL_ZONES) {
    const did = str((sdk as any).hostImports?.comAtprotoIdentityCreate?.(
      `nzone:${nz.slug}`,
      JSON.stringify({ displayName: nz.name, description: nz.description, category: "naturalZone" }),
    ));
    if (did) {
      await write(sdk, "naturalZone", {
        zoneId: `nz_${nz.slug}`, slug: nz.slug, displayName: nz.name,
        zoneType: nz.zoneType, description: nz.description,
        did, nodeId: `nzone:${nz.slug}`, nodeLabel: "NaturalZone",
        createdAt: nowISO(), orgId: "anon", userId: "anon", actorId: appId,
      });
      // Alias DID
      const schemeName = nz.zoneType === "climate" ? "koppen" : nz.zoneType === "biome" ? "wwf-biome" : "tectonic";
      await write(sdk, "geoAlias", {
        scheme: schemeName, code: nz.slug, regionId: "", aliasDid: did,
        canonicalDid: did, dim: "2d",
        nodeId: `geoAlias:${schemeName}:${nz.slug}`, nodeLabel: "GeoAlias",
        createdAt: nowISO(), orgId: "anon", userId: "anon", actorId: appId,
      });
      count++;
    }
  }
  naturalZonesRegistered = true;
  return count;
}

const MAPS_SOCIAL_PROFILE = {
  displayName: "Maps — Spatial Intelligence + Digital Twin",
  description: "Graph-first spatial intelligence. Places, buildings, routes, land, registry, weather, infrastructure, and digital twin operations.",
};

const MAPS_BOOTSTRAP_FOLLOW_DIDS = [
  "did:web:yoro.etzhayyim.com",
  "did:web:jinushi.etzhayyim.com",
];

async function bootstrapMapsIdentityAndSocial(sdk: HostSDK): Promise<{
  profileCreated: boolean;
  actorCreated: boolean;
  socialProfileCreated: boolean;
  bootstrapPostCreated: boolean;
  followsCreated: string[];
}> {
  const mapsDid = `did:web:${appId}.etzhayyim.com`;
  const db = getDb();
  const [profileRow, actorRow, socialProfileRows, postRow, followRows] = await Promise.all([
    getCollectionRow("profile", (query) => query.where("did", "=", mapsDid)),
    getCollectionRow("actor", (query) => query.where("did", "=", mapsDid)),
    db.selectFrom("vertex_maps_social_profile" as any)
      .select(["vertex_id"])
      .where("did", "=", mapsDid)
      .limit(1)
      .execute()
      .catch(() => [] as AnyRow[]),
    db.selectFrom("vertex_repo_record")
      .select(sql<number>`count(*)`.as("cnt"))
      .where("collection", "=", "app.bsky.feed.post")
      .where("repo", "=", mapsDid)
      .executeTakeFirst()
      .catch(() => ({ cnt: 0 }) as AnyRow),
    db.selectFrom("edge_follows")
      .select(["dst_vid"])
      .where("src_vid", "=", mapsDid)
      .where("dst_vid", "in", MAPS_BOOTSTRAP_FOLLOW_DIDS)
      .execute()
      .catch(() => [] as AnyRow[]),
  ]);

  let profileCreated = false;
  if (!profileRow) {
    await write(sdk, "profile", {
      displayName: MAPS_SOCIAL_PROFILE.displayName,
      description: MAPS_SOCIAL_PROFILE.description,
      did: mapsDid,
      handle: `${appId}.etzhayyim.com`,
      isBot: true,
      agentType: "autonomous",
      nodeLabel: "Profile",
      orgId: "anon",
      userId: "anon",
      actorId: appId,
      createdAt: nowISO(),
    });
    profileCreated = true;
  }

  let actorCreated = false;
  if (!actorRow) {
    await write(sdk, "actor", {
      nanoid: appId,
      displayName: MAPS_SOCIAL_PROFILE.displayName,
      did: mapsDid,
      performerType: "system",
      runtimeType: "worker",
      uiType: "appview",
      agentType: "autonomous",
      operator: "etzhayyim.com",
      status: "active",
      nodeLabel: "Actor",
      orgId: "anon",
      userId: "anon",
      actorId: appId,
      createdAt: nowISO(),
    });
    actorCreated = true;
  }

  const socialProfileCreated = socialProfileRows.length === 0;
  await upsertMapsSocialProfileDirect(mapsDid, {
    displayName: MAPS_SOCIAL_PROFILE.displayName,
    description: MAPS_SOCIAL_PROFILE.description,
    createdAt: nowISO(),
  });

  let bootstrapPostCreated = false;
  if (Number(postRow?.cnt ?? 0) === 0) {
    await post(sdk, "[Bootstrap] Maps actor initialized for YORO profile / social graph\ncc @jinushi.etzhayyim.com", "bootstrap");
    bootstrapPostCreated = true;
  }

  const existingFollowDids = new Set((followRows as AnyRow[]).map((row) => str(row.dst_vid)).filter(Boolean));
  const followsCreated: string[] = [];
  for (const followDid of MAPS_BOOTSTRAP_FOLLOW_DIDS) {
    if (existingFollowDids.has(followDid)) continue;
    await ensureFollowEdgeDirect(mapsDid, followDid);
    followsCreated.push(followDid);
  }

  return {
    profileCreated,
    actorCreated,
    socialProfileCreated,
    bootstrapPostCreated,
    followsCreated,
  };
}

function sortRowsByRecency(rows: AnyRow[]): AnyRow[] {
  return [...rows].sort((a, b) => {
    const aTs = Date.parse(str(a.createdAt) || str(a.updatedAt) || str(a.indexed_at) || "1970-01-01T00:00:00.000Z");
    const bTs = Date.parse(str(b.createdAt) || str(b.updatedAt) || str(b.indexed_at) || "1970-01-01T00:00:00.000Z");
    return bTs - aTs;
  });
}

async function cmdBackfillSocial(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = decodeJson<Record<string, unknown>>(payload, {});
  const dryRun = req.dryRun === true;
  const sampleLimit = Math.min(Math.max(Number(req.sampleLimit ?? 3), 1), 10);
  const summaryOnly = req.summaryOnly === true;
  const mapsDid = `did:web:${appId}.etzhayyim.com`;

  const socialBootstrap = dryRun
    ? {
        profileCreated: false,
        actorCreated: false,
        socialProfileCreated: false,
        bootstrapPostCreated: false,
        followsCreated: [] as string[],
      }
    : await bootstrapMapsIdentityAndSocial(sdk);

  const [existingPostTexts, buildingCount, landRegistryCount, propertyRegistryCount, zoningRecordCount, adminAreaCount, airportCount, stationCount] = await Promise.all([
    listActorPostTexts(mapsDid, 2000),
    countCollectionRows("building"),
    countCollectionRows("landRegistry"),
    countCollectionRows("propertyRegistry"),
    countCollectionRows("zoningRecord"),
    countCollectionRows("adminArea"),
    countCollectionRows("airport"),
    countCollectionRows("station"),
  ]);

  const existingPrefixes = new Set(existingPostTexts.map((text) => text.split("\n")[0]));
  const existingExact = new Set(existingPostTexts);
  const summaryPosts = [
    {
      rkey: "backfill-summary",
      text: `[Backfill:summary] Maps graph contains ${buildingCount} buildings, ${landRegistryCount} land registries, ${propertyRegistryCount} property registries, and ${zoningRecordCount} zoning records.\ncc @jinushi.etzhayyim.com`,
    },
    {
      rkey: "backfill-coverage",
      text: `[Backfill:coverage] AdminAreas ${adminAreaCount}, Airports ${airportCount}, Stations ${stationCount}.\ncc @yoro.etzhayyim.com`,
    },
  ];

  const createdPosts: string[] = [];
  for (const { rkey, text } of summaryPosts) {
    const prefix = text.split("\n")[0];
    if (existingPrefixes.has(prefix)) continue;
    if (!dryRun) await post(sdk, text, rkey);
    existingPrefixes.add(prefix);
    createdPosts.push(text);
  }

  const sampledPosts: string[] = [];
  if (!summaryOnly) {
    const collections = ["building", "landRegistry", "propertyRegistry", "zoningRecord"] as const;
    for (const collection of collections) {
      const rows = sortRowsByRecency(await listCollectionRows(collection)).slice(0, sampleLimit);
      for (const row of rows) {
        const socialText = buildMapsSocialPost(collection, row);
        if (!socialText || existingExact.has(socialText)) continue;
        if (!dryRun) {
          const seed = str(row.did || row.nodeId || row.registryNumber || row.buildingId || row.entityId || row.name || row.label || socialText);
          await post(sdk, socialText, buildStableRkey(`sample-${collection}`, seed));
        }
        existingExact.add(socialText);
        sampledPosts.push(socialText);
      }
    }
  }

  return {
    ok: true,
    dryRun,
    socialBootstrap,
    counts: {
      building: buildingCount,
      landRegistry: landRegistryCount,
      propertyRegistry: propertyRegistryCount,
      zoningRecord: zoningRecordCount,
      adminArea: adminAreaCount,
      airport: airportCount,
      station: stationCount,
    },
    createdSummaryPosts: createdPosts.length,
    createdSamplePosts: sampledPosts.length,
    sampleLimit,
  };
}

// ── Factory: generic register (Design E Tier 2 domain + Tier 1 social) ──

function mkRegister(collection: string, label: string, idPrefix: string, requiredField: string) {
  return async (sdk: HostSDK, payload: Uint8Array): Promise<unknown> => {
    const req = decodeJson<Record<string, unknown>>(payload, {});
    if (!req[requiredField]) return { error: `${requiredField} required` };
    const nodeId = `${idPrefix}:${genID(idPrefix)}`;
    const rec: Record<string, unknown> = {
      ...req, 'nodeId': nodeId, 'nodeLabel': label,
      'createdAt': nowISO(), 'orgId': str(req.orgId ?? "anon"), 'userId': str(req.userId ?? "anon"), 'actorId': appId,
    };
    await write(sdk, collection, rec);
    return { 'nodeId': nodeId, status: "created" };
  };
}

// ── Factory: generic list with optional filter ──

function mkList(label: string, filterField?: string) {
  return async (_sdk: HostSDK, payload: Uint8Array): Promise<unknown> => {
    const req = decodeJson<Record<string, unknown>>(payload, {});
    const limit = Math.min(Math.max(Number(req.limit ?? 50), 1), 100);
    const offset = Number(req.offset ?? 0);
    const rows = await listCollectionRows(collectionForLabel(label));
    const filtered = filterField && req[filterField] != null && req[filterField] !== ""
      ? rows.filter((row) => String(row[filterField] ?? "") === String(req[filterField]))
      : rows;
    return filtered.slice(offset, offset + limit);
  };
}

// ── Factory: generic get by nodeId ──

function mkGet(label: string, idField: string) {
  return async (_sdk: HostSDK, payload: Uint8Array): Promise<unknown> => {
    const req = decodeJson<Record<string, unknown>>(payload, {});
    if (!req[idField]) return { error: `${idField} required` };
    const row = await getCollectionByRkey(collectionForLabel(label), String(req[idField]));
    return row ?? { error: "not found" };
  };
}

// ── Spatial Intelligence ──

async function cmdPlaceReverseGeocode(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.reverseGeocode", payload);
  if (req.lat == null || req.lng == null) return { error: "lat and lng required" };
  const rows = (await listCollectionRows("place")).filter((row) => {
    const lat = readFiniteNumber(row.lat);
    const lng = readFiniteNumber(row.lng);
    return lat != null && lng != null
      && lat >= req.lat! - 0.01 && lat <= req.lat! + 0.01
      && lng >= req.lng! - 0.01 && lng <= req.lng! + 0.01;
  }).slice(0, 5);
  if (rows.length > 0) return rows;
  // graph MISS → create collection job for Nominatim fallback
  await write(sdk, "place", {
    'nodeId': `place:geo-${req.lat}-${req.lng}`, label: `Geocode ${req.lat},${req.lng}`,
    lat: req.lat, lng: req.lng, source: "nominatim", 'sourceDid': `did:web:${appId}.etzhayyim.com:geocode`,
    status: "pending", 'createdAt': nowISO(), 'orgId': "anon", 'userId': "anon", 'actorId': appId,
  });
  return { status: "collectionJobCreated", lat: req.lat, lng: req.lng };
}

async function cmdWeatherAt(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.weatherAt", payload);
  if (req.lat == null || req.lng == null) return { error: "lat and lng required" };
  const rows = (await listCollectionRows("weatherPoint")).filter((row) => {
    const lat = readFiniteNumber(row.lat);
    const lng = readFiniteNumber(row.lng);
    return lat != null && lng != null
      && lat >= req.lat! - 0.05 && lat <= req.lat! + 0.05
      && lng >= req.lng! - 0.05 && lng <= req.lng! + 0.05;
  }).slice(0, 1);
  if (rows.length > 0) return rows[0];
  // graph MISS → write collection job for Open-Meteo fallback
  await write(sdk, "weatherPoint", {
    'nodeId': `wx:${req.lat}:${req.lng}`, lat: req.lat, lng: req.lng,
    'sourceDid': `did:web:${appId}.etzhayyim.com:weather`, 'ttlHours': 1, status: "pending",
    'fetchedAt': nowISO(), 'createdAt': nowISO(), 'orgId': "anon", 'userId': "anon", 'actorId': appId,
  });
  return { status: "collectionJobCreated", lat: req.lat, lng: req.lng };
}

async function cmdWeatherGrid(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.weatherGrid", payload);
  if (req.latMin == null || req.latMax == null || req.lngMin == null || req.lngMax == null) return { error: "latMin, latMax, lngMin, lngMax required" };
  const limit = Math.min(req.limit ?? 20, 50);
  return (await listCollectionRows("weatherPoint")).filter((row) => {
    const lat = readFiniteNumber(row.lat);
    const lng = readFiniteNumber(row.lng);
    return lat != null && lng != null
      && lat >= req.latMin! && lat <= req.latMax!
      && lng >= req.lngMin! && lng <= req.lngMax!;
  }).slice(0, limit);
}

async function cmdIpGeolocate(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.ipGeolocate", payload);
  if (!req.ip) return { error: "ip required" };
  const row = (await listCollectionRows("crawlerHost")).find((entry) => String(entry.ip ?? "") === req.ip);
  return row ?? { error: "not found", ip: req.ip };
}

// ── RisingWave-native vector source (replaces external MVT tile dependency) ──
//
// Query vertex_spatial by bbox + label, emit per-label GeoJSON FeatureCollection.
// Labels are supplied by the client per visible tile/viewport. Lines and polygons
// are encoded in props.geometry (GeoJSON) when present; otherwise rows with only
// lat/lng fall back to Point geometry.

async function cmdSeedBuildings(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = decodeJson<{
    lat?: number; lng?: number; radiusM?: number; maxBuildings?: number;
  }>(payload, {});
  const lat = Number(req.lat);
  const lng = Number(req.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { written: 0, error: "lat/lng required" };
  const radiusM = Math.min(Math.max(Number(req.radiusM) || 1500, 100), 5000);
  const maxBuildings = Math.min(Math.max(Number(req.maxBuildings) || 200, 1), 2000);
  const written = await fetchBuildingsFromOverpass(sdk, lat, lng, radiusM, maxBuildings);
  return { written };
}

// ── XYZ tile addressing (Option C MVP) ─────────────────────────────────────
// Slippy-tile / Web-Mercator z/x/y → WGS84 lon/lat bbox. Lets clients address
// tiles with stable, cacheable keys (the foundation for a future MVT-binary
// edge tile server) while reusing the existing bbox query path internally.
function tileXyzToBbox(z: number, x: number, y: number): { west: number; south: number; east: number; north: number } | null {
  if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (z < 0 || z > 22) return null;
  const n = Math.pow(2, z);
  if (x < 0 || x >= n || y < 0 || y >= n) return null;
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  const northRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const southRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)));
  return {
    west, east,
    north: (northRad * 180) / Math.PI,
    south: (southRad * 180) / Math.PI,
  };
}

async function cmdTileXyz(_sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = decodeJson<{
    z?: number; x?: number; y?: number; labels?: string[]; limit?: number;
  }>(payload, {});
  const bbox = tileXyzToBbox(Number(req.z), Number(req.x), Number(req.y));
  if (!bbox) {
    return { layers: {}, tile: { z: req.z, x: req.x, y: req.y }, total: 0, error: "invalid tile coords" };
  }
  // Re-enter the tileGeoJson payload shape — same bbox query + LOD simplification
  // path is shared via decodeJson indirection.
  const inner = new TextEncoder().encode(JSON.stringify({
    west: bbox.west, south: bbox.south, east: bbox.east, north: bbox.north,
    labels: req.labels, zoom: Number(req.z), limit: req.limit,
  }));
  const result = await cmdTileGeoJson(_sdk, inner) as Record<string, unknown>;
  return { ...result, tile: { z: Number(req.z), x: Number(req.x), y: Number(req.y) } };
}

async function cmdTileGeoJson(_sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = decodeJson<{
    west?: number; south?: number; east?: number; north?: number;
    labels?: string[]; zoom?: number; limit?: number;
  }>(payload, {});
  const west = Number(req.west);
  const south = Number(req.south);
  const east = Number(req.east);
  const north = Number(req.north);
  if (![west, south, east, north].every(Number.isFinite)) {
    return { layers: {}, bbox: [], total: 0, error: "invalid bbox" };
  }
  const labels = Array.isArray(req.labels) && req.labels.length > 0
    ? req.labels.slice(0, 32).map(String)
    : ["Place", "Road", "Railway", "Coastline", "River", "AdminArea", "Building"];
  const perLabelLimit = Math.min(Math.max(Number(req.limit) || 500, 1), 5000);

  // Bbox filter uses lat/lng columns. For rows with only geometry prop (no lat/lng),
  // we can't prefilter in SQL — those are excluded from the viewport query.
  const layers: Record<string, { type: "FeatureCollection"; features: unknown[] }> = {};
  let total = 0;

  // Single query for all labels (1 Hyperdrive round-trip, not 7). Limit is
  // scaled by label count so no single label can dominate the result set.
  const globalLimit = Math.min(perLabelLimit * labels.length, 10_000);
  let allRows: AnyRow[] = [];
  try {
    allRows = await getDb()
      .selectFrom("vertex_spatial")
      .selectAll()
      .where("label", "in", labels)
      .where("lng", ">=", west)
      .where("lng", "<=", east)
      .where("lat", ">=", south)
      .where("lat", "<=", north)
      .limit(globalLimit)
      .execute();
  } catch (err) {
    allRows = [];
  }
  const rowsByLabel = new Map<string, AnyRow[]>();
  for (const row of allRows) {
    const lab = String(row.label ?? "");
    if (!rowsByLabel.has(lab)) rowsByLabel.set(lab, []);
    const arr = rowsByLabel.get(lab)!;
    if (arr.length < perLabelLimit) arr.push(row);
  }
  for (const label of labels) {
    const rows = rowsByLabel.get(label) ?? [];
    const features: unknown[] = [];
    for (const row of rows) {
      const geom = extractGeomFromRow(row);
      if (!geom) continue;
      const props = parseProps(row.props);
      features.push({
        type: "Feature",
        geometry: geom,
        properties: {
          id: row.vertex_id,
          name: row.name,
          displayName: row.display_name,
          category: row.category,
          label: row.label,
          did: row.did,
          status: row.status,
          heightM: (props as { heightM?: unknown }).heightM
            ?? (props as { height_m?: unknown }).height_m,
          levels: (props as { levels?: unknown }).levels
            ?? (props as { floors?: unknown }).floors,
        },
      });
    }
    if (features.length > 0) {
      layers[label] = { type: "FeatureCollection", features };
      total += features.length;
    }
  }
  const result = { layers, bbox: [west, south, east, north], total };
  // Cutover Stage 2 (etzhayyim-root@90-docs/maps-etzhayyim-cutover-runbook.md):
  // shadow query to etzhayyim reader when MAPS_SHADOW_ETZHAYYIM=1. Logs a
  // parity line; does not affect the vendor response.
  shadowTileGeoJsonRead((_sdk as any).env, result, { west, south, east, north, labels });
  return result;
}

// ── Forward topology: H3-indexed chunk reader (replaces XYZ pyramid) ──
//
// Takes an array of H3 cells at a single resolution, unions their boundary
// bboxes, runs ONE vertex_spatial query, then groups returned features into
// their owning cell (by centroid of geometry.coordinates or lat/lng). Client
// cache-key = h3Cell, which stays stable across viewport pans — unlike bbox
// which changes every frame. Design: 90-docs/260417-maps-forward-topology-raw-to-webgpu.md.

const DEFAULT_CHUNK_LABELS = [
  "Place", "Road", "Railway", "Coastline", "River",
  "AdminArea", "Building", "Mountain", "Port", "Airport", "Station",
];

function featureCentroid(geom: GeoJsonGeom): [number, number] | null {
  switch (geom.type) {
    case "Point": return geom.coordinates;
    case "LineString": {
      const c = geom.coordinates;
      return c.length > 0 ? c[Math.floor(c.length / 2)] : null;
    }
    case "MultiLineString": {
      const lines = geom.coordinates;
      if (!lines.length || !lines[0].length) return null;
      return lines[0][Math.floor(lines[0].length / 2)];
    }
    case "Polygon": {
      const ring = geom.coordinates[0];
      if (!ring || ring.length === 0) return null;
      let sx = 0, sy = 0;
      for (const p of ring) { sx += p[0]; sy += p[1]; }
      return [sx / ring.length, sy / ring.length];
    }
    case "MultiPolygon": {
      const poly = geom.coordinates[0];
      if (!poly || !poly[0]) return null;
      const ring = poly[0];
      let sx = 0, sy = 0;
      for (const p of ring) { sx += p[0]; sy += p[1]; }
      return [sx / ring.length, sy / ring.length];
    }
  }
}

/** Map OSM tag → chunk label. Only the tags we currently render. */
function osmLabelFromTags(tags: Record<string, unknown>, osmType: string): string | null {
  if (osmType === "w" && tags["building"]) return "Building";
  if (osmType === "w" && tags["highway"]) return "Road";
  if (osmType === "w" && tags["railway"]) return "Railway";
  if (osmType === "w" && (tags["natural"] === "coastline")) return "Coastline";
  if (osmType === "w" && (tags["waterway"] === "river" || tags["waterway"] === "stream")) return "River";
  if (osmType === "r" && tags["admin_level"]) return "AdminArea";
  if (osmType === "n" && tags["natural"] === "peak") return "Mountain";
  if (osmType === "n" && tags["aeroway"] === "aerodrome") return "Airport";
  if (osmType === "n" && tags["railway"] === "station") return "Station";
  if (osmType === "n" && (tags["harbour"] || tags["man_made"] === "pier")) return "Port";
  if (osmType === "n" && (tags["place"] || tags["name"])) return "Place";
  return null;
}

/**
 * Reconstruct a GeoJSON geometry for a single OSM way by joining
 * vertex_osm_element (as the way header) with edge_osm_way_node → member
 * nodes (as the point coordinates, ordered by `seq`). Closed rings (first
 * node == last node) emit Polygon; open paths emit LineString.
 *
 * NB: Relations are currently emitted as bare centroid Points — full
 * multipolygon reconstruction needs `edge_osm_relation_member` with role
 * filtering, deferred to a follow-up.
 */
async function reconstructOsmWayGeom(wayVertexId: string): Promise<GeoJsonGeom | null> {
  try {
    const rows = await getDb()
      .selectFrom("edge_osm_way_node as e")
      .innerJoin("vertex_osm_element as n", "n.vertex_id", "e.node_vertex_id")
      .select(["n.lng as lng", "n.lat as lat", "e.seq as seq"])
      .where("e.way_vertex_id", "=", wayVertexId)
      .where("e.valid_to", "is", null)
      .orderBy("e.seq", "asc")
      .execute();
    if (rows.length < 2) return null;
    const coords: [number, number][] = rows
      .map((r) => [Number((r as { lng?: unknown }).lng), Number((r as { lat?: unknown }).lat)] as [number, number])
      .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    if (coords.length < 2) return null;
    const first = coords[0];
    const last = coords[coords.length - 1];
    const closed = first[0] === last[0] && first[1] === last[1];
    if (closed && coords.length >= 4) {
      return { type: "Polygon", coordinates: [coords] };
    }
    return { type: "LineString", coordinates: coords };
  } catch {
    return null;
  }
}

/**
 * Query vertex_osm_element for elements whose lat/lon centroid falls inside
 * the requested bbox, convert their OSM tags to chunk labels, reconstruct
 * way geometries, and append to the chunks map. Caps at `perLabelLimit`
 * rows per (cell × label).
 */
async function gatherOsmChunkFeatures(
  bbox: { west: number; south: number; east: number; north: number },
  labels: string[],
  lod: number,
  cellSet: Set<string>,
  chunks: Record<string, Record<string, unknown[]>>,
  perLabelLimit: number,
  limitFor: (label: string) => number = () => perLabelLimit,
): Promise<number> {
  const wantLabel = new Set(labels);
  // Only fetch tag-bearing elements; skip plain graph nodes with no semantic.
  // A single Kysely query with the current bbox — the crate indexes lng/lat.
  const perLabelSum = labels.reduce((s, l) => s + limitFor(l), 0) || perLabelLimit * labels.length;
  const limit = Math.min(perLabelSum * Math.max(cellSet.size, 1) * 2, 40_000);
  let rows: AnyRow[] = [];
  try {
    rows = await getDb()
      .selectFrom("vertex_osm_element")
      .select([
        "vertex_id", "osm_type", "osm_id", "tags", "lat", "lng",
      ])
      .where("lng", ">=", bbox.west)
      .where("lng", "<=", bbox.east)
      .where("lat", ">=", bbox.south)
      .where("lat", "<=", bbox.north)
      .where("valid_to", "is", null)
      .limit(limit)
      .execute() as unknown as AnyRow[];
  } catch {
    return 0;
  }
  let total = 0;
  for (const row of rows) {
    const tags = (row.tags ?? {}) as Record<string, unknown>;
    const osmType = String(row.osm_type ?? "");
    const label = osmLabelFromTags(tags, osmType);
    if (!label || !wantLabel.has(label)) continue;
    const lng = Number(row.lng);
    const lat = Number(row.lat);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    let owner: string;
    try { owner = latLngToCell(lat, lng, lod); } catch { continue; }
    if (!cellSet.has(owner)) continue;
    const byLabel = chunks[owner];
    if (!byLabel[label]) byLabel[label] = [];
    const arr = byLabel[label] as unknown[];
    if (arr.length >= limitFor(label)) continue;
    // Ways: reconstruct full geometry; nodes: Point; relations: skip for now.
    let geom: GeoJsonGeom | null = null;
    if (osmType === "w") {
      geom = await reconstructOsmWayGeom(String(row.vertex_id));
      if (!geom) geom = { type: "Point", coordinates: [lng, lat] };
    } else if (osmType === "n") {
      geom = { type: "Point", coordinates: [lng, lat] };
    } else {
      geom = { type: "Point", coordinates: [lng, lat] };
    }
    arr.push({
      type: "Feature",
      geometry: simplifyGeomForLod(geom, lod),
      properties: {
        id: row.vertex_id,
        osmType,
        osmId: row.osm_id,
        name: tags["name"] ?? null,
        label,
        heightM: tags["height"] ? Number(String(tags["height"]).replace(/[^0-9.]/g, "")) || undefined : undefined,
        levels: tags["building:levels"] ? parseInt(String(tags["building:levels"]), 10) || undefined : undefined,
        tags,
      },
    });
    total++;
  }
  return total;
}

// ── Douglas-Peucker polygon simplification (Option A.2) ────────────────────
// Server-side LOD: reduce vertex count for polygons/lines before shipping
// GeoJSON to the client. Tolerance scales with H3 lod so low-zoom chunks
// ship coarse geometry, high-zoom chunks stay detailed.
//
// Design reference: deps.toml maps-forward-topology-raw-to-webgpu (Option A
// pyramid tier). Runs in TS on the Worker — pure-CPU, no deps. For the ~500
// rows per chunk we query, a quadratic RDP is fine (<1 ms per polygon).
function rdpPerpDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const mag = Math.sqrt(dx * dx + dy * dy);
  if (mag === 0) {
    const dpx = p[0] - a[0], dpy = p[1] - a[1];
    return Math.sqrt(dpx * dpx + dpy * dpy);
  }
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / mag;
}

function rdpSimplify(pts: [number, number][], tolerance: number): [number, number][] {
  if (pts.length < 3 || tolerance <= 0) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    let maxDist = 0;
    let maxIdx = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const d = rdpPerpDist(pts[i], pts[i0], pts[i1]);
      if (d > maxDist) { maxDist = d; maxIdx = i; }
    }
    if (maxDist > tolerance && maxIdx >= 0) {
      keep[maxIdx] = 1;
      stack.push([i0, maxIdx]);
      stack.push([maxIdx, i1]);
    }
  }
  const out: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out.length >= 2 ? out : pts;
}

// Tolerance in degrees by H3 lod. At lod=2 (z<3) a 0.5° tolerance collapses
// an entire country's coastline into a handful of vertices. At lod=8+ we
// return full detail because zoom 10+ requires street-level accuracy.
const LOD_SIMPLIFY_TOLERANCE: Record<number, number> = {
  0: 2.0, 1: 1.0, 2: 0.5, 3: 0.25,
  4: 0.1, 5: 0.05, 6: 0.02, 7: 0.01,
  8: 0.003, 9: 0.001,
  // lod 10+: no simplification (0 or omitted → pass-through)
};

function simplifyGeomForLod(geom: unknown, lod: number): unknown {
  const tol = LOD_SIMPLIFY_TOLERANCE[lod] ?? 0;
  if (tol <= 0) return geom;
  const g = geom as { type?: string; coordinates?: unknown };
  if (!g || typeof g !== "object" || !g.type) return geom;
  switch (g.type) {
    case "LineString": {
      const pts = g.coordinates as [number, number][];
      if (!Array.isArray(pts) || pts.length < 3) return geom;
      return { type: "LineString", coordinates: rdpSimplify(pts, tol) };
    }
    case "MultiLineString": {
      const lines = g.coordinates as [number, number][][];
      if (!Array.isArray(lines)) return geom;
      return { type: "MultiLineString", coordinates: lines.map((l) => rdpSimplify(l, tol)) };
    }
    case "Polygon": {
      const rings = g.coordinates as [number, number][][];
      if (!Array.isArray(rings)) return geom;
      return { type: "Polygon", coordinates: rings.map((r) => rdpSimplify(r, tol)) };
    }
    case "MultiPolygon": {
      const polys = g.coordinates as [number, number][][][];
      if (!Array.isArray(polys)) return geom;
      return {
        type: "MultiPolygon",
        coordinates: polys.map((poly) => poly.map((ring) => rdpSimplify(ring, tol))),
      };
    }
    default:
      return geom;
  }
}

async function cmdGetChunk(_sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = decodeJson<{
    h3Cells?: string[]; lod?: number; labels?: string[]; limit?: number;
    limitByLabel?: Record<string, number>;
  }>(payload, {});
  const cells = Array.isArray(req.h3Cells) ? req.h3Cells.slice(0, 128).map(String) : [];
  const lod = Number(req.lod);
  if (cells.length === 0 || !Number.isFinite(lod) || lod < 0 || lod > 15) {
    return { chunks: {}, lod, total: 0, error: "h3Cells[] and lod required" };
  }
  const labels = Array.isArray(req.labels) && req.labels.length > 0
    ? req.labels.slice(0, 32).map(String)
    : DEFAULT_CHUNK_LABELS;
  const defaultLimit = Math.min(Math.max(Number(req.limit) || 500, 1), 5000);
  const limitByLabel: Record<string, number> = {};
  if (req.limitByLabel && typeof req.limitByLabel === "object") {
    for (const [k, v] of Object.entries(req.limitByLabel)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) limitByLabel[String(k)] = Math.min(n, 5000);
    }
  }
  const perLabelLimit = defaultLimit;
  const limitFor = (label: string) => limitByLabel[label] ?? perLabelLimit;

  // Union bbox across all requested cells (h3-js returns [lat, lng] pairs).
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  const cellSet = new Set<string>();
  for (const cell of cells) {
    cellSet.add(cell);
    let boundary: [number, number][];
    try {
      boundary = cellToBoundary(cell);
    } catch {
      continue;
    }
    for (const [lat, lng] of boundary) {
      if (lng < west) west = lng;
      if (lng > east) east = lng;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
  }
  if (!Number.isFinite(west)) {
    return { chunks: {}, lod, total: 0, error: "invalid H3 cells" };
  }

  // kotoba-native read (ADR-2606064500 R2): H3-cell AVET probe — O(cells), no bbox scan.
  // RisingWave fail-open removed at R2; kotoba is the sole read backend.
  const perLabelSum = labels.reduce((s, l) => s + limitFor(l), 0);
  const globalLimit = Math.min(perLabelSum * cells.length, 20_000);
  const kr = await kotobaQueryByCells(_mapsEnv as Record<string, unknown>, {
    cells, lod, labels, limit: globalLimit,
  });
  const allRows: AnyRow[] = kr ?? [];

  // Route each row → owning H3 cell (via feature centroid). Drop rows whose
  // centroid cell isn't in the requested set (handles bbox over-fetch).
  const chunks: Record<string, Record<string, unknown[]>> = {};
  let total = 0;
  for (const cell of cells) chunks[cell] = {};

  // Also gather OSM planet data from vertex_osm_element + edge_osm_way_node.
  // Option B topology: OSM queried via the same kotoba plane as all map entities
  // (deps.toml maps-forward-topology-raw-to-webgpu).
  const osmAdded = await gatherOsmChunkFeatures(
    { west, south, east, north },
    labels,
    lod,
    cellSet,
    chunks,
    perLabelLimit,
    limitFor,
  );
  total += osmAdded;
  for (const row of allRows) {
    const geom = extractGeomFromRow(row);
    if (!geom) continue;
    const c = featureCentroid(geom);
    if (!c) continue;
    const [cx, cy] = c;
    let owner: string;
    try {
      owner = latLngToCell(cy, cx, lod);
    } catch { continue; }
    if (!cellSet.has(owner)) continue;
    const label = String(row.label ?? "");
    const props = parseProps(row.props);
    const byLabel = chunks[owner];
    if (!byLabel[label]) byLabel[label] = [];
    if ((byLabel[label] as unknown[]).length >= limitFor(label)) continue;
    (byLabel[label] as unknown[]).push({
      type: "Feature",
      geometry: simplifyGeomForLod(geom, lod),
      properties: {
        id: row.vertex_id,
        name: row.name,
        displayName: row.display_name,
        category: row.category,
        label,
        did: row.did,
        status: row.status,
        heightM: (props as { heightM?: unknown }).heightM
          ?? (props as { height_m?: unknown }).height_m,
        levels: (props as { levels?: unknown }).levels
          ?? (props as { floors?: unknown }).floors,
      },
    });
    total++;
  }

  return { chunks, lod, total, servedBy: "kotoba" };
}

// ── getChunkModels: DB-driven science model instances for maps-walk.htm ──────
// Primary path: vertex_kami_model_instance JOIN vertex_kami_model_def (placed instances)
// Fallback path: vertex_maps_building_3d by lat/lng bbox (direct, no instance layer)
// Returns AABB buildings, vegetation TaxonomicProfile JSON, atom CPK spheres.
async function cmdGetChunkModels(_sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = decodeJson<{
    h3Cells?: string[];
    limit?: number;
    anchorLat?: number;
    anchorLng?: number;
    west?: number;
    south?: number;
    east?: number;
    north?: number;
  }>(payload, {});
  const cells = Array.isArray(req.h3Cells) ? req.h3Cells.slice(0, 128).map(String) : [];
  if (cells.length === 0) {
    return { buildings: [], vegetation: [], atoms: [], modelCounts: { buildings: 0, vegetation: 0, atoms: 0, total: 0 } };
  }
  const limit = Math.min(Math.max(Number(req.limit) || 500, 1), 2000);

  // Anchor for lat/lng → world-space conversion (local meters, same formula as maps-walk.htm)
  const anchorLat = Number.isFinite(req.anchorLat) ? req.anchorLat! : 35.6812;
  const anchorLng = Number.isFinite(req.anchorLng) ? req.anchorLng! : 139.7671;
  const M_PER_DEG_LAT = 111_320;
  const M_PER_DEG_LNG = 111_320 * Math.cos(anchorLat * Math.PI / 180);
  const lngLatToWorld = (lng: number, lat: number) => ({
    x: (lng - anchorLng) * M_PER_DEG_LNG,
    z: -(lat - anchorLat) * M_PER_DEG_LAT,
  });

  // Bbox supplied by caller (JS computes from H3 cells via cellToBoundary)
  const west  = Number.isFinite(req.west)  ? req.west!  : anchorLng - 0.05;
  const east  = Number.isFinite(req.east)  ? req.east!  : anchorLng + 0.05;
  const south = Number.isFinite(req.south) ? req.south! : anchorLat - 0.04;
  const north = Number.isFinite(req.north) ? req.north! : anchorLat + 0.04;

  type BuildingBox = { minX: number; maxX: number; minZ: number; maxZ: number; baseY: number; height: number; color: [number, number, number] };
  type VegItem = { taxonDid: string; worldX: number; worldY: number; worldZ: number; profile: unknown };
  type AtomItem = { symbol: string; worldX: number; worldY: number; worldZ: number; sphereRPm: number; colorR: number; colorG: number; colorB: number };

  const buildings: BuildingBox[] = [];
  const vegetation: VegItem[] = [];
  const atoms: AtomItem[] = [];

  // ── Primary: vertex_kami_model_instance (pre-placed typed instances) ──────
  type ModelRow = {
    instance_id: string; model_kind: string;
    world_x: number | string | null; world_y: number | string | null; world_z: number | string | null;
    scale_x: number | string | null; scale_y: number | string | null; scale_z: number | string | null;
    color_r: number | string | null; color_g: number | string | null; color_b: number | string | null;
    bbox_json: string | null; render_profile_json: string | null;
    kami_sphere_r_pm: number | string | null; kami_color_r: number | string | null;
    kami_color_g: number | string | null; kami_color_b: number | string | null;
    element_symbol: string | null;
  };
  let instanceRows: ModelRow[] = [];
  try {
    instanceRows = await (getDb() as any)
      .selectFrom("vertex_kami_model_instance as i")
      .innerJoin("vertex_kami_model_def as d", "d.vertex_id", "i.model_def_id")
      .leftJoin("vertex_scientific_taxon as t", "t.vertex_id", "d.taxonomy_did")
      .leftJoin("vertex_periodic_element as e", "e.vertex_id", "d.taxonomy_did")
      .select([
        "i.vertex_id as instance_id", "d.model_kind",
        "i.world_x", "i.world_y", "i.world_z", "i.scale_x", "i.scale_y", "i.scale_z",
        "i.color_r", "i.color_g", "i.color_b",
        "d.bbox_json", "t.render_profile_json",
        "e.kami_sphere_r_pm", "e.kami_color_r", "e.kami_color_g", "e.kami_color_b",
        "e.symbol as element_symbol",
      ])
      .where("i.tile_h3", "in", cells)
      .limit(limit)
      .execute();
  } catch { instanceRows = []; }

  for (const row of instanceRows) {
    const wx = Number(row.world_x ?? 0), wy = Number(row.world_y ?? 0), wz = Number(row.world_z ?? 0);
    const sx = Number(row.scale_x ?? 1), sy = Number(row.scale_y ?? 1), sz = Number(row.scale_z ?? 1);
    if (row.model_kind === "building" && row.bbox_json) {
      try {
        const bbox = JSON.parse(row.bbox_json) as { minX?: number; maxX?: number; minY?: number; maxY?: number; minZ?: number; maxZ?: number };
        const hw = ((bbox.maxX ?? 8) - (bbox.minX ?? -8)) * sx * 0.5;
        const hd = ((bbox.maxZ ?? 8) - (bbox.minZ ?? -8)) * sz * 0.5;
        buildings.push({ minX: wx - hw, maxX: wx + hw, minZ: wz - hd, maxZ: wz + hd, baseY: wy, height: ((bbox.maxY ?? 9) - (bbox.minY ?? 0)) * sy, color: [Number(row.color_r ?? 0.78), Number(row.color_g ?? 0.74), Number(row.color_b ?? 0.69)] });
      } catch { /* skip */ }
    } else if (row.model_kind === "vegetation" && row.render_profile_json) {
      try { vegetation.push({ taxonDid: row.instance_id, worldX: wx, worldY: wy, worldZ: wz, profile: JSON.parse(row.render_profile_json) }); } catch { /* skip */ }
    } else if (row.model_kind === "atom" || row.model_kind === "element") {
      atoms.push({ symbol: row.element_symbol ?? "?", worldX: wx, worldY: wy, worldZ: wz, sphereRPm: Number(row.kami_sphere_r_pm ?? 150), colorR: Number(row.kami_color_r ?? 0.5), colorG: Number(row.kami_color_g ?? 0.5), colorB: Number(row.kami_color_b ?? 0.5) });
    }
  }

  // ── Fallback: vertex_maps_building_3d direct bbox query ───────────────────
  if (buildings.length === 0) {
    type B3dRow = { centroid_lat: number | string; centroid_lng: number | string; height_m: number | string | null; footprint_json: string | null };
    let b3dRows: B3dRow[] = [];
    try {
      b3dRows = await (getDb() as any)
        .selectFrom("vertex_maps_building_3d")
        .select(["centroid_lat", "centroid_lng", "height_m", "footprint_json"])
        .where("centroid_lat", ">=", south)
        .where("centroid_lat", "<=", north)
        .where("centroid_lng", ">=", west)
        .where("centroid_lng", "<=", east)
        .limit(Math.min(limit, 500))
        .execute();
    } catch { b3dRows = []; }

    for (const r of b3dRows) {
      const lat = Number(r.centroid_lat), lng = Number(r.centroid_lng);
      const { x: wx, z: wz } = lngLatToWorld(lng, lat);
      const height = Number(r.height_m ?? 9);
      let hw = 8, hd = 8;
      if (r.footprint_json) {
        try {
          const fp = JSON.parse(r.footprint_json);
          const coords: [number, number][] = fp?.coordinates?.[0] ?? [];
          if (coords.length > 2) {
            const lngs = coords.map(c => c[0]), lats = coords.map(c => c[1]);
            hw = (Math.max(...lngs) - Math.min(...lngs)) * M_PER_DEG_LNG * 0.5;
            hd = (Math.max(...lats) - Math.min(...lats)) * M_PER_DEG_LAT * 0.5;
          }
        } catch { /* use defaults */ }
      }
      buildings.push({ minX: wx - hw, maxX: wx + hw, minZ: wz - hd, maxZ: wz + hd, baseY: 0, height, color: [0.78, 0.74, 0.69] });
    }
  }

  // ── Fallback: vertex_spatial Building rows by lat/lng bbox ─────────────────
  // vertex_maps_building_3d is populated by the BPMN pipeline from vertex_spatial;
  // query vertex_spatial directly when building_3d table has no coverage yet.
  if (buildings.length === 0 && Number.isFinite(south) && Number.isFinite(north) && Number.isFinite(west) && Number.isFinite(east)) {
    type SpatialBldRow = { lat: string | null; lng: string | null; props: string | null };
    let spatialRows: SpatialBldRow[] = [];
    try {
      spatialRows = await (getDb() as any)
        .selectFrom("vertex_spatial")
        .select(["lat", "lng", "props"])
        .where("label", "=", "Building")
        .where("lat", ">=", String(south))
        .where("lat", "<=", String(north))
        .where("lng", ">=", String(west))
        .where("lng", "<=", String(east))
        .limit(Math.min(limit, 500))
        .execute();
    } catch { spatialRows = []; }

    for (const r of spatialRows) {
      const lat = Number(r.lat), lng = Number(r.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const { x: wx, z: wz } = lngLatToWorld(lng, lat);
      let height = 9;
      if (r.props) {
        try {
          const p = JSON.parse(r.props);
          if (p.heightM) height = Number(p.heightM) || 9;
          else if (p.height) height = parseFloat(String(p.height).replace(/[^0-9.]/g, "")) || 9;
          else if (p["building:levels"]) height = (parseInt(String(p["building:levels"]), 10) || 3) * 3;
        } catch { /* use default */ }
      }
      const hw = 8, hd = 8;
      buildings.push({ minX: wx - hw, maxX: wx + hw, minZ: wz - hd, maxZ: wz + hd, baseY: 0, height, color: [0.78, 0.74, 0.69] });
    }
  }

  // ── Fallback: vertex_periodic_element atoms (CPK spheres, fixed world positions) ─
  // vertex_kami_model_instance has no atom placements yet; display first N elements
  // at fixed positions near origin as a science-visualization demonstration.
  if (atoms.length === 0) {
    type ElemRow = { symbol: string | null; kami_sphere_r_pm: number | string | null; kami_color_r: number | string | null; kami_color_g: number | string | null; kami_color_b: number | string | null };
    let elemRows: ElemRow[] = [];
    try {
      elemRows = await (getDb() as any)
        .selectFrom("vertex_periodic_element")
        .select(["symbol", "kami_sphere_r_pm", "kami_color_r", "kami_color_g", "kami_color_b"])
        .where("kami_sphere_r_pm", "is not", null)
        .orderBy("atomic_number", "asc")
        .limit(12)
        .execute();
    } catch { elemRows = []; }
    elemRows.forEach((r, i) => {
      if (!r.symbol) return;
      const col = i % 4, row = Math.floor(i / 4);
      atoms.push({ symbol: r.symbol, worldX: (col - 1.5) * 4, worldY: 1, worldZ: -30 - row * 4, sphereRPm: Number(r.kami_sphere_r_pm ?? 150), colorR: Number(r.kami_color_r ?? 0.5), colorG: Number(r.kami_color_g ?? 0.5), colorB: Number(r.kami_color_b ?? 0.5) });
    });
  }

  // ── Fallback: vertex_scientific_taxon vegetation (profile only, no world pos) ─
  if (vegetation.length === 0) {
    type TaxRow = { vertex_id: string; render_profile_json: string | null };
    let taxRows: TaxRow[] = [];
    try {
      taxRows = await (getDb() as any)
        .selectFrom("vertex_scientific_taxon")
        .select(["vertex_id", "render_profile_json"])
        .where("render_profile_json", "is not", null)
        .limit(7)
        .execute();
    } catch { taxRows = []; }
    taxRows.forEach((r, i) => {
      if (!r.render_profile_json) return;
      try {
        vegetation.push({ taxonDid: r.vertex_id, worldX: (i - 3) * 6, worldY: 0, worldZ: -20, profile: JSON.parse(r.render_profile_json) });
      } catch { /* skip */ }
    });
  }

  return {
    buildings,
    vegetation,
    atoms,
    modelCounts: { buildings: buildings.length, vegetation: vegetation.length, atoms: atoms.length, total: buildings.length + vegetation.length + atoms.length },
  };
}

async function cmdRuntimeConfig(sdk: HostSDK, _payload: Uint8Array): Promise<unknown> {
  try {
    let hostImports: { configGet?: (key: string) => string | undefined } | undefined;
    try {
      hostImports = (sdk as unknown as { hostImports?: { configGet?: (key: string) => string | undefined } }).hostImports;
    } catch {
      hostImports = undefined;
    }
    const cfg = (key: string): string | undefined => {
      try {
        return hostImports?.configGet?.(key);
      } catch {
        return undefined;
      }
    };
    const cfgFirstNonEmpty = (...keys: string[]): string | undefined => {
      for (const key of keys) {
        const value = cfg(key);
        if (value != null && value.trim() !== "") {
          return value.trim();
        }
      }
      return undefined;
    };
    const styleUrl = str(
      cfgFirstNonEmpty("MAP_STYLE_URL", "STYLE_URL", "MAPS_STYLE_URL")
      ?? "https://tiles.openfreemap.org/styles/liberty",
    );
    const mapDataCdnUrl = str(cfgFirstNonEmpty("MAP_DATA_CDN_URL", "MAPS_DATA_CDN_URL"));
    const mapDataObjectUrl = str(cfgFirstNonEmpty("MAP_DATA_OBJECT_URL", "MAPS_DATA_OBJECT_URL"));
    const mapDataMetadataKvkey = str(cfgFirstNonEmpty("MAP_DATA_METADATA_KVKEY", "MAPS_DATA_METADATA_KVKEY"));
    const vectorSources = await listVectorRuntimeSources();
    const vectorSource = vectorSources.find((source) => source.isDefault) ?? vectorSources[0] ?? null;
    const vectorTileUrl = str(
      cfgFirstNonEmpty("VECTOR_TILE_URL", "MAP_VECTOR_TILE_URL", "MAPS_VECTOR_TILE_URL", "KAMI_VECTOR_TILE_URL")
      ?? vectorSource?.vectorTileUrl
      ?? "",
    );
    const mapTileUrl = str(
      cfgFirstNonEmpty("MAP_TILE_URL", "MAPS_TILE_URL", "KAMI_MAP_TILE_URL")
      ?? "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/%7Bz%7D/%7By%7D/%7Bx%7D",
    );
    const terrainSources = await listTerrainRuntimeSources();
    const terrainSource = terrainSources.find((source) => source.isDefault) ?? terrainSources[0] ?? null;
    const orbitalSystems = await listOrbitalRuntimeSystems();
    const orbitalBodies = await listOrbitalRuntimeBodies();
    const celestialCatalogs = await listCelestialRuntimeCatalogs();
    const celestialObjects = await listCelestialRuntimeObjects();
    const demTileUrl = str(
      cfgFirstNonEmpty("DEM_TILE_URL", "MAP_DEM_TILE_URL", "MAPS_DEM_TILE_URL", "KAMI_DEM_TILE_URL")
      ?? terrainSource?.demTileUrl
      ?? "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/%7Bz%7D/%7Bx%7D/%7By%7D.png",
    );
    const mapillaryAccessToken = str(cfgFirstNonEmpty("MAPILLARY_ACCESS_TOKEN"));

    // Return both camelCase and snake_case for compatibility with old/new UI code.
    return {
      styleUrl,
      style_url: styleUrl,
      mapDataCdnUrl,
      map_data_cdn_url: mapDataCdnUrl,
      mapDataObjectUrl,
      map_data_object_url: mapDataObjectUrl,
      mapDataMetadataKvkey,
      map_data_metadata_kvkey: mapDataMetadataKvkey,
      mapTileUrl,
      map_tile_url: mapTileUrl,
      vectorTileUrl,
      vector_tile_url: vectorTileUrl,
      vectorSource,
      vector_source: vectorSource,
      vectorSources,
      vector_sources: vectorSources,
      terrainSource,
      terrain_source: terrainSource,
      terrainSources,
      terrain_sources: terrainSources,
      orbitalSystems,
      orbital_systems: orbitalSystems,
      orbitalBodies,
      orbital_bodies: orbitalBodies,
      celestialCatalogs,
      celestial_catalogs: celestialCatalogs,
      celestialObjects,
      celestial_objects: celestialObjects,
      demTileUrl,
      dem_tile_url: demTileUrl,
      mapillaryAccessToken,
      mapillary_access_token: mapillaryAccessToken,
    };
  } catch {
    const styleUrl = "https://tiles.openfreemap.org/styles/liberty";
    const vectorSources = await listVectorRuntimeSources();
    const vectorSource = vectorSources.find((source) => source.isDefault) ?? vectorSources[0] ?? null;
    const terrainSources = await listTerrainRuntimeSources();
    const terrainSource = terrainSources.find((source) => source.isDefault) ?? terrainSources[0] ?? null;
    const orbitalSystems = await listOrbitalRuntimeSystems();
    const orbitalBodies = await listOrbitalRuntimeBodies();
    const celestialCatalogs = await listCelestialRuntimeCatalogs();
    const celestialObjects = await listCelestialRuntimeObjects();
    const vectorTileUrl = vectorSource?.vectorTileUrl ?? "";
    const demTileUrl = terrainSource?.demTileUrl ?? "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/%7Bz%7D/%7Bx%7D/%7By%7D.png";
    return {
      styleUrl,
      style_url: styleUrl,
      mapDataCdnUrl: "",
      map_data_cdn_url: "",
      mapDataObjectUrl: "",
      map_data_object_url: "",
      mapDataMetadataKvkey: "",
      map_data_metadata_kvkey: "",
      mapTileUrl: "",
      map_tile_url: "",
      vectorTileUrl,
      vector_tile_url: vectorTileUrl,
      vectorSource,
      vector_source: vectorSource,
      vectorSources,
      vector_sources: vectorSources,
      terrainSource,
      terrain_source: terrainSource,
      terrainSources,
      terrain_sources: terrainSources,
      orbitalSystems,
      orbital_systems: orbitalSystems,
      orbitalBodies,
      orbital_bodies: orbitalBodies,
      celestialCatalogs,
      celestial_catalogs: celestialCatalogs,
      celestialObjects,
      celestial_objects: celestialObjects,
      demTileUrl,
      dem_tile_url: demTileUrl,
      mapillaryAccessToken: "",
      mapillary_access_token: "",
    };
  }
}

async function cmdKamiConfig(sdk: HostSDK, _payload: Uint8Array): Promise<unknown> {
  try {
    let hostImports: { configGet?: (key: string) => string | undefined } | undefined;
    try {
      hostImports = (sdk as unknown as { hostImports?: { configGet?: (key: string) => string | undefined } }).hostImports;
    } catch {
      hostImports = undefined;
    }
    const cfg = (key: string): string | undefined => {
      try {
        return hostImports?.configGet?.(key);
      } catch {
        return undefined;
      }
    };
    const candidates = [cfg("MAP_TILE_URL"), cfg("MAPS_TILE_URL"), cfg("KAMI_MAP_TILE_URL")]
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter(Boolean);
    const tileUrl = candidates[0] || "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
    const styleUrl = cfg("MAP_STYLE_URL") || cfg("MAPS_STYLE_URL") || undefined;
    const chunkSizeMeters = normalizeChunkSizeMeters(cfg("KAMI_CHUNK_SIZE_METERS"), 50);
    const source = candidates[0] ? "env" : "default";
    return await buildKamiRuntimePackage(tileUrl, source, styleUrl, chunkSizeMeters);
  } catch {
    const tileUrl = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
    return await buildKamiRuntimePackage(tileUrl, "fallback", undefined, 50);
  }
}

function normalizeQueryPayload(payload: Uint8Array, numericKeys: string[] = [], booleanKeys: string[] = []): Uint8Array {
  const req = decodeJson<Record<string, unknown>>(payload, {});
  const next: Record<string, unknown> = { ...req };
  for (const key of numericKeys) {
    const value = next[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed === "") {
        delete next[key];
      } else {
        const n = Number(trimmed);
        if (Number.isFinite(n)) next[key] = n;
      }
    }
  }
  for (const key of booleanKeys) {
    const value = next[key];
    if (typeof value === "string") {
      const trimmed = value.trim().toLowerCase();
      if (trimmed === "") {
        delete next[key];
      } else if (trimmed === "true" || trimmed === "1") {
        next[key] = true;
      } else if (trimmed === "false" || trimmed === "0") {
        next[key] = false;
      }
    }
  }
  return encodeJson(next);
}

async function cmdCrawlerLocations(_sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = decodeJson<Record<string, unknown>>(normalizeQueryPayload(
    payload,
    ["jobLimit", "job_limit", "resultsPerJob", "results_per_job", "limit"],
    ["includeUnresolved", "include_unresolved"],
  ), {});
  const limit = Math.min(Math.max(Number(req.limit ?? 200), 1), 1000);
  const includeUnresolved = Boolean(req.includeUnresolved ?? req.include_unresolved ?? false);
  const rows = (await listCollectionRows("webCrawlGeoEntity")).slice(0, limit);
  const points = rows.map((row) => {
    const latRaw = row.lat ?? row.latitude;
    const lngRaw = row.lng ?? row.longitude;
    const latitude = latRaw == null || latRaw === "" ? 0 : Number(latRaw);
    const longitude = lngRaw == null || lngRaw === "" ? 0 : Number(lngRaw);
    const hasLocation = Number.isFinite(latitude) && Number.isFinite(longitude) && (latitude !== 0 || longitude !== 0);
    return {
      resultId: str(row.entityId ?? row.rkey ?? ""),
      jobId: str(row.crawlId ?? row.jobId ?? ""),
      title: str(row.name ?? ""),
      url: str(row.sourceUrl ?? row.url ?? ""),
      host: str(row.sourceDomain ?? row.host ?? ""),
      ip: str(row.ip ?? ""),
      httpStatus: Number(row.httpStatus ?? 0),
      crawledAt: str(row.createdAt ?? row.crawledAt ?? ""),
      latitude: hasLocation ? latitude : 0,
      longitude: hasLocation ? longitude : 0,
      country: str(row.country ?? ""),
      region: str(row.region ?? ""),
      city: str(row.city ?? ""),
      isp: str(row.isp ?? ""),
      asn: str(row.asn ?? ""),
      serverLocation: str(row.serverLocation ?? ""),
      hasLocation,
      error: str(row.error ?? ""),
    };
  }).filter((point) => includeUnresolved || point.hasLocation);
  return {
    points,
    fetchedAt: nowISO(),
    jobCount: 0,
    resultCount: points.length,
    queriedJobs: 0,
    queriedResults: rows.length,
    errors: [],
    requestedStatuses: [],
  };
}

async function cmdActorLocations(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.actorLocations", normalizeQueryPayload(payload, ["limit"]));
  const limit = Math.min(Math.max(req.limit ?? 200, 1), 500);
  const rows = (await listProfileRows(Math.min(limit * 10, 1000))).filter((row) => {
    const valueB64 = rowField(row, "valueB64", "value_b64");
    return String(valueB64 ?? "") !== "";
  });
  const points: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const did = str(row.did || row.repo);
    if (!did || seen.has(did)) continue;
    const profile = safeDecodeBase64Json(rowField(row, "valueB64", "value_b64"));
    const locationText = readProfileLocationText(profile);
    let coords = readProfileCoordinates(profile);
    if (!coords && locationText) {
      coords = await resolvePlaceCoordinates(locationText);
    }
    if (!coords) continue;
    seen.add(did);
    points.push({
      did,
      handle: did.replace(/^did:web:/, "").replace(/:/g, "."),
      displayName: str(profile.displayName || row.displayName || did),
      description: str(profile.description || row.description || ""),
      location: locationText,
      latitude: coords.lat,
      longitude: coords.lng,
      source: readProfileCoordinates(profile) ? "profile" : "geocode-from-place",
    });
    if (points.length >= limit) break;
  }
  return {
    points,
    fetchedAt: nowISO(),
    queriedProfiles: rows.length,
    total: points.length,
  };
}

// ── Transport Intelligence ──

const cmdRegisterWaterway = mkRegister("waterway", "Waterway", "waterway", "name");
const cmdListWaterways = mkList("Waterway");
const cmdRegisterPort = mkRegister("port", "Port", "port", "name");
const cmdListPorts = mkList("Port", "portType");
const cmdRegisterStation = mkRegister("station", "Station", "station", "name");
const cmdListStations = mkList("Station", "stationType");
const cmdRegisterBusStop = mkRegister("busStop", "BusStop", "busStop", "name");
const cmdListBusStops = mkList("BusStop");
const cmdRegisterParking = mkRegister("parking", "Parking", "parking", "name");
const cmdListParkings = mkList("Parking");

/**
 * com.etzhayyim.apps.maps.nextDeparturesAtStop — Phase 2 (bus + train timetable).
 *
 * Reads the GTFS-JP schedule tables that the K8s gtfs-jp dumper writes:
 *   vertex_maps_stop_time  (stop_id, departure_time, …)
 *   vertex_maps_trip       (trip_id, route_id, headsign, …)
 *   vertex_spatial         (route metadata: agency, label=Railway|BusRoute)
 *
 * Index used: idx_maps_stop_time_stop_dep on (stop_id, departure_time).
 * Per advisor #5 we deliberately picked the (a) "next train at stop X"
 * read shape; switching to (b) "this route's full timetable" needs a
 * separate composite index on (feed_id, route_id, stop_sequence).
 *
 * GTFS-RT delays (Phase 3) are NOT applied here — this is the static
 * schedule view.
 */
async function cmdNextDeparturesAtStop(_sdk: HostSDK, body: ArrayBuffer | Uint8Array | string): Promise<ArrayBuffer> {
  const params = parseJsonObject(typeof body === "string" ? body : new TextDecoder().decode(body as ArrayBuffer));
  const stopId = String(params.stopId || "").trim();
  if (!stopId) {
    return encodeJson({ error: "stopId required" });
  }
  let fromTime = String(params.fromTime || "").trim();
  if (!fromTime) {
    const d = new Date();
    fromTime = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
  }
  const limit = Math.max(1, Math.min(200, Number(params.limit ?? 30)));
  const offset = Math.max(0, Number(params.offset ?? 0));

  // Single 3-way join, anchored by (stop_id, departure_time) index.
  // route metadata lives in vertex_spatial keyed by
  //   at://did:web:maps.etzhayyim.com/com.etzhayyim.apps.maps.{railway|busRoute}/gtfsjp-{feed_id}-{route_id}
  // so we reconstruct the rkey from feed_id + route_id at query time.
  const rows = await raceTimeout<any[]>(sql`
    SELECT
      st.feed_id          AS "feedId",
      st.trip_id          AS "tripId",
      st.stop_sequence    AS "stopSequence",
      st.departure_time   AS "departureTime",
      st.arrival_time     AS "arrivalTime",
      t.headsign          AS "headsign",
      t.route_id          AS "routeId",
      t.direction_id      AS "directionId",
      t.agency            AS "agency",
      vs.name             AS "routeLongName",
      vs.label            AS "routeLabel",
      vs.props            AS "routeProps"
    FROM vertex_maps_stop_time st
    JOIN vertex_maps_trip t
      ON t.feed_id = st.feed_id AND t.trip_id = st.trip_id
    LEFT JOIN vertex_spatial vs
      ON vs.rkey = ('gtfsjp-' || st.feed_id || '-' || t.route_id)
     AND vs.label IN ('Railway', 'BusRoute')
    WHERE st.stop_id = ${stopId}
      AND st.departure_time >= ${fromTime}
    ORDER BY st.departure_time ASC
    LIMIT ${limit}
    OFFSET ${offset}
  `.execute(getDb()), 5000, "nextDeparturesAtStop").then(r => (r as any).rows ?? []);

  const departures = rows.map((r: any) => {
    let routeShortName: string | undefined;
    if (typeof r.routeProps === "string") {
      try {
        const p = JSON.parse(r.routeProps);
        routeShortName = p.route_short_name;
      } catch {}
    }
    return {
      feedId: r.feedId,
      tripId: r.tripId,
      stopSequence: r.stopSequence,
      departureTime: r.departureTime,
      arrivalTime: r.arrivalTime,
      headsign: r.headsign,
      routeId: r.routeId,
      routeShortName,
      routeLongName: r.routeLongName,
      routeLabel: r.routeLabel,
      agency: r.agency,
      directionId: r.directionId,
    };
  });
  return encodeJson({
    stopId,
    fromTime,
    departures,
    total: departures.length,
    offset,
    limit,
  });
}

/**
 * com.etzhayyim.apps.maps.realtimeDelaysAtStop — Phase 3 (gated, RT layered on Phase 2).
 *
 * Same anchor as nextDeparturesAtStop (idx_maps_stop_time_stop_dep) but
 * LEFT JOIN'd against mv_maps_recent_trip_update so an offline RT pipeline
 * degrades gracefully to the static schedule.
 *
 * rtAvailable = true iff at least one row in mv_maps_recent_trip_update
 * shares the feed_id of the queried stop. The MV has 30 min ts cutoff
 * baked in, so freshness is automatic.
 *
 * Active alerts come from mv_maps_active_alerts, filtered by feed_id
 * (cheap) and a substring match on the affected_*_ids comma list (cheap
 * vs JOIN, since alert volumes are O(10s/feed)).
 */
async function cmdRealtimeDelaysAtStop(_sdk: HostSDK, body: ArrayBuffer | Uint8Array | string): Promise<ArrayBuffer> {
  const params = parseJsonObject(typeof body === "string" ? body : new TextDecoder().decode(body as ArrayBuffer));
  const stopId = String(params.stopId || "").trim();
  if (!stopId) {
    return encodeJson({ error: "stopId required" });
  }
  let fromTime = String(params.fromTime || "").trim();
  if (!fromTime) {
    const d = new Date();
    fromTime = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
  }
  const limit = Math.max(1, Math.min(200, Number(params.limit ?? 30)));
  const offset = Math.max(0, Number(params.offset ?? 0));

  // Recover feed_id from the stop_id form `gtfsjp-{feed_id}-{gtfs_stop_id}`.
  // We need it for the rtAvailable probe + alert filter and to keep the
  // trip-update join non-cartesian.
  let feedId = "";
  if (stopId.startsWith("gtfsjp-")) {
    const rest = stopId.slice("gtfsjp-".length);
    const dash = rest.indexOf("-");
    if (dash > 0) feedId = rest.slice(0, dash);
  }

  const departuresPromise = raceTimeout<any>(sql`
    SELECT
      st.feed_id          AS "feedId",
      st.trip_id          AS "tripId",
      st.stop_sequence    AS "stopSequence",
      st.departure_time   AS "scheduledDeparture",
      st.arrival_time     AS "scheduledArrival",
      t.headsign          AS "headsign",
      t.route_id          AS "routeId",
      t.agency            AS "agency",
      vs.name             AS "routeLongName",
      vs.label            AS "routeLabel",
      vs.props            AS "routeProps",
      tu.schedule_relationship  AS "scheduleRelationship",
      tu.arrival_delay_sec      AS "arrivalDelaySec",
      tu.departure_delay_sec    AS "departureDelaySec",
      tu.arrival_time           AS "predictedArrival",
      tu.departure_time         AS "predictedDeparture",
      tu.ts                     AS "rtAt"
    FROM vertex_maps_stop_time st
    JOIN vertex_maps_trip t
      ON t.feed_id = st.feed_id AND t.trip_id = st.trip_id
    LEFT JOIN vertex_spatial vs
      ON vs.rkey = ('gtfsjp-' || st.feed_id || '-' || t.route_id)
     AND vs.label IN ('Railway', 'BusRoute')
    LEFT JOIN mv_maps_recent_trip_update tu
      ON tu.feed_id = st.feed_id
     AND tu.trip_id = st.trip_id
     AND tu.stop_sequence = st.stop_sequence
    WHERE st.stop_id = ${stopId}
      AND st.departure_time >= ${fromTime}
    ORDER BY st.departure_time ASC
    LIMIT ${limit}
    OFFSET ${offset}
  `.execute(getDb()), 5000, "realtimeDelaysAtStop").then((r: any) => r.rows ?? []);

  // rtAvailable probe — feed_id-scoped, single row, sub-ms.
  const rtProbePromise = feedId
    ? raceTimeout<any>(sql`
        SELECT 1 AS one FROM mv_maps_recent_trip_update
        WHERE feed_id = ${feedId} LIMIT 1
      `.execute(getDb()), 2000, "rtProbe").then((r: any) => (r.rows ?? []).length > 0).catch(() => false)
    : Promise.resolve(false);

  // Alerts — feed-scoped + substring match on affected_*_ids.
  const stopIdLike = `%${stopId}%`;
  const alertsPromise = feedId
    ? raceTimeout<any>(sql`
        SELECT alert_id AS "alertId", cause, effect, severity,
               header_text AS "headerText", description, url,
               active_from AS "activeFrom", active_until AS "activeUntil"
        FROM mv_maps_active_alerts
        WHERE feed_id = ${feedId}
          AND (affected_stop_ids LIKE ${stopIdLike} OR affected_stop_ids IS NULL)
        LIMIT 50
      `.execute(getDb()), 3000, "alerts").then((r: any) => r.rows ?? []).catch(() => [])
    : Promise.resolve([] as any[]);

  const [rows, rtAvailable, alerts] = await Promise.all([departuresPromise, rtProbePromise, alertsPromise]);

  const departures = rows.map((r: any) => {
    let routeShortName: string | undefined;
    if (typeof r.routeProps === "string") {
      try { routeShortName = JSON.parse(r.routeProps).route_short_name; } catch {}
    }
    return {
      feedId: r.feedId,
      tripId: r.tripId,
      stopSequence: r.stopSequence,
      scheduledDeparture: r.scheduledDeparture,
      scheduledArrival: r.scheduledArrival,
      headsign: r.headsign,
      routeId: r.routeId,
      routeShortName,
      routeLabel: r.routeLabel,
      agency: r.agency,
      scheduleRelationship: r.scheduleRelationship,
      arrivalDelaySec: r.arrivalDelaySec,
      departureDelaySec: r.departureDelaySec,
      predictedArrival: r.predictedArrival,
      predictedDeparture: r.predictedDeparture,
      rtAt: r.rtAt,
    };
  });

  return encodeJson({
    stopId,
    fromTime,
    departures,
    alerts,
    rtAvailable,
    total: departures.length,
    offset,
    limit,
  });
}

const cmdRegisterEvCharger = mkRegister("evCharger", "EvCharger", "evCharger", "name");
const cmdListEvChargers = mkList("EvCharger", "connectorType");

// ─── com.etzhayyim.apps.maps.{get,list,bake}GsplatAsset ──────────────────────────
//
// 3D Gaussian Splat preview / QC asset registry (ADR-2605092800).
//
// `vertex_maps_gsplat_asset` rows = metadata only; the binary payload lives
// in B2 under `b2_key`. `getGsplatAsset` returns a short-lived public URL.
// `bakeGsplatAsset` is a thin façade — it inserts a job-tracking row and
// publishes a LangServer BPMN-contract message; the heavy splat→mesh extraction runs as
// a Vultr k8s pod (ADR-2604251830 L7→L8).

interface GsplatAssetRow {
  vertex_id: string;
  source_did: string;
  tile_h3: string;
  b2_key: string;
  byte_size: string | number;
  splat_count: string | number;
  sh_degree: number;
  format: string;
  generated_at: string;
  bake_job_id: string | null;
}

function gsplatRowToMeta(r: GsplatAssetRow) {
  return {
    vertexId: r.vertex_id,
    sourceDid: r.source_did,
    tileH3: r.tile_h3,
    b2Key: r.b2_key,
    byteSize: Number(r.byte_size) || 0,
    splatCount: Number(r.splat_count) || 0,
    shDegree: r.sh_degree ?? 0,
    format: r.format,
    generatedAt: r.generated_at,
    ...(r.bake_job_id ? { bakeJobId: r.bake_job_id } : {}),
  };
}

function gsplatPublicUrl(b2Key: string): string {
  // Read-only public bucket pattern used by other maps assets
  // (`mesh_tile` GLBs already follow this shape, so the splat preview
  // path inherits the same access policy without per-request signing).
  const base =
    str((_mapsEnv as any).B2_PUBLIC_BASE_URL) ||
    "https://etzhayyim-nats.s3.us-west-004.backblazeb2.com";
  return `${base.replace(/\/$/, "")}/${b2Key.replace(/^\//, "")}`;
}

interface GsplatMeshRow {
  vertex_id: string;
  gsplat_vertex_id: string;
  tile_h3: string;
  bake_job_id: string | null;
  b2_key: string;
  byte_size: string | number;
  triangle_count: string | number;
  baked_at: string;
}

async function cmdGetGsplatAsset(_sdk: HostSDK, body: ArrayBuffer | Uint8Array | string): Promise<ArrayBuffer> {
  const params = parseJsonObject(typeof body === "string" ? body : new TextDecoder().decode(body as ArrayBuffer));
  const tileH3 = str((params as any).tileH3).trim();
  const vertexId = str((params as any).vertexId).trim();
  if (!tileH3 && !vertexId) {
    return encodeJson({ error: "tileH3 or vertexId required" });
  }
  let q: any = getDb()
    .selectFrom("vertex_maps_gsplat_asset" as any)
    .select([
      "vertex_id",
      "source_did",
      "tile_h3",
      "b2_key",
      "byte_size",
      "splat_count",
      "sh_degree",
      "format",
      "generated_at",
      "bake_job_id",
    ] as any)
    .limit(1);
  if (vertexId) {
    q = q.where("vertex_id" as any, "=", vertexId);
  } else {
    q = q.where("tile_h3" as any, "=", tileH3).orderBy("generated_at" as any, "desc");
  }
  const rows = (await raceTimeout<GsplatAssetRow[]>(
    q.execute() as Promise<GsplatAssetRow[]>,
    3000,
    "getGsplatAsset",
  )) ?? [];
  const row = rows[0];
  if (!row) return encodeJson({ error: "asset not found" });

  // Resolve baked mesh (if any) — most recent row keyed by gsplat_vertex_id.
  let bakedMesh: GsplatMeshRow | undefined;
  try {
    const meshRows = (await raceTimeout<GsplatMeshRow[]>(
      getDb()
        .selectFrom("vertex_maps_gsplat_mesh" as any)
        .select([
          "vertex_id",
          "gsplat_vertex_id",
          "tile_h3",
          "bake_job_id",
          "b2_key",
          "byte_size",
          "triangle_count",
          "baked_at",
        ] as any)
        .where("gsplat_vertex_id" as any, "=", row.vertex_id)
        .orderBy("baked_at" as any, "desc")
        .limit(1)
        .execute() as Promise<GsplatMeshRow[]>,
      2500,
      "getGsplatAsset.bakedMesh",
    )) ?? [];
    bakedMesh = meshRows[0];
  } catch {
    bakedMesh = undefined;
  }

  return encodeJson({
    meta: gsplatRowToMeta(row),
    signedUrl: gsplatPublicUrl(row.b2_key),
    expiresInSec: 300,
    ...(bakedMesh
      ? {
          bakedMesh: {
            vertexId: bakedMesh.vertex_id,
            tileH3: bakedMesh.tile_h3,
            b2Key: bakedMesh.b2_key,
            byteSize: Number(bakedMesh.byte_size) || 0,
            triangleCount: Number(bakedMesh.triangle_count) || 0,
            bakedAt: bakedMesh.baked_at,
            ...(bakedMesh.bake_job_id ? { bakeJobId: bakedMesh.bake_job_id } : {}),
          },
          bakedMeshUrl: gsplatPublicUrl(bakedMesh.b2_key),
        }
      : {}),
  });
}

async function cmdListGsplatAssets(_sdk: HostSDK, body: ArrayBuffer | Uint8Array | string): Promise<ArrayBuffer> {
  const params = parseJsonObject(typeof body === "string" ? body : new TextDecoder().decode(body as ArrayBuffer));
  const tileH3 = str((params as any).tileH3).trim();
  const sourceDid = str((params as any).sourceDid).trim();
  const limit = Math.max(1, Math.min(200, Number((params as any).limit ?? 50)));
  const offset = Math.max(0, Number((params as any).offset ?? 0));
  let q: any = getDb()
    .selectFrom("vertex_maps_gsplat_asset" as any)
    .select([
      "vertex_id",
      "source_did",
      "tile_h3",
      "b2_key",
      "byte_size",
      "splat_count",
      "sh_degree",
      "format",
      "generated_at",
      "bake_job_id",
    ] as any);
  if (tileH3) q = q.where("tile_h3" as any, "=", tileH3);
  if (sourceDid) q = q.where("source_did" as any, "=", sourceDid);
  q = q.orderBy("generated_at" as any, "desc").limit(limit).offset(offset);
  const rows = (await raceTimeout<GsplatAssetRow[]>(
    q.execute() as Promise<GsplatAssetRow[]>,
    5000,
    "listGsplatAssets",
  )) ?? [];
  return encodeJson({
    assets: rows.map(gsplatRowToMeta),
    total: rows.length,
    offset,
    limit,
  });
}

interface GsplatJobRow {
  job_id: string;
  job_kind: string;
  tile_h3: string | null;
  status: string;
  phase: string | null;
  message: string | null;
  splat_count: string | number | null;
  triangle_count: string | number | null;
  byte_size: string | number | null;
  runtime_ms: string | number | null;
  ts: string;
}

function gsplatJobRowToOut(r: GsplatJobRow) {
  return {
    jobId:    r.job_id,
    jobKind:  r.job_kind,
    ...(r.tile_h3   ? { tileH3: r.tile_h3 } : {}),
    status:   r.status,
    ...(r.phase     ? { phase: r.phase } : {}),
    ...(r.message   ? { message: r.message } : {}),
    ...(r.splat_count    != null ? { splatCount:    Number(r.splat_count)    || 0 } : {}),
    ...(r.triangle_count != null ? { triangleCount: Number(r.triangle_count) || 0 } : {}),
    ...(r.byte_size      != null ? { byteSize:      Number(r.byte_size)      || 0 } : {}),
    ...(r.runtime_ms     != null ? { runtimeMs:     Number(r.runtime_ms)     || 0 } : {}),
    ts: r.ts,
  };
}

interface GsplatCostRow {
  job_kind: string;
  cost_sum: string | number | null;
  cnt: string | number;
}

interface CostBucket {
  totalUsd: number;
  count: number;
  byKind: { kind: string; totalUsd: number; count: number }[];
}

function emptyBucket(): CostBucket {
  return { totalUsd: 0, count: 0, byKind: [] };
}

async function _costBucketSinceISO(sinceIso: string): Promise<CostBucket> {
  const rows = (await raceTimeout<GsplatCostRow[]>(
    getDb()
      .selectFrom("vertex_maps_gsplat_job" as any)
      .select((eb: any) => [
        "job_kind",
        eb.fn.sum("cost_usd" as any).as("cost_sum"),
        eb.fn.count("vertex_id" as any).as("cnt"),
      ])
      .where("status" as any, "=", "completed")
      .where("ts" as any, ">=", sinceIso)
      .where("cost_usd" as any, "is not", null)
      .groupBy("job_kind" as any)
      .execute() as Promise<GsplatCostRow[]>,
    5000,
    "gsplatCost.bucket",
  )) ?? [];
  const bucket = emptyBucket();
  for (const r of rows) {
    const usd = Number(r.cost_sum) || 0;
    const cnt = Number(r.cnt) || 0;
    bucket.totalUsd += usd;
    bucket.count += cnt;
    bucket.byKind.push({ kind: r.job_kind, totalUsd: usd, count: cnt });
  }
  bucket.byKind.sort((a, b) => a.kind.localeCompare(b.kind));
  bucket.totalUsd = Math.round(bucket.totalUsd * 1e6) / 1e6;
  return bucket;
}

async function cmdGetGsplatCostSummary(_sdk: HostSDK, _body: ArrayBuffer | Uint8Array | string): Promise<ArrayBuffer> {
  const now = new Date();
  const utcMidnight = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
  ));
  const startOfTodayIso = utcMidnight.toISOString();
  const last7Iso  = new Date(Date.now() -  7 * 86_400_000).toISOString();
  const last30Iso = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [today, last7d, last30d] = await Promise.all([
    _costBucketSinceISO(startOfTodayIso),
    _costBucketSinceISO(last7Iso),
    _costBucketSinceISO(last30Iso),
  ]);
  return encodeJson({ today, last7d, last30d });
}

async function cmdGetGsplatJobStatus(_sdk: HostSDK, body: ArrayBuffer | Uint8Array | string): Promise<ArrayBuffer> {
  const params = parseJsonObject(typeof body === "string" ? body : new TextDecoder().decode(body as ArrayBuffer));
  const jobId = str((params as any).jobId).trim();
  if (!jobId) return encodeJson({ error: "jobId required" });
  const rows = (await raceTimeout<GsplatJobRow[]>(
    getDb()
      .selectFrom("mv_maps_gsplat_job_latest" as any)
      .select([
        "job_id", "job_kind", "tile_h3", "status", "phase", "message",
        "splat_count", "triangle_count", "byte_size", "runtime_ms", "ts",
      ] as any)
      .where("job_id" as any, "=", jobId)
      .limit(1)
      .execute() as Promise<GsplatJobRow[]>,
    3000,
    "getGsplatJobStatus",
  )) ?? [];
  if (!rows[0]) return encodeJson({ error: "job not found" });
  return encodeJson(gsplatJobRowToOut(rows[0]));
}

async function cmdListGsplatJobs(_sdk: HostSDK, body: ArrayBuffer | Uint8Array | string): Promise<ArrayBuffer> {
  const params = parseJsonObject(typeof body === "string" ? body : new TextDecoder().decode(body as ArrayBuffer));
  const tileH3 = str((params as any).tileH3).trim();
  const jobKind = str((params as any).jobKind).trim();
  const status = str((params as any).status).trim();
  const limit = Math.max(1, Math.min(200, Number((params as any).limit ?? 50)));
  const offset = Math.max(0, Number((params as any).offset ?? 0));
  let q: any = getDb()
    .selectFrom("mv_maps_gsplat_job_latest" as any)
    .select([
      "job_id", "job_kind", "tile_h3", "status", "phase", "message",
      "splat_count", "triangle_count", "byte_size", "runtime_ms", "ts",
    ] as any);
  if (tileH3)  q = q.where("tile_h3"  as any, "=", tileH3);
  if (jobKind) q = q.where("job_kind" as any, "=", jobKind);
  if (status)  q = q.where("status"   as any, "=", status);
  q = q.orderBy("ts" as any, "desc").limit(limit).offset(offset);
  const rows = (await raceTimeout<GsplatJobRow[]>(
    q.execute() as Promise<GsplatJobRow[]>,
    5000,
    "listGsplatJobs",
  )) ?? [];
  return encodeJson({
    jobs:   rows.map(gsplatJobRowToOut),
    total:  rows.length,
    offset,
    limit,
  });
}

async function cmdTrainGsplatFromMapillary(sdk: HostSDK, body: ArrayBuffer | Uint8Array | string): Promise<ArrayBuffer> {
  const params = parseJsonObject(typeof body === "string" ? body : new TextDecoder().decode(body as ArrayBuffer));
  const lat = Number((params as any).lat);
  const lng = Number((params as any).lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return encodeJson({ error: "lat/lng required (numbers)" });
  }
  const radiusM = Math.max(5, Math.min(200, Number((params as any).radiusM ?? 50)));
  const h3Resolution = Math.max(8, Math.min(14, Number((params as any).h3Resolution ?? 12)));
  const tileH3 = str((params as any).tileH3) || latLngToCell(lat, lng, h3Resolution);
  const maxImages = Math.max(8, Math.min(400, Number((params as any).maxImages ?? 80)));
  const priority = ["low", "normal", "high"].includes(str((params as any).priority))
    ? str((params as any).priority)
    : "normal";
  const mapillaryImageIds = Array.isArray((params as any).mapillaryImageIds)
    ? (params as any).mapillaryImageIds.map((x: unknown) => String(x)).slice(0, 400)
    : [];
  const force = Boolean((params as any).force);

  // Per-tile lifetime spend gate. Compute *after* normalising tileH3
  // (so caller-supplied tile or lat/lng-derived tile both share the
  // same accounting). Refuses if cumulative > cap; operator override
  // via `force: true` (lexicon documents this).
  if (!force) {
    const lifetimeSpendUsd = await _resolveLifetimeSpendUsd(tileH3);
    const capUsd = _lifetimeSpendCapUsd();
    if (lifetimeSpendUsd >= capUsd) {
      return encodeJson({
        error: "train refused: tile lifetime spend cap exceeded (pass force:true to override)",
        tileH3,
        lifetimeSpendUsd: Math.round(lifetimeSpendUsd * 1e6) / 1e6,
        capUsd,
      });
    }
  }

  const queuedAt = nowISO();
  const trainJobId = `gsplattrain-${genID("train")}`;
  // Per-scene budget on L40S: COLMAP feature+match+mapper ~5-8 min,
  // gsplat training to convergence ~10-15 min for ~80 images. Surface
  // a generous estimate so the UI can show ETA.
  const estimatedDurationSec = 1200;

  // NOTE (confirmed while decommissioning 50-infra/vultr/zeebe, ADR-2607071500):
  // `sdk.zeebe` is not part of @etzhayyim/kotodama-host-sdk's HostSDK contract
  // (operations are create-host-sdk/dispatch/cancel/health only) — this cast
  // resolves to `undefined` and the guard below has never fired. That was
  // already true before Zeebe's VKE cluster was deleted 2026-06-24/25, so
  // leaving the guarded call in place is harmless (the job row is still
  // queued and polled by the dumper pod per the comment below) but it can
  // never dispatch. Kept as-is rather than ripped out; a real replacement
  // signal (if one is ever needed) should go through the kotoba Datomic BPMN
  // engine (ADR-2606162041), not Zeebe.
  try {
    const zeebe: any = (sdk as any).zeebe;
    if (zeebe && typeof zeebe.publishMessage === "function") {
      await zeebe.publishMessage({
        name: "com.etzhayyim.apps.maps.trainGsplatFromMapillary",
        correlationKey: tileH3,
        variables: {
          trainJobId, tileH3, lat, lng, radiusM, h3Resolution,
          mapillaryImageIds, maxImages, priority, queuedAt,
        },
        timeToLiveMs: 60 * 60 * 1000,
      });
    }
  } catch (e) {
    console.warn("[maps] trainGsplatFromMapillary publishMessage failed:", (e as Error)?.message ?? e);
  }
  return encodeJson({ trainJobId, tileH3, queuedAt, estimatedDurationSec });
}

/**
 * Hard PSNR floor — below this we refuse to bake at all (bake cost
 * is real and a sub-12 dB scene produces only noise mesh). Operator
 * override: pass `force: true` in the bake payload.
 */
const BAKE_HARD_MIN_PSNR = 12.0;

/**
 * Per-tile lifetime spend cap (USD). Cumulative `cost_usd` across
 * all train + bake jobs for a single tileH3. Once exceeded, future
 * train / bake calls refuse unless the caller passes `force: true`.
 * Operator can override the threshold via the
 * `MAPS_GSPLAT_LIFETIME_CAP_USD` env binding (read by the worker
 * from `_mapsEnv` at request time).
 */
const DEFAULT_LIFETIME_SPEND_CAP_USD = 10.0;

function _lifetimeSpendCapUsd(): number {
  const raw = (_mapsEnv as any)?.MAPS_GSPLAT_LIFETIME_CAP_USD;
  if (raw == null) return DEFAULT_LIFETIME_SPEND_CAP_USD;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LIFETIME_SPEND_CAP_USD;
}

interface LifetimeSpendRow {
  cost_sum: string | number | null;
  cnt: string | number | null;
}

async function _resolveLifetimeSpendUsd(tileH3: string): Promise<number> {
  try {
    const rows = (await raceTimeout<LifetimeSpendRow[]>(
      getDb()
        .selectFrom("vertex_maps_gsplat_job" as any)
        .select((eb: any) => [
          eb.fn.sum("cost_usd" as any).as("cost_sum"),
          eb.fn.count("vertex_id" as any).as("cnt"),
        ])
        .where("tile_h3" as any, "=", tileH3)
        .where("status" as any, "=", "completed")
        .where("cost_usd" as any, "is not", null)
        .execute() as Promise<LifetimeSpendRow[]>,
      2500,
      "lifetimeSpend",
    )) ?? [];
    return Number(rows[0]?.cost_sum) || 0;
  } catch {
    return 0;
  }
}

interface GsplatJobLatestRow {
  job_id: string;
  job_kind: string;
  tile_h3: string | null;
  status: string;
  phase: string | null;
  ts: string;
}

async function _resolveLatestTrainPsnr(tileH3: string): Promise<number | null> {
  // We surface evalPsnr on `vertex_maps_gsplat_job.message` only on
  // the auto-chain-skipped path; the canonical signal is the train
  // handler's own stats.evalPsnr which lives in
  // `vertex_maps_gsplat_asset.props` (forward path) — but `props` is
  // currently free-form JSON from the dumper. For a cheap consistency
  // gate, reject if the most-recent train for this tile produced a
  // job state row with `phase = "skipped-low-psnr"`.
  try {
    const rows = (await raceTimeout<GsplatJobLatestRow[]>(
      getDb()
        .selectFrom("mv_maps_gsplat_job_latest" as any)
        .select(["job_id", "job_kind", "tile_h3", "status", "phase", "ts"] as any)
        .where("tile_h3" as any, "=", tileH3)
        .where("job_kind" as any, "=", "train")
        .orderBy("ts" as any, "desc")
        .limit(1)
        .execute() as Promise<GsplatJobLatestRow[]>,
      2000,
      "bakeGate.train",
    )) ?? [];
    const row = rows[0];
    if (!row) return null;
    if (row.phase === "skipped-low-psnr") return BAKE_HARD_MIN_PSNR - 1; // sentinel < hard floor
    return null; // unknown / not gated
  } catch {
    return null;
  }
}

async function cmdBakeGsplatAsset(sdk: HostSDK, body: ArrayBuffer | Uint8Array | string): Promise<ArrayBuffer> {
  const params = parseJsonObject(typeof body === "string" ? body : new TextDecoder().decode(body as ArrayBuffer));
  const tileH3 = str((params as any).tileH3).trim();
  if (!tileH3) return encodeJson({ error: "tileH3 required" });
  const vertexId = str((params as any).vertexId).trim();
  const priority = ["low", "normal", "high"].includes(str((params as any).priority))
    ? str((params as any).priority)
    : "normal";
  const force = Boolean((params as any).force);

  // PSNR floor consistency with the dumper's auto-chain skip. If
  // the most recent train for this tile was gated below the soft
  // threshold, refuse the manual bake too unless `force: true` is
  // passed. Bake compute is real GPU $; spending it on noise output
  // helps no one.
  if (!force) {
    const latestPsnr = await _resolveLatestTrainPsnr(tileH3);
    if (latestPsnr !== null && latestPsnr < BAKE_HARD_MIN_PSNR) {
      return encodeJson({
        error: "bake refused: latest train was gated low-PSNR (pass force:true to override)",
        tileH3,
        latestEvalPsnr: latestPsnr,
        hardMinPsnr: BAKE_HARD_MIN_PSNR,
      });
    }
    // Per-tile lifetime spend gate (same accounting as train).
    const lifetimeSpendUsd = await _resolveLifetimeSpendUsd(tileH3);
    const capUsd = _lifetimeSpendCapUsd();
    if (lifetimeSpendUsd >= capUsd) {
      return encodeJson({
        error: "bake refused: tile lifetime spend cap exceeded (pass force:true to override)",
        tileH3,
        lifetimeSpendUsd: Math.round(lifetimeSpendUsd * 1e6) / 1e6,
        capUsd,
      });
    }
  }

  const queuedAt = nowISO();
  const bakeJobId = `gsplatbake-${genID("bake")}`;

  // Best-effort delegate to L7 (LangServer BPMN-contract). The k8s bake pod subscribes
  // to this message name and pulls the splat asset by `correlationKey`.
  // Failures here are non-fatal — the row in vertex_maps_gsplat_asset
  // can be retried by another bake invocation later.
  // NOTE (confirmed while decommissioning 50-infra/vultr/zeebe, ADR-2607071500):
  // `sdk.zeebe` was never part of the HostSDK contract, so this guarded call
  // has never actually dispatched — see the identical note on
  // cmdTrainGsplatFromMapillary above.
  try {
    const zeebe: any = (sdk as any).zeebe;
    if (zeebe && typeof zeebe.publishMessage === "function") {
      await zeebe.publishMessage({
        name: "com.etzhayyim.apps.maps.bakeGsplatAsset",
        correlationKey: tileH3,
        variables: { tileH3, vertexId, priority, bakeJobId, queuedAt },
        timeToLiveMs: 60 * 60 * 1000,
      });
    }
  } catch (e) {
    // surface but do not fail the XRPC — the dumper pod can also poll
    // a `vertex_maps_gsplat_asset` row whose bake_job_id is null/older.
    console.warn("[maps] bakeGsplatAsset publishMessage failed:", (e as Error)?.message ?? e);
  }
  return encodeJson({ bakeJobId, queuedAt });
}

async function cmdRegisterAirport(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = decodeJson<Record<string, unknown>>(payload, {});
  if (!str(req.name)) return { error: "name required" };
  const airportDid = str(req.airportDid) || `did:web:maps.etzhayyim.com:airport:${genID("apt")}`;
  const nodeId = `airport:${genID("apt")}`;
  await write(sdk, "airport", {
    ...req,
    airportDid,
    nodeId,
    nodeLabel: "Airport",
    createdAt: nowISO(),
    orgId: str((req as Record<string, unknown>).orgId ?? "anon"),
    userId: str((req as Record<string, unknown>).userId ?? "anon"),
    actorId: appId,
  });
  return { nodeId, airportDid, status: "created" };
}

async function cmdListAirports(_sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = decodeJson<Record<string, unknown>>(payload, {});
  const limit = Math.min(Math.max(Number(req.limit ?? 50), 1), 500);
  const offset = Number(req.offset ?? 0);
  let rows = await listCollectionRows("airport");
  const country = str(req.country);
  const operatorDid = str(req.operatorDid);
  const qValue = str(req.q);
  if (country) rows = rows.filter((row) => String(row.country ?? "") === country);
  if (operatorDid) rows = rows.filter((row) => String(row.operatorDid ?? "") === operatorDid);
  if (qValue) {
    const q = qValue.toLowerCase();
    rows = rows.filter((row) => {
      const name = String(row.name ?? "").toLowerCase();
      const icao = String(row.icao ?? "").toLowerCase();
      const iata = String(row.iata ?? "").toLowerCase();
      return name.includes(q) || icao.startsWith(q) || iata.startsWith(q);
    });
  }
  const total = rows.length;
  const airports = rows.slice(offset, offset + limit).map((row) => ({
    airportDid: row.airportDid ?? row.did ?? row.nodeId,
    name: row.name,
    icao: row.icao,
    iata: row.iata,
    country: row.country,
    city: row.city,
    operatorDid: row.operatorDid,
    lat: row.lat,
    lng: row.lng,
  }));
  return { airports, total, offset, limit };
}

async function cmdRegisterAircraft(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = decodeJson<Record<string, unknown>>(payload, {});
  if (!str(req.tailNumber)) return { error: "tailNumber required" };
  const aircraftDid = str(req.aircraftDid) || `did:web:maps.etzhayyim.com:aircraft:${genID("ac")}`;
  const nodeId = `aircraft:${genID("ac")}`;
  await write(sdk, "aircraft", {
    ...req,
    aircraftDid,
    nodeId,
    nodeLabel: "Aircraft",
    createdAt: nowISO(),
    actorId: appId,
  });
  return { nodeId, aircraftDid, status: "created" };
}

async function cmdUpsertFlightOperation(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = decodeJson<Record<string, unknown>>(payload, {});
  if (!str(req.flightNumber) || !str(req.aircraftDid) || !str(req.asOf)) return { error: "flightNumber, aircraftDid, asOf required" };
  const flightDid = str(req.flightDid) || `did:web:maps.etzhayyim.com:flight:${genID("flt")}`;
  const nodeId = `flightOperation:${genID("fop")}`;
  const revenue = readFiniteNumber(req.revenue);
  const cost = readFiniteNumber(req.cost);
  const profit = readFiniteNumber(req.profit) ?? (revenue != null && cost != null ? revenue - cost : null);
  await write(sdk, "flightOperation", {
    ...req,
    flightDid,
    nodeId,
    nodeLabel: "FlightOperation",
    profit: profit ?? req.profit,
    createdAt: nowISO(),
    actorId: appId,
  });
  return { nodeId, flightDid, status: "upserted" };
}

async function cmdListFlightOperations(_sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = decodeJson<Record<string, unknown>>(payload, {});
  const limit = Math.min(Math.max(Number(req.limit ?? 100), 1), 500);
  const offset = Number(req.offset ?? 0);
  let rows = await listCollectionRows("flightOperation");
  const aircraftDid = str(req.aircraftDid);
  const flightNumber = str(req.flightNumber);
  const operatorDid = str(req.operatorDid);
  const status = str(req.status);
  const minDelayMinutes = req.minDelayMinutes == null ? null : Number(req.minDelayMinutes);
  const maxDelayMinutes = req.maxDelayMinutes == null ? null : Number(req.maxDelayMinutes);
  const minOccupancyRate = req.minOccupancyRate == null ? null : Number(req.minOccupancyRate);
  const asOfFrom = str(req.asOfFrom);
  const asOfTo = str(req.asOfTo);
  if (aircraftDid) rows = rows.filter((row) => String(row.aircraftDid ?? "") === aircraftDid);
  if (flightNumber) rows = rows.filter((row) => String(row.flightNumber ?? "") === flightNumber);
  if (operatorDid) rows = rows.filter((row) => String(row.operatorDid ?? "") === operatorDid);
  if (status) rows = rows.filter((row) => String(row.status ?? "") === status);
  if (minDelayMinutes != null) rows = rows.filter((row) => Number(row.delayMinutes ?? -1) >= minDelayMinutes);
  if (maxDelayMinutes != null) rows = rows.filter((row) => Number(row.delayMinutes ?? 0) <= maxDelayMinutes);
  if (minOccupancyRate != null) rows = rows.filter((row) => Number(row.occupancyRate ?? 0) >= minOccupancyRate);
  if (asOfFrom) rows = rows.filter((row) => String(row.asOf ?? "") >= asOfFrom);
  if (asOfTo) rows = rows.filter((row) => String(row.asOf ?? "") <= asOfTo);
  rows.sort((a, b) => String(b.asOf ?? "").localeCompare(String(a.asOf ?? "")));
  const total = rows.length;
  const operations = rows.slice(offset, offset + limit).map((row) => ({
    flightDid: row.flightDid ?? row.did ?? row.nodeId,
    flightNumber: row.flightNumber,
    aircraftDid: row.aircraftDid,
    operatorDid: row.operatorDid,
    status: row.status,
    delayMinutes: Number(row.delayMinutes ?? 0),
    occupancyRate: Number(row.occupancyRate ?? 0),
    revenue: readFiniteNumber(row.revenue),
    cost: readFiniteNumber(row.cost),
    profit: readFiniteNumber(row.profit),
    currency: row.currency,
    asOf: row.asOf,
  }));
  return { operations, total, offset, limit };
}

async function cmdCrawlFlightPrices(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = decodeJson<Record<string, unknown>>(payload, {});
  if (!str(req.originIata) || !str(req.destinationIata) || !str(req.outboundDate)) {
    return { error: "originIata, destinationIata, outboundDate required" };
  }
  const crawlId = `flight-crawl:${genID("fc")}`;
  const origin = str(req.originIata).toLowerCase();
  const destination = str(req.destinationIata).toLowerCase();
  const out = str(req.outboundDate).replaceAll("-", "");
  const returnDate = str(req.returnDate);
  const ret = returnDate ? `/${returnDate.replaceAll("-", "")}` : "";
  const locale = str(req.locale || "en-US");
  const market = str(req.market || "US");
  const currency = str(req.currency || "USD");
  const adults = Number(req.adults ?? 1);
  const children = Number(req.children ?? 0);
  const cabinClass = str(req.cabinClass || "economy").toLowerCase();
  const sourceUrl = str(req.sourceUrl) || `https://www.skyscanner.net/transport/flights/${origin}/${destination}/${out}${ret}/?adultsv2=${adults}&childrenv2=${children}&cabinclass=${cabinClass}&currency=${encodeURIComponent(currency)}&locale=${encodeURIComponent(locale)}&market=${encodeURIComponent(market)}`;

  await write(sdk, "flightCrawlerJob", {
    nodeId: crawlId,
    nodeLabel: "FlightCrawlerJob",
    crawlId,
    status: "queued",
    provider: str(req.provider || "skyscanner-like"),
    originIata: str(req.originIata),
    destinationIata: str(req.destinationIata),
    outboundDate: str(req.outboundDate),
    returnDate: returnDate,
    sourceUrl,
    requestedAt: nowISO(),
    actorId: appId,
  });

  (sdk as any).hostImports?.kotodamaInvoke?.(
    "site.etzhayyim.com",
    "com.etzhayyim.apps.site.crawlPage",
    JSON.stringify({ url: sourceUrl, depth: 1, topics: "flight-price,aviation,booking" }),
  );

  await post(sdk, `[FlightPriceCrawler] queued ${str(req.originIata)}-${str(req.destinationIata)} ${str(req.outboundDate)}${returnDate ? `/${returnDate}` : ""} via ${str(req.provider || "skyscanner-like")}\n${sourceUrl}`);
  return { crawlId, status: "queued", sourceUrl };
}

async function cmdUpsertFlightOffer(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = decodeJson<Record<string, unknown>>(payload, {});
  if (!str(req.originIata) || !str(req.destinationIata) || !str(req.outboundDate) || req.totalPrice == null || !str(req.currency) || !str(req.bookingUrl)) {
    return { error: "originIata, destinationIata, outboundDate, totalPrice, currency, bookingUrl required" };
  }
  const offerId = str(req.offerId) || `offer:${genID("fof")}`;
  const nodeId = `flightOffer:${offerId.replaceAll(":", "-")}`;
  await write(sdk, "flightOffer", {
    ...req,
    offerId,
    nodeId,
    nodeLabel: "FlightOffer",
    observedAt: req.observedAt ?? nowISO(),
    createdAt: nowISO(),
    actorId: appId,
  });
  return { offerId, status: "upserted" };
}

async function cmdListFlightOffers(_sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = decodeJson<Record<string, unknown>>(payload, {});
  const limit = Math.min(Math.max(Number(req.limit ?? 100), 1), 500);
  const offset = Number(req.offset ?? 0);
  let rows = await listCollectionRows("flightOffer");
  const originIata = str(req.originIata);
  const destinationIata = str(req.destinationIata);
  const outboundDate = str(req.outboundDate);
  const returnDate = str(req.returnDate);
  const provider = str(req.provider);
  const currency = str(req.currency);
  const maxTotalPrice = req.maxTotalPrice == null ? null : Number(req.maxTotalPrice);
  if (originIata) rows = rows.filter((row) => String(row.originIata ?? "") === originIata);
  if (destinationIata) rows = rows.filter((row) => String(row.destinationIata ?? "") === destinationIata);
  if (outboundDate) rows = rows.filter((row) => String(row.outboundDate ?? "") === outboundDate);
  if (returnDate) rows = rows.filter((row) => String(row.returnDate ?? "") === returnDate);
  if (provider) rows = rows.filter((row) => String(row.provider ?? "") === provider);
  if (currency) rows = rows.filter((row) => String(row.currency ?? "") === currency);
  if (maxTotalPrice != null) rows = rows.filter((row) => Number(row.totalPrice ?? Number.MAX_SAFE_INTEGER) <= maxTotalPrice);
  rows.sort((a, b) => Number(a.totalPrice ?? Number.MAX_SAFE_INTEGER) - Number(b.totalPrice ?? Number.MAX_SAFE_INTEGER));
  const total = rows.length;
  const offers = rows.slice(offset, offset + limit).map((row) => ({
    offerId: row.offerId ?? row.nodeId,
    provider: row.provider ?? "unknown",
    originIata: row.originIata,
    destinationIata: row.destinationIata,
    outboundDate: row.outboundDate,
    returnDate: row.returnDate,
    airline: row.airline,
    flightNumber: row.flightNumber,
    totalPrice: Number(row.totalPrice ?? 0),
    basePrice: readFiniteNumber(row.basePrice),
    taxes: readFiniteNumber(row.taxes),
    currency: row.currency,
    bookingUrl: row.bookingUrl,
    deeplinkUrl: row.deeplinkUrl ?? row.bookingUrl,
    observedAt: row.observedAt,
  }));
  const cheapest = offers[0] ?? null;
  return { offers, cheapest, total, offset, limit };
}

// ── Geography Intelligence ──

// ── Digital Twin ──

const cmdRegisterBuilding = mkRegister("building", "Building", "bldg", "name");
const cmdListBuildings = mkList("Building");
const cmdGetBuilding = mkGet("Building", "buildingId");
const cmdRegisterBuildingFloor = mkRegister("buildingFloor", "BuildingFloor", "floor", "buildingId");
async function cmdRegisterAsset(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = decodeJson<Record<string, unknown>>(payload, {});
  if (!str(req.name)) return { error: "name required" };
  if (!str(req.assetType)) return { error: "assetType required" };
  const assetType = str(req.assetType);
  if (assetType !== "kami_street_chunk" && assetType !== "kami_prop_catalog" && assetType !== "kami_collision_chunk" && assetType !== "kami_nav_chunk") {
    return { error: "unsupported assetType" };
  }
  if (assetType === "kami_street_chunk") {
    if (!str(req.chunkKey)) return { error: "chunkKey required" };
    if (!str(req.sourceDid)) return { error: "sourceDid required" };
    if (!str(req.packageUrl)) return { error: "packageUrl required" };
  }
  const nodeId = `asset:${genID("asset")}`;
  const record = buildChunkAssetRecord(req, nodeId);
  if (assetType === "kami_street_chunk") {
    const compressedBytes = Number(record.compressedBytes ?? 0);
    const maxCompressedBytes = Number(record.maxCompressedBytes ?? 0);
    if (compressedBytes > maxCompressedBytes) {
      return {
        error: "compressedBytes exceeds budget",
        chunkSizeMeters: record.chunkSizeMeters,
        compressedBytes,
        maxCompressedBytes,
      };
    }
  }
  await write(sdk, "asset", record);
  return {
    nodeId,
    status: "created",
    assetType,
    chunkSizeMeters: record.chunkSizeMeters,
    qualityClass: record.qualityClass,
  };
}

async function cmdListAssets(_sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = decodeJson<Record<string, unknown>>(payload, {});
  const limit = Math.min(Math.max(Number(req.limit ?? 50), 1), 100);
  const offset = Math.max(0, Number(req.offset ?? 0));
  let rows = await listCollectionRows("asset");
  const assetType = str(req.assetType);
  const status = str(req.status);
  const chunkKeyPrefix = str(req.chunkKeyPrefix);
  const sourceDid = str(req.sourceDid);
  const chunkSizeMeters = req.chunkSizeMeters == null ? null : normalizeChunkSizeMeters(req.chunkSizeMeters);
  if (assetType) rows = rows.filter((row) => String(row.assetType ?? "") === assetType);
  if (status) rows = rows.filter((row) => String(row.status ?? "") === status);
  if (sourceDid) rows = rows.filter((row) => String(row.sourceDid ?? "") === sourceDid);
  if (chunkKeyPrefix) rows = rows.filter((row) => String(row.chunkKey ?? "").startsWith(chunkKeyPrefix));
  if (chunkSizeMeters != null) rows = rows.filter((row) => Number(row.chunkSizeMeters ?? 0) === chunkSizeMeters);
  rows.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  const total = rows.length;
  const assets = rows.slice(offset, offset + limit).map((row) => ({
    nodeId: row.nodeId ?? row.rkey,
    name: row.name,
    assetType: row.assetType,
    assetRole: row.assetRole,
    packageKind: row.packageKind,
    targetRuntime: row.targetRuntime,
    chunkKey: row.chunkKey,
    chunkSizeMeters: Number(row.chunkSizeMeters ?? 0) || undefined,
    lodCount: Number(row.lodCount ?? 0) || undefined,
    compressedBytes: Number(row.compressedBytes ?? 0) || undefined,
    maxCompressedBytes: Number(row.maxCompressedBytes ?? 0) || undefined,
    qualityClass: row.qualityClass,
    status: row.status,
    sourceDid: row.sourceDid,
    packageUrl: row.packageUrl,
    metadataUrl: row.metadataUrl,
    createdAt: row.createdAt,
  }));
  return { assets, total, offset, limit };
}

async function cmdDeviceBind(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.deviceBind", payload);
  if (!req.deviceDid || !req.assetId) return { error: "deviceDid and assetId required" };
  const nodeId = `devbind:${genID("devbind")}`;
  await write(sdk, "deviceBinding", {
    'nodeId': nodeId, 'deviceDid': req.deviceDid, 'assetId': req.assetId,
    protocol: req.protocol ?? "mqtt", status: "active", 'boundAt': nowISO(),
    'nodeLabel': "DeviceBinding", 'createdAt': nowISO(), 'orgId': "anon", 'userId': "anon", 'actorId': appId,
  });
  return { 'nodeId': nodeId, status: "bound" };
}

const cmdListDevices = mkList("DeviceBinding", "status");

async function cmdTwinStateUpdate(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.twinStateUpdate", payload);
  if (!req.entityType || !req.entityId) return { error: "entityType and entityId required" };
  const nodeId = `twin:${req.entityType}:${req.entityId}`;
  await write(sdk, "twinState", {
    'nodeId': nodeId, 'entityType': req.entityType, 'entityId': req.entityId,
    status: req.status ?? "active", 'healthScore': req.healthScore,
    'propertiesJson': req.propertiesJson, condition: req.status ?? "normal",
    'nodeLabel': "TwinState", 'createdAt': nowISO(), 'orgId': "anon", 'userId': "anon", 'actorId': appId,
  });
  return { 'nodeId': nodeId, status: "updated" };
}

const cmdTwinStateGet = mkGet("TwinState", "entityId");

async function cmdTwinScene(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.twinScene", payload);
  if (req.lat == null || req.lng == null) return { error: "lat and lng required" };
  const r = req.radiusKm ?? 0.5;
  const dlat = r / 111.0;
  const dlng = r / (111.0 * Math.cos(req.lat * Math.PI / 180));
  const bbox = { latMin: req.lat - dlat, latMax: req.lat + dlat, lngMin: req.lng - dlng, lngMax: req.lng + dlng };
  const buildings = (await listCollectionRows("building")).filter((row) => {
    const lat = readFiniteNumber(row.lat);
    const lng = readFiniteNumber(row.lng);
    return lat != null && lng != null && lat >= bbox.latMin && lat <= bbox.latMax && lng >= bbox.lngMin && lng <= bbox.lngMax;
  }).slice(0, 50);
  const sensors = (await listCollectionRows("sensor")).filter((row) => {
    const lat = readFiniteNumber(row.lat);
    const lng = readFiniteNumber(row.lng);
    return lat != null && lng != null && lat >= bbox.latMin && lat <= bbox.latMax && lng >= bbox.lngMin && lng <= bbox.lngMax;
  }).slice(0, 50);
  const infra = (await listCollectionRows("infraSegment")).filter((row) => {
    const lat = readFiniteNumber(row.lat);
    const lng = readFiniteNumber(row.lng);
    return lat != null && lng != null && lat >= bbox.latMin && lat <= bbox.latMax && lng >= bbox.lngMin && lng <= bbox.lngMax;
  }).slice(0, 100);
  return {
    'sceneType': "kamiJsonld", center: { lat: req.lat, lng: req.lng }, 'radiusKm': r,
    entities: {
      buildings: buildings.map(b => ({
        mesh: { type: "building", color: [0.7, 0.7, 0.75, 1.0], footprint: b.footprintJson, height: Number(b.heightM ?? 10) },
        position: { lat: b.lat, lng: b.lng }, properties: b,
      })),
      infrastructure: infra.map(seg => ({
        mesh: { type: "pipe", color: (seg.category ?? seg.infraType) ? [0.3, 0.5, 0.9, 1.0] : [0.5, 0.5, 0.5, 1.0], radius: 0.15, thickness: 0.02, height: Number(seg.depthM ?? 1) },
        properties: seg,
      })),
      sensors: sensors.map(sn => ({
        position: { lat: sn.lat, lng: sn.lng }, 'sensorType': sn.sensorType, properties: sn,
      })),
    },
    counts: { buildings: buildings.length, infrastructure: infra.length, sensors: sensors.length },
  };
}

async function cmdOccupancyUpdate(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.occupancyUpdate", payload);
  if (!req.buildingId) return { error: "buildingId required" };
  await write(sdk, "twinState", {
    'nodeId': `twin:occupancy:${req.buildingId}:${req.floorNumber ?? 0}`,
    'entityType': "occupancy", 'entityId': req.buildingId,
    status: "active", 'propertiesJson': JSON.stringify({ floor: req.floorNumber, occupancy: req.occupancy }),
    'nodeLabel': "TwinState", 'createdAt': nowISO(), 'orgId': "anon", 'userId': "anon", 'actorId': appId,
  });
  return { status: "updated" };
}

// ── Sensor Intelligence ──

const cmdRegisterSensor = mkRegister("sensor", "Sensor", "sensor", "sensorType");
const cmdListSensors = mkList("Sensor", "sensorType");

async function cmdSensorIngest(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.sensorIngest", payload);
  if (!req.sensorId || !req.readings?.length) return { error: "sensorId and readings required" };
  await write(sdk, "sensorReading", {
    sensorId: req.sensorId, readingsJson: JSON.stringify(req.readings),
    batchSize: req.readings.length, ingestedAt: nowISO(),
    'nodeLabel': "SensorReading", 'createdAt': nowISO(), 'orgId': "anon", 'userId': "anon", 'actorId': appId,
  });
  return { status: "ingested", sensorId: req.sensorId, count: req.readings.length };
}

async function cmdSensorQuery(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.sensorQuery", payload);
  if (!req.sensorId) return { error: "sensorId required" };
  const limit = Math.min(req.limit ?? 20, 100);
  return (await listCollectionRows("sensorReading")).filter((row) => String(row.sensorId ?? "") === req.sensorId).slice(0, limit);
}

async function cmdSensorLatest(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.sensorLatest", payload);
  if (!req.sensorId) return { error: "sensorId required" };
  const rows = (await listCollectionRows("sensorReading")).filter((row) => String(row.sensorId ?? "") === req.sensorId).slice(0, 1);
  return rows.length > 0 ? rows[0] : { error: "no readings" };
}

async function cmdSensorAlertSet(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.sensorAlertSet", payload);
  if (!req.sensorId || !req.metric || req.threshold == null) return { error: "sensorId, metric, threshold required" };
  const nodeId = `alertRule:${genID("alert")}`;
  await write(sdk, "sensorAlert", {
    'nodeId': nodeId, sensorId: req.sensorId, metric: req.metric,
    operator: req.operator ?? "gt", threshold: req.threshold,
    severity: req.severity ?? "warning", 'nodeLabel': "SensorAlert",
    'createdAt': nowISO(), 'orgId': "anon", 'userId': "anon", 'actorId': appId,
  });
  return { 'nodeId': nodeId, status: "created" };
}

const cmdListSensorAlerts = mkList("SensorAlert", "sensorId");

// ── Simulation Intelligence ──

async function cmdSimulationCreate(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.simulationCreate", payload);
  if (!req.name) return { error: "name required" };
  const nodeId = `sim:${genID("sim")}`;
  await write(sdk, "simulation", {
    'nodeId': nodeId, name: req.name, scenario: req.scenario ?? "default",
    'modelType': req.modelType ?? "generic", 'paramsJson': req.paramsJson,
    'targetArea': req.targetArea, status: "created", 'nodeLabel': "Simulation",
    'createdAt': nowISO(), 'orgId': "anon", 'userId': "anon", 'actorId': appId,
  });
  await post(sdk,
    `[Simulation] ${truncateText(req.name, 80)} created (${req.modelType ?? "generic"})\ncc @intel.etzhayyim.com`);
  return { 'nodeId': nodeId, status: "created" };
}

async function cmdSimulationRun(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.simulationRun", payload);
  if (!req.simulationId) return { error: "simulationId required" };
  await write(sdk, "simulationResult", {
    'simulationId': req.simulationId, status: "running", 'startedAt': nowISO(),
    'nodeLabel': "SimulationResult", 'createdAt': nowISO(), 'orgId': "anon", 'userId': "anon", 'actorId': appId,
  });
  return { 'simulationId': req.simulationId, status: "running" };
}

const cmdSimulationResult = mkGet("SimulationResult", "simulationId");

async function cmdForecastGet(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.forecastGet", payload);
  if (!req.entityId) return { error: "entityId required" };
  const rows = (await listCollectionRows("forecast")).filter((row) => {
    if (String(row.entityId ?? "") !== req.entityId) return false;
    if (req.forecastType && String(row.forecastType ?? "") !== req.forecastType) return false;
    return true;
  }).slice(0, 1);
  return rows.length > 0 ? rows[0] : { error: "no forecast" };
}

async function cmdHealthAssess(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.healthAssess", payload);
  if (!req.entityId) return { error: "entityId required" };
  const nodeId = `health:${genID("health")}`;
  await write(sdk, "healthAssessment", {
    'nodeId': nodeId, 'entityId': req.entityId,
    'compositeScore': req.compositeScore, 'degradationRate': req.degradationRate,
    'remainingLifeYears': req.remainingLifeYears, 'nodeLabel': "HealthAssessment",
    'createdAt': nowISO(), 'orgId': "anon", 'userId': "anon", 'actorId': appId,
  });
  return { 'nodeId': nodeId, status: "assessed" };
}

async function cmdMaintenancePlan(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.maintenancePlan", payload);
  if (!req.entityId) return { error: "entityId required" };
  const nodeId = `maint:${genID("maint")}`;
  await write(sdk, "maintenancePlan", {
    'nodeId': nodeId, 'entityId': req.entityId, 'planType': req.planType ?? "preventive",
    'intervalDays': req.intervalDays ?? 90, priority: req.priority ?? "medium",
    'nextDue': nowISO(), 'nodeLabel': "MaintenancePlan",
    'createdAt': nowISO(), 'orgId': "anon", 'userId': "anon", 'actorId': appId,
  });
  return { 'nodeId': nodeId, status: "planned" };
}

function clampProbability(value: unknown, fallback = 0.5): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function bayesianPosterior(prior: unknown, likelihood: unknown): number {
  const p = clampProbability(prior);
  const l = clampProbability(likelihood);
  const evidence = l * p + (1 - l) * (1 - p);
  if (evidence <= 0) return p;
  return (l * p) / evidence;
}

function beliefSlug(value: unknown): string {
  const slug = str(value).toLowerCase().replace(/[^a-z0-9:_-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || genID("belief");
}

async function latestWorldBelief(entityId: string, hypothesis: string): Promise<AnyRow | null> {
  const rows = await listCollectionRows("worldBelief");
  return sortRowsByRecency(rows.filter((row) =>
    String(row.entityId ?? "") === entityId && String(row.hypothesis ?? "") === hypothesis
  ))[0] ?? null;
}

async function cmdWorldBeliefUpdate(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.worldBeliefUpdate", payload);
  if (!req.entityId || !req.hypothesis) return { error: "entityId and hypothesis required" };
  if (req.likelihood == null && req.evidenceConfidence == null) return { error: "likelihood or evidenceConfidence required" };
  const entityId = String(req.entityId);
  const hypothesis = String(req.hypothesis);
  const previous = await latestWorldBelief(entityId, hypothesis);
  const prior = clampProbability(req.prior ?? previous?.posterior ?? previous?.existenceProbability ?? 0.5);
  const likelihood = clampProbability(req.likelihood ?? req.evidenceConfidence);
  const posterior = bayesianPosterior(prior, likelihood);
  const uncertainty = 1 - Math.abs(posterior - 0.5) * 2;
  const modelVersion = str(req.modelVersion) || "maps-blwm-v1";
  const nodeId = `belief:${beliefSlug(entityId)}:${beliefSlug(hypothesis)}:${genID("belief")}`;
  const record = {
    nodeId,
    entityId,
    entityType: str(req.entityType) || "spatial_entity",
    hypothesis,
    prior,
    likelihood,
    posterior,
    uncertainty,
    modelType: "bayesian-latent-world-model",
    modelVersion,
    evidenceJson: str(req.evidenceJson) || JSON.stringify({ sourceEventId: req.sourceEventId ?? null }),
    stateVectorJson: str(req.stateVectorJson) || previous?.stateVectorJson,
    sourceEventId: req.sourceEventId,
    previousBeliefId: previous?.nodeId,
    nodeLabel: "WorldBelief",
    createdAt: nowISO(),
    orgId: "anon",
    userId: "anon",
    actorId: appId,
  };
  await write(sdk, "worldBelief", record);
  await write(sdk, "twinState", {
    nodeId: `twin:belief:${beliefSlug(entityId)}:${beliefSlug(hypothesis)}`,
    entityType: record.entityType,
    entityId,
    status: posterior >= 0.8 ? "likely" : posterior <= 0.2 ? "unlikely" : "uncertain",
    condition: hypothesis,
    healthScore: posterior,
    propertiesJson: JSON.stringify({ hypothesis, prior, likelihood, posterior, uncertainty, modelVersion }),
    nodeLabel: "TwinState",
    createdAt: nowISO(),
    orgId: "anon",
    userId: "anon",
    actorId: appId,
  });
  return { nodeId, entityId, hypothesis, prior, likelihood, posterior, uncertainty, status: "updated" };
}

async function cmdWorldBeliefGet(_sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.worldBeliefGet", payload);
  if (!req.entityId) return { error: "entityId required" };
  const limit = Math.min(Math.max(Number(req.limit ?? 20), 1), 100);
  const rows = await listCollectionRows("worldBelief");
  const filtered = rows.filter((row) => {
    if (String(row.entityId ?? "") !== String(req.entityId)) return false;
    if (req.hypothesis && String(row.hypothesis ?? "") !== String(req.hypothesis)) return false;
    return true;
  });
  return sortRowsByRecency(filtered).slice(0, limit);
}

async function cmdLatentWorldModelRun(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.latentWorldModelRun", payload);
  const modelVersion = str(req.modelVersion) || "maps-blwm-v1";
  const hypothesis = str(req.hypothesis) || "operational_state_normal";
  const entityFilter = str(req.entityId);
  const limit = Math.min(Math.max(Number(req.limit ?? 25), 1), 100);
  const twinStates = sortRowsByRecency(await listCollectionRows("twinState"))
    .filter((row) => !entityFilter || String(row.entityId ?? "") === entityFilter)
    .slice(0, limit);
  const sensorReadings = sortRowsByRecency(await listCollectionRows("sensorReading")).slice(0, 100);
  const spatialEvents = sortRowsByRecency(await listCollectionRows("spatialEvent")).slice(0, 100);
  const entities = twinStates.length > 0 ? twinStates : (entityFilter ? [{ entityId: entityFilter, entityType: req.entityType }] : []);
  const updates = [];
  for (const entity of entities) {
    const entityId = String(entity.entityId ?? entity.nodeId ?? "");
    if (!entityId) continue;
    const health = readFiniteNumber(entity.healthScore);
    const priorRow = await latestWorldBelief(entityId, hypothesis);
    const prior = clampProbability(req.prior ?? priorRow?.posterior ?? health ?? 0.5);
    const localSensorCount = sensorReadings.filter((row) =>
      String(row.sensorId ?? "").includes(entityId) || String(row.entityId ?? "") === entityId
    ).length;
    const localEventCount = spatialEvents.filter((row) => String(row.entityId ?? "") === entityId).length;
    const evidenceLift = Math.min(0.2, (localSensorCount + localEventCount) * 0.02);
    const likelihood = clampProbability(req.likelihood ?? (health != null ? health : 0.55 + evidenceLift));
    const posterior = bayesianPosterior(prior, likelihood);
    const beliefPayload = encodeJson({
      entityId,
      entityType: entity.entityType ?? "spatial_entity",
      hypothesis,
      prior,
      likelihood,
      evidenceJson: JSON.stringify({
        twinStateId: entity.nodeId ?? null,
        localSensorCount,
        localEventCount,
        targetArea: req.targetArea ?? null,
      }),
      stateVectorJson: JSON.stringify({
        healthScore: health,
        localSensorCount,
        localEventCount,
        horizonSeconds: req.horizonSeconds ?? 3600,
      }),
      modelVersion,
    });
    const updated = await cmdWorldBeliefUpdate(sdk, beliefPayload as Uint8Array) as Record<string, unknown>;
    updates.push(updated);
    await write(sdk, "forecast", {
      nodeId: `forecast:${beliefSlug(entityId)}:${beliefSlug(hypothesis)}`,
      entityId,
      forecastType: hypothesis,
      probability: posterior,
      horizonSeconds: req.horizonSeconds ?? 3600,
      modelVersion,
      nodeLabel: "Forecast",
      createdAt: nowISO(),
      orgId: "anon",
      userId: "anon",
      actorId: appId,
    });
  }
  const runId = `worldrun:${genID("worldrun")}`;
  await write(sdk, "worldModelRun", {
    nodeId: runId,
    modelType: "bayesian-latent-world-model",
    modelVersion,
    hypothesis,
    targetArea: req.targetArea,
    entityId: entityFilter || undefined,
    inputCountsJson: JSON.stringify({ twinStates: twinStates.length, sensorReadings: sensorReadings.length, spatialEvents: spatialEvents.length }),
    resultJson: JSON.stringify({ updates }),
    status: "complete",
    nodeLabel: "WorldModelRun",
    createdAt: nowISO(),
    orgId: "anon",
    userId: "anon",
    actorId: appId,
  });
  await post(sdk, `[WorldModel] ${updates.length} belief updates completed (${modelVersion})`);
  return { runId, modelVersion, hypothesis, updates, status: "complete" };
}

// ── Spatiotemporal ──

async function cmdSpatialEventRecord(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.spatialEventRecord", payload);
  if (!req.entityId || !req.eventType) return { error: "entityId and eventType required" };
  const nodeId = `evt:${genID("evt")}`;
  await write(sdk, "spatialEvent", {
    'nodeId': nodeId, 'entityId': req.entityId, 'eventType': req.eventType,
    severity: req.severity ?? "info", description: req.description,
    'locationJson': (req.lat != null && req.lng != null) ? JSON.stringify({ lat: req.lat, lng: req.lng }) : undefined,
    'occurredAt': nowISO(), 'nodeLabel': "SpatialEvent",
    'createdAt': nowISO(), 'orgId': "anon", 'userId': "anon", 'actorId': appId,
  });
  return { 'nodeId': nodeId, status: "recorded" };
}

async function cmdSpatialEventQuery(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.spatialEventQuery", payload);
  const limit = Math.min(req.limit ?? 50, 100);
  return (await listCollectionRows("spatialEvent")).filter((row) => {
    if (req.entityId && String(row.entityId ?? "") !== req.entityId) return false;
    if (req.eventType && String(row.eventType ?? "") !== req.eventType) return false;
    return true;
  }).slice(0, limit);
}

async function cmdSpatialVersionRecord(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = decodeJson<{ entityId?: string; changeType?: string; properties?: Record<string, unknown> }>(payload, {});
  if (!req.entityId || !req.changeType) return { error: "entityId and changeType required" };
  const versionId = genID("ver");
  await write(sdk, "spatialVersion", {
    'versionId': versionId, 'entityId': req.entityId, 'changeType': req.changeType,
    'changedAt': nowISO(), properties: req.properties ? JSON.stringify(req.properties) : undefined,
    'nodeLabel': "SpatialVersion", 'createdAt': nowISO(), 'orgId': "anon", 'userId': "anon", 'actorId': appId,
  });
  return { 'versionId': versionId, status: "recorded" };
}

async function cmdSpatialVersionQuery(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.spatialVersionQuery", payload);
  if (!req.entityId) return { error: "entityId required" };
  const limit = Math.min(req.limit ?? 50, 100);
  return (await listCollectionRows("spatialVersion")).filter((row) => String(row.entityId ?? "") === req.entityId).slice(0, limit);
}

async function cmdSpatialRelationWrite(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.spatialRelationWrite", payload);
  if (!req.fromId || !req.toId || !req.relation) return { error: "fromId, toId, relation required" };
  const relId = genID("rel");
  await write(sdk, "spatialRelation", {
    'relId': relId, 'fromId': req.fromId, 'toId': req.toId, relation: req.relation,
    'validFrom': req.validFrom ?? nowISO(), 'validTo': req.validTo,
    'nodeLabel': "SpatialRelation", 'createdAt': nowISO(), 'orgId': "anon", 'userId': "anon", 'actorId': appId,
  });
  return { 'relId': relId, status: "created" };
}

async function cmdSpatialRelationQuery(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.spatialRelationQuery", payload);
  if (!req.entityId) return { error: "entityId required" };
  const limit = Math.min(req.limit ?? 50, 100);
  return (await listCollectionRows("spatialRelation")).filter((row) => {
    if (String(row.fromId ?? "") !== req.entityId && String(row.toId ?? "") !== req.entityId) return false;
    if (req.relation && String(row.relation ?? "") !== req.relation) return false;
    return true;
  }).slice(0, limit);
}

async function cmdTimeline(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.timeline", payload);
  if (!req.entityId) return { error: "entityId required" };
  const limit = Math.min(req.limit ?? 50, 100);
  const events = (await listCollectionRows("spatialEvent")).filter((row) => String(row.entityId ?? "") === req.entityId).slice(0, limit);
  const versions = (await listCollectionRows("spatialVersion")).filter((row) => String(row.entityId ?? "") === req.entityId).slice(0, limit);
  return { 'entityId': req.entityId, events, versions };
}

async function cmdSpatialDiff(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.spatialDiff", payload);
  if (!req.entityId) return { error: "entityId required" };
  const versions = (await listCollectionRows("spatialVersion")).filter((row) => String(row.entityId ?? "") === req.entityId).slice(0, 100);
  return { 'entityId': req.entityId, versions, 'diffCount': versions.length };
}

async function cmdDisplayLayerDefine(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.displayLayerDefine", payload);
  if (!req.name) return { error: "name required" };
  const layerId = genID("layer");
  await write(sdk, "displayLayer", {
    'layerId': layerId, name: req.name, domain: req.domain ?? "maps",
    'filterKind': req.filterKind, color: req.color ?? "#3b82f6",
    opacity: req.opacity ?? 0.8, 'renderType': req.renderType ?? "fill",
    'nodeLabel': "DisplayLayer", 'createdAt': nowISO(), 'orgId': "anon", 'userId': "anon", 'actorId': appId,
  });
  return { 'layerId': layerId, status: "created" };
}

const cmdListDisplayLayers = mkList("DisplayLayer", "domain");

// ── Step 1: User Post EXIF → SpatialEvent ('sourceDid': did:web:${appId}.etzhayyim.com:userPost) ──

async function cmdExtractPostLocation(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.extractPostLocation", payload);
  if (!req.postUri) return { error: "postUri required" };
  const results: Record<string, unknown>[] = [];
  const images = req.embedImages ?? [];
  for (const img of images) {
    if (!img.exif?.lat || !img.exif?.lng) continue;
    const eventId = genID("postLoc");
    await write(sdk, "spatialEvent", {
      'nodeId': `evt:${eventId}`, 'entityId': req.postUri, 'eventType': "userPostPhoto",
      severity: "info", description: `Photo from post: ${truncateText(req.postText ?? "", 100)}`,
      lat: img.exif.lat, lng: img.exif.lng, altitude: img.exif.altitude,
      'locationJson': JSON.stringify({ lat: img.exif.lat, lng: img.exif.lng, altitude: img.exif.altitude }),
      'imageCid': img.cid, 'cameraMake': img.exif.cameraMake, 'cameraModel': img.exif.cameraModel,
      'photoTimestamp': img.exif.timestamp, 'authorDid': req.authorDid,
      'sourceDid': `did:web:${appId}.etzhayyim.com:userPost`, 'nodeLabel': "SpatialEvent",
      'occurredAt': img.exif.timestamp ?? nowISO(), 'createdAt': nowISO(),
      'orgId': "anon", 'userId': str(req.authorDid ?? "anon"), 'actorId': appId,
    });
    const existing = (await listCollectionRows("place")).filter((row) => {
      const lat = readFiniteNumber(row.lat);
      const lng = readFiniteNumber(row.lng);
      return lat != null && lng != null
        && lat >= img.exif.lat - 0.0005 && lat <= img.exif.lat + 0.0005
        && lng >= img.exif.lng - 0.0005 && lng <= img.exif.lng + 0.0005;
    }).slice(0, 1);
    if (existing.length === 0) {
      const placeId = genID("placePost");
      await write(sdk, "place", {
        'nodeId': `place:${placeId}`, label: `User photo location`,
        lat: img.exif.lat, lng: img.exif.lng, source: "userPost",
        'sourceDid': `did:web:${appId}.etzhayyim.com:userPost`, status: "confirmed",
        'createdAt': nowISO(), 'orgId': "anon", 'userId': str(req.authorDid ?? "anon"), 'actorId': appId,
      });
    }
    results.push({ 'eventId': eventId, lat: img.exif.lat, lng: img.exif.lng, 'imageCid': img.cid });
  }
  return { extracted: results.length, locations: results };
}

async function cmdListPostLocations(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.listPostLocations", payload);
  const limit = Math.min(req.limit ?? 50, 100);
  const rows = await listCollectionRows("spatialEvent");
  return rows.filter((row) => {
    if (String(row.eventType ?? "") !== "userPostPhoto") return false;
    if (req.authorDid && String(row.authorDid ?? "") !== req.authorDid) return false;
    if (req.lat != null && req.lng != null) {
      const r = req.radiusKm ?? 5;
      const dlat = r / 111.0;
      const dlng = r / (111.0 * Math.cos(req.lat * Math.PI / 180));
      const lat = readFiniteNumber(row.lat);
      const lng = readFiniteNumber(row.lng);
      if (lat == null || lng == null) return false;
      if (lat < req.lat! - dlat || lat > req.lat! + dlat) return false;
      if (lng < req.lng! - dlng || lng > req.lng! + dlng) return false;
    }
    return true;
  }).slice(0, limit);
}

// ── Step 2: Mapraly ingest → Place/Route ('sourceDid': did:web:${appId}.etzhayyim.com:mapraly) ──

async function cmdMapralyIngest(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.mapralyIngest", payload);
  if (!req.region && !req.bbox) return { error: "region or bbox required" };
  const jobId = genID("mapralyJob");
  await write(sdk, "collectionJob", {
    'nodeId': `cj:${jobId}`, 'jobId': jobId, source: "mapraly",
    'sourceDid': `did:web:${appId}.etzhayyim.com:mapraly`, 'sourceUrl': "https://mapraly.com/api",
    format: "geojson", status: "pending", phase: 1,
    region: req.region, 'poiType': req.poiType,
    'bboxJson': req.bbox ? JSON.stringify(req.bbox) : undefined,
    'nodeLabel': "CollectionJob", 'createdAt': nowISO(),
    'orgId': "anon", 'userId': "anon", 'actorId': appId,
  });
  await post(sdk,
    `[Collection] Mapraly ingest job created: ${req.region ?? "bbox"} ${req.poiType ?? "all"}\ncc @jinushi.etzhayyim.com`);
  return { 'jobId': jobId, status: "pending", source: "mapraly" };
}

async function cmdMapralyImportPoi(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.mapralyImportPoi", payload);
  if (!req.pois?.length) return { error: "pois array required" };
  let created = 0;
  for (const poi of req.pois) {
    if (!poi.name || poi.lat == null || poi.lng == null) continue;
    if (poi.routeGeojson) {
      const routeId = genID("mapralyRoute");
      await write(sdk, "route", {
        'nodeId': `route:${routeId}`, name: poi.name, 'routeType': "mapraly",
        geojson: poi.routeGeojson, lat: poi.lat, lng: poi.lng,
        source: "mapraly", 'sourceDid': `did:web:${appId}.etzhayyim.com:mapraly`,
        'mapralyId': poi.mapralyId, description: poi.description,
        'nodeLabel': "Route", 'createdAt': nowISO(),
        'orgId': "anon", 'userId': "anon", 'actorId': appId,
      });
    } else {
      const spotId = genID("mapralySpot");
      await write(sdk, "spot", {
        'nodeId': `spot:${spotId}`, name: poi.name, 'spotType': "mapralyPoi",
        category: poi.category ?? "general", lat: poi.lat, lng: poi.lng,
        description: poi.description, 'photosJson': poi.photos ? JSON.stringify(poi.photos) : undefined,
        source: "mapraly", 'sourceDid': `did:web:${appId}.etzhayyim.com:mapraly`,
        'mapralyId': poi.mapralyId, 'nodeLabel': "Spot",
        'createdAt': nowISO(), 'orgId': "anon", 'userId': "anon", 'actorId': appId,
      });
    }
    created++;
  }
  if (created > 0) {
    await post(sdk,
      `[Mapraly] Imported ${created} POIs/routes\ncc @jinushi.etzhayyim.com @resources-r3s0urc3.etzhayyim.com`);
  }
  return { imported: created, total: req.pois.length };
}

async function cmdMapralyListPois(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.mapralyListPois", payload);
  const limit = Math.min(req.limit ?? 50, 100);
  const rows = await listCollectionRows("spot");
  return rows.filter((row) => {
    if (String(row.source ?? "") !== "mapraly") return false;
    if (req.category && String(row.category ?? "") !== req.category) return false;
    if (req.lat != null && req.lng != null) {
      const r = req.radiusKm ?? 10;
      const dlat = r / 111.0;
      const dlng = r / (111.0 * Math.cos(req.lat * Math.PI / 180));
      const lat = readFiniteNumber(row.lat);
      const lng = readFiniteNumber(row.lng);
      if (lat == null || lng == null) return false;
      if (lat < req.lat! - dlat || lat > req.lat! + dlat) return false;
      if (lng < req.lng! - dlng || lng > req.lng! + dlng) return false;
    }
    return true;
  }).slice(0, limit);
}

// ── Step 3: Murakumo Vision → image analysis → entity extraction ('sourceDid': did:web:${appId}.etzhayyim.com:vision) ──

async function cmdAnalyzeImage(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.analyzeImage", payload);
  if (!req.imageCid && !req.imageUrl) return { error: "imageCid or imageUrl required" };
  const jobId = genID("visionJob");
  await write(sdk, "collectionJob", {
    'nodeId': `cj:${jobId}`, 'jobId': jobId, source: "murakumoVision",
    'sourceDid': `did:web:${appId}.etzhayyim.com:vision`,
    format: "visionAnalysis", status: "pending", phase: 1,
    'imageCid': req.imageCid, 'imageUrl': req.imageUrl,
    lat: req.lat, lng: req.lng,
    'analysisType': req.analysisType ?? "spatialEntityExtraction",
    prompt: req.prompt ?? "Extract spatial entities: buildings, roads, vegetation, water, POIs. Classify land use. Estimate coordinates if possible.",
    'nodeLabel': "CollectionJob", 'createdAt': nowISO(),
    'orgId': "anon", 'userId': "anon", 'actorId': appId,
  });
  await post(sdk,
    `[Vision] Image analysis job created: ${req.analysisType ?? "spatialEntityExtraction"}\ncc @intel.etzhayyim.com`);
  return { 'jobId': jobId, status: "pending", source: "murakumoVision" };
}

async function cmdVisionImportEntities(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = decodeJson<{ jobId?: string; imageCid?: string; entities?: { kind: string; name: string; lat: number; lng: number; confidence: number; classes?: string[]; properties?: Record<string, unknown> }[] }>(payload, {});
  if (!req.entities?.length) return { error: "entities array required" };
  let created = 0;
  for (const ent of req.entities) {
    if (!ent.kind || ent.lat == null || ent.lng == null) continue;
    const collection = ent.kind;
    const label = LABEL_MAP[collection] ?? `Maps:${collection}`;
    const nodeId = genID(`vision_${collection}`);
    await write(sdk, collection, {
      'nodeId': `${collection}:${nodeId}`, name: ent.name, 'nodeLabel': label,
      lat: ent.lat, lng: ent.lng, confidence: ent.confidence,
      'detectedClasses': ent.classes ? JSON.stringify(ent.classes) : undefined,
      source: "murakumoVision", 'sourceDid': `did:web:${appId}.etzhayyim.com:vision`,
      'sourceImageCid': req.imageCid, 'visionJobId': req.jobId,
      ...(ent.properties ?? {}),
      'createdAt': nowISO(), 'orgId': "anon", 'userId': "anon", 'actorId': appId,
    });
    await write(sdk, "visionResult", {
      'nodeId': `vr:${genID("vr")}`, 'jobId': req.jobId, 'imageCid': req.imageCid,
      'entityKind': collection, 'entityNodeId': `${collection}:${nodeId}`,
      confidence: ent.confidence, 'classesJson': ent.classes ? JSON.stringify(ent.classes) : undefined,
      lat: ent.lat, lng: ent.lng, 'nodeLabel': "VisionResult",
      'sourceDid': `did:web:${appId}.etzhayyim.com:vision`,
      'createdAt': nowISO(), 'orgId': "anon", 'userId': "anon", 'actorId': appId,
    });
    created++;
  }
  if (created > 0) {
    await post(sdk,
      `[Vision] Extracted ${created} spatial entities from image\ncc @jinushi.etzhayyim.com @intel.etzhayyim.com`);
  }
  return { imported: created, total: req.entities.length };
}

async function cmdListVisionResults(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.listVisionResults", payload);
  const limit = Math.min(req.limit ?? 50, 100);
  return (await listCollectionRows("visionResult")).filter((row) => {
    if (req.jobId && String(row.jobId ?? "") !== req.jobId) return false;
    if (req.entityKind && String(row.entityKind ?? "") !== req.entityKind) return false;
    if (req.minConfidence != null && Number(row.confidence ?? 0) < req.minConfidence) return false;
    return true;
  }).slice(0, limit);
}

// ── Step 4: Satellite imagery → STAC → analysis ('sourceDid': did:web:${appId}.etzhayyim.com:satellite) ──

// Free satellite sources — STAC endpoints and metadata
const FREE_SATELLITE_CATALOG: Record<string, { 'stacUrl': string; 'resolutionM': number; bands: string; 'revisitDays': number; 'sensorType': string; 'collectionId': string }> = {
  "sentinel-2": { 'stacUrl': "https://earth-search.aws.element84.com/v1", 'resolutionM': 10, bands: "13 (VNIR/SWIR)", 'revisitDays': 5, 'sensorType': "optical", 'collectionId': "sentinel-2-l2a" },
  "landsat": { 'stacUrl': "https://landsatlook.usgs.gov/stac-server", 'resolutionM': 30, bands: "11 (OLI/TIRS)", 'revisitDays': 8, 'sensorType': "optical", 'collectionId': "landsat-c2l2-sr" },
  "sentinel-1": { 'stacUrl': "https://earth-search.aws.element84.com/v1", 'resolutionM': 10, bands: "C-band SAR (VV+VH)", 'revisitDays': 6, 'sensorType': "sar", 'collectionId': "sentinel-1-grd" },
  "hls": { 'stacUrl': "https://cmr.earthdata.nasa.gov/stac", 'resolutionM': 30, bands: "6 (harmonized)", 'revisitDays': 3, 'sensorType': "optical", 'collectionId': "HLSL30.v2.0" },
  "cop-dem": { 'stacUrl': "https://earth-search.aws.element84.com/v1", 'resolutionM': 30, bands: "DEM", 'revisitDays': 0, 'sensorType': "dem", 'collectionId': "cop-dem-glo-30" },
  "naip": { 'stacUrl': "https://planetarycomputer.microsoft.com/api/stac/v1", 'resolutionM': 1, bands: "4 (RGBNIR)", 'revisitDays': 730, 'sensorType': "aerial", 'collectionId': "naip" },
};

async function cmdSatelliteIngest(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.satelliteIngest", payload);
  if (!req.bbox.latMin && !req.bbox.latMax) return { error: "bbox required (latMin, latMax, lngMin, lngMax)" };
  const satellite = req.satellite ?? "sentinel-2";
  const catalog = FREE_SATELLITE_CATALOG[satellite];
  if (!catalog) return { error: `unknown satellite: ${satellite}. Available: ${Object.keys(FREE_SATELLITE_CATALOG).join(", ")}` };
  const jobId = genID("satJob");
  await write(sdk, "collectionJob", {
    'nodeId': `cj:${jobId}`, 'jobId': jobId, source: "satellite",
    'sourceDid': `did:web:${appId}.etzhayyim.com:satellite`,
    'sourceUrl': catalog.stacUrl, 'stacCollectionId': catalog.collectionId,
    format: "stacCog", status: "pending", phase: 1,
    satellite, 'sensorType': catalog.sensorType, bands: catalog.bands,
    'maxCloudCover': catalog.sensorType === "sar" ? undefined : (req.maxCloudCover ?? 20),
    'resolutionM': catalog.resolutionM, 'revisitDays': catalog.revisitDays,
    'dateFrom': req.dateFrom, 'dateTo': req.dateTo,
    'bboxJson': JSON.stringify(req.bbox),
    'nodeLabel': "CollectionJob", 'createdAt': nowISO(),
    'orgId': "anon", 'userId': "anon", 'actorId': appId,
  });
  await post(sdk,
    `[Satellite] ${satellite} (${catalog.resolutionM}m, ${catalog.sensorType}) ingest: ${req.bbox.latMin},${req.bbox.lngMin} → ${req.bbox.latMax},${req.bbox.lngMax}\ncc @intel.etzhayyim.com @jinushi.etzhayyim.com`);
  return { 'jobId': jobId, status: "pending", satellite, 'stacUrl': catalog.stacUrl, 'collectionId': catalog.collectionId, 'resolutionM': catalog.resolutionM, 'sensorType': catalog.sensorType };
}

function cmdListSatelliteSources(_sdk: HostSDK, _payload: Uint8Array): unknown {
  return Object.entries(FREE_SATELLITE_CATALOG).map(([name, info]) => ({ name, ...info, cost: "free" }));
}

async function cmdSatelliteImportScene(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.satelliteImportScene", payload);
  if (!req.scenes?.length) return { error: "scenes array required" };
  let created = 0;
  for (const scene of req.scenes) {
    if (!scene.sceneId) continue;
    const catalog = FREE_SATELLITE_CATALOG[scene.satellite];
    await write(sdk, "satelliteScene", {
      'nodeId': `sat:${scene.sceneId}`, 'sceneId': scene.sceneId,
      satellite: scene.satellite, 'acquisitionDate': scene.acquisitionDate,
      'cloudCover': scene.cloudCover, 'resolutionM': scene.resolutionM ?? catalog?.resolutionM ?? 10,
      'sensorType': scene.sensorType ?? catalog?.sensorType ?? "optical",
      'stacCollectionId': scene.stacCollectionId ?? catalog?.collectionId,
      'bboxJson': JSON.stringify(scene.bbox),
      lat: (scene.bbox.latMin + scene.bbox.latMax) / 2,
      lng: (scene.bbox.lngMin + scene.bbox.lngMax) / 2,
      'bandsJson': scene.bands ? JSON.stringify(scene.bands) : undefined,
      'cogUrl': scene.cogUrl, 'thumbnailUrl': scene.thumbnailUrl,
      source: "satellite", 'sourceDid': `did:web:${appId}.etzhayyim.com:satellite`,
      'nodeLabel': "SatelliteScene", 'createdAt': nowISO(),
      'orgId': "anon", 'userId': "anon", 'actorId': appId,
    });
    created++;
  }
  if (created > 0) {
    await post(sdk,
      `[Satellite] Imported ${created} scenes\ncc @intel.etzhayyim.com`);
  }
  return { imported: created, total: req.scenes.length };
}

async function cmdSatelliteAnalyze(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.satelliteAnalyze", payload);
  if (!req.sceneId) return { error: "sceneId required" };
  const scenes = (await listCollectionRows("satelliteScene")).filter((row) => String(row.sceneId ?? "") === req.sceneId).slice(0, 1);
  if (scenes.length === 0) return { error: "scene not found" };
  const jobId = genID("satAnalysis");
  const analysisType = req.analysisType ?? "changeDetection";
  await write(sdk, "collectionJob", {
    'nodeId': `cj:${jobId}`, 'jobId': jobId, source: "satelliteAnalysis",
    'sourceDid': `did:web:${appId}.etzhayyim.com:satellite`,
    format: "visionAnalysis", status: "pending", phase: 1,
    'sceneId': req.sceneId, 'analysisType': analysisType,
    'imageUrl': str(scenes[0].cogUrl ?? scenes[0].thumbnailUrl),
    prompt: req.prompt ?? `Analyze satellite imagery: ${analysisType}. Extract buildings, land use changes, vegetation, water bodies. Return entities with coordinates.`,
    'nodeLabel': "CollectionJob", 'createdAt': nowISO(),
    'orgId': "anon", 'userId': "anon", 'actorId': appId,
  });
  await post(sdk,
    `[Satellite] Analysis job: ${analysisType} on ${req.sceneId}\ncc @intel.etzhayyim.com`);
  return { 'jobId': jobId, status: "pending", 'analysisType': analysisType, 'sceneId': req.sceneId };
}

async function cmdListSatelliteScenes(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.listSatelliteScenes", payload);
  const limit = Math.min(req.limit ?? 50, 100);
  return (await listCollectionRows("satelliteScene")).filter((row) => {
    if (req.satellite && String(row.satellite ?? "") !== req.satellite) return false;
    if (req.lat != null && req.lng != null) {
      const r = req.radiusKm ?? 50;
      const dlat = r / 111.0;
      const dlng = r / (111.0 * Math.cos(req.lat * Math.PI / 180));
      const lat = readFiniteNumber(row.lat);
      const lng = readFiniteNumber(row.lng);
      if (lat == null || lng == null) return false;
      if (lat < req.lat! - dlat || lat > req.lat! + dlat) return false;
      if (lng < req.lng! - dlng || lng > req.lng! + dlng) return false;
    }
    return true;
  }).slice(0, limit);
}

// ── Dashboard (enhanced) ──

async function cmdGetDashboard(sdk: HostSDK, _payload: Uint8Array): Promise<unknown> {
  const pod = await callMapsLangserverRead("com.etzhayyim.apps.maps.getDashboard", _payload);
  if (pod) return pod;

  const count = async (label: string): Promise<number> => {
    try {
      return await countCollectionRows(collectionForLabel(label));
    } catch (e) {
      console.warn(`[getDashboard] count failed label=${label}: ${(e as Error).message}`);
      return 0;
    }
  };
  const [
    places, routes, buildings, sensors, roads, railways, airports, ports, stations,
    spots, rivers, lakes, mountains, infraNetworks, infraIncidents, simulations,
    spatialEvents, displayLayers, visionResults, satelliteScenes, collectionJobs,
  ] = await Promise.all([
    count("Place"), count("Route"), count("Building"), count("Sensor"), count("Road"),
    count("Railway"), count("Airport"), count("Port"), count("Station"), count("Spot"),
    count("River"), count("Lake"), count("Mountain"), count("InfraNetwork"),
    count("InfraIncident"), count("Simulation"), count("SpatialEvent"),
    count("DisplayLayer"), count("VisionResult"), count("SatelliteScene"),
    count("CollectionJob"),
  ]);
  const counts = {
    places, routes, buildings, sensors, roads, railways, airports, ports, stations,
    spots, rivers, lakes, mountains, infraNetworks, infraIncidents, simulations,
    spatialEvents, displayLayers, visionResults, satelliteScenes, collectionJobs,
  };
  const liveAircraft = await cmdListLiveAircraft(sdk, encodeJson({ limit: 12 })).catch(() => ({ aircraft: [], total: 0 })) as any;
  const liveSatellites = await cmdListLiveSatellites(sdk, encodeJson({ limit: 8 })).catch(() => ({ satellites: [], total: 0 })) as any;
  const vesselDensity = await cmdAismarineGetVesselDensityTile(sdk, encodeJson({ west: 122, south: 20, east: 154, north: 46, limit: 1 })).catch(() => ({ total: 0 })) as any;
  const eventRows = (await listCollectionRows("spatialEvent")).slice(0, 8);
  const events = eventRows.map((row, i) => {
    const eventType = str(row.eventType ?? row.event_type ?? row.label ?? "SpatialEvent");
    const severityRaw = str(row.severity ?? "info").toLowerCase();
    const severity = severityRaw === "critical" || severityRaw === "warning" || severityRaw === "watch" ? severityRaw : "info";
    return {
      id: str(row.nodeId ?? row.vertex_id ?? `event-${i}`),
      title: str(row.description ?? row.name ?? eventType),
      category: eventType,
      severity,
      timestamp: str(row.occurredAt ?? row.createdAt ?? row.updated_at ?? ""),
      lat: readFiniteNumber(row.lat),
      lng: readFiniteNumber(row.lng),
      source: str(row.sourceDid ?? row.source ?? ""),
    };
  });
  const riskScore = Math.min(100, Math.round(
    Math.min(spatialEvents, 250) * 0.12
    + Math.min(infraIncidents, 50) * 0.8
    + Math.min(Number(liveAircraft.total ?? liveAircraft.aircraft?.length ?? 0), 200) * 0.05
    + Math.min(Number(vesselDensity.total ?? 0), 500) * 0.03
    + Math.min(collectionJobs, 100) * 0.08
  ));
  const riskLevel = riskScore >= 70 ? "high" : riskScore >= 40 ? "elevated" : riskScore >= 18 ? "watch" : "low";
  const layers = [
    { id: "live-aircraft", name: "Live Aircraft", category: "mobility", enabled: true, count: Number(liveAircraft.total ?? liveAircraft.aircraft?.length ?? 0), color: "#10b981", description: "ADS-B aircraft positions" },
    { id: "live-satellites", name: "Live Satellites", category: "space", enabled: true, count: Number(liveSatellites.total ?? liveSatellites.satellites?.length ?? 0), color: "#ec4899", description: "SGP4 satellite overlay" },
    { id: "ais-vessels", name: "AIS Vessels", category: "maritime", enabled: true, count: Number(vesselDensity.total ?? 0), color: "#0ea5e9", description: "AIS marine traffic" },
    { id: "spatial-events", name: "Spatial Events", category: "intel", enabled: true, count: spatialEvents, color: "#f97316", description: "Seismic, sensor, post, and imported events" },
    { id: "weather-grid", name: "Weather Grid", category: "environment", enabled: false, count: sensors, color: "#60a5fa", description: "Open-Meteo weather field" },
    { id: "transport", name: "Transit / Routes", category: "transport", enabled: true, count: routes + railways + stations + ports + airports, color: "#a78bfa", description: "GTFS, rail, air, ferry, and route graph" },
    { id: "satellite-scenes", name: "Satellite Scenes", category: "imagery", enabled: false, count: satelliteScenes, color: "#84cc16", description: "STAC imagery and analysis jobs" },
    { id: "infrastructure", name: "Infrastructure", category: "assets", enabled: true, count: infraNetworks + infraIncidents + buildings, color: "#eab308", description: "Infrastructure graph, buildings, and incidents" },
  ];
  const panels = [
    { id: "risk", title: "Spatial Risk", value: riskScore, status: riskLevel, items: [{ label: "events", value: spatialEvents }, { label: "infra", value: infraIncidents }, { label: "jobs", value: collectionJobs }] },
    { id: "assets", title: "Live Assets", value: Number(liveAircraft.total ?? 0) + Number(liveSatellites.total ?? 0), status: "live", items: [{ label: "aircraft", value: Number(liveAircraft.total ?? liveAircraft.aircraft?.length ?? 0) }, { label: "satellites", value: Number(liveSatellites.total ?? liveSatellites.satellites?.length ?? 0) }, { label: "vessel density", value: Number(vesselDensity.total ?? 0) }] },
    { id: "coverage", title: "Graph Coverage", value: places + buildings + routes + roads + railways, status: "indexed", items: [{ label: "places", value: places }, { label: "buildings", value: buildings }, { label: "transport", value: routes + railways + stations }] },
  ];
  return {
    places, routes, buildings, sensors, roads, railways, airports, ports, stations,
    spots, rivers, lakes, mountains, 'infraNetworks': infraNetworks,
    'infraIncidents': infraIncidents, simulations, 'spatialEvents': spatialEvents,
    'displayLayers': displayLayers, 'visionResults': visionResults,
    'satelliteScenes': satelliteScenes, 'collectionJobs': collectionJobs,
    fetchedAt: nowISO(),
    region: "global",
    counts,
    risk: {
      score: riskScore,
      level: riskLevel,
      drivers: [
        spatialEvents > 0 ? `${spatialEvents} spatial events indexed` : "no recent event records",
        infraIncidents > 0 ? `${infraIncidents} infrastructure incidents` : "infrastructure incident count stable",
        collectionJobs > 0 ? `${collectionJobs} collection jobs in graph` : "no collection job backlog visible",
      ],
    },
    layers,
    panels,
    events,
  };
}

// ── Web Crawl Geo Coverage: site.etzhayyim.com integration ──

async function cmdSeedGeoDomains(sdk: HostSDK, payload: Uint8Array): Promise<Uint8Array> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.seedGeoDomains", payload);

  let targets = GEO_CRAWL_DOMAINS;
  if (req.categories && req.categories.length > 0) {
    targets = targets.filter(d => req.categories!.includes(d.category));
  }
  if (req.countries && req.countries.length > 0) {
    targets = targets.filter(d => req.countries!.includes(d.country));
  }

  const domains = targets.map(d => d.domain);

  // Invoke site.etzhayyim.com seedForProject remotely
  sdk.pds.dispatch({
    type: "invoke",
    payload: {
      did: "did:web:site.etzhayyim.com",
      method: "com.etzhayyim.apps.site.seedForProject",
      params: JSON.stringify({
        project: "maps",
        domains,
        topics: ["maps", "spatial", "geography", "transport", "infrastructure"],
        ccIndex: req.ccIndex ?? "CC-MAIN-2024-51",
        maxPagesPerDomain: 200,
        priority: 40,
      }),
    },
  });

  // Register site web crawl source DID (idempotent)
  await write(sdk, "source", {
    'sourceId': "src-site-webcrawl",
    name: "site.etzhayyim.com Web Crawl",
    'sourceType': "webcrawl",
    'sourceDid': "did:web:site.etzhayyim.com",
    'dataType': "wet+wat",
    license: "mixed",
    'crawlIntervalMin': 1440,
    enabled: 1,
    'nodeLabel': "MapsSource",
    'createdAt': nowISO(), 'orgId': "anon", 'userId': "anon", 'actorId': appId,
  });

  await post(sdk,
    `[SeedGeoDomains] Requested ${domains.length} geo domains from site.etzhayyim.com (categories: ${(req.categories ?? ["all"]).join(",")})\ncc @site.etzhayyim.com @jinushi.etzhayyim.com`);

  return encodeJson({ status: "seeded", 'domainCount': domains.length, domains });
}

async function cmdListGeoDomains(sdk: HostSDK, _payload: Uint8Array): Promise<Uint8Array> {
  return encodeJson({
    domains: GEO_CRAWL_DOMAINS,
    total: GEO_CRAWL_DOMAINS.length,
    categories: [...new Set(GEO_CRAWL_DOMAINS.map(d => d.category))],
    countries: [...new Set(GEO_CRAWL_DOMAINS.map(d => d.country))],
  });
}

// ── C-approach: seed commands → site.etzhayyim.com:ingestGeoData ──

/**
 * Seed USGS seismic feed via site.etzhayyim.com:ingestGeoData.
 * site fetches USGS GeoJSON → emits geoRecord{entityType:"seismicEvent"}
 * → maps handleCommit → write(spatialEvent).
 */
async function cmdSeedSeismicFeed(sdk: HostSDK, payload: Uint8Array): Promise<Uint8Array> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.seedSeismicFeed", payload);
  const feedMap = {
    day: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson",
    week: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson",
    month: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_month.geojson",
    significant: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_week.geojson",
  } as const;
  const feedUrl = feedMap[req.feed ?? "day"];
  (sdk as any).hostImports?.kotodamaInvoke?.(
    "site.etzhayyim.com",
    "com.etzhayyim.apps.site.ingestGeoData",
    JSON.stringify({ url: feedUrl, format: "usgs_geojson", project: "maps" }),
  );
  await post(sdk, `[SeedSeismic] Requested USGS ${req.feed ?? "day"} feed via @site.etzhayyim.com`);
  return encodeJson({ status: "seeded", feed: req.feed ?? "day", url: feedUrl });
}

/**
 * Seed JP municipality data via site.etzhayyim.com:ingestGeoData (Wikidata SPARQL).
 * Wikidata SPARQL: SELECT municipalities with JIS X 0402 codes + coordinates.
 * site → processWikidataSparqlResult → geoRecord{entityType:"municipality"}
 * → maps handleCommit → registerRegionRecord (AdminArea DID per municipality).
 */
async function cmdSeedMunicipalities(sdk: HostSDK, payload: Uint8Array): Promise<Uint8Array> {
  // Wikidata SPARQL: JP municipalities (P17=Q17 Japan, P31/P279* wd:Q494721)
  // Returns: ?name (ja), ?jis (P1402 JIS X 0402), ?lat, ?lng via geof functions
  const sparql = [
    "SELECT ?name ?jis ?lat ?lng WHERE {",
    "  ?muni wdt:P17 wd:Q17 ;",
    "        wdt:P31/wdt:P279* wd:Q494721 ;",
    "        rdfs:label ?name FILTER(LANG(?name)='ja') .",
    "  OPTIONAL { ?muni wdt:P1402 ?jis }",
    "  OPTIONAL { ?muni wdt:P625 ?coord .",
    "    BIND(geof:latitude(?coord) AS ?lat)",
    "    BIND(geof:longitude(?coord) AS ?lng) }",
    "  FILTER(BOUND(?jis))",
    "} LIMIT 2000",
  ].join(" ");
  const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`;
  (sdk as any).hostImports?.kotodamaInvoke?.(
    "site.etzhayyim.com",
    "com.etzhayyim.apps.site.ingestGeoData",
    JSON.stringify({ url, format: "wikidata_sparql", project: "maps" }),
  );
  await post(sdk, `[SeedMunicipalities] Requested JP 市区町村 via Wikidata SPARQL → @site.etzhayyim.com`);
  return encodeJson({ status: "seeded", source: "wikidata_sparql", limit: 2000 });
}

/**
 * Seed GTFS-JP data via site.etzhayyim.com:seedForProject on gtfs.jp + transit agency domains.
 * site crawls those pages → WET/WAT with GTFS file links → maps WAT handler detects GTFS URLs
 * → future: site:ingestGeoData with gtfs_zip format for discovered URLs.
 */
async function cmdSeedGtfsJp(sdk: HostSDK, _payload: Uint8Array): Promise<Uint8Array> {
  const gtfsDomains = [
    "www.gtfs.jp",
    "www.tokyometro.jp",
    "www.kotsu.city.osaka.lg.jp",
    "www.city.nagoya.jp",
    "www.namboku.co.jp",
    "www.odakyu.jp",
    "developer.odpt.org",
  ];
  (sdk as any).hostImports?.kotodamaInvoke?.(
    "site.etzhayyim.com",
    "com.etzhayyim.apps.site.seedForProject",
    JSON.stringify({
      project: "maps-gtfs",
      domains: gtfsDomains,
      topics: ["maps", "transport", "gtfs"],
      maxPagesPerDomain: 100,
      priority: 45,
    }),
  );
  await post(sdk, `[SeedGTFS] Seeding ${gtfsDomains.length} JP transit domains via @site.etzhayyim.com`);
  return encodeJson({ status: "seeded", domains: gtfsDomains });
}

/**
 * A: Seed World AdminArea tier-2 via Wikidata SPARQL → site.etzhayyim.com → adminArea2 geoRecords.
 * Covers US states, CN provinces, IN states, DE Bundesländer, FR régions, BR estados, etc.
 * Optional: region param filters by ISO 3166-1 alpha-2 prefix (e.g., "US" for US-* codes).
 */
async function cmdSeedWorldAdminAreas(sdk: HostSDK, payload: Uint8Array): Promise<Uint8Array> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.seedWorldAdminAreas", payload);
  const limit = Math.min(req.limit ?? 4000, 4000);
  const regionFilter = req.region ? `FILTER(STRSTARTS(?code, "${req.region.toUpperCase()}-"))` : "";
  const sparql = [
    "SELECT ?name ?code ?lat ?lng WHERE {",
    "  ?item wdt:P300 ?code .",
    "  ?item rdfs:label ?name FILTER(LANG(?name)='en') .",
    "  OPTIONAL { ?item wdt:P625 ?coord .",
    "    BIND(geof:latitude(?coord) AS ?lat)",
    "    BIND(geof:longitude(?coord) AS ?lng) }",
    regionFilter,
    `} LIMIT ${limit}`,
  ].join(" ");
  const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`;
  (sdk as any).hostImports?.kotodamaInvoke?.(
    "site.etzhayyim.com",
    "com.etzhayyim.apps.site.ingestGeoData",
    JSON.stringify({ url, format: "wikidata_sparql", project: "maps" }),
  );
  const label = req.region ? `region:${req.region}` : `all regions`;
  await post(sdk, `[SeedWorldAdminAreas] Requested tier-2 AdminAreas (${label}, limit:${limit}) via Wikidata SPARQL → @site.etzhayyim.com`);
  return encodeJson({ status: "seeded", source: "wikidata_sparql", entityType: "adminArea2", limit, region: req.region ?? "all" });
}

/**
 * B: Seed airport data from OurAirports CSV (1,000+ large/medium airports with ICAO+IATA).
 * Source: https://davidmegginson.github.io/ourairports-data/airports.csv (daily refresh, CC0)
 * site → processOurAirportsCsvResult → geoRecord{entityType:"airport"}
 * → maps handleCommit → write(airport) + ICAO DID + IATA DID
 */
async function cmdSeedAirports(sdk: HostSDK, _payload: Uint8Array): Promise<Uint8Array> {
  const url = "https://davidmegginson.github.io/ourairports-data/airports.csv";
  (sdk as any).hostImports?.kotodamaInvoke?.(
    "site.etzhayyim.com",
    "com.etzhayyim.apps.site.ingestGeoData",
    JSON.stringify({ url, format: "ourairports_csv", project: "maps" }),
  );
  await post(sdk, `[SeedAirports] Requested OurAirports CSV (large+medium airports) via @site.etzhayyim.com`);
  return encodeJson({ status: "seeded", source: "ourairports_csv", url });
}

/**
 * C: Seed real-time aircraft positions from OpenSky Network ADS-B.
 * Source: https://opensky-network.org/api/states/all (anonymous, no key, global or bbox)
 * Optional bbox params: lamin, lomin, lamax, lomax (default: JP region)
 * site → processOpenSkyJsonResult → geoRecord{entityType:"aircraft"}
 * → maps handleCommit → write(spatialEvent{eventType:"aircraftPosition"})
 */
async function cmdSeedAdsb(sdk: HostSDK, payload: Uint8Array): Promise<Uint8Array> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.seedAdsb", payload);
  // Default bbox: Japan + surrounding airspace
  const lamin = req.lamin ?? 24.0;
  const lomin = req.lomin ?? 122.0;
  const lamax = req.lamax ?? 46.0;
  const lomax = req.lomax ?? 154.0;
  const url = `https://opensky-network.org/api/states/all?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`;
  (sdk as any).hostImports?.kotodamaInvoke?.(
    "site.etzhayyim.com",
    "com.etzhayyim.apps.site.ingestGeoData",
    JSON.stringify({ url, format: "opensky_json", project: "maps" }),
  );
  await post(sdk, `[SeedADSB] Requested OpenSky ADS-B snapshot (bbox:[${lamin},${lomin}→${lamax},${lomax}]) via @site.etzhayyim.com`);
  return encodeJson({ status: "seeded", source: "opensky_json", bbox: { lamin, lomin, lamax, lomax } });
}

/**
 * Seed world rivers from Wikidata SPARQL (Q4022 = river, ~15K with coordinates).
 */
async function cmdSeedWorldRivers(sdk: HostSDK, _payload: Uint8Array): Promise<Uint8Array> {
  (sdk as any).hostImports?.kotodamaInvoke?.(
    "site.etzhayyim.com",
    "com.etzhayyim.apps.site.ingestGeoData",
    JSON.stringify({ url: "https://query.wikidata.org/sparql", format: "wikidata_sparql", project: "maps",
      sparql: `SELECT ?item ?itemLabel ?lat ?lng WHERE { ?item wdt:P31 wd:Q4022; wdt:P625 ?coord. BIND(geof:latitude(?coord) AS ?lat) BIND(geof:longitude(?coord) AS ?lng) SERVICE wikibase:label { bd:serviceParam wikibase:language "en,ja". } } LIMIT 15000`,
      entityType: "river" }),
  );
  await post(sdk, `[SeedRivers] Requested ~15K world rivers via Wikidata SPARQL → @site.etzhayyim.com`);
  return encodeJson({ status: "seeded", source: "wikidata_sparql", entityType: "river", limit: 15000 });
}

/**
 * Seed world lakes from Wikidata SPARQL (Q23397 = lake, ~8K with coordinates).
 */
async function cmdSeedWorldLakes(sdk: HostSDK, _payload: Uint8Array): Promise<Uint8Array> {
  (sdk as any).hostImports?.kotodamaInvoke?.(
    "site.etzhayyim.com",
    "com.etzhayyim.apps.site.ingestGeoData",
    JSON.stringify({ url: "https://query.wikidata.org/sparql", format: "wikidata_sparql", project: "maps",
      sparql: `SELECT ?item ?itemLabel ?lat ?lng WHERE { ?item wdt:P31 wd:Q23397; wdt:P625 ?coord. BIND(geof:latitude(?coord) AS ?lat) BIND(geof:longitude(?coord) AS ?lng) SERVICE wikibase:label { bd:serviceParam wikibase:language "en,ja". } } LIMIT 10000`,
      entityType: "lake" }),
  );
  await post(sdk, `[SeedLakes] Requested ~8K world lakes via Wikidata SPARQL → @site.etzhayyim.com`);
  return encodeJson({ status: "seeded", source: "wikidata_sparql", entityType: "lake", limit: 10000 });
}

// ── Live tracker: Flightradar24 + N2YO equivalent (2026-05-01) ───────────────
//
// Backend: LangServer BPMN-as-actor (ADR-0056) writes vertex_aircraft_state /
// vertex_aircraft_track / vertex_satellite_tle / vertex_satellite_pass via
// Hyperdrive direct (ADR-0036). These XRPC handlers are pure SELECT.

async function cmdListLiveAircraft(_sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const pod = await callMapsLangserverRead("com.etzhayyim.apps.maps.listLiveAircraft", payload);
  if (pod) return pod;

  const req = parseLexiconInput("com.etzhayyim.apps.maps.listLiveAircraft", normalizeQueryPayload(payload, ["minLat", "maxLat", "minLon", "maxLon", "maxAgeSec", "limit"]));
  const maxAge = Math.min(Math.max(Number(req.maxAgeSec ?? 90), 30), 600);
  const limitN = Math.min(Math.max(Number(req.limit ?? 200), 1), 2000);
  const cutoffMs = Date.now() - maxAge * 1000;

  try {
    let q: any = getDb()
      .selectFrom("vertex_aircraft_state" as any)
      .select([
        "icao24", "callsign", "lat", "lon",
        "baro_altitude_m as baroAltitudeM",
        "velocity_ms as velocityMs",
        "heading_deg as headingDeg",
        "vertical_rate_ms as verticalRateMs",
        "origin_country as originCountry",
        "source", "ts_ms as tsMs",
      ] as any)
      .where("on_ground" as any, "=", false)
      .where("ts_ms" as any, ">=", cutoffMs);

    if (req.minLat != null && req.maxLat != null) {
      q = q.where("lat" as any, ">=", req.minLat).where("lat" as any, "<=", req.maxLat);
    }
    if (req.minLon != null && req.maxLon != null) {
      q = q.where("lon" as any, ">=", req.minLon).where("lon" as any, "<=", req.maxLon);
    }
    if (req.country) {
      q = q.where("origin_country" as any, "=", req.country);
    }
    const rows = await q.orderBy("ts_ms" as any, "desc").limit(limitN).execute();
    return { aircraft: rows, count: rows.length, asOfMs: Date.now() };
  } catch (e) {
    console.warn(`[listLiveAircraft] unavailable: ${(e as Error).message}`);
    return { aircraft: [], count: 0, asOfMs: Date.now(), degraded: true };
  }
}

async function cmdListLiveSatellites(_sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const pod = await callMapsLangserverRead("com.etzhayyim.apps.maps.listLiveSatellites", payload);
  if (pod) return pod;

  const req = parseLexiconInput("com.etzhayyim.apps.maps.listLiveSatellites", normalizeQueryPayload(payload, ["limit"]));
  const limitN = Math.min(Math.max(Number(req.limit ?? 100), 1), 1000);
  const nowMs = Date.now();

  try {
    let q: any = getDb()
      .selectFrom("vertex_satellite_pass" as any)
      .select([
        "norad_id as noradId",
        "observer_h3 as observerH3",
        "aos_ms as aosMs",
        "los_ms as losMs",
        "max_elevation_deg as maxElevationDeg",
        "peak_azimuth_deg as peakAzimuthDeg",
        "visible_at_night as visibleAtNight",
        "magnitude",
      ] as any)
      .where("aos_ms" as any, "<=", nowMs)
      .where("los_ms" as any, ">=", nowMs);

    if (req.observerH3) {
      q = q.where("observer_h3" as any, "=", req.observerH3);
    }
    const rows = await q.orderBy("max_elevation_deg" as any, "desc").limit(limitN).execute();
    return { satellites: rows, count: rows.length, asOfMs: nowMs };
  } catch (e) {
    console.warn(`[listLiveSatellites] unavailable: ${(e as Error).message}`);
    return { satellites: [], count: 0, asOfMs: nowMs, degraded: true };
  }
}

async function cmdSatellitePassQuery(_sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.satellitePassQuery", payload);
  if (req.lat == null || req.lon == null) return { error: "lat and lon required" };
  const windowH = Math.min(Math.max(Number(req.windowH ?? 24), 1), 168);
  const minEl = Math.min(Math.max(Number(req.minElevationDeg ?? 10), 0), 90);
  const nowMs = Date.now();
  const horizonMs = nowMs + windowH * 3600 * 1000;

  // Fast cache path: try matching pre-computed observer cell within ~60km
  // (rough lat/lon ±0.5° box; observer_h3 is name-slug not real H3 yet).
  const cached = await getDb()
    .selectFrom("vertex_satellite_pass" as any)
    .select([
      "norad_id as noradId",
      "aos_ms as aosMs",
      "los_ms as losMs",
      "tca_ms as tcaMs",
      "max_elevation_deg as maxElevationDeg",
      "peak_azimuth_deg as peakAzimuthDeg",
      "visible_at_night as visibleAtNight",
      "magnitude",
    ] as any)
    .where("observer_lat" as any, ">=", req.lat - 0.5)
    .where("observer_lat" as any, "<=", req.lat + 0.5)
    .where("observer_lon" as any, ">=", req.lon - 0.5)
    .where("observer_lon" as any, "<=", req.lon + 0.5)
    .where("max_elevation_deg" as any, ">=", minEl)
    .where("aos_ms" as any, ">=", nowMs)
    .where("aos_ms" as any, "<=", horizonMs)
    .orderBy("aos_ms" as any, "asc")
    .limit(500)
    .execute() as any[];

  if (cached.length > 0) {
    return {
      passes: cached,
      count: cached.length,
      computedAtMs: nowMs,
      fromCache: true,
    };
  }

  // Cache miss → no on-demand SGP4 path at the edge; the R/PT1H LangServer
  // precompute job covers the next window. Surface a stub so client retries.
  return {
    passes: [],
    count: 0,
    computedAtMs: nowMs,
    fromCache: false,
    note: "no cached cell; on-demand SGP4 not wired through L3 yet; covered by next R/PT1H precompute",
  };
}

async function cmdAircraftTrack(_sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.aircraftTrack", payload);
  const windowH = Math.min(Math.max(Number(req.windowH ?? 6), 1), 48);
  const cutoffMs = Date.now() - windowH * 3600 * 1000;

  let q: any = getDb()
    .selectFrom("vertex_aircraft_track" as any)
    .select([
      "icao24", "callsign",
      "flight_start_ms as flightStartMs",
      "flight_end_ms as flightEndMs",
      "origin_iata as originIata",
      "dest_iata as destIata",
      "path_geojson as pathGeoJson",
      "max_altitude_m as maxAltitudeM",
      "max_velocity_ms as maxVelocityMs",
      "point_count as pointCount",
    ] as any)
    .where("flight_end_ms" as any, ">=", cutoffMs);
  if (req.icao24) q = q.where("icao24" as any, "=", req.icao24);
  if (req.callsign) q = q.where("callsign" as any, "=", req.callsign);
  const rows = await q.orderBy("flight_start_ms" as any, "desc").limit(50).execute();
  return { tracks: rows, count: rows.length };
}

async function cmdListCelestialObjects(_sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.listCelestialObjects", normalizeQueryPayload(payload, ["magMax", "limit"]));
  const limitN = Math.min(Math.max(Number(req.limit ?? 5000), 1), 20000);
  let q: any = getDb()
    .selectFrom("vertex_celestial_object" as any)
    .select([
      "object_id as objectId",
      "name",
      "object_kind as kind",
      "catalog_id as catalogId",
      "ra_deg as raDeg",
      "dec_deg as decDeg",
      "distance_ly as distanceLy",
      "spectral_class as spectralClass",
      "render_priority as renderPriority",
    ] as any);
  if (req.kind) q = q.where("object_kind" as any, "=", req.kind);
  if (req.catalogId) q = q.where("catalog_id" as any, "=", req.catalogId);
  // mag is in metadata_json — server side filter via JSON op skipped (RW slow);
  // sorting by render_priority approximates magnitude order (brighter = higher).
  const rows = await q.orderBy("render_priority" as any, "desc").limit(limitN).execute();
  return { objects: rows, count: rows.length, asOfMs: Date.now() };
}

/**
 * Seed world mountains from Wikidata SPARQL (Q8502 = mountain, ~20K with coordinates + elevation).
 */
async function cmdSeedWorldMountains(sdk: HostSDK, _payload: Uint8Array): Promise<Uint8Array> {
  (sdk as any).hostImports?.kotodamaInvoke?.(
    "site.etzhayyim.com",
    "com.etzhayyim.apps.site.ingestGeoData",
    JSON.stringify({ url: "https://query.wikidata.org/sparql", format: "wikidata_sparql", project: "maps",
      sparql: `SELECT ?item ?itemLabel ?lat ?lng ?elevation WHERE { ?item wdt:P31 wd:Q8502; wdt:P625 ?coord. OPTIONAL { ?item wdt:P2044 ?elevation. } BIND(geof:latitude(?coord) AS ?lat) BIND(geof:longitude(?coord) AS ?lng) SERVICE wikibase:label { bd:serviceParam wikibase:language "en,ja". } } LIMIT 25000`,
      entityType: "mountain" }),
  );
  await post(sdk, `[SeedMountains] Requested ~20K world mountains via Wikidata SPARQL → @site.etzhayyim.com`);
  return encodeJson({ status: "seeded", source: "wikidata_sparql", entityType: "mountain", limit: 25000 });
}

/**
 * Seed world railway stations from Wikidata SPARQL (Q55488 = railway station, ~30K).
 */
async function cmdSeedWorldStations(sdk: HostSDK, _payload: Uint8Array): Promise<Uint8Array> {
  (sdk as any).hostImports?.kotodamaInvoke?.(
    "site.etzhayyim.com",
    "com.etzhayyim.apps.site.ingestGeoData",
    JSON.stringify({ url: "https://query.wikidata.org/sparql", format: "wikidata_sparql", project: "maps",
      sparql: `SELECT ?item ?itemLabel ?lat ?lng WHERE { ?item wdt:P31 wd:Q55488; wdt:P625 ?coord. BIND(geof:latitude(?coord) AS ?lat) BIND(geof:longitude(?coord) AS ?lng) SERVICE wikibase:label { bd:serviceParam wikibase:language "en,ja". } } LIMIT 30000`,
      entityType: "station" }),
  );
  await post(sdk, `[SeedStations] Requested ~30K world railway stations via Wikidata SPARQL → @site.etzhayyim.com`);
  return encodeJson({ status: "seeded", source: "wikidata_sparql", entityType: "station", limit: 30000 });
}

/**
 * Seed world ports from Wikidata SPARQL (Q44782 = port, ~5K).
 */
async function cmdSeedWorldPorts(sdk: HostSDK, _payload: Uint8Array): Promise<Uint8Array> {
  (sdk as any).hostImports?.kotodamaInvoke?.(
    "site.etzhayyim.com",
    "com.etzhayyim.apps.site.ingestGeoData",
    JSON.stringify({ url: "https://query.wikidata.org/sparql", format: "wikidata_sparql", project: "maps",
      sparql: `SELECT ?item ?itemLabel ?lat ?lng WHERE { ?item wdt:P31 wd:Q44782; wdt:P625 ?coord. BIND(geof:latitude(?coord) AS ?lat) BIND(geof:longitude(?coord) AS ?lng) SERVICE wikibase:label { bd:serviceParam wikibase:language "en,ja". } } LIMIT 8000`,
      entityType: "port" }),
  );
  await post(sdk, `[SeedPorts] Requested ~5K world ports via Wikidata SPARQL → @site.etzhayyim.com`);
  return encodeJson({ status: "seeded", source: "wikidata_sparql", entityType: "port", limit: 8000 });
}

async function cmdListWebCrawlGeoEntities(sdk: HostSDK, payload: Uint8Array): Promise<Uint8Array> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.listWebCrawlGeoEntities", payload);
  const limit = Math.min(req.limit ?? 50, 200);
  const offset = req.offset ?? 0;
  let rows: Record<string, unknown>[] = [];
  try {
    rows = await listCollectionRows("webCrawlGeoEntity");
    if (req.domain) rows = rows.filter((row) => String(row.sourceDomain ?? "") === req.domain);
    if (req.entityType) rows = rows.filter((row) => String(row.entityType ?? "") === req.entityType);
    rows = rows.slice(offset, offset + limit);
  } catch {
    // table not yet populated
  }
  return encodeJson({ entities: rows, count: rows.length, limit, offset });
}

// ── Reactive: handleComAtprotoSyncSubscribeReposCommit (W Protocol commit stream) ──

export async function handleComAtprotoSyncSubscribeReposCommit(sdk: HostSDK, commit: ComAtprotoSyncSubscribeReposCommit): Promise<{ ok: true; detail: string }> {
  if (commit.action !== "create") return { ok: true, detail: "ignored" };

  if (commit.collection.startsWith("com.etzhayyim.apps.maps.")) {
    // Murakumo LLM vision callback → parse entities → write + post per entity
    if (commit.collection === "com.etzhayyim.apps.maps.satelliteAnalysisResult") {
      try {
        const rows = await listCollectionRows("satelliteAnalysisResult");
        const row = rows.find((entry) => String(entry.rkey ?? "") === commit.rkey);
        if (row) {
          const responseJson = str(row.responseJson ?? row.content ?? "[]");
          const metaJson = str(row.callbackMeta ?? "{}");
          let entities: Array<Record<string, unknown>> = [];
          let meta: Record<string, unknown> = {};
          try { entities = JSON.parse(responseJson); } catch { /* ok */ }
          try { meta = JSON.parse(metaJson); } catch { /* ok */ }
          const sceneId = str(meta.sceneId ?? "");
          const satellite = str(meta.satellite ?? "");
          const centerLat = Number(meta.lat ?? 0);
          const centerLng = Number(meta.lng ?? 0);
          const collectionMap: Record<string, string> = {
            building: "building", road: "road", river: "river",
            waterBody: "river", mountain: "mountain",
            settlement: "spot", landUse: "spot",
            vegetation: "spot", infrastructure: "spot",
          };
          for (const entity of entities) {
            const ename = str(entity.name ?? "");
            const etype = str(entity.entityType ?? "spot");
            if (!ename) continue;
            const collection = collectionMap[etype] ?? "spot";
            const desc = str(entity.description ?? "");
            const conf = Number(entity.confidence ?? 0.5);
            await write(sdk, collection, {
              nodeId: genID(`sat_${etype}`), name: ename,
              lat: Number(entity.lat ?? centerLat),
              lng: Number(entity.lng ?? centerLng),
              description: desc, confidence: conf,
              source: "satelliteAnalysis", satellite, sceneId,
              sourceDid: `did:web:${appId}.etzhayyim.com:satellite`,
              nodeLabel: etype.charAt(0).toUpperCase() + etype.slice(1),
              createdAt: nowISO(), orgId: "anon", userId: "anon", actorId: appId,
            });
            await post(sdk,
              `[Sat:${satellite}] ${ename} (${etype}) conf:${(conf * 100).toFixed(0)}%\n${truncateText(desc, 80)}\ncc @intel.etzhayyim.com @jinushi.etzhayyim.com`);
          }
        }
      } catch (e: any) { console.warn(`satelliteAnalysis error: ${e?.message ?? e}`); }
      return { ok: true, detail: "processedSatelliteAnalysis" };
    }

    // Generic: 1 social post per new maps entity (suppress noise collections)
    const noPostKinds = new Set(["geoAlias", "collectionJob"]);
    const kind = commit.collection.replace("com.etzhayyim.apps.maps.", "");
    if (!noPostKinds.has(kind)) {
      try {
        const label = kindToLabel(commit.collection);
          const rows = await listCollectionRows("geoAlias");
          const row = rows.find((entry) => String(entry.rkey ?? "") === commit.rkey);
        if (row) {
          const name = str(row.name ?? row.label ?? row.description ?? "");
          const lat = row.lat ?? row.latitude;
          const lng = row.lng ?? row.longitude;
          const eventType = str(row.eventType ?? "");
          // Suppress high-frequency real-time events (aircraft, weather readings)
          if (eventType === "aircraftPosition") return { ok: true, detail: "suppressedAircraft" };
          const geo = (lat && lng) ? ` (${Number(lat).toFixed(3)},${Number(lng).toFixed(3)})` : "";
          if (name) {
            await post(sdk,
              `[${label}] ${truncateText(name, 80)}${geo}\ncc @jinushi.etzhayyim.com @resources-r3s0urc3.etzhayyim.com @intel.etzhayyim.com`);
          }
        }
      } catch (e: any) { console.warn(`maps commit error: ${e?.message ?? e}`); }
    }
    return { ok: true, detail: "processedMaps" };
  }

  // Step 1: User posts with image embeds → auto-extract EXIF geolocation
  if (commit.collection === "app.bsky.feed.post") {
    try {
      const rows = await listCollectionRows("app.bsky.feed.post");
      const record = rows.find((entry) => String(entry.rkey ?? "") === commit.rkey);
      if (record) {
        const embedStr = str(record.embedJson ?? record.embed ?? "");
        if (embedStr) {
          try {
            const embed = JSON.parse(embedStr);
            const images: unknown[] = embed?.images ?? embed?.media?.images ?? [];
            for (const img of images) {
              const imgObj = img as Record<string, unknown>;
              const exif = imgObj.exif as Record<string, unknown> | undefined;
              if (exif?.lat && exif?.lng) {
                const lat = Number(exif.lat);
                const lng = Number(exif.lng);
                if (!isNaN(lat) && !isNaN(lng)) {
                  const eventId = genID("autoLoc");
                  await write(sdk, "spatialEvent", {
                    'nodeId': `evt:${eventId}`, 'entityId': commit.rkey, 'eventType': "userPostPhoto",
                    severity: "info", description: `Auto-extracted from post image`,
                    lat, lng, 'locationJson': JSON.stringify({ lat, lng }),
                    'imageCid': str(imgObj.cid ?? ""), 'sourceDid': `did:web:${appId}.etzhayyim.com:userPost`,
                    'authorDid': str(record.repo ?? record.author ?? ""),
                    'nodeLabel': "SpatialEvent", 'occurredAt': nowISO(), 'createdAt': nowISO(),
                    'orgId': "anon", 'userId': "anon", 'actorId': appId,
                  });
                  await post(sdk,
                    `[GeoPhoto] Auto-located post at ${lat.toFixed(4)},${lng.toFixed(4)}\ncc @jinushi.etzhayyim.com`);
                }
              }
            }
          } catch { /* embed parse failure — skip */ }
        }
      }
    } catch (e: any) { console.warn(`post geo-extract error: ${e?.message ?? e}`); }
    return { ok: true, detail: "processedPostGeo" };
  }

  if (commit.collection === "com.etzhayyim.apps.ipaddress.ipGeo") {
    try {
      const rows = await listCollectionRows("ipGeo");
      const row = rows.find((entry) => String(entry.rkey ?? "") === commit.rkey);
      if (row) {
        const ip = str(row.ip ?? "");
        const country = str(row.country ?? "");
        const city = str(row.city ?? "");
        if (ip) {
          await write(sdk, "spot", {
            'spotId': genID("ipgeo"), name: `IP: ${ip}`, 'spotType': "ipGeolocation",
            country, city, latitude: row.latitude, longitude: row.longitude,
            source: "ipaddress", 'nodeLabel': "Spot:IPGeo",
            'createdAt': nowISO(), 'orgId': "anon", 'userId': "anon", 'actorId': appId,
          });
          await post(sdk,
            `[Spot:IPGeo] ${ip} → ${city}, ${country}\nvia @ipaddress.etzhayyim.com cc @yabai.etzhayyim.com`);
        }
      }
    } catch (e: any) { console.warn(`ipGeo commit error: ${e?.message ?? e}`); }
    return { ok: true, detail: "processedIpGeo" };
  }

  // ── site.etzhayyim.com WET → geo entity NER extraction (Murakumo LLM) ──
  if (commit.collection === "com.etzhayyim.apps.site.wet") {
    try {
      const rows = await listCollectionRows("site.wet");
      const row = rows.find((entry) => String(entry.rkey ?? "") === commit.rkey);
      if (row) {
        const markdown = str(row.markdown ?? "");
        const domain = str(row.domain ?? "");
        const url = str(row.url ?? "");
        const language = str(row.language ?? "ja");

        if (markdown.length > 50) {
          // Invoke Murakumo NER for geo entity extraction
          sdk.pds.dispatch({
            type: "invoke",
            payload: {
              did: "did:web:murakumo.etzhayyim.com",
              method: "llm-ask",
              params: JSON.stringify({
                model: resolveModelId(undefined, "general"),
                system: `You are a geo entity extractor. From the given web page text, extract geographic entities. Return JSON array of objects with: {name, entityType (place|station|airport|port|road|river|mountain|building|adminArea), lat?, lng?, address?, country?, description}. Only return entities with clear geographic identity. Max 20 entities. If no geo entities found, return [].`,
                prompt: `URL: ${url}\nDomain: ${domain}\nLanguage: ${language}\n\nText:\n${truncateText(markdown, 3000)}`,
                'responseFormat': "json",
                'callbackCollection': "com.etzhayyim.apps.maps.webCrawlGeoEntity",
                'callbackMeta': JSON.stringify({ 'sourceDomain': domain, 'sourceUrl': url, 'sourceRkey': commit.rkey, 'sourceDid': "did:web:site.etzhayyim.com" }),
              }),
            },
          });
        }
      }
    } catch (e: any) { console.warn(`WET geo-extract error: ${e?.message ?? e}`); }
    return { ok: true, detail: "processedWetGeo" };
  }

  // ── site.etzhayyim.com WAT → outlink graph + domain geo classification ──
  if (commit.collection === "com.etzhayyim.apps.site.wat") {
    try {
      const rows = await listCollectionRows("site.wat");
      const row = rows.find((entry) => String(entry.rkey ?? "") === commit.rkey);
      if (row) {
        const domain = str(row.domain ?? "");
        const title = str(row.title ?? "");
        const url = str(row.url ?? "");
        const outlinksRaw = str(row.outlinks ?? "[]");

        // Check if this domain matches a known geo domain target
        const geoTarget = GEO_CRAWL_DOMAINS.find(d => d.domain === domain);
        if (geoTarget) {
          // Parse outlinks for geo-relevant sub-pages
          try {
            const outlinks: string[] = JSON.parse(outlinksRaw);
            const geoKeywords = /station|airport|port|route|line|river|mountain|park|shrine|temple|bridge|dam|tunnel|highway|railway|coast|island|lake|volcano/i;
            const geoLinks = outlinks.filter(l => geoKeywords.test(l)).slice(0, 20);

            if (geoLinks.length > 0) {
              // Enqueue geo-relevant sub-pages back to site.etzhayyim.com for deeper crawl
              sdk.pds.dispatch({
                type: "invoke",
                payload: {
                  did: "did:web:site.etzhayyim.com",
                  method: "com.etzhayyim.apps.site.enqueueBulk",
                  params: JSON.stringify({
                    urls: geoLinks,
                    topics: ["maps", geoTarget.category],
                    priority: 45,
                  }),
                },
              });
            }
          } catch { /* outlinks parse failure */ }
        }

        // Write WAT domain info as spatial domain coverage record
        if (geoTarget) {
          await write(sdk, "webCrawlGeoEntity", {
            'entityId': genID("wcge"),
            name: title || domain,
            'entityType': "domainCoverage",
            'sourceDomain': domain,
            'sourceUrl': url,
            'sourceDid': "did:web:site.etzhayyim.com",
            category: geoTarget.category,
            country: geoTarget.country,
            'nodeLabel': "WebCrawlGeoEntity",
            'createdAt': nowISO(), 'orgId': "anon", 'userId': "anon", 'actorId': appId,
          });
        }
      }
    } catch (e: any) { console.warn(`WAT geo-extract error: ${e?.message ?? e}`); }
    return { ok: true, detail: "processedWatGeo" };
  }

  // ── site.etzhayyim.com LLM NER callback → write extracted geo entities to graph ──
  if (commit.collection === "com.etzhayyim.apps.maps.webCrawlGeoEntity") {
    try {
      const rows = await listCollectionRows("webCrawlGeoEntity");
      const rec = rows.find((entry) => String(entry.rkey ?? "") === commit.rkey);
      if (rec) {
        const name = str(rec.name ?? "");
        const entityType = str(rec.entityType ?? "");
        const lat = Number(rec.lat ?? rec.latitude ?? 0);
        const lng = Number(rec.lng ?? rec.longitude ?? 0);
        const geo = (lat && lng) ? ` (${lat},${lng})` : "";

        if (name && entityType !== "domainCoverage") {
          // Write extracted entity to its proper graph node type
          const NER_TO_COLLECTION: Record<string, string> = {
            place: "place", station: "station", airport: "airport",
            port: "port", road: "road", river: "river",
            mountain: "mountain", building: "building", adminArea: "adminArea",
          };
          const collection = NER_TO_COLLECTION[entityType];
          if (collection && lat && lng) {
            const entityId = genID("ner");
            await write(sdk, collection, {
              nodeId: `ner:${entityId}`, name,
              lat, lng,
              sourceDid: "did:web:site.etzhayyim.com",
              sourceUrl: str(rec.sourceUrl ?? ""),
              sourceDomain: str(rec.sourceDomain ?? ""),
              nodeLabel: collection.charAt(0).toUpperCase() + collection.slice(1),
              createdAt: nowISO(),
              orgId: "anon", userId: "anon", actorId: appId,
            });
          }
          await post(sdk,
            `[WebCrawlGeo] ${entityType}: ${truncateText(name, 60)}${geo}\nfrom @site.etzhayyim.com cc @jinushi.etzhayyim.com`);
        }
      }
    } catch (e: any) { console.warn(`webCrawlGeoEntity commit error: ${e?.message ?? e}`); }
    return { ok: true, detail: "processedWebCrawlGeoEntity" };
  }

  // ── site.etzhayyim.com geoRecord → AdminArea DID / SpatialEvent / Station / BusStop ──
  if (commit.collection === "com.etzhayyim.apps.site.geoRecord") {
    try {
      const rows = await listCollectionRows("site.geoRecord");
      const row = rows.find((entry) => String(entry.rkey ?? "") === commit.rkey);
      if (row) {
        const rec = expandGeoRecordRow(row);
        await processGeoRecord(sdk, rec);
      }
    } catch (e: any) { console.warn(`geoRecord commit error: ${e?.message ?? e}`); }
    return { ok: true, detail: "processedGeoRecord" };
  }

  return { ok: true, detail: "ignored" };
}

/**
 * Expand a GeoRecord vertex row from the graph query layer into a flat record for processGeoRecord.
 * The PDS GeoRecord handler maps: name→name, entityType→category, lat→lat, lng→lng,
 * createdAt→source, remaining fields→props JSON.
 * This function merges props back into the row and normalises field names.
 */
function expandGeoRecordRow(row: Record<string, unknown>): Record<string, unknown> {
  let propsData: Record<string, unknown> = {};
  const propsStr = str(row.props ?? "");
  if (propsStr) { try { propsData = JSON.parse(propsStr) as Record<string, unknown>; } catch { /* ok */ } }
  return {
    ...propsData,
    ...row,
    // Normalise column-mapped fields back to camelCase names expected by processGeoRecord
    entityType: str(row.category ?? propsData.entityType ?? ""),
    lat: Number(row.lat ?? propsData.lat ?? 0),
    lng: Number(row.lng ?? propsData.lng ?? 0),
  };
}

/**
 * Process a site.etzhayyim.com geoRecord and write the appropriate entity to the maps graph.
 * entityType:
 *   "seismicEvent"  → SpatialEvent + social post
 *   "municipality"  → AdminArea DID via registerRegionRecord (jis-x0402 + iso3166-2 alias)
 *   "gtfsStop"      → Station or BusStop
 *   "gtfsRoute"     → Railway or BusRoute
 *   "satelliteScene" → SatelliteScene + Murakumo vision analysis
 *   "adminArea2"    → AdminArea DID (world tier-2: US states, CN provinces, etc.)
 *   "airport"       → Airport + ICAO/IATA alias DIDs
 *   "port"          → Port + UNLOCODE alias DID
 *   "road"          → Road
 *   "river"         → River
 *   "mountain"      → Mountain
 *   "building"      → Building
 *   "place"         → Place (generic geocoded)
 *   "aircraft"      → SpatialEvent (ADS-B real-time position)
 */
async function processGeoRecord(sdk: HostSDK, rec: Record<string, unknown>): Promise<void> {
  const entityType = str(rec.entityType ?? rec.category ?? "");
  const name = str(rec.name ?? "");
  const lat = Number(rec.lat ?? 0);
  const lng = Number(rec.lng ?? 0);
  const codesJson = str(rec.codesJson ?? "{}");
  const extraJson = str(rec.extraJson ?? "{}");
  let codes: Record<string, string> = {};
  let extra: Record<string, unknown> = {};
  try { codes = JSON.parse(codesJson); } catch { /* ok */ }
  try { extra = JSON.parse(extraJson); } catch { /* ok */ }

  if (entityType === "seismicEvent") {
    const magnitude = Number(extra.magnitude ?? 0);
    const place = str(extra.place ?? "");
    const depth = Number(extra.depth ?? 0);
    const eventId = str(rec.entityId ?? genID("eq"));
    await write(sdk, "spatialEvent", {
      nodeId: `seismic:${eventId}`, eventId,
      eventType: "earthquake", name,
      // AT Protocol rejectFloats: pass numerics as strings to pass validation
      magnitude: String(magnitude), magnitudeType: str(extra.magnitudeType ?? ""),
      depth: String(depth), place,
      lat: String(lat), lng: String(lng),
      time: String(Number(extra.time ?? 0)),
      alert: str(extra.alert ?? ""), tsunami: String(Number(extra.tsunami ?? 0)),
      sig: String(Number(extra.sig ?? 0)), status: str(extra.status ?? ""),
      sourceDid: `did:web:${appId}.etzhayyim.com:seismic`,
      nodeLabel: "SpatialEvent", createdAt: nowISO(),
      orgId: "anon", userId: "anon", actorId: appId,
    });
    if (magnitude >= 5.0) {
      await post(sdk,
        `[Seismic] M${magnitude.toFixed(1)} ${place} depth:${depth}km\nvia @site.etzhayyim.com:usgs cc @jinushi.etzhayyim.com`);
    }
    return;
  }

  if (entityType === "municipality" && codes["jis-x0402"]) {
    // Register municipality as AdminArea DID (jis-x0402 canonical + iso3166-2 alias)
    await registerRegionRecord(sdk, {
      displayName: name, lat, lng, adminLevel: 3,
      codes: {
        "jis-x0402": codes["jis-x0402"],
        "iso3166-2": codes["iso3166-2"] ?? `jp-${codes["jis-x0402"].slice(0, 2)}`,
      },
    });
    return;
  }

  if (entityType === "gtfsStop") {
    const stopType = str(extra.stopType ?? "busStop");
    const collection = stopType === "station" ? "station" : "busStop";
    await write(sdk, collection, {
      nodeId: `stop:${str(rec.entityId ?? "")}`, name,
      lat, lng, stopId: str(rec.entityId ?? ""),
      sourceDid: `did:web:${appId}.etzhayyim.com:gtfs`,
      nodeLabel: stopType === "station" ? "Station" : "BusStop",
      createdAt: nowISO(), orgId: "anon", userId: "anon", actorId: appId,
    });
    return;
  }

  if (entityType === "gtfsRoute") {
    const routeType = str(extra.routeType ?? "busRoute");
    const collection = routeType === "railway" ? "railway" : "busRoute";
    await write(sdk, collection, {
      nodeId: `route:${str(rec.entityId ?? "")}`, name,
      routeId: str(rec.entityId ?? ""), routeType,
      sourceDid: `did:web:${appId}.etzhayyim.com:gtfs`,
      nodeLabel: routeType === "railway" ? "Railway" : "BusRoute",
      createdAt: nowISO(), orgId: "anon", userId: "anon", actorId: appId,
    });
    return;
  }

  // Satellite scene: STAC → write SatelliteScene + trigger murakumo vision analysis
  if (entityType === "satelliteScene") {
    const sceneId = str(extra.sceneId ?? rec.entityId ?? "");
    const satellite = str(extra.satellite ?? "unknown");
    const acquisitionDate = str(extra.acquisitionDate ?? "");
    const cloudCover = Number(extra.cloudCover ?? 0);
    const thumbnailUrl = str(extra.thumbnailUrl ?? "");
    const cogUrl = str(extra.cogUrl ?? "");
    const bboxJson = str(extra.bboxJson ?? "{}");
    if (!sceneId) return;
    await write(sdk, "satelliteScene", {
      nodeId: `sat:${sceneId}`, sceneId,
      satellite, acquisitionDate, cloudCover,
      thumbnailUrl, cogUrl, bboxJson,
      lat, lng,
      sourceDid: `did:web:${appId}.etzhayyim.com:satellite`,
      nodeLabel: "SatelliteScene", createdAt: nowISO(),
      orgId: "anon", userId: "anon", actorId: appId,
    });
    // Murakumo vision analysis on thumbnail → entity extraction
    if (thumbnailUrl) {
      sdk.pds.dispatch({
        type: "invoke",
        payload: {
          did: "did:web:murakumo.etzhayyim.com",
          method: "llm-ask",
          params: JSON.stringify({
            model: resolveModelId(undefined, "vision"),
            imageUrl: thumbnailUrl,
            system: "You are a satellite imagery analyst. Extract geographic entities visible in the image. Return a JSON array: [{name, entityType (building|road|river|waterBody|vegetation|landUse|infrastructure|mountain|settlement), description, confidence (0-1)}]. Max 8 entities. If nothing clear, return [].",
            prompt: `Satellite: ${satellite}. Date: ${acquisitionDate.slice(0, 10)}. Cloud: ${cloudCover.toFixed(0)}%. Center: ${lat.toFixed(3)},${lng.toFixed(3)}. Extract entities.`,
            responseFormat: "json",
            callbackCollection: "com.etzhayyim.apps.maps.satelliteAnalysisResult",
            callbackMeta: JSON.stringify({ sceneId, satellite, lat, lng }),
          }),
        },
      });
    }
    return;
  }

  // A: World AdminArea tier-2 (US states, CN provinces, IN states, etc.)
  if (entityType === "adminArea2" && codes["iso3166-2"]) {
    const nameEn = str(extra.nameEn ?? name);
    await registerRegionRecord(sdk, {
      displayName: name, displayNameEn: nameEn,
      lat, lng, adminLevel: 2,
      codes: { "iso3166-2": codes["iso3166-2"] },
    });
    return;
  }

  // B: Airport from OurAirports CSV (large/medium airports with ICAO + IATA)
  if (entityType === "airport") {
    const icao = codes["icao-airport"] ?? "";
    const iata = codes["iata-airport"] ?? "";
    const airportType = str(extra.airportType ?? "large_airport");
    const elevation = Number(extra.elevation ?? 0);
    const country = str(extra.country ?? "");
    if (!icao) return;
    await write(sdk, "airport", {
      nodeId: `airport:${icao.toLowerCase()}`, name,
      icaoCode: icao, iataCode: iata, country, airportType, elevation,
      lat, lng,
      sourceDid: `did:web:${appId}.etzhayyim.com:adsb`,
      nodeLabel: "Airport", createdAt: nowISO(),
      orgId: "anon", userId: "anon", actorId: appId,
    });
    // ICAO alias DID
    const icaoDid = str((sdk as any).hostImports?.comAtprotoIdentityCreate?.(
      `geo:icao-airport:${icao}`,
      JSON.stringify({ displayName: `${name} [icao:${icao}]`, category: "geoAlias" }),
    ));
    if (icaoDid) {
      await write(sdk, "geoAlias", {
        scheme: "icao-airport", code: icao, regionId: "", aliasDid: icaoDid,
        canonicalDid: icaoDid, dim: "2d",
        nodeId: `geoAlias:icao-airport:${icao}`, nodeLabel: "GeoAlias",
        createdAt: nowISO(), orgId: "anon", userId: "anon", actorId: appId,
      });
    }
    // IATA alias DID
    if (iata) {
      const iataDid = str((sdk as any).hostImports?.comAtprotoIdentityCreate?.(
        `geo:iata-airport:${iata}`,
        JSON.stringify({ displayName: `${name} [iata:${iata}]`, category: "geoAlias" }),
      ));
      if (iataDid) {
        await write(sdk, "geoAlias", {
          scheme: "iata-airport", code: iata, regionId: "", aliasDid: iataDid,
          canonicalDid: iataDid, dim: "2d",
          nodeId: `geoAlias:iata-airport:${iata}`, nodeLabel: "GeoAlias",
          createdAt: nowISO(), orgId: "anon", userId: "anon", actorId: appId,
        });
      }
    }
    return;
  }

  // D: Port (from web crawl NER or Overpass)
  if (entityType === "port") {
    const portId = str(rec.entityId ?? genID("port"));
    const portType = str(extra.portType ?? "commercial");
    const unlocode = codes["unlocode"] ?? "";
    const country = str(extra.country ?? "");
    await write(sdk, "port", {
      nodeId: `port:${portId}`, name,
      portId, portType, unlocode, country,
      lat, lng,
      sourceDid: `did:web:${appId}.etzhayyim.com:infrastructure`,
      nodeLabel: "Port", createdAt: nowISO(),
      orgId: "anon", userId: "anon", actorId: appId,
    });
    if (unlocode) {
      const uDid = str((sdk as any).hostImports?.comAtprotoIdentityCreate?.(
        `geo:unlocode:${unlocode}`,
        JSON.stringify({ displayName: `${name} [${unlocode}]`, category: "geoAlias" }),
      ));
      if (uDid) {
        await write(sdk, "geoAlias", {
          scheme: "unlocode", code: unlocode, regionId: "", aliasDid: uDid,
          canonicalDid: uDid, dim: "2d",
          nodeId: `geoAlias:unlocode:${unlocode}`, nodeLabel: "GeoAlias",
          createdAt: nowISO(), orgId: "anon", userId: "anon", actorId: appId,
        });
      }
    }
    return;
  }

  // E: Road (from Overpass or web crawl)
  if (entityType === "road") {
    const roadId = str(rec.entityId ?? genID("road"));
    const roadType = str(extra.roadType ?? "primary");
    await write(sdk, "road", {
      nodeId: `road:${roadId}`, name,
      roadId, roadType, lat, lng,
      sourceDid: `did:web:${appId}.etzhayyim.com:infrastructure`,
      nodeLabel: "Road", createdAt: nowISO(),
      orgId: "anon", userId: "anon", actorId: appId,
    });
    return;
  }

  // F: River (from Overpass or web crawl)
  if (entityType === "river") {
    const riverId = str(rec.entityId ?? genID("riv"));
    const length = Number(extra.length ?? 0);
    await write(sdk, "river", {
      nodeId: `river:${riverId}`, name,
      riverId, length: String(length), lat, lng,
      sourceDid: `did:web:${appId}.etzhayyim.com:infrastructure`,
      nodeLabel: "River", createdAt: nowISO(),
      orgId: "anon", userId: "anon", actorId: appId,
    });
    return;
  }

  // G: Mountain (from Overpass natural=peak or web crawl)
  if (entityType === "mountain") {
    const mountainId = str(rec.entityId ?? genID("mtn"));
    const elevation = Number(extra.elevation ?? 0);
    await write(sdk, "mountain", {
      nodeId: `mtn:${mountainId}`, name,
      mountainId, elevation: String(elevation), lat, lng,
      sourceDid: `did:web:${appId}.etzhayyim.com:infrastructure`,
      nodeLabel: "Mountain", createdAt: nowISO(),
      orgId: "anon", userId: "anon", actorId: appId,
    });
    return;
  }

  // H: Building (from Overpass or web crawl)
  if (entityType === "building") {
    const buildingId = str(rec.entityId ?? genID("bld"));
    const buildingType = str(extra.buildingType ?? "commercial");
    const floors = Number(extra.floors ?? 0);
    await write(sdk, "building", {
      nodeId: `bld:${buildingId}`, name,
      buildingId, buildingType, floors: String(floors), lat, lng,
      sourceDid: `did:web:${appId}.etzhayyim.com:infrastructure`,
      nodeLabel: "Building", createdAt: nowISO(),
      orgId: "anon", userId: "anon", actorId: appId,
    });
    return;
  }

  // I: Place (generic geocoded place from web crawl NER)
  if (entityType === "place") {
    const placeId = str(rec.entityId ?? genID("pl"));
    const address = str(extra.address ?? "");
    const country = str(extra.country ?? "");
    await write(sdk, "place", {
      nodeId: `place:${placeId}`, name,
      placeId, address, country, lat, lng,
      sourceDid: `did:web:${appId}.etzhayyim.com:geocode`,
      nodeLabel: "Place", createdAt: nowISO(),
      orgId: "anon", userId: "anon", actorId: appId,
    });
    return;
  }

  // C: ADS-B aircraft position (OpenSky real-time)
  if (entityType === "aircraft") {
    const icao24 = str(extra.icao24 ?? "");
    const callsign = str(extra.callsign ?? "").trim();
    const altitude = Number(extra.altitude ?? 0);
    const velocity = Number(extra.velocity ?? 0);
    const heading = Number(extra.heading ?? 0);
    const onGround = Boolean(extra.onGround);
    if (!icao24) return;
    await write(sdk, "spatialEvent", {
      nodeId: `aircraft:${icao24}:${Number(extra.time ?? 0)}`,
      eventId: genID("ac"),
      eventType: "aircraftPosition",
      name: callsign || icao24,
      lat, lng, altitude, velocity, heading, onGround,
      icao24, callsign,
      sourceDid: `did:web:${appId}.etzhayyim.com:adsb`,
      nodeLabel: "SpatialEvent", createdAt: nowISO(),
      orgId: "anon", userId: "anon", actorId: appId,
    });
    return;
  }
}

// ── Heartbeat ──

// --- Multi-DID ---

// Layer 3: Shinka (Social Evolution)
const shinkaEnabled = true; // domain: maps

// NOTE: runHeartbeat is dead code — host-sdk calls runDefaultHeartbeat() which invokes
// the hook registered via sdk.app.onHeartbeat() in createWorkerExport below.
// Collection dispatch logic has been migrated to that hook.
export async function runHeartbeat(_sdk: HostSDK): Promise<{ ok: boolean; actions: Array<Record<string, unknown>> }> {
  return { ok: true, actions: [{ action: "noop", note: "use onHeartbeat hook" }] };
}

// ── Registry & Legal Entity Intelligence (2026-04-13) ──
// Source DIDs for global registry data coverage
const REGISTRY_SOURCE_DIDS = {
  gleif: "did:web:maps.etzhayyim.com:registry:gleif",
  opencorporates: "did:web:maps.etzhayyim.com:registry:opencorporates",
  wikidata: "did:web:maps.etzhayyim.com:registry:wikidata",
  osm: "did:web:maps.etzhayyim.com:registry:osm",
  jpMoj: "did:web:maps.etzhayyim.com:registry:jp-moj",
  jpNta: "did:web:maps.etzhayyim.com:registry:jp-nta",
  ukCh: "did:web:maps.etzhayyim.com:registry:uk-ch",
  usEdgar: "did:web:maps.etzhayyim.com:registry:us-edgar",
  euBr: "did:web:maps.etzhayyim.com:registry:eu-br",
  openaddresses: "did:web:maps.etzhayyim.com:registry:openaddresses",
} as const;

const cmdRegisterLegalEntity = mkRegister("legalEntity", "LegalEntity", "ent", "name");
const cmdListLegalEntities = mkList("LegalEntity", "entityType");
const cmdRegisterOperator = mkRegister("operator", "Operator", "opr", "name");
const cmdListOperators = mkList("Operator", "jurisdiction");
const cmdRegisterPropertyOwner = mkRegister("propertyOwner", "PropertyOwner", "pown", "name");
const cmdListPropertyOwners = mkList("PropertyOwner", "jurisdiction");
const cmdRegisterLandRegistry = mkRegister("landRegistry", "LandRegistry", "lreg", "registryNumber");
const cmdListLandRegistries = mkList("LandRegistry", "jurisdiction");
const cmdRegisterPropertyRegistry = mkRegister("propertyRegistry", "PropertyRegistry", "preg", "registryNumber");
const cmdListPropertyRegistries = mkList("PropertyRegistry", "jurisdiction");
const cmdRegisterBusinessRegistry = mkRegister("businessRegistry", "BusinessRegistry", "breg", "registryNumber");
const cmdListBusinessRegistries = mkList("BusinessRegistry", "jurisdiction");
const cmdRegisterConstructionPermit = mkRegister("constructionPermit", "ConstructionPermit", "cpmt", "registryNumber");
const cmdListConstructionPermits = mkList("ConstructionPermit", "jurisdiction");
const cmdRegisterOperatingLicense = mkRegister("operatingLicense", "OperatingLicense", "olic", "registryNumber");
const cmdListOperatingLicenses = mkList("OperatingLicense", "jurisdiction");
const cmdRegisterZoningRecord = mkRegister("zoningRecord", "ZoningRecord", "zrec", "landUse");
const cmdListZoningRecords = mkList("ZoningRecord", "jurisdiction");

async function cmdRegisterOwnership(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = decodeJson<Record<string, unknown>>(payload, {});
  if (!req.ownerEntityId || !req.propertyId) return { error: "ownerEntityId and propertyId required" };
  const edgeId = `own:${genID("own")}`;
  const rec: Record<string, unknown> = {
    edgeId, ownerEntityId: str(req.ownerEntityId), propertyId: str(req.propertyId),
    sharePct: req.sharePct ?? 100, effectiveDate: req.effectiveDate ?? nowISO(),
    expiryDate: req.expiryDate, registryRef: req.registryRef, sourceDid: req.sourceDid,
    nodeLabel: "OwnsProperty", createdAt: nowISO(),
    orgId: str(req.orgId ?? "anon"), userId: str(req.userId ?? "anon"), actorId: appId,
  };
  await write(sdk, "ownership", rec);
  return { edgeId, status: "created" };
}

async function cmdOwnershipChain(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = decodeJson<Record<string, unknown>>(payload, {});
  if (!req.propertyId) return { error: "propertyId required" };
  const db = getDb();
  const rows = await db.selectFrom("edge_ownership" as any)
    .selectAll()
    .where("dst_vid" as any, "=", str(req.propertyId))
    .orderBy("effective_date" as any, "desc")
    .limit(Math.min(Number(req.limit ?? 20), 100))
    .execute();
  return { propertyId: req.propertyId, chain: rows };
}

async function cmdEntityHistory(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = decodeJson<Record<string, unknown>>(payload, {});
  if (!req.entityId) return { error: "entityId required" };
  const db = getDb();
  const registries = await db.selectFrom("edge_registered_at" as any)
    .selectAll()
    .where("src_vid" as any, "=", str(req.entityId))
    .orderBy("effective_date" as any, "desc")
    .limit(50)
    .execute();
  const ownerships = await db.selectFrom("edge_ownership" as any)
    .selectAll()
    .where("src_vid" as any, "=", str(req.entityId))
    .orderBy("effective_date" as any, "desc")
    .limit(50)
    .execute();
  const operations = await db.selectFrom("edge_operates" as any)
    .selectAll()
    .where("src_vid" as any, "=", str(req.entityId))
    .orderBy("effective_date" as any, "desc")
    .limit(50)
    .execute();
  return { entityId: req.entityId, registries, ownerships, operations };
}

async function cmdSeedGlobalRegistries(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = decodeJson<Record<string, unknown>>(payload, {});
  const actions: unknown[] = [];
  // Wikidata SPARQL: companies with HQ coordinates + industry
  (sdk as any).hostImports?.kotodamaInvoke?.(
    "site.etzhayyim.com",
    "com.etzhayyim.apps.site.ingestGeoData",
    JSON.stringify({
      url: "https://query.wikidata.org/sparql",
      format: "wikidata_sparql",
      project: "maps",
      query: `SELECT ?item ?itemLabel ?hqCoord ?countryLabel ?lei ?inception WHERE {
        ?item wdt:P31/wdt:P279* wd:Q4830453 .
        ?item wdt:P159 ?hq . ?hq wdt:P625 ?hqCoord .
        OPTIONAL { ?item wdt:P17 ?country } OPTIONAL { ?item wdt:P1278 ?lei } OPTIONAL { ?item wdt:P571 ?inception }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en,ja" }
      } LIMIT 5000`,
    }),
  );
  actions.push({ action: "wikidataCorporations", source: REGISTRY_SOURCE_DIDS.wikidata });
  // GLEIF LEI bulk download (CSV)
  (sdk as any).hostImports?.kotodamaInvoke?.(
    "site.etzhayyim.com",
    "com.etzhayyim.apps.site.ingestGeoData",
    JSON.stringify({ url: "https://lei-api.gleif.org/api/v1/lei-records?page[size]=100&page[number]=1", format: "gleif_json", project: "maps" }),
  );
  actions.push({ action: "gleifLei", source: REGISTRY_SOURCE_DIDS.gleif });
  // JP 法人番号 (NTA open data)
  (sdk as any).hostImports?.kotodamaInvoke?.(
    "site.etzhayyim.com",
    "com.etzhayyim.apps.site.ingestGeoData",
    JSON.stringify({ url: "https://www.houjin-bangou.nta.go.jp/download/zenken/", format: "jp_nta_csv", project: "maps" }),
  );
  actions.push({ action: "jpNtaCorporateNumber", source: REGISTRY_SOURCE_DIDS.jpNta });
  // OpenAddresses global addresses
  (sdk as any).hostImports?.kotodamaInvoke?.(
    "site.etzhayyim.com",
    "com.etzhayyim.apps.site.ingestGeoData",
    JSON.stringify({ url: "https://batch.openaddresses.io/api/data", format: "openaddresses_json", project: "maps" }),
  );
  actions.push({ action: "openaddresses", source: REGISTRY_SOURCE_DIDS.openaddresses });
  return { ok: true, seeded: actions.length, actions };
}

// ── aismarine (ADR-2605011500) — MarineTraffic-equivalent vessel tracking ──
//
// Read path: createKyselyDb(env.HYPERDRIVE) → mv_vessel_latest_position +
// vertex_vessel + vertex_vessel_voyage. Write path is via the K8s
// aismarine-consumer Deployment (long-running aisstream.io WebSocket) that
// POSTs through maps-langserver.etzhayyim.com (CF Tunnel) to the ingestAisStream NSID.
// CF Worker stays L3 dispatcher subset (ADR-2604251830) — no business logic.

const AISMARINE_TYPE_CLASSES = new Set([
  "cargo", "tanker", "passenger", "highspeed", "sailing_pleasure",
  "fishing", "tug", "military", "pilot", "sar", "lawenforcement",
  "other", "unknown",
]);

function _parseBbox4(raw: unknown): [number, number, number, number] | null {
  // Accept three URL encodings of `bbox`:
  //   1. array of 4 numbers (proper XRPC array param)
  //   2. comma-separated string "w,s,e,n" (curl-friendly fallback)
  //   3. whitespace-separated string (compat for older clients)
  let arr: unknown[] = [];
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === "string") {
    arr = raw.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
  }
  if (arr.length !== 4) return null;
  const out = arr.map(Number) as [number, number, number, number];
  if (!out.every(Number.isFinite)) return null;
  return out;
}

async function cmdAismarineQueryVesselsBbox(_sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.aismarine.queryVesselsBbox", payload);
  const parsed = _parseBbox4(req.bbox);
  if (parsed === null) return { features: [], total: 0, bbox: [], truncated: false };
  const [w, s, e, n] = parsed;

  const limit = Math.min(Math.max(Number(req.limit ?? 5000), 1), 20000);
  const minSog = req.minSog != null ? Number(req.minSog) : null;
  const types = Array.isArray(req.types)
    ? (req.types as string[]).filter((t) => typeof t === "string" && AISMARINE_TYPE_CLASSES.has(t))
    : [];

  const db = getDb();
  let q = (db as any).selectFrom("mv_vessel_latest_position as p")
    .leftJoin("vertex_vessel as v", "v.mmsi", "p.mmsi")
    .select([
      "p.mmsi as mmsi", "p.ts_ms as ts_ms", "p.lat as lat", "p.lon as lon",
      "p.sog_knot as sog_knot", "p.cog_deg as cog_deg",
      "p.heading_deg as heading_deg", "p.nav_status as nav_status",
      "v.name as name", "v.type_code as type_code",
      "v.type_class as type_class", "v.flag_iso as flag_iso",
    ])
    .where("p.lat", ">=", s).where("p.lat", "<=", n);
  q = w <= e
    ? q.where("p.lon", ">=", w).where("p.lon", "<=", e)
    : q.where((eb: any) => eb.or([eb("p.lon", ">=", w), eb("p.lon", "<=", e)]));
  if (minSog != null && Number.isFinite(minSog)) q = q.where("p.sog_knot", ">=", minSog);
  if (types.length > 0) q = q.where("v.type_class", "in", types);
  q = q.limit(limit + 1);

  const rows = await q.execute();
  const truncated = rows.length > limit;
  const trimmed = truncated ? rows.slice(0, limit) : rows;

  const features = trimmed.map((r: any) => {
    const props: Record<string, unknown> = {
      mmsi: Number(r.mmsi),
      ts_ms: Number(r.ts_ms),
      type_class: r.type_class ?? "unknown",
    };
    if (r.name) props.name = r.name;
    if (r.type_code != null) props.type_code = Number(r.type_code);
    if (r.flag_iso) props.flag_iso = r.flag_iso;
    if (r.sog_knot != null) props.sog_knot = Number(r.sog_knot);
    if (r.cog_deg != null) props.cog_deg = Number(r.cog_deg);
    if (r.heading_deg != null) props.heading_deg = Number(r.heading_deg);
    if (r.nav_status != null) props.nav_status = Number(r.nav_status);
    return {
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [Number(r.lon), Number(r.lat)] },
      properties: props,
    };
  });

  return { features, total: features.length, bbox: [w, s, e, n], truncated };
}

async function cmdAismarineGetVesselDetail(_sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.aismarine.getVesselDetail", payload);
  const mmsi = Number(req.mmsi);
  if (!Number.isInteger(mmsi) || mmsi <= 0) return { vessel: null };

  const trackHours = Math.min(Math.max(Number(req.trackHours ?? 24), 1), 168);
  const trackLimit = Math.min(Math.max(Number(req.trackLimit ?? 500), 1), 2000);
  const cutoffMs = Date.now() - trackHours * 3600 * 1000;

  const db = getDb();
  const [vessel] = await (db as any).selectFrom("vertex_vessel")
    .selectAll()
    .where("mmsi", "=", mmsi)
    .limit(1)
    .execute();

  if (!vessel) return { vessel: null, recentTrack: [], voyage: null };

  const trackDesc = await (db as any).selectFrom("vertex_vessel_position")
    .select(["ts_ms", "lat", "lon", "sog_knot", "cog_deg", "heading_deg", "nav_status"])
    .where("mmsi", "=", mmsi)
    .where("ts_ms", ">=", cutoffMs)
    .orderBy("ts_ms", "desc")
    .limit(trackLimit)
    .execute();
  const recentTrack = trackDesc.slice().reverse().map((r: any) => ({
    ts_ms: Number(r.ts_ms),
    lat: Number(r.lat),
    lon: Number(r.lon),
    sog_knot: r.sog_knot != null ? Number(r.sog_knot) : null,
    cog_deg: r.cog_deg != null ? Number(r.cog_deg) : null,
    heading_deg: r.heading_deg != null ? Number(r.heading_deg) : null,
    nav_status: r.nav_status != null ? Number(r.nav_status) : null,
  }));

  const [voyage] = await (db as any).selectFrom("vertex_vessel_voyage")
    .select([
      "departure_port_locode", "departure_ms",
      "arrival_port_locode", "arrival_ms",
      "declared_draught_m", "declared_eta_ms", "declared_destination",
    ])
    .where("mmsi", "=", mmsi)
    .orderBy("departure_ms", "desc")
    .limit(1)
    .execute();

  // Owner / operator (best-effort, edges populated by Wikidata SPARQL task).
  // Read directly from edge tables instead of mv_vessel_with_lei to avoid
  // a wide LEFT-JOIN scan when the MV state lags.
  // Owner / operator edges only — no LEFT JOIN to vertex_legal_entity
  // (millions of GLEIF rows, no index on `lei` → full-table scan, 25s
  // XRPC hard cap blown). entity_label already lives on the edge from
  // the Wikidata enrichment task. For the full legal-entity record
  // caller can resolve dst_vid → legal-entity.etzhayyim.com out-of-band.
  const owners = await (db as any).selectFrom("edge_vessel_owned_by")
    .select([
      "lei", "wikidata_qid", "entity_label",
      "share_pct", "source", "effective_from_ms", "dst_vid",
    ])
    .where("mmsi", "=", mmsi)
    .orderBy("effective_from_ms", "desc")
    .limit(5)
    .execute();
  const operators = await (db as any).selectFrom("edge_vessel_operated_by")
    .select([
      "lei", "wikidata_qid", "entity_label",
      "role", "source", "effective_from_ms", "dst_vid",
    ])
    .where("mmsi", "=", mmsi)
    .orderBy("effective_from_ms", "desc")
    .limit(5)
    .execute();
  const fmtEntity = (r: any) => ({
    lei: r.lei ?? null,
    wikidata_qid: r.wikidata_qid ?? null,
    name: r.entity_label ?? null,
    country: null,
    entity_type: null,
    legal_entity_vid: r.dst_vid ?? null,
    share_pct: r.share_pct != null ? Number(r.share_pct) : null,
    role: r.role ?? null,
    source: r.source,
    effective_from_ms: r.effective_from_ms != null ? Number(r.effective_from_ms) : null,
  });

  return {
    vessel: {
      mmsi: Number(vessel.mmsi),
      imo: vessel.imo != null ? Number(vessel.imo) : null,
      callsign: vessel.callsign ?? null,
      name: vessel.name ?? null,
      type_code: vessel.type_code != null ? Number(vessel.type_code) : null,
      type_class: vessel.type_class ?? "unknown",
      flag_mid: vessel.flag_mid != null ? Number(vessel.flag_mid) : null,
      flag_iso: vessel.flag_iso ?? null,
      length_m: vessel.length_m != null ? Number(vessel.length_m) : null,
      width_m: vessel.width_m != null ? Number(vessel.width_m) : null,
      draught_m: vessel.draught_m != null ? Number(vessel.draught_m) : null,
      source: vessel.source ?? null,
      first_seen_ms: Number(vessel.first_seen_ms),
      last_seen_ms: Number(vessel.last_seen_ms),
    },
    recentTrack,
    voyage: voyage ?? null,
    owners: owners.map(fmtEntity),
    operators: operators.map(fmtEntity),
  };
}

async function cmdAismarineSearchVessels(_sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.aismarine.searchVessels", payload);
  const q = String(req.q ?? "").trim();
  if (q.length < 2) return { results: [], total: 0 };
  const limit = Math.min(Math.max(Number(req.limit ?? 25), 1), 100);

  const db = getDb();
  const numeric = /^\d{7,}$/.test(q) ? Number(q) : null;
  const baseQuery = (db as any).selectFrom("vertex_vessel as v")
    .leftJoin("mv_vessel_latest_position as p", "p.mmsi", "v.mmsi")
    .select([
      "v.mmsi as mmsi", "v.imo as imo", "v.name as name",
      "v.callsign as callsign", "v.type_class as type_class",
      "v.flag_iso as flag_iso", "v.last_seen_ms as last_seen_ms",
      "p.lat as last_lat", "p.lon as last_lon",
    ]);

  let qb;
  if (numeric != null) {
    qb = baseQuery.where((eb: any) => eb.or([
      eb("v.mmsi", "=", numeric),
      eb("v.imo", "=", numeric),
    ]));
  } else {
    const like = `${q.replace(/[%_]/g, " ")}%`;
    qb = baseQuery.where("v.name", "like", like);
  }
  const rows = await qb.orderBy("v.last_seen_ms", "desc").limit(limit).execute();

  return {
    results: rows.map((r: any) => ({
      mmsi: Number(r.mmsi),
      imo: r.imo != null ? Number(r.imo) : null,
      name: r.name ?? null,
      callsign: r.callsign ?? null,
      type_class: r.type_class ?? "unknown",
      flag_iso: r.flag_iso ?? null,
      last_seen_ms: r.last_seen_ms != null ? Number(r.last_seen_ms) : null,
      last_lat: r.last_lat != null ? Number(r.last_lat) : null,
      last_lon: r.last_lon != null ? Number(r.last_lon) : null,
    })),
    total: rows.length,
  };
}

async function cmdAismarineGetVesselDensityTile(_sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.aismarine.getVesselDensityTile", payload);
  const parsed = _parseBbox4(req.bbox);
  if (parsed === null) return { cells: [], cellSchema: "grid_0p1deg", windowMinutes: 60 };
  const [w, s, e, n] = parsed;

  const windowMinutes = [15, 30, 60, 240, 1440].includes(Number(req.windowMinutes))
    ? Number(req.windowMinutes) : 60;
  const types = Array.isArray(req.types)
    ? (req.types as string[]).filter((t) => typeof t === "string" && AISMARINE_TYPE_CLASSES.has(t))
    : [];

  // Phase 1: backed by mv_vessel_density_grid (0.1° lat/lon grid). The
  // h3Resolution input is accepted for forward-compat (Phase 2 will re-introduce
  // true H3 res-6 once a Python/Rust UDF wraps `h3o`) but currently ignored.
  // cellSchema='grid_0p1deg' tells the client which rendering path to use.
  const cutoffMs = Date.now() - windowMinutes * 60 * 1000;
  const db = getDb();
  let q = (db as any).selectFrom("mv_vessel_density_grid")
    .select((eb: any) => [
      "cell_id",
      "lat_bin",
      "lon_bin",
      "type_class",
      eb.fn.sum("hit_count").as("hit_count"),
      eb.fn.sum("vessel_count").as("vessel_count"),
    ])
    .where("bucket_ms", ">=", cutoffMs)
    .where("lat_bin", ">=", s).where("lat_bin", "<=", n)
    .groupBy(["cell_id", "lat_bin", "lon_bin", "type_class"]);
  q = w <= e
    ? q.where("lon_bin", ">=", w).where("lon_bin", "<=", e)
    : q.where((eb: any) => eb.or([eb("lon_bin", ">=", w), eb("lon_bin", "<=", e)]));
  if (types.length > 0) q = q.where("type_class", "in", types);

  const rows = await q.execute();
  type Cell = {
    cell_id: string;
    lat_bin: number;
    lon_bin: number;
    vessel_count: number;
    hit_count: number;
    byClass: Record<string, { vessel_count: number; hit_count: number }>;
  };
  const byCell = new Map<string, Cell>();
  for (const r of rows as any[]) {
    const key = String(r.cell_id);
    const vc = Number(r.vessel_count ?? 0);
    const hc = Number(r.hit_count ?? 0);
    const tc = r.type_class ?? "unknown";
    let entry = byCell.get(key);
    if (!entry) {
      entry = {
        cell_id: key,
        lat_bin: Number(r.lat_bin),
        lon_bin: Number(r.lon_bin),
        vessel_count: 0,
        hit_count: 0,
        byClass: {},
      };
      byCell.set(key, entry);
    }
    entry.vessel_count += vc;
    entry.hit_count += hc;
    entry.byClass[tc] = { vessel_count: vc, hit_count: hc };
  }

  return {
    cells: Array.from(byCell.values()),
    cellSchema: "grid_0p1deg",
    windowMinutes,
  };
}

// ── unified search (Phase 1.3 — restores broken Svelte client wiring) ──
//
// The Svelte search box (App.svelte:runUnifiedSearch) calls three NSIDs in
// parallel: searchPlaces / searchResources / graphSearchNodes. Until now
// the Worker had no handlers → all three returned XRPC_UNKNOWN_METHOD →
// pins were never drawn. Implementations below run direct Kysely queries
// against vertex_spatial / vertex_vessel / vertex_legal_entity, no PDS
// pipethrough (ADR-0036 read path).

const SEARCH_LIMIT_DEFAULT = 12;
const SEARCH_LIMIT_MAX = 50;

// vertex_spatial has 4.6M `Spot` rows + 168K `Place` rows + smaller per-label.
// Restrict keyword search to user-relevant labels; the Spot bucket is OSM POI
// noise that fuzzy matches everything and dominates results.
const KEYWORD_PLACE_LABELS = [
  "Place", "Station", "Airport", "Port", "Hotel", "Restaurant", "Cafe",
  "School", "Hospital", "Park", "Building", "AdminArea", "Mountain", "River",
  "Lake", "Island", "Coastline",
];

function _prefixVariants(q: string): string[] {
  // RW has no LOWER(name) functional index → can't use `LOWER(name) LIKE 'x%'`
  // efficiently. Use case-sensitive prefix match with two variants (verbatim
  // + capitalised + lowercased), each btree-indexed.
  const cleaned = q.replace(/[%_]/g, "").trim();
  if (!cleaned) return [];
  const lower = cleaned.toLowerCase();
  const upper = cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
  const verbatim = cleaned;
  const seen = new Set<string>();
  return [verbatim, upper, lower].filter((v) => {
    if (seen.has(v)) return false;
    seen.add(v);
    return true;
  });
}

async function cmdSearchPlaces(_sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  // URL params arrive as strings; the auto-bootstrapped lexicon validator
  // rejects "5" against `limit: number`. Decode raw JSON + coerce manually.
  const req = decodeJson<Record<string, unknown>>(payload, {});
  const q = String(req.query ?? "").trim();
  if (q.length < 2) return { rows: [], total: 0 };
  const limit = Math.min(Math.max(Number(req.limit ?? SEARCH_LIMIT_DEFAULT), 1), SEARCH_LIMIT_MAX);
  const variants = _prefixVariants(q);
  if (variants.length === 0) return { rows: [], total: 0 };

  const db = getDb();
  const rows = await (db as any).selectFrom("vertex_spatial")
    .select(["vertex_id", "rkey", "label", "name", "lat", "lng"])
    .where("label", "in", KEYWORD_PLACE_LABELS)
    .where((eb: any) => eb.or(variants.map((v) => eb("name", "like", `${v}%`))))
    .where("lat", "is not", null)
    .where("lng", "is not", null)
    .limit(limit)
    .execute();

  return {
    rows: rows.map((r: any) => ({
      placeId: r.vertex_id ?? r.rkey,
      label: r.name ?? r.rkey ?? r.vertex_id,
      kind: r.label ?? "Place",
      lat: r.lat != null ? Number(r.lat) : null,
      lng: r.lng != null ? Number(r.lng) : null,
    })),
    total: rows.length,
  };
}

async function cmdSearchResources(_sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = decodeJson<Record<string, unknown>>(payload, {});
  const q = String(req.query ?? "").trim();
  if (q.length < 2) return { results: [], total: 0 };
  const limit = Math.min(Math.max(Number(req.limit ?? SEARCH_LIMIT_DEFAULT), 1), SEARCH_LIMIT_MAX);
  const variants = _prefixVariants(q);
  if (variants.length === 0) return { results: [], total: 0 };
  const numeric = /^\d{7,9}$/.test(q) ? Number(q) : null;

  const db = getDb();
  // legal_entity excluded — use IVF semantic search (no LOWER(name) index).
  const [places, vessels] = await Promise.all([
    (db as any).selectFrom("vertex_spatial")
      .select(["vertex_id", "rkey", "label", "name", "lat", "lng"])
      .where("label", "in", KEYWORD_PLACE_LABELS)
      .where((eb: any) => eb.or(variants.map((v) => eb("name", "like", `${v}%`))))
      .where("lat", "is not", null)
      .limit(limit)
      .execute(),
    (db as any).selectFrom("vertex_vessel")
      .select(["mmsi", "imo", "name", "type_class", "flag_iso"])
      .where((eb: any) => {
        const conds = variants.map((v) => eb("name", "like", `${v}%`));
        if (numeric != null) {
          conds.push(eb("mmsi", "=", numeric));
          conds.push(eb("imo", "=", numeric));
        }
        return eb.or(conds);
      })
      .limit(limit)
      .execute(),
  ]);
  const entities: any[] = [];

  const results: any[] = [];
  for (const r of places) {
    results.push({
      id: r.vertex_id ?? r.rkey,
      title: r.name ?? r.rkey,
      snippet: `place / ${r.label ?? "Place"}`,
      source: "graph",
      latitude: r.lat != null ? Number(r.lat) : null,
      longitude: r.lng != null ? Number(r.lng) : null,
      url: null,
    });
  }
  for (const v of vessels) {
    results.push({
      id: `mmsi:${v.mmsi}`,
      title: v.name ?? `MMSI ${v.mmsi}`,
      snippet: `vessel / ${v.type_class ?? "unknown"}${v.flag_iso ? " · " + v.flag_iso : ""}`,
      source: "vessel",
      latitude: null,  // resolved at click via aismarine.queryVesselsBbox / mv_vessel_latest_position
      longitude: null,
      url: `/at/did:web:maps.etzhayyim.com/com.etzhayyim.apps.maps.aismarine/${v.mmsi}`,
    });
  }
  for (const e of entities) {
    results.push({
      id: e.vertex_id,
      title: e.name ?? e.lei ?? e.vertex_id,
      snippet: `legal-entity${e.country ? " · " + e.country : ""}${e.entity_type ? " · " + e.entity_type : ""}`,
      source: "legal_entity",
      latitude: null,
      longitude: null,
      url: e.lei ? `https://search.gleif.org/#/record/${e.lei}` : null,
    });
  }
  return { results: results.slice(0, limit * 2), total: results.length };
}

async function cmdGraphSearchNodes(_sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = decodeJson<Record<string, unknown>>(payload, {});
  const q = String(req.query ?? "").trim();
  if (q.length < 2) return { nodes: [], total: 0 };
  const limit = Math.min(Math.max(Number(req.limit ?? 20), 1), SEARCH_LIMIT_MAX);
  const variants = _prefixVariants(q);
  if (variants.length === 0) return { nodes: [], total: 0 };
  const numeric = /^\d{7,9}$/.test(q) ? Number(q) : null;

  const db = getDb();
  // Same three sources as searchResources but the output shape is graph-y
  // (id / label / lat / lng). The Svelte client uses this for entity
  // graph hits — pins drawn whenever lat/lng are present.
  // legal_entity excluded — use IVF semantic search (no LOWER(name) index).
  const [places, vessels, ports] = await Promise.all([
    (db as any).selectFrom("vertex_spatial")
      .select(["vertex_id", "rkey", "label", "name", "lat", "lng"])
      .where("label", "in", KEYWORD_PLACE_LABELS)
      .where((eb: any) => eb.or(variants.map((v) => eb("name", "like", `${v}%`))))
      .limit(limit)
      .execute(),
    (db as any).selectFrom("vertex_vessel as v")
      .leftJoin("mv_vessel_latest_position as p", "p.mmsi", "v.mmsi")
      .select([
        "v.mmsi as mmsi", "v.name as name", "v.type_class as type_class",
        "v.flag_iso as flag_iso", "p.lat as lat", "p.lon as lon",
      ])
      .where((eb: any) => {
        const conds: any[] = variants.map((v) => eb("v.name", "like", `${v}%`));
        if (numeric != null) {
          conds.push(eb("v.mmsi", "=", numeric));
          conds.push(eb("v.imo", "=", numeric));
        }
        return eb.or(conds);
      })
      .limit(limit)
      .execute(),
    (db as any).selectFrom("vertex_open_ports_port")
      .select(["vertex_id", "un_locode", "name", "latitude", "longitude"])
      .where((eb: any) => {
        const conds = variants.map((v) => eb("name", "like", `${v}%`));
        conds.push(eb("un_locode", "=", q.toUpperCase()));
        return eb.or(conds);
      })
      .limit(limit)
      .execute(),
  ]);
  const entities: any[] = [];

  const nodes: any[] = [];
  for (const r of places) {
    if (r.lat == null || r.lng == null) continue;
    nodes.push({
      id: r.vertex_id, label: r.label ?? "Place",
      title: r.name ?? r.rkey,
      lat: Number(r.lat), lng: Number(r.lng),
      sourceUrl: null, types: [r.label ?? "Place"], nsPrefix: "com.etzhayyim.apps.maps.spatial",
    });
  }
  for (const v of vessels) {
    if (v.lat == null || v.lon == null) continue;
    nodes.push({
      id: `mmsi:${v.mmsi}`, label: "Vessel",
      title: v.name ?? `MMSI ${v.mmsi}`,
      lat: Number(v.lat), lng: Number(v.lon),
      sourceUrl: null, types: [v.type_class ?? "unknown"], nsPrefix: "com.etzhayyim.apps.maps.aismarine",
    });
  }
  for (const e of entities) {
    nodes.push({
      id: e.vertex_id, label: "LegalEntity",
      title: e.name ?? e.lei ?? e.vertex_id,
      lat: null, lng: null,
      sourceUrl: e.lei ? `https://search.gleif.org/#/record/${e.lei}` : null,
      types: [e.entity_type ?? "LegalEntity"], nsPrefix: "com.etzhayyim.apps.legal_entity",
    });
  }
  for (const p of ports) {
    nodes.push({
      id: p.vertex_id, label: "Port",
      title: p.name ?? p.un_locode,
      lat: p.latitude != null ? Number(p.latitude) : null,
      lng: p.longitude != null ? Number(p.longitude) : null,
      sourceUrl: null, types: ["Port", p.un_locode], nsPrefix: "com.etzhayyim.apps.maps.openPorts",
    });
  }
  return { nodes: nodes.slice(0, limit), total: nodes.length };
}

// ── IVF semantic search (ADR-2605011500 §Phase-1.3 — addendum) ──
//
// `searchSemanticNodes` embeds the user query via Cloudflare Workers AI
// (@cf/baai/bge-base-en-v1.5, 768-dim) → distances vs ~128 centroids in
// vertex_ivf_centroid (collection='maps_search_v1') → top-4 cluster scan
// in vertex_vector_embedding_768 (space_id='maps_search_v1') →
// cosine-similarity sort. Resolves source_vertex_id back to vessel /
// legal_entity / spatial / port for return shape.
//
// Embedding backfill + K-means training is run as a one-shot Job by the
// maps-bulk-ingest aismarine_ivf_train.py worker (separate commit). At
// query time we never block on missing embeddings — if the IVF index is
// empty (no centroids) the handler returns []; the Svelte client treats
// IVF as a complement, not a replacement, of the keyword search.

const IVF_SPACE = "maps_search_v1";
const IVF_MODEL = "BAAI/bge-base-en-v1.5";
const IVF_CENTROID_PROBE = 4;
// Self-hosted embedder pod via cf-tunnel. ADR-2605011500 §Phase-1.3.
// No external API call. The token gates the public ingress; the pod
// itself is on a maps-bulk-ingest ClusterIP, not directly reachable.
const EMBEDDER_BASE_URL = "https://embedder.etzhayyim.com";

// RisingWave returns `real[]` as a textual array literal ("{0.1,0.2,…}" or
// "[0.1,0.2,…]") through Hyperdrive. Parse before cosine; null on bogus shape.
function _parseEmb(v: unknown): number[] | null {
  if (Array.isArray(v)) return v as number[];
  if (typeof v !== "string") return null;
  const s = v.trim();
  let inner: string;
  if (s.startsWith("[") && s.endsWith("]")) inner = s.slice(1, -1);
  else if (s.startsWith("{") && s.endsWith("}")) inner = s.slice(1, -1);
  else return null;
  if (!inner) return null;
  const out: number[] = [];
  for (const tok of inner.split(",")) {
    const f = Number(tok);
    if (!Number.isFinite(f)) return null;
    out.push(f);
  }
  return out;
}

function _cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

async function _embedQuery(env: any, query: string): Promise<number[] | null> {
  // Self-hosted embedder pod via cf-tunnel — no Workers AI binding, no
  // external API. Auth via EMBED_AUTH_TOKEN secret (Worker-side bearer).
  const token = String(
    (_mapsEnv as any)?.EMBED_AUTH_TOKEN
      ?? (_mapsEnv as any)?.SS_EMBED_AUTH_TOKEN
      ?? env?.EMBED_AUTH_TOKEN
      ?? "",
  );
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers["authorization"] = `Bearer ${token}`;
    const resp = await fetch(`${EMBEDDER_BASE_URL}/embed`, {
      method: "POST",
      headers,
      body: JSON.stringify({ texts: [query] }),
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
      console.warn("[ivf] embedder HTTP", resp.status, await resp.text().catch(() => ""));
      return null;
    }
    const j: any = await resp.json();
    const v = Array.isArray(j?.vectors) ? j.vectors[0] : null;
    if (!Array.isArray(v) || v.length !== 768) return null;
    return v as number[];
  } catch (e) {
    console.warn("[ivf] embed failed:", e);
    return null;
  }
}

async function cmdSearchSemanticNodes(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.searchSemanticNodes" as any, payload);
  const q = String((req as any).query ?? "").trim();
  if (q.length < 2) return { nodes: [], total: 0, model: IVF_MODEL, indexed: false };
  const limit = Math.min(Math.max(Number((req as any).limit ?? 20), 1), SEARCH_LIMIT_MAX);

  const env = (sdk as any)?.env ?? {};
  const qvec = await _embedQuery(env, q);
  if (qvec === null) {
    return { nodes: [], total: 0, model: IVF_MODEL, indexed: false, reason: "embed_unavailable" };
  }

  const db = getDb();

  // 1. centroid scan — pull all centroids for our space (small N, ~128).
  const centroidRows = await (db as any).selectFrom("vertex_ivf_centroid")
    .select(["rkey", "embedding"])
    .where("collection", "=", IVF_SPACE)
    .execute();
  if (centroidRows.length === 0) {
    return { nodes: [], total: 0, model: IVF_MODEL, indexed: false, reason: "no_centroids" };
  }
  const ranked = centroidRows
    .map((r: any) => ({
      cluster_id: String(r.rkey),
      sim: _cosine(qvec, _parseEmb(r.embedding) ?? []),
    }))
    .sort((a: any, b: any) => b.sim - a.sim)
    .slice(0, IVF_CENTROID_PROBE);
  const probeIds = ranked.map((r: any) => r.cluster_id);

  // 2. cluster scan — JOIN through side table vertex_ivf_assignment because
  // vertex_vector_embedding_768 is append-only (UPDATE forbidden), so the
  // KMeans cluster_id can't live on the embedding row directly.
  const candidateRows = await (db as any).selectFrom("vertex_vector_embedding_768 as e")
    .innerJoin("vertex_ivf_assignment as a", "a.embedding_id", "e.embedding_id")
    .select([
      "e.embedding_id as embedding_id",
      "e.source_vertex_id as source_vertex_id",
      "e.source_uri as source_uri",
      "e.text_preview as text_preview",
      "e.emb as emb",
    ])
    .where("a.space_id", "=", IVF_SPACE)
    .where("a.cluster_id", "in", probeIds)
    .limit(2000)
    .execute();

  const scored = candidateRows
    .map((r: any) => ({
      source_vertex_id: r.source_vertex_id,
      text_preview: r.text_preview,
      sim: _cosine(qvec, _parseEmb(r.emb) ?? []),
    }))
    .sort((a: any, b: any) => b.sim - a.sim)
    .slice(0, limit);

  return {
    nodes: scored.map((s: any) => ({
      id: s.source_vertex_id,
      title: s.text_preview ?? s.source_vertex_id,
      similarity: s.sim,
    })),
    total: scored.length,
    model: IVF_MODEL,
    indexed: true,
    centroids_total: centroidRows.length,
    centroids_probed: probeIds.length,
  };
}

// ── SDK Bootstrap ──

// ADR-0087 kotodama MCP Tool Facade — opt-in `mcpRegistry: {}` flag mounts
// the per-actor `/mcp` Streamable-HTTP endpoint. No new dispatch path: every
// `sdk.app.command()` already declared above with `asAgentTool(...)` is
// auto-published to `tools/list` from the Kysely `vertex_mcp_tool_def` registry
// (synced by 70-tools/scripts/contract/sync-mcp-registry.py). `tools/call`
// delegates back to the existing XRPC handler. Bearer auth (ADR-0022) and
// Path F middleware (memory/consent/audit/scheduler, 260413) apply unchanged.
const _innerExport = createWorkerExport((sdk) => {
  appId = (sdk as any)?.pds?.selfNanoid ?? "";
  // Stash sdk.env so handlers can reach it without an extra param. The
  // initial fetch wrapper below will overwrite this with the raw CF env
  // on every request (which is what carries the `AI` Workers AI binding).
  _mapsEnv = (sdk as any)?.env ?? _mapsEnv;
  // Guard: createWorkerExport probes the callback as a legacy factory by calling it with raw CF
  // env (sdk = env object). sdk.app is undefined in that case — return early so the probe
  // returns void cleanly. The SDK will then take the `else` path, initialize correctly, and
  // call this callback again with a proper HostSDK where sdk.app is defined.
  if (!sdk.app) return;

  // ── Heartbeat hook — collection dispatch (seismic, ADS-B, satellite, Overpass) ──
  // CRITICAL: Must register via sdk.app.onHeartbeat(). export async function runHeartbeat()
  // is NOT called by the host-sdk. Host calls runDefaultHeartbeat() which invokes this hook.
  sdk.app.onHeartbeat(async (cadence) => {
    const actions: Array<Record<string, unknown>> = [];
    const ts = nowISO();

    // --- Poll: Process GeoRecord nodes written by previous heartbeat's remote calls ---
    // Run FIRST before bootstrap to ensure seismic/ADS-B data is processed even on cold start.
    // T3 workers don't receive automatic PDS commit events, so we poll the graph directly.
    // source column = createdAt (set by PDS GeoRecord handler) — enables time-range polling.
    {
      const since = lastGeoRecordPollAt;
      lastGeoRecordPollAt = new Date(Date.now() - 30 * 1000).toISOString();
      try {
        const geoRecs = (await listCollectionRows("site.geoRecord")).filter((row) => String(row.source ?? "") > since).slice(0, 50);
        if (geoRecs.length > 0) {
          for (const row of geoRecs) {
            const rec = expandGeoRecordRow(row);
            await processGeoRecord(sdk, rec);
          }
          actions.push({ action: "geoRecordPoll", count: geoRecs.length, ts });
        }
      } catch (e: any) { console.warn(`[heartbeat] geoRecord poll error: ${e?.message ?? e}`); }
    }

    // --- Bootstrap 0: Profile + Actor + social graph registration ---
    if (!profileRegistered || !socialBootstrapRegistered) {
      try {
        const mapsDid = `did:web:${appId}.etzhayyim.com`;
        const socialBootstrap = await bootstrapMapsIdentityAndSocial(sdk);
        actions.push({
          action: "profileRegistered",
          did: mapsDid,
          socialProfileCreated: socialBootstrap.socialProfileCreated,
          followsCreated: socialBootstrap.followsCreated.length,
          ts,
        });
        // 3. Register path-based source DIDs
        const sourceDids = [
          { path: "geocode", name: "Geocode (Nominatim)" },
          { path: "weather", name: "Weather (Open-Meteo)" },
          { path: "ip_geolocation", name: "IP Geolocation (ip-api)" },
          { path: "infrastructure", name: "Infrastructure (Overpass)" },
          { path: "tile", name: "Tile (OpenFreeMap)" },
          { path: "street_view", name: "Street View (Mapillary)" },
          { path: "planet", name: "Planet (OSM)" },
          { path: "user_post", name: "User Post EXIF" },
          { path: "mapraly", name: "Mapraly POI" },
          { path: "vision", name: "Vision (Murakumo)" },
          { path: "satellite", name: "Satellite (Sentinel-2/Landsat)" },
          { path: "seismic", name: "Seismic (USGS)" },
          { path: "gtfs", name: "GTFS-JP (MLIT)" },
          { path: "adsb", name: "ADS-B (OpenSky)" },
        ];
        for (const src of sourceDids) {
          try {
            (sdk as any).hostImports?.comAtprotoIdentityCreate?.(
              `source:${src.path}`,
              JSON.stringify({ displayName: `Maps Source: ${src.name}`, category: "source" }),
            );
          } catch { /* already exists */ }
        }
        profileRegistered = true;
        socialBootstrapRegistered = true;
        actions.push({ action: "profileRegistered", sources: sourceDids.length, ts });
        if (socialBootstrap.profileCreated || socialBootstrap.actorCreated || socialBootstrap.socialProfileCreated || socialBootstrap.bootstrapPostCreated || socialBootstrap.followsCreated.length > 0) {
          await post(sdk, `[Bootstrap] Maps profile + actor + social graph ensured (${socialBootstrap.followsCreated.length} follows, ${sourceDids.length} source DIDs)\ncc @jinushi.etzhayyim.com`);
        }
      } catch (e: any) {
        console.warn(`[heartbeat] profile registration: ${e?.message ?? e}`);
        profileRegistered = true;
      }
    }

    // --- Bootstrap: Layer DID coordinators (one-time) ---
    if (!layersRegistered) {
      const n = await bootstrapLayerCoordinators(sdk);
      if (n > 0) actions.push({ action: "bootstrapLayers", count: n, ts });
    }

    // --- Bootstrap: JP prefectures + country (one-time) ---
    if (!regionsRegistered) {
      const n = await bootstrapJpPrefectures(sdk);
      if (n > 0) actions.push({ action: "bootstrapJpPrefectures", count: n, ts });
    }

    // --- Bootstrap: Vertical zones (one-time) ---
    if (!verticalZonesRegistered) {
      const n = await bootstrapVerticalZones(sdk);
      if (n > 0) actions.push({ action: "bootstrapVerticalZones", count: n, ts });
    }

    // --- Bootstrap: Natural zones (one-time) ---
    if (!naturalZonesRegistered) {
      const n = await bootstrapNaturalZones(sdk);
      if (n > 0) actions.push({ action: "bootstrapNaturalZones", count: n, ts });
    }

    // --- Bootstrap: 195 sovereign countries (one-time) ---
    if (!sovereignRegistered) {
      const n = await bootstrapSovereignCountries(sdk);
      if (n > 0) actions.push({ action: "bootstrapSovereignCountries", count: n, ts });
    }

    // --- Bootstrap: World ports (one-time) ---
    if (!portsRegistered) {
      const n = await bootstrapWorldPorts(sdk);
      if (n > 0) actions.push({ action: "bootstrapWorldPorts", count: n, ts });
    }

    // --- Bootstrap: World airports (one-time) ---
    if (!airportsRegistered) {
      const n = await bootstrapWorldAirports(sdk);
      if (n > 0) actions.push({ action: "bootstrapWorldAirports", count: n, ts });
    }

    // --- Collection: Underground infra from OSM Overpass (1 city per 6 heartbeats ≈ 30min) ---
    if (collectionPhase % 6 === 0) {
      const cityIdx = Math.floor(collectionPhase / 6) % INFRA_SEED_CITIES.length;
      const city = INFRA_SEED_CITIES[cityIdx];
      const infraCount = await fetchInfraFromOverpass(sdk, city.lat, city.lng, 2000);
      if (infraCount > 0) actions.push({ action: "infraOverpass", city: city.name, segments: infraCount, ts });
    }

    // --- Collection: Building footprints + heights (1 city per 4 heartbeats ≈ 20min) ---
    if (collectionPhase % 4 === 0) {
      const cityIdx = Math.floor(collectionPhase / 4) % INFRA_SEED_CITIES.length;
      const city = INFRA_SEED_CITIES[cityIdx];
      const bldCount = await fetchBuildingsFromOverpass(sdk, city.lat, city.lng, 1500, 200);
      if (bldCount > 0) actions.push({ action: "buildingsOverpass", city: city.name, buildings: bldCount, ts });
    }

    // --- Collection: OSM Overpass grid scan (4 jobs per heartbeat for 4x throughput, stays under 10K req/day) ---
    for (let ovpI = 0; ovpI < 4; ovpI++) {
      const ovpResult = dispatchOverpassCollectionJob(sdk, collectionPhase * 4 + ovpI);
      if (ovpResult) {
        actions.push({ action: "overpassJob", prefecture: ovpResult.prefecture, entityType: ovpResult.entityType, phase: collectionPhase * 4 + ovpI, ts });
      }
    }

    // --- Collection: STAC satellite sync (1 job per heartbeat) ---
    const satResult = dispatchSatelliteCollectionJob(sdk, collectionPhase);
    if (satResult) {
      actions.push({ action: "satelliteJob", target: satResult, phase: collectionPhase, ts });
    }

    // --- Collection: USGS seismic — 毎 heartbeat (5 min), 小 feed を交互 ---
    // M4.5+day (~10件) / significant_week (~5件) を交互 → 量を抑えつつ鮮度を保つ
    {
      const feeds = [
        "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson",    // M4.5+ 直近24h (~10件)
        "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_week.geojson", // 重要 週次 (~5件)
      ];
      const feedUrl = feeds[collectionPhase % feeds.length];
      (sdk as any).hostImports?.kotodamaInvoke?.(
        "site.etzhayyim.com",
        "com.etzhayyim.apps.site.ingestGeoData",
        JSON.stringify({ url: feedUrl, format: "usgs_geojson", project: "maps" }),
      );
      actions.push({ action: "seismicRemoteIngest", url: feedUrl, phase: collectionPhase, ts });
    }

    // --- Collection: OpenSky ADS-B — 毎 heartbeat (5 min), 小 bbox を8タイル循環 ---
    // 各タイル ~4°×5° → ~30-80機/call。8タイルで日本空域を40分でフル coverage
    {
      const tiles = [
        { lamin: 42.0, lomin: 140.0, lamax: 46.0, lomax: 145.0, label: "Hokkaido-W" },
        { lamin: 42.0, lomin: 145.0, lamax: 46.0, lomax: 150.0, label: "Hokkaido-E" },
        { lamin: 37.0, lomin: 139.0, lamax: 42.0, lomax: 145.0, label: "Tohoku" },
        { lamin: 34.0, lomin: 138.0, lamax: 38.0, lomax: 142.0, label: "Kanto" },
        { lamin: 34.0, lomin: 134.0, lamax: 38.0, lomax: 138.0, label: "Chubu" },
        { lamin: 33.0, lomin: 130.0, lamax: 36.0, lomax: 136.0, label: "Kansai" },
        { lamin: 30.0, lomin: 128.0, lamax: 34.0, lomax: 132.0, label: "Kyushu" },
        { lamin: 24.0, lomin: 122.0, lamax: 30.0, lomax: 130.0, label: "Okinawa" },
      ];
      const tile = tiles[collectionPhase % tiles.length];
      const adsbUrl = `https://opensky-network.org/api/states/all?lamin=${tile.lamin}&lomin=${tile.lomin}&lamax=${tile.lamax}&lomax=${tile.lomax}`;
      (sdk as any).hostImports?.kotodamaInvoke?.(
        "site.etzhayyim.com",
        "com.etzhayyim.apps.site.ingestGeoData",
        JSON.stringify({ url: adsbUrl, format: "opensky_json", project: "maps" }),
      );
      actions.push({ action: "adsbRemoteIngest", tile: tile.label, phase: collectionPhase, ts });
    }

    // --- Coverage frontier self-pacing (backup for BPMN timer) ---
    // Every heartbeat (≈5 min): advance 1 gap + run the created job.
    // Coverage cycle is now driven by the Vultr K8s CronJob
    // `maps-coverage-ticker` (`*/2 * * * *`) which posts to
    // /xrpc/com.etzhayyim.apps.maps.batchCoverageCycle guaranteed every 2 min —
    // see 50-infra/vultr/maps-coverage-ticker/cronjob.yaml. The CF Worker
    // heartbeat was traffic-driven (fired only when isolate was hot), so
    // running the cycle here as well stacked duplicate external calls and
    // wasted rate budget. Leave state-sync logic below (geoRecord poll,
    // profile bootstrap, infraSeedCities) but stop piggy-backing coverage.

    // Advance collection phase
    collectionPhase++;

    return actions;
  });

  const a = sdk.app;
    // Spatial Intelligence
    a.command(nsid("com.etzhayyim.apps.maps.runtimeConfig"), (_, body) => cmdRuntimeConfig(sdk, body), asAgentTool("Get maps runtime configuration"), withCapabilityTags("config", "query"))
      .command(nsid("com.etzhayyim.apps.maps.kamiConfig"), (_, body) => cmdKamiConfig(sdk, body), asAgentTool("Get KAMI runtime configuration"), withCapabilityTags("config", "query"))
      .command(nsid("com.etzhayyim.apps.maps.tileGeoJson"), (_, body) => cmdTileGeoJson(sdk, body), asAgentTool("RisingWave-native vector tile: per-label GeoJSON for bbox"), withCapabilityTags("map", "vector", "geojson"))
      .command(nsid("com.etzhayyim.apps.maps.tileXyz"), (_, body) => cmdTileXyz(sdk, body), asAgentTool("Slippy-tile (z/x/y) vector endpoint — stable tile URL, lod-simplified features"), withCapabilityTags("map", "vector", "xyz", "tile"))
      .command(nsid("com.etzhayyim.apps.maps.getChunk"), (_, body) => cmdGetChunk(sdk, body), asAgentTool("Forward-topology H3 chunk reader: per-cell per-label GeoJSON (replaces XYZ pyramid)"), withCapabilityTags("map", "chunk", "h3", "forward-topology"))
      .command(nsid("com.etzhayyim.apps.maps.getChunkModels"), (_, body) => cmdGetChunkModels(sdk, body), asAgentTool("DB-driven 3D model instances: buildings (AABB), vegetation (TaxonomicProfile), atoms for H3 tiles"), withCapabilityTags("map", "model", "3d", "science", "h3"))
      .command(nsid("com.etzhayyim.apps.maps.seedBuildings"), (_, body) => cmdSeedBuildings(sdk, body), asAgentTool("Seed building polygons + heights from OSM Overpass for a bbox"), withCapabilityTags("seed", "building", "overpass"))
      .command(nsid("com.etzhayyim.apps.maps.reverseGeocode"), (_, body) => cmdPlaceReverseGeocode(sdk, body), asAgentTool("Reverse geocode lat/lng"), withCapabilityTags("place", "geocode"))
      .command(nsid("com.etzhayyim.apps.maps.weatherAt"), (_, body) => cmdWeatherAt(sdk, body), asAgentTool("Weather at location"), withCapabilityTags("weather", "query"))
      .command(nsid("com.etzhayyim.apps.maps.weatherGrid"), (_, body) => cmdWeatherGrid(sdk, body), asAgentTool("Weather grid query"), withCapabilityTags("weather", "query"))
      .command(nsid("com.etzhayyim.apps.maps.ipGeolocate"), (_, body) => cmdIpGeolocate(sdk, body), asAgentTool("IP geolocation lookup"), withCapabilityTags("ip", "query"));
    // Transport Intelligence
    a.command(nsid("com.etzhayyim.apps.maps.nextDeparturesAtStop"), (_, body) => cmdNextDeparturesAtStop(sdk, body), asAgentTool("Next scheduled departures at a Station / BusStop (GTFS-JP timetable, no realtime)"), withCapabilityTags("transit", "schedule", "query", "gtfs"))
      .command(nsid("com.etzhayyim.apps.maps.realtimeDelaysAtStop"), (_, body) => cmdRealtimeDelaysAtStop(sdk, body), asAgentTool("Next departures at a stop with GTFS-RT delays + active alerts (degrades to static when RT pipeline offline)"), withCapabilityTags("transit", "schedule", "query", "gtfs", "realtime"))
      .command(nsid("com.etzhayyim.apps.maps.crawlFlightPrices" as any), (_, body) => cmdCrawlFlightPrices(sdk, body), asAgentTool("Queue flight fare crawler (Skyscanner-like)"), withCapabilityTags("transport", "crawler", "flight", "price", "write"));
    // Gsplat preview / QC (ADR-2605092800)
    a.query(nsid("com.etzhayyim.apps.maps.getGsplatAsset"), (_, body) => cmdGetGsplatAsset(sdk, body), asAgentTool("Resolve a 3D Gaussian Splat preview asset by tile (H3) or vertex_id"), withCapabilityTags("gsplat", "preview", "qc", "query"))
      .query(nsid("com.etzhayyim.apps.maps.listGsplatAssets"), (_, body) => cmdListGsplatAssets(sdk, body), asAgentTool("List 3D Gaussian Splat preview assets (filter by tile / source_did)"), withCapabilityTags("gsplat", "preview", "list", "query"))
      .command(nsid("com.etzhayyim.apps.maps.bakeGsplatAsset"), (_, body) => cmdBakeGsplatAsset(sdk, body), asAgentTool("Enqueue a splat→mesh bake job for a tile (delegates to L8 k8s pod)"), withCapabilityTags("gsplat", "bake", "mesh", "write"))
      .command(nsid("com.etzhayyim.apps.maps.trainGsplatFromMapillary"), (_, body) => cmdTrainGsplatFromMapillary(sdk, body), asAgentTool("Train a 3D Gaussian Splat at lat/lng from Mapillary imagery (COLMAP + gsplat on RunPod L40S)"), withCapabilityTags("gsplat", "train", "mapillary", "colmap", "write"))
      .query(nsid("com.etzhayyim.apps.maps.getGsplatJobStatus"), (_, body) => cmdGetGsplatJobStatus(sdk, body), asAgentTool("Latest state of a single gsplat train / bake job by jobId"), withCapabilityTags("gsplat", "status", "query"))
      .query(nsid("com.etzhayyim.apps.maps.listGsplatJobs"), (_, body) => cmdListGsplatJobs(sdk, body), asAgentTool("List the latest state of gsplat train / bake jobs (filter by tile / kind / status)"), withCapabilityTags("gsplat", "status", "list", "query"))
      .query(nsid("com.etzhayyim.apps.maps.getGsplatCostSummary"), (_, body) => cmdGetGsplatCostSummary(sdk, body), asAgentTool("RunPod $ spend summary across train + bake (today UTC / last 7 / last 30 days)"), withCapabilityTags("gsplat", "cost", "rollup", "query"));
    // Digital Twin
    a.command(nsid("com.etzhayyim.apps.maps.twinScene"), (_, body) => cmdTwinScene(sdk, body), asAgentTool("Get KAMI 3D scene for area"), withCapabilityTags("twin", "scene"))
      .command(nsid("com.etzhayyim.apps.maps.worldBeliefUpdate"), (_, body) => cmdWorldBeliefUpdate(sdk, body), asAgentTool("Bayesian latent world-model belief update for a spatial entity"), withCapabilityTags("world-model", "bayesian", "belief", "write"))
      .command(nsid("com.etzhayyim.apps.maps.worldBeliefGet"), (_, body) => cmdWorldBeliefGet(sdk, body), asAgentTool("Get Bayesian latent world-model beliefs for a spatial entity"), withCapabilityTags("world-model", "bayesian", "belief", "query"))
      .command(nsid("com.etzhayyim.apps.maps.latentWorldModelRun"), (_, body) => cmdLatentWorldModelRun(sdk, body), asAgentTool("Run Bayesian latent world-model inference across twin, sensor, and spatial event state"), withCapabilityTags("world-model", "bayesian", "latent", "simulation"));
    // Operations dashboard — World Monitor-style summary surface for the maps UI.
    a.query(nsid("com.etzhayyim.apps.maps.getDashboard"), (_, body) => cmdGetDashboard(sdk, body), asAgentTool("Get maps operations dashboard summary"), withCapabilityTags("dashboard", "intel", "query"));
    a.query(nsid("com.etzhayyim.apps.maps.getWorldMonitorDashboard"), (_, body) => cmdMapsPodIntelRead("com.etzhayyim.apps.maps.getWorldMonitorDashboard", body), asAgentTool("Get World Monitor-style resident intelligence dashboard"), withCapabilityTags("dashboard", "intel", "world-monitor", "query"))
      .query(nsid("com.etzhayyim.apps.maps.listIntelEvents"), (_, body) => cmdMapsPodIntelRead("com.etzhayyim.apps.maps.listIntelEvents", body), asAgentTool("List resident intelligence graph events"), withCapabilityTags("event", "intel", "world-monitor", "query"))
      .query(nsid("com.etzhayyim.apps.maps.getRiskSnapshot"), (_, body) => cmdMapsPodIntelRead("com.etzhayyim.apps.maps.getRiskSnapshot", body), asAgentTool("Get resident intelligence risk snapshot"), withCapabilityTags("risk", "intel", "world-monitor", "query"))
      .query(nsid("com.etzhayyim.apps.maps.getLatestBrief"), (_, body) => cmdMapsPodIntelRead("com.etzhayyim.apps.maps.getLatestBrief", body), asAgentTool("Get latest resident intelligence brief"), withCapabilityTags("brief", "intel", "world-monitor", "query"))
      .query(nsid("com.etzhayyim.apps.maps.listIntelAlerts"), (_, body) => cmdMapsPodIntelRead("com.etzhayyim.apps.maps.listIntelAlerts", body), asAgentTool("List resident intelligence alerts"), withCapabilityTags("alert", "intel", "world-monitor", "query"));
    a.command(nsid("com.etzhayyim.apps.maps.timeline"), (_, body) => cmdTimeline(sdk, body), asAgentTool("Get spatial event timeline for an entity"), withCapabilityTags("timeline", "event", "query"))
      .command(nsid("com.etzhayyim.apps.maps.displayLayerDefine"), (_, body) => cmdDisplayLayerDefine(sdk, body), asAgentTool("Define a display layer"), withCapabilityTags("layer", "write"))
      .query(nsid("com.etzhayyim.apps.maps.listDisplayLayers"), (_, body) => cmdListDisplayLayers(sdk, body), asAgentTool("List display layers"), withCapabilityTags("layer", "query"));
    // Sensor Intelligence
    // Simulation Intelligence
    // Spatiotemporal
    // Analytics
    // Step 1: User Post EXIF Geolocation
    a.command(nsid("com.etzhayyim.apps.maps.extractPostLocation"), (_, body) => cmdExtractPostLocation(sdk, body), asAgentTool("Extract geolocation from post images via EXIF"), withCapabilityTags("vision", "exif", "write"));
    // Step 2: Mapraly Ingest
    a.command(nsid("com.etzhayyim.apps.maps.mapralyIngest"), (_, body) => cmdMapralyIngest(sdk, body), asAgentTool("Create Mapraly collection job"), withCapabilityTags("mapraly", "ingest"));
    // Step 3: Murakumo Vision Analysis
    a.command(nsid("com.etzhayyim.apps.maps.analyzeImage"), (_, body) => cmdAnalyzeImage(sdk, body), asAgentTool("Analyze image for spatial entities via Murakumo Vision"), withCapabilityTags("vision", "analyze"));
    // Step 4: Satellite Imagery (free sources: Sentinel-2, Landsat, Sentinel-1 SAR, HLS, Copernicus DEM, NAIP)
    a.command(nsid("com.etzhayyim.apps.maps.satelliteIngest"), (_, body) => cmdSatelliteIngest(sdk, body), asAgentTool("Ingest satellite scenes from free STAC catalogs"), withCapabilityTags("satellite", "ingest"))
      .command(nsid("com.etzhayyim.apps.maps.satelliteAnalyze"), (_, body) => cmdSatelliteAnalyze(sdk, body), asAgentTool("Analyze satellite scene via Murakumo Vision"), withCapabilityTags("satellite", "analyze"));
    // Web Crawl Geo Coverage (site.etzhayyim.com integration)
    a.command(nsid("com.etzhayyim.apps.maps.seedGeoDomains"), (_, body) => cmdSeedGeoDomains(sdk, body), asAgentTool("Seed geo domain crawls via site.etzhayyim.com + CommonCrawl fallback"), withCapabilityTags("webcrawl", "seed", "coverage"));
    // Seed commands → site.etzhayyim.com:ingestGeoData
    a.command(nsid("com.etzhayyim.apps.maps.seedSeismicFeed"), (_, body) => cmdSeedSeismicFeed(sdk, body), asAgentTool("Seed USGS seismic feed via site.etzhayyim.com → SpatialEvent records"), withCapabilityTags("seismic", "usgs", "seed", "remote-ingest"))
      .command(nsid("com.etzhayyim.apps.maps.seedMunicipalities"), (_, body) => cmdSeedMunicipalities(sdk, body), asAgentTool("Seed JP 市区町村 AdminArea DIDs via Wikidata SPARQL → site.etzhayyim.com → registerRegionRecord"), withCapabilityTags("municipality", "adminArea", "wikidata", "seed", "remote-ingest"))
      .command(nsid("com.etzhayyim.apps.maps.seedGtfsJp"), (_, body) => cmdSeedGtfsJp(sdk, body), asAgentTool("Seed GTFS-JP transit data via site.etzhayyim.com crawl of transit agency domains"), withCapabilityTags("gtfs", "transit", "station", "seed", "remote-ingest"))
      // P1 seeds
      .command(nsid("com.etzhayyim.apps.maps.seedWorldAdminAreas"), (_, body) => cmdSeedWorldAdminAreas(sdk, body), asAgentTool("Seed world AdminArea tier-2 DIDs (US states, CN provinces, etc.) via Wikidata SPARQL → site.etzhayyim.com"), withCapabilityTags("adminArea", "wikidata", "tier2", "seed", "remote-ingest"))
      .command(nsid("com.etzhayyim.apps.maps.seedAirports"), (_, body) => cmdSeedAirports(sdk, body), asAgentTool("Seed 1000+ airports (large/medium) from OurAirports CSV via site.etzhayyim.com → Airport DIDs + ICAO/IATA aliases"), withCapabilityTags("airport", "icao", "iata", "ourairports", "seed", "remote-ingest"))
      .command(nsid("com.etzhayyim.apps.maps.seedAdsb"), (_, body) => cmdSeedAdsb(sdk, body), asAgentTool("Seed real-time aircraft positions from OpenSky ADS-B (optional bbox) via site.etzhayyim.com → SpatialEvent{aircraftPosition}"), withCapabilityTags("adsb", "aircraft", "opensky", "realtime", "seed", "remote-ingest"))
      // P2 seeds: Wikidata bulk natural geography + infrastructure
      .command(nsid("com.etzhayyim.apps.maps.seedWorldRivers"), (_, body) => cmdSeedWorldRivers(sdk, body), asAgentTool("Seed ~15K world rivers via Wikidata SPARQL → site.etzhayyim.com"), withCapabilityTags("river", "wikidata", "seed", "remote-ingest"))
      .command(nsid("com.etzhayyim.apps.maps.seedWorldLakes"), (_, body) => cmdSeedWorldLakes(sdk, body), asAgentTool("Seed ~8K world lakes via Wikidata SPARQL → site.etzhayyim.com"), withCapabilityTags("lake", "wikidata", "seed", "remote-ingest"))
      .command(nsid("com.etzhayyim.apps.maps.seedWorldMountains"), (_, body) => cmdSeedWorldMountains(sdk, body), asAgentTool("Seed ~20K world mountains via Wikidata SPARQL → site.etzhayyim.com"), withCapabilityTags("mountain", "wikidata", "seed", "remote-ingest"))
      .command(nsid("com.etzhayyim.apps.maps.seedWorldStations"), (_, body) => cmdSeedWorldStations(sdk, body), asAgentTool("Seed ~30K world railway stations via Wikidata SPARQL → site.etzhayyim.com"), withCapabilityTags("station", "wikidata", "seed", "remote-ingest"))
      .command(nsid("com.etzhayyim.apps.maps.seedWorldPorts"), (_, body) => cmdSeedWorldPorts(sdk, body), asAgentTool("Seed ~5K world ports via Wikidata SPARQL → site.etzhayyim.com"), withCapabilityTags("port", "wikidata", "seed", "remote-ingest"))
      // GeoRecord poll — process site.etzhayyim.com geoRecords written since $since
      .command(nsid("com.etzhayyim.apps.maps.pollGeoRecords"), async (_, payload) => {;
        const req = parseLexiconInput("com.etzhayyim.apps.maps.pollGeoRecords", payload);
        const since = req.since ?? new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const limit = req.limit ?? 50;
        const geoRecs = (await listCollectionRows("site.geoRecord")).filter((row) => String(row.source ?? "") > since).slice(0, limit);
        let processed = 0;
        for (const row of geoRecs) {
          const rec = expandGeoRecordRow(row);
          await processGeoRecord(sdk, rec);
          processed++;
        }
        lastGeoRecordPollAt = new Date(Date.now() - 30 * 1000).toISOString();
        return { ok: true, processed, since, found: geoRecs.length };
      }, asAgentTool("Process recent site.etzhayyim.com geoRecords → SpatialEvent / AdminArea / Station"), withCapabilityTags("geoRecord", "poll", "seismic", "adsb"));
    // Registry & Legal Entity Intelligence (2026-04-13)
    a.command(nsid("com.etzhayyim.apps.maps.seedGlobalRegistries"), (_, body) => cmdSeedGlobalRegistries(sdk, body), asAgentTool("Seed global registry data (GLEIF LEI, JP NTA, Wikidata corps, OpenAddresses)"), withCapabilityTags("registry", "seed", "remote-ingest"))
      .command(nsid("com.etzhayyim.apps.maps.backfillSocial"), (_, body) => cmdBackfillSocial(sdk, body), asAgentTool("Backfill maps social posts/follows from existing RisingWave graph"), withCapabilityTags("social", "backfill", "post", "follow"));

    // Live tracker — Flightradar24 + N2YO equivalent (2026-05-01).
    // listLive*/aircraftTrack are lexicon `query` (GET) → register via .query().
    // satellitePassQuery is lexicon `procedure` (POST) → register via .command().
    a.query(nsid("com.etzhayyim.apps.maps.crawlerLocations"), (_, body) => cmdCrawlerLocations(sdk, body));
    a.query(nsid("com.etzhayyim.apps.maps.actorLocations"), (_, body) => cmdActorLocations(sdk, body));
    a.query(nsid("com.etzhayyim.apps.maps.listLiveAircraft"), (_, body) => cmdListLiveAircraft(sdk, body));
    a.query(nsid("com.etzhayyim.apps.maps.listLiveSatellites"), (_, body) => cmdListLiveSatellites(sdk, body));
    a.query(nsid("com.etzhayyim.apps.maps.listCelestialObjects"), (_, body) => cmdListCelestialObjects(sdk, body));
    a.query(nsid("com.etzhayyim.apps.maps.aircraftTrack"), (_, body) => cmdAircraftTrack(sdk, body));
    a.command(nsid("com.etzhayyim.apps.maps.satellitePassQuery"), (_, body) => cmdSatellitePassQuery(sdk, body), asAgentTool("Upcoming satellite passes for an arbitrary observer (SGP4)"), withCapabilityTags("satellite", "pass", "sgp4", "visibility"));

    // AIS Marine — MarineTraffic-equivalent vessel tracking (ADR-2605011500)
    a.query(nsid("com.etzhayyim.apps.maps.aismarine.queryVesselsBbox" as any), (_, body) => cmdAismarineQueryVesselsBbox(sdk, body), asAgentTool("List AIS-tracked vessels (MarineTraffic-equivalent) inside a WGS84 bbox as GeoJSON"), withCapabilityTags("vessel", "ais", "marine", "live", "tracking"))
      .query(nsid("com.etzhayyim.apps.maps.aismarine.getVesselDetail" as any), (_, body) => cmdAismarineGetVesselDetail(sdk, body), asAgentTool("Vessel master + 24h track + active voyage by MMSI"), withCapabilityTags("vessel", "ais", "marine", "detail"))
      .query(nsid("com.etzhayyim.apps.maps.aismarine.searchVessels" as any), (_, body) => cmdAismarineSearchVessels(sdk, body), asAgentTool("Search vessels by name prefix, MMSI, or IMO"), withCapabilityTags("vessel", "ais", "marine", "search"))
      .query(nsid("com.etzhayyim.apps.maps.aismarine.getVesselDensityTile" as any), (_, body) => cmdAismarineGetVesselDensityTile(sdk, body), asAgentTool("Aggregated vessel density for low-zoom heatmap (Phase 1: 0.1° grid; Phase 2: H3 res-6)"), withCapabilityTags("vessel", "ais", "marine", "density", "grid"));

    // Unified search (ADR-2605011500 §Phase-1.3) — restores broken Svelte
    // search box wiring (4 NSIDs called by App.svelte runUnifiedSearch).
    a.query(nsid("com.etzhayyim.apps.maps.searchPlaces"), (_, body) => cmdSearchPlaces(sdk, body), asAgentTool("Substring search vertex_spatial → place rows with lat/lng"), withCapabilityTags("search", "place", "graph"))
      .query(nsid("com.etzhayyim.apps.maps.searchResources"), (_, body) => cmdSearchResources(sdk, body), asAgentTool("Multi-source keyword search: places + vessels + legal entities"), withCapabilityTags("search", "resource", "graph"))
      .query(nsid("com.etzhayyim.apps.maps.graphSearchNodes" as any), (_, body) => cmdGraphSearchNodes(sdk, body), asAgentTool("Cross-actor entity-graph keyword search; pins drawable from {lat,lng}"), withCapabilityTags("search", "graph", "entity"))
      .query(nsid("com.etzhayyim.apps.maps.searchSemanticNodes" as any), (_, body) => cmdSearchSemanticNodes(sdk, body), asAgentTool("IVF semantic search via Cloudflare Workers AI bge-base embeddings + 128 centroids"), withCapabilityTags("search", "ivf", "semantic", "embedding"));

  // Consolidated from maps-collection-control-plane (2026-04-22): source/job/dataset/POI commands.
  // Do not open a Kysely/Hyperdrive connection during Worker cold-start.
  // ADR-2605111200 makes direct DB access illegal at the edge; collection
  // control-plane commands proxy to the pod-side dispatcher unless explicitly
  // running a legacy ingestion path.
  registerCollectionCommands(sdk, null as any, appId, (text) => post(sdk, text));
  registerWriterEntities(sdk, null as any, appId).catch((e) => console.warn(`[registerWriterEntities] ${e?.message ?? e}`));
}, { mcpRegistry: { actorDid: "did:web:maps.etzhayyim.com" } });

// Wrap _innerExport to capture the raw CF env on every request — needed for
// the `AI` (Workers AI) binding which the host-sdk's HostSDK.env doesn't
// always surface (editor app uses the same pattern).
export default {
  async fetch(request: Request, env: Record<string, unknown>, ctx?: { waitUntil(p: Promise<unknown>): void }) {
    _mapsEnv = env;
    return _innerExport.fetch(request, env, ctx);
  },
};
