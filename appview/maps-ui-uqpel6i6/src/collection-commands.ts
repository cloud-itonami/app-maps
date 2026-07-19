// Ported from maps-collection-control-plane-v1m9k2q8 (2026-04-22 consolidation).
// Source/Job/Dataset + OSM/Wikidata POI import commands.
import {
  asAgentTool, withCapabilityTags, withOCELEvent,
  str, nowISO, genID, nsid, parseLexiconInput,
  sql,
  type HostSDK,
} from "@etzhayyim/kotodama-host-sdk";
import { projectToVertexSpatial } from "./vertex-spatial-projection";

// ── Local helpers (self-contained) ───────────────────────────────────────

type Db = ReturnType<HostSDK["env"]["HYPERDRIVE" & keyof HostSDK["env"]] extends infer _ ? any : any>;

function mapsActorDid(appId: string): string {
  return `did:web:${appId}.etzhayyim.com`;
}

async function writeSpatial(db: any, appId: string, entity: string, rec: Record<string, unknown>): Promise<void> {
  const { row } = projectToVertexSpatial(mapsActorDid(appId), entity, rec);
  try {
    await db.insertInto("vertex_spatial" as any).values(row as any).execute();
  } catch (err: any) {
    // RisingWave does not parse `ON CONFLICT ... DO UPDATE` in raw SQL.
    // PRIMARY KEY enforcement is "first write wins"; retries on the same
    // vertex_id surface as a duplicate-key error — ignore. Anything else
    // re-throws so real failures are not silently dropped.
    const msg = String(err?.message ?? err);
    if (!/duplicate|unique|primary key|already exists|23505/i.test(msg)) throw err;
  }
}

// Batched version: 1 multi-VALUES INSERT for N rows instead of N single-row
// round-trips. 15-30x faster on Hyperdrive for typical N=50-100 dispatch
// batches. Duplicate-key errors still surface as first-write-wins; on batch
// conflict we retry each row individually so the rest commit.
async function writeSpatialBatch(db: any, appId: string, entity: string, recs: Record<string, unknown>[]): Promise<number> {
  if (recs.length === 0) return 0;
  const did = mapsActorDid(appId);
  const rows = recs.map((r) => projectToVertexSpatial(did, entity, r).row) as any[];
  try {
    await db.insertInto("vertex_spatial" as any).values(rows).execute();
    return rows.length;
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (!/duplicate|unique|primary key|already exists|23505/i.test(msg)) throw err;
    // A row in the batch collided — fall back to per-row inserts so that
    // the non-colliding rows still commit. (RisingWave doesn't support
    // ON CONFLICT DO NOTHING in multi-row INSERT.)
    let written = 0;
    for (const r of recs) {
      try {
        await writeSpatial(db, appId, entity, r);
        written += 1;
      } catch { /* ignore per-row errors after fallback; silent dupe drops */ }
    }
    return written;
  }
}

// ── Writer Entities (source sub-DIDs) ───────────────────────────────────

interface WriterEntity {
  sourceId: string; name: string; did: string; url: string; dataType: string; license: string;
}
function buildWriters(appId: string): WriterEntity[] {
  return [
    { sourceId: "src-osm", name: "OpenStreetMap", did: `did:web:${appId}.etzhayyim.com:source:osm`, url: "https://overpass-api.de/api/interpreter", dataType: "poi", license: "ODbL" },
    { sourceId: "src-wikidata", name: "Wikidata", did: `did:web:${appId}.etzhayyim.com:source:wikidata`, url: "https://query.wikidata.org/sparql", dataType: "poi", license: "CC0" },
  ];
}

let writersRegistered = false;
export async function registerWriterEntities(sdk: HostSDK, db: any, appId: string): Promise<void> {
  if (writersRegistered) return;
  const writers = buildWriters(appId);
  for (const w of writers) {
    try {
      const slug = `source:${w.sourceId.replace("src-", "")}`;
      const did = str(sdk.hostImports.comAtprotoIdentityCreate(slug, JSON.stringify({
        displayName: w.name,
        description: `${w.name} data source for maps.etzhayyim.com (${w.license} license)`,
        dataType: w.dataType, license: w.license,
      })));
      if (did) w.did = did;
      await writeSpatial(db, appId, "source", {
        sourceId: w.sourceId, name: w.name, url: w.url,
        sourceType: "api", dataType: w.dataType, license: w.license,
        crawlIntervalMin: 60, enabled: 1, writerDid: w.did,
        nodeLabel: "MapsSource",
        orgId: "anon", userId: "anon", actorId: w.did,
      });
    } catch (e: any) { console.warn(`[registerWriterEntities] ${w.sourceId}: ${e?.message ?? e}`); }
  }
  writersRegistered = true;
}

// ── POI parsing (OSM Overpass + Wikidata SPARQL) ─────────────────────────

interface POI {
  poiId: string; osmId: string; name: string; category: string; subcategory: string;
  lat: number; lon: number; address: string; phone: string; website: string;
  openingHours: string; wheelchair: string; sourceDid: string; collectedAt: string;
  orgId: string; userId: string; actorId: string;
}

const OSM_POI_TYPES: Record<string, string> = {
  restaurant: '["amenity"="restaurant"]', cafe: '["amenity"="cafe"]', bar: '["amenity"="bar"]',
  fastFood: '["amenity"="fastFood"]', hotel: '["tourism"="hotel"]', hostel: '["tourism"="hostel"]',
  motel: '["tourism"="motel"]', guestHouse: '["tourism"="guestHouse"]',
  supermarket: '["shop"="supermarket"]', convenience: '["shop"="convenience"]',
  clothes: '["shop"="clothes"]', bakery: '["shop"="bakery"]',
  pharmacy: '["amenity"="pharmacy"]', hospital: '["amenity"="hospital"]',
  clinic: '["amenity"="clinic"]', dentist: '["amenity"="dentist"]',
  school: '["amenity"="school"]', university: '["amenity"="university"]',
  library: '["amenity"="library"]', museum: '["tourism"="museum"]',
  park: '["leisure"="park"]', playground: '["leisure"="playground"]',
  fuel: '["amenity"="fuel"]', parking: '["amenity"="parking"]',
  atm: '["amenity"="atm"]', bank: '["amenity"="bank"]',
  postOffice: '["amenity"="postOffice"]', police: '["amenity"="police"]',
  fireStation: '["amenity"="fireStation"]', placeOfWorship: '["amenity"="placeOfWorship"]',
  cinema: '["amenity"="cinema"]', theatre: '["amenity"="theatre"]',
  swimmingPool: '["leisure"="swimmingPool"]', sportsCentre: '["leisure"="sportsCentre"]',
  viewpoint: '["tourism"="viewpoint"]', attraction: '["tourism"="attraction"]',
};

function osmCategoryFromTags(tags: Record<string, string>): { category: string; subcategory: string } {
  if (tags.amenity) return { category: "amenity", subcategory: tags.amenity };
  if (tags.shop) return { category: "shop", subcategory: tags.shop };
  if (tags.tourism) return { category: "tourism", subcategory: tags.tourism };
  if (tags.leisure) return { category: "leisure", subcategory: tags.leisure };
  if (tags.office) return { category: "office", subcategory: tags.office };
  if (tags.craft) return { category: "craft", subcategory: tags.craft };
  return { category: "other", subcategory: "unknown" };
}

function parseOverpassResponse(body: string, sourceDid: string): POI[] {
  let data: { elements?: Array<Record<string, unknown>> };
  try { data = JSON.parse(body); } catch { return []; }
  if (!data.elements) return [];
  const pois: POI[] = [];
  for (const el of data.elements) {
    const tags = (el.tags ?? {}) as Record<string, string>;
    if (!tags.name) continue;
    const lat = Number(el.lat ?? (el.center as Record<string, number>)?.lat ?? 0);
    const lon = Number(el.lon ?? (el.center as Record<string, number>)?.lon ?? 0);
    if (lat === 0 && lon === 0) continue;
    const { category, subcategory } = osmCategoryFromTags(tags);
    const addr = [tags["addr:housenumber"], tags["addr:street"], tags["addr:city"], tags["addr:postcode"], tags["addr:country"]].filter(Boolean).join(", ");
    pois.push({
      poiId: genID("poi"), osmId: `${el.type}/${el.id}`, name: tags.name,
      category, subcategory, lat, lon, address: addr,
      phone: tags.phone ?? tags["contact:phone"] ?? "",
      website: tags.website ?? tags["contact:website"] ?? "",
      openingHours: tags.openingHours ?? "", wheelchair: tags.wheelchair ?? "",
      sourceDid, collectedAt: nowISO(),
      orgId: "anon", userId: "anon", actorId: sourceDid,
    });
  }
  return pois;
}

function parseWikidataResponse(body: string, sourceDid: string): POI[] {
  let data: { results?: { bindings?: Array<Record<string, { value?: string; type?: string }>> } };
  try { data = JSON.parse(body); } catch { return []; }
  if (!data.results?.bindings) return [];
  const pois: POI[] = [];
  for (const b of data.results.bindings) {
    const name = b.itemLabel?.value ?? "";
    if (!name) continue;
    const lat = Number(b.lat?.value ?? 0);
    const lon = Number(b.lon?.value ?? 0);
    if (lat === 0 && lon === 0) continue;
    const wid = b.item?.value?.replace("http://www.wikidata.org/entity/", "") ?? "";
    pois.push({
      poiId: genID("poi"),
      osmId: b.osmId?.value ? `relation/${b.osmId.value}` : `wikidata/${wid}`,
      name, category: "wikidata", subcategory: "entity", lat, lon, address: "",
      phone: b.phone?.value ?? "", website: b.website?.value ?? "",
      openingHours: "", wheelchair: "",
      sourceDid, collectedAt: nowISO(),
      orgId: "anon", userId: "anon", actorId: sourceDid,
    });
  }
  return pois;
}

// ── Street-chunk job stage helpers ──────────────────────────────────────

const STREET_CHUNK_STAGE_ORDER = [
  "sequence_select", "frame_admit", "chunk_assign", "coverage_score",
  "reconstruct", "bake", "publish",
] as const;

function normalizeStreetChunkStage(value: unknown): string {
  const stage = str(value);
  return (STREET_CHUNK_STAGE_ORDER as readonly string[]).includes(stage) ? stage : "sequence_select";
}
function stageIndex(stage: string): number {
  const idx = (STREET_CHUNK_STAGE_ORDER as readonly string[]).indexOf(stage);
  return idx >= 0 ? idx + 1 : 1;
}
function parseFiniteNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
function toDbTimestamp(value: string): string {
  return value.replace("T", " ").replace("Z", "");
}

async function appendMapsJobEvent(db: any, actorDid: string, event: Record<string, unknown>): Promise<void> {
  const timestamp = nowISO();
  const jobId = str(event.jobId);
  await db.insertInto("vertex_maps_job" as any).values({
    vertex_id: `maps-job:${jobId}:${genID("evt")}`,
    _seq: Date.now(),
    created_date: toDbTimestamp(timestamp),
    owner_did: actorDid, rkey: jobId, repo: actorDid,
    label: "MapsJob", did: actorDid,
    name: jobId, display_name: jobId, category: "MapsJob",
    status: str(event.status),
    job_id: jobId,
    source_id: str(event.sourceId) || undefined,
    dataset_type: str(event.datasetType) || undefined,
    region: str(event.region) || undefined,
    priority: str(event.priority) || undefined,
    phase: parseFiniteNumber(event.phase),
    stage: str(event.stage) || undefined,
    progress_pct: parseFiniteNumber(event.progressPct),
    pipeline_type: str(event.pipelineType) || undefined,
    sequence_id: str(event.sequenceId) || undefined,
    chunk_key: str(event.chunkKey) || undefined,
    chunk_size_meters: parseFiniteNumber(event.chunkSizeMeters),
    bbox_json: event.bboxJson == null ? undefined : str(event.bboxJson),
    stage_order_json: event.stageOrderJson == null ? undefined : str(event.stageOrderJson),
    coverage_threshold_ratio: parseFiniteNumber(event.coverageThresholdRatio),
    heading_threshold_deg: parseFiniteNumber(event.headingThresholdDeg),
    frame_threshold_count: parseFiniteNumber(event.frameThresholdCount),
    frame_count: parseFiniteNumber(event.frameCount),
    records_count: parseFiniteNumber(event.recordsCount),
    coverage_ratio: parseFiniteNumber(event.coverageRatio),
    heading_span_deg: parseFiniteNumber(event.headingSpanDeg),
    view_cluster_count: parseFiniteNumber(event.viewClusterCount),
    occlusion_risk: parseFiniteNumber(event.occlusionRisk),
    dynamic_object_risk: parseFiniteNumber(event.dynamicObjectRisk),
    recommended_chunk_class: str(event.recommendedChunkClass) || undefined,
    error_message: str(event.errorMessage) || undefined,
    props: JSON.stringify(event),
    created_at: str(event.createdAt) || timestamp,
    updated_at: str(event.updatedAt) || timestamp,
  } as any).execute();
}

// ── Commands ────────────────────────────────────────────────────────────

type Ctx = { sdk: HostSDK; db: any; appId: string; post: (text: string) => void | Promise<void> };

// ── Coverage job consumer (runs pending MapsJob against external source) ─
// Fetches from Overpass / GLEIF / Wikidata, parses, writes to vertex_spatial,
// advances the MapsJob. Dispatched by SQL UDF maps_source_dispatch_kind so
// BPMN and handler share one routing table.
//
// Called by etzhayyim-root/orgs/etzhayyim/com-etzhayyim-maps/wire/bpmn/maps/runPendingCoverageJobs.bpmn every
// 3 min (multi-instance parallel, cap 5 jobs/tick).
interface MapsJobRow {
  job_id: string;
  source_id: string | null;     // holds the full source DID (cmdAdvanceCoverage sets sourceId = row.source_did)
  label: string | null;
  pipeline_type: string | null;
  bbox_json: string | null;
  status: string | null;
  stage: string | null;
}

const OVERPASS_LABEL_FILTER: Record<string, string> = {
  Building: 'way["building"]',
  Airport: 'way["aeroway"="aerodrome"]',
  Station: 'node["railway"="station"]',
  Port: 'node["harbour"="yes"]',
  Road: 'way["highway"~"motorway|trunk|primary|secondary"]',
  Railway: 'way["railway"="rail"]',
  AdminArea: 'relation["boundary"="administrative"]["admin_level"~"^(4|6|7)$"]',
  EvCharger: 'node["amenity"="charging_station"]',
  InfraSegment: 'way["man_made"~"pipeline|water_well|water_tower"]',
  Waterway: 'way["waterway"~"river|canal|stream"]',
  River: 'way["waterway"="river"]',
  Mountain: 'node["natural"="peak"]',
  BusStop: 'node["highway"="bus_stop"]',
  Parking: 'way["amenity"="parking"]',
  PowerLine: 'way["power"="line"]',
  Pipeline: 'way["man_made"="pipeline"]',
  Substation: 'node["power"="substation"]',
  Cemetery: 'way["landuse"="cemetery"]',
  Monument: 'node["historic"~"memorial|monument"]',
  Hospital: 'node["amenity"="hospital"]',
  School: 'node["amenity"="school"]',
  Museum: 'node["tourism"="museum"]',
  Cafe: 'node["amenity"="cafe"]',
  Restaurant: 'node["amenity"="restaurant"]',
  Hotel: 'node["tourism"="hotel"]',
  Bank: 'node["amenity"="bank"]',
  PostOffice: 'node["amenity"="post_office"]',
  Pharmacy: 'node["amenity"="pharmacy"]',
  Supermarket: 'node["shop"="supermarket"]',
  Cinema: 'node["amenity"="cinema"]',
  Library: 'node["amenity"="library"]',
  Park: 'way["leisure"="park"]',
  Viewpoint: 'node["tourism"="viewpoint"]',
  GolfCourse: 'way["leisure"="golf_course"]',
  Zoo: 'way["tourism"="zoo"]',
  SportsCentre: 'node["leisure"="sports_centre"]',
  Kindergarten: 'node["amenity"="kindergarten"]',
  Marketplace: 'node["amenity"="marketplace"]',
  FireStation: 'node["amenity"="fire_station"]',
  PoliceStation: 'node["amenity"="police"]',
  Beach: 'way["natural"="beach"]',
  // Phase 23 — 10 landuse / area filters (structural — no name required)
  Forest: 'way["landuse"="forest"]',
  Industrial: 'way["landuse"="industrial"]',
  Commercial: 'way["landuse"="commercial"]',
  Residential: 'way["landuse"="residential"]',
  Farmland: 'way["landuse"="farmland"]',
  Wood: 'way["natural"="wood"]',
  Grass: 'way["landuse"="grass"]',
  Meadow: 'way["landuse"="meadow"]',
  Village: 'node["place"="village"]',
  Hamlet: 'node["place"="hamlet"]',
  // Phase 29 — 10 industrial / religious / historic filters
  PowerPlant: 'way["power"="plant"]',
  WindTurbine: 'node["generator:source"="wind"]',
  SolarFarm: 'way["generator:source"="solar"]',
  Antenna: 'node["man_made"="antenna"]',
  Mosque: 'way["amenity"="place_of_worship"]["religion"="muslim"]',
  Synagogue: 'way["amenity"="place_of_worship"]["religion"="jewish"]',
  Ruins: 'way["historic"="ruins"]',
  Castle: 'way["historic"="castle"]',
  Archaeological: 'way["historic"="archaeological_site"]',
  MilitaryBase: 'way["landuse"="military"]',
  // Phase 31 — 10 emergency / shop filters
  FireHydrant: 'node["emergency"="fire_hydrant"]',
  Defibrillator: 'node["emergency"="defibrillator"]',
  EmergencyPhone: 'node["emergency"="phone"]',
  ShopClothes: 'node["shop"="clothes"]',
  ShopBooks: 'node["shop"="books"]',
  ShopFurniture: 'node["shop"="furniture"]',
  ShopElectronics: 'node["shop"="electronics"]',
  BikeShop: 'node["shop"="bicycle"]',
  Optician: 'node["shop"="optician"]',
  JewelryShop: 'node["shop"="jewelry"]',
  // Phase 48 — 15 dense civic/education/religion/amenity filters.
  // Each label hits every mid-size city globally → high yield per Overpass call.
  University:     'way["amenity"="university"]',
  College:        'way["amenity"="college"]',
  TownHall:       'node["amenity"="townhall"]',
  Courthouse:     'node["amenity"="courthouse"]',
  Embassy:        'node["amenity"="embassy"]',
  FerryTerminal:  'node["amenity"="ferry_terminal"]',
  Toilets:        'node["amenity"="toilets"]',
  FastFood:       'node["amenity"="fast_food"]',
  Bar:            'node["amenity"="bar"]',
  Nightclub:      'node["amenity"="nightclub"]',
  Church:         'way["amenity"="place_of_worship"]["religion"="christian"]',
  BuddhistTemple: 'way["amenity"="place_of_worship"]["religion"="buddhist"]',
  Shrine:         'way["amenity"="place_of_worship"]["religion"="shinto"]',
  HinduTemple:    'way["amenity"="place_of_worship"]["religion"="hindu"]',
  SikhTemple:     'way["amenity"="place_of_worship"]["religion"="sikh"]',
};

const AMENITY_MAP: Record<string, string> = {
  hospital: "Hospital", school: "School", cafe: "Cafe", restaurant: "Restaurant",
  pharmacy: "Pharmacy", bank: "Bank", post_office: "PostOffice", cinema: "Cinema",
  library: "Library", fire_station: "FireStation", police: "PoliceStation",
  clinic: "Clinic", dentist: "Dentist", veterinary: "Veterinary",
  fountain: "FountainOsm", kindergarten: "Kindergarten", marketplace: "Marketplace",
  bicycle_parking: "BikeParking",
};
const TOURISM_MAP: Record<string, string> = {
  hotel: "Hotel", museum: "Museum", gallery: "ArtGallery", viewpoint: "Viewpoint",
};
const SHOP_MAP: Record<string, string> = {
  supermarket: "Supermarket", clothes: "ShopClothes", books: "ShopBooks",
  furniture: "ShopFurniture", electronics: "ShopElectronics", bicycle: "BikeShop",
  optician: "Optician", jewelry: "JewelryShop", hairdresser: "HairSalon",
};
const EMERGENCY_MAP: Record<string, string> = {
  defibrillator: "Defibrillator", fire_hydrant: "FireHydrant", phone: "EmergencyPhone",
};
const LEISURE_MAP: Record<string, string> = {
  sports_centre: "SportsCentre",
};
const COMPOSITE_TAG_KEYS: Array<[string, Record<string, string>]> = [
  ["amenity", AMENITY_MAP], ["tourism", TOURISM_MAP], ["shop", SHOP_MAP],
  ["emergency", EMERGENCY_MAP], ["leisure", LEISURE_MAP],
];
const COMPOSITE_LABELS = new Set<string>([
  ...Object.values(AMENITY_MAP),
  ...Object.values(TOURISM_MAP),
  ...Object.values(SHOP_MAP),
  ...Object.values(EMERGENCY_MAP),
  ...Object.values(LEISURE_MAP),
]);
function labelFromOsmTags(tags: Record<string, string>): string | null {
  for (const [key, map] of COMPOSITE_TAG_KEYS) {
    const v = tags[key];
    if (v && map[v]) return map[v];
  }
  return null;
}



// 12 JP city bboxes — rotated by job_id hash for dense Overpass coverage.
// Kobe/Kyoto default was low-density for Road/Railway/Building.
const JP_CITY_BBOXES: Array<{ name: string; west: number; south: number; east: number; north: number }> = [
  { name: "Tokyo-23ku",  west: 139.60, south: 35.53, east: 139.90, north: 35.82 },
  { name: "Osaka",       west: 135.40, south: 34.58, east: 135.65, north: 34.78 },
  { name: "Yokohama",    west: 139.55, south: 35.38, east: 139.72, north: 35.52 },
  { name: "Nagoya",      west: 136.82, south: 35.08, east: 137.00, north: 35.25 },
  { name: "Sapporo",     west: 141.25, south: 42.95, east: 141.48, north: 43.12 },
  { name: "Fukuoka",     west: 130.30, south: 33.52, east: 130.50, north: 33.65 },
  { name: "Kobe",        west: 135.10, south: 34.64, east: 135.28, north: 34.78 },
  { name: "Kyoto",       west: 135.68, south: 34.95, east: 135.83, north: 35.08 },
  { name: "Sendai",      west: 140.82, south: 38.22, east: 141.00, north: 38.35 },
  { name: "Hiroshima",   west: 132.40, south: 34.32, east: 132.55, north: 34.45 },
  { name: "Naha",        west: 127.66, south: 26.17, east: 127.75, north: 26.25 },
  { name: "Kanazawa",    west: 136.60, south: 36.52, east: 136.72, north: 36.62 },
  // International — 22 urban cores
  { name: "London",      west: -0.20,  south: 51.47, east: 0.02,   north: 51.57 },
  { name: "NYC",         west: -74.02, south: 40.70, east: -73.92, north: 40.82 },
  { name: "Paris",       west: 2.28,   south: 48.82, east: 2.42,   north: 48.90 },
  { name: "Berlin",      west: 13.35,  south: 52.48, east: 13.50,  north: 52.57 },
  { name: "Moscow",      west: 37.52,  south: 55.68, east: 37.72,  north: 55.82 },
  { name: "Shanghai",    west: 121.42, south: 31.18, east: 121.58, north: 31.30 },
  { name: "Mumbai",      west: 72.82,  south: 18.92, east: 72.94,  north: 19.08 },
  { name: "Sydney",      west: 151.17, south: -33.92, east: 151.28, north: -33.82 },
  { name: "SãoPaulo",    west: -46.72, south: -23.62, east: -46.58, north: -23.52 },
  { name: "MexicoCity",  west: -99.20, south: 19.38, east: -99.08, north: 19.48 },
  { name: "Cairo",       west: 31.22,  south: 30.02, east: 31.35,  north: 30.12 },
  { name: "Lagos",       west: 3.30,   south: 6.42,  east: 3.42,   north: 6.52 },
  { name: "Istanbul",    west: 28.95,  south: 40.98, east: 29.08,  north: 41.08 },
  { name: "BuenosAires", west: -58.48, south: -34.68, east: -58.35, north: -34.55 },
  { name: "Toronto",     west: -79.45, south: 43.62, east: -79.32, north: 43.72 },
  { name: "LosAngeles",  west: -118.32, south: 34.02, east: -118.20, north: 34.12 },
  { name: "Seoul",       west: 126.95, south: 37.52, east: 127.08, north: 37.60 },
  { name: "Singapore",   west: 103.82, south: 1.28,  east: 103.88, north: 1.32 },
  { name: "Bangkok",     west: 100.48, south: 13.72, east: 100.58, north: 13.78 },
  { name: "Rome",        west: 12.45,  south: 41.88, east: 12.52,  north: 41.93 },
  { name: "Madrid",      west: -3.72,  south: 40.40, east: -3.62,  north: 40.48 },
  { name: "Barcelona",   west: 2.14,   south: 41.37, east: 2.20,   north: 41.41 },
  // Phase 16 — 18 more mid-size cities
  { name: "Amsterdam",   west: 4.85,   south: 52.35, east: 4.95,   north: 52.40 },
  { name: "Dublin",      west: -6.30,  south: 53.33, east: -6.22,  north: 53.37 },
  { name: "Milan",       west: 9.15,   south: 45.45, east: 9.25,   north: 45.50 },
  { name: "Warsaw",      west: 20.95,  south: 52.20, east: 21.05,  north: 52.28 },
  { name: "Stockholm",   west: 18.02,  south: 59.30, east: 18.13,  north: 59.36 },
  { name: "Oslo",        west: 10.70,  south: 59.90, east: 10.80,  north: 59.94 },
  { name: "Helsinki",    west: 24.92,  south: 60.15, east: 24.98,  north: 60.20 },
  { name: "Zurich",      west: 8.50,   south: 47.35, east: 8.58,   north: 47.40 },
  { name: "Copenhagen",  west: 12.55,  south: 55.65, east: 12.62,  north: 55.70 },
  { name: "Athens",      west: 23.72,  south: 37.96, east: 23.78,  north: 38.00 },
  { name: "Lisbon",      west: -9.18,  south: 38.70, east: -9.10,  north: 38.75 },
  { name: "Vienna",      west: 16.35,  south: 48.18, east: 16.42,  north: 48.23 },
  { name: "Jakarta",     west: 106.80, south: -6.22, east: 106.88, north: -6.15 },
  { name: "KualaLumpur", west: 101.68, south: 3.12,  east: 101.75, north: 3.18 },
  { name: "Manila",      west: 120.96, south: 14.58, east: 121.02, north: 14.62 },
  { name: "Taipei",      west: 121.52, south: 25.02, east: 121.58, north: 25.08 },
  { name: "Delhi",       west: 77.18,  south: 28.60, east: 77.28,  north: 28.68 },
  { name: "Tehran",      west: 51.38,  south: 35.68, east: 51.48,  north: 35.76 },
  // Phase 22 — 12 more bboxes (Oceania / LatAm / Africa / Central Asia)
  { name: "Auckland",    west: 174.70, south: -36.88, east: 174.82, north: -36.82 },
  { name: "Lima",        west: -77.05, south: -12.10, east: -76.95, north: -12.02 },
  { name: "Bogota",      west: -74.10, south: 4.60,   east: -74.00, north: 4.72 },
  { name: "Caracas",     west: -66.93, south: 10.45,  east: -66.85, north: 10.52 },
  { name: "Santiago",    west: -70.70, south: -33.48, east: -70.60, north: -33.40 },
  { name: "Johannesburg",west: 28.00,  south: -26.25, east: 28.10,  north: -26.15 },
  { name: "Nairobi",     west: 36.78,  south: -1.32,  east: 36.88,  north: -1.24 },
  { name: "Casablanca",  west: -7.65,  south: 33.55,  east: -7.55,  north: 33.62 },
  { name: "Accra",       west: -0.25,  south: 5.52,   east: -0.15,  north: 5.62 },
  { name: "Dakar",       west: -17.50, south: 14.65,  east: -17.42, north: 14.72 },
  { name: "Dhaka",       west: 90.37,  south: 23.73,  east: 90.47,  north: 23.82 },
  { name: "Astana",      west: 71.40,  south: 51.10,  east: 71.52,  north: 51.18 },
  // Phase 24 — 16 more bboxes (Eastern Europe / Caucasus / Central Asia / South Asia / SE Asia)
  { name: "Kiev",        west: 30.45,  south: 50.42,  east: 30.58,  north: 50.48 },
  { name: "Krakow",      west: 19.93,  south: 50.05,  east: 19.98,  north: 50.08 },
  { name: "Belgrade",    west: 20.42,  south: 44.80,  east: 20.50,  north: 44.82 },
  { name: "Minsk",       west: 27.52,  south: 53.88,  east: 27.62,  north: 53.95 },
  { name: "Riga",        west: 24.08,  south: 56.92,  east: 24.18,  north: 56.98 },
  { name: "Tallinn",     west: 24.72,  south: 59.42,  east: 24.78,  north: 59.45 },
  { name: "Vilnius",     west: 25.25,  south: 54.68,  east: 25.32,  north: 54.72 },
  { name: "Tbilisi",     west: 44.77,  south: 41.70,  east: 44.82,  north: 41.73 },
  { name: "Yerevan",     west: 44.48,  south: 40.17,  east: 44.55,  north: 40.22 },
  { name: "Baku",        west: 49.82,  south: 40.37,  east: 49.90,  north: 40.42 },
  { name: "Almaty",      west: 76.90,  south: 43.22,  east: 76.98,  north: 43.28 },
  { name: "Tashkent",    west: 69.20,  south: 41.28,  east: 69.30,  north: 41.34 },
  { name: "UB",          west: 106.88, south: 47.88,  east: 106.98, north: 47.95 },
  { name: "Kathmandu",   west: 85.30,  south: 27.68,  east: 85.35,  north: 27.72 },
  { name: "Colombo",     west: 79.83,  south: 6.90,   east: 79.88,  north: 6.96 },
  { name: "PhnomPenh",   west: 104.90, south: 11.55,  east: 104.95, north: 11.58 },
  // Phase 27 — 20 more bboxes (European mid-size + Asian mega cities)
  { name: "Budapest",    west: 19.03,  south: 47.48,  east: 19.10,  north: 47.52 },
  { name: "Sofia",       west: 23.30,  south: 42.68,  east: 23.35,  north: 42.72 },
  { name: "Bucharest",   west: 26.08,  south: 44.42,  east: 26.15,  north: 44.45 },
  { name: "Reykjavik",   west: -21.95, south: 64.12,  east: -21.80, north: 64.16 },
  { name: "Edinburgh",   west: -3.22,  south: 55.94,  east: -3.15,  north: 55.97 },
  { name: "Marseille",   west: 5.35,   south: 43.28,  east: 5.42,   north: 43.32 },
  { name: "Birmingham",  west: -1.92,  south: 52.46,  east: -1.86,  north: 52.50 },
  { name: "Cologne",     west: 6.92,   south: 50.92,  east: 6.98,   north: 50.96 },
  { name: "Munich",      west: 11.54,  south: 48.13,  east: 11.60,  north: 48.16 },
  { name: "Hamburg",     west: 9.98,   south: 53.55,  east: 10.03,  north: 53.58 },
  { name: "Frankfurt",   west: 8.66,   south: 50.10,  east: 8.72,   north: 50.14 },
  { name: "Turin",       west: 7.65,   south: 45.06,  east: 7.70,   north: 45.08 },
  { name: "Florence",    west: 11.24,  south: 43.76,  east: 11.28,  north: 43.78 },
  { name: "Naples",      west: 14.24,  south: 40.83,  east: 14.28,  north: 40.86 },
  { name: "Seville",     west: -5.99,  south: 37.38,  east: -5.96,  north: 37.40 },
  { name: "Valencia",    west: -0.40,  south: 39.46,  east: -0.36,  north: 39.48 },
  { name: "Porto",       west: -8.64,  south: 41.14,  east: -8.59,  north: 41.16 },
  { name: "Chengdu",     west: 104.05, south: 30.65,  east: 104.10, north: 30.68 },
  { name: "HongKong",    west: 114.15, south: 22.28,  east: 114.20, north: 22.32 },
  { name: "Kaohsiung",   west: 120.28, south: 22.62,  east: 120.34, north: 22.65 },
  // Phase 30 — 20 specialty bboxes (arctic / desert / island / mountain / rural)
  { name: "Svalbard",    west: 15.60,  south: 78.20,  east: 15.75,  north: 78.25 },  // arctic
  { name: "Greenland",   west: -51.72, south: 64.15,  east: -51.68, north: 64.20 },  // Nuuk
  { name: "Alaska-Anc",  west: -149.95, south: 61.18, east: -149.85, north: 61.25 },
  { name: "Novosibirsk", west: 82.88,  south: 54.98,  east: 82.98,  north: 55.08 },  // Siberia
  { name: "Yakutsk",     west: 129.70, south: 62.00,  east: 129.78, north: 62.05 },  // deep Siberia
  { name: "Irkutsk",     west: 104.28, south: 52.28,  east: 104.35, north: 52.33 },
  { name: "Vladivostok", west: 131.88, south: 43.10,  east: 131.95, north: 43.15 },
  { name: "Galapagos",   west: -90.32, south: -0.76,  east: -90.28, north: -0.72 },  // remote island
  { name: "EasterIsland",west: -109.43,south: -27.15, east: -109.40,north: -27.12 },
  { name: "Falklands",   west: -57.87, south: -51.70, east: -57.82, north: -51.66 },  // Stanley
  { name: "Reykjavik-S", west: -19.92, south: 63.45,  east: -19.86, north: 63.48 },  // Selfoss
  { name: "Tamanrasset", west: 5.52,   south: 22.77,  east: 5.56,   north: 22.80 },  // Sahara
  { name: "Hami",        west: 93.48,  south: 42.80,  east: 93.55,  north: 42.85 },  // Gobi
  { name: "SanPedro",    west: -68.21, south: -22.92, east: -68.17, north: -22.88 },  // Atacama
  { name: "Lhasa",       west: 91.10,  south: 29.62,  east: 91.18,  north: 29.68 },  // Himalaya
  { name: "Gilgit",      west: 74.28,  south: 35.90,  east: 74.34,  north: 35.95 },  // K2 area
  { name: "Honolulu",    west: -157.88, south: 21.30, east: -157.82, north: 21.33 },
  { name: "CapeTown",    west: 18.40,  south: -33.95, east: 18.48,  north: -33.90 },
  { name: "Wellington",  west: 174.76, south: -41.30, east: 174.80, north: -41.27 },
  { name: "Hobart",      west: 147.30, south: -42.90, east: 147.36, north: -42.86 },  // Tasmania
  // Phase 45 restoration — 24 more bboxes (Oceania / LatAm / Africa / Asia)
  { name: "Hanoi",       west: 105.82, south: 21.00,  east: 105.88, north: 21.05 },
  { name: "HoChiMinh",   west: 106.68, south: 10.76,  east: 106.72, north: 10.80 },
  { name: "Yangon",      west: 96.14,  south: 16.80,  east: 96.18,  north: 16.84 },
  { name: "Vientiane",   west: 102.60, south: 17.96,  east: 102.64, north: 18.00 },
  { name: "PortMoresby", west: 147.12, south: -9.48,  east: 147.18, north: -9.42 },
  { name: "Suva",        west: 178.42, south: -18.16, east: 178.46, north: -18.12 },
  { name: "Doha",        west: 51.52,  south: 25.27,  east: 51.55,  north: 25.30 },
  { name: "Amman",       west: 35.90,  south: 31.95,  east: 35.96,  north: 31.98 },
  { name: "Beirut",      west: 35.48,  south: 33.88,  east: 35.54,  north: 33.92 },
  { name: "Baghdad",     west: 44.36,  south: 33.30,  east: 44.42,  north: 33.34 },
  { name: "Lima",        west: -77.05, south: -12.10, east: -76.95, north: -12.02 },
  { name: "Bogota",      west: -74.10, south: 4.60,   east: -74.00, north: 4.72 },
  { name: "Santiago",    west: -70.70, south: -33.48, east: -70.60, north: -33.40 },
  { name: "Johannesburg",west: 28.00,  south: -26.25, east: 28.10,  north: -26.15 },
  { name: "Nairobi",     west: 36.78,  south: -1.32,  east: 36.88,  north: -1.24 },
  { name: "Casablanca",  west: -7.65,  south: 33.55,  east: -7.55,  north: 33.62 },
  { name: "Accra",       west: -0.25,  south: 5.52,   east: -0.15,  north: 5.62 },
  { name: "Dakar",       west: -17.50, south: 14.65,  east: -17.42, north: 14.72 },
  { name: "Dhaka",       west: 90.37,  south: 23.73,  east: 90.47,  north: 23.82 },
  { name: "Astana",      west: 71.40,  south: 51.10,  east: 71.52,  north: 51.18 },
  { name: "Auckland",    west: 174.70, south: -36.88, east: 174.82, north: -36.82 },
  { name: "CapeTown",    west: 18.40,  south: -33.95, east: 18.48,  north: -33.90 },
  { name: "Wellington",  west: 174.76, south: -41.30, east: 174.80, north: -41.27 },
  { name: "Hobart",      west: 147.30, south: -42.90, east: 147.36, north: -42.86 },
];

// Systematic bbox rotation — time + hash cyclic.
function cyclicBboxIdx(jobId: string): number {
  const timeTick = Math.floor(Date.now() / 12000);
  return (timeTick + hashString(jobId)) % JP_CITY_BBOXES.length;
}

const DEFAULT_BBOX_JP = JP_CITY_BBOXES[0]; // Tokyo fallback (dense).

async function cmdRunCoverageJob(ctx: Ctx, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.maps.runCoverageJob", payload) as Record<string, unknown>;
  if (!req.jobId) return { error: "jobId required" };
  const jobId = str(req.jobId);
  const maxRecords = Math.max(1, Math.min(Number(req.maxRecords ?? 100), 500));

  // 1. Load the pending job.
  const jobRes = await sql<MapsJobRow>`
    SELECT job_id, source_id, label, pipeline_type, bbox_json, status, stage
      FROM vertex_maps_job
     WHERE job_id = ${jobId}
     ORDER BY created_date DESC NULLS LAST
     LIMIT 1
  `.execute(ctx.db);
  const job = (jobRes.rows ?? [])[0] as MapsJobRow | undefined;
  if (!job) return { jobId, status: "error", error: "job not found" };
  if (job.status === "done" || job.status === "error") {
    return { jobId, status: "skipped", dispatchKind: "already-terminal", recordsWritten: 0 };
  }

  const sourceDid = job.source_id ?? "";
  // vertex_maps_job.label is always "MapsJob" (the node label of the job row
  // itself). The *ingest* label (what we're collecting — LegalEntity / Airport
  // / Building / ...) lives on vertex_maps_coverage_target. Resolve it via
  // source_did so runtime branching and social posts use the real label.
  let label = "";
  if (sourceDid) {
    // Pick the target most recently bumped — cmdAdvanceCoverage set
    // last_fetched_at on the exact row it picked, so this resolves to
    // the correct label even when multiple targets share a source_did
    // (e.g. infrastructure:{Building, Airport, Port, AdminArea, ...}).
    const labelRes = await sql<{ label: string }>`
      SELECT label FROM vertex_maps_coverage_target
       WHERE source_did = ${sourceDid}
       ORDER BY last_fetched_at DESC NULLS LAST, priority_weight DESC
       LIMIT 1
    `.execute(ctx.db);
    label = (labelRes.rows?.[0] as any)?.label ?? "";
  }

  // 2. Resolve dispatch kind via the shared UDF.
  const kindRes = await sql<{ kind: string }>`
    SELECT maps_source_dispatch_kind(${sourceDid}, ${label}) AS kind
  `.execute(ctx.db);
  const dispatchKind = (kindRes.rows?.[0] as any)?.kind ?? "unsupported";

  // 3. Execute.
  let recordsWritten = 0;
  let errorMsg: string | null = null;
  try {
    if (dispatchKind === "overpass") {
      recordsWritten = await runOverpass(ctx, job, label, maxRecords);
    } else if (dispatchKind === "gleif") {
      recordsWritten = await runGleif(ctx, job, label, maxRecords);
    } else if (dispatchKind === "wikidata") {
      recordsWritten = await runWikidata(ctx, job, label, maxRecords);
    } else if (dispatchKind === "stac") {
      recordsWritten = await runStac(ctx, job, label, maxRecords);
    } else if (dispatchKind === "seismic") {
      recordsWritten = await runSeismic(ctx, job, label, maxRecords);
    } else if (dispatchKind === "mapillary") {
      recordsWritten = await runMapillary(ctx, job, label, maxRecords);
    } else if (dispatchKind === "wikipedia") {
      recordsWritten = await runWikipedia(ctx, job, label, maxRecords);
    } else if (dispatchKind === "commons") {
      recordsWritten = await runCommons(ctx, job, label, maxRecords);
    } else if (dispatchKind === "inaturalist") {
      recordsWritten = await runINaturalist(ctx, job, label, maxRecords);
    } else if (dispatchKind === "gbif") {
      recordsWritten = await runGbif(ctx, job, label, maxRecords);
    } else if (dispatchKind === "wikivoyage") {
      recordsWritten = await runWikivoyage(ctx, job, label, maxRecords);
    } else if (dispatchKind === "eonet") {
      recordsWritten = await runEonet(ctx, job, label, maxRecords);
    } else if (dispatchKind === "opensky") {
      recordsWritten = await runOpenSky(ctx, job, label, maxRecords);
    } else if (dispatchKind === "noaa_tides") {
      recordsWritten = await runNoaaTides(ctx, job, label, maxRecords);
    } else if (dispatchKind === "osm_notes") {
      recordsWritten = await runOsmNotes(ctx, job, label, maxRecords);
    } else {
      errorMsg = `dispatch_kind '${dispatchKind}' not implemented`;
    }
  } catch (err: any) {
    errorMsg = `ingest failed: ${err?.message ?? String(err)}`;
  }

  // 4. Advance the job.
  const terminalStatus = errorMsg ? "error" : "done";
  const advanceEvent = {
    jobId,
    status: terminalStatus,
    phase: errorMsg ? -1 : 6,
    stage: errorMsg ? "error" : "publish",
    progressPct: errorMsg ? 0 : 100,
    recordsCount: recordsWritten,
    errorMessage: errorMsg,
    updatedAt: nowISO(),
    nodeLabel: "MapsJob",
    orgId: "anon",
    userId: "anon",
    actorId: ctx.appId,
  };
  await writeSpatial(ctx.db, ctx.appId, "job", advanceEvent);
  await appendMapsJobEvent(ctx.db, mapsActorDid(ctx.appId), advanceEvent);

  // Productivity signal: UPDATE the frontier target with last_rows_written +
  // last_run_at. The ranked-view multiplies gap_score by a factor derived
  // from this, so consistently-0 sources get picked less often.
  if (sourceDid && label) {
    try {
      await sql`
        UPDATE vertex_maps_coverage_target
           SET last_rows_written = ${recordsWritten},
               last_run_at = NOW()
         WHERE source_did = ${sourceDid} AND label = ${label}
      `.execute(ctx.db);
    } catch { /* column may not exist yet if migration hasn't run — non-fatal */ }
  }

  if (!errorMsg && recordsWritten > 0) {
    await ctx.post(`[Coverage:run] ${dispatchKind} ${label} → +${recordsWritten} rows (${sourceDid.replace(/^did:web:maps\.etzhayyim\.ai:?/, "") || "primary"})\ncc @maps.etzhayyim.com`);
  }

  return {
    jobId, status: terminalStatus, dispatchKind,
    recordsWritten, sourceDid, label,
    ...(errorMsg ? { error: errorMsg } : {}),
  };
}

async function runOverpassComposite(ctx: Ctx, job: MapsJobRow, primaryLabel: string, maxRecords: number): Promise<number> {
  const bbox = job.bbox_json
    ? safeParseBbox(job.bbox_json)
    : JP_CITY_BBOXES[cyclicBboxIdx(job.job_id)];
  const bboxStr = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const unionParts = COMPOSITE_TAG_KEYS.map(([key, map]) => {
    const vals = Object.keys(map).join("|");
    return `node["${key}"~"^(${vals})$"](${bboxStr});`;
  }).join("");
  const cap = Math.min(maxRecords * 5, 500);
  const ql = `[out:json][timeout:30];(${unionParts});out center tags ${cap};`;
  const resp = await cachedFetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(ql)}`,
  }, 180);
  if (!resp.ok) throw new Error(`Overpass composite ${resp.status}`);
  let parsed: { elements?: Array<Record<string, any>> };
  try { parsed = JSON.parse(await resp.text()); } catch { return 0; }
  const els = parsed.elements ?? [];
  const sourceDid = job.source_id ?? `did:web:${ctx.appId}.etzhayyim.com:infrastructure`;
  let primaryWritten = 0;
  let totalWritten = 0;
  for (const el of els) {
    if (totalWritten >= cap) break;
    const tags = (el.tags ?? {}) as Record<string, string>;
    const resolvedLabel = labelFromOsmTags(tags);
    if (!resolvedLabel) continue;
    const center = el.center as { lat?: number; lon?: number } | undefined;
    const lat = Number(el.lat ?? center?.lat ?? 0);
    const lng = Number(el.lon ?? center?.lon ?? 0);
    if (lat === 0 && lng === 0) continue;
    const osmType = String(el.type ?? "");
    const osmId = String(el.id ?? "");
    if (!osmType || !osmId) continue;
    await writeSpatial(ctx.db, ctx.appId, "poi", {
      poiId: `osm:${osmType}/${osmId}`,
      osmId: `${osmType}/${osmId}`,
      name: tags.name ?? `${resolvedLabel}-${osmId}`,
      category: resolvedLabel.toLowerCase(),
      subcategory: resolvedLabel,
      lat, lon: lng,
      address: "",
      phone: tags.phone ?? "", website: tags.website ?? "", openingHours: tags.opening_hours ?? "",
      wheelchair: tags.wheelchair ?? "",
      sourceDid,
      collectedAt: nowISO(),
      orgId: "anon", userId: "anon", actorId: sourceDid,
      nodeLabel: resolvedLabel,
      label: resolvedLabel,
      jobId: job.job_id,
    });
    totalWritten += 1;
    if (resolvedLabel === primaryLabel) primaryWritten += 1;
  }
  return primaryWritten;
}

async function runOverpass(ctx: Ctx, job: MapsJobRow, coverageLabel: string, maxRecords: number): Promise<number> {
  const label = coverageLabel || job.label || "Building";
  if (COMPOSITE_LABELS.has(label)) {
    return await runOverpassComposite(ctx, job, label, maxRecords);
  }
  const filter = OVERPASS_LABEL_FILTER[label];
  if (!filter) throw new Error(`no Overpass filter for label '${label}'`);
  // Rotate through 12 JP city bboxes by job_id hash — Kobe/Kyoto default
  // was low-density, producing 0 rows for Building/Road/Railway. Any
  // explicit job.bbox_json still wins.
  const bbox = job.bbox_json
    ? safeParseBbox(job.bbox_json)
    : JP_CITY_BBOXES[cyclicBboxIdx(job.job_id)];
  const bboxStr = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const kind = filter.startsWith("node") ? "node" : filter.startsWith("way") ? "way" : "rel";
  // Relations (AdminArea, etc) have no explicit lat/lon on the element itself —
  // need `out center` to get the computed centroid. Way/node can use `out geom tags`.
  const outClause = kind === "rel"
    ? `out center tags ${maxRecords};`
    : `out geom tags ${maxRecords};`;
  const ql = `[out:json][timeout:25];(${filter.replace(/^(node|way|rel(ation)?)/, kind)}(${bboxStr}););${outClause}`;
  const resp = await cachedFetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(ql)}`,
  });
  if (!resp.ok) throw new Error(`Overpass ${resp.status}`);
  const body = await resp.text();
  const sourceDid = job.source_id ?? `did:web:${ctx.appId}.etzhayyim.com:infrastructure`;

  // parseOverpassResponse skips elements without `tags.name` (POI-style).
  // For structural labels (Building / Road / Railway / Waterway / AdminArea /
  // InfraSegment / EvCharger / Parking) most OSM elements are un-named —
  // use the osm ref as stable identifier instead.
  const NAMED_LABELS = new Set(["Airport", "Station", "Port", "BusStop", "Mountain", "Hospital", "School", "Museum", "Cafe", "Restaurant", "Hotel", "Bank", "PostOffice", "Pharmacy", "Supermarket", "Cinema", "Library", "Viewpoint", "SportsCentre", "Kindergarten", "Marketplace", "FireStation", "PoliceStation"]);
  if (NAMED_LABELS.has(label)) {
    const pois = parseOverpassResponse(body, sourceDid);
    for (const poi of pois.slice(0, maxRecords)) {
      await writeSpatial(ctx.db, ctx.appId, "poi", { ...poi, nodeLabel: label, jobId: job.job_id, label });
    }
    return Math.min(pois.length, maxRecords);
  }

  let parsed: { elements?: Array<Record<string, any>> };
  try { parsed = JSON.parse(body); } catch { return 0; }
  const els = parsed.elements ?? [];
  let written = 0;
  for (const el of els) {
    if (written >= maxRecords) break;
    const tags = (el.tags ?? {}) as Record<string, string>;
    const center = el.center as { lat?: number; lon?: number } | undefined;
    const geomFirst = Array.isArray(el.geometry) && el.geometry.length > 0 ? el.geometry[0] : null;
    const lat = Number(el.lat ?? center?.lat ?? geomFirst?.lat ?? 0);
    const lng = Number(el.lon ?? center?.lon ?? geomFirst?.lon ?? 0);
    if (lat === 0 && lng === 0) continue;
    const osmType = String(el.type ?? "");
    const osmId = String(el.id ?? "");
    if (!osmType || !osmId) continue;
    await writeSpatial(ctx.db, ctx.appId, "poi", {
      poiId: `osm:${osmType}/${osmId}`,
      osmId: `${osmType}/${osmId}`,
      name: tags.name ?? `${label}-${osmId}`,
      category: label.toLowerCase(),
      subcategory: label,
      lat, lon: lng,
      address: "",
      phone: "", website: "", openingHours: "", wheelchair: "",
      sourceDid,
      collectedAt: nowISO(),
      orgId: "anon", userId: "anon", actorId: sourceDid,
      nodeLabel: label,
      label,
      jobId: job.job_id,
    });
    written += 1;
  }
  return written;
}

async function runGleif(ctx: Ctx, job: MapsJobRow, _coverageLabel: string, maxRecords: number): Promise<number> {
  // Pagination by (job_id, minute-bucket) hash — covers GLEIF's ~2.5M LEI
  // catalog at 200 records/page × up to 12,500 pages. Mixing a 10-minute
  // bucket keeps stable-for-retry within a cycle but drifts over time so
  // repeated picks of the same (source, label) gradually sweep the catalog.
  const minuteBucket = Math.floor(Date.now() / (10 * 60_000));
  const combined = hashString(`${job.job_id}|${minuteBucket}`);
  const page = 1 + (combined % 10_000);
  const size = Math.min(maxRecords, 200);
  const url = `https://api.gleif.org/api/v1/lei-records?page%5Bnumber%5D=${page}&page%5Bsize%5D=${size}`;
  const resp = await cachedFetch(url, { headers: { Accept: "application/vnd.api+json" } });
  if (!resp.ok) throw new Error(`GLEIF ${resp.status}`);
  const body = (await resp.json()) as any;
  const items: any[] = Array.isArray(body?.data) ? body.data : [];
  const sourceDid = job.source_id ?? "did:web:maps.etzhayyim.com:registry:gleif";
  let written = 0;
  for (const it of items) {
    const attrs = it?.attributes ?? {};
    const entity = attrs?.entity ?? {};
    const legalName = entity?.legalName?.name ?? entity?.legalName ?? "";
    if (!legalName) continue;
    const lei = it?.id ?? attrs?.lei ?? "";
    if (!lei) continue;
    const hq = entity?.headquartersAddress ?? entity?.legalAddress ?? {};
    await writeSpatial(ctx.db, ctx.appId, "legalEntity", {
      entityId: `lei:${lei}`,
      lei,
      name: String(legalName),
      entityType: entity?.category ?? "Corporation",
      jurisdiction: entity?.jurisdiction ?? hq?.country ?? "",
      country: hq?.country ?? "",
      nodeLabel: "LegalEntity",
      label: "LegalEntity",
      sourceDid,
      jobId: job.job_id,
    });
    written += 1;
  }
  return written;
}

async function runMapillary(ctx: Ctx, job: MapsJobRow, _coverageLabel: string, maxRecords: number): Promise<number> {
  // Mapillary v4 Graph API — https://graph.mapillary.com/images
  // Requires MAPILLARY_ACCESS_TOKEN from env (configured in kotodama.jsonld).
  const token = (ctx.sdk.env as any)?.MAPILLARY_ACCESS_TOKEN;
  if (!token) throw new Error("MAPILLARY_ACCESS_TOKEN missing in env");
  // Mapillary bbox must be tiny (few km²) — 500 error otherwise. Shrink
  // a JP_CITY_BBOXES center to ±0.01° (~1km square).
  const seed = job.bbox_json
    ? safeParseBbox(job.bbox_json)
    : JP_CITY_BBOXES[cyclicBboxIdx(job.job_id)];
  const cLat = (seed.south + seed.north) / 2;
  const cLng = (seed.west + seed.east) / 2;
  const d = 0.01;
  const bboxStr = `${cLng - d},${cLat - d},${cLng + d},${cLat + d}`;
  const limit = Math.min(maxRecords, 200);
  const url = `https://graph.mapillary.com/images?access_token=${encodeURIComponent(token)}&bbox=${bboxStr}&limit=${limit}&fields=id,captured_at,geometry,compass_angle,sequence`;
  const resp = await cachedFetch(url);
  if (!resp.ok) throw new Error(`Mapillary ${resp.status}`);
  const data = (await resp.json()) as any;
  const imgs: any[] = Array.isArray(data?.data) ? data.data : [];
  const sourceDid = job.source_id ?? "did:web:maps.etzhayyim.com:street_view";
  let written = 0;
  for (const im of imgs) {
    if (written >= maxRecords) break;
    const mid = String(im?.id ?? "");
    if (!mid) continue;
    const coords = im?.geometry?.coordinates ?? [];
    const lng = typeof coords[0] === "number" ? coords[0] : 0;
    const lat = typeof coords[1] === "number" ? coords[1] : 0;
    if (lat === 0 && lng === 0) continue;
    await writeSpatial(ctx.db, ctx.appId, "poi", {
      poiId: `mly:${mid}`,
      osmId: `mapillary/${mid}`,
      name: `StreetChunk-${mid}`,
      category: "street_view",
      subcategory: "StreetChunk",
      lat, lon: lng,
      address: "",
      phone: "", website: "", openingHours: "", wheelchair: "",
      sourceDid,
      collectedAt: im?.captured_at ? new Date(Number(im.captured_at)).toISOString() : nowISO(),
      orgId: "anon", userId: "anon", actorId: sourceDid,
      nodeLabel: "StreetChunk",
      label: "StreetChunk",
      jobId: job.job_id,
      sequenceId: im?.sequence ?? "",
      headingDeg: typeof im?.compass_angle === "number" ? im.compass_angle : null,
    });
    written += 1;
  }
  return written;
}

async function runWikipedia(ctx: Ctx, job: MapsJobRow, _coverageLabel: string, maxRecords: number): Promise<number> {
  // MediaWiki GeoSearch — ~14M geotagged articles across Wikipedia.
  // Zero auth. Language variant selectable via source_did suffix:
  //   did:web:maps.etzhayyim.com:wikipedia        → en.wikipedia.org
  //   did:web:maps.etzhayyim.com:wikipedia:ja     → ja.wikipedia.org
  //   did:web:maps.etzhayyim.com:wikipedia:{lang} → {lang}.wikipedia.org
  const src = job.source_id ?? "";
  const m = /did:web:maps\.etzhayyim\.ai:wikipedia(?::(\w+))?/.exec(src);
  const lang = m?.[1] ?? "en";
  const bbox = job.bbox_json
    ? safeParseBbox(job.bbox_json)
    : JP_CITY_BBOXES[cyclicBboxIdx(job.job_id)];
  // geosearch uses center + radius (max 10000m). Compute city center.
  const cLat = (bbox.south + bbox.north) / 2;
  const cLng = (bbox.west + bbox.east) / 2;
  const limit = Math.min(maxRecords, 500);
  const url = `https://${lang}.wikipedia.org/w/api.php?format=json&origin=*&action=query&list=geosearch&gsradius=10000&gscoord=${cLat}%7C${cLng}&gslimit=${limit}`;
  const resp = await cachedFetch(url, {
    headers: { Accept: "application/json", "User-Agent": "etzhayyim-maps-coverage/1.0 (contact@etzhayyim.com)" },
  });
  if (!resp.ok) throw new Error(`Wikipedia ${resp.status}`);
  const data = (await resp.json()) as any;
  const hits: any[] = data?.query?.geosearch ?? [];
  const sourceDid = src || "did:web:maps.etzhayyim.com:wikipedia";
  let written = 0;
  for (const h of hits) {
    if (written >= maxRecords) break;
    const pageid = Number(h?.pageid ?? 0);
    if (!pageid) continue;
    const title = String(h?.title ?? "");
    if (!title) continue;
    const lat = Number(h?.lat ?? 0);
    const lng = Number(h?.lon ?? 0);
    if (lat === 0 && lng === 0) continue;
    await writeSpatial(ctx.db, ctx.appId, "poi", {
      poiId: `wp:${lang}:${pageid}`,
      osmId: `wikipedia/${lang}/${pageid}`,
      name: title,
      category: "wikipedia",
      subcategory: `${lang}-article`,
      lat, lon: lng,
      address: "",
      phone: "", website: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
      openingHours: "", wheelchair: "",
      sourceDid,
      collectedAt: nowISO(),
      orgId: "anon", userId: "anon", actorId: sourceDid,
      nodeLabel: "Spot",
      label: "Spot",
      jobId: job.job_id,
    });
    written += 1;
  }
  return written;
}

// CF Cache API wrapper — TTL-keyed memoization of upstream fetches.
// Reduces duplicate API pressure when 1-min CronJob picks similar (bbox,
// source) combos. Key = sha256(method+url+body), cached at CF edge.
async function cachedFetch(url: string, init?: RequestInit, ttlSec = 300): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  const bodyStr = init?.body == null ? "" : (typeof init.body === "string" ? init.body : String(init.body));
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${method}|${url}|${bodyStr}`));
  const digest = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
  const keyReq = new Request(`https://maps-cache.etzhayyim.com/x/${digest}`, { method: "GET" });
  const cache = (caches as any).default;
  if (cache) {
    const hit = await cache.match(keyReq);
    if (hit) return hit;
  }
  const resp = await fetch(url, init);
  if (resp.ok && cache) {
    try {
      const cloned = resp.clone();
      const headers = new Headers(resp.headers);
      headers.set("Cache-Control", `public, max-age=${ttlSec}`);
      const cacheable = new Response(cloned.body, { status: resp.status, headers });
      void cache.put(keyReq, cacheable).catch(() => { /* swallow */ });
    } catch { /* non-critical */ }
  }
  return resp;
}

async function fetchWithBackoff(url: string, init: RequestInit, attempts = 2, backoffMs = 2000): Promise<Response> {
  let last: Response | undefined;
  for (let i = 0; i < attempts; i++) {
    const r = await fetch(url, init);
    // Retry on 429 (rate limit) AND 5xx upstream errors (CF 522 / 502 / 503 / 504).
    if (r.status !== 429 && !(r.status >= 500 && r.status <= 599)) return r;
    last = r;
    if (i < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, backoffMs * (i + 1)));
    }
  }
  return last as Response;
}

async function runEonet(ctx: Ctx, job: MapsJobRow, _coverageLabel: string, maxRecords: number): Promise<number> {
  // NASA EONET — Natural Event Observer Tracker. Returns ~500 active
  // events globally (wildfires/storms/volcanos/seaLakeIce/etc) with
  // geometries over time. Zero auth.
  const limit = Math.min(maxRecords, 200);
  // Category filter via source_did suffix — else get all categories.
  const src = job.source_id ?? "";
  const m = /did:web:maps\.etzhayyim\.ai:eonet(?::(\w+))?/.exec(src);
  const cat = m?.[1];
  const catParam = cat ? `&category=${encodeURIComponent(cat)}` : "";
  const url = `https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=${limit}${catParam}`;
  const resp = await cachedFetch(url, {
    headers: { Accept: "application/json", "User-Agent": "etzhayyim-maps-coverage/1.0 (contact@etzhayyim.com)" },
  });
  if (!resp.ok) throw new Error(`EONET ${resp.status}`);
  const data = (await resp.json()) as any;
  const events: any[] = data?.events ?? [];
  const sourceDid = src || "did:web:maps.etzhayyim.com:eonet";
  let written = 0;
  for (const ev of events) {
    if (written >= maxRecords) break;
    const eid = String(ev?.id ?? "");
    if (!eid) continue;
    // Most-recent geometry point.
    const geoms = Array.isArray(ev?.geometry) ? ev.geometry : [];
    const g = geoms[geoms.length - 1];
    if (!g) continue;
    let lat = 0, lng = 0;
    if (Array.isArray(g?.coordinates) && g.coordinates.length >= 2) {
      lng = Number(g.coordinates[0]);
      lat = Number(g.coordinates[1]);
    }
    if (lat === 0 && lng === 0) continue;
    const categoryTitle = (ev?.categories ?? [])[0]?.title ?? "natural_event";
    await writeSpatial(ctx.db, ctx.appId, "spatialEvent", {
      eventId: `eonet:${eid}`,
      eventType: categoryTitle,
      place: ev?.title ?? "",
      lat, lng,
      occurredAt: g?.date ? new Date(g.date).toISOString() : nowISO(),
      url: (ev?.sources ?? [])[0]?.url ?? "",
      label: "SpatialEvent",
      nodeLabel: "SpatialEvent",
      sourceDid,
      jobId: job.job_id,
    });
    written += 1;
  }
  return written;
}

async function runNoaaTides(ctx: Ctx, job: MapsJobRow, _coverageLabel: string, maxRecords: number): Promise<number> {
  // NOAA CO-OPS stations metadata — ~3K tide/current stations globally
  // (mostly US coasts + Pacific). Zero-auth JSON.
  const url = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions";
  const resp = await cachedFetch(url, {
    headers: { Accept: "application/json", "User-Agent": "etzhayyim-maps-coverage/1.0 (contact@etzhayyim.com)" },
  });
  if (!resp.ok) throw new Error(`NOAA Tides ${resp.status}`);
  const data = (await resp.json()) as any;
  const stations: any[] = data?.stations ?? [];
  // Cap per-call to 50 — writeSpatial×N sequential takes ~50ms each,
  // 200 overran the XRPC 45s timeout budget.
  const chunk = Math.min(maxRecords, 50);
  const offset = (hashString(job.job_id) % Math.max(1, Math.ceil(stations.length / chunk))) * chunk;
  const window = stations.slice(offset, offset + chunk);
  const sourceDid = job.source_id ?? "did:web:maps.etzhayyim.com:noaa_tides";
  let written = 0;
  for (const st of window) {
    if (written >= maxRecords) break;
    const id = String(st?.id ?? "");
    if (!id) continue;
    const lat = Number(st?.lat ?? 0);
    const lng = Number(st?.lng ?? 0);
    if (lat === 0 && lng === 0) continue;
    await writeSpatial(ctx.db, ctx.appId, "poi", {
      poiId: `noaa:${id}`,
      osmId: `noaa/${id}`,
      name: String(st?.name ?? `NOAA-${id}`),
      category: "tidestation",
      subcategory: String(st?.state ?? ""),
      lat, lon: lng,
      address: "",
      phone: "", website: `https://tidesandcurrents.noaa.gov/stationhome.html?id=${id}`,
      openingHours: "", wheelchair: "",
      sourceDid,
      collectedAt: nowISO(),
      orgId: "anon", userId: "anon", actorId: sourceDid,
      nodeLabel: "Station",
      label: "Station",
      jobId: job.job_id,
    });
    written += 1;
  }
  return written;
}

async function runOpenSky(ctx: Ctx, job: MapsJobRow, _coverageLabel: string, maxRecords: number): Promise<number> {
  // OpenSky Network — live ADS-B aircraft positions. State vectors
  // returned as array-of-arrays: [icao24, callsign, origin_country,
  //   time_position, last_contact, longitude, latitude, baro_altitude,
  //   on_ground, velocity, heading, vertical_rate, sensors, geo_altitude,
  //   squawk, spi, position_source]. Zero-auth dev tier (~4000 call/day).
  const bbox = job.bbox_json
    ? safeParseBbox(job.bbox_json)
    : JP_CITY_BBOXES[cyclicBboxIdx(job.job_id)];
  const url = `https://opensky-network.org/api/states/all?lamin=${bbox.south}&lomin=${bbox.west}&lamax=${bbox.north}&lomax=${bbox.east}`;
  // OpenSky returns 522 (CF upstream timeout) intermittently. fetchWithBackoff
  // retries once with a 3s gap so heartbeat cycles aren't wasted on transient hits.
  const resp = await fetchWithBackoff(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "etzhayyim-maps-coverage/1.0 (contact@etzhayyim.com; +https://maps.etzhayyim.com)",
    },
  }, 2, 3000);
  if (!resp.ok) throw new Error(`OpenSky ${resp.status}`);
  const data = (await resp.json()) as any;
  const states: any[] = Array.isArray(data?.states) ? data.states : [];
  const sourceDid = job.source_id ?? "did:web:maps.etzhayyim.com:opensky";
  let written = 0;
  for (const s of states) {
    if (written >= maxRecords) break;
    if (!Array.isArray(s) || s.length < 7) continue;
    const icao24 = String(s[0] ?? "").trim();
    const callsign = String(s[1] ?? "").trim();
    const country = String(s[2] ?? "");
    const lng = Number(s[5]);
    const lat = Number(s[6]);
    const alt = typeof s[7] === "number" ? s[7] : null;
    if (!icao24 || !isFinite(lat) || !isFinite(lng)) continue;
    if (lat === 0 && lng === 0) continue;
    await writeSpatial(ctx.db, ctx.appId, "poi", {
      poiId: `opensky:${icao24}`,
      osmId: `opensky/${icao24}`,
      name: callsign || icao24,
      category: "aircraft",
      subcategory: country,
      lat, lon: lng,
      address: "",
      phone: "", website: "https://opensky-network.org/aircraft-profile?icao24=" + icao24,
      openingHours: "", wheelchair: "",
      sourceDid,
      collectedAt: nowISO(),
      orgId: "anon", userId: "anon", actorId: sourceDid,
      nodeLabel: "Aircraft",
      label: "Aircraft",
      jobId: job.job_id,
      altitudeM: alt,
    });
    written += 1;
  }
  return written;
}

async function runWikivoyage(ctx: Ctx, job: MapsJobRow, _coverageLabel: string, maxRecords: number): Promise<number> {
  // Wikivoyage geosearch — travel articles with coordinates. API identical
  // to Wikipedia but on wikivoyage.org (per language). ~30K–100K geotagged
  // articles across all languages (en dominates).
  const src = job.source_id ?? "";
  const m = /did:web:maps\.etzhayyim\.ai:wikivoyage(?::(\w+))?/.exec(src);
  const lang = m?.[1] ?? "en";
  const bbox = job.bbox_json
    ? safeParseBbox(job.bbox_json)
    : JP_CITY_BBOXES[cyclicBboxIdx(job.job_id)];
  const cLat = (bbox.south + bbox.north) / 2;
  const cLng = (bbox.west + bbox.east) / 2;
  const limit = Math.min(maxRecords, 500);
  const url = `https://${lang}.wikivoyage.org/w/api.php?format=json&origin=*&action=query&list=geosearch&gsradius=10000&gscoord=${cLat}%7C${cLng}&gslimit=${limit}`;
  const resp = await cachedFetch(url, {
    headers: { Accept: "application/json", "User-Agent": "etzhayyim-maps-coverage/1.0 (contact@etzhayyim.com)" },
  });
  if (!resp.ok) throw new Error(`Wikivoyage ${resp.status}`);
  const data = (await resp.json()) as any;
  const hits: any[] = data?.query?.geosearch ?? [];
  const sourceDid = src || "did:web:maps.etzhayyim.com:wikivoyage";
  let written = 0;
  for (const h of hits) {
    if (written >= maxRecords) break;
    const pageid = Number(h?.pageid ?? 0);
    const title = String(h?.title ?? "");
    if (!pageid || !title) continue;
    const lat = Number(h?.lat ?? 0);
    const lng = Number(h?.lon ?? 0);
    if (lat === 0 && lng === 0) continue;
    await writeSpatial(ctx.db, ctx.appId, "poi", {
      poiId: `wv:${lang}:${pageid}`,
      osmId: `wikivoyage/${lang}/${pageid}`,
      name: title,
      category: "wikivoyage",
      subcategory: `${lang}-travel`,
      lat, lon: lng,
      address: "",
      phone: "", website: `https://${lang}.wikivoyage.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
      openingHours: "", wheelchair: "",
      sourceDid,
      collectedAt: nowISO(),
      orgId: "anon", userId: "anon", actorId: sourceDid,
      nodeLabel: "Spot",
      label: "Spot",
      jobId: job.job_id,
    });
    written += 1;
  }
  return written;
}

async function runGbif(ctx: Ctx, job: MapsJobRow, _coverageLabel: string, maxRecords: number): Promise<number> {
  // GBIF species occurrences — 2B+ records, zero-auth, bbox filter.
  const bbox = job.bbox_json
    ? safeParseBbox(job.bbox_json)
    : JP_CITY_BBOXES[cyclicBboxIdx(job.job_id)];
  const per = Math.min(maxRecords, 300);
  const offset = (hashString(job.job_id) % 100) * per;
  const url = `https://api.gbif.org/v1/occurrence/search?decimalLatitude=${bbox.south},${bbox.north}&decimalLongitude=${bbox.west},${bbox.east}&hasCoordinate=true&limit=${per}&offset=${offset}`;
  const resp = await cachedFetch(url, {
    headers: { Accept: "application/json", "User-Agent": "etzhayyim-maps-coverage/1.0 (contact@etzhayyim.com)" },
  });
  if (!resp.ok) throw new Error(`GBIF ${resp.status}`);
  const data = (await resp.json()) as any;
  const occs: any[] = data?.results ?? [];
  const sourceDid = job.source_id ?? "did:web:maps.etzhayyim.com:gbif";
  let written = 0;
  for (const o of occs) {
    if (written >= maxRecords) break;
    const key = String(o?.key ?? o?.gbifID ?? "");
    if (!key) continue;
    const lat = Number(o?.decimalLatitude ?? 0);
    const lng = Number(o?.decimalLongitude ?? 0);
    if (lat === 0 && lng === 0) continue;
    const species = o?.species ?? o?.scientificName ?? `Occurrence-${key}`;
    await writeSpatial(ctx.db, ctx.appId, "poi", {
      poiId: `gbif:${key}`,
      osmId: `gbif/${key}`,
      name: String(species).slice(0, 120),
      category: "biodiversity",
      subcategory: o?.kingdom ?? "occurrence",
      lat, lon: lng,
      address: "",
      phone: "", website: `https://www.gbif.org/occurrence/${key}`,
      openingHours: "", wheelchair: "",
      sourceDid,
      collectedAt: o?.eventDate ?? nowISO(),
      orgId: "anon", userId: "anon", actorId: sourceDid,
      nodeLabel: "Spot",
      label: "Spot",
      jobId: job.job_id,
    });
    written += 1;
  }
  return written;
}

async function runINaturalist(ctx: Ctx, job: MapsJobRow, _coverageLabel: string, maxRecords: number): Promise<number> {
  // iNaturalist observations API — ~200M globally, zero-auth, bbox query.
  // Wrapped with 2-attempt 2s-backoff on 429 (their rate limit is
  // per-IP and CF edge IPs are shared, so even 1-per-heartbeat gets hit
  // when the shared IP has fired recently from another Worker).
  const bbox = job.bbox_json
    ? safeParseBbox(job.bbox_json)
    : JP_CITY_BBOXES[cyclicBboxIdx(job.job_id)];
  const per = Math.min(maxRecords, 200);
  const page = 1 + (hashString(job.job_id) % 50);
  const url = `https://api.inaturalist.org/v1/observations?swlat=${bbox.south}&swlng=${bbox.west}&nelat=${bbox.north}&nelng=${bbox.east}&per_page=${per}&page=${page}&order=desc&order_by=observed_on&quality_grade=research`;
  const resp = await fetchWithBackoff(url, {
    headers: { Accept: "application/json", "User-Agent": "etzhayyim-maps-coverage/1.0 (contact@etzhayyim.com)" },
  });
  if (!resp.ok) throw new Error(`iNaturalist ${resp.status}`);
  const data = (await resp.json()) as any;
  const obs: any[] = data?.results ?? [];
  const sourceDid = job.source_id ?? "did:web:maps.etzhayyim.com:inaturalist";
  let written = 0;
  for (const o of obs) {
    if (written >= maxRecords) break;
    const oid = String(o?.id ?? "");
    if (!oid) continue;
    // location is "lat,lng" string OR geojson.coordinates [lng, lat]
    let lat = 0, lng = 0;
    if (o?.location && typeof o.location === "string") {
      const [la, lo] = o.location.split(",").map((s: string) => Number(s.trim()));
      if (isFinite(la) && isFinite(lo)) { lat = la; lng = lo; }
    }
    if (lat === 0 && lng === 0 && Array.isArray(o?.geojson?.coordinates)) {
      lng = Number(o.geojson.coordinates[0] ?? 0);
      lat = Number(o.geojson.coordinates[1] ?? 0);
    }
    if (lat === 0 && lng === 0) continue;
    const species = o?.species_guess ?? o?.taxon?.name ?? `Observation-${oid}`;
    await writeSpatial(ctx.db, ctx.appId, "poi", {
      poiId: `inat:${oid}`,
      osmId: `inaturalist/${oid}`,
      name: String(species).slice(0, 120),
      category: "biodiversity",
      subcategory: o?.taxon?.iconic_taxon_name ?? "observation",
      lat, lon: lng,
      address: "",
      phone: "", website: `https://www.inaturalist.org/observations/${oid}`,
      openingHours: "", wheelchair: "",
      sourceDid,
      collectedAt: o?.observed_on ? new Date(o.observed_on).toISOString() : nowISO(),
      orgId: "anon", userId: "anon", actorId: sourceDid,
      nodeLabel: "Spot",
      label: "Spot",
      jobId: job.job_id,
    });
    written += 1;
  }
  return written;
}

async function runCommons(ctx: Ctx, job: MapsJobRow, _coverageLabel: string, maxRecords: number): Promise<number> {
  // Wikimedia Commons geosearch — gsnamespace=6 (File: namespace) for
  // geotagged media. ~11M images with coordinates across the commons.
  const bbox = job.bbox_json
    ? safeParseBbox(job.bbox_json)
    : JP_CITY_BBOXES[cyclicBboxIdx(job.job_id)];
  const cLat = (bbox.south + bbox.north) / 2;
  const cLng = (bbox.west + bbox.east) / 2;
  const limit = Math.min(maxRecords, 500);
  const url = `https://commons.wikimedia.org/w/api.php?format=json&origin=*&action=query&list=geosearch&gsnamespace=6&gsradius=10000&gscoord=${cLat}%7C${cLng}&gslimit=${limit}`;
  const resp = await cachedFetch(url, {
    headers: { Accept: "application/json", "User-Agent": "etzhayyim-maps-coverage/1.0 (contact@etzhayyim.com)" },
  });
  if (!resp.ok) throw new Error(`Commons ${resp.status}`);
  const data = (await resp.json()) as any;
  const hits: any[] = data?.query?.geosearch ?? [];
  const sourceDid = job.source_id ?? "did:web:maps.etzhayyim.com:commons";
  let written = 0;
  for (const h of hits) {
    if (written >= maxRecords) break;
    const pageid = Number(h?.pageid ?? 0);
    if (!pageid) continue;
    const title = String(h?.title ?? "");
    if (!title) continue;
    const lat = Number(h?.lat ?? 0);
    const lng = Number(h?.lon ?? 0);
    if (lat === 0 && lng === 0) continue;
    await writeSpatial(ctx.db, ctx.appId, "poi", {
      poiId: `commons:${pageid}`,
      osmId: `commons/${pageid}`,
      name: title.replace(/^File:/, "").replace(/\.(jpg|jpeg|png|svg|webp|tif|tiff|gif)$/i, ""),
      category: "commons",
      subcategory: "media",
      lat, lon: lng,
      address: "",
      phone: "", website: `https://commons.wikimedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
      openingHours: "", wheelchair: "",
      sourceDid,
      collectedAt: nowISO(),
      orgId: "anon", userId: "anon", actorId: sourceDid,
      nodeLabel: "Spot",
      label: "Spot",
      jobId: job.job_id,
    });
    written += 1;
  }
  return written;
}

async function runSeismic(ctx: Ctx, job: MapsJobRow, _coverageLabel: string, maxRecords: number): Promise<number> {
  // USGS seismic feed — all variants share the same GeoJSON schema so we
  // just rotate windows/magnitudes per source_did suffix for multiplexing.
  //   :seismic            → all_hour/day/sig_week/4.5_week rotation (default)
  //   :seismic:week       → all_week (larger recent window, more rows)
  //   :seismic:month      → all_month (broadest catalog)
  //   :seismic:sig_month  → significant_month (high-magnitude only)
  //   :seismic:m6         → 4.5_month filtered to M≥6 post-parse
  const src = job.source_id ?? "";
  const m = /did:web:maps\.etzhayyim\.ai:seismic(?::(\w+))?/.exec(src);
  const kind = m?.[1] ?? "";
  const variantWindows: Record<string, string[]> = {
    "":           ["all_hour", "all_day", "significant_week", "4.5_week"],
    week:         ["all_week"],
    month:        ["all_month"],
    sig_month:    ["significant_month"],
    m6:           ["4.5_month"],
  };
  const wins = variantWindows[kind] ?? variantWindows[""];
  const w = wins[hashString(job.job_id) % wins.length];
  const url = `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/${w}.geojson`;
  const eventType = "earthquake";
  const magFloor = kind === "m6" ? 6.0 : 0;
  const resp = await cachedFetch(url);
  if (!resp.ok) throw new Error(`Seismic(${kind || "default"}) ${resp.status}`);
  const data = (await resp.json()) as any;
  const feats: any[] = Array.isArray(data?.features) ? data.features : [];
  const sourceDid = job.source_id ?? "did:web:maps.etzhayyim.com:seismic";
  let written = 0;
  for (const f of feats.slice(0, maxRecords)) {
    const props = f?.properties ?? {};
    const coords = f?.geometry?.coordinates ?? [];
    const usgsId = String(f?.id ?? "");
    if (!usgsId) continue;
    if (magFloor > 0 && !(typeof props.mag === "number" && props.mag >= magFloor)) continue;
    await writeSpatial(ctx.db, ctx.appId, "spatialEvent", {
      eventId: `usgs:${usgsId}`,
      eventType,
      magnitude: typeof props.mag === "number" ? props.mag : null,
      place: props.place ?? "",
      depth: typeof coords[2] === "number" ? coords[2] : null,
      lat: typeof coords[1] === "number" ? coords[1] : null,
      lng: typeof coords[0] === "number" ? coords[0] : null,
      occurredAt: props.time ? new Date(props.time).toISOString() : "",
      url: props.url ?? "",
      alertLevel: props.alert ?? "",
      label: "SpatialEvent",
      nodeLabel: "SpatialEvent",
      sourceDid,
      jobId: job.job_id,
    });
    written += 1;
  }
  return written;
}

async function runStac(ctx: Ctx, job: MapsJobRow, coverageLabel: string, maxRecords: number): Promise<number> {
  // Earth-Search STAC API. Collection selection:
  //   source_did suffix after `:satellite:` → explicit STAC collection id
  //   (e.g. `:satellite:landsat` → `landsat-c2l2-sr`).
  //   Falls back to label-driven default (SatelliteScene → sentinel-2-l2a,
  //   TerrainPatch → cop-dem-glo-30).
  const label = coverageLabel || "SatelliteScene";
  const src = job.source_id ?? "";
  const m = /did:web:maps\.etzhayyim\.ai:satellite:(\w[\w-]*)/.exec(src);
  const stacByKey: Record<string, string> = {
    sentinel2: "sentinel-2-l2a",
    landsat:   "landsat-c2l2-sr",
    sentinel1: "sentinel-1-grd",
    naip:      "naip",
    hls:       "hls2-l30",
  };
  const collection = m && stacByKey[m[1]]
    ? stacByKey[m[1]]
    : (label === "TerrainPatch" ? "cop-dem-glo-30" : "sentinel-2-l2a");
  // Rotate through the 28 global bboxes so each STAC call hits a different
  // city → 28x scene diversity instead of pinning on Tokyo. Explicit
  // job.bbox_json still wins.
  const bbox = job.bbox_json
    ? safeParseBbox(job.bbox_json)
    : JP_CITY_BBOXES[cyclicBboxIdx(job.job_id)];
  const size = Math.min(maxRecords, 100);
  const body = {
    collections: [collection],
    bbox: [bbox.west, bbox.south, bbox.east, bbox.north],
    limit: size,
  };
  const resp = await cachedFetch("https://earth-search.aws.element84.com/v1/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`STAC ${resp.status}`);
  const data = (await resp.json()) as any;
  const feats: any[] = Array.isArray(data?.features) ? data.features : [];
  const sourceDid = job.source_id ?? "did:web:maps.etzhayyim.com:satellite";
  let written = 0;
  for (const f of feats) {
    const sceneId = String(f?.id ?? "").slice(0, 120);
    if (!sceneId) continue;
    const geom = f?.geometry ?? {};
    const props = f?.properties ?? {};
    // Centroid: rough mean of bbox for 2D placement.
    const fbbox = Array.isArray(f?.bbox) && f.bbox.length >= 4
      ? { west: f.bbox[0], south: f.bbox[1], east: f.bbox[2], north: f.bbox[3] }
      : bbox;
    const lat = (fbbox.south + fbbox.north) / 2;
    const lng = (fbbox.west + fbbox.east) / 2;
    await writeSpatial(ctx.db, ctx.appId, "satelliteScene", {
      sceneId,
      satellite: collection,
      acquisitionDate: props?.datetime ?? "",
      cloudCover: typeof props?.["eo:cloud_cover"] === "number" ? props["eo:cloud_cover"] : null,
      lat, lng,
      label,
      nodeLabel: label,
      sourceDid,
      jobId: job.job_id,
      stacCollectionId: collection,
    });
    written += 1;
  }
  return written;
}

// Wikidata entity-type SPARQL profiles. Routing by source_did suffix:
//   did:web:maps.etzhayyim.com:registry:wikidata        → corp (default)
//   did:web:maps.etzhayyim.com:registry:wikidata:river  → Q4022 rivers
//   …etc. Each profile targets a different Wikidata instance-of class.
const WIKIDATA_PROFILES: Record<string, { qid: string; label: string; nodeKind: string }> = {
  corp:       { qid: "Q4830453", label: "LegalEntity", nodeKind: "legalEntity" },
  river:      { qid: "Q4022",    label: "River",       nodeKind: "poi" },
  mountain:   { qid: "Q8502",    label: "Mountain",    nodeKind: "poi" },
  lake:       { qid: "Q23397",   label: "Lake",        nodeKind: "poi" },
  island:     { qid: "Q23442",   label: "Spot",        nodeKind: "poi" },
  airport:    { qid: "Q62447",   label: "Airport",     nodeKind: "poi" },
  university: { qid: "Q3918",    label: "Spot",        nodeKind: "poi" },
  // Phase 13 — 8 more entity types
  volcano:    { qid: "Q8072",    label: "Mountain",    nodeKind: "poi" },
  glacier:    { qid: "Q35509",   label: "Spot",        nodeKind: "poi" },
  bridge:     { qid: "Q12280",   label: "Spot",        nodeKind: "poi" },
  dam:        { qid: "Q12323",   label: "Spot",        nodeKind: "poi" },
  castle:     { qid: "Q23413",   label: "Spot",        nodeKind: "poi" },
  monastery:  { qid: "Q44613",   label: "Spot",        nodeKind: "poi" },
  stadium:    { qid: "Q483110",  label: "Spot",        nodeKind: "poi" },
  theatre:    { qid: "Q24354",   label: "Spot",        nodeKind: "poi" },
  // Phase 16 — 10 more entity types
  railwayStation: { qid: "Q55488",  label: "Station",  nodeKind: "poi" },
  hospitalWd:     { qid: "Q16917",  label: "Hospital", nodeKind: "poi" },
  schoolWd:       { qid: "Q3914",   label: "School",   nodeKind: "poi" },
  libraryWd:      { qid: "Q7075",   label: "Library",  nodeKind: "poi" },
  government:     { qid: "Q3657186",label: "Spot",     nodeKind: "poi" },
  embassy:        { qid: "Q3917681",label: "Spot",     nodeKind: "poi" },
  prison:         { qid: "Q40357",  label: "Spot",     nodeKind: "poi" },
  cemeteryWd:     { qid: "Q39614",  label: "Cemetery", nodeKind: "poi" },
  temple:         { qid: "Q44539",  label: "Spot",     nodeKind: "poi" },
  church:         { qid: "Q16970",  label: "Spot",     nodeKind: "poi" },
  // Phase 21 — 6 more entity types
  metroStation:   { qid: "Q928830", label: "Station",  nodeKind: "poi" },
  busStation:     { qid: "Q494829", label: "Station",  nodeKind: "poi" },
  shoppingMall:   { qid: "Q11315",  label: "Spot",     nodeKind: "poi" },
  skyscraper:     { qid: "Q11303",  label: "Spot",     nodeKind: "poi" },
  lighthouse:     { qid: "Q39715",  label: "Spot",     nodeKind: "poi" },
  hotSpring:      { qid: "Q177380", label: "Spot",     nodeKind: "poi" },
  // Phase 26 — 15 more entity types
  airline:        { qid: "Q46970",   label: "Spot",    nodeKind: "poi" },
  winery:         { qid: "Q156362",  label: "Spot",    nodeKind: "poi" },
  observatory:    { qid: "Q62832",   label: "Spot",    nodeKind: "poi" },
  waterfall:      { qid: "Q34038",   label: "Spot",    nodeKind: "poi" },
  beachWd:        { qid: "Q40080",   label: "Beach",   nodeKind: "poi" },
  swimmingPool:   { qid: "Q17744811",label: "Spot",    nodeKind: "poi" },
  casino:         { qid: "Q133215",  label: "Spot",    nodeKind: "poi" },
  garden:         { qid: "Q1107656", label: "Park",    nodeKind: "poi" },
  amusementPark:  { qid: "Q194195",  label: "Park",    nodeKind: "poi" },
  resort:         { qid: "Q875157",  label: "Hotel",   nodeKind: "poi" },
  distillery:     { qid: "Q25550691",label: "Spot",    nodeKind: "poi" },
  bakeryWd:       { qid: "Q163820",  label: "Spot",    nodeKind: "poi" },
  restaurantWd:   { qid: "Q11707",   label: "Restaurant",nodeKind:"poi" },
  brewery:        { qid: "Q131734",  label: "Spot",    nodeKind: "poi" },
  monasteryVar:   { qid: "Q44613",   label: "Monument",nodeKind: "poi" },
  // Phase 29 — 20 more entity types (industrial/religious/natural geography)
  powerPlant:     { qid: "Q159719",  label: "Spot",    nodeKind: "poi" },
  nuclear:        { qid: "Q134447",  label: "Spot",    nodeKind: "poi" },
  refineryWd:     { qid: "Q165815",  label: "Spot",    nodeKind: "poi" },
  factory:        { qid: "Q83405",   label: "Spot",    nodeKind: "poi" },
  mosqueWd:       { qid: "Q32815",   label: "Spot",    nodeKind: "poi" },
  synagogueWd:    { qid: "Q34627",   label: "Spot",    nodeKind: "poi" },
  cathedral:      { qid: "Q2977",    label: "Spot",    nodeKind: "poi" },
  palace:         { qid: "Q16560",   label: "Spot",    nodeKind: "poi" },
  ruinWd:         { qid: "Q109607",  label: "Spot",    nodeKind: "poi" },
  artMuseum:      { qid: "Q207694",  label: "Museum",  nodeKind: "poi" },
  concertHall:    { qid: "Q131734",  label: "Spot",    nodeKind: "poi" },
  caveWd:         { qid: "Q35509",   label: "Spot",    nodeKind: "poi" },
  fjord:          { qid: "Q45776",   label: "Spot",    nodeKind: "poi" },
  reef:           { qid: "Q131681",  label: "Spot",    nodeKind: "poi" },
  strait:         { qid: "Q37901",   label: "Waterway",nodeKind: "poi" },
  bay:            { qid: "Q39594",   label: "Spot",    nodeKind: "poi" },
  valley:         { qid: "Q39816",   label: "Spot",    nodeKind: "poi" },
  hill:           { qid: "Q54050",   label: "Mountain",nodeKind: "poi" },
  peninsula:      { qid: "Q43742",   label: "Spot",    nodeKind: "poi" },
  isthmus:        { qid: "Q160091",  label: "Spot",    nodeKind: "poi" },
  // Phase 30 — 10 niche profiles
  plaza:          { qid: "Q174782",  label: "Spot",    nodeKind: "poi" },
  historicDist:   { qid: "Q15243209",label: "Spot",    nodeKind: "poi" },
  memorialPlace:  { qid: "Q5003624", label: "Monument",nodeKind: "poi" },
  trainLine:      { qid: "Q728937",  label: "Railway", nodeKind: "poi" },
  marina:         { qid: "Q786014",  label: "Port",    nodeKind: "poi" },
  powerSubst:     { qid: "Q174814",  label: "Spot",    nodeKind: "poi" },
  gasStation:     { qid: "Q205495",  label: "Spot",    nodeKind: "poi" },
  gate:           { qid: "Q59772",   label: "Spot",    nodeKind: "poi" },
  tower:          { qid: "Q12518",   label: "Spot",    nodeKind: "poi" },
  sportsField:    { qid: "Q1076486", label: "Spot",    nodeKind: "poi" },
  // Phase 31 — 10 commercial / cultural profiles
  musicVenue:     { qid: "Q131734",  label: "Spot",    nodeKind: "poi" },
  bookstore:      { qid: "Q213441",  label: "Spot",    nodeKind: "poi" },
  nightclub:      { qid: "Q622425",  label: "Spot",    nodeKind: "poi" },
  antiquariat:    { qid: "Q107175",  label: "Spot",    nodeKind: "poi" },
  pharmacyWd:     { qid: "Q91054",   label: "Pharmacy",nodeKind: "poi" },
  fitness:        { qid: "Q4817197", label: "SportsCentre", nodeKind: "poi" },
  radioStation:   { qid: "Q14350",   label: "Spot",    nodeKind: "poi" },
  tvStation:      { qid: "Q1616075", label: "Spot",    nodeKind: "poi" },
  bookshop:       { qid: "Q1107244", label: "Spot",    nodeKind: "poi" },
  prominentPlace: { qid: "Q618123",  label: "Spot",    nodeKind: "poi" },
  // Phase 22 — 10 more entity types
  heritage:       { qid: "Q1329623", label: "Spot",    nodeKind: "poi" },
  archSite:       { qid: "Q839954",  label: "Spot",    nodeKind: "poi" },
  natReserve:     { qid: "Q179049",  label: "Spot",    nodeKind: "poi" },
  nationalPark:   { qid: "Q46169",   label: "Spot",    nodeKind: "poi" },
  ferryTerminal:  { qid: "Q1248784", label: "Port",    nodeKind: "poi" },
  busStopWd:      { qid: "Q14890286",label: "BusStop", nodeKind: "poi" },
  protectedArea:  { qid: "Q473972",  label: "Spot",    nodeKind: "poi" },
  canal:          { qid: "Q12284",   label: "Waterway",nodeKind: "poi" },
  lightRail:      { qid: "Q2175765", label: "Railway", nodeKind: "poi" },
  subwayLine:     { qid: "Q12802",   label: "Railway", nodeKind: "poi" },
  // Phase 45 restoration — 50 profiles (iter 22/26/29/30/33/36/39/41 reconstructed)
  heritage:       { qid: "Q1329623", label: "Spot",      nodeKind: "poi" },
  archSite:       { qid: "Q839954",  label: "Spot",      nodeKind: "poi" },
  natReserve:     { qid: "Q179049",  label: "Spot",      nodeKind: "poi" },
  nationalPark:   { qid: "Q46169",   label: "Spot",      nodeKind: "poi" },
  ferryTerminal:  { qid: "Q1248784", label: "Port",      nodeKind: "poi" },
  protectedArea:  { qid: "Q473972",  label: "Spot",      nodeKind: "poi" },
  canal:          { qid: "Q12284",   label: "Waterway",  nodeKind: "poi" },
  lightRail:      { qid: "Q2175765", label: "Railway",   nodeKind: "poi" },
  subwayLine:     { qid: "Q12802",   label: "Railway",   nodeKind: "poi" },
  musicVenue:     { qid: "Q131734",  label: "Spot",      nodeKind: "poi" },
  bookstore:      { qid: "Q213441",  label: "Spot",      nodeKind: "poi" },
  nightclub:      { qid: "Q622425",  label: "Spot",      nodeKind: "poi" },
  pharmacyWd:     { qid: "Q91054",   label: "Pharmacy",  nodeKind: "poi" },
  fitness:        { qid: "Q4817197", label: "SportsCentre", nodeKind: "poi" },
  powerPlant:     { qid: "Q159719",  label: "Spot",      nodeKind: "poi" },
  nuclear:        { qid: "Q134447",  label: "Spot",      nodeKind: "poi" },
  factory:        { qid: "Q83405",   label: "Spot",      nodeKind: "poi" },
  mosqueWd:       { qid: "Q32815",   label: "Spot",      nodeKind: "poi" },
  synagogueWd:    { qid: "Q34627",   label: "Spot",      nodeKind: "poi" },
  cathedral:      { qid: "Q2977",    label: "Spot",      nodeKind: "poi" },
  palace:         { qid: "Q16560",   label: "Spot",      nodeKind: "poi" },
  artMuseum:      { qid: "Q207694",  label: "Museum",    nodeKind: "poi" },
  concertHall:    { qid: "Q131734",  label: "Spot",      nodeKind: "poi" },
  bay:            { qid: "Q39594",   label: "Spot",      nodeKind: "poi" },
  valley:         { qid: "Q39816",   label: "Spot",      nodeKind: "poi" },
  hill:           { qid: "Q54050",   label: "Mountain",  nodeKind: "poi" },
  plaza:          { qid: "Q174782",  label: "Spot",      nodeKind: "poi" },
  memorialPlace:  { qid: "Q5003624", label: "Monument",  nodeKind: "poi" },
  trainLine:      { qid: "Q728937",  label: "Railway",   nodeKind: "poi" },
  marina:         { qid: "Q786014",  label: "Port",      nodeKind: "poi" },
  gasStation:     { qid: "Q205495",  label: "Spot",      nodeKind: "poi" },
  tower:          { qid: "Q12518",   label: "Spot",      nodeKind: "poi" },
  artGalleryWd:   { qid: "Q1007870", label: "Museum",    nodeKind: "poi" },
  shrine:         { qid: "Q697295",  label: "Spot",      nodeKind: "poi" },
  warehouse:      { qid: "Q181623",  label: "Spot",      nodeKind: "poi" },
  officeBuilding: { qid: "Q1021645", label: "Spot",      nodeKind: "poi" },
  townHall:       { qid: "Q543654",  label: "Spot",      nodeKind: "poi" },
  courthouse:     { qid: "Q1137809", label: "Spot",      nodeKind: "poi" },
  chapel:         { qid: "Q108325",  label: "Spot",      nodeKind: "poi" },
  obelisk:        { qid: "Q170285",  label: "Monument",  nodeKind: "poi" },
  fountainWd:     { qid: "Q483453",  label: "Spot",      nodeKind: "poi" },
  vineyard:       { qid: "Q82652",   label: "Farmland",  nodeKind: "poi" },
  orchard:        { qid: "Q236371",  label: "Farmland",  nodeKind: "poi" },
  mine:           { qid: "Q820477",  label: "Spot",      nodeKind: "poi" },
  quarry:         { qid: "Q188040",  label: "Spot",      nodeKind: "poi" },
  evStation:      { qid: "Q14565199",label: "EvCharger", nodeKind: "poi" },
  dataCenter:     { qid: "Q1172675", label: "Spot",      nodeKind: "poi" },
  windFarm:       { qid: "Q1339622", label: "Spot",      nodeKind: "poi" },
  solarPark:      { qid: "Q1774812", label: "Spot",      nodeKind: "poi" },
  spaceport:      { qid: "Q26529",   label: "Airport",   nodeKind: "poi" },

  // Phase 47 restoration — 40 more profiles (medical/hospitality/industrial/natural)
  medicalLab:     { qid: "Q1192067", label: "Spot",      nodeKind: "poi" },
  clinicWd:       { qid: "Q16917",   label: "Clinic",    nodeKind: "poi" },
  maternityHosp:  { qid: "Q1774898", label: "Hospital",  nodeKind: "poi" },
  bedAndBreakfast:{ qid: "Q14907102",label: "Hotel",     nodeKind: "poi" },
  motelWd:        { qid: "Q57831",   label: "Hotel",     nodeKind: "poi" },
  hostelWd:       { qid: "Q56514",   label: "Hotel",     nodeKind: "poi" },
  ryokan:         { qid: "Q214554",  label: "Hotel",     nodeKind: "poi" },
  campsite:       { qid: "Q832778",  label: "Spot",      nodeKind: "poi" },
  steelMill:      { qid: "Q746071",  label: "Spot",      nodeKind: "poi" },
  paperMill:      { qid: "Q1513472", label: "Spot",      nodeKind: "poi" },
  cementPlant:    { qid: "Q1414133", label: "Spot",      nodeKind: "poi" },
  chemicalPlant:  { qid: "Q2061186", label: "Spot",      nodeKind: "poi" },
  glassFactory:   { qid: "Q865967",  label: "Spot",      nodeKind: "poi" },
  reservoirWd:    { qid: "Q131681",  label: "Lake",      nodeKind: "poi" },
  pond:           { qid: "Q3253281", label: "Lake",      nodeKind: "poi" },
  marshland:      { qid: "Q43197",   label: "Spot",      nodeKind: "poi" },
  plateau:        { qid: "Q75520",   label: "Mountain",  nodeKind: "poi" },
  tundra:         { qid: "Q43262",   label: "Spot",      nodeKind: "poi" },
  biogasPlant:    { qid: "Q2302908", label: "Spot",      nodeKind: "poi" },
  powerSubstation:{ qid: "Q174814",  label: "Spot",      nodeKind: "poi" },
  railwayYard:    { qid: "Q862571",  label: "Spot",      nodeKind: "poi" },
  dryDock:        { qid: "Q1139881", label: "Port",      nodeKind: "poi" },
  windmill:       { qid: "Q38720",   label: "Spot",      nodeKind: "poi" },
  watermill:      { qid: "Q1144549", label: "Spot",      nodeKind: "poi" },
  radioTelescope: { qid: "Q184356",  label: "Spot",      nodeKind: "poi" },
  busRoute:       { qid: "Q2085381", label: "BusRoute",  nodeKind: "poi" },
  trainLineWd:    { qid: "Q106257",  label: "Railway",   nodeKind: "poi" },
  cableCar:       { qid: "Q209465",  label: "Spot",      nodeKind: "poi" },
  funicular:      { qid: "Q200989",  label: "Spot",      nodeKind: "poi" },
  teaGarden:      { qid: "Q5499562", label: "Farmland",  nodeKind: "poi" },
  ricePaddy:      { qid: "Q55788",   label: "Farmland",  nodeKind: "poi" },
  fishery:        { qid: "Q1520691", label: "Spot",      nodeKind: "poi" },
  oilFieldWd:     { qid: "Q17145969",label: "Spot",      nodeKind: "poi" },
  saltPond:       { qid: "Q1132153", label: "Spot",      nodeKind: "poi" },
  greenhouse:     { qid: "Q170544",  label: "Spot",      nodeKind: "poi" },
  bakehouse:      { qid: "Q860661",  label: "Spot",      nodeKind: "poi" },
  streetWd:       { qid: "Q79007",   label: "Road",      nodeKind: "poi" },
  housingEstate:  { qid: "Q334454",  label: "Spot",      nodeKind: "poi" },
  pier:           { qid: "Q1133975", label: "Spot",      nodeKind: "poi" },
  historicDist:   { qid: "Q15243209",label: "Spot",      nodeKind: "poi" },

  // Phase 51 — 10 civic/education/religion Wikidata profiles. Pairs with
  // Phase 48 Overpass filters: Wikidata sweep picks up entities missing
  // coords in OSM but registered in Wikidata (historical / off-OSM).
  parliamentBldg: { qid: "Q35798",   label: "Spot",      nodeKind: "poi" },
  primarySchool:  { qid: "Q9842",    label: "Spot",      nodeKind: "poi" },
  middleSchool:   { qid: "Q149566",  label: "Spot",      nodeKind: "poi" },
  highSchoolWd:   { qid: "Q159334",  label: "Spot",      nodeKind: "poi" },
  boardingSchool: { qid: "Q376199",  label: "Spot",      nodeKind: "poi" },
  prisonWd:       { qid: "Q40357",   label: "Spot",      nodeKind: "poi" },
  gurdwara:       { qid: "Q1174356", label: "Spot",      nodeKind: "poi" },
  aquariumWd:     { qid: "Q1469",    label: "Spot",      nodeKind: "poi" },
  botanicalGarden:{ qid: "Q167346",  label: "Spot",      nodeKind: "poi" },
  basilica:       { qid: "Q163687",  label: "Spot",      nodeKind: "poi" },

  // Phase 56 — 10 more civic/transport/urban-structure profiles, chosen
  // for known dense Wikidata coord coverage (P625 populated) to avoid
  // the 0-row pattern from Phase 51.
  subwayStation:  { qid: "Q928830",  label: "Station",   nodeKind: "poi" },
  seaport:        { qid: "Q93352",   label: "Port",      nodeKind: "poi" },
  borough:        { qid: "Q22865",   label: "AdminArea", nodeKind: "poi" },
  hamletWd:       { qid: "Q5084",    label: "Spot",      nodeKind: "poi" },
  neighborhood:   { qid: "Q123705",  label: "AdminArea", nodeKind: "poi" },
  publicSquare:   { qid: "Q174782",  label: "Spot",      nodeKind: "poi" },
  skiResort:      { qid: "Q130003",  label: "Spot",      nodeKind: "poi" },
  cityPark:       { qid: "Q22698",   label: "Spot",      nodeKind: "poi" },
  shoppingCenter: { qid: "Q31374404",label: "Spot",      nodeKind: "poi" },
  policeStationWd:{ qid: "Q2971666", label: "Spot",      nodeKind: "poi" },

  // Phase 59 — 10 more historical/military/civic Wikidata profiles, same
  // pattern as Phase 56 (proven 9/10 productive for known-dense QIDs).
  battlefield:    { qid: "Q178561",  label: "Spot",      nodeKind: "poi" },
  conventionCtr:  { qid: "Q694612",  label: "Spot",      nodeKind: "poi" },
  musicSchool:    { qid: "Q860626",  label: "Spot",      nodeKind: "poi" },
  airForceBase:   { qid: "Q38723",   label: "Spot",      nodeKind: "poi" },
  busStationWd:   { qid: "Q494829",  label: "Station",   nodeKind: "poi" },
  microbrewery:   { qid: "Q853626",  label: "Spot",      nodeKind: "poi" },
  cityGate:       { qid: "Q1115076", label: "Spot",      nodeKind: "poi" },
  bunker:         { qid: "Q194203",  label: "Spot",      nodeKind: "poi" },
  arsenal:        { qid: "Q204216",  label: "Spot",      nodeKind: "poi" },
  farmersMarket:  { qid: "Q330284",  label: "Spot",      nodeKind: "poi" },

  // Phase 68 — 10 more infrastructure/culture/transport Wikidata profiles.
  waterTreatment: { qid: "Q1331793", label: "Spot",      nodeKind: "poi" },
  sewageTreatment:{ qid: "Q186693",  label: "Spot",      nodeKind: "poi" },
  navalBase:      { qid: "Q1520491", label: "Spot",      nodeKind: "poi" },
  operaHouse:     { qid: "Q153562",  label: "Spot",      nodeKind: "poi" },
  concertHall:    { qid: "Q249604",  label: "Spot",      nodeKind: "poi" },
  restAreaWd:     { qid: "Q846041",  label: "Spot",      nodeKind: "poi" },
  tollPlaza:      { qid: "Q1378820", label: "Spot",      nodeKind: "poi" },
  lighthouseWd2:  { qid: "Q39715",   label: "Spot",      nodeKind: "poi" },
  miningSite:     { qid: "Q820477",  label: "Spot",      nodeKind: "poi" },
  museumShip:     { qid: "Q575727",  label: "Spot",      nodeKind: "poi" },

  // Phase 71 — 10 more maritime/academic/urban WD profiles.
  maritimeStrait: { qid: "Q37901",   label: "Spot",      nodeKind: "poi" },
  archipelago:    { qid: "Q33837",   label: "Spot",      nodeKind: "poi" },
  peninsulaWd:    { qid: "Q34763",   label: "Spot",      nodeKind: "poi" },
  capeWd:         { qid: "Q185113",  label: "Spot",      nodeKind: "poi" },
  lagoon:         { qid: "Q187223",  label: "Lake",      nodeKind: "poi" },
  estuary:        { qid: "Q82974",   label: "Spot",      nodeKind: "poi" },
  researchInst:   { qid: "Q31855",   label: "Spot",      nodeKind: "poi" },
  scientificLab:  { qid: "Q483242",  label: "Spot",      nodeKind: "poi" },
  artistStudio:   { qid: "Q611177",  label: "Spot",      nodeKind: "poi" },
  observatory2:   { qid: "Q62832",   label: "Spot",      nodeKind: "poi" },

  // Phase 74 — 10 sports/nature/tourism WD profiles.
  footballStadium:{ qid: "Q483110",  label: "Spot",      nodeKind: "poi" },
  canyon:         { qid: "Q150784",  label: "Spot",      nodeKind: "poi" },
  orchard:        { qid: "Q236371",  label: "Farmland",  nodeKind: "poi" },
  wetland:        { qid: "Q170321",  label: "Spot",      nodeKind: "poi" },
  atoll:          { qid: "Q42523",   label: "Spot",      nodeKind: "poi" },
  themePark:      { qid: "Q194195",  label: "Spot",      nodeKind: "poi" },
  hotSpringWd:    { qid: "Q177380",  label: "Spot",      nodeKind: "poi" },
  waterpark:      { qid: "Q2195043", label: "Spot",      nodeKind: "poi" },
  fortress:       { qid: "Q57831",   label: "Spot",      nodeKind: "poi" },
  iceberg:        { qid: "Q35551",   label: "Spot",      nodeKind: "poi" },

  // Phase 75 — 5 sports/education WD profiles, high-confidence QIDs.
  baseballStadium:{ qid: "Q3411199", label: "Spot",      nodeKind: "poi" },
  velodromeWd:    { qid: "Q1026299", label: "Spot",      nodeKind: "poi" },
  publicLibrary:  { qid: "Q28564",   label: "Spot",      nodeKind: "poi" },
  kindergartenWd: { qid: "Q19816",   label: "Spot",      nodeKind: "poi" },
  cricketGround:  { qid: "Q1079023", label: "Spot",      nodeKind: "poi" },

  // Phase 80 — 5 transport/religious niche profiles.
  tramStop:       { qid: "Q2175765", label: "Station",   nodeKind: "poi" },
  monasteryWd:    { qid: "Q44613",   label: "Spot",      nodeKind: "poi" },
  funeralHomeWd:  { qid: "Q1555508", label: "Spot",      nodeKind: "poi" },
  crematoriumWd:  { qid: "Q1213719", label: "Spot",      nodeKind: "poi" },
  ferryRouteWd:   { qid: "Q18984099",label: "Spot",      nodeKind: "poi" },

  // Phase 86 — 5 more specialty WD profiles.
  powerLineWd:    { qid: "Q12570",   label: "PowerLine", nodeKind: "poi" },
  radioAntenna:   { qid: "Q1414116", label: "Spot",      nodeKind: "poi" },
  fishingHarbor:  { qid: "Q1196838", label: "Port",      nodeKind: "poi" },
  artificialIsland: { qid: "Q1163310", label: "Spot",    nodeKind: "poi" },
  amusementRideWd: { qid: "Q1144661", label: "Spot",     nodeKind: "poi" },
};

async function runWikidata(ctx: Ctx, job: MapsJobRow, _coverageLabel: string, maxRecords: number): Promise<number> {
  // Pick profile by source_did suffix (falls back to "corp").
  const src = job.source_id ?? "";
  const m = /did:web:maps\.etzhayyim\.ai:registry:wikidata(?::(\w+))?/.exec(src);
  const key = m?.[1] ?? "corp";
  const profile = WIKIDATA_PROFILES[key] ?? WIKIDATA_PROFILES.corp;
  // OFFSET rotation — bounded by collected_count so narrow-catalog QIDs
  // don't page past their catalog end. `collected_count` is the number of
  // rows we've already fetched for this target; the catalog has at least
  // that many coord-bearing entities, so (collected/maxRecords)+5 pages
  // ahead is a safe + growing window.
  let collected = 0;
  if (src) {
    const cRes = await sql<{ cc: number }>`
      SELECT collected_count AS cc FROM vertex_maps_coverage_target
       WHERE source_did = ${src} LIMIT 1
    `.execute(ctx.db);
    collected = Number((cRes.rows?.[0] as any)?.cc ?? 0);
  }
  // OFFSET rotation bounded by collected_count. iter 62 revert: drop the
  // 2x pullLimit — 100 rows × parallel SPARQL (3-4 concurrent) hits the
  // Worker 30s CPU budget too often (504 storm observed iter 61 → 62).
  const minuteBucket = Math.floor(Date.now() / 60_000);
  const pagesKnown = Math.max(1, Math.ceil(collected / maxRecords));
  const rotationWindow = Math.min(100, pagesKnown + 5);
  const offset = ((hashString(job.job_id) + minuteBucket) % rotationWindow) * maxRecords;
  // Corp uses HQ coord (P159→P625); everything else reads P625 directly.
  const query = profile.qid === "Q4830453"
    ? `SELECT ?item ?itemLabel ?countryLabel ?coord ?website WHERE {
         ?item wdt:P31/wdt:P279* wd:${profile.qid}; wdt:P159 ?hq.
         ?hq wdt:P625 ?coord.
         OPTIONAL { ?item wdt:P17 ?country. }
         OPTIONAL { ?item wdt:P856 ?website. }
         SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
       } LIMIT ${maxRecords} OFFSET ${offset}`
    : `SELECT ?item ?itemLabel ?countryLabel ?coord WHERE {
         ?item wdt:P31/wdt:P279* wd:${profile.qid}; wdt:P625 ?coord.
         OPTIONAL { ?item wdt:P17 ?country. }
         SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
       } LIMIT ${maxRecords} OFFSET ${offset}`;
  const resp = await cachedFetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`, {
    headers: { Accept: "application/sparql-results+json", "User-Agent": "etzhayyim-maps-coverage/1.0" },
  });
  if (!resp.ok) throw new Error(`Wikidata ${resp.status}`);
  const data = (await resp.json()) as any;
  const bindings: any[] = data?.results?.bindings ?? [];
  const sourceDid = src || "did:web:maps.etzhayyim.com:registry:wikidata";
  // Build all rows first, then batch INSERT — ~15x faster than per-row
  // round-trips on Hyperdrive (50 × 30ms → 1 × 100ms).
  const poiBatch: Record<string, unknown>[] = [];
  const legalBatch: Record<string, unknown>[] = [];
  for (const b of bindings) {
    if (poiBatch.length + legalBatch.length >= maxRecords) break;
    // Strip U+0000..U+001F + U+007F control chars — some Wikidata entity
    // labels contain them (e.g. Nagari-script glyphs) and downstream JSON
    // serialization in XRPC response breaks the client parser.
    const rawName = b?.itemLabel?.value ?? "";
    // eslint-disable-next-line no-control-regex
    const name = rawName.replace(/[ -]/g, " ").trim();
    if (!name) continue;
    const wid = (b?.item?.value ?? "").replace("http://www.wikidata.org/entity/", "");
    if (!wid) continue;
    const coordStr = String(b?.coord?.value ?? "");
    const mm = /Point\(([-\d.]+)\s+([-\d.]+)\)/.exec(coordStr);
    const lng = mm ? Number(mm[1]) : 0;
    const lat = mm ? Number(mm[2]) : 0;
    if (lat === 0 && lng === 0) continue;
    const base: Record<string, unknown> = {
      name,
      country: b?.countryLabel?.value ?? "",
      lat, lng,
      label: profile.label,
      nodeLabel: profile.label,
      sourceDid,
      jobId: job.job_id,
    };
    if (profile.nodeKind === "legalEntity") {
      legalBatch.push({
        ...base,
        entityId: `wikidata:${wid}`,
        entityType: "Corporation",
        website: b?.website?.value ?? "",
      });
    } else {
      poiBatch.push({
        ...base,
        poiId: `wikidata:${wid}`,
        osmId: `wikidata/${wid}`,
        category: "wikidata",
        subcategory: profile.label,
        lon: lng,
        address: "", phone: "", website: b?.website?.value ?? "", openingHours: "", wheelchair: "",
        collectedAt: nowISO(),
        orgId: "anon", userId: "anon", actorId: sourceDid,
      });
    }
  }
  const written = (await writeSpatialBatch(ctx.db, ctx.appId, "legalEntity", legalBatch))
                + (await writeSpatialBatch(ctx.db, ctx.appId, "poi", poiBatch));
  return written;
}

async function runOsmNotes(ctx: Ctx, job: MapsJobRow, _coverageLabel: string, maxRecords: number): Promise<number> {
  // OSM Notes API — user-reported map annotations (open / closed status).
  // Free, no auth, bbox-based. ~100k notes globally, refresh as notes get
  // resolved. https://wiki.openstreetmap.org/wiki/API_v0.6#Retrieving_notes_data_by_bounding_box
  const bbox = job.bbox_json
    ? safeParseBbox(job.bbox_json)
    : JP_CITY_BBOXES[cyclicBboxIdx(job.job_id)];
  const limit = Math.min(maxRecords, 500);
  const bboxStr = `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`;
  const url = `https://api.openstreetmap.org/api/0.6/notes.json?bbox=${bboxStr}&limit=${limit}&closed=7`;
  const resp = await cachedFetch(url, {
    headers: { Accept: "application/json", "User-Agent": "etzhayyim-maps-coverage/1.0 (contact@etzhayyim.com)" },
  });
  if (!resp.ok) throw new Error(`OSM Notes ${resp.status}`);
  const data = (await resp.json()) as any;
  const features: any[] = Array.isArray(data?.features) ? data.features : [];
  const sourceDid = job.source_id ?? "did:web:maps.etzhayyim.com:osm_notes";
  let written = 0;
  for (const f of features) {
    if (written >= maxRecords) break;
    const coords = f?.geometry?.coordinates ?? [];
    const lng = typeof coords[0] === "number" ? coords[0] : 0;
    const lat = typeof coords[1] === "number" ? coords[1] : 0;
    if (lat === 0 && lng === 0) continue;
    const props = f?.properties ?? {};
    const noteId = Number(props?.id ?? 0);
    if (!noteId) continue;
    const firstComment = Array.isArray(props?.comments) ? (props.comments[0]?.text ?? "") : "";
    // eslint-disable-next-line no-control-regex
    const name = String(firstComment).replace(/[\x00-\x1F\x7F]/g, " ").slice(0, 140).trim() || `Note-${noteId}`;
    await writeSpatial(ctx.db, ctx.appId, "poi", {
      poiId: `osmnote:${noteId}`,
      osmId: `osm_note/${noteId}`,
      name,
      category: "osm_notes",
      subcategory: String(props?.status ?? "open"),
      lat, lon: lng,
      address: "",
      phone: "", website: `https://www.openstreetmap.org/note/${noteId}`,
      openingHours: "", wheelchair: "",
      sourceDid,
      collectedAt: nowISO(),
      orgId: "anon", userId: "anon", actorId: sourceDid,
      nodeLabel: "Spot",
      label: "Spot",
      jobId: job.job_id,
    });
    written += 1;
  }
  return written;
}

function safeParseBbox(bboxJson: string): { west: number; south: number; east: number; north: number } {
  try {
    const b = JSON.parse(bboxJson);
    if (typeof b?.west === "number" && typeof b?.south === "number"
        && typeof b?.east === "number" && typeof b?.north === "number") return b;
  } catch { /* fall through */ }
  return DEFAULT_BBOX_JP;
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h = (h ^ s.charCodeAt(i)) * 16777619; h >>>= 0; }
  return h;
}

// ── Auto-expand frontier to cover all Worker-declared variations ───────
async function proxyCollectionCommand(ctx: Ctx, command: string, payload: Uint8Array): Promise<unknown> {
  const nsidValue = `com.etzhayyim.apps.maps.${command}`;
  let body: Record<string, unknown> = {};
  try {
    const text = new TextDecoder().decode(payload);
    body = text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    return { error: "InvalidJson" };
  }
  const env = ctx.sdk.env as Record<string, unknown>;
  const base = String(env.DISPATCHER_URL ?? "https://dispatcher.etzhayyim.com").replace(/\/+$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  const secret = env.DISPATCHER_INTERNAL_SECRET;
  if (typeof secret === "string" && secret) headers["x-internal-trust"] = secret;
  const resp = await fetch(`${base}/xrpc/${nsidValue}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: "DispatcherNonJson", status: resp.status, body: text };
  }
}

// ── Registration ────────────────────────────────────────────────────────

export function registerCollectionCommands(
  sdk: HostSDK,
  db: any,
  appId: string,
  post: (text: string) => void | Promise<void>,
): void {
  const ctx: Ctx = { sdk, db, appId, post };
  sdk.app
    .command(nsid("com.etzhayyim.apps.maps.registerSource"),
      (_, body) => proxyCollectionCommand(ctx, "registerSource", body),
      asAgentTool("Register map data source"), withCapabilityTags("source", "write"), withOCELEvent("governance.audit"))
    .command(nsid("com.etzhayyim.apps.maps.listSources"),
      (_, body) => proxyCollectionCommand(ctx, "listSources", body),
      asAgentTool("List map data sources"), withCapabilityTags("source", "query"))
    .command(nsid("com.etzhayyim.apps.maps.createCollectionJob"),
      (_, body) => proxyCollectionCommand(ctx, "createCollectionJob", body),
      asAgentTool("Create collection job"), withCapabilityTags("collection", "write"))
    .command(nsid("com.etzhayyim.apps.maps.advanceJob"),
      (_, body) => proxyCollectionCommand(ctx, "advanceJob", body),
      asAgentTool("Advance job status"), withCapabilityTags("collection", "write"))
    .command(nsid("com.etzhayyim.apps.maps.advanceCoverage"),
      (_, body) => proxyCollectionCommand(ctx, "advanceCoverage", body),
      asAgentTool("Pick top coverage gap via UDF and create a collection job for it (called by BPMN timer)"),
      withCapabilityTags("coverage", "udf", "bpmn", "write"),
      withOCELEvent("com.etzhayyim.apps.maps.coverage.advance"))
    .command(nsid("com.etzhayyim.apps.maps.refreshCoverageStats"),
      (_, body) => proxyCollectionCommand(ctx, "refreshCoverageStats", body),
      asAgentTool("Re-count vertex_spatial into coverage target collected_count (closes advance feedback loop)"),
      withCapabilityTags("coverage", "udf", "bpmn", "write"),
      withOCELEvent("com.etzhayyim.apps.maps.coverage.stats"))
    .command(nsid("com.etzhayyim.apps.maps.runCoverageJob"),
      (_, body) => cmdRunCoverageJob(ctx, body),
      asAgentTool("Execute a pending MapsJob: fetch from source (Overpass/GLEIF/Wikidata), parse, write vertex_spatial, advance job"),
      withCapabilityTags("coverage", "udf", "bpmn", "write", "ingest"),
      withOCELEvent("com.etzhayyim.apps.maps.coverage.run"))
    .command(nsid("com.etzhayyim.apps.maps.getCoverageStatus"),
      (_, body) => proxyCollectionCommand(ctx, "getCoverageStatus", body),
      asAgentTool("Get live coverage frontier leaderboard (read-only)"),
      withCapabilityTags("coverage", "query"))
    .command(nsid("com.etzhayyim.apps.maps.batchCoverageCycle"),
      (_, body) => proxyCollectionCommand(ctx, "batchCoverageCycle", body),
      asAgentTool("Run one full coverage cycle (advance+runN+refresh) in a single XRPC call"),
      withCapabilityTags("coverage", "batch", "write"),
      withOCELEvent("com.etzhayyim.apps.maps.coverage.cycle"))
    .command(nsid("com.etzhayyim.apps.maps.expandFrontier"),
      (_, body) => proxyCollectionCommand(ctx, "expandFrontier", body),
      asAgentTool("Declaratively seed vertex_maps_coverage_target rows; idempotent"),
      withCapabilityTags("coverage", "seed", "write"))
    .command(nsid("com.etzhayyim.apps.maps.seedAllKnownVariations"),
      (_, body) => proxyCollectionCommand(ctx, "seedAllKnownVariations", body),
      asAgentTool("Auto-expand frontier to cover every Worker-declared source×label variation (Wikidata/STAC/Overpass). Idempotent."),
      withCapabilityTags("coverage", "seed", "auto", "write"))
    .command(nsid("com.etzhayyim.apps.maps.listJobs"),
      (_, body) => proxyCollectionCommand(ctx, "listJobs", body),
      asAgentTool("List collection jobs"), withCapabilityTags("collection", "query"))
    .command(nsid("com.etzhayyim.apps.maps.getJobStatus"),
      (_, body) => proxyCollectionCommand(ctx, "getJobStatus", body),
      asAgentTool("Get job status"), withCapabilityTags("collection", "query"))
    .command(nsid("com.etzhayyim.apps.maps.storeDataset"),
      (_, body) => proxyCollectionCommand(ctx, "storeDataset", body),
      asAgentTool("Store map dataset"), withCapabilityTags("dataset", "write"))
    .command(nsid("com.etzhayyim.apps.maps.getDataset"),
      (_, body) => proxyCollectionCommand(ctx, "getDataset", body),
      asAgentTool("Get dataset details"), withCapabilityTags("dataset", "query"))
    .command(nsid("com.etzhayyim.apps.maps.listDatasets"),
      (_, body) => proxyCollectionCommand(ctx, "listDatasets", body),
      asAgentTool("List datasets"), withCapabilityTags("dataset", "query"))
    .command(nsid("com.etzhayyim.apps.maps.getPipelineStats"),
      (_, body) => proxyCollectionCommand(ctx, "getPipelineStats", body),
      asAgentTool("Collection pipeline stats"), withCapabilityTags("analytics", "query"))
    .command(nsid("com.etzhayyim.apps.maps.importOsmPois"),
      (_, body) => proxyCollectionCommand(ctx, "importOsmPois", body),
      asAgentTool("Import parsed Overpass API response as POI records"), withCapabilityTags("poi", "osm", "import"))
    .command(nsid("com.etzhayyim.apps.maps.importWikidataPois"),
      (_, body) => proxyCollectionCommand(ctx, "importWikidataPois", body),
      asAgentTool("Import parsed Wikidata SPARQL response as POI records"), withCapabilityTags("poi", "wikidata", "import"))
    .command(nsid("com.etzhayyim.apps.maps.searchPoi"),
      (_, body) => proxyCollectionCommand(ctx, "searchPoi", body),
      asAgentTool("Search POIs by name/category/bbox/source"), withCapabilityTags("poi", "search", "query"))
    .command(nsid("com.etzhayyim.apps.maps.getPoi"),
      (_, body) => proxyCollectionCommand(ctx, "getPoi", body),
      asAgentTool("Get POI by poiId"), withCapabilityTags("poi", "query"))
    .command(nsid("com.etzhayyim.apps.maps.listPoiTypes"),
      (_, body) => proxyCollectionCommand(ctx, "listPoiTypes", body),
      asAgentTool("List available OSM POI types for collection"), withCapabilityTags("poi", "meta"))
    .command(nsid("com.etzhayyim.apps.maps.registerWriterProfiles"),
      (_, body) => proxyCollectionCommand(ctx, "registerWriterProfiles", body),
      asAgentTool("Register all source sub-DID profiles"), withCapabilityTags("sources", "wDid"));
}
