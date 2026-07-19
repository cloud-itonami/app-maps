import type { Feature } from './chunk-overlay';

// @capacitor/core import was removed when the package was uninstalled from
// the workspace (2026-05-05). Native-platform detection is replaced with a
// runtime guard against the global `Capacitor` symbol Capacitor injects in
// the WebView; on the web we fall through to window.location.origin.
const _Capacitor = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;

interface AuthResolver {
  resolve(nsid?: string): Promise<Record<string, string>>;
}

interface XrpcResponse<T> {
  ok: boolean;
  status: number;
  data: T;
  error?: {
    error: string;
    message: string;
    status: number;
  };
}

interface XrpcCallOptions {
  method?: 'GET' | 'POST';
  auth?: AuthResolver;
  params?: Record<string, unknown>;
  signal?: AbortSignal;
  timeout?: number;
}

class XrpcHttpClient {
  constructor(private readonly baseUrl: string, private readonly defaultTimeout = 10000) {}

  async xrpc<T>(nsid: string, opts?: XrpcCallOptions): Promise<XrpcResponse<T>> {
    const method = opts?.method ?? 'POST';
    let url = `${this.baseUrl}/xrpc/${nsid}`;

    if (method === 'GET' && opts?.params) {
      const qs = Object.entries(opts.params)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
        .join('&');
      if (qs) url += `?${qs}`;
    }

    const headers = opts?.auth ? await opts.auth.resolve(nsid) : { 'content-type': 'application/json' };
    const response = await fetch(url, {
      method,
      headers,
      body: method === 'POST' && opts?.params ? JSON.stringify(opts.params) : undefined,
      signal: opts?.signal ?? AbortSignal.timeout(opts?.timeout ?? this.defaultTimeout),
    });

    return parseResponse<T>(response, nsid);
  }
}

async function parseResponse<T>(response: Response, nsid: string): Promise<XrpcResponse<T>> {
  if (!response.ok) {
    let errBody: Partial<XrpcResponse<T>['error']> = {};
    try {
      errBody = await response.json();
    } catch {
      // Ignore malformed error bodies and synthesize a generic XRPC error below.
    }
    return {
      ok: false,
      status: response.status,
      data: undefined as T,
      error: {
        error: errBody?.error ?? 'XRPCError',
        message: errBody?.message ?? `${nsid}: HTTP ${response.status}`,
        status: response.status,
      },
    };
  }

  if (response.status === 200 && response.headers.get('content-length') === '0') {
    return { ok: true, status: 200, data: {} as T };
  }

  try {
    return {
      ok: true,
      status: response.status,
      data: await response.json() as T,
    };
  } catch {
    return {
      ok: false,
      status: response.status,
      data: undefined as T,
      error: {
        error: 'MalformedXRPCResponse',
        message: `${nsid}: response was not JSON`,
        status: response.status,
      },
    };
  }
}

export async function unwrapXrpcResponse<T>(value: Promise<XrpcResponse<T>>): Promise<T> {
  const response = await value;
  if (!response.ok) {
    throw response.error ?? { error: 'XRPCError', message: `HTTP ${response.status}`, status: response.status };
  }
  return response.data;
}

export interface RuntimeMapConfig {
  styleUrl?: string;
  mapDataCdnUrl?: string;
  mapDataObjectUrl?: string;
  mapDataMetadataKvkey?: string;
  mapTileUrl?: string;
  vectorTileUrl?: string;
  vectorSource?: VectorSourceConfig;
  vectorSources?: VectorSourceConfig[];
  demTileUrl?: string;
  terrainSource?: TerrainSourceConfig;
  terrainSources?: TerrainSourceConfig[];
  orbitalSystems?: OrbitalSystemConfig[];
  orbitalBodies?: OrbitalBodyConfig[];
  celestialCatalogs?: CelestialCatalogConfig[];
  celestialObjects?: CelestialObjectConfig[];
  mapillaryAccessToken?: string;
}

export interface OrbitalSystemConfig {
  systemId: string;
  parentSystemId?: string;
  frame: string;
  primaryBodyId?: string;
  scaleKind: string;
  status: string;
  metadata?: Record<string, unknown>;
}

export interface OrbitalBodyConfig {
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
}

export interface CelestialCatalogConfig {
  catalogId: string;
  authority: string;
  version: string;
  frame: string;
  coverageKind: string;
  metadata?: Record<string, unknown>;
}

export interface CelestialObjectConfig {
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
}

export interface VectorAssetConfig {
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
}

export interface VectorSourceConfig {
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
  assets: VectorAssetConfig[];
}

export interface TerrainRasterAssetConfig {
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
}

export interface TerrainSourceConfig {
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
  assets: TerrainRasterAssetConfig[];
}

export interface KamiRuntimeConfig {
  tileUrl?: string;
  source?: string;
}

export interface SearchHit {
  id: string;
  title: string;
  snippet?: string;
  url?: string;
  source: string;
  kind: string;
  score: number;
  latitude?: number;
  longitude?: number;
}

export interface SourceStatus {
  name: string;
  status: string;
  results: number;
  error?: string;
}

export interface SearchResourcesResult {
  query: string;
  results: SearchHit[];
  sources?: SourceStatus[];
  tookMs?: number;
}

export interface DashboardLayer {
  id: string;
  name: string;
  category: string;
  enabled: boolean;
  count?: number;
  color?: string;
  description?: string;
}

export interface DashboardPanel {
  id: string;
  title: string;
  value?: string | number;
  status?: string;
  items?: Array<Record<string, unknown>>;
}

export interface DashboardEvent {
  id: string;
  title: string;
  category: string;
  severity: 'info' | 'watch' | 'warning' | 'critical';
  timestamp?: string;
  lat?: number;
  lng?: number;
  source?: string;
}

export interface DashboardRisk {
  score: number;
  level: 'low' | 'watch' | 'elevated' | 'high';
  drivers: string[];
}

export interface MapsDashboard {
  fetchedAt: string;
  region: string;
  counts: Record<string, number>;
  risk: DashboardRisk;
  layers: DashboardLayer[];
  panels: DashboardPanel[];
  events: DashboardEvent[];
}

interface RuntimeConfigResponse {
  styleUrl?: string;
  style_url?: string;
  mapDataCdnUrl?: string;
  map_data_cdn_url?: string;
  mapDataObjectUrl?: string;
  map_data_object_url?: string;
  mapDataMetadataKvkey?: string;
  map_data_metadata_kvkey?: string;
  mapTileUrl?: string;
  map_tile_url?: string;
  vectorTileUrl?: string;
  vector_tile_url?: string;
  vectorSource?: VectorSourceConfig;
  vector_source?: VectorSourceConfig;
  vectorSources?: VectorSourceConfig[];
  vector_sources?: VectorSourceConfig[];
  demTileUrl?: string;
  dem_tile_url?: string;
  terrainSource?: TerrainSourceConfig;
  terrain_source?: TerrainSourceConfig;
  terrainSources?: TerrainSourceConfig[];
  terrain_sources?: TerrainSourceConfig[];
  orbitalSystems?: OrbitalSystemConfig[];
  orbital_systems?: OrbitalSystemConfig[];
  orbitalBodies?: OrbitalBodyConfig[];
  orbital_bodies?: OrbitalBodyConfig[];
  celestialCatalogs?: CelestialCatalogConfig[];
  celestial_catalogs?: CelestialCatalogConfig[];
  celestialObjects?: CelestialObjectConfig[];
  celestial_objects?: CelestialObjectConfig[];
  mapillaryAccessToken?: string;
  mapillary_access_token?: string;
}

interface KamiConfigResponse {
  tileUrl?: string;
  tile_url?: string;
  source?: string;
}

interface SearchResourceHitRow {
  id: string;
  title: string;
  snippet?: string;
  url?: string;
  source: string;
  kind: string;
  score: number;
  latitude?: number;
  longitude?: number;
}

interface SearchResourceSourceRow {
  name: string;
  status: string;
  results: number;
  error?: string;
}

interface SearchResourcesResponse {
  query: string;
  results: SearchResourceHitRow[];
  sources: SearchResourceSourceRow[];
  tookMs?: number;
}

type DashboardResponse = Partial<MapsDashboard> & Record<string, unknown>;

export interface CrawlerLocationsOptions {
  jobStatus?: string;
  jobLimit?: number;
  resultsPerJob?: number;
  limit?: number;
  includeUnresolved?: boolean;
}

export interface CrawlerLocationsResult {
  points: import('$lib/types').MapCrawlerLocationPoint[];
  'fetchedAt': string;
  'jobCount': number;
  'resultCount': number;
  'queriedJobs': number;
  'queriedResults': number;
  errors: string[];
  'requestedStatuses': string[];
}

interface CrawlerPointRow {
  resultId?: string;
  jobId?: string;
  title: string;
  url: string;
  host: string;
  ip: string;
  httpStatus?: number;
  crawledAt?: string;
  latitude?: number;
  longitude?: number;
  country?: string;
  region?: string;
  city?: string;
  isp?: string;
  asn?: string;
  serverLocation?: string;
  hasLocation?: boolean;
  error?: string;
}

interface CrawlerLocationsResponse {
  points: CrawlerPointRow[];
  fetchedAt?: string;
  jobCount?: number;
  resultCount?: number;
  queriedJobs?: number;
  queriedResults?: number;
  errors: string[];
  requestedStatuses?: string[];
}

export interface ActorLocationPoint {
  did: string;
  handle: string;
  displayName: string;
  description?: string;
  location?: string;
  latitude: number;
  longitude: number;
  source?: string;
}

export interface ActorLocationsResult {
  points: ActorLocationPoint[];
  'fetchedAt': string;
  'queriedProfiles': number;
  total: number;
}

interface ActorLocationsResponse {
  points: ActorLocationPoint[];
  fetchedAt?: string;
  queriedProfiles?: number;
  total?: number;
}

export interface RouteLocation {
  lat: number;
  lng: number;
  label: string;
}

export interface SavedRoute {
  id: string;
  name: string;
  start: RouteLocation;
  end: RouteLocation;
  profile: string;
  geometry?: unknown;
  legs?: unknown[];
  'distanceMeters': number;
  'durationSeconds': number;
  'createdAt': string;
}

export interface RouteSavePayload {
  id?: string;
  name: string;
  profile: string;
  start: RouteLocation;
  end: RouteLocation;
  'distanceMeters'?: number;
  'durationSeconds'?: number;
  geometry?: unknown;
  legs?: unknown[];
}

export interface RouteListResult {
  routes: SavedRoute[];
  total: number;
  offset: number;
  limit: number;
}

function normalizeSavedRoute(route: SavedRoute & Record<string, unknown>): SavedRoute {
  return {
    id: String(route.id ?? ''),
    name: String(route.name ?? ''),
    start: (route.start as RouteLocation | undefined) ?? { lat: 0, lng: 0, label: '' },
    end: (route.end as RouteLocation | undefined) ?? { lat: 0, lng: 0, label: '' },
    profile: String(route.profile ?? ''),
    geometry: route.geometry,
    legs: Array.isArray(route.legs) ? route.legs : undefined,
    distanceMeters: Number(route.distanceMeters ?? route.distance_meters ?? 0),
    durationSeconds: Number(route.durationSeconds ?? route.duration_seconds ?? 0),
    createdAt: String(route.createdAt ?? route.created_at ?? ''),
  };
}

function normalizeWeatherGridResult(result: WeatherGridResult & Record<string, unknown>): WeatherGridResult {
  const rawFeatures = Array.isArray(result.features) ? result.features : [];
  return {
    type: 'FeatureCollection',
    features: rawFeatures.map((feature) => {
      const props = (feature.properties ?? {}) as Record<string, unknown>;
      return {
        type: 'Feature',
        geometry: feature.geometry,
        properties: {
          gridIndex: Number(props.gridIndex ?? props.grid_index ?? 0),
          marineWaveHeight: props.marineWaveHeight as number | undefined ?? props.marine_wave_height as number | undefined,
          marineWaveDirection: props.marineWaveDirection as number | undefined ?? props.marine_wave_direction as number | undefined,
          marineWavePeriod: props.marineWavePeriod as number | undefined ?? props.marine_wave_period as number | undefined,
          marineWindWaveHeight: props.marineWindWaveHeight as number | undefined ?? props.marine_wind_wave_height as number | undefined,
          marineSwellWaveHeight: props.marineSwellWaveHeight as number | undefined ?? props.marine_swell_wave_height as number | undefined,
          weatherWindSpeed10m: props.weatherWindSpeed10m as number | undefined ?? props.weather_wind_speed_10m as number | undefined,
          weatherWindDirection10m: props.weatherWindDirection10m as number | undefined ?? props.weather_wind_direction_10m as number | undefined,
          weatherWindGusts10m: props.weatherWindGusts10m as number | undefined ?? props.weather_wind_gusts_10m as number | undefined,
          weatherPressureMsl: props.weatherPressureMsl as number | undefined ?? props.weather_pressure_msl as number | undefined,
          weatherPrecipitation: props.weatherPrecipitation as number | undefined ?? props.weather_precipitation as number | undefined,
          weatherWeatherCode: props.weatherWeatherCode as number | undefined ?? props.weather_weather_code as number | undefined,
        },
      };
    }),
    gridStep: Number(result.gridStep ?? result.grid_step ?? 0),
    gridRadius: Number(result.gridRadius ?? result.grid_radius ?? 0),
    center: result.center,
    fetchedAt: String(result.fetchedAt ?? result.fetched_at ?? ''),
    errors: Array.isArray(result.errors) ? result.errors : [],
  };
}

function normalizeGraphNode(node: GraphNode & Record<string, unknown>): GraphNode {
  return {
    id: String(node.id ?? ''),
    nsPrefix: String(node.nsPrefix ?? node.ns_prefix ?? ''),
    types: Array.isArray(node.types) ? node.types.map(String) : [],
    label: String(node.label ?? ''),
    description: typeof node.description === 'string' ? node.description : undefined,
    sourceUrl: typeof node.sourceUrl === 'string' ? node.sourceUrl : typeof node.source_url === 'string' ? node.source_url : undefined,
    latitude: typeof node.latitude === 'number' ? node.latitude : undefined,
    longitude: typeof node.longitude === 'number' ? node.longitude : undefined,
  };
}

function normalizeGraphEdge(edge: GraphEdge & Record<string, unknown>): GraphEdge {
  return {
    predicate: String(edge.predicate ?? ''),
    objectId: typeof edge.objectId === 'string' ? edge.objectId : typeof edge.object_id === 'string' ? edge.object_id : undefined,
    objectLabel: typeof edge.objectLabel === 'string' ? edge.objectLabel : typeof edge.object_label === 'string' ? edge.object_label : undefined,
    objectLiteral: typeof edge.objectLiteral === 'string' ? edge.objectLiteral : typeof edge.object_literal === 'string' ? edge.object_literal : undefined,
    objectTypes: Array.isArray(edge.objectTypes) ? edge.objectTypes.map(String) : Array.isArray(edge.object_types) ? edge.object_types.map(String) : undefined,
    direction: edge.direction === 'in' ? 'in' : 'out',
  };
}

const isBrowser = typeof window !== 'undefined';
const baseUrl =
  (_Capacitor && typeof _Capacitor.isNativePlatform === 'function' && _Capacitor.isNativePlatform())
    ? 'https://maps.etzhayyim.com'
    : (isBrowser ? window.location.origin : 'https://maps.etzhayyim.com');

const xrpcClient = new XrpcHttpClient(baseUrl || window.location.origin || 'https://atproto.etzhayyim.com');

async function getClerkToken(): Promise<string | null> {
  const clerk = (globalThis as { Clerk?: { session?: { getToken?: () => Promise<string | null> } } }).Clerk;
  if (!clerk?.session?.getToken) return null;
  return await clerk.session.getToken();
}

const auth = {
  async resolve() {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    const token = await getClerkToken();
    if (token) h['authorization'] = `Bearer ${token}`;
    return h;
  },
};

// connectPost is used for performer methods not in the proto service definition
async function connectPost<T>(method: string, body = {}): Promise<T> {
  return unwrapXrpcResponse(xrpcClient.xrpc<T>(`com.etzhayyim.apps.maps.${method}`, { auth, params: body }));
}

export async function getRuntimeConfig(): Promise<RuntimeMapConfig> {
  const res = await unwrapXrpcResponse(
    xrpcClient.xrpc<RuntimeConfigResponse>('com.etzhayyim.apps.maps.runtimeConfig', { auth, params: {} }),
  );
  return {
    'styleUrl': res.styleUrl ?? res.style_url,
    'mapDataCdnUrl': res.mapDataCdnUrl ?? res.map_data_cdn_url,
    'mapDataObjectUrl': res.mapDataObjectUrl ?? res.map_data_object_url,
    'mapDataMetadataKvkey': res.mapDataMetadataKvkey ?? res.map_data_metadata_kvkey,
    'mapTileUrl': res.mapTileUrl ?? res.map_tile_url,
    'vectorTileUrl': res.vectorTileUrl ?? res.vector_tile_url,
    'vectorSource': res.vectorSource ?? res.vector_source,
    'vectorSources': res.vectorSources ?? res.vector_sources,
    'demTileUrl': res.demTileUrl ?? res.dem_tile_url,
    'terrainSource': res.terrainSource ?? res.terrain_source,
    'terrainSources': res.terrainSources ?? res.terrain_sources,
    'orbitalSystems': res.orbitalSystems ?? res.orbital_systems,
    'orbitalBodies': res.orbitalBodies ?? res.orbital_bodies,
    'celestialCatalogs': res.celestialCatalogs ?? res.celestial_catalogs,
    'celestialObjects': res.celestialObjects ?? res.celestial_objects,
    'mapillaryAccessToken': res.mapillaryAccessToken ?? res.mapillary_access_token,
  };
}

export async function getKamiConfig(): Promise<KamiRuntimeConfig> {
  const res = await unwrapXrpcResponse(
    xrpcClient.xrpc<KamiConfigResponse>('com.etzhayyim.apps.maps.kamiConfig', { auth, params: {} }),
  );
  return {
    tileUrl: res.tileUrl ?? res.tile_url,
    source: res.source,
  };
}

function normalizeDashboard(raw: DashboardResponse): MapsDashboard {
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw.counts ?? raw)) {
    if (typeof value === 'number' && Number.isFinite(value)) counts[key] = value;
  }
  const riskRaw = (raw.risk ?? {}) as Partial<DashboardRisk>;
  const score = Math.max(0, Math.min(100, Number(riskRaw.score ?? 0)));
  const level = riskRaw.level === 'high' || riskRaw.level === 'elevated' || riskRaw.level === 'watch'
    ? riskRaw.level
    : 'low';
  return {
    fetchedAt: String(raw.fetchedAt ?? raw.fetched_at ?? new Date().toISOString()),
    region: String(raw.region ?? 'global'),
    counts,
    risk: {
      score,
      level,
      drivers: Array.isArray(riskRaw.drivers) ? riskRaw.drivers.map(String) : [],
    },
    layers: Array.isArray(raw.layers) ? raw.layers as DashboardLayer[] : [],
    panels: Array.isArray(raw.panels) ? raw.panels as DashboardPanel[] : [],
    events: Array.isArray(raw.events) ? raw.events as DashboardEvent[] : [],
  };
}

export async function getDashboard(params: Record<string, unknown> = {}): Promise<MapsDashboard> {
  const res = await unwrapXrpcResponse(
    xrpcClient.xrpc<DashboardResponse>('com.etzhayyim.apps.maps.getDashboard', {
      auth,
      params,
      timeout: 7000,
    }),
  );
  return normalizeDashboard(res);
}

export async function searchResources(query: string, limit?: number): Promise<SearchResourcesResult> {
  const res = await unwrapXrpcResponse(
    xrpcClient.xrpc<SearchResourcesResponse>('com.etzhayyim.apps.maps.searchResources', {
      auth,
      params: {
        q: query,
        limit: limit ?? 8,
      },
    }),
  );
  return {
    query: res.query,
    results: res.results.map((row) => ({
      id: row.id,
      title: row.title,
      snippet: row.snippet,
      url: row.url,
      source: row.source,
      kind: row.kind,
      score: row.score,
      latitude: row.latitude,
      longitude: row.longitude,
    })),
    sources: res.sources.map((row) => ({
      name: row.name,
      status: row.status,
      results: row.results,
      error: row.error || undefined,
    })),
    'tookMs': Number(res.tookMs ?? res.tookMs),
  };
}

export interface SearchPlacesRow {
  placeId: string;
  label: string;
  lat: number | null;
  lng: number | null;
  kind: string;
}

export async function searchPlaces(query: string, limit = 6): Promise<SearchPlacesRow[]> {
  const res = await unwrapXrpcResponse(
    xrpcClient.xrpc<{ places?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(
      'com.etzhayyim.apps.maps.searchPlaces',
      { auth, params: { query, limit } },
    ),
  );
  const rows = Array.isArray(res) ? res : (res.places ?? []);
  return rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      placeId: String(r.placeId ?? r.place_id ?? r.rkey ?? r.nodeId ?? ''),
      label: String(r.name ?? r.label ?? r.displayName ?? ''),
      lat: typeof r.lat === 'number' ? r.lat : Number.parseFloat(String(r.lat ?? '')),
      lng: typeof r.lng === 'number' ? r.lng : Number.parseFloat(String(r.lng ?? '')),
      kind: String(r.kind ?? r.type ?? r.category ?? 'place'),
    };
  });
}

export async function getCrawlerLocations(options: CrawlerLocationsOptions = {}): Promise<CrawlerLocationsResult> {
  const res = await unwrapXrpcResponse(
    xrpcClient.xrpc<CrawlerLocationsResponse>('com.etzhayyim.apps.maps.crawlerLocations', {
      auth,
      params: {
        'jobStatus': options.jobStatus ?? '',
        'jobLimit': options.jobLimit ?? 0,
        'resultsPerJob': options.resultsPerJob ?? 0,
        limit: options.limit ?? 0,
        'includeUnresolved': options.includeUnresolved ?? false,
      },
    }),
  );
  return {
    points: res.points.map((point) => ({
      'resultId': point.resultId ?? '',
      'jobId': point.jobId ?? '',
      title: point.title ?? '',
      url: point.url ?? '',
      host: point.host ?? '',
      ip: point.ip ?? '',
      'httpStatus': point.httpStatus ?? 0,
      'crawledAt': point.crawledAt ?? '',
      latitude: point.latitude ?? 0,
      longitude: point.longitude ?? 0,
      country: point.country ?? '',
      region: point.region ?? '',
      city: point.city ?? '',
      isp: point.isp ?? '',
      asn: point.asn ?? '',
      'serverLocation': point.serverLocation ?? '',
      hasLocation: point.hasLocation ?? false,
      error: point.error ?? '',
    })),
    'fetchedAt': res.fetchedAt ?? '',
    'jobCount': res.jobCount ?? 0,
    'resultCount': res.resultCount ?? 0,
    'queriedJobs': res.queriedJobs ?? 0,
    'queriedResults': res.queriedResults ?? 0,
    errors: res.errors,
    'requestedStatuses': res.requestedStatuses ?? [],
  };
}

export async function getActorLocations(limit = 200): Promise<ActorLocationsResult> {
  const res = await unwrapXrpcResponse(
    xrpcClient.xrpc<ActorLocationsResponse>('com.etzhayyim.apps.maps.actorLocations', {
      auth,
      params: { limit },
    }),
  );
  return {
    points: (res.points ?? []).map((point) => ({
      did: point.did ?? '',
      handle: point.handle ?? '',
      displayName: point.displayName ?? point.did ?? '',
      description: point.description ?? '',
      location: point.location ?? '',
      latitude: point.latitude ?? 0,
      longitude: point.longitude ?? 0,
      source: point.source ?? '',
    })),
    fetchedAt: res.fetchedAt ?? '',
    queriedProfiles: res.queriedProfiles ?? 0,
    total: res.total ?? (res.points?.length ?? 0),
  };
}

export async function getChunk(params: {
  h3Cells: string[]; lod: number; labels: string[]; limit?: number;
}): Promise<{ chunks: Record<string, Record<string, Feature[]>>; total: number }> {
  const res = await unwrapXrpcResponse(
    xrpcClient.xrpc<{ chunks?: Record<string, Record<string, Feature[]>>; total?: number }>(
      'com.etzhayyim.apps.maps.getChunk',
      { auth, params },
    ),
  );
  return { chunks: res.chunks ?? {}, total: res.total ?? 0 };
}

export async function getTileGeoJson(params: {
  west: number; south: number; east: number; north: number;
  labels: string[]; zoom: number; limit?: number;
}): Promise<{ layers: Record<string, { type: 'FeatureCollection'; features: unknown[] }>; total: number }> {
  const res = await unwrapXrpcResponse(
    xrpcClient.xrpc<{ layers?: Record<string, { type: 'FeatureCollection'; features: unknown[] }>; total?: number }>(
      'com.etzhayyim.apps.maps.tileGeoJson',
      { auth, params },
    ),
  );
  return { layers: res.layers ?? {}, total: res.total ?? 0 };
}

// ── aismarine — MarineTraffic-equivalent vessel tracking (ADR-2605011500) ──

export type VesselFeature = {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: {
    mmsi: number;
    ts_ms: number;
    type_class: string;
    name?: string;
    type_code?: number;
    flag_iso?: string;
    sog_knot?: number;
    cog_deg?: number;
    heading_deg?: number;
    nav_status?: number;
  };
};

export async function aismarineQueryVesselsBbox(params: {
  bbox: [number, number, number, number];
  types?: string[];
  minSog?: number;
  limit?: number;
}): Promise<{ features: VesselFeature[]; total: number; bbox: number[]; truncated: boolean }> {
  const res = await unwrapXrpcResponse(
    xrpcClient.xrpc<{ features?: VesselFeature[]; total?: number; bbox?: number[]; truncated?: boolean }>(
      'com.etzhayyim.apps.maps.aismarine.queryVesselsBbox',
      { auth, params },
    ),
  );
  return {
    features: res.features ?? [],
    total: res.total ?? 0,
    bbox: res.bbox ?? [],
    truncated: !!res.truncated,
  };
}

export type VesselTrackPoint = {
  ts_ms: number;
  lat: number;
  lon: number;
  sog_knot: number | null;
  cog_deg: number | null;
  heading_deg: number | null;
  nav_status: number | null;
};

export type VesselDetail = {
  vessel: null | {
    mmsi: number;
    imo: number | null;
    callsign: string | null;
    name: string | null;
    type_code: number | null;
    type_class: string;
    flag_mid: number | null;
    flag_iso: string | null;
    length_m: number | null;
    width_m: number | null;
    draught_m: number | null;
    source: string | null;
    first_seen_ms: number;
    last_seen_ms: number;
  };
  recentTrack: VesselTrackPoint[];
  voyage: null | {
    departure_port_locode?: string;
    departure_ms?: number;
    arrival_port_locode?: string;
    arrival_ms?: number;
    declared_eta_ms?: number;
    declared_destination?: string;
    declared_draught_m?: number;
  };
  /** Legal-entity owner edges (Phase 1.2). Empty until Wikidata SPARQL enrichment seeds rows. */
  owners?: VesselLegalEntityEdge[];
  /** Legal-entity operator / manager edges. Empty until enrichment runs. */
  operators?: VesselLegalEntityEdge[];
};

export type VesselLegalEntityEdge = {
  /** GLEIF LEI when known; null when only the Wikidata QID is available. */
  lei: string | null;
  /** Wikidata QID (e.g. 'Q12345') when sourced from Wikidata. */
  wikidata_qid: string | null;
  /** Display name — vertex_legal_entity.name when LEI joined, else Wikidata label. */
  name: string | null;
  country: string | null;
  entity_type: string | null;
  /** vertex_legal_entity vertex_id (or 'wikidata:Qxxx' fallback). */
  legal_entity_vid: string | null;
  share_pct?: number | null;
  role?: string | null;
  source: string;
  effective_from_ms: number | null;
};

export async function aismarineGetVesselDetail(params: {
  mmsi: number; trackHours?: number; trackLimit?: number;
}): Promise<VesselDetail> {
  const res = await unwrapXrpcResponse(
    xrpcClient.xrpc<VesselDetail>(
      'com.etzhayyim.apps.maps.aismarine.getVesselDetail',
      { auth, params },
    ),
  );
  return {
    vessel: res.vessel ?? null,
    recentTrack: res.recentTrack ?? [],
    voyage: res.voyage ?? null,
    owners: res.owners ?? [],
    operators: res.operators ?? [],
  };
}

export async function aismarineSearchVessels(params: {
  q: string; limit?: number;
}): Promise<{
  results: Array<{
    mmsi: number;
    imo: number | null;
    name: string | null;
    callsign: string | null;
    type_class: string;
    flag_iso: string | null;
    last_seen_ms: number | null;
    last_lat: number | null;
    last_lon: number | null;
  }>;
  total: number;
}> {
  const res = await unwrapXrpcResponse(
    xrpcClient.xrpc<{ results?: unknown[]; total?: number }>(
      'com.etzhayyim.apps.maps.aismarine.searchVessels',
      { auth, params },
    ),
  );
  return { results: (res.results ?? []) as never, total: res.total ?? 0 };
}

/** Phase 1 grid cell (cellSchema='grid_0p1deg'): south-west-anchored 0.1° box.
 *  Phase 2 H3 cell (cellSchema='h3_r6'): cell_id is an H3 hex; lat_bin/lon_bin
 *  are absent. ADR-2605011500. */
export type VesselDensityCell = {
  cell_id: string;
  lat_bin?: number;
  lon_bin?: number;
  vessel_count: number;
  hit_count: number;
  byClass: Record<string, { vessel_count: number; hit_count: number }>;
};

export type VesselDensityCellSchema = 'grid_0p1deg' | 'h3_r6';

export async function aismarineGetVesselDensityTile(params: {
  bbox: [number, number, number, number];
  h3Resolution?: number;
  windowMinutes?: number;
  types?: string[];
}): Promise<{ cells: VesselDensityCell[]; cellSchema: VesselDensityCellSchema; windowMinutes: number }> {
  const res = await unwrapXrpcResponse(
    xrpcClient.xrpc<{ cells?: VesselDensityCell[]; cellSchema?: VesselDensityCellSchema; windowMinutes?: number }>(
      'com.etzhayyim.apps.maps.aismarine.getVesselDensityTile',
      { auth, params },
    ),
  );
  return {
    cells: res.cells ?? [],
    cellSchema: res.cellSchema ?? 'grid_0p1deg',
    windowMinutes: res.windowMinutes ?? (params.windowMinutes ?? 60),
  };
}

// ── Live tracker — Flightradar24 + N2YO (2026-05-05) ───────────────────────

export type LiveAircraft = {
  icao24: string;
  callsign?: string;
  lat: number;
  lon: number;
  baroAltitudeM?: number | null;
  velocityMs?: number | null;
  headingDeg?: number | null;
  verticalRateMs?: number | null;
  originCountry?: string | null;
  source: string;
  tsMs: number;
};

export type CelestialObject = {
  objectId: string;
  name?: string;
  kind: string;
  catalogId?: string;
  raDeg?: number | null;
  decDeg?: number | null;
  distanceLy?: number | null;
  spectralClass?: string | null;
  renderPriority?: number | null;
};

export type LiveSatellite = {
  noradId: number;
  name?: string | null;
  observerH3?: string;
  aosMs: number;
  losMs: number;
  maxElevationDeg: number;
  peakAzimuthDeg?: number | null;
  visibleAtNight?: boolean;
  magnitude?: number | null;
};

export async function listLiveAircraft(params: {
  minLat?: number;
  maxLat?: number;
  minLon?: number;
  maxLon?: number;
  maxAgeSec?: number;
  limit?: number;
  country?: string;
} = {}): Promise<{ aircraft: LiveAircraft[]; count: number; asOfMs: number }> {
  const res = await unwrapXrpcResponse(
    xrpcClient.xrpc<{ aircraft?: LiveAircraft[]; count?: number; asOfMs?: number }>(
      'com.etzhayyim.apps.maps.listLiveAircraft',
      { method: 'GET', auth, params },
    ),
  );
  return {
    aircraft: res.aircraft ?? [],
    count: res.count ?? 0,
    asOfMs: res.asOfMs ?? Date.now(),
  };
}

export async function listLiveSatellites(params: {
  observerH3?: string;
  catalogGroup?: string;
  limit?: number;
} = {}): Promise<{ satellites: LiveSatellite[]; count: number; asOfMs: number }> {
  const res = await unwrapXrpcResponse(
    xrpcClient.xrpc<{ satellites?: LiveSatellite[]; count?: number; asOfMs?: number }>(
      'com.etzhayyim.apps.maps.listLiveSatellites',
      { method: 'GET', auth, params },
    ),
  );
  return {
    satellites: res.satellites ?? [],
    count: res.count ?? 0,
    asOfMs: res.asOfMs ?? Date.now(),
  };
}

// Route methods use performer adapter bridge (not in proto service)
export async function routeSave(payload: RouteSavePayload): Promise<{ id: string; ok: boolean }> {
  return connectPost<{ id: string; ok: boolean }>('RouteSave', {
    ...payload,
    distanceMeters: payload.distanceMeters ?? 0,
    durationSeconds: payload.durationSeconds ?? 0,
  } as unknown as Record<string, unknown>);
}

export async function routeGet(id: string): Promise<{ route: SavedRoute }> {
  const result = await connectPost<{ route: SavedRoute & Record<string, unknown> }>('RouteGet', { id });
  return { route: normalizeSavedRoute(result.route) };
}

export async function routeList(offset = 0, limit = 20): Promise<RouteListResult> {
  const result = await connectPost<RouteListResult & { routes?: Array<SavedRoute & Record<string, unknown>> }>('RouteList', { offset, limit });
  return {
    routes: (result.routes ?? []).map(normalizeSavedRoute),
    total: result.total ?? 0,
    offset: result.offset ?? offset,
    limit: result.limit ?? limit,
  };
}

export async function routeDelete(id: string): Promise<{ ok: boolean }> {
  return connectPost<{ ok: boolean }>('RouteDelete', { id });
}

// Weather grid types
export interface WeatherGridFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: {
    'gridIndex': number;
    marineWaveHeight?: number;
    marineWaveDirection?: number;
    marineWavePeriod?: number;
    marineWindWaveHeight?: number;
    marineSwellWaveHeight?: number;
    weatherWindSpeed10m?: number;
    weatherWindDirection10m?: number;
    weatherWindGusts10m?: number;
    weatherPressureMsl?: number;
    weatherPrecipitation?: number;
    weatherWeatherCode?: number;
  };
}

export interface WeatherGridResult {
  type: 'FeatureCollection';
  features: WeatherGridFeature[];
  'gridStep': number;
  'gridRadius': number;
  center: { latitude: number; longitude: number };
  'fetchedAt': string;
  errors: string[];
}

export async function getWeatherGrid(
  latitude: number,
  longitude: number,
  gridStep = 0.5,
  gridRadius = 3,
): Promise<WeatherGridResult> {
  const result = await connectPost<WeatherGridResult & Record<string, unknown>>('WeatherGrid', {
    latitude,
    longitude,
    'gridStep': gridStep,
    'gridRadius': gridRadius,
  });
  return normalizeWeatherGridResult(result);
}

export interface GraphNode {
  id: string;
  'nsPrefix': string;
  types: string[];
  label: string;
  description?: string;
  sourceUrl?: string;
  latitude?: number;
  longitude?: number;
}

export interface GraphSearchNodesResult {
  nodes: GraphNode[];
  total: number;
}

export async function graphSearchNodes(query: string, limit = 20): Promise<GraphSearchNodesResult> {
  const result = await connectPost<GraphSearchNodesResult & { nodes?: Array<GraphNode & Record<string, unknown>> }>('GraphSearchNodes', { q: query, limit });
  return {
    nodes: (result.nodes ?? []).map(normalizeGraphNode),
    total: result.total ?? 0,
  };
}

export interface GraphEdge {
  predicate: string;
  objectId?: string;
  objectLabel?: string;
  objectLiteral?: string;
  objectTypes?: string[];
  direction: 'out' | 'in';
}

export interface GraphNeighborsResult {
  'nodeId': string;
  edges: GraphEdge[];
}

export async function graphNeighbors(nodeId: string, direction = 'both'): Promise<GraphNeighborsResult> {
  const result = await connectPost<GraphNeighborsResult & { edges?: Array<GraphEdge & Record<string, unknown>> }>('GraphNeighbors', { 'nodeId': nodeId, direction });
  return {
    nodeId: result.nodeId,
    edges: (result.edges ?? []).map(normalizeGraphEdge),
  };
}

export interface InfraLayer {
  infraType: string;
  depthM: number;
  color: string;
  segments: unknown[];
}

export interface InfraCrossSectionResult {
  lat: number;
  lng: number;
  radiusM: number;
  layers: InfraLayer[];
  totalSegments: number;
}

export async function infraCrossSection(lat: number, lng: number, radiusM = 500): Promise<InfraCrossSectionResult> {
  return connectPost<InfraCrossSectionResult>('InfraCrossSection', { lat, lng, radiusM });
}
