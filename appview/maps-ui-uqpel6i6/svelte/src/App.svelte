<script lang="ts">
import { getSpatialIdentity } from '$lib/client/spatial';
import {
  buildH3HexData,
  computeH3CellBoundary,
  zoomToH3Resolution,
  zoomToRingSize,
} from '$lib/spatial/client-spatial';
import { hasLocation, type MapCrawlerLocationPoint } from '$lib/types';
import {
  type NavigationStep,
  type NavigationRoute,
  type JourneyLeg,
  type MultiModalJourney,
  parseOSRMSteps,
  getManeuverIcon,
  haversineDistance,
  buildBoardingInstruction,
  LEG_MODE_COLOR,
  LEG_MODE_ICON,
  VOICE_TRIGGER_FAR,
  VOICE_TRIGGER_NEAR,
  VOICE_TRIGGER_NOW,
  DEVIATION_THRESHOLD_METERS,
} from '$lib/navigation';
import { routeTransit, routeFerry, routeFlight } from '$lib/transit';
import {
  type RuntimeMapConfig,
  getRuntimeConfig,
  getKamiConfig,
  searchResources as apiSearchResources,
  searchPlaces as apiSearchPlaces,
  routeSave as apiRouteSave,
  routeList as apiRouteList,
  routeDelete as apiRouteDelete,
  graphSearchNodes as apiGraphSearchNodes,
  graphNeighbors as apiGraphNeighbors,
  getWeatherGrid as apiGetWeatherGrid,
  infraCrossSection as apiInfraCrossSection,
  type GraphEdge,
  type WeatherGridFeature,
  type InfraCrossSectionResult,
  getCrawlerLocations,
  getActorLocations,
  type ActorLocationPoint,
  getTileGeoJson,
  getChunk,
  getDashboard as apiGetDashboard,
  type MapsDashboard,
  type DashboardLayer,
} from '$lib/api';
import { applyOpenMapTilesStyle } from '$lib/kami-openmaptiles-style';
import { applyChunkOverlay } from '$lib/chunk-overlay';
import { applyAismarineOverlay } from '$lib/aismarine-overlay';
import { aismarineGetVesselDetail, type VesselDetail } from '$lib/api';
import { applyLiveAircraftOverlay } from '$lib/live-aircraft-overlay';
import { applyLiveSatelliteOverlay } from '$lib/live-satellite-overlay';
import { applyCelestialSphereOverlay, type CelestialOverlayHandle } from '$lib/celestial-sphere-overlay';
import { clipRingToBBox, ringBBoxIntersects, type Ring as ClipRing } from '$lib/polygon-clip';
  import { KamiMapBridge, KamiMarker, KamiPopup, LngLatBoundsCompat } from '$lib/kami-bridge';

  let mapContainer = $state<HTMLElement>();
  let map = $state<any>();
  let kamiMap = $state<KamiMapBridge | null>(null);

  // aismarine vessel detail panel (ADR-2605011500). Populated by overlay click.
  let vesselDetail = $state<VesselDetail | null>(null);
  let vesselDetailLoading = $state(false);
  let aismarineCtlRef = $state<{
    showTrack?: (pts: Array<[number, number]>) => void;
    clearTrack?: () => void;
    selectVessel?: (lonLat: [number, number]) => void;
    clearSelection?: () => void;
    setVisible?: (visible: boolean) => void;
  } | null>(null);

  // Live tracker layer toggles (2026-05-05). 衛星 / 航空機 / 船舶 visibility.
  // Default ON so first paint shows everything; user can toggle off via the
  // panel in the top-right. Each overlay returns a cleanup() captured here;
  // re-applied on next $effect when the toggle flips back on.
  let showLiveAircraft = $state(true);
  let showLiveSatellite = $state(true);
  let showLiveVessel = $state(true);
  let liveAircraftCleanup: (() => void) | null = null;
  let liveSatelliteCleanup: (() => void) | null = null;
  let celestialOverlayRef: CelestialOverlayHandle | null = null;
  let showCelestial = $state(true);
  // (vessel cleanup is the existing aismarineCtlRef.cleanup — handled below)
  let kamiMapRef = $state<any>(null);

  $effect(() => {
    const map = kamiMapRef;
    if (!map) return;
    if (showLiveAircraft && !liveAircraftCleanup) {
      liveAircraftCleanup = applyLiveAircraftOverlay(map);
    } else if (!showLiveAircraft && liveAircraftCleanup) {
      liveAircraftCleanup();
      liveAircraftCleanup = null;
    }
  });

  $effect(() => {
    const map = kamiMapRef;
    if (!map) return;
    if (showLiveSatellite && !liveSatelliteCleanup) {
      liveSatelliteCleanup = applyLiveSatelliteOverlay(map);
    } else if (!showLiveSatellite && liveSatelliteCleanup) {
      liveSatelliteCleanup();
      liveSatelliteCleanup = null;
    }
  });

  // MapLibre-compat global shim: expose KamiMarker/KamiPopup/LngLatBounds under the
  // legacy `maplibregl` name so existing `new maplibregl.Marker(...)` call sites keep working.
  const maplibregl = {
    Marker: KamiMarker,
    Popup: KamiPopup,
    LngLatBounds: LngLatBoundsCompat,
  } as any;
  // deck.gl integration is not reimplemented in Phase 1; H3 overlay is drawn as a
  // kami-bridge fill layer instead. Keep the legacy variable references as null so
  // the H3 update path below can continue to early-return cleanly.
  const deckOverlay: any = null;
  const MapboxOverlay: any = null;
  const H3HexagonLayer: any = null;
  let lat = $state(35.6812);
  let lng = $state(139.7671);
  let zoom = $state(12);
  let scaleBarWidthPx = $state(96);
  let scaleBarLabel = $state('5 km');
  let s2ID = $state('');
  let h3ID = $state('');
  let mgrs = $state('');
  let h3Resolution = $state(9);
  let showH3Grid = $state(true);
  let hoveredH3 = $state<string | null>(null);
  let mapReady = $state(false);
  let mapError = $state<string | null>(null);
  // Debug HUD: toggled by ?debug=1 URL param or pressing 'D'
  let debugHud = $state(false);
  let debugStats = $state<Record<string, unknown>>({});
  let fpsFrames = 0;
  let fpsLastT = 0;
  let fpsCurrent = $state(0);
  let runtimeConfig = $state<RuntimeMapConfig | null>(null);
  let mapBootstrapped = $state(false);
  let crawlerPoints = $state<MapCrawlerLocationPoint[]>([]);
  let crawlerMarkers: any[] = [];
  let crawlerPollTimer: ReturnType<typeof setInterval> | undefined;
  let crawlerLoading = $state(false);
  let crawlerInitialized = $state(false);
  let crawlerError = $state<string | null>(null);
  let crawlerLastUpdated = $state('');
  let crawlerJobCount = $state(0);
  let crawlerResultCount = $state(0);
  let crawlerQueriedJobs = $state(0);
  let crawlerQueriedResults = $state(0);
  let crawlerRequestedStatuses = $state<string[]>([]);
  let crawlerActivePoint = $state<MapCrawlerLocationPoint | null>(null);
  let crawlerPopup: any = null;
  const crawlerWatchStatuses = ['pending', 'running', 'completed'];
  const crawlerPanelLimit = 8;
  let actorPoints = $state<ActorLocationPoint[]>([]);
  let actorMarkers: any[] = [];
  let actorPollTimer: ReturnType<typeof setInterval> | undefined;
  let actorLoading = $state(false);
  let actorError = $state<string | null>(null);
  let showActorLocations = $state(true);

  // Search state
  let searchQuery = $state('');
  let searchResults = $state<MapSearchResult[]>([]);
  let showResults = $state(false);
  let searching = $state(false);
  let searchMarker = $state<any>(null);
  let searchInputEl = $state<HTMLInputElement>();
  let searchStatusText = $state('');
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  // Route navigation state
  let routeMode = $state(false);
  let routeStart = $state<{lat: number; lng: number; label: string} | null>(null);
  let routeEnd = $state<{lat: number; lng: number; label: string} | null>(null);
  let routeProfile = $state<'driving' | 'walking' | 'transit' | 'ferry' | 'flight'>('driving');
  let routeGeometry = $state<any>(null);
  let routeDistance = $state(0);
  let routeDuration = $state(0);
  let routeLoading = $state(false);
  let routeError = $state<string | null>(null);
  let routeStartMarker = $state<any>(null);
  let routeEndMarker = $state<any>(null);
  let savedRoutes = $state<any[]>([]);
  let showSavedRoutes = $state(false);
  let routeSaving = $state(false);

  // Place detail card state
  let selectedPlace = $state<MapSearchResult | null>(null);
  let showPlaceCard = $state(false);
  let entityNeighbors = $state<GraphEdge[]>([]);
  let entityNeighborsLoading = $state(false);
  let shareCopied = $state(false);

  // Dev tools toggle (replaces always-visible info panel)
  let showDevTools = $state(false);

  // Operations dashboard (World Monitor-inspired, but backed by maps.etzhayyim.com graph/live layers)
  let showOpsPanel = $state(true);
  let showLayerDrawer = $state(false);
  let dashboard = $state<MapsDashboard | null>(null);
  let dashboardLoading = $state(false);
  let dashboardError = $state<string | null>(null);
  let dashboardPollTimer: ReturnType<typeof setInterval> | undefined;
  let selectedDashboardRange = $state<'1h' | '6h' | '24h' | '7d'>('24h');

  // Mapillary street-level imagery
  let showMapillaryCoverage = $state(false);
  let showMapillaryViewer = $state(false);
  let mapillaryViewerImageId = $state<string | null>(null);
  let mapillaryViewer = $state<any>(null);
  let mapillaryViewerContainer = $state<HTMLElement>();
  let mapillaryViewerMarker = $state<any>(null);
  let mapillaryToken = $state('');

  // Weather layer state
  let showWeatherLayer = $state(false);
  let weatherFeatures = $state<WeatherGridFeature[]>([]);
  let weatherLoading = $state(false);
  let weatherError = $state<string | null>(null);
  let weatherFetchedAt = $state('');
  let weatherPollTimer: ReturnType<typeof setInterval> | undefined;

  // 3D mode + underground cross-section + ground walk
  type MapRenderMode = 'flat' | 'kami3d' | 'kami-walk';
  let mapRenderMode = $state<MapRenderMode>('kami3d');
  let pitch3D = $state(0); // current pitch in degrees
  let autoPitchEnabled = $state(true);
  let show3DPanel = $state(false);
  let undergroundData = $state<InfraCrossSectionResult | null>(null);
  let undergroundLoading = $state(false);
  let undergroundError = $state<string | null>(null);

  // Hamburger menu
  let showMenu = $state(false);
  const mapsTools = [
    { icon: '\u{1F50D}', label: 'Search', href: 'https://search.etzhayyim.com' },
    { icon: '\u{1F577}\uFE0F', label: 'Crawler', href: 'https://crawler.etzhayyim.com' },
    { icon: '\u{1F4F0}', label: 'News', href: 'https://news.etzhayyim.com' },
    { icon: '\u{1F5C4}\uFE0F', label: 'Collection CP', href: 'https://v1m9k2q8.etzhayyim.com/xrpc' },
  ];
  const dataSources = [
    { icon: '\u{1F30D}', label: 'OpenStreetMap', href: 'https://openstreetmap.org' },
    { icon: '\u{1F5FA}\uFE0F', label: 'OpenFreeMap', href: 'https://openfreemap.org' },
    { icon: '\u{1F522}', label: 'H3 Geo', href: 'https://h3geo.org' },
    { icon: '\u{1F4CD}', label: 'Nominatim', href: 'https://nominatim.openstreetmap.org' },
    { icon: '\u{1F310}', label: 'ip-api', href: 'https://ip-api.com' },
    { icon: '\u{1F4F7}', label: 'Mapillary', href: 'https://www.mapillary.com' },
    { icon: '\u{1F32A}\uFE0F', label: 'Open-Meteo', href: 'https://open-meteo.com' },
  ];

  // Route text search
  let routeSearching = $state(false);
  let routeOriginSuggestions = $state<MapSearchResult[]>([]);
  let routeDestSuggestions = $state<MapSearchResult[]>([]);
  let showOriginSuggestions = $state(false);
  let showDestSuggestions = $state(false);
  let routeOriginInput = $state('');
  let routeDestInput = $state('');
  let routeOriginDebounce: ReturnType<typeof setTimeout> | undefined;
  let routeDestDebounce: ReturnType<typeof setTimeout> | undefined;

  // Route alternatives
  const ROUTE_COLORS = ['#00ffcc', '#ff9a3c', '#9a7cff'];
  let routeAlternatives = $state<Array<NavigationRoute>>([]);
  let selectedRouteIndex = $state(0);

  // Turn-by-turn navigation
  let routeSteps = $state<NavigationStep[]>([]);
  let showStepList = $state(false);

  // Navigation mode (Phase 2)
  let navigationMode = $state(false);
  let currentStepIndex = $state(0);
  let navigationETA = $state('');
  let navigationRemainingDistance = $state(0);
  let navigationRemainingDuration = $state(0);

  // GPS tracking (Phase 3)
  let gpsWatchId = $state<number | null>(null);
  let userPosition = $state<{ lat: number; lng: number; accuracy: number; heading: number | null; speed: number | null } | null>(null);
  let userPositionMarker = $state<any>(null);
  let isFollowingUser = $state(true);
  let deviationCount = $state(0);
  let isRecalculating = $state(false);

  // Voice navigation (Phase 4)
  let voiceEnabled = $state(true);
  let voiceMuted = $state(false);
  let voiceLang = $state<'ja-JP' | 'en-US'>('ja-JP');
  let lastAnnouncedStepIndex = $state(-1);
  let lastAnnouncedDistance = $state<'far' | 'near' | 'now' | null>(null);

  // Multi-modal transit routing
  let multiModalJourney = $state<MultiModalJourney | null>(null);
  let multiModalAlternatives = $state<MultiModalJourney[]>([]);
  let journeyLegs = $state<JourneyLeg[]>([]);
  let showLegList = $state(false);
  let transitStepIndex = $state(0);

  const TRANSPARENT_TILE_DATA_URL =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnS6S8AAAAASUVORK5CYII=';

  function pickNiceScaleDistance(rawMeters: number): number {
    if (!Number.isFinite(rawMeters) || rawMeters <= 0) return 1000;
    const exponent = Math.floor(Math.log10(rawMeters));
    const base = 10 ** exponent;
    const ratio = rawMeters / base;
    const step = ratio >= 5 ? 5 : ratio >= 2 ? 2 : 1;
    return step * base;
  }

  function formatScaleDistance(meters: number): string {
    if (!Number.isFinite(meters) || meters <= 0) return '';
    if (meters < 1000) return `${Math.round(meters)} m`;
    if (meters < 1_000_000) {
      const km = meters / 1000;
      return km >= 100 ? `${Math.round(km)} km` : `${km.toFixed(km >= 10 ? 0 : 1)} km`;
    }
    const auMeters = 149_597_870_700;
    if (meters < auMeters * 0.1) return `${(meters / 1_000_000).toFixed(0)}k km`;
    if (meters < auMeters * 1000) {
      const au = meters / auMeters;
      return au >= 10 ? `${au.toFixed(0)} AU` : `${au.toFixed(1)} AU`;
    }
    const lyMeters = 9_460_730_472_580_800;
    const ly = meters / lyMeters;
    return ly >= 10 ? `${ly.toFixed(0)} ly` : `${ly.toFixed(1)} ly`;
  }

  function updateScaleIndicator() {
    const widthPx = Math.max(72, Math.min(140, Math.round((mapContainer?.clientWidth ?? 480) * 0.18)));
    const latitudeCos = Math.max(0.15, Math.cos((lat * Math.PI) / 180));
    const metersPerPixel = 156543.03392 * latitudeCos / (2 ** zoom);
    const rawMeters = metersPerPixel * widthPx;
    const niceMeters = pickNiceScaleDistance(rawMeters);
    const adjustedWidth = Math.max(32, Math.min(180, Math.round(niceMeters / metersPerPixel)));
    scaleBarWidthPx = adjustedWidth;
    scaleBarLabel = formatScaleDistance(niceMeters);
  }

  function parseRouteQuery(text: string): { origin: string; destination: string } | null {
    const t = text.trim();
    if (!t) return null;
    const patterns = [
      /^(.+?)から(.+?)まで$/u,
      /^(.+?)から(.+)$/u,
      /^(.+?)\s*(?:→|⇒|->)\s*(.+)$/u,
      /^from\s+(.+?)\s+to\s+(.+)$/iu,
      /^(.+?)\s+to\s+(.+)$/iu,
    ];
    for (const re of patterns) {
      const m = t.match(re);
      if (m && m[1].trim() && m[2].trim()) return { origin: m[1].trim(), destination: m[2].trim() };
    }
    return null;
  }

  interface MapSearchResult {
    id: string;
    title: string;
    subtitle: string;
    resultType: 'place' | 'resource';
    source: string;
    lat?: number;
    lng?: number;
    externalURL?: string;
    rawType?: string;
  }

  interface ResourceSearchResponse {
    query: string;
    results: Array<{
      id: string;
      title: string;
      snippet?: string;
      url?: string;
      source: string;
      kind: string;
      latitude?: number;
      longitude?: number;
      score: number;
    }>;
    sources?: Array<{
      name: string;
      status: string;
      results: number;
      error?: string;
    }>;
  }

  async function loadRuntimeConfig(): Promise<RuntimeMapConfig> {
    try {
      const timeoutMs = 2500;
      const config = await Promise.race<RuntimeMapConfig>([
        (async () => {
          const [base, kami] = await Promise.allSettled([getRuntimeConfig(), getKamiConfig()]);
          const merged: RuntimeMapConfig = base.status === 'fulfilled' ? (base.value ?? {}) : {};
          if (kami.status === 'fulfilled' && kami.value?.tileUrl) {
            merged.mapTileUrl = kami.value.tileUrl;
          }
          return merged;
        })(),
        new Promise<RuntimeMapConfig>((resolve) => {
          setTimeout(() => resolve({}), timeoutMs);
        }),
      ]);
      return config ?? {};
    } catch {
      return {};
    }
  }

  async function loadCdnDatasetLayer() {
    const cfg = runtimeConfig as any;
    const datasetURL = (cfg?.mapDataCdnUrl || cfg?.map_data_cdn_url || '').trim();
    if (!datasetURL || !map) return;

    try {
      const res = await fetch(datasetURL, { cache: 'no-store' });
      if (!res.ok) {
        console.warn('Dataset fetch failed', datasetURL, res.status);
        return;
      }
      const geojson = await res.json();
      if (!map.getSource('maps-dataset')) {
        map.addSource('maps-dataset', {
          type: 'geojson',
          data: geojson,
        });
      }
      if (!map.getLayer('maps-dataset-fill')) {
        map.addLayer({
          id: 'maps-dataset-fill',
          type: 'fill',
          source: 'maps-dataset',
          paint: {
            'fill-color': '#33b8ff',
            'fill-opacity': 0.16,
          },
          filter: ['==', '$type', 'Polygon'],
        });
      }
      if (!map.getLayer('maps-dataset-line')) {
        map.addLayer({
          id: 'maps-dataset-line',
          type: 'line',
          source: 'maps-dataset',
          paint: {
            'line-color': '#33b8ff',
            'line-width': 2,
            'line-opacity': 0.75,
          },
        });
      }
      if (!map.getLayer('maps-dataset-point')) {
        map.addLayer({
          id: 'maps-dataset-point',
          type: 'circle',
          source: 'maps-dataset',
          paint: {
            'circle-color': '#33b8ff',
            'circle-radius': 4,
            'circle-opacity': 0.9,
          },
          filter: ['==', '$type', 'Point'],
        });
      }
    } catch (err) {
      console.warn('Dataset layer load failed', err);
    }
  }

  function clearCrawlerMarkers() {
    for (const marker of crawlerMarkers) {
      marker.remove();
    }
    crawlerMarkers = [];
    if (crawlerPopup) {
      crawlerPopup.remove();
      crawlerPopup = null;
    }
  }

  function buildCrawlerMarkerColor(point: MapCrawlerLocationPoint): string {
    if (point.httpStatus >= 500) {
      return '#ff5c6c';
    }
    if (point.httpStatus >= 400) {
      return '#ff9a3c';
    }
    return '#00f7a0';
  }

  function formatCrawlerServerLine(point: MapCrawlerLocationPoint): string {
    const parts = [point.serverLocation, point.country, point.region, point.city].map((value) => value?.trim()).filter(Boolean);
    if (parts.length > 0) {
      return parts.join(' / ');
    }
    if (point.ip) {
      return point.ip;
    }
    return 'location unknown';
  }

  function formatCrawlerRelativeAt(raw: string): string {
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      return '時刻不明';
    }
    const now = Date.now();
    const diff = now - parsed.getTime();
    if (diff < 1000 * 60) {
      return `${Math.max(0, Math.floor(diff / 1000))}秒前`;
    }
    if (diff < 1000 * 60 * 60) {
      return `${Math.floor(diff / (1000 * 60))}分前`;
    }
    return parsed.toLocaleString('ja-JP');
  }

  function renderCrawlerMarkers() {
    if (!map || !maplibregl) return;
    clearCrawlerMarkers();

    for (const point of crawlerPoints) {
      if (!hasLocation(point)) {
        continue;
      }
      const markerEl = document.createElement('div');
      markerEl.style.width = '14px';
      markerEl.style.height = '14px';
      markerEl.style.borderRadius = '50%';
      markerEl.style.background = buildCrawlerMarkerColor(point);
      markerEl.style.border = '2px solid rgba(255,255,255,0.95)';
      markerEl.style.boxShadow = '0 2px 6px rgba(0,0,0,0.35)';
      markerEl.style.cursor = 'pointer';
      markerEl.title = `${point.title} (${formatCrawlerServerLine(point)})`;
      markerEl.style.touchAction = 'manipulation';

      const popup = new maplibregl.Popup({
        anchor: 'top',
        offset: 12,
        closeButton: false,
      }).setHTML(
        `<div style="font-size:12px;max-width:260px;line-height:1.4;">${point.title}<br><span style="color:#8be9fd">${point.host}</span><br><b>${point.ip}</b><br>${formatCrawlerServerLine(
          point
        )}</div>`
      );

      const marker = new maplibregl.Marker({ element: markerEl })
        .setLngLat([point.longitude, point.latitude])
        .setPopup(popup)
        .addTo(map);

      marker.getElement().addEventListener('mouseenter', () => {
        crawlerActivePoint = point;
      });
      marker.getElement().addEventListener('click', () => {
        crawlerActivePoint = point;
        marker.togglePopup();
      });

      crawlerMarkers = [...crawlerMarkers, marker];
      marker.getElement().addEventListener('focus', () => {
        crawlerActivePoint = point;
      });
    }
  }

  async function pollCrawlerLocations() {
    if (!map || typeof window === 'undefined') return;
    crawlerLoading = true;
    try {
      const payload = await getCrawlerLocations({
        jobStatus: crawlerWatchStatuses.join(','),
        jobLimit: 12,
        resultsPerJob: 40,
        limit: 240,
        includeUnresolved: true,
      });
      crawlerPoints = payload.points || [];
      crawlerJobCount = payload.jobCount;
      crawlerResultCount = payload.resultCount;
      crawlerQueriedJobs = payload.queriedJobs;
      crawlerQueriedResults = payload.queriedResults;
      crawlerRequestedStatuses = payload.requestedStatuses || crawlerWatchStatuses;
      crawlerLastUpdated = payload.fetchedAt ?? '';
      crawlerError = payload.errors?.length ? payload.errors[0] : null;
      if (!payload.points.some((point: MapCrawlerLocationPoint) => point.resultId === crawlerActivePoint?.resultId)) {
        crawlerActivePoint = null;
      }
      renderCrawlerMarkers();
    } catch (e) {
      crawlerError = e instanceof Error ? e.message : 'failed to load crawler locations';
      crawlerRequestedStatuses = crawlerWatchStatuses;
      crawlerJobCount = 0;
      crawlerResultCount = 0;
      crawlerQueriedJobs = 0;
      crawlerQueriedResults = 0;
    } finally {
      crawlerLoading = false;
      crawlerInitialized = true;
    }
  }

  function crawlerPointUpdatedText() {
    if (!crawlerLastUpdated) return '待機中';
    const d = new Date(crawlerLastUpdated);
    if (Number.isNaN(d.getTime())) {
      return '更新時刻不明';
    }
    return `${Math.floor((Date.now() - d.getTime()) / 1000)}秒前`;
  }

  function clearActorMarkers() {
    for (const marker of actorMarkers) {
      marker.remove();
    }
    actorMarkers = [];
  }

  function renderActorMarkers() {
    if (!map || !maplibregl) return;
    clearActorMarkers();
    if (!showActorLocations) return;
    for (const point of actorPoints) {
      if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) continue;
      const markerEl = document.createElement('div');
      markerEl.style.width = '12px';
      markerEl.style.height = '12px';
      markerEl.style.borderRadius = '50%';
      markerEl.style.background = '#60a5fa';
      markerEl.style.border = '2px solid rgba(255,255,255,0.95)';
      markerEl.style.boxShadow = '0 2px 6px rgba(0,0,0,0.35)';
      markerEl.style.cursor = 'pointer';
      markerEl.style.touchAction = 'manipulation';
      markerEl.title = `${point.displayName}${point.location ? ` (${point.location})` : ''}`;
      const popup = new maplibregl.Popup({
        anchor: 'top',
        offset: 12,
        closeButton: false,
      }).setHTML(
        `<div style="font-size:12px;max-width:260px;line-height:1.4;"><b>${point.displayName}</b><br><span style="color:#93c5fd">${point.did}</span>${point.location ? `<br>${point.location}` : ''}</div>`
      );
      const marker = new maplibregl.Marker({ element: markerEl })
        .setLngLat([point.longitude, point.latitude])
        .setPopup(popup)
        .addTo(map);
      actorMarkers = [...actorMarkers, marker];
    }
  }

  async function pollActorLocations() {
    if (!map || typeof window === 'undefined') return;
    actorLoading = true;
    try {
      const payload = await getActorLocations(250);
      actorPoints = payload.points || [];
      actorError = null;
      renderActorMarkers();
    } catch (e) {
      actorError = e instanceof Error ? e.message : 'failed to load actor locations';
    } finally {
      actorLoading = false;
    }
  }

  async function bootstrapMap() {
    runtimeConfig = await loadRuntimeConfig();
    const cfg = runtimeConfig as any;
    mapillaryToken = (cfg?.mapillaryAccessToken || cfg?.mapillary_access_token || '').trim();
    const mapTileUrlRaw = (cfg?.mapTileUrl || cfg?.map_tile_url || '').trim();
    // RisingWave-native rendering: vector layers now come from
    // `com.etzhayyim.apps.maps.tileGeoJson` XRPC, not external MVT tiles. Only honor
    // an explicit MVT URL from server config (legacy path for self-hosted
    // tile-server); otherwise keep empty so KAMI uses raster basemap + the
    // RisingWave overlay attached below.
    //
    // Known-broken host `tiles-maps.etzhayyim.com` (TLS handshake fails — no cert on
    // that 2nd-level subdomain) is explicitly rejected so stale server config
    // or registered VectorSource rows can't resurrect the black-tile path.
    const rawVectorCandidate = (
      cfg?.vectorTileUrl
      || cfg?.vector_tile_url
      || (mapTileUrlRaw.includes('.pbf') ? mapTileUrlRaw : '')
      || ''
    ).trim();
    const vectorTileUrlRaw = rawVectorCandidate.includes('tiles-maps.etzhayyim.com')
      ? ''
      : rawVectorCandidate;
    const vectorTileUrl = vectorTileUrlRaw ? decodeURIComponent(vectorTileUrlRaw) : '';
    const searchParams = typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
    // Render mode (URL param ?render=3d|flat, persisted in localStorage).
    // 3d is the default: KAMI owns the raster texture, pitched camera, vector
    // extrusions, and DEM globe/cosmic terrain. `flat` keeps the same KAMI
    // renderer but starts top-down and avoids DEM fetches.
    const renderParam = searchParams.get('render') ?? searchParams.get('engine');
    const storedRender = typeof window !== 'undefined'
      ? window.localStorage.getItem('maps:render')
      : null;
    const renderMode: MapRenderMode = (renderParam ?? storedRender ?? '3d') === 'flat'
      ? 'flat'
      : 'kami3d';
    mapRenderMode = renderMode;
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('maps:render', renderMode === 'kami3d' ? '3d' : 'flat');
    }
    const demOverride = searchParams.get('dem');
    const demEnabled = demOverride === '1' || (renderMode === 'kami3d' && demOverride !== '0');
    const demTileUrlRaw = demEnabled
      ? (cfg?.demTileUrl || cfg?.dem_tile_url || '').trim()
      : '';
    const DEFAULT_DEM_URL = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png';
    const demTileUrl = demEnabled
      ? (demTileUrlRaw ? decodeURIComponent(demTileUrlRaw) : DEFAULT_DEM_URL)
      : '';
    // Tile view mode (URL param ?view=map|satellite, persisted in localStorage).
    // map      → CartoDB Voyager (road+labels raster, Google-Maps style)
    // satellite→ Esri World Imagery (photo mosaic)
    // kami-map treats both as raster tiles and textures the same 3D tile mesh,
    // so the mode switch is purely a texture swap at bootstrap time.
    const viewParam = typeof window !== 'undefined' ? searchParams.get('view') : null;
    const storedView = typeof window !== 'undefined'
      ? window.localStorage.getItem('maps:view')
      : null;
    const viewMode = (viewParam ?? storedView ?? 'satellite') === 'map' ? 'map' : 'satellite';
    if (typeof window !== 'undefined') window.localStorage.setItem('maps:view', viewMode);
    const DEFAULT_SATELLITE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
    const DEFAULT_MAP_URL = 'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png';
    const defaultTileUrl = viewMode === 'map' ? DEFAULT_MAP_URL : DEFAULT_SATELLITE_URL;
    // User view toggle overrides server-configured tile URL. Only fall back to
    // server-configured mapTileUrlRaw when no explicit ?view=... / stored
    // preference is present — first-time visitors get whatever ops set.
    const userSelectedView = typeof window !== 'undefined'
      && (viewParam !== null || storedView !== null);
    const mapTileUrl = userSelectedView
      ? defaultTileUrl
      : (mapTileUrlRaw ? decodeURIComponent(mapTileUrlRaw) : defaultTileUrl);
    // ── KAMI Engine (WebGPU primary / WebGL2 fallback in engine) ──
    try {
      const createTimeoutMs = 4000;
      const createKami = KamiMapBridge.create('kami-map-canvas', {
        center: [lng, lat],
        zoom: 12,
        tileUrl: mapTileUrl,
        demTileUrl,
        pitch: renderMode === 'kami3d' ? 45 : 0,
        orbitalSystems: cfg?.orbitalSystems || cfg?.orbital_systems || [],
        orbitalBodies: cfg?.orbitalBodies || cfg?.orbital_bodies || [],
        celestialCatalogs: cfg?.celestialCatalogs || cfg?.celestial_catalogs || [],
        celestialObjects: cfg?.celestialObjects || cfg?.celestial_objects || [],
      });
      kamiMap = await Promise.race([
        createKami,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('KAMI create timed out')), createTimeoutMs);
        }),
      ]);
      void kamiMap.waitForFirstTile(8000).then((hasFirstTile) => {
        if (!hasFirstTile) {
          console.warn('KAMI tile bootstrap timed out; continuing with engine render loop');
        }
      });

      // `map` now directly is the KamiMapBridge instance — all MapLibre-compat
      // methods (addSource/addLayer/fitBounds/on/etc) are implemented on the bridge
      // and delegate to kami-map WASM. No JS map library is involved.
      map = kamiMap;
      if (import.meta.env.DEV) (window as any).__kamiMap = kamiMap;
      // URL `?graph-first=1` forces the forward-topology chunk path even if
      // runtimeConfig returned an external vectorTileUrl — lets us A/B the
      // graph pipeline without re-deploying server config.
      const graphFirstOverride = typeof window !== 'undefined'
        && new URLSearchParams(window.location.search).get('graph-first') === '1';
      if (vectorTileUrl && !graphFirstOverride) {
        // Legacy self-hosted MVT path. Only used when an explicit vector tile
        // URL is configured server-side (tile-server deployment).
        applyOpenMapTilesStyle(kamiMap, vectorTileUrl);
      } else {
        // Forward topology (2026-04-17): H3-indexed chunk reader. Cache-key =
        // h3Cell (stable across pans). Replaces bbox-per-moveend tileGeoJson.
        // Design: 90-docs/260417-maps-forward-topology-raw-to-webgpu.md
        applyChunkOverlay(kamiMap, (p) => getChunk(p));
      }

      // aismarine vessel layer (ADR-2605011500). MarineTraffic-equivalent.
      // Density hex polygons at zoom < 8, individual vessel circles at >= 8.
      // Click → fetch full detail via aismarineGetVesselDetail and overlay
      // the recent 24h track as a polyline source so the user can see where
      // the ship has been.
      let aismarineCtl: ReturnType<typeof applyAismarineOverlay> | null = null;
      aismarineCtl = applyAismarineOverlay(kamiMap, {
        // (assigned to component-scope ref below for the panel close button)
        onVesselClick: (props) => {
          void (async () => {
            try {
              vesselDetail = null;
              vesselDetailLoading = true;
              // Highlight the selected vessel immediately (don't wait for the
              // detail fetch). The clicked feature carries no geometry in
              // `props`, so we rely on the latest position via the detail
              // fetch — but draw a placeholder ring at the last-seen lat/lon
              // once it returns.
              const detail = await aismarineGetVesselDetail({ mmsi: props.mmsi });
              vesselDetail = detail;
              const last = detail.recentTrack?.[detail.recentTrack.length - 1];
              if (last) aismarineCtl?.selectVessel?.([last.lon, last.lat]);
              if (detail.recentTrack && detail.recentTrack.length >= 2) {
                aismarineCtl?.showTrack?.(
                  detail.recentTrack.map((p) => [p.lon, p.lat] as [number, number]),
                );
              } else {
                aismarineCtl?.clearTrack?.();
              }
            } catch (e) {
              console.error('[aismarine] getVesselDetail failed', e);
            } finally {
              vesselDetailLoading = false;
            }
          })();
        },
      });
      aismarineCtlRef = aismarineCtl;

      // Live tracker overlays (2026-05-05): Flightradar24 + N2YO equivalents.
      // 10s aircraft polling + 30s satellite polling. Server-side BPMNs feed
      // the underlying tables (vertex_aircraft_state, vertex_satellite_pass).
      // The toggle panel ($effect blocks above) drives apply/detach; here
      // we just expose the kamiMap reference so the effects know the map
      // is ready. Initial overlay attach happens in the effect's first run.
      kamiMapRef = kamiMap;

      // Celestial sphere background (HYG ~9K naked-eye stars + OpenNGC
      // ~5K deep-sky objects). Sits on a fixed canvas behind the WebGPU
      // surface so the globe view shows accurate star positions.
      celestialOverlayRef = applyCelestialSphereOverlay();

      // Phase 4 basemap: Natural Earth landmass vector pyramid (public domain,
      // self-hosted). Zoom-adaptive LOD — loads the minimum polygon density
      // the viewport can actually use:
      //   z0-2 → ne_110m_land  (127 features, ~50 KB gzip)
      //   z3-5 → ne_50m_land   (~1400 features, ~600 KB gzip)
      //   z6+  → layer hides, OSM raster / chunk overlay takes over
      // KAMI's canvas clear color naturally acts as ocean. Each tier cached
      // by browser (force-cache) so reloads on zoom cross are free.
      const BASEMAP_TIERS: Array<{ maxZoom: number; url: string; key: string }> = [
        { maxZoom: 2.99, url: '/basemap/world-land.geojson',     key: '110m' },
        { maxZoom: 5.99, url: '/basemap/world-land-50m.geojson', key: '50m'  },
      ];
      const sourceId = 'basemap-land';
      const layerId = 'basemap-land-fill';
      const featureCache = new Map<string, unknown[]>();
      const pickTier = (z: number) => {
        for (const t of BASEMAP_TIERS) if (z <= t.maxZoom) return t;
        return BASEMAP_TIERS[BASEMAP_TIERS.length - 1];
      };
      const loadTier = async (tier: { url: string; key: string }): Promise<unknown[]> => {
        if (featureCache.has(tier.key)) return featureCache.get(tier.key)!;
        const r = await fetch(tier.url, { cache: 'force-cache' });
        if (!r.ok) return [];
        const land = await r.json() as { features?: Array<{ geometry: { type: string; coordinates: number[][][] | number[][][][] } }> };
        const rings: [number, number][][] = [];
        for (const f of land.features ?? []) {
          const g = f.geometry;
          if (g.type === 'Polygon') {
            const outer = (g.coordinates as number[][][])[0];
            if (outer && outer.length >= 3) rings.push(outer as [number, number][]);
          } else if (g.type === 'MultiPolygon') {
            for (const poly of g.coordinates as number[][][][]) {
              const outer = poly[0];
              if (outer && outer.length >= 3) rings.push(outer as [number, number][]);
            }
          }
        }
        const features = rings.map((ring) => ({
          type: 'Feature' as const,
          geometry: { type: 'Polygon' as const, coordinates: [ring] },
          properties: {},
        }));
        featureCache.set(tier.key, features);
        return features;
      };
      let currentTierKey = '';
      const applyTier = async (z: number): Promise<void> => {
        const tier = pickTier(z);
        if (tier.key === currentTierKey) return;
        try {
          const features = await loadTier(tier);
          const src = kamiMap?.getSource(sourceId);
          if (src && typeof src.setData === 'function') {
            src.setData({ type: 'FeatureCollection', features } as never);
          }
          currentTierKey = tier.key;
        } catch (err) {
          console.warn(`basemap: tier ${tier.key} load failed`, err);
        }
      };
      void (async () => {
        try {
          kamiMap!.addSource(sourceId, {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
          } as never);
          kamiMap!.addLayer({
            id: layerId,
            type: 'fill',
            source: sourceId,
            paint: { 'fill-color': '#2d3a2a', 'fill-opacity': 0.85 },
            minzoom: 0,
            maxzoom: 6,
          } as never);
          await applyTier(zoom);
        } catch (err) {
          console.warn('basemap: init failed', err);
        }
      })();
      // Hook into zoom changes — the moveend handler below calls applyTier.
      (kamiMap as unknown as { _applyBasemapTier?: (z: number) => void })._applyBasemapTier = (z) => { void applyTier(z); };

      kamiMap.onMoveEnd(() => {
        const vp = kamiMap!.getViewport();
        lat = vp.lat;
        lng = vp.lng;
        zoom = vp.zoom;
        syncAutoPitch(vp.zoom);
        updateSpatialInfo();
        // Swap basemap LOD tier when zoom crosses a threshold.
        const hook = (kamiMap as unknown as { _applyBasemapTier?: (z: number) => void })._applyBasemapTier;
        if (hook) hook(vp.zoom);
      });

      if (renderMode === 'kami3d') {
        autoPitchEnabled = true;
        setPitchDeg(targetPitchForZoom(zoom));
      } else {
        autoPitchEnabled = false;
        setPitchDeg(0);
      }

      mapReady = true;
      mapError = null;
      updateSpatialInfo();
    } catch (e: any) {
      console.error('KAMI Map init failed', e);
      mapError = `KAMI init failed (WebGPU/WebGL2): ${e?.message || e}`;
      mapReady = true;
    }

    {
      // Shared place URL params
      const sp = new URLSearchParams(window.location.search);
      const sharedLat = parseFloat(sp.get('lat') || '');
      const sharedLng = parseFloat(sp.get('lng') || '');
      const sharedTitle = sp.get('title') || '';
      if (!isNaN(sharedLat) && !isNaN(sharedLng) && sharedTitle) {
        if (map) map.flyTo({ center: [sharedLng, sharedLat], zoom: 16, duration: 1200 });
        selectedPlace = {
          id: `shared-${sharedLat}-${sharedLng}`,
          title: sharedTitle,
          subtitle: `${sharedLat.toFixed(6)}, ${sharedLng.toFixed(6)}`,
          resultType: 'place',
          source: 'shared',
          lat: sharedLat,
          lng: sharedLng,
          externalURL: sp.get('url') || undefined,
        };
        showPlaceCard = true;
      }
    }
  }

  $effect(() => {
    if (mapBootstrapped || !mapContainer || typeof window === 'undefined') {
      return;
    }
    mapBootstrapped = true;
    void bootstrapMap();
  });

  // Debug HUD bootstrap: ?debug=1 on-load, or keyboard 'D' to toggle.
  $effect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('debug') === '1') debugHud = true;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'd' || e.key === 'D') {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        debugHud = !debugHud;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // FPS counter + chunk-overlay stats poll at 500ms while debug HUD is on.
  $effect(() => {
    if (!debugHud || typeof window === 'undefined') return;
    let raf = 0;
    const measure = (t: number) => {
      fpsFrames++;
      if (fpsLastT === 0) fpsLastT = t;
      const dt = t - fpsLastT;
      if (dt >= 500) {
        fpsCurrent = Math.round((fpsFrames * 1000) / dt);
        fpsFrames = 0;
        fpsLastT = t;
      }
      raf = requestAnimationFrame(measure);
    };
    raf = requestAnimationFrame(measure);
    const iv = setInterval(() => {
      const s = (window as unknown as { __chunkStats?: Record<string, unknown> }).__chunkStats;
      if (s) debugStats = { ...s };
    }, 500);
    return () => { cancelAnimationFrame(raf); clearInterval(iv); };
  });

  $effect(() => {
    if (!mapReady || typeof window === 'undefined' || crawlerPollTimer) {
      return;
    }
    const run = () => {
      void pollCrawlerLocations();
    };
    run();
    crawlerPollTimer = setInterval(run, 15000);
    return () => {
      if (crawlerPollTimer) {
        clearInterval(crawlerPollTimer);
        crawlerPollTimer = undefined;
      }
      clearCrawlerMarkers();
    };
  });

  $effect(() => {
    if (!mapReady || typeof window === 'undefined' || actorPollTimer) {
      return;
    }
    const run = () => {
      void pollActorLocations();
    };
    run();
    actorPollTimer = setInterval(run, 60000);
    return () => {
      if (actorPollTimer) {
        clearInterval(actorPollTimer);
        actorPollTimer = undefined;
      }
      clearActorMarkers();
    };
  });

  $effect(() => {
    if (!mapReady) return;
    if (showActorLocations) {
      renderActorMarkers();
    } else {
      clearActorMarkers();
    }
  });

  // Highlight railway/ferry layers based on selected profile
  $effect(() => {
    if (!map || !mapReady) return;
    const profile = routeProfile;
    const RAIL_HIGHLIGHT = 'transit-rail-highlight';
    const FERRY_HIGHLIGHT = 'transit-ferry-highlight';

    // Remove existing highlight layers
    for (const id of [RAIL_HIGHLIGHT, FERRY_HIGHLIGHT]) {
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
    }

    if (profile === 'transit' && routeMode) {
      // Highlight rail lines from vector tiles
      try {
        map.addLayer({
          id: RAIL_HIGHLIGHT,
          type: 'line',
          source: 'openmaptiles',
          'source-layer': 'transportation',
          filter: ['in', 'class', 'rail', 'transit'],
          paint: { 'line-color': '#e53935', 'line-width': 2.5, 'line-opacity': 0.5 },
          minzoom: 6,
        });
      } catch { /* source may not exist */ }
    } else if (profile === 'ferry' && routeMode) {
      try {
        map.addLayer({
          id: FERRY_HIGHLIGHT,
          type: 'line',
          source: 'openmaptiles',
          'source-layer': 'transportation',
          filter: ['==', 'class', 'ferry'],
          paint: { 'line-color': '#1565c0', 'line-width': 2.5, 'line-opacity': 0.5 },
          minzoom: 4,
        });
      } catch { /* source may not exist */ }
    }
  });

  function updateSpatialInfo() {
    const result = getSpatialIdentity(lat, lng, h3Resolution, 12);
    s2ID = result.s2CellId;
    h3ID = result.h3CellId;
    mgrs = result.mgrsCoordinate;
    updateScaleIndicator();
    updateH3Overlay();
  }

  $effect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => updateScaleIndicator();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });

  function updateH3Overlay() {
    if (!map) return;

    // Always remove the previous overlay before re-adding so toggle works.
    if (map.getLayer('h3-hex-fill')) map.removeLayer('h3-hex-fill');
    if (map.getLayer('h3-hex-outline')) map.removeLayer('h3-hex-outline');
    if (map.getSource('h3-hex')) map.removeSource('h3-hex');

    if (!showH3Grid) return;

    const ringSize = zoomToRingSize(zoom);
    const data = buildH3HexData(lat, lng, h3Resolution, ringSize);

    // Each H3 cell → a Polygon ring (boundary close-loop) + LineString outline.
    const polygonFeatures: Array<{
      type: 'Feature';
      geometry: { type: 'Polygon'; coordinates: [number, number][][] };
      properties: { h3Index: string; value: number };
    }> = [];
    const lineFeatures: Array<{
      type: 'Feature';
      geometry: { type: 'LineString'; coordinates: [number, number][] };
      properties: { h3Index: string };
    }> = [];

    for (const d of data) {
      const boundary = computeH3CellBoundary(d.h3Index); // [[lat, lng], ...]
      if (!boundary?.length) continue;
      // h3-js returns [lat, lng]; GeoJSON wants [lng, lat]. Close ring.
      const ringLngLat: [number, number][] = boundary.map(([la, lo]) => [lo, la]);
      ringLngLat.push(ringLngLat[0]);
      polygonFeatures.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [ringLngLat] },
        properties: { h3Index: d.h3Index, value: d.value },
      });
      lineFeatures.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: ringLngLat },
        properties: { h3Index: d.h3Index },
      });
    }

    // Single combined source; fill + outline layers reference the same data.
    map.addSource('h3-hex', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [...polygonFeatures, ...lineFeatures] },
    });

    map.addLayer({
      id: 'h3-hex-fill',
      type: 'fill',
      source: 'h3-hex',
      paint: { 'fill-color': '#00ffcc', 'fill-opacity': 0.18 },
    });

    map.addLayer({
      id: 'h3-hex-outline',
      type: 'line',
      source: 'h3-hex',
      paint: { 'line-color': '#00ffcc', 'line-width': 1.5 },
    });
  }

  // Weather layer functions
  async function fetchWeatherGrid() {
    if (!map || weatherLoading) return;
    weatherLoading = true;
    weatherError = null;
    try {
      const center = map.getCenter();
      const z = map.getZoom();
      // Adapt grid based on zoom level
      const gridStep = z >= 10 ? 0.25 : z >= 7 ? 0.5 : 1.0;
      const gridRadius = z >= 10 ? 2 : 3;
      const result = await apiGetWeatherGrid(center.lat, center.lng, gridStep, gridRadius);
      weatherFeatures = result.features;
      weatherFetchedAt = result.fetchedAt ?? '';
      if (result.errors?.length) {
        weatherError = result.errors.join('; ');
      }
      renderWeatherLayer();
    } catch (e: any) {
      weatherError = e?.message || 'Failed to fetch weather data';
    } finally {
      weatherLoading = false;
    }
  }

  function renderWeatherLayer() {
    if (!map || !mapReady) return;

    // Remove existing weather layers/sources
    for (const id of ['weather-wind-arrows', 'weather-wave-circles', 'weather-wave-labels']) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    if (map.getSource('weather-grid')) map.removeSource('weather-grid');

    if (!showWeatherLayer || weatherFeatures.length === 0) return;

    // Build GeoJSON with wind arrow rotation and wave sizing
    const geojson = {
      type: 'FeatureCollection' as const,
      features: weatherFeatures.map((f) => ({
        ...f,
        properties: {
          ...f.properties,
          'wind_speed': f.properties.weatherWindSpeed10m ?? 0,
          'wind_dir': f.properties.weatherWindDirection10m ?? 0,
          'wave_height': f.properties.marineWaveHeight ?? 0,
          'wave_dir': f.properties.marineWaveDirection ?? 0,
          'has_marine': f.properties.marineWaveHeight != null,
          // Wind speed color: 0-10=green, 10-20=yellow, 20+=red
          'wind_color': (f.properties.weatherWindSpeed10m ?? 0) < 10 ? '#4ade80'
            : (f.properties.weatherWindSpeed10m ?? 0) < 20 ? '#fbbf24' : '#ef4444',
          // Wave height color: 0-1=blue, 1-2=cyan, 2-3=yellow, 3+=red
          'wave_color': (f.properties.marineWaveHeight ?? 0) < 1 ? '#60a5fa'
            : (f.properties.marineWaveHeight ?? 0) < 2 ? '#22d3ee'
            : (f.properties.marineWaveHeight ?? 0) < 3 ? '#fbbf24' : '#ef4444',
          // Circle radius based on wave height (min 4, max 20)
          'wave_radius': Math.min(20, Math.max(4, (f.properties.marineWaveHeight ?? 0) * 5 + 4)),
          // Label: wind speed + wave height combined
          label: `${(f.properties.weatherWindSpeed10m ?? 0).toFixed(0)}m/s` +
            (f.properties.marineWaveHeight != null ? ` ${f.properties.marineWaveHeight.toFixed(1)}m` : ''),
        },
      })),
    };

    map.addSource('weather-grid', { type: 'geojson', data: geojson });

    // Wave height circles (ocean points)
    map.addLayer({
      id: 'weather-wave-circles',
      type: 'circle',
      source: 'weather-grid',
      filter: ['==', ['get', 'has_marine'], true],
      paint: {
        'circle-radius': ['get', 'wave_radius'],
        'circle-color': ['get', 'wave_color'],
        'circle-opacity': 0.5,
        'circle-stroke-width': 1,
        'circle-stroke-color': ['get', 'wave_color'],
        'circle-stroke-opacity': 0.8,
      },
    });

    // Wind direction arrows (symbol layer)
    map.addLayer({
      id: 'weather-wind-arrows',
      type: 'symbol',
      source: 'weather-grid',
      layout: {
        'icon-image': 'wind-arrow',
        'icon-size': ['interpolate', ['linear'], ['get', 'wind_speed'], 0, 0.5, 10, 0.8, 30, 1.2],
        'icon-rotate': ['get', 'wind_dir'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'text-field': ['get', 'label'],
        'text-size': 10,
        'text-offset': [0, 1.8],
        'text-allow-overlap': false,
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      },
      paint: {
        'icon-color': ['get', 'wind_color'],
        'icon-opacity': 0.9,
        'text-color': '#e5e5e5',
        'text-halo-color': 'rgba(0,0,0,0.7)',
        'text-halo-width': 1,
      },
    });
  }

  function ensureWindArrowImage() {
    if (!map || map.hasImage('wind-arrow')) return;
    // Create a simple arrow image for wind direction
    const size = 32;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, size, size);
    // Arrow pointing up (0° = north), will be rotated by icon-rotate
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // Shaft
    ctx.beginPath();
    ctx.moveTo(size / 2, size * 0.8);
    ctx.lineTo(size / 2, size * 0.15);
    ctx.stroke();
    // Arrowhead
    ctx.beginPath();
    ctx.moveTo(size * 0.3, size * 0.35);
    ctx.lineTo(size / 2, size * 0.15);
    ctx.lineTo(size * 0.7, size * 0.35);
    ctx.stroke();
    map.addImage('wind-arrow', { width: size, height: size, data: ctx.getImageData(0, 0, size, size).data }, { sdf: true });
  }

  function toggleWeatherLayer() {
    if (showWeatherLayer) {
      ensureWindArrowImage();
      void fetchWeatherGrid();
      // Re-fetch on map move (debounced)
      if (!weatherPollTimer) {
        weatherPollTimer = setInterval(() => {
          if (showWeatherLayer && mapReady) void fetchWeatherGrid();
        }, 300_000); // Refresh every 5 minutes
      }
    } else {
      // Remove layers
      if (map) {
        for (const id of ['weather-wind-arrows', 'weather-wave-circles', 'weather-wave-labels']) {
          if (map.getLayer(id)) map.removeLayer(id);
        }
        if (map.getSource('weather-grid')) map.removeSource('weather-grid');
      }
      if (weatherPollTimer) {
        clearInterval(weatherPollTimer);
        weatherPollTimer = undefined;
      }
      weatherFeatures = [];
    }
  }

  // ── 3D mode + underground cross-section ──

  const INFRA_LABEL: Record<string, string> = {
    water: '水道', sewage: '下水', gas: 'ガス', electric: '電気',
    telecom: '通信', subway: '地下鉄', districtHeating: '地域暖房',
  };

  async function fetchUnderground() {
    undergroundLoading = true;
    undergroundError = null;
    try {
      const vp = kamiMap ? kamiMap.getViewport() : { lat, lng };
      undergroundData = await apiInfraCrossSection(vp.lat, vp.lng, 500);
    } catch (e) {
      undergroundError = e instanceof Error ? e.message : '地下データ取得失敗';
      undergroundData = null;
    } finally {
      undergroundLoading = false;
    }
  }

  function targetPitchForZoom(currentZoom: number): number {
    if (!Number.isFinite(currentZoom)) return 0;
    if (currentZoom < 10) return 0;
    if (currentZoom < 11.5) return 28;
    if (currentZoom < 13) return 45;
    if (currentZoom < 14.5) return 52;
    return 55;
  }

  function syncAutoPitch(currentZoom: number) {
    if (!autoPitchEnabled || show3DPanel) return;
    const target = targetPitchForZoom(currentZoom);
    if (pitch3D === target) return;
    setPitchDeg(target);
  }

  function setPitchDeg(deg: number) {
    pitch3D = deg;
    kamiMap?.setPitch(deg);
  }

  function setMapRenderMode(next: MapRenderMode) {
    if (next === 'kami-walk') { enterWalkMode(); return; }
    mapRenderMode = next;
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('maps:render', next === 'kami3d' ? '3d' : 'flat');
    const url = new URL(window.location.href);
    url.searchParams.set('render', next === 'kami3d' ? '3d' : 'flat');
    window.location.assign(url.toString());
  }

  function enterWalkMode() {
    if (typeof window === 'undefined') return;
    mapRenderMode = 'kami-walk';
  }

  function exitWalkMode() {
    mapRenderMode = 'kami3d';
  }

  // Listen for postMessage from the walk iframe (exit-walk signal).
  $effect(() => {
    if (typeof window === 'undefined') return;
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'exit-walk') exitWalkMode();
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  });

  function toggle3D() {
    if (!show3DPanel) {
      show3DPanel = true;
      autoPitchEnabled = false;
      setPitchDeg(55);
      void fetchUnderground();
    } else {
      show3DPanel = false;
      autoPitchEnabled = true;
      syncAutoPitch(zoom);
      undergroundData = null;
    }
  }

  function onSearchInput() {
    clearTimeout(debounceTimer);
    if (searchQuery.trim().length < 2) {
      searchResults = [];
      searchStatusText = '';
      showResults = false;
      return;
    }
    const routeParsed = parseRouteQuery(searchQuery.trim());
    if (routeParsed) {
      searchResults = [];
      searchStatusText = `ルート検索: ${routeParsed.origin} → ${routeParsed.destination} (Enter で検索)`;
      showResults = true;
      return;
    }
    debounceTimer = setTimeout(() => {
      void runUnifiedSearch(searchQuery.trim());
    }, 300);
  }

  async function graphSearchAPI(query: string): Promise<MapSearchResult[]> {
    try {
      const payload = await apiGraphSearchNodes(query, 12);
      return (payload.nodes || [])
        .filter((node) => node.label && node.label !== '<nil>')
        .map((node) => ({
          id: node.id,
          title: node.label,
          subtitle: node.description && node.description !== '<nil>' ? node.description : node.types?.join(', ') || node.nsPrefix || '',
          resultType: 'resource' as const,
          source: 'entity_graph',
          lat: node.latitude,
          lng: node.longitude,
          externalURL: node.sourceUrl && node.sourceUrl !== '<nil>' ? node.sourceUrl : undefined,
          rawType: node.types?.[0] || node.nsPrefix,
        }));
    } catch {
      return [];
    }
  }

  async function runUnifiedSearch(query: string) {
    searching = true;
    showResults = true;
    searchStatusText = '';
    clearPOIMarkers();
    clearSearchResultPins();
    try {
      const poiCategory = detectPOICategory(query);
      if (poiCategory) {
        // POI category search: Overpass (nearby) + Nominatim + Resources + Entity graph in parallel
        const [poiResults, placeResults, resourceResults, entityResults] = await Promise.all([
          searchNearbyPOI(poiCategory.tag, poiCategory.label),
          searchPlaces(query),
          searchResourcesAPI(query),
          graphSearchAPI(query),
        ]);
        const combined = [...poiResults, ...entityResults, ...placeResults, ...resourceResults].slice(0, 30);
        searchResults = combined;
        if (poiResults.length > 0) {
          const extraSources = entityResults.length > 0 ? ' + entity graph' : '';
          searchStatusText = `${poiCategory.label}: ${poiResults.length}件 (周辺)${extraSources}`;
          showPOIMarkersOnMap(poiResults);
        } else {
          searchStatusText = `${poiCategory.label}: 周辺に見つかりません`;
        }
        showSearchResultsAsMarkers(combined);
      } else {
        // Normal search: Nominatim + Resources + Entity graph
        const [placeResults, resourceResults, entityResults] = await Promise.all([
          searchPlaces(query),
          searchResourcesAPI(query),
          graphSearchAPI(query),
        ]);
        const combined = [...entityResults, ...placeResults, ...resourceResults].slice(0, 20);
        searchResults = combined;
        const sources: string[] = [];
        if (entityResults.length > 0) sources.push(`entity graph: ${entityResults.length}件`);
        if (resourceResults.length > 0) sources.push('landowners / crawler / search');
        searchStatusText = sources.join(' / ');
        showSearchResultsAsMarkers(combined);
      }
    } catch (e) {
      console.error('Unified search failed', e);
      searchResults = [];
      searchStatusText = '';
    } finally {
      searching = false;
    }
  }

  async function searchPlaces(query: string): Promise<MapSearchResult[]> {
    try {
      const rows = await apiSearchPlaces(query, 6);
      return rows
        .filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lng))
        .map((row) => ({
          id: `place-${row.placeId || row.label}`,
          title: row.label,
          subtitle: formatPlaceType(row.kind),
          resultType: 'place',
          source: 'graph',
          lat: row.lat!,
          lng: row.lng!,
          rawType: row.kind,
        }));
    } catch (e) {
      console.warn('searchPlaces XRPC failed', e);
      return [];
    }
  }

  async function searchResourcesAPI(query: string): Promise<MapSearchResult[]> {
    try {
      const payload = await apiSearchResources(query, 8);
      return (payload.results || []).map((row) => ({
        id: row.id,
        title: row.title,
        subtitle: row.snippet || `${row.source} result`,
        resultType: 'resource' as const,
        source: row.source,
        externalURL: row.url,
        lat: row.latitude,
        lng: row.longitude,
        rawType: row.kind,
      }));
    } catch {
      return [];
    }
  }

  function selectResult(result: MapSearchResult) {
    if (result.lat != null && result.lng != null) {
      if (!maplibregl || !map) return;
      // POI and search result pins are already on the map; only place a standalone
      // marker for nominatim results that don't have a search-result pin yet.
      if (result.source !== 'overpass' && result.source !== 'entity_graph' && searchResultPins.length === 0) {
        if (searchMarker) searchMarker.remove();
        searchMarker = new maplibregl.Marker({ color: '#00ffcc' })
          .setLngLat([result.lng, result.lat])
          .addTo(map!);
      } else if (searchMarker) {
        searchMarker.remove();
        searchMarker = null;
      }
      map!.flyTo({
        center: [result.lng, result.lat],
        zoom: Math.max(map!.getZoom(), 16),
        duration: 1500,
      });
      selectedPlace = result;
      showPlaceCard = true;
      entityNeighbors = [];
      if (result.source === 'entity_graph') {
        void loadEntityNeighbors(result.id);
      }
    } else if (result.externalURL) {
      window.open(result.externalURL, '_blank', 'noopener');
    }
    searchQuery = result.title;
    showResults = false;
  }

  function closePlaceCard() {
    showPlaceCard = false;
    selectedPlace = null;
    entityNeighbors = [];
    entityNeighborsLoading = false;
    if (searchMarker) {
      searchMarker.remove();
      searchMarker = null;
    }
  }

  function placeCardGradient(place: MapSearchResult): string {
    if (place.source === 'entity_graph') return 'linear-gradient(135deg, #5b21b6 0%, #4338ca 100%)';
    if (place.resultType === 'resource') return 'linear-gradient(135deg, #c2410c 0%, #d97706 100%)';
    if (place.source === 'nominatim') return 'linear-gradient(135deg, #0369a1 0%, #0891b2 100%)';
    if (place.source === 'overpass') return 'linear-gradient(135deg, #166534 0%, #15803d 100%)';
    return 'linear-gradient(135deg, #047857 0%, #0d9488 100%)';
  }

  function placeIcon(place: MapSearchResult): string {
    const t = (place.rawType || '').toLowerCase();
    if (t.includes('route')) return '🗺️';
    if (t.includes('organization') || t.includes('org')) return '🏢';
    if (t.includes('person')) return '👤';
    if (t.includes('location') || place.source === 'nominatim') return '📍';
    if (place.source === 'entity_graph') return '🔗';
    if (place.source === 'overpass') return '🏪';
    return '📌';
  }

  function neighborIcon(edge: GraphEdge): string {
    const p = (edge.predicate || '').toLowerCase();
    const types = ((edge.objectTypes || []).join(' ')).toLowerCase();
    if (types.includes('organization')) return '🏢';
    if (types.includes('person')) return '👤';
    if (types.includes('location')) return '📍';
    if (types.includes('route')) return '🗺️';
    if (p.includes('latitude') || p.includes('longitude')) return '🌐';
    if (p.includes('url') || p.includes('source')) return '🔗';
    if (p.includes('name') || p.includes('label')) return '🏷️';
    return '◦';
  }

  async function sharePlace(place: MapSearchResult) {
    const baseUrl = typeof window !== 'undefined' ? window.location.origin : 'https://maps.etzhayyim.com';
    const params = new URLSearchParams({ title: place.title });
    if (place.lat != null) params.set('lat', place.lat.toFixed(6));
    if (place.lng != null) params.set('lng', place.lng.toFixed(6));
    if (place.externalURL) params.set('url', place.externalURL);
    const shareUrl = `${baseUrl}/?${params.toString()}`;
    const shareData = {
      title: place.title,
      text: place.subtitle ? `${place.title} — ${place.subtitle}` : place.title,
      url: shareUrl,
    };
    try {
      if (navigator.share && navigator.canShare?.(shareData)) {
        await navigator.share(shareData);
      } else {
        await navigator.clipboard.writeText(shareUrl);
        shareCopied = true;
        setTimeout(() => { shareCopied = false; }, 2000);
      }
    } catch {
      // user cancelled or clipboard unavailable
    }
  }

  async function loadEntityNeighbors(nodeId: string) {
    entityNeighbors = [];
    entityNeighborsLoading = true;
    try {
      const res = await apiGraphNeighbors(nodeId, 'both');
      entityNeighbors = (res.edges || []).filter(e => {
        const p = (e.predicate || '').toLowerCase();
        return !p.includes('latitude') && !p.includes('longitude') && !p.includes('_doc_id');
      }).slice(0, 12);
    } catch {
      entityNeighbors = [];
    } finally {
      entityNeighborsLoading = false;
    }
  }

  function startDirectionsFromPlace() {
    if (!selectedPlace || selectedPlace.lat == null || selectedPlace.lng == null) return;
    routeMode = true;
    routeEnd = { lat: selectedPlace.lat!, lng: selectedPlace.lng!, label: selectedPlace.title };
    routeDestInput = selectedPlace.title;
    placeRouteMarker('end', [selectedPlace.lng!, selectedPlace.lat!]);
    showPlaceCard = false;
    selectedPlace = null;
    void loadSavedRoutes();
  }

  function clearSearch() {
    searchQuery = '';
    searchResults = [];
    searchStatusText = '';
    showResults = false;
    closePlaceCard();
    clearPOIMarkers();
    clearSearchResultPins();
    searchInputEl?.focus();
  }

  function onSearchKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      showResults = false;
      searchInputEl?.blur();
    }
    if (e.key === 'Enter') {
      const routeParsed = parseRouteQuery(searchQuery.trim());
      if (routeParsed) {
        showResults = false;
        routeMode = true;
        void executeRouteSearch(searchQuery.trim());
        return;
      }
      if (searchResults.length > 0) {
        selectResult(searchResults[0]);
      }
    }
  }

  function onSearchBlur() {
    setTimeout(() => {
      showResults = false;
    }, 200);
  }

  // --- POI category search (Overpass API) ---
  const POI_CATEGORIES: Array<{ keywords: string[]; tag: string; label: string }> = [
    { keywords: ['レストラン', 'restaurant', '食事', '飲食'], tag: '"amenity"="restaurant"', label: 'レストラン' },
    { keywords: ['カフェ', 'cafe', 'coffee', 'コーヒー'], tag: '"amenity"="cafe"', label: 'カフェ' },
    { keywords: ['コンビニ', 'convenience', 'コンビニエンス'], tag: '"shop"="convenience"', label: 'コンビニ' },
    { keywords: ['スーパー', 'supermarket', 'スーパーマーケット'], tag: '"shop"="supermarket"', label: 'スーパー' },
    { keywords: ['薬局', 'pharmacy', 'ドラッグストア'], tag: '"amenity"="pharmacy"', label: '薬局' },
    { keywords: ['病院', 'hospital', 'クリニック', 'clinic'], tag: '"amenity"~"hospital|clinic"', label: '病院' },
    { keywords: ['銀行', 'bank', 'atm'], tag: '"amenity"~"bank|atm"', label: '銀行' },
    { keywords: ['ホテル', 'hotel', '旅館', '宿泊'], tag: '"tourism"~"hotel|guest_house"', label: 'ホテル' },
    { keywords: ['駐車場', 'parking'], tag: '"amenity"="parking"', label: '駐車場' },
    { keywords: ['ガソリンスタンド', 'gas station', '給油'], tag: '"amenity"="fuel"', label: 'GS' },
    { keywords: ['公園', 'park'], tag: '"leisure"="park"', label: '公園' },
    { keywords: ['学校', 'school'], tag: '"amenity"="school"', label: '学校' },
    { keywords: ['郵便局', 'post office'], tag: '"amenity"="post_office"', label: '郵便局' },
    { keywords: ['ラーメン', 'ramen'], tag: '"cuisine"="ramen"', label: 'ラーメン' },
    { keywords: ['寿司', 'sushi'], tag: '"cuisine"="sushi"', label: '寿司' },
    { keywords: ['居酒屋', 'izakaya', 'bar', 'バー'], tag: '"amenity"~"bar|pub"', label: 'バー' },
    { keywords: ['神社', 'shrine'], tag: '"amenity"="place_of_worship"', label: '神社' },
    { keywords: ['寺', 'temple'], tag: '"amenity"="place_of_worship"', label: '寺院' },
  ];

  let poiMarkers = $state<any[]>([]);
  let searchResultPins = $state<any[]>([]);

  function clearSearchResultPins() {
    for (const m of searchResultPins) m.remove();
    searchResultPins = [];
  }

  // Pin color by source
  function searchPinColor(source: string, resultType: string): string {
    if (source === 'entity_graph') return '#9a7cff';
    if (resultType === 'resource') return '#ff9a3c';
    if (source === 'nominatim') return '#00b4d8';
    return '#00ffcc';
  }

  function showSearchResultsAsMarkers(results: MapSearchResult[]) {
    clearSearchResultPins();
    if (!maplibregl || !map) return;
    for (const r of results) {
      if (r.lat == null || r.lng == null) continue;
      if (r.source === 'overpass') continue; // POI markers managed separately
      const marker = new maplibregl.Marker({ color: searchPinColor(r.source, r.resultType), scale: 0.75 })
        .setLngLat([r.lng, r.lat])
        .addTo(map!);
      marker.getElement().addEventListener('click', () => {
        selectedPlace = r;
        showPlaceCard = true;
        entityNeighbors = [];
        if (r.source === 'entity_graph') void loadEntityNeighbors(r.id);
        map!.flyTo({ center: [r.lng!, r.lat!], zoom: Math.max(map!.getZoom(), 16), duration: 800 });
      });
      searchResultPins = [...searchResultPins, marker];
    }
  }

  function detectPOICategory(query: string): { tag: string; label: string } | null {
    const q = query.trim().toLowerCase();
    for (const cat of POI_CATEGORIES) {
      for (const kw of cat.keywords) {
        if (q.includes(kw.toLowerCase())) return { tag: cat.tag, label: cat.label };
      }
    }
    return null;
  }

  function clearPOIMarkers() {
    for (const m of poiMarkers) m.remove();
    poiMarkers = [];
  }

  async function searchNearbyPOI(tag: string, label: string): Promise<MapSearchResult[]> {
    if (!map) return [];
    const bounds = map.getBounds();
    const south = bounds.getSouth();
    const west = bounds.getWest();
    const north = bounds.getNorth();
    const east = bounds.getEast();
    const query = `[out:json][timeout:10];(node[${tag}](${south},${west},${north},${east});way[${tag}](${south},${west},${north},${east}););out center body 30;`;
    try {
      const res = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        body: `data=${encodeURIComponent(query)}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      if (!res.ok) return [];
      const data = await res.json();
      const elements: any[] = data.elements || [];
      return elements
        .filter((el: any) => (el.lat || el.center?.lat) && (el.tags?.name || el.tags?.['name:ja']))
        .map((el: any, i: number) => {
          const elLat = el.lat ?? el.center?.lat;
          const elLng = el.lon ?? el.center?.lon;
          const name = el.tags?.['name:ja'] || el.tags?.name || label;
          const cuisine = el.tags?.cuisine ? ` (${el.tags.cuisine})` : '';
          const addr = el.tags?.['addr:full'] || el.tags?.['addr:street'] || '';
          const hours = el.tags?.opening_hours || '';
          const website = el.tags?.website || '';
          const subtitleParts = [label + cuisine, addr, hours].filter(Boolean);
          return {
            id: `poi-${el.id || i}`,
            title: name,
            subtitle: subtitleParts.join(' / '),
            resultType: 'place' as const,
            source: 'overpass',
            lat: elLat,
            lng: elLng,
            externalURL: website || undefined,
            rawType: label,
          };
        });
    } catch {
      return [];
    }
  }

  function showPOIMarkersOnMap(results: MapSearchResult[]) {
    clearPOIMarkers();
    if (!maplibregl || !map) return;
    for (const r of results) {
      if (r.lat == null || r.lng == null) continue;
      const el = document.createElement('div');
      el.style.cssText = 'width:28px;height:28px;border-radius:50%;background:#ff6b6b;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.3);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:12px;';
      el.textContent = r.rawType?.charAt(0) || '?';
      el.style.color = '#fff';
      el.style.fontWeight = '700';
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([r.lng, r.lat])
        .addTo(map!);
      marker.getElement().addEventListener('click', () => {
        selectedPlace = r;
        showPlaceCard = true;
        entityNeighbors = [];
        map!.flyTo({ center: [r.lng!, r.lat!], zoom: Math.max(map!.getZoom(), 16), duration: 800 });
      });
      poiMarkers.push(marker);
    }
    // Fit bounds to show all POI markers
    if (results.length > 1 && maplibregl) {
      const b = new maplibregl.LngLatBounds();
      for (const r of results) {
        if (r.lat != null && r.lng != null) b.extend([r.lng, r.lat]);
      }
      map!.fitBounds(b, { padding: 60, duration: 800 });
    }
  }

  function formatPlaceType(type: string): string {
    const typeMap: Record<string, string> = {
      city: '市区町村',
      town: '町',
      village: '村',
      suburb: '地区',
      neighbourhood: '近隣',
      road: '道路',
      station: '駅',
      restaurant: 'レストラン',
      cafe: 'カフェ',
      hotel: 'ホテル',
      hospital: '病院',
      school: '学校',
      university: '大学',
      park: '公園',
      museum: '博物館',
      library: '図書館',
      temple: '寺院',
      shrine: '神社',
      administrative: '行政区',
      building: '建物',
      house: '住所',
      amenity: '施設',
    };
    return typeMap[type] || type;
  }

  function formatResultType(result: MapSearchResult): string {
    if (result.resultType === 'resource') {
      return `${result.source} resource`;
    }
    if (result.rawType) {
      return formatPlaceType(result.rawType);
    }
    return result.source;
  }

  // --- Navigation mode (Phase 2-4) ---
  function flyToStep(step: NavigationStep) {
    if (!map || !step.maneuverLocation) return;
    map.flyTo({ center: step.maneuverLocation, zoom: Math.max(map.getZoom(), 16), duration: 800 });
  }

  function updateNavigationETA() {
    const eta = new Date(Date.now() + navigationRemainingDuration * 1000);
    navigationETA = `${eta.getHours().toString().padStart(2, '0')}:${eta.getMinutes().toString().padStart(2, '0')}`;
  }

  function startNavigation() {
    if (routeSteps.length === 0 || !routeGeometry) return;
    navigationMode = true;
    currentStepIndex = 0;
    navigationRemainingDistance = routeDistance;
    navigationRemainingDuration = routeDuration;
    lastAnnouncedStepIndex = -1;
    lastAnnouncedDistance = null;
    deviationCount = 0;
    updateNavigationETA();
    startGPSTracking();
    if (map && routeSteps[0]) {
      map.easeTo({
        center: routeSteps[0].maneuverLocation,
        zoom: 17, pitch: 60, bearing: routeSteps[0].bearingAfter,
        duration: 1000,
      });
    }
  }

  function startTransitNavigation() {
    if (!multiModalJourney || journeyLegs.length === 0) return;
    navigationMode = true;
    transitStepIndex = 0;
    const currentLeg = journeyLegs[0];
    if (map && currentLeg) {
      map.flyTo({ center: currentLeg.fromCoords, zoom: 15, duration: 1000 });
    }
  }

  function nextTransitLeg() {
    if (transitStepIndex < journeyLegs.length - 1) {
      transitStepIndex++;
      const leg = journeyLegs[transitStepIndex];
      if (map && leg) map.flyTo({ center: leg.fromCoords, zoom: 15, duration: 800 });
    } else {
      stopNavigation();
    }
  }

  function prevTransitLeg() {
    if (transitStepIndex > 0) {
      transitStepIndex--;
      const leg = journeyLegs[transitStepIndex];
      if (map && leg) map.flyTo({ center: leg.fromCoords, zoom: 15, duration: 800 });
    }
  }

  function stopNavigation() {
    navigationMode = false;
    currentStepIndex = 0;
    transitStepIndex = 0;
    navigationETA = '';
    navigationRemainingDistance = 0;
    navigationRemainingDuration = 0;
    stopGPSTracking();
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    if (map) map.easeTo({ pitch: 0, bearing: 0, duration: 500 });
  }

  // GPS tracking
  function startGPSTracking() {
    if (!navigator.geolocation) return;
    gpsWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, accuracy, heading, speed } = pos.coords;
        userPosition = { lat: latitude, lng: longitude, accuracy, heading, speed };
        updateUserMarker();
        if (navigationMode) {
          updateNavigationProgress();
          if (isFollowingUser && map) {
            map.easeTo({ center: [longitude, latitude], bearing: heading ?? map.getBearing(), duration: 300 });
          }
        }
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 },
    );
  }

  function stopGPSTracking() {
    if (gpsWatchId !== null) {
      navigator.geolocation.clearWatch(gpsWatchId);
      gpsWatchId = null;
    }
    if (userPositionMarker) { userPositionMarker.remove(); userPositionMarker = null; }
    userPosition = null;
  }

  function updateUserMarker() {
    if (!map || !maplibregl || !userPosition) return;
    if (!userPositionMarker) {
      const el = document.createElement('div');
      el.innerHTML = '<div style="width:20px;height:20px;position:relative"><div style="width:20px;height:20px;border-radius:50%;background:#4285f4;border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3);position:relative;z-index:2"></div><div style="width:40px;height:40px;border-radius:50%;background:rgba(66,133,244,0.15);position:absolute;top:-10px;left:-10px;z-index:1"></div></div>';
      userPositionMarker = new maplibregl.Marker({ element: el }).setLngLat([userPosition.lng, userPosition.lat]).addTo(map);
    } else {
      userPositionMarker.setLngLat([userPosition.lng, userPosition.lat]);
    }
  }

  function updateNavigationProgress() {
    if (!userPosition || !routeSteps.length || !routeGeometry) return;
    const coords: [number, number][] = routeGeometry.coordinates;
    let minDist = Infinity;
    for (let i = 0; i < coords.length; i++) {
      const d = haversineDistance(userPosition.lat, userPosition.lng, coords[i][1], coords[i][0]);
      if (d < minDist) minDist = d;
    }
    // Deviation detection
    if (minDist > DEVIATION_THRESHOLD_METERS) {
      deviationCount++;
      if (deviationCount >= 3 && !isRecalculating) void recalculateRoute();
    } else {
      deviationCount = 0;
    }
    // Update current step
    for (let i = currentStepIndex; i < routeSteps.length; i++) {
      const loc = routeSteps[i].maneuverLocation;
      if (haversineDistance(userPosition.lat, userPosition.lng, loc[1], loc[0]) < 30) {
        currentStepIndex = i;
        break;
      }
    }
    // Update remaining
    let rem = 0, remT = 0;
    for (let i = currentStepIndex; i < routeSteps.length; i++) {
      rem += routeSteps[i].distance;
      remT += routeSteps[i].duration;
    }
    navigationRemainingDistance = rem;
    navigationRemainingDuration = remT;
    updateNavigationETA();
    checkVoiceTriggers();
  }

  async function recalculateRoute() {
    if (!userPosition || !routeEnd) return;
    isRecalculating = true;
    routeStart = { lat: userPosition.lat, lng: userPosition.lng, label: '現在地' };
    routeOriginInput = '現在地';
    await calculateRoute();
    currentStepIndex = 0;
    deviationCount = 0;
    isRecalculating = false;
  }

  // Voice navigation
  function announceStep(text: string) {
    if (voiceMuted || !voiceEnabled || typeof speechSynthesis === 'undefined') return;
    speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = voiceLang;
    utt.rate = 1.0;
    const voices = speechSynthesis.getVoices();
    const pref = voices.find(v => v.lang === voiceLang || v.lang.startsWith(voiceLang.split('-')[0]));
    if (pref) utt.voice = pref;
    speechSynthesis.speak(utt);
  }

  function checkVoiceTriggers() {
    if (!navigationMode || !userPosition || routeSteps.length === 0) return;
    const nextIdx = currentStepIndex < routeSteps.length - 1 ? currentStepIndex + 1 : currentStepIndex;
    const next = routeSteps[nextIdx];
    if (!next) return;
    const dist = haversineDistance(userPosition.lat, userPosition.lng, next.maneuverLocation[1], next.maneuverLocation[0]);
    let trigger: 'far' | 'near' | 'now' | null = null;
    if (dist <= VOICE_TRIGGER_NOW) trigger = 'now';
    else if (dist <= VOICE_TRIGGER_NEAR) trigger = 'near';
    else if (dist <= VOICE_TRIGGER_FAR) trigger = 'far';
    if (trigger && (nextIdx !== lastAnnouncedStepIndex || trigger !== lastAnnouncedDistance)) {
      lastAnnouncedStepIndex = nextIdx;
      lastAnnouncedDistance = trigger;
      if (voiceLang === 'ja-JP') {
        if (trigger === 'far') announceStep(`${Math.round(dist)}メートル先、${next.instruction}`);
        else if (trigger === 'near') announceStep(`まもなく${next.instruction}`);
        else announceStep(`${next.instruction}してください`);
      } else {
        if (trigger === 'far') announceStep(`In ${Math.round(dist)} meters, ${next.instructionEn}`);
        else if (trigger === 'near') announceStep(`Prepare to ${next.instructionEn}`);
        else announceStep(next.instructionEn);
      }
    }
  }

  // --- Mapillary coverage + viewer ---
  let mapillaryViewerLat = $state<number | null>(null);
  let mapillaryViewerLng = $state<number | null>(null);

  async function openStreetViewAt(lat: number, lng: number) {
    if (!mapillaryToken) return;
    const delta = 0.002; // ~200m
    const bbox = `${lng - delta},${lat - delta},${lng + delta},${lat + delta}`;
    try {
      const res = await fetch(
        `https://graph.mapillary.com/images?access_token=${mapillaryToken}&fields=id,geometry&bbox=${bbox}&limit=1`,
      );
      const mapillaryResponse = await res.json();
      const feature = mapillaryResponse?.data?.[0];
      if (!feature?.id) {
        mapillaryStreetViewError = 'この場所の近くに街並み写真が見つかりませんでした';
        setTimeout(() => { mapillaryStreetViewError = null; }, 3000);
        return;
      }
      const coords = feature.geometry?.coordinates as [number, number] | undefined;
      await openMapillaryViewer(feature.id, coords?.[0] ?? lng, coords?.[1] ?? lat);
    } catch {
      mapillaryStreetViewError = 'Street View の読み込みに失敗しました';
      setTimeout(() => { mapillaryStreetViewError = null; }, 3000);
    }
  }

  let mapillaryStreetViewError = $state<string | null>(null);
  function addMapillaryCoverageLayer() {
    if (!map || !mapillaryToken) return;
    if (map.getSource('mapillary')) return;

    map.addSource('mapillary', {
      type: 'vector',
      tiles: [
        `https://tiles.mapillary.com/maps/vtp/mly1_public/2/{z}/{x}/{y}?access_token=${mapillaryToken}`,
      ],
      minzoom: 6,
      maxzoom: 14,
    });

    map.addLayer({
      id: 'mapillary-sequences',
      type: 'line',
      source: 'mapillary',
      'source-layer': 'sequence',
      layout: { 'line-join': 'round', 'line-cap': 'round', visibility: 'none' },
      paint: { 'line-color': '#05CB63', 'line-width': 2, 'line-opacity': 0.7 },
    });

    map.addLayer({
      id: 'mapillary-images',
      type: 'circle',
      source: 'mapillary',
      'source-layer': 'image',
      layout: { visibility: 'none' },
      paint: {
        'circle-color': '#05CB63',
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 3, 17, 6],
        'circle-opacity': 0.7,
      },
      minzoom: 14,
    });

    map.on('contextmenu', (e: any) => {
      if (!mapillaryToken) return;
      const { lat: rLat, lng: rLng } = e.lngLat;
      void openStreetViewAt(rLat, rLng);
    });

    map.on('click', 'mapillary-images', (e: any) => {
      if (!showMapillaryCoverage) return;
      const feature = e.features?.[0];
      if (!feature) return;
      const imageId = String(feature.properties?.id || '');
      if (imageId) {
        openMapillaryViewer(imageId, e.lngLat.lng, e.lngLat.lat);
      }
    });

    map.on('mouseenter', 'mapillary-images', () => {
      if (showMapillaryCoverage) map!.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'mapillary-images', () => {
      map!.getCanvas().style.cursor = '';
    });
  }

  function toggleMapillaryCoverage() {
    if (!map) return;
    const vis = showMapillaryCoverage ? 'visible' : 'none';
    if (map.getLayer('mapillary-sequences')) map.setLayoutProperty('mapillary-sequences', 'visibility', vis);
    if (map.getLayer('mapillary-images')) map.setLayoutProperty('mapillary-images', 'visibility', vis);
    if (!showMapillaryCoverage) closeMapillaryViewer();
  }

  async function openMapillaryViewer(imageId: string, lng: number, lat: number) {
    mapillaryViewerImageId = imageId;
    showMapillaryViewer = true;
    mapillaryViewerLat = lat;
    mapillaryViewerLng = lng;

    // Auto-enable coverage layer
    if (!showMapillaryCoverage) {
      showMapillaryCoverage = true;
      if (map?.getLayer('mapillary-sequences')) map.setLayoutProperty('mapillary-sequences', 'visibility', 'visible');
      if (map?.getLayer('mapillary-images')) map.setLayoutProperty('mapillary-images', 'visibility', 'visible');
    }

    // Place marker
    if (mapillaryViewerMarker) mapillaryViewerMarker.remove();
    if (maplibregl && map) {
      const el = document.createElement('div');
      el.style.cssText = 'width:24px;height:24px;border-radius:50%;background:#05CB63;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.4);';
      mapillaryViewerMarker = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map!);
    }

    // Initialize or navigate viewer after DOM renders
    await new Promise((r) => setTimeout(r, 50));
    if (!mapillaryViewerContainer) return;

    // Mapillary pano viewer reimplementation in kami engine is pending (Phase 1.5).
    // For now, render a static thumbnail + metadata via the Mapillary Graph REST API
    // so the feature degrades gracefully without the mapillary-js dependency.
    if (!mapillaryViewer) {
      try {
        const imgRes = await fetch(
          `https://graph.mapillary.com/${encodeURIComponent(imageId)}?access_token=${mapillaryToken}&fields=thumb_1024_url,geometry`,
        );
        if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`);
        const img = await imgRes.json();
        if (mapillaryViewerContainer) {
          mapillaryViewerContainer.innerHTML = '';
          const el = document.createElement('img');
          el.src = img.thumb_1024_url;
          el.style.width = '100%';
          el.style.height = '100%';
          el.style.objectFit = 'contain';
          mapillaryViewerContainer.appendChild(el);
        }
        const coords = img?.geometry?.coordinates;
        if (Array.isArray(coords) && coords.length === 2) {
          mapillaryViewerLng = coords[0];
          mapillaryViewerLat = coords[1];
          if (map && mapillaryViewerMarker) {
            mapillaryViewerMarker.setLngLat([coords[0], coords[1]]);
            map.panTo([coords[0], coords[1]], { duration: 300 });
          }
        }
        mapillaryViewer = { _kind: 'kami-static-thumbnail', imageId };
      } catch (err) {
        console.error('Mapillary static viewer init failed', err);
      }
    }
  }

  function closeMapillaryViewer() {
    showMapillaryViewer = false;
    mapillaryViewerImageId = null;
    if (mapillaryViewerMarker) {
      mapillaryViewerMarker.remove();
      mapillaryViewerMarker = null;
    }
  }

  function onH3ToggleChange() {
    updateH3Overlay();
  }

  function onH3ResolutionInput() {
    updateSpatialInfo();
  }

  async function calculateRoute() {
    if (!routeStart || !routeEnd) return;
    routeLoading = true;
    routeError = null;
    routeAlternatives = [];
    routeSteps = [];
    multiModalAlternatives = [];
    multiModalJourney = null;
    journeyLegs = [];
    selectedRouteIndex = 0;
    try {
      if (routeProfile === 'transit' || routeProfile === 'ferry' || routeProfile === 'flight') {
        // Multi-modal routing
        const fn = routeProfile === 'transit' ? routeTransit
                 : routeProfile === 'ferry' ? routeFerry
                 : routeFlight;
        const journeys = await fn(routeStart, routeEnd);
        if (journeys.length === 0) { routeError = 'ルートが見つかりません'; return; }
        multiModalAlternatives = journeys;
        const selected = journeys[0];
        multiModalJourney = selected;
        journeyLegs = selected.legs;
        routeDistance = selected.totalDistanceMeters;
        routeDuration = selected.totalDurationSeconds;
        routeGeometry = null;
        renderMultiModalOnMap(selected);
      } else {
        // OSRM car/foot routing
        const profile = routeProfile === 'walking' ? 'foot' : 'car';
        const coords = `${routeStart.lng},${routeStart.lat};${routeEnd.lng},${routeEnd.lat}`;
        const res = await fetch(
          `https://router.project-osrm.org/route/v1/${profile}/${coords}?overview=full&geometries=geojson&alternatives=3&steps=true&annotations=duration,distance,speed`
        );
        const data = await res.json();
        if (!data.routes || data.routes.length === 0) {
          routeError = 'ルートが見つかりません';
          return;
        }
        routeAlternatives = data.routes.map((r: any, i: number) => ({
          geometry: r.geometry, distance: r.distance, duration: r.duration, index: i,
          steps: parseOSRMSteps(r.legs || []),
          legSummary: r.legs?.[0]?.summary || '',
        }));
        const primary = routeAlternatives[0];
        routeGeometry = primary.geometry;
        routeDistance = primary.distance;
        routeDuration = primary.duration;
        routeSteps = primary.steps;
        selectedRouteIndex = 0;
        renderAllRoutesOnMap();
      }
    } catch (e) {
      routeError = e instanceof Error ? e.message : 'ルート計算に失敗しました';
    } finally {
      routeLoading = false;
    }
  }

  function clearRouteLayers() {
    if (!map) return;
    if (kamiMap) {
      kamiMap.clearLayers();
      return;
    }
    for (let i = 0; i < 3; i++) {
      if (map.getLayer(`route-arrows-${i}`)) map.removeLayer(`route-arrows-${i}`);
      if (map.getLayer(`route-line-${i}`)) map.removeLayer(`route-line-${i}`);
      if (map.getSource(`route-source-${i}`)) map.removeSource(`route-source-${i}`);
    }
    if (map.getLayer('route-line')) map.removeLayer('route-line');
    if (map.getSource('route-source')) map.removeSource('route-source');
    // Multi-modal transit layers
    for (let i = 0; i < 10; i++) {
      if (map.getLayer(`transit-leg-line-${i}`)) map.removeLayer(`transit-leg-line-${i}`);
      if (map.getSource(`transit-leg-${i}`)) map.removeSource(`transit-leg-${i}`);
      if (map.getLayer(`transit-stop-${i}`)) map.removeLayer(`transit-stop-${i}`);
      if (map.getSource(`transit-stop-src-${i}`)) map.removeSource(`transit-stop-src-${i}`);
    }
  }

  function renderMultiModalOnMap(journey: MultiModalJourney) {
    if (!map) return;
    clearRouteLayers();

    if (kamiMap) {
      for (const leg of journey.legs) {
        const coords = (leg.geometry?.coordinates || []) as [number, number][];
        if (!Array.isArray(coords) || coords.length < 2) continue;
        const color = LEG_MODE_COLOR[leg.mode] || '#888888';
        const width = leg.mode === 'walk' || leg.mode === 'drive' ? 3 : 5;
        kamiMap.setRoute(coords, color, width);
      }
      const allCoords = journey.legs.flatMap((leg) => (Array.isArray(leg.geometry?.coordinates) ? leg.geometry.coordinates : [])) as [number, number][];
      if (allCoords.length > 0) {
        const lons = allCoords.map((c) => c[0]);
        const lats = allCoords.map((c) => c[1]);
        const sw = { lng: Math.min(...lons), lat: Math.min(...lats) };
        const ne = { lng: Math.max(...lons), lat: Math.max(...lats) };
        map.fitBounds(
          { getSouthWest: () => sw, getNorthEast: () => ne },
          { padding: 60, duration: 1000 },
        );
      }
      return;
    }

    if (!maplibregl) return;

    const allCoords: [number, number][] = [];

    journey.legs.forEach((leg, i) => {
      const color = LEG_MODE_COLOR[leg.mode] || '#888888';
      const sourceId = `transit-leg-${i}`;
      const layerId = `transit-leg-line-${i}`;

      map!.addSource(sourceId, {
        type: 'geojson',
        data: { type: 'Feature', geometry: leg.geometry, properties: {} },
      });

      const isAccess = leg.mode === 'walk' || leg.mode === 'drive';
      map!.addLayer({
        id: layerId,
        type: 'line',
        source: sourceId,
        paint: {
          'line-color': color,
          'line-width': isAccess ? 3 : 5,
          'line-opacity': isAccess ? 0.7 : 0.9,
          ...(leg.mode === 'walk' ? { 'line-dasharray': [2, 2] } :
              leg.mode === 'drive' ? { 'line-dasharray': [4, 1] } :
              leg.mode === 'ferry' ? { 'line-dasharray': [4, 2] } :
              leg.mode === 'flight' ? { 'line-dasharray': [6, 3] } : {}),
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      });

      // Transfer point marker
      if (i > 0) {
        const stopSrcId = `transit-stop-src-${i}`;
        const stopLayerId = `transit-stop-${i}`;
        map!.addSource(stopSrcId, {
          type: 'geojson',
          data: {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: leg.fromCoords },
            properties: {},
          },
        });
        map!.addLayer({
          id: stopLayerId,
          type: 'circle',
          source: stopSrcId,
          paint: {
            'circle-color': color,
            'circle-radius': 6,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2,
          },
        });
      }

      // Collect coords for bounds
      const coords = leg.geometry?.coordinates;
      if (Array.isArray(coords)) {
        for (const c of coords) {
          if (Array.isArray(c) && c.length >= 2) allCoords.push(c as [number, number]);
        }
      }
    });

    // Fit bounds
    if (allCoords.length > 0) {
      const bounds = allCoords.reduce(
        (b: any, c: [number, number]) => b.extend(c),
        new maplibregl.LngLatBounds(allCoords[0], allCoords[0]),
      );
      map!.fitBounds(bounds, { padding: 60, duration: 1000 });
    }
  }

  function renderAllRoutesOnMap() {
    if (!map) return;
    clearRouteLayers();
    if (routeAlternatives.length === 0) return;

    if (kamiMap) {
      const alt = routeAlternatives[selectedRouteIndex];
      const coords = (alt?.geometry?.coordinates || []) as [number, number][];
      if (Array.isArray(coords) && coords.length > 1) {
        const color = ROUTE_COLORS[selectedRouteIndex] || ROUTE_COLORS[0];
        kamiMap.setRoute(coords, color, 5);
        const lons = coords.map((c) => c[0]);
        const lats = coords.map((c) => c[1]);
        const sw = { lng: Math.min(...lons), lat: Math.min(...lats) };
        const ne = { lng: Math.max(...lons), lat: Math.max(...lats) };
        map.fitBounds(
          { getSouthWest: () => sw, getNorthEast: () => ne },
          { padding: 60, duration: 1000 },
        );
      }
      return;
    }

    // Render non-selected first (behind), selected last (on top)
    const renderOrder = routeAlternatives
      .map((_, i) => i)
      .sort((a, b) => {
        if (a === selectedRouteIndex) return 1;
        if (b === selectedRouteIndex) return -1;
        return a - b;
      });

    for (const i of renderOrder) {
      const alt = routeAlternatives[i];
      const isSelected = i === selectedRouteIndex;
      map.addSource(`route-source-${i}`, {
        type: 'geojson',
        data: { type: 'Feature', geometry: alt.geometry, properties: {} },
      });
      map.addLayer({
        id: `route-line-${i}`,
        type: 'line',
        source: `route-source-${i}`,
        paint: {
          'line-color': ROUTE_COLORS[i] || ROUTE_COLORS[0],
          'line-width': isSelected ? 6 : 4,
          'line-opacity': isSelected ? 0.9 : 0.5,
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      });
      // Direction arrows on selected route
      if (isSelected) {
        try {
          map.addLayer({
            id: `route-arrows-${i}`,
            type: 'symbol',
            source: `route-source-${i}`,
            layout: {
              'symbol-placement': 'line',
              'symbol-spacing': 70,
              'text-field': '▶',
              'text-size': 12,
              'text-rotation-alignment': 'map',
              'text-keep-upright': false,
              'text-allow-overlap': true,
              'text-ignore-placement': true,
              'text-font': ['Noto Sans Regular', 'Open Sans Regular', 'Arial Unicode MS Regular'],
            },
            paint: {
              'text-color': '#ffffff',
              'text-opacity': 0.85,
            },
          });
        } catch { /* glyph font may not exist in some styles */ }
      }
      if (!isSelected) {
        map.on('click', `route-line-${i}`, () => selectAlternativeRoute(i));
        map.on('mouseenter', `route-line-${i}`, () => { map!.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', `route-line-${i}`, () => { map!.getCanvas().style.cursor = ''; });
      }
    }

    // Fit bounds to selected route
    const selGeo = routeAlternatives[selectedRouteIndex]?.geometry;
    if (selGeo?.coordinates?.length > 0 && maplibregl) {
      const coords = selGeo.coordinates;
      const bounds = coords.reduce(
        (b: any, c: number[]) => b.extend(c),
        new maplibregl.LngLatBounds(coords[0], coords[0])
      );
      map.fitBounds(bounds, { padding: 60, duration: 1000 });
    }
  }

  function selectAlternativeRoute(index: number) {
    if (index < 0 || index >= routeAlternatives.length) return;
    selectedRouteIndex = index;
    const alt = routeAlternatives[index];
    routeGeometry = alt.geometry;
    routeDistance = alt.distance;
    routeDuration = alt.duration;
    routeSteps = alt.steps || [];
    renderAllRoutesOnMap();
  }

  function clearRoute() {
    if (navigationMode) stopNavigation();
    routeStart = null;
    routeEnd = null;
    routeGeometry = null;
    routeDistance = 0;
    routeDuration = 0;
    routeError = null;
    routeAlternatives = [];
    routeSteps = [];
    selectedRouteIndex = 0;
    routeOriginInput = '';
    routeDestInput = '';
    routeOriginSuggestions = [];
    routeDestSuggestions = [];
    showStepList = false;
    multiModalJourney = null;
    multiModalAlternatives = [];
    journeyLegs = [];
    showLegList = false;
    transitStepIndex = 0;
    if (routeStartMarker) { routeStartMarker.remove(); routeStartMarker = null; }
    if (routeEndMarker) { routeEndMarker.remove(); routeEndMarker = null; }
    clearRouteLayers();
  }

  function clearRoutePoint(which: 'start' | 'end') {
    if (which === 'start') {
      if (routeStartMarker) { routeStartMarker.remove(); routeStartMarker = null; }
      routeStart = null;
      routeOriginInput = '';
    } else {
      if (routeEndMarker) { routeEndMarker.remove(); routeEndMarker = null; }
      routeEnd = null;
      routeDestInput = '';
    }
    routeGeometry = null;
    routeDistance = 0;
    routeDuration = 0;
    routeError = null;
    routeAlternatives = [];
    selectedRouteIndex = 0;
    clearRouteLayers();
  }

  function formatRouteDistance(meters: number): string {
    if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
    return `${Math.round(meters)} m`;
  }

  function formatRouteDuration(seconds: number): string {
    if (seconds >= 3600) {
      const h = Math.floor(seconds / 3600);
      const m = Math.round((seconds % 3600) / 60);
      return `${h}時間${m}分`;
    }
    return `${Math.round(seconds / 60)}分`;
  }

  async function geocodeForRoute(query: string): Promise<{ lat: number; lng: number; label: string } | null> {
    const results = await searchPlaces(query);
    if (results.length > 0 && results[0].lat != null && results[0].lng != null) {
      return { lat: results[0].lat!, lng: results[0].lng!, label: results[0].title };
    }
    return null;
  }

  function placeRouteMarker(type: 'start' | 'end', lngLat: [number, number]) {
    if (!maplibregl || !map) return;
    const color = type === 'start' ? '#00cc66' : '#ff4444';
    if (type === 'start') {
      if (routeStartMarker) routeStartMarker.remove();
      const el = document.createElement('div');
      el.style.cssText = `width:16px;height:16px;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.4)`;
      routeStartMarker = new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map!);
    } else {
      if (routeEndMarker) routeEndMarker.remove();
      const el = document.createElement('div');
      el.style.cssText = `width:16px;height:16px;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.4)`;
      routeEndMarker = new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map!);
    }
  }

  async function executeRouteSearch(text: string) {
    const parsed = parseRouteQuery(text);
    if (!parsed) return;
    routeSearching = true;
    routeError = null;
    clearRoute();
    try {
      const [origin, dest] = await Promise.all([
        geocodeForRoute(parsed.origin),
        geocodeForRoute(parsed.destination),
      ]);
      if (!origin) { routeError = `出発地「${parsed.origin}」が見つかりません`; return; }
      if (!dest) { routeError = `目的地「${parsed.destination}」が見つかりません`; return; }
      routeStart = origin;
      routeEnd = dest;
      routeOriginInput = origin.label;
      routeDestInput = dest.label;
      placeRouteMarker('start', [origin.lng, origin.lat]);
      placeRouteMarker('end', [dest.lng, dest.lat]);
      await calculateRoute();
    } catch (e) {
      routeError = e instanceof Error ? e.message : 'ルート検索に失敗しました';
    } finally {
      routeSearching = false;
    }
  }

  function onRouteOriginInput() {
    clearTimeout(routeOriginDebounce);
    const q = routeOriginInput.trim();
    if (q.length < 2) { routeOriginSuggestions = []; showOriginSuggestions = false; return; }
    routeOriginDebounce = setTimeout(async () => {
      routeOriginSuggestions = await searchPlaces(q);
      showOriginSuggestions = routeOriginSuggestions.length > 0;
    }, 300);
  }

  function onRouteDestInput() {
    clearTimeout(routeDestDebounce);
    const q = routeDestInput.trim();
    if (q.length < 2) { routeDestSuggestions = []; showDestSuggestions = false; return; }
    routeDestDebounce = setTimeout(async () => {
      routeDestSuggestions = await searchPlaces(q);
      showDestSuggestions = routeDestSuggestions.length > 0;
    }, 300);
  }

  function selectRouteOrigin(result: MapSearchResult) {
    if (result.lat == null || result.lng == null) return;
    routeStart = { lat: result.lat!, lng: result.lng!, label: result.title };
    routeOriginInput = result.title;
    showOriginSuggestions = false;
    placeRouteMarker('start', [result.lng!, result.lat!]);
    if (routeStart && routeEnd) void calculateRoute();
  }

  function selectRouteDest(result: MapSearchResult) {
    if (result.lat == null || result.lng == null) return;
    routeEnd = { lat: result.lat!, lng: result.lng!, label: result.title };
    routeDestInput = result.title;
    showDestSuggestions = false;
    placeRouteMarker('end', [result.lng!, result.lat!]);
    if (routeStart && routeEnd) void calculateRoute();
  }

  async function saveRoute() {
    if (!routeStart || !routeEnd) return;
    if (!routeGeometry && !multiModalJourney) return;
    routeSaving = true;
    try {
      const payload = {
        name: `${routeStart.label} → ${routeEnd.label}`,
        start: routeStart, end: routeEnd, profile: routeProfile,
        geometry: routeGeometry || { type: 'LineString', coordinates: [] },
        distanceMeters: routeDistance, durationSeconds: routeDuration,
        legs: multiModalJourney?.legs,
      };
      await apiRouteSave(payload);
      await loadSavedRoutes();
    } catch (e) {
      console.error('Route save failed', e);
    } finally {
      routeSaving = false;
    }
  }

  async function loadSavedRoutes() {
    try {
      const data = await apiRouteList(0, 20);
      savedRoutes = data.routes || [];
    } catch {
      savedRoutes = [];
    }
  }

  async function deleteSavedRoute(id: string) {
    try {
      await apiRouteDelete(id);
      await loadSavedRoutes();
    } catch (e) {
      console.error('Route delete failed', e);
    }
  }

  function loadRouteOnMap(route: any) {
    clearRoute();
    routeStart = route.start;
    routeEnd = route.end;
    routeProfile = route.profile || 'driving';
    routeDistance = route.distanceMeters;
    routeDuration = route.durationSeconds;
    routeOriginInput = route.start?.label || '';
    routeDestInput = route.end?.label || '';
    placeRouteMarker('start', [route.start.lng, route.start.lat]);
    placeRouteMarker('end', [route.end.lng, route.end.lat]);

    if (route.legs && Array.isArray(route.legs) && route.legs.length > 0) {
      // Multi-modal saved route
      routeGeometry = null;
      const journey: MultiModalJourney = {
        legs: route.legs,
        totalDistanceMeters: route.distanceMeters,
        totalDurationSeconds: route.durationSeconds,
        index: 0,
      };
      multiModalJourney = journey;
      journeyLegs = journey.legs;
      renderMultiModalOnMap(journey);
    } else {
      // Standard driving/walking route
      routeGeometry = route.geometry;
      routeAlternatives = [{
        geometry: route.geometry, distance: route.distanceMeters,
        duration: route.durationSeconds, index: 0,
        steps: [], legSummary: '',
      }];
      selectedRouteIndex = 0;
      renderAllRoutesOnMap();
    }
  }

  const fallbackDashboardLayers: DashboardLayer[] = [
    { id: 'live-aircraft', name: 'Live Aircraft', category: 'mobility', enabled: true, color: '#10b981', description: 'ADS-B aircraft positions' },
    { id: 'live-satellites', name: 'Live Satellites', category: 'space', enabled: true, color: '#ec4899', description: 'SGP4 satellite overlay' },
    { id: 'ais-vessels', name: 'AIS Vessels', category: 'maritime', enabled: true, color: '#0ea5e9', description: 'AIS marine traffic' },
    { id: 'weather-grid', name: 'Weather Grid', category: 'environment', enabled: false, color: '#60a5fa', description: 'Open-Meteo wind and precipitation' },
    { id: 'h3-grid', name: 'H3 Grid', category: 'spatial', enabled: true, color: '#00ffcc', description: 'H3 operational cells' },
    { id: 'actor-locations', name: 'Actor Locations', category: 'graph', enabled: true, color: '#a78bfa', description: 'etzhayyim actor locations' },
  ];

  function fallbackDashboard(): MapsDashboard {
    const liveCount = Number(showLiveAircraft) + Number(showLiveSatellite) + Number(showLiveVessel);
    return {
      fetchedAt: new Date().toISOString(),
      region: 'tokyo',
      counts: {
        aircraft: showLiveAircraft ? 1 : 0,
        satellites: showLiveSatellite ? 1 : 0,
        vessels: showLiveVessel ? 1 : 0,
        crawlerPoints: crawlerPoints.length,
        actorPoints: actorPoints.length,
        weatherCells: weatherFeatures.length,
      },
      risk: {
        score: liveCount * 8 + Math.min(crawlerPoints.length, 20),
        level: liveCount >= 3 ? 'watch' : 'low',
        drivers: ['live tracker layers enabled', 'graph dashboard API pending'],
      },
      layers: fallbackDashboardLayers,
      panels: [
        { id: 'assets', title: 'Live Assets', value: liveCount, status: 'local' },
        { id: 'coverage', title: 'Crawler Coverage', value: crawlerPoints.length, status: crawlerLoading ? 'loading' : 'ready' },
      ],
      events: [],
    };
  }

  async function refreshDashboard() {
    dashboardLoading = true;
    dashboardError = null;
    try {
      dashboard = await apiGetDashboard({ lat, lng, zoom, timeRange: selectedDashboardRange });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'dashboard unavailable';
      dashboardError = message.includes('response was not JSON') || message.includes('Unexpected token')
        ? 'local dashboard API unavailable'
        : message;
      dashboard = fallbackDashboard();
    } finally {
      dashboardLoading = false;
    }
  }

  $effect(() => {
    if (!mapReady) return;
    void refreshDashboard();
    dashboardPollTimer = setInterval(() => { void refreshDashboard(); }, 60_000);
    return () => {
      if (dashboardPollTimer) clearInterval(dashboardPollTimer);
      dashboardPollTimer = undefined;
    };
  });

  function riskColor(level?: string): string {
    if (level === 'high') return '#ef4444';
    if (level === 'elevated') return '#f97316';
    if (level === 'watch') return '#eab308';
    return '#10b981';
  }

  function formatDashboardTime(raw: string): string {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return 'not synced';
    return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  }

  function dashboardLayerEnabled(layer: DashboardLayer): boolean {
    if (layer.id === 'live-aircraft') return showLiveAircraft;
    if (layer.id === 'live-satellites') return showLiveSatellite;
    if (layer.id === 'ais-vessels') return showLiveVessel;
    if (layer.id === 'weather-grid') return showWeatherLayer;
    if (layer.id === 'h3-grid') return showH3Grid;
    if (layer.id === 'actor-locations') return showActorLocations;
    return layer.enabled;
  }

  function toggleDashboardLayer(layer: DashboardLayer) {
    if (layer.id === 'live-aircraft') showLiveAircraft = !showLiveAircraft;
    else if (layer.id === 'live-satellites') showLiveSatellite = !showLiveSatellite;
    else if (layer.id === 'ais-vessels') {
      showLiveVessel = !showLiveVessel;
      aismarineCtlRef?.setVisible?.(showLiveVessel);
    } else if (layer.id === 'weather-grid') {
      showWeatherLayer = !showWeatherLayer;
      void toggleWeatherLayer();
    } else if (layer.id === 'h3-grid') {
      showH3Grid = !showH3Grid;
      onH3ToggleChange();
    } else if (layer.id === 'actor-locations') {
      showActorLocations = !showActorLocations;
    }
  }

  const dashboardCounts = $derived(dashboard?.counts ?? {});
  const dashboardLayers = $derived((dashboard?.layers?.length ? dashboard.layers : fallbackDashboardLayers).slice(0, 12));
  const dashboardEvents = $derived(dashboard?.events ?? []);
</script>

<!-- Map page -->
<div class="relative w-full h-full min-h-[100dvh]">
  <div class="absolute inset-0">
    <div bind:this={mapContainer} class="w-full h-full touch-manipulation">
      <canvas
        id="kami-map-canvas"
        class="w-full h-full block transition-[transform,filter,opacity] duration-500 ease-out"
      ></canvas>
    </div>
  </div>

  <!-- kami-walk: full-screen iframe overlay. Shown when mapRenderMode === 'kami-walk'.
       The iframe loads maps-walk.htm with the current map center as anchor.
       Exit is handled via postMessage { type: 'exit-walk' } → exitWalkMode(). -->
  {#if mapRenderMode === 'kami-walk'}
    <div class="absolute inset-0 z-50">
      <iframe
        src="/maps-walk.htm?lat={lat.toFixed(6)}&lng={lng.toFixed(6)}"
        class="w-full h-full border-0"
        title="kami walk mode"
        allow="pointer-lock; fullscreen"
      ></iframe>
    </div>
  {/if}

  <!-- Phase 3 lite: atmospheric haze overlay. Pure CSS, zero GPU cost. Adds
       top-edge blue sky glow + bottom-edge depth fade so tilted-camera views
       read as "looking along the surface" instead of a flat sheet. Hidden on
       top-down orientation (no transform) via pitch CSS var on canvas parent. -->
  <div
    class="absolute inset-0 pointer-events-none z-[5] opacity-70"
    style="background:
      radial-gradient(160% 60% at 50% -20%, rgba(140, 180, 230, 0.35) 0%, rgba(140, 180, 230, 0.12) 30%, transparent 60%),
      linear-gradient(to top, rgba(12, 18, 28, 0.25) 0%, transparent 20%);
    "
  ></div>

  {#if !mapReady}
    <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--gv2-bg-primary,#1a1a1a)] z-30">
      <div class="w-8 h-8 rounded-full border-[3px] border-white/10 border-t-[#00ffcc] animate-spin"></div>
      <span class="text-[13px] text-[#888]">Loading map...</span>
    </div>
  {/if}

  {#if debugHud}
    <div class="absolute top-20 right-4 z-40 bg-black/85 text-[11px] text-white font-mono rounded-lg p-3 min-w-[280px] backdrop-blur border border-white/10 leading-5 select-text pointer-events-auto">
      <div class="flex items-center justify-between mb-1">
        <span class="font-bold text-[#00ffcc]">DEBUG HUD</span>
        <button class="text-white/50 hover:text-white text-[10px]" onclick={() => debugHud = false}>× close (D)</button>
      </div>
      <div>FPS: <span class="text-[#ffcc00]">{fpsCurrent}</span></div>
      <div>zoom: {debugStats.currentZoom ?? '-'} / lod: {debugStats.currentLod ?? '-'}</div>
      <div>cells visible: {debugStats.currentCells ?? '-'} / cache hits: {debugStats.cellsCacheHit ?? '-'}</div>
      <div>cache size: {debugStats.cacheSize ?? '-'}</div>
      <div>last refresh: <span class={(debugStats.lastRefreshMs as number ?? 0) > 500 ? 'text-red-400' : 'text-green-400'}>{Math.round((debugStats.lastRefreshMs as number) ?? 0)}ms</span></div>
      <div>last fetch: <span class={(debugStats.lastFetchMs as number ?? 0) > 1000 ? 'text-red-400' : 'text-green-400'}>{Math.round((debugStats.lastFetchMs as number) ?? 0)}ms</span> ({debugStats.fetchCount ?? 0} total)</div>
      <hr class="my-1 border-white/10" />
      <div class="text-white/60">features per label (rendered):</div>
      {#if debugStats.featuresPerLabel}
        {#each Object.entries(debugStats.featuresPerLabel as Record<string, number>) as [label, count]}
          <div class="flex justify-between"><span>{label}</span><span class={count > 500 ? 'text-orange-400' : 'text-white/80'}>{count}</span></div>
        {/each}
      {/if}
    </div>
  {/if}

  <!-- Map / Satellite view toggle (bottom-left, Google-Maps-style) -->
  <div class="absolute bottom-4 left-4 z-20 flex rounded-full overflow-hidden border border-white/[0.15] shadow-[0_2px_6px_rgba(0,0,0,0.3)] backdrop-blur-xl bg-[rgba(26,26,26,0.88)] text-[12px] font-semibold">
    {#each [['map', '地図'], ['satellite', '衛星']] as [mode, label]}
      <button
        class="px-4 py-2 transition-colors {(typeof window !== 'undefined' && (new URLSearchParams(window.location.search).get('view') ?? window.localStorage.getItem('maps:view') ?? 'satellite') === mode) ? 'bg-white text-black' : 'text-white hover:bg-white/10'}"
        onclick={() => {
          if (typeof window === 'undefined') return;
          window.localStorage.setItem('maps:view', mode);
          const url = new URL(window.location.href);
          url.searchParams.set('view', mode);
          window.location.href = url.toString();
        }}
        title={mode === 'map' ? '地図モード (CartoDB Voyager)' : '衛星モード (Esri World Imagery)'}
      >
        {label}
      </button>
    {/each}
  </div>

  <!-- Route Toggle Button (desktop only — on mobile it's inside search bar) -->
  <button
    class="absolute top-4 right-4 z-20 w-11 h-11 rounded-full flex items-center justify-center border transition-all duration-200 touch-manipulation max-[600px]:hidden {routeMode ? 'bg-[#00ffcc] border-[#00ffcc] text-[#1a1a1a] shadow-[0_2px_10px_rgba(0,255,204,0.4)]' : 'bg-[rgba(26,26,26,0.88)] backdrop-blur-xl border-white/[0.15] text-white shadow-[0_2px_6px_rgba(0,0,0,0.3)] hover:bg-[rgba(40,40,40,0.9)]'}"
    onclick={() => { routeMode = !routeMode; if (!routeMode) clearRoute(); else { closePlaceCard(); void loadSavedRoutes(); } }}
    title={routeMode ? 'ルートモードを終了' : 'ルートナビゲーション'}
  >
    <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="22 12 18 8 14 12" />
      <path d="M18 8v7a4 4 0 0 1-4 4h-4" />
      <polyline points="6 16 2 12 6 8" />
    </svg>
  </button>

  <!-- 3D / Underground Button (desktop only) -->
  {#if kamiMap}
  <button
    class="absolute top-[68px] right-4 z-20 w-11 h-11 rounded-full flex items-center justify-center border transition-all duration-200 touch-manipulation max-[600px]:hidden {show3DPanel ? 'bg-[#6366f1] border-[#6366f1] text-white shadow-[0_2px_10px_rgba(99,102,241,0.5)]' : 'bg-[rgba(26,26,26,0.88)] backdrop-blur-xl border-white/[0.15] text-white shadow-[0_2px_6px_rgba(0,0,0,0.3)] hover:bg-[rgba(40,40,40,0.9)]'}"
    onclick={toggle3D}
    title={show3DPanel ? '3D地下モードを終了' : '3D地下モード'}
  >
    <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <!-- layers icon representing underground strata -->
      <polygon points="12 2 22 8.5 12 15 2 8.5" />
      <polyline points="2 15.5 12 22 22 15.5" />
      <polyline points="2 12 12 18.5 22 12" />
    </svg>
  </button>

  <div class="absolute top-[116px] right-4 z-20 flex gap-1.5 max-[600px]:hidden">
    <button
      class="px-2.5 py-1 rounded-full border text-[10px] font-semibold tracking-wide transition-colors touch-manipulation {mapRenderMode === 'kami3d' ? 'bg-[rgba(99,102,241,0.28)] border-[rgba(129,140,248,0.55)] text-white' : 'bg-[rgba(26,26,26,0.88)] border-white/[0.12] text-[#888] hover:bg-[rgba(40,40,40,0.9)]'}"
      onclick={() => setMapRenderMode(mapRenderMode === 'kami3d' ? 'flat' : 'kami3d')}
      title="KAMI 3D render"
    >
      KAMI 3D
    </button>
    <button
      class="px-2.5 py-1 rounded-full border text-[10px] font-semibold tracking-wide transition-colors touch-manipulation bg-[rgba(26,26,26,0.88)] border-white/[0.12] text-[#888] hover:bg-[rgba(40,40,58,0.9)] hover:border-[rgba(129,140,248,0.4)] hover:text-[#a5b4fc]"
      onclick={() => enterWalkMode()}
      title="地上を歩く (isekai walk mode)"
    >
      WALK
    </button>
    <button
      class="px-2.5 py-1 rounded-full border text-[10px] font-semibold tracking-wide transition-colors touch-manipulation {autoPitchEnabled ? 'bg-[rgba(0,255,204,0.14)] border-[rgba(0,255,204,0.35)] text-[#9fffe9]' : 'bg-[rgba(26,26,26,0.88)] border-white/[0.12] text-[#888] hover:bg-[rgba(40,40,40,0.9)]'}"
      onclick={() => {
        autoPitchEnabled = !autoPitchEnabled;
        if (autoPitchEnabled) syncAutoPitch(zoom);
      }}
      title="ズーム連動 3D ピッチ"
    >
      AUTO TILT
    </button>
  </div>

  <!-- Live tracker layer toggles (2026-05-05): 衛星 / 航空機 / 船舶 -->
  <div class="absolute top-[148px] right-4 z-20 flex flex-col gap-1 items-end max-[600px]:hidden">
    <button
      class="px-2.5 py-1 rounded-full border text-[10px] font-semibold tracking-wide transition-colors touch-manipulation flex items-center gap-1.5 {showLiveAircraft ? 'bg-[rgba(16,185,129,0.18)] border-[rgba(16,185,129,0.45)] text-[#a7f3d0]' : 'bg-[rgba(26,26,26,0.88)] border-white/[0.12] text-[#888] hover:bg-[rgba(40,40,40,0.9)]'}"
      onclick={() => { showLiveAircraft = !showLiveAircraft; }}
      title="航空機 live (Flightradar24)"
    >
      <span class="inline-block w-1.5 h-1.5 rounded-full {showLiveAircraft ? 'bg-[#10b981]' : 'bg-[#444]'}"></span>
      ✈ 航空機
    </button>
    <button
      class="px-2.5 py-1 rounded-full border text-[10px] font-semibold tracking-wide transition-colors touch-manipulation flex items-center gap-1.5 {showLiveSatellite ? 'bg-[rgba(236,72,153,0.18)] border-[rgba(236,72,153,0.45)] text-[#fbcfe8]' : 'bg-[rgba(26,26,26,0.88)] border-white/[0.12] text-[#888] hover:bg-[rgba(40,40,40,0.9)]'}"
      onclick={() => { showLiveSatellite = !showLiveSatellite; }}
      title="衛星 live (N2YO)"
    >
      <span class="inline-block w-1.5 h-1.5 rounded-full {showLiveSatellite ? 'bg-[#ec4899]' : 'bg-[#444]'}"></span>
      🛰 衛星
    </button>
    <button
      class="px-2.5 py-1 rounded-full border text-[10px] font-semibold tracking-wide transition-colors touch-manipulation flex items-center gap-1.5 {showLiveVessel ? 'bg-[rgba(14,165,233,0.18)] border-[rgba(14,165,233,0.45)] text-[#bae6fd]' : 'bg-[rgba(26,26,26,0.88)] border-white/[0.12] text-[#888] hover:bg-[rgba(40,40,40,0.9)]'}"
      onclick={() => { showLiveVessel = !showLiveVessel; aismarineCtlRef?.setVisible?.(showLiveVessel); }}
      title="船舶 live (MarineTraffic)"
    >
      <span class="inline-block w-1.5 h-1.5 rounded-full {showLiveVessel ? 'bg-[#0ea5e9]' : 'bg-[#444]'}"></span>
      🚢 船舶
    </button>
    <button
      class="px-2.5 py-1 rounded-full border text-[10px] font-semibold tracking-wide transition-colors touch-manipulation flex items-center gap-1.5 {showCelestial ? 'bg-[rgba(250,204,21,0.18)] border-[rgba(250,204,21,0.45)] text-[#fef08a]' : 'bg-[rgba(26,26,26,0.88)] border-white/[0.12] text-[#888] hover:bg-[rgba(40,40,40,0.9)]'}"
      onclick={() => { showCelestial = !showCelestial; celestialOverlayRef?.setVisible(showCelestial); }}
      title="星空 (HYG + OpenNGC)"
    >
      <span class="inline-block w-1.5 h-1.5 rounded-full {showCelestial ? 'bg-[#facc15]' : 'bg-[#444]'}"></span>
      ✨ 星空
    </button>
  </div>

  <!-- 3D / Underground Panel -->
  {#if show3DPanel}
  <div class="absolute top-[124px] right-4 w-[288px] z-20 bg-[rgba(18,18,28,0.95)] backdrop-blur-xl border border-white/[0.1] rounded-xl text-white shadow-[0_4px_16px_rgba(0,0,0,0.5)] max-[600px]:hidden overflow-hidden">

    <!-- Header -->
    <div class="flex items-center gap-2 px-4 py-3 border-b border-white/[0.08]">
      <div class="w-2 h-2 rounded-full bg-[#6366f1] flex-shrink-0"></div>
      <span class="text-[13px] font-semibold tracking-wide">3D 地下断面</span>
      <div class="ml-auto flex items-center gap-1">
        <button
          class="text-[10px] px-2 py-1 rounded-md border transition-colors touch-manipulation {pitch3D === 0 ? 'bg-white/[0.15] border-white/[0.3] text-white' : 'bg-transparent border-white/[0.12] text-[#888] hover:border-white/[0.2]'}"
          onclick={() => setPitchDeg(0)}
        >平面</button>
        <button
          class="text-[10px] px-2 py-1 rounded-md border transition-colors touch-manipulation {pitch3D === 45 ? 'bg-[#6366f1] border-[#6366f1] text-white' : 'bg-transparent border-white/[0.12] text-[#888] hover:border-white/[0.2]'}"
          onclick={() => setPitchDeg(45)}
        >45°</button>
        <button
          class="text-[10px] px-2 py-1 rounded-md border transition-colors touch-manipulation {pitch3D === 55 ? 'bg-[#6366f1] border-[#6366f1] text-white' : 'bg-transparent border-white/[0.12] text-[#888] hover:border-white/[0.2]'}"
          onclick={() => setPitchDeg(55)}
        >55°</button>
      </div>
    </div>

    <!-- Cross-section diagram -->
    <div class="px-4 py-3">
      <!-- Ground surface indicator -->
      <div class="flex items-center gap-2 mb-1">
        <div class="w-full h-[2px] bg-gradient-to-r from-[#4ade80]/60 to-[#4ade80]/20 rounded-full"></div>
        <span class="text-[10px] text-[#4ade80] flex-shrink-0 font-mono">地表 0m</span>
      </div>

      {#if undergroundLoading}
        <div class="flex items-center gap-2 py-4 text-[#888] text-[12px]">
          <div class="w-4 h-4 rounded-full border-2 border-white/10 border-t-[#6366f1] animate-spin flex-shrink-0"></div>
          地下データ取得中...
        </div>
      {:else if undergroundError}
        <div class="py-3 text-[12px] text-[#ff5c6c]">{undergroundError}</div>
      {:else}
        <!-- Layer bars sorted by depth ascending -->
        {@const layers = undergroundData?.layers ?? [
          { infraType: 'telecom',         depthM: 0.6,  color: '#10b981', segments: [] },
          { infraType: 'electric',        depthM: 0.8,  color: '#eab308', segments: [] },
          { infraType: 'districtHeating', depthM: 1.0,  color: '#ef4444', segments: [] },
          { infraType: 'water',           depthM: 1.2,  color: '#3b82f6', segments: [] },
          { infraType: 'gas',             depthM: 1.5,  color: '#f59e0b', segments: [] },
          { infraType: 'sewage',          depthM: 3.0,  color: '#78716c', segments: [] },
          { infraType: 'subway',          depthM: 15.0, color: '#6366f1', segments: [] },
        ]}
        <div class="flex flex-col gap-1.5">
          {#each [...layers].sort((a, b) => a.depthM - b.depthM) as layer (layer.infraType)}
            {@const count = layer.segments.length}
            {@const hasData = undergroundData !== null}
            <div class="flex items-center gap-2.5 group">
              <!-- Depth marker -->
              <span class="text-[10px] font-mono text-[#666] w-[36px] text-right flex-shrink-0">{layer.depthM}m</span>
              <!-- Layer bar -->
              <div
                class="flex-1 h-[22px] rounded-[4px] flex items-center px-2 gap-1.5 transition-opacity"
                style="background:{layer.color}22; border:1px solid {layer.color}66; opacity:{hasData && count === 0 ? 0.35 : 1}"
              >
                <div class="w-2 h-2 rounded-full flex-shrink-0" style="background:{layer.color}"></div>
                <span class="text-[11px] font-medium text-[#ddd] flex-1">{INFRA_LABEL[layer.infraType] ?? layer.infraType}</span>
                {#if hasData}
                  <span class="text-[10px] font-mono {count > 0 ? 'text-[#aaa]' : 'text-[#444]'}">{count > 0 ? `${count}区間` : '—'}</span>
                {:else}
                  <span class="text-[10px] text-[#444]">—</span>
                {/if}
              </div>
            </div>
          {/each}
        </div>

        {#if undergroundData}
          <div class="mt-3 pt-2 border-t border-white/[0.06] flex items-center justify-between">
            <span class="text-[10px] text-[#555]">半径 {undergroundData.radiusM}m · {undergroundData.lat.toFixed(4)},{undergroundData.lng.toFixed(4)}</span>
            <button
              class="text-[10px] px-2 py-1 rounded-md bg-white/[0.06] text-[#888] hover:bg-white/[0.1] transition-colors touch-manipulation"
              onclick={() => void fetchUnderground()}
            >更新</button>
          </div>
        {/if}
      {/if}
    </div>
  </div>
  {/if}
  {/if}

  <!-- Route Panel — desktop: top-right card, mobile: bottom sheet -->
  {#if routeMode}
    <div class="absolute top-[68px] right-4 w-[320px] z-20 bg-[rgba(26,26,26,0.92)] backdrop-blur-xl border border-white/[0.1] rounded-xl p-3 text-white shadow-[0_4px_12px_rgba(0,0,0,0.4)] max-[600px]:top-auto max-[600px]:bottom-0 max-[600px]:left-0 max-[600px]:right-0 max-[600px]:w-full max-[600px]:rounded-b-none max-[600px]:rounded-t-2xl max-[600px]:max-h-[55dvh] max-[600px]:overflow-y-auto max-[600px]:pb-[env(safe-area-inset-bottom,12px)]">
      <!-- Profile Toggle -->
      <div class="flex gap-1 mb-3">
        {#each [['driving', '車'], ['walking', '徒歩'], ['transit', '電車'], ['ferry', '船'], ['flight', '飛行機']] as [pKey, pLabel] (pKey)}
          <button
            class="flex-1 h-9 rounded-lg text-[12px] font-medium border transition-colors duration-150 touch-manipulation {routeProfile === pKey ? 'bg-[#00ffcc] text-[#1a1a1a] border-[#00ffcc]' : 'bg-white/[0.06] text-[#ccc] border-white/[0.12] hover:bg-white/[0.12]'}"
            onclick={() => { routeProfile = pKey as any; if (routeStart && routeEnd) void calculateRoute(); }}
          >{pLabel}</button>
        {/each}
      </div>

      <!-- Origin Input -->
      <div class="relative mb-2">
        <div class="flex items-center gap-2 bg-white/[0.06] rounded-lg px-3 h-11 border border-white/[0.08]">
          <div class="w-3 h-3 rounded-full bg-[#00cc66] flex-shrink-0"></div>
          <input
            bind:value={routeOriginInput}
            oninput={onRouteOriginInput}
            onfocus={() => { if (routeOriginSuggestions.length > 0) showOriginSuggestions = true; }}
            onblur={() => setTimeout(() => { showOriginSuggestions = false; }, 200)}
            onkeydown={(e) => { if (e.key === 'Enter' && routeOriginSuggestions.length > 0) selectRouteOrigin(routeOriginSuggestions[0]); }}
            type="text"
            placeholder="出発地を入力..."
            class="flex-1 border-none outline-none text-[13px] bg-transparent text-white font-[inherit] placeholder:text-[#888]"
            autocomplete="off"
            spellcheck="false"
          />
          {#if routeStart}
            <button aria-label="Clear start" class="w-7 h-7 flex items-center justify-center rounded-full bg-white/[0.08] text-[#888] hover:bg-white/[0.15] flex-shrink-0 touch-manipulation" onclick={() => clearRoutePoint('start')}>
              <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          {/if}
        </div>
        {#if showOriginSuggestions && routeOriginSuggestions.length > 0}
          <div class="absolute top-full left-0 right-0 z-30 mt-1 bg-[rgba(30,30,30,0.97)] backdrop-blur-xl border border-white/[0.12] rounded-lg overflow-hidden shadow-[0_4px_12px_rgba(0,0,0,0.5)] max-h-[200px] overflow-y-auto">
            {#each routeOriginSuggestions.slice(0, 5) as result (result.id)}
              <button
                class="w-full text-left px-3 py-2.5 min-h-[44px] text-[12px] text-[#ddd] hover:bg-white/[0.1] transition-colors duration-100 touch-manipulation border-b border-white/[0.06] last:border-b-0"
                onmousedown={(e) => { e.preventDefault(); selectRouteOrigin(result); }}
              >
                <span class="block leading-[1.3] break-words">{result.title}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Destination Input -->
      <div class="relative mb-3">
        <div class="flex items-center gap-2 bg-white/[0.06] rounded-lg px-3 h-11 border border-white/[0.08]">
          <div class="w-3 h-3 rounded-full bg-[#ff4444] flex-shrink-0"></div>
          <input
            bind:value={routeDestInput}
            oninput={onRouteDestInput}
            onfocus={() => { if (routeDestSuggestions.length > 0) showDestSuggestions = true; }}
            onblur={() => setTimeout(() => { showDestSuggestions = false; }, 200)}
            onkeydown={(e) => { if (e.key === 'Enter' && routeDestSuggestions.length > 0) selectRouteDest(routeDestSuggestions[0]); }}
            type="text"
            placeholder="目的地を入力..."
            class="flex-1 border-none outline-none text-[13px] bg-transparent text-white font-[inherit] placeholder:text-[#888]"
            autocomplete="off"
            spellcheck="false"
          />
          {#if routeEnd}
            <button aria-label="Clear destination" class="w-7 h-7 flex items-center justify-center rounded-full bg-white/[0.08] text-[#888] hover:bg-white/[0.15] flex-shrink-0 touch-manipulation" onclick={() => clearRoutePoint('end')}>
              <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          {/if}
        </div>
        {#if showDestSuggestions && routeDestSuggestions.length > 0}
          <div class="absolute top-full left-0 right-0 z-30 mt-1 bg-[rgba(30,30,30,0.97)] backdrop-blur-xl border border-white/[0.12] rounded-lg overflow-hidden shadow-[0_4px_12px_rgba(0,0,0,0.5)] max-h-[200px] overflow-y-auto">
            {#each routeDestSuggestions.slice(0, 5) as result (result.id)}
              <button
                class="w-full text-left px-3 py-2.5 min-h-[44px] text-[12px] text-[#ddd] hover:bg-white/[0.1] transition-colors duration-100 touch-manipulation border-b border-white/[0.06] last:border-b-0"
                onmousedown={(e) => { e.preventDefault(); selectRouteDest(result); }}
              >
                <span class="block leading-[1.3] break-words">{result.title}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Tap hint -->
      {#if !routeStart || !routeEnd}
        <div class="text-[11px] text-[#666] mb-3 text-center">地図タップでも設定できます</div>
      {/if}

      {#if routeLoading || routeSearching}
        <div class="flex items-center gap-2 text-[13px] text-[#888] mb-3">
          <div class="w-4 h-4 rounded-full border-2 border-white/15 border-t-[#00ffcc] animate-spin"></div>
          {routeSearching ? 'ルートを検索中...' : 'ルートを計算中...'}
        </div>
      {/if}
      {#if routeError}
        <div class="text-[13px] text-[#ff5c6c] mb-3">{routeError}</div>
      {/if}

      <!-- Route Alternatives List -->
      {#if routeAlternatives.length > 1}
        <div class="flex flex-col gap-1.5 mb-3">
          {#each routeAlternatives as alt, i}
            <button
              class="w-full text-left px-3 py-2 rounded-lg border transition-all duration-150 touch-manipulation min-h-[44px] {selectedRouteIndex === i ? 'border-[rgba(0,255,204,0.6)] bg-[rgba(0,255,204,0.1)]' : 'border-white/[0.1] bg-white/[0.04] hover:bg-white/[0.08]'}"
              onclick={() => selectAlternativeRoute(i)}
            >
              <div class="flex items-center gap-2">
                <div class="w-3 h-1.5 rounded-full flex-shrink-0" style="background:{ROUTE_COLORS[i] || ROUTE_COLORS[0]}; opacity:{selectedRouteIndex === i ? 1 : 0.6}"></div>
                <span class="text-[13px] font-medium {selectedRouteIndex === i ? 'text-[#00ffcc]' : 'text-[#ccc]'}">
                  ルート {i + 1}
                </span>
                <span class="ml-auto text-[12px] text-[#999]">
                  {formatRouteDistance(alt.distance)} / {formatRouteDuration(alt.duration)}
                </span>
              </div>
              {#if i > 0}
                {@const diff = alt.duration - routeAlternatives[0].duration}
                <span class="text-[11px] text-[#888] ml-5">
                  {diff > 0 ? `+${formatRouteDuration(diff)}` : `${formatRouteDuration(Math.abs(diff))} 短い`}
                </span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}

      <!-- Route Stats (single route) -->
      {#if routeGeometry && routeDistance > 0 && routeAlternatives.length <= 1}
        <div class="flex items-center gap-4 bg-[rgba(0,255,204,0.08)] border border-[rgba(0,255,204,0.25)] rounded-lg px-3 py-2 mb-3">
          <div class="flex flex-col">
            <span class="text-[11px] text-[#888] uppercase">距離</span>
            <span class="text-[15px] font-semibold text-[#00ffcc]">{formatRouteDistance(routeDistance)}</span>
          </div>
          <div class="flex flex-col">
            <span class="text-[11px] text-[#888] uppercase">所要時間</span>
            <span class="text-[15px] font-semibold text-[#00ffcc]">{formatRouteDuration(routeDuration)}</span>
          </div>
        </div>
      {/if}

      <!-- Save/Clear -->
      {#if (routeGeometry || multiModalJourney) && routeDistance > 0}
        <div class="flex gap-2 mb-3">
          <button
            class="flex-1 h-9 rounded-lg text-[13px] font-medium bg-[#00ffcc] text-[#1a1a1a] border-none cursor-pointer transition-opacity duration-150 touch-manipulation disabled:opacity-50"
            onclick={() => void saveRoute()}
            disabled={routeSaving}
          >{routeSaving ? '保存中...' : '保存'}</button>
          <button
            class="flex-1 h-9 rounded-lg text-[13px] font-medium bg-white/[0.08] text-[#ccc] border border-white/[0.12] cursor-pointer transition-colors duration-150 touch-manipulation hover:bg-white/[0.15]"
            onclick={clearRoute}
          >クリア</button>
        </div>
      {/if}

      <!-- Start Navigation Button (standard) -->
      {#if routeGeometry && routeSteps.length > 0 && !navigationMode}
        <button
          class="w-full h-11 rounded-lg text-[14px] font-bold bg-[#00ffcc] text-[#1a1a1a] transition-opacity touch-manipulation hover:opacity-90 mb-3"
          onclick={startNavigation}
        >ナビ開始</button>
      {/if}

      <!-- Transit Navigation Button -->
      {#if multiModalJourney && journeyLegs.length > 0 && !navigationMode}
        <button
          class="w-full h-11 rounded-lg text-[14px] font-bold bg-[#00ffcc] text-[#1a1a1a] transition-opacity touch-manipulation hover:opacity-90 mb-3"
          onclick={startTransitNavigation}
        >ナビ開始 ({journeyLegs.length}区間)</button>
      {/if}

      <!-- Turn-by-Turn Step List -->
      {#if routeSteps.length > 0}
        <button
          class="w-full text-left text-[12px] text-[#888] hover:text-[#ccc] transition-colors duration-150 flex items-center gap-1 touch-manipulation mb-2"
          onclick={() => { showStepList = !showStepList; }}
        >
          <svg class="w-3 h-3 transition-transform duration-200 {showStepList ? 'rotate-90' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6" /></svg>
          ステップ ({routeSteps.length})
        </button>
        {#if showStepList}
          <div class="flex flex-col gap-0 max-h-[300px] overflow-y-auto mb-3">
            {#each routeSteps as step, i (i)}
              <button
                class="w-full text-left px-3 py-2 min-h-[44px] border-b border-white/[0.06] hover:bg-white/[0.08] transition-colors touch-manipulation flex items-start gap-3"
                onclick={() => flyToStep(step)}
              >
                <div class="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 {i === 0 ? 'bg-[#00cc66]' : i === routeSteps.length - 1 ? 'bg-[#ff4444]' : 'bg-white/[0.12]'}">
                  <span class="text-[11px] font-bold text-white">{getManeuverIcon(step.maneuverType, step.maneuverModifier)}</span>
                </div>
                <div class="flex-1 min-w-0">
                  <span class="block text-[13px] text-white leading-[1.3]">{step.instruction}</span>
                  <span class="block text-[11px] text-[#888] mt-0.5">
                    {step.roadName ? step.roadName + ' / ' : ''}{formatRouteDistance(step.distance)}
                  </span>
                </div>
              </button>
            {/each}
          </div>
        {/if}
      {/if}

      <!-- Multi-Modal Journey Leg List -->
      {#if journeyLegs.length > 0}
        <button
          class="w-full text-left text-[12px] text-[#888] hover:text-[#ccc] transition-colors duration-150 flex items-center gap-1 touch-manipulation mb-2"
          onclick={() => { showLegList = !showLegList; }}
        >
          <svg class="w-3 h-3 transition-transform duration-200 {showLegList ? 'rotate-90' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6" /></svg>
          乗換ルート ({journeyLegs.length} 区間)
        </button>
        {#if showLegList}
          <div class="flex flex-col gap-0 max-h-[350px] overflow-y-auto mb-3">
            {#each journeyLegs as leg, i (i)}
              <button
                class="w-full text-left px-3 py-3 border-b border-white/[0.06] hover:bg-white/[0.08] transition-colors touch-manipulation"
                onclick={() => { if (map) map.flyTo({ center: leg.fromCoords, zoom: 15, duration: 800 }); }}
              >
                <div class="flex items-center gap-2 mb-1.5">
                  <div
                    class="w-7 h-7 rounded-full flex items-center justify-center text-[13px] flex-shrink-0"
                    style="background: {LEG_MODE_COLOR[leg.mode]}22; border: 1px solid {LEG_MODE_COLOR[leg.mode]}66;"
                  >{LEG_MODE_ICON[leg.mode]}</div>
                  <span class="text-[13px] font-semibold text-white truncate">{leg.lineName || leg.mode}</span>
                  <span class="ml-auto text-[11px] text-[#888] flex-shrink-0">{formatRouteDuration(leg.durationSeconds)}</span>
                </div>
                <div class="ml-9 flex flex-col gap-0.5">
                  <div class="flex items-center gap-1.5">
                    <div class="w-2 h-2 rounded-full flex-shrink-0" style="background: {LEG_MODE_COLOR[leg.mode]}"></div>
                    <span class="text-[12px] text-[#ccc] truncate">{leg.fromStop}</span>
                  </div>
                  <div class="ml-[3px] w-px h-3 bg-white/20"></div>
                  <div class="flex items-center gap-1.5">
                    <div class="w-2 h-2 rounded-sm flex-shrink-0" style="background: {LEG_MODE_COLOR[leg.mode]}"></div>
                    <span class="text-[12px] text-[#ccc] truncate">{leg.toStop}</span>
                  </div>
                </div>
              </button>
            {/each}
          </div>
        {/if}
      {/if}

      <!-- Saved Routes -->
      <button
        class="w-full text-left text-[12px] text-[#888] hover:text-[#ccc] transition-colors duration-150 flex items-center gap-1 touch-manipulation"
        onclick={() => { showSavedRoutes = !showSavedRoutes; if (showSavedRoutes) void loadSavedRoutes(); }}
      >
        <svg class="w-3 h-3 transition-transform duration-200 {showSavedRoutes ? 'rotate-90' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6" /></svg>
        保存済みルート ({savedRoutes.length})
      </button>
      {#if showSavedRoutes && savedRoutes.length > 0}
        <div class="mt-2 flex flex-col gap-1.5 max-h-[200px] overflow-y-auto">
          {#each savedRoutes as route (route.id)}
            <div class="flex items-start gap-2 bg-white/[0.04] border border-white/[0.08] rounded-lg px-2.5 py-2 group">
              <button class="flex-1 text-left cursor-pointer min-h-[44px] touch-manipulation" onclick={() => loadRouteOnMap(route)}>
                <span class="block text-[12px] text-white leading-[1.3] break-words">{route.name}</span>
                <span class="block text-[11px] text-[#888] mt-0.5">{formatRouteDistance(route.distanceMeters)} / {formatRouteDuration(route.durationSeconds)} / {({ driving: '車', walking: '徒歩', transit: '電車', ferry: '船', flight: '飛行機' } as Record<string, string>)[route.profile] || route.profile}</span>
              </button>
              <button
                class="w-6 h-6 flex items-center justify-center rounded-full text-[#666] hover:text-[#ff5c6c] hover:bg-white/[0.08] flex-shrink-0 mt-1 touch-manipulation opacity-0 group-hover:opacity-100 transition-opacity duration-150"
                onclick={() => void deleteSavedRoute(route.id)}
                title="削除"
              >
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
              </button>
            </div>
          {/each}
        </div>
      {/if}
      {#if showSavedRoutes && savedRoutes.length === 0}
        <div class="mt-2 text-[12px] text-[#666] text-center py-2">保存済みルートなし</div>
      {/if}
    </div>
  {/if}

  <!-- Navigation Mode Overlay (standard driving/walking) -->
  {#if navigationMode && routeSteps[currentStepIndex] && journeyLegs.length === 0}
    {@const currentStep = routeSteps[currentStepIndex]}
    {@const nextStep = routeSteps[currentStepIndex + 1]}
    <!-- Top instruction card -->
    <div class="absolute top-0 left-0 right-0 z-30 bg-[rgba(26,26,26,0.95)] backdrop-blur-xl" style="padding-top:max(env(safe-area-inset-top,12px),12px)">
      <div class="px-4 pb-3">
        <div class="flex items-center gap-4">
          <div class="w-16 h-16 rounded-2xl bg-[#00ffcc] flex items-center justify-center flex-shrink-0">
            <span class="text-[28px] text-[#1a1a1a] font-bold">{getManeuverIcon(currentStep.maneuverType, currentStep.maneuverModifier)}</span>
          </div>
          <div class="flex-1 min-w-0">
            <span class="block text-[24px] font-bold text-white leading-tight">{formatRouteDistance(currentStep.distance)}</span>
            <span class="block text-[15px] text-[#ccc] leading-tight mt-1">{currentStep.instruction}</span>
            {#if currentStep.roadName}
              <span class="block text-[13px] text-[#888] mt-0.5">{currentStep.roadName}</span>
            {/if}
          </div>
        </div>
        {#if currentStep.lanes && currentStep.lanes.length > 0}
          <div class="flex gap-1 mt-3 justify-center">
            {#each currentStep.lanes as lane}
              <div class="w-8 h-10 rounded border-2 flex items-center justify-center text-[10px] {lane.valid ? 'border-[#00ffcc] bg-[rgba(0,255,204,0.15)] text-[#00ffcc]' : 'border-white/[0.2] text-[#666]'}">
                {lane.indications.map((ind: string) => ind === 'left' ? '\u2190' : ind === 'right' ? '\u2192' : '\u2191').join('')}
              </div>
            {/each}
          </div>
        {/if}
        {#if nextStep}
          <div class="mt-3 pt-3 border-t border-white/[0.1] flex items-center gap-3 text-[#888]">
            <span class="text-[14px]">{getManeuverIcon(nextStep.maneuverType, nextStep.maneuverModifier)}</span>
            <span class="text-[13px] flex-1 truncate">{nextStep.instruction}</span>
            <span class="text-[13px] flex-shrink-0">{formatRouteDistance(nextStep.distance)}</span>
          </div>
        {/if}
      </div>
    </div>
    <!-- Bottom ETA bar -->
    <div class="absolute bottom-0 left-0 right-0 z-30 bg-[rgba(26,26,26,0.95)] backdrop-blur-xl pb-[env(safe-area-inset-bottom,12px)]">
      <div class="px-4 py-3 flex items-center gap-4">
        <div class="flex flex-col">
          <span class="text-[28px] font-bold text-[#00ffcc]">{navigationETA}</span>
          <span class="text-[12px] text-[#888] uppercase">到着予定</span>
        </div>
        <div class="h-8 w-px bg-white/[0.15]"></div>
        <div class="flex flex-col">
          <span class="text-[17px] font-semibold text-white">{formatRouteDuration(navigationRemainingDuration)}</span>
          <span class="text-[12px] text-[#888]">{formatRouteDistance(navigationRemainingDistance)}</span>
        </div>
        <div class="ml-auto flex items-center gap-2">
          <button
            class="w-11 h-11 rounded-full flex items-center justify-center border border-white/[0.15] touch-manipulation {voiceMuted ? 'bg-white/[0.08] text-[#888]' : 'bg-[rgba(0,255,204,0.15)] text-[#00ffcc]'}"
            onclick={() => { voiceMuted = !voiceMuted; if (voiceMuted && typeof speechSynthesis !== 'undefined') speechSynthesis.cancel(); }}
          >
            {#if voiceMuted}
              <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></svg>
            {:else}
              <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" /></svg>
            {/if}
          </button>
          <button
            class="h-11 px-5 rounded-full bg-[#ff4444] text-white text-[14px] font-medium touch-manipulation"
            onclick={stopNavigation}
          >終了</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Transit Navigation Mode Overlay -->
  {#if navigationMode && journeyLegs.length > 0 && journeyLegs[transitStepIndex]}
    {@const currentLeg = journeyLegs[transitStepIndex]}
    {@const remainingDur = journeyLegs.slice(transitStepIndex).reduce((s, l) => s + l.durationSeconds, 0)}
    {@const remainingDist = journeyLegs.slice(transitStepIndex).reduce((s, l) => s + l.distanceMeters, 0)}
    <!-- Top boarding instruction card -->
    <div class="absolute top-0 left-0 right-0 z-30 bg-[rgba(26,26,26,0.95)] backdrop-blur-xl" style="padding-top:max(env(safe-area-inset-top,12px),12px)">
      <div class="px-4 pb-3">
        <div class="flex items-center gap-4">
          <div class="w-16 h-16 rounded-2xl flex items-center justify-center flex-shrink-0" style="background-color:{LEG_MODE_COLOR[currentLeg.mode] || '#888'}">
            <span class="text-[28px]">{LEG_MODE_ICON[currentLeg.mode] || ''}</span>
          </div>
          <div class="flex-1 min-w-0">
            <span class="block text-[20px] font-bold text-white leading-tight">{buildBoardingInstruction(currentLeg)}</span>
            <span class="block text-[14px] text-[#ccc] mt-1">{currentLeg.fromStop} → {currentLeg.toStop}</span>
            <span class="block text-[13px] text-[#888] mt-0.5">{formatRouteDistance(currentLeg.distanceMeters)} · {formatRouteDuration(currentLeg.durationSeconds)}</span>
          </div>
        </div>
        <!-- Next leg preview -->
        {#if journeyLegs[transitStepIndex + 1]}
          {@const nextLeg = journeyLegs[transitStepIndex + 1]}
          <div class="mt-3 pt-3 border-t border-white/[0.1] flex items-center gap-3 text-[#888]">
            <span class="text-[14px]">{LEG_MODE_ICON[nextLeg.mode] || ''}</span>
            <span class="text-[13px] flex-1 truncate">{nextLeg.lineName} {nextLeg.fromStop}→{nextLeg.toStop}</span>
            <span class="text-[13px] flex-shrink-0">{formatRouteDuration(nextLeg.durationSeconds)}</span>
          </div>
        {/if}
      </div>
    </div>
    <!-- Bottom controls bar -->
    <div class="absolute bottom-0 left-0 right-0 z-30 bg-[rgba(26,26,26,0.95)] backdrop-blur-xl pb-[env(safe-area-inset-bottom,12px)]">
      <div class="px-4 py-3 flex items-center gap-3">
        <!-- Prev button -->
        <button
          aria-label="Previous leg"
          class="w-11 h-11 rounded-full flex items-center justify-center border border-white/[0.15] touch-manipulation {transitStepIndex > 0 ? 'bg-white/[0.08] text-white' : 'bg-white/[0.04] text-[#555]'}"
          onclick={prevTransitLeg}
          disabled={transitStepIndex === 0}
        >
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6" /></svg>
        </button>
        <!-- Progress -->
        <div class="flex-1 text-center">
          <span class="text-[15px] font-semibold text-white">{transitStepIndex + 1} / {journeyLegs.length}</span>
          <span class="block text-[12px] text-[#888]">残り {formatRouteDuration(remainingDur)} · {formatRouteDistance(remainingDist)}</span>
        </div>
        <!-- Next button -->
        <button
          class="w-11 h-11 rounded-full flex items-center justify-center touch-manipulation {transitStepIndex < journeyLegs.length - 1 ? 'bg-[#00ffcc] text-[#1a1a1a]' : 'bg-[#00ffcc] text-[#1a1a1a]'}"
          onclick={nextTransitLeg}
        >
          {#if transitStepIndex < journeyLegs.length - 1}
            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6" /></svg>
          {:else}
            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5" /></svg>
          {/if}
        </button>
        <!-- Stop -->
        <button
          class="h-11 px-5 rounded-full bg-[#ff4444] text-white text-[14px] font-medium touch-manipulation"
          onclick={stopNavigation}
        >終了</button>
      </div>
    </div>
  {/if}

  <!-- Hamburger Menu Button -->
  <button
    class="absolute top-4 left-4 z-20 w-11 h-11 rounded-full flex items-center justify-center bg-white shadow-[0_2px_6px_rgba(0,0,0,0.3)] text-[#666] hover:text-[#333] transition-colors touch-manipulation max-[600px]:top-[10px] max-[600px]:left-[10px]"
    onclick={() => { showMenu = !showMenu; }}
    aria-label="Menu"
  >
    <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  </button>

  <!-- Hamburger Menu Panel -->
  {#if showMenu}
    <button
      class="fixed inset-0 z-30 bg-black/20"
      onclick={() => { showMenu = false; }}
      aria-label="Close menu"
    ></button>
    <div class="absolute top-[68px] left-4 w-[280px] z-40 bg-white rounded-xl shadow-[0_4px_16px_rgba(0,0,0,0.25)] overflow-hidden max-[600px]:top-[60px] max-[600px]:left-[10px]">
      <div class="p-3">
        <div class="text-[10px] font-bold tracking-widest uppercase mb-2 text-[#888]">Maps Tools</div>
        {#each mapsTools as tool}
          <a
            href={tool.href}
            target="_blank"
            rel="noopener noreferrer"
            class="flex items-center gap-2.5 px-2 py-2 rounded-lg min-h-[44px] text-[#333] hover:bg-[#f5f5f5] transition-colors touch-manipulation"
          >
            <span class="w-7 h-7 flex items-center justify-center rounded-lg text-[16px] bg-[#eee]">{tool.icon}</span>
            <span class="text-[13px] font-medium">{tool.label}</span>
          </a>
        {/each}
      </div>
      <div class="px-3 pb-3">
        <div class="text-[10px] font-bold tracking-widest uppercase mb-2 mt-1 text-[#888]">Data Sources</div>
        {#each dataSources as source}
          <a
            href={source.href}
            target="_blank"
            rel="noopener noreferrer"
            class="flex items-center gap-2.5 px-2 py-2 rounded-lg min-h-[44px] text-[#333] hover:bg-[#f5f5f5] transition-colors touch-manipulation"
          >
            <span class="w-7 h-7 flex items-center justify-center rounded-lg text-[16px] bg-[#eee]">{source.icon}</span>
            <span class="text-[13px] font-medium">{source.label}</span>
          </a>
        {/each}
      </div>
      <div class="border-t border-[#eee] px-3 py-2">
        <span class="text-[11px] text-[#888]">maps.etzhayyim.com</span>
      </div>
    </div>
  {/if}

  <!-- Search Bar -->
  <div class="absolute top-4 left-[72px] w-[420px] max-w-[calc(100vw-200px)] z-20 max-[600px]:max-w-[calc(100vw-120px)] max-[600px]:top-[10px] max-[600px]:left-[56px]">
    <div class="flex items-center bg-white px-4 h-11 shadow-[0_2px_6px_rgba(0,0,0,0.3)] transition-all duration-200 {showResults && (searchResults.length > 0 || searchStatusText) ? 'rounded-t-2xl shadow-[0_2px_8px_rgba(0,0,0,0.35)]' : 'rounded-[24px]'}">
      <svg class="w-[18px] h-[18px] text-[#666] flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.35-4.35" />
      </svg>
      <input
        bind:this={searchInputEl}
        bind:value={searchQuery}
        oninput={onSearchInput}
        onkeydown={onSearchKeydown}
        onblur={onSearchBlur}
        onfocus={() => { if (searchResults.length > 0) showResults = true; }}
        type="text"
        placeholder="場所を検索 / 東京から渋谷 でルート検索"
        class="flex-1 border-none outline-none text-[14px] px-3 bg-transparent text-[#333] font-[inherit] placeholder:text-[#999]"
        autocomplete="off"
        spellcheck="false"
      />
      {#if searching}
        <div class="w-[18px] h-[18px] rounded-full border-2 border-white/15 border-t-[var(--gv2-text-muted,#666)] animate-spin flex-shrink-0 mr-2"></div>
      {/if}
      {#if searchQuery.length > 0}
        <button
          class="flex items-center justify-center w-[26px] h-[26px] border-none bg-[#eee] rounded-full cursor-pointer p-0 flex-shrink-0 transition-colors duration-150 hover:bg-[#ddd]"
          onmousedown={(e) => { e.preventDefault(); clearSearch(); }}
          aria-label="検索をクリア"
        >
          <svg class="w-[14px] h-[14px] text-[#666]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      {/if}
    </div>

    {#if showResults && (searchResults.length > 0 || (searchStatusText && searchResults.length === 0))}
      <div class="bg-white rounded-b-2xl shadow-[0_4px_8px_rgba(0,0,0,0.3)] max-h-[360px] overflow-y-auto border-t border-[#eee]">
        {#if searchStatusText}
          <div class="text-[11px] text-[#888] px-4 pt-2 pb-1 border-b border-dashed border-[#eee]">{searchStatusText}</div>
        {/if}
        {#each searchResults as result (result.id)}
          <button
            class="flex items-start gap-3 w-full px-4 py-[10px] border-none bg-transparent cursor-pointer text-left font-[inherit] transition-colors duration-100 hover:bg-[#f5f5f5] last:rounded-b-2xl"
            onmousedown={(e) => { e.preventDefault(); selectResult(result); }}
          >
            <svg class="w-[18px] h-[18px] text-[#00ffcc] flex-shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
              <circle cx="12" cy="10" r="3" />
            </svg>
            <div class="flex flex-col gap-0.5 flex-1 min-w-0">
              <span class="text-[13px] text-[#333] leading-[1.4] break-words">{result.title}</span>
              <span class="text-[11px] text-[#999]">{result.subtitle || formatResultType(result)}</span>
            </div>
            <span class="text-[10px] text-[#0b5f4f] bg-[rgba(0,255,204,0.18)] border border-[rgba(0,255,204,0.4)] rounded-[10px] px-1.5 py-0.5 whitespace-nowrap self-center lowercase">{result.source}</span>
          </button>
        {/each}
      </div>
    {/if}
    {#if showResults && !searching && searchResults.length === 0 && searchQuery.trim().length >= 2 && !parseRouteQuery(searchQuery.trim())}
      <div class="bg-white rounded-b-2xl shadow-[0_4px_8px_rgba(0,0,0,0.3)] border-t border-[#eee]">
        <div class="p-4 text-center text-[#999] text-[13px]">検索結果が見つかりません</div>
      </div>
    {/if}
  </div>

  <!-- Operations dashboard rail -->
  <div class="absolute top-4 right-4 z-20 flex items-start gap-2 max-[900px]:hidden">
    {#if showLayerDrawer}
      <div class="w-[292px] max-h-[calc(100dvh-32px)] overflow-hidden rounded-lg border border-white/[0.12] bg-[rgba(15,23,42,0.88)] text-white shadow-[0_6px_24px_rgba(0,0,0,0.38)] backdrop-blur-xl">
        <div class="flex items-center justify-between border-b border-white/[0.08] px-3 py-2.5">
          <div>
            <div class="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/45">Layer Catalog</div>
            <div class="text-[13px] font-semibold">Operational overlays</div>
          </div>
          <button class="h-8 w-8 rounded-md text-white/60 hover:bg-white/10 hover:text-white" onclick={() => { showLayerDrawer = false; }} aria-label="Close layer catalog">×</button>
        </div>
        <div class="max-h-[calc(100dvh-104px)] overflow-y-auto p-2">
          {#each dashboardLayers as layer (layer.id)}
            <button
              class="mb-1 flex min-h-[48px] w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors {dashboardLayerEnabled(layer) ? 'border-white/[0.16] bg-white/[0.08]' : 'border-white/[0.08] bg-transparent hover:bg-white/[0.05]'}"
              onclick={() => toggleDashboardLayer(layer)}
            >
              <span class="h-2.5 w-2.5 flex-shrink-0 rounded-full" style="background:{layer.color ?? '#94a3b8'}"></span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-[12px] font-semibold">{layer.name}</span>
                <span class="block truncate text-[10px] text-white/45">{layer.category}{#if layer.count != null} / {layer.count}{/if}</span>
              </span>
              <span class="rounded-full px-2 py-0.5 text-[10px] {dashboardLayerEnabled(layer) ? 'bg-emerald-400/15 text-emerald-200' : 'bg-white/[0.06] text-white/45'}">
                {dashboardLayerEnabled(layer) ? 'ON' : 'OFF'}
              </span>
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <div class="w-[336px] max-h-[calc(100dvh-32px)] overflow-hidden rounded-lg border border-white/[0.12] bg-[rgba(12,18,28,0.9)] text-white shadow-[0_6px_24px_rgba(0,0,0,0.42)] backdrop-blur-xl">
      <div class="flex items-center gap-2 border-b border-white/[0.08] px-3 py-2.5">
        <span class="h-2 w-2 rounded-full" style="background:{riskColor(dashboard?.risk.level)}"></span>
        <div class="min-w-0 flex-1">
          <div class="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/45">Spatial Ops</div>
          <div class="truncate text-[13px] font-semibold">maps.etzhayyim.com monitor</div>
        </div>
        <button class="h-8 w-8 rounded-md text-white/60 hover:bg-white/10 hover:text-white" onclick={() => { showLayerDrawer = !showLayerDrawer; }} aria-label="Layer catalog">☷</button>
        <button class="h-8 w-8 rounded-md text-white/60 hover:bg-white/10 hover:text-white" onclick={() => { showOpsPanel = !showOpsPanel; }} aria-label="Toggle ops panel">{showOpsPanel ? '−' : '+'}</button>
      </div>

      {#if showOpsPanel}
        <div class="max-h-[calc(100dvh-86px)] overflow-y-auto p-3">
          <div class="mb-3 grid grid-cols-4 gap-1 rounded-md bg-white/[0.05] p-1">
            {#each ['1h', '6h', '24h', '7d'] as range}
              <button
                class="h-7 rounded text-[11px] font-semibold transition-colors {selectedDashboardRange === range ? 'bg-white text-slate-950' : 'text-white/55 hover:bg-white/[0.08]'}"
                onclick={() => { selectedDashboardRange = range as '1h' | '6h' | '24h' | '7d'; void refreshDashboard(); }}
              >{range}</button>
            {/each}
          </div>

          <div class="mb-3 rounded-md border border-white/[0.1] bg-white/[0.06] p-3">
            <div class="flex items-end justify-between gap-3">
              <div>
                <div class="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/45">Risk</div>
                <div class="mt-1 text-[28px] font-semibold leading-none" style="color:{riskColor(dashboard?.risk.level)}">{dashboard?.risk.score ?? 0}</div>
              </div>
              <div class="text-right">
                <div class="text-[12px] font-semibold uppercase" style="color:{riskColor(dashboard?.risk.level)}">{dashboard?.risk.level ?? 'low'}</div>
                <div class="mt-1 text-[10px] text-white/45">{dashboardLoading ? 'syncing' : formatDashboardTime(dashboard?.fetchedAt ?? '')}</div>
              </div>
            </div>
            {#if dashboard?.risk.drivers?.length}
              <div class="mt-3 space-y-1">
                {#each dashboard.risk.drivers.slice(0, 3) as driver}
                  <div class="truncate text-[11px] text-white/60">{driver}</div>
                {/each}
              </div>
            {/if}
            {#if dashboardError}
              <div class="mt-2 text-[10px] text-amber-200">API fallback: {dashboardError}</div>
            {/if}
          </div>

          <div class="mb-3 grid grid-cols-3 gap-2">
            <div class="rounded-md border border-white/[0.08] bg-white/[0.045] p-2">
              <div class="text-[10px] text-white/40">Events</div>
              <div class="mt-1 text-[18px] font-semibold">{dashboardCounts.spatialEvents ?? 0}</div>
            </div>
            <div class="rounded-md border border-white/[0.08] bg-white/[0.045] p-2">
              <div class="text-[10px] text-white/40">Assets</div>
              <div class="mt-1 text-[18px] font-semibold">{(dashboardCounts.airports ?? 0) + (dashboardCounts.ports ?? 0) + (dashboardCounts.stations ?? 0)}</div>
            </div>
            <div class="rounded-md border border-white/[0.08] bg-white/[0.045] p-2">
              <div class="text-[10px] text-white/40">Jobs</div>
              <div class="mt-1 text-[18px] font-semibold">{dashboardCounts.collectionJobs ?? 0}</div>
            </div>
          </div>

          <div class="mb-3 rounded-md border border-white/[0.08]">
            {#each dashboardLayers.slice(0, 5) as layer (layer.id)}
              <button class="flex min-h-[38px] w-full items-center gap-2 border-b border-white/[0.06] px-2.5 last:border-b-0 hover:bg-white/[0.04]" onclick={() => toggleDashboardLayer(layer)}>
                <span class="h-2 w-2 rounded-full" style="background:{layer.color ?? '#94a3b8'}"></span>
                <span class="min-w-0 flex-1 truncate text-left text-[11px]">{layer.name}</span>
                <span class="text-[10px] text-white/40">{layer.count ?? ''}</span>
              </button>
            {/each}
          </div>

          <div>
            <div class="mb-2 flex items-center justify-between">
              <div class="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/45">Live Intel</div>
              <button class="text-[10px] text-white/45 hover:text-white" onclick={() => { void refreshDashboard(); }}>refresh</button>
            </div>
            {#if dashboardEvents.length > 0}
              <div class="space-y-1.5">
                {#each dashboardEvents.slice(0, 5) as event (event.id)}
                  <button
                    class="w-full rounded-md border border-white/[0.08] bg-white/[0.045] px-2.5 py-2 text-left hover:bg-white/[0.08]"
                    onclick={() => { if (event.lat != null && event.lng != null && map) map.flyTo({ center: [event.lng, event.lat], zoom: 9, duration: 800 }); }}
                  >
                    <div class="flex items-center gap-2">
                      <span class="h-2 w-2 flex-shrink-0 rounded-full" style="background:{riskColor(event.severity === 'critical' ? 'high' : event.severity === 'warning' ? 'elevated' : event.severity === 'watch' ? 'watch' : 'low')}"></span>
                      <span class="min-w-0 flex-1 truncate text-[11px] font-semibold">{event.title}</span>
                    </div>
                    <div class="mt-1 truncate pl-4 text-[10px] text-white/40">{event.category}{#if event.timestamp} / {formatDashboardTime(event.timestamp)}{/if}</div>
                  </button>
                {/each}
              </div>
            {:else}
              <div class="rounded-md border border-dashed border-white/[0.14] px-3 py-4 text-center text-[11px] text-white/40">No spatial events in the current dashboard window</div>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  </div>

  <!-- Mobile Route Toggle (next to search bar) -->
  <button
    class="absolute top-[10px] right-[10px] z-20 w-11 h-11 rounded-full flex items-center justify-center border transition-all duration-200 touch-manipulation min-[601px]:hidden {routeMode ? 'bg-[#00ffcc] border-[#00ffcc] text-[#1a1a1a] shadow-[0_2px_10px_rgba(0,255,204,0.4)]' : 'bg-white border-[#ddd] text-[#666] shadow-[0_2px_6px_rgba(0,0,0,0.3)]'}"
    onclick={() => { routeMode = !routeMode; if (!routeMode) clearRoute(); else { closePlaceCard(); void loadSavedRoutes(); } }}
    title={routeMode ? 'ルートモードを終了' : 'ルートナビゲーション'}
  >
    <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="22 12 18 8 14 12" />
      <path d="M18 8v7a4 4 0 0 1-4 4h-4" />
      <polyline points="6 16 2 12 6 8" />
    </svg>
  </button>

  <!-- Place Detail Card -->
  {#if showPlaceCard && selectedPlace}
    <!-- Desktop: Left panel -->
    <div class="absolute top-[68px] left-4 w-[360px] z-20 bg-white rounded-xl shadow-[0_4px_24px_rgba(0,0,0,0.28)] overflow-hidden max-[600px]:hidden">
      <!-- Gradient header -->
      <div class="relative h-[120px] flex flex-col justify-end p-4" style="background: {placeCardGradient(selectedPlace)}">
        <button
          class="absolute top-3 right-3 w-8 h-8 rounded-full flex items-center justify-center bg-black/25 text-white hover:bg-black/40 transition-colors touch-manipulation"
          onclick={closePlaceCard}
          aria-label="Close"
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
        <div class="text-3xl mb-1 leading-none">{placeIcon(selectedPlace)}</div>
        <h2 class="text-[17px] font-bold text-white leading-tight" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">{selectedPlace.title}</h2>
      </div>
      <!-- Action buttons row -->
      <div class="flex gap-2 px-4 pt-4 pb-2">
        <button
          class="flex flex-col items-center gap-1 flex-1 py-2.5 rounded-xl bg-[#e8f5e9] text-[#1b5e20] touch-manipulation hover:opacity-80 transition-opacity"
          onclick={startDirectionsFromPlace}
        >
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="22 12 18 8 14 12" /><path d="M18 8v7a4 4 0 0 1-4 4h-4" /><polyline points="6 16 2 12 6 8" />
          </svg>
          <span class="text-[11px] font-medium">Directions</span>
        </button>
        {#if selectedPlace.externalURL}
          <a
            href={selectedPlace.externalURL}
            target="_blank"
            rel="noopener noreferrer"
            class="flex flex-col items-center gap-1 flex-1 py-2.5 rounded-xl bg-[#e3f2fd] text-[#0d47a1] touch-manipulation hover:opacity-80 transition-opacity no-underline"
          >
            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3" /></svg>
            <span class="text-[11px] font-medium">Website</span>
          </a>
        {/if}
        {#if selectedPlace.lat != null && selectedPlace.lng != null}
          <button
            class="flex flex-col items-center gap-1 flex-1 py-2.5 rounded-xl bg-[#fff3e0] text-[#bf360c] touch-manipulation hover:opacity-80 transition-opacity"
            onclick={() => {
              if (selectedPlace?.lat != null && selectedPlace?.lng != null)
                navigator.clipboard?.writeText(`${selectedPlace.lat.toFixed(6)}, ${selectedPlace.lng.toFixed(6)}`);
            }}
          >
            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            <span class="text-[11px] font-medium">Copy</span>
          </button>
        {/if}
        <button
          class="flex flex-col items-center gap-1 flex-1 py-2.5 rounded-xl bg-[#f3e8ff] text-[#6b21a8] touch-manipulation hover:opacity-80 transition-opacity"
          onclick={() => sharePlace(selectedPlace!)}
        >
          {#if shareCopied}
            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12" /></svg>
            <span class="text-[11px] font-medium">Copied!</span>
          {:else}
            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
            <span class="text-[11px] font-medium">Share</span>
          {/if}
        </button>
        {#if mapillaryToken && selectedPlace.lat != null && selectedPlace.lng != null}
          <button
            class="flex flex-col items-center gap-1 flex-1 py-2.5 rounded-xl bg-[#e6f9ef] text-[#065f46] touch-manipulation hover:opacity-80 transition-opacity"
            onclick={() => { closePlaceCard(); void openStreetViewAt(selectedPlace!.lat!, selectedPlace!.lng!); }}
          >
            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
            </svg>
            <span class="text-[11px] font-medium">Street</span>
          </button>
        {/if}
      </div>
      <!-- Info rows -->
      <div class="px-4 pb-1">
        {#if selectedPlace.subtitle}
          <div class="flex items-start gap-3 py-3 border-t border-[#f0f0f0]">
            <span class="text-[14px] text-[#aaa] mt-0.5 flex-shrink-0">ℹ️</span>
            <p class="text-[13px] text-[#555] leading-relaxed flex-1">{selectedPlace.subtitle}</p>
          </div>
        {/if}
        {#if selectedPlace.lat != null && selectedPlace.lng != null}
          <div class="flex items-center gap-3 py-3 border-t border-[#f0f0f0]">
            <svg class="w-4 h-4 text-[#aaa] flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" />
            </svg>
            <span class="font-mono text-[12px] text-[#777]">{selectedPlace.lat.toFixed(6)}, {selectedPlace.lng.toFixed(6)}</span>
          </div>
        {/if}
        <div class="flex items-center gap-3 py-3 border-t border-[#f0f0f0]">
          <svg class="w-4 h-4 text-[#aaa] flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
          <div class="flex items-center gap-1.5">
            <span class="text-[12px] text-[#777]">{formatResultType(selectedPlace)}</span>
            <span class="text-[10px] text-[#0b5f4f] bg-[rgba(0,255,204,0.18)] border border-[rgba(0,255,204,0.4)] rounded-[10px] px-1.5 py-0.5 lowercase">{selectedPlace.source}</span>
          </div>
        </div>
      </div>
      <!-- Entity graph neighbors -->
      {#if selectedPlace.source === 'entity_graph'}
        <div class="px-4 pb-4 border-t border-[#f0f0f0]">
          <div class="text-[11px] text-[#aaa] uppercase tracking-wider pt-3 pb-2">関連ノード</div>
          {#if entityNeighborsLoading}
            <div class="text-[12px] text-[#bbb] py-1">読み込み中…</div>
          {:else if entityNeighbors.length === 0}
            <div class="text-[12px] text-[#bbb] py-1">関連ノードなし</div>
          {:else}
            <div class="flex flex-col gap-0.5">
              {#each entityNeighbors as edge}
                <div class="flex items-start gap-2 py-1.5 rounded-lg hover:bg-[#f7f7f7] px-1 transition-colors">
                  <span class="text-[14px] flex-shrink-0 mt-0.5">{neighborIcon(edge)}</span>
                  <div class="flex flex-col min-w-0 flex-1">
                    <span class="text-[10px] text-[#bbb] leading-none mb-0.5">{edge.predicate.replace(/.*[:#/]/, '')}</span>
                    <span class="text-[13px] text-[#444] leading-tight truncate">{edge.objectLabel || edge.objectLiteral || edge.objectId || ''}</span>
                  </div>
                  <span class="text-[9px] text-[#ddd] flex-shrink-0 mt-1">{edge.direction}</span>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>

    <!-- Mobile: Bottom sheet -->
    <div class="absolute bottom-0 left-0 right-0 z-20 bg-white rounded-t-2xl shadow-[0_-4px_16px_rgba(0,0,0,0.2)] pb-[env(safe-area-inset-bottom,12px)] max-h-[60dvh] overflow-y-auto min-[601px]:hidden">
      <!-- Gradient header -->
      <div class="relative h-[96px] flex flex-col justify-end px-4 pb-3 rounded-t-2xl" style="background: {placeCardGradient(selectedPlace)}">
        <div class="absolute top-2 left-0 right-0 flex justify-center">
          <div class="w-8 h-1 rounded-full bg-white/40"></div>
        </div>
        <button
          class="absolute top-3 right-3 w-8 h-8 rounded-full flex items-center justify-center bg-black/25 text-white touch-manipulation"
          onclick={closePlaceCard}
          aria-label="Close"
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
        <div class="flex items-end gap-2">
          <span class="text-2xl leading-none">{placeIcon(selectedPlace)}</span>
          <h2 class="text-[16px] font-bold text-white leading-tight flex-1" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">{selectedPlace.title}</h2>
        </div>
      </div>
      <!-- Action buttons -->
      <div class="flex gap-2 px-4 pt-3 pb-2">
        <button
          class="flex flex-col items-center gap-1 flex-1 py-2.5 rounded-xl bg-[#e8f5e9] text-[#1b5e20] touch-manipulation"
          onclick={startDirectionsFromPlace}
        >
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="22 12 18 8 14 12" /><path d="M18 8v7a4 4 0 0 1-4 4h-4" /><polyline points="6 16 2 12 6 8" />
          </svg>
          <span class="text-[11px] font-medium">Directions</span>
        </button>
        {#if selectedPlace.externalURL}
          <a
            href={selectedPlace.externalURL}
            target="_blank"
            rel="noopener noreferrer"
            class="flex flex-col items-center gap-1 flex-1 py-2.5 rounded-xl bg-[#e3f2fd] text-[#0d47a1] touch-manipulation no-underline"
          >
            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3" /></svg>
            <span class="text-[11px] font-medium">Website</span>
          </a>
        {/if}
        {#if selectedPlace.lat != null && selectedPlace.lng != null}
          <button
            class="flex flex-col items-center gap-1 flex-1 py-2.5 rounded-xl bg-[#fff3e0] text-[#bf360c] touch-manipulation"
            onclick={() => {
              if (selectedPlace?.lat != null && selectedPlace?.lng != null)
                navigator.clipboard?.writeText(`${selectedPlace.lat.toFixed(6)}, ${selectedPlace.lng.toFixed(6)}`);
            }}
          >
            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            <span class="text-[11px] font-medium">Copy</span>
          </button>
        {/if}
        <button
          class="flex flex-col items-center gap-1 flex-1 py-2.5 rounded-xl bg-[#f3e8ff] text-[#6b21a8] touch-manipulation"
          onclick={() => sharePlace(selectedPlace!)}
        >
          {#if shareCopied}
            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12" /></svg>
            <span class="text-[11px] font-medium">Copied!</span>
          {:else}
            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
            <span class="text-[11px] font-medium">Share</span>
          {/if}
        </button>
        {#if mapillaryToken && selectedPlace.lat != null && selectedPlace.lng != null}
          <button
            class="flex flex-col items-center gap-1 flex-1 py-2.5 rounded-xl bg-[#e6f9ef] text-[#065f46] touch-manipulation"
            onclick={() => { closePlaceCard(); void openStreetViewAt(selectedPlace!.lat!, selectedPlace!.lng!); }}
          >
            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
            </svg>
            <span class="text-[11px] font-medium">Street</span>
          </button>
        {/if}
      </div>
      <!-- Info -->
      <div class="px-4 pb-3">
        {#if selectedPlace.subtitle}
          <div class="flex items-start gap-3 py-2.5 border-t border-[#f0f0f0]">
            <span class="text-[14px] text-[#aaa] mt-0.5 flex-shrink-0">ℹ️</span>
            <p class="text-[12px] text-[#555] leading-relaxed flex-1">{selectedPlace.subtitle}</p>
          </div>
        {/if}
        {#if selectedPlace.lat != null && selectedPlace.lng != null}
          <div class="flex items-center gap-3 py-2.5 border-t border-[#f0f0f0]">
            <svg class="w-4 h-4 text-[#aaa] flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" />
            </svg>
            <span class="font-mono text-[11px] text-[#777]">{selectedPlace.lat.toFixed(6)}, {selectedPlace.lng.toFixed(6)}</span>
          </div>
        {/if}
        {#if selectedPlace.source === 'entity_graph' && (entityNeighborsLoading || entityNeighbors.length > 0)}
          <div class="border-t border-[#f0f0f0] pt-2.5">
            <div class="text-[10px] text-[#aaa] uppercase tracking-wider mb-1.5">関連ノード</div>
            {#if entityNeighborsLoading}
              <div class="text-[11px] text-[#bbb]">読み込み中…</div>
            {:else}
              {#each entityNeighbors.slice(0, 6) as edge}
                <div class="flex items-center gap-2 py-1.5">
                  <span class="text-[13px] flex-shrink-0">{neighborIcon(edge)}</span>
                  <div class="flex-1 min-w-0">
                    <span class="text-[10px] text-[#aaa]">{edge.predicate.replace(/.*[:#/]/, '')} · </span>
                    <span class="text-[12px] text-[#444]">{edge.objectLabel || edge.objectLiteral || edge.objectId || ''}</span>
                  </div>
                </div>
              {/each}
            {/if}
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- Mapillary Coverage Toggle Button -->
  <button
    class="absolute bottom-5 left-[60px] z-10 w-9 h-9 rounded-lg flex items-center justify-center backdrop-blur-sm border transition-all touch-manipulation {!mapillaryToken ? 'opacity-40 cursor-not-allowed bg-[rgba(26,26,26,0.7)] border-white/[0.1] text-[#888]' : showMapillaryCoverage ? 'bg-[#05CB63] border-[#05CB63] text-white shadow-[0_2px_8px_rgba(5,203,99,0.4)]' : 'bg-[rgba(26,26,26,0.7)] border-white/[0.1] text-[#888] hover:text-white hover:bg-[rgba(26,26,26,0.85)]'}"
    onclick={() => { if (mapillaryToken) toggleMapillaryCoverage(); }}
    title={!mapillaryToken ? 'Mapillary token 未設定' : showMapillaryCoverage ? 'Mapillary カバレッジを非表示' : 'Mapillary ストリートビュー'}
  >
    <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
    </svg>
  </button>

  {#if scaleBarLabel}
    <div class="absolute bottom-[58px] left-5 z-10 rounded-xl bg-[rgba(26,26,26,0.76)] backdrop-blur-md border border-white/[0.1] px-3 py-2 text-white shadow-[0_4px_12px_rgba(0,0,0,0.24)]">
      <div class="text-[0.64rem] leading-none text-[#b6bdc6] mb-1">Scale</div>
      <div class="flex flex-col gap-1">
        <span class="text-[0.82rem] font-medium leading-none">{scaleBarLabel}</span>
        <div class="relative h-2">
          <div
            class="absolute bottom-0 left-0 h-[2px] bg-white"
            style={`width:${scaleBarWidthPx}px`}
          ></div>
          <div class="absolute bottom-0 left-0 w-[2px] h-2 bg-white"></div>
          <div
            class="absolute bottom-0 w-[2px] h-2 bg-white"
            style={`left:${Math.max(0, scaleBarWidthPx - 2)}px`}
          ></div>
        </div>
      </div>
    </div>
  {/if}

  <!-- Mapillary Viewer Overlay — Desktop: right half, Mobile: bottom half -->
  {#if showMapillaryViewer}
    <div class="absolute top-0 right-0 bottom-0 w-[50%] z-20 bg-black max-[600px]:top-auto max-[600px]:left-0 max-[600px]:w-full max-[600px]:h-[50dvh]">
      <button
        class="absolute top-3 right-3 z-30 w-9 h-9 rounded-full flex items-center justify-center bg-black/50 text-white hover:bg-black/70 transition-colors touch-manipulation"
        onclick={closeMapillaryViewer}
        aria-label="Close street view"
      >
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
      <div class="absolute top-3 left-3 z-30 flex items-center gap-2">
        <div class="bg-black/50 rounded-lg px-3 py-1.5 flex items-center gap-2">
          <div class="w-3 h-3 rounded-full bg-[#05CB63] flex-shrink-0"></div>
          <span class="text-white text-[12px] font-medium">Mapillary</span>
          {#if mapillaryViewerLat != null && mapillaryViewerLng != null}
            <span class="text-white/60 text-[11px] font-mono">{mapillaryViewerLat.toFixed(5)}, {mapillaryViewerLng.toFixed(5)}</span>
          {/if}
        </div>
        {#if mapillaryViewerLat != null && mapillaryViewerLng != null}
          <button
            class="bg-black/50 rounded-lg px-3 py-1.5 text-[#05CB63] text-[11px] font-medium hover:bg-black/70 transition-colors touch-manipulation flex items-center gap-1.5"
            onclick={() => {
              if (mapillaryViewerLat != null && mapillaryViewerLng != null) {
                const label = `${mapillaryViewerLat.toFixed(5)}, ${mapillaryViewerLng.toFixed(5)}`;
                searchQuery = label;
                map?.flyTo({ center: [mapillaryViewerLng, mapillaryViewerLat], zoom: Math.max(map.getZoom(), 17), duration: 600 });
              }
            }}
            title="この場所を地図の中心にする"
          >
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            ここを検索
          </button>
        {/if}
      </div>
      <div bind:this={mapillaryViewerContainer} class="w-full h-full"></div>
    </div>
  {/if}
  <!-- Street View not found toast -->
  {#if mapillaryStreetViewError}
    <div class="absolute bottom-20 left-1/2 -translate-x-1/2 z-30 bg-[#1a1a1a] text-white text-[13px] px-4 py-2.5 rounded-xl shadow-lg pointer-events-none">
      {mapillaryStreetViewError}
    </div>
  {/if}

  <!-- Dev Tools Toggle Button -->
  <button
    class="absolute bottom-5 left-5 z-10 w-9 h-9 rounded-lg flex items-center justify-center bg-[rgba(26,26,26,0.7)] backdrop-blur-sm border border-white/[0.1] text-[#888] hover:text-white hover:bg-[rgba(26,26,26,0.85)] transition-all touch-manipulation {showDevTools ? 'hidden' : ''}"
    onclick={() => { showDevTools = true; }}
    title="Developer tools"
  >
    <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M16 18l6-6-6-6M8 6l-6 6 6 6" />
    </svg>
  </button>

  <!-- Dev Tools Panel (hidden by default) -->
  {#if showDevTools}
  <div class="absolute bottom-5 left-5 w-[260px] bg-[rgba(26,26,26,0.88)] backdrop-blur-xl border border-white/[0.08] rounded-xl p-[14px] text-white z-10 max-h-[70dvh] overflow-y-auto max-[600px]:bottom-auto max-[600px]:top-[60px] max-[600px]:left-[10px] max-[600px]:right-[10px] max-[600px]:w-auto max-[600px]:p-2">
    <!-- Header with close -->
    <div class="flex items-center justify-between mb-2">
      <span class="text-[10px] font-bold tracking-widest uppercase text-[#888]">Dev Tools</span>
      <button
        class="w-7 h-7 rounded-full flex items-center justify-center text-[#888] hover:text-white hover:bg-white/[0.1] transition-colors touch-manipulation"
        onclick={() => { showDevTools = false; }}
        aria-label="Close dev tools"
      >
        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
    </div>

    <!-- Spatial Stats -->
    <div class="flex flex-col gap-2">
      <div>
        <span class="block text-[0.6rem] text-[#888] uppercase mb-px">LAT/LNG</span>
        <span class="block text-[0.78rem] font-mono">{lat.toFixed(6)}, {lng.toFixed(6)}</span>
      </div>
      <div>
        <span class="block text-[0.6rem] text-[#888] uppercase mb-px">H3 (Res {h3Resolution})</span>
        <span class="block text-[0.78rem] font-mono">{h3ID || '---'}</span>
      </div>
      <div>
        <span class="block text-[0.6rem] text-[#888] uppercase mb-px">S2 (Level 12)</span>
        <span class="block text-[0.78rem] font-mono">{s2ID || '---'}</span>
      </div>
      <div>
        <span class="block text-[0.6rem] text-[#888] uppercase mb-px">MGRS</span>
        <span class="block text-[0.78rem] font-mono">{mgrs || '---'}</span>
      </div>
      <div>
        <span class="block text-[0.6rem] text-[#888] uppercase mb-px">ZOOM</span>
        <span class="block text-[0.78rem]">{zoom.toFixed(1)}</span>
      </div>
    </div>

    <!-- Crawler Realtime -->
    <div class="mt-3 pt-[10px] border-t border-white/10 flex flex-col gap-2">
      <div>
        <span class="block text-[0.6rem] text-[#888] uppercase mb-px">Crawler pages</span>
        <span class="block text-[0.78rem]">
          {#if crawlerLoading}
            更新中...
          {:else}
            {crawlerResultCount}件
          {/if}
          {#if crawlerLastUpdated}
            <span class="block text-[#9aa0a6] text-[0.68rem] mt-0.5">({crawlerPointUpdatedText()})</span>
          {/if}
        </span>
      </div>
      <div>
        <span class="block text-[0.6rem] text-[#888] uppercase mb-px">Job/Result pull</span>
        <span class="block text-[0.78rem]">
          job {crawlerQueriedJobs}/{crawlerJobCount} / result {crawlerQueriedResults}/{crawlerResultCount}
        </span>
      </div>
      {#if crawlerRequestedStatuses.length > 0}
        <div>
          <span class="block text-[0.6rem] text-[#888] uppercase mb-px">Watching</span>
          <span class="block text-[#9aa0a6] text-[0.68rem] mt-0.5">{crawlerRequestedStatuses.join(' / ')}</span>
        </div>
      {/if}
      {#if crawlerActivePoint}
        <div class="border border-[rgba(0,247,160,0.35)] rounded-[10px] px-[10px] py-2 bg-[rgba(0,247,160,0.08)]">
          <span class="block text-[0.76rem] font-semibold mb-1 leading-[1.3] text-white">{crawlerActivePoint.title}</span>
          <span class="block text-[0.66rem] text-[#c2e9e1] leading-[1.4] break-words">
            {crawlerActivePoint.host} / {crawlerActivePoint.ip || 'ip unknown'} / {formatCrawlerServerLine(crawlerActivePoint)}
          </span>
          <span class="block text-[0.66rem] text-[#c2e9e1] leading-[1.4] break-words">{formatCrawlerRelativeAt(crawlerActivePoint.crawledAt)}</span>
        </div>
      {/if}
      {#if !crawlerInitialized && crawlerLoading}
        <div class="border border-dashed border-white/20 rounded-lg text-[#9aa0a6] text-[0.72rem] p-[10px] text-center flex flex-col gap-1.5 items-center">
          読み込み中...
        </div>
      {:else if crawlerError && crawlerPoints.length === 0}
        <div class="border border-dashed border-white/20 rounded-lg text-[#9aa0a6] text-[0.72rem] p-[10px] text-center flex flex-col gap-1.5 items-center">
          <span class="text-[#ffb4b4] text-[0.7rem]">エラー: {crawlerError}</span>
          <button
            class="bg-white/[0.08] border border-white/20 rounded-md text-[#ccc] text-[0.68rem] px-[10px] py-1 cursor-pointer min-h-[28px] touch-manipulation hover:bg-white/[0.15]"
            onclick={() => { void pollCrawlerLocations(); }}
          >再試行</button>
        </div>
      {:else if crawlerInitialized && crawlerPoints.length === 0}
        <div class="border border-dashed border-white/20 rounded-lg text-[#9aa0a6] text-[0.72rem] p-[10px] text-center flex flex-col gap-1.5 items-center">
          クローラジョブがありません
          <a
            href="https://crawler.etzhayyim.com"
            target="_blank"
            rel="noopener noreferrer"
            class="text-[#33b8ff] text-[0.68rem] no-underline hover:underline"
          >crawler.etzhayyim.com を開く</a>
        </div>
      {:else}
        <div class="mt-1 flex flex-col gap-1.5 max-h-[240px] overflow-auto pr-1">
          {#each crawlerPoints.slice(0, crawlerPanelLimit) as point (point.resultId)}
            <button
              class="text-left border rounded-lg px-[10px] py-2 min-h-[44px] flex flex-col gap-1 w-full cursor-pointer transition-colors duration-150 touch-manipulation {point.resultId === crawlerActivePoint?.resultId ? 'border-[rgba(0,247,160,0.7)] bg-[rgba(0,247,160,0.12)] text-[#e7eff1]' : 'border-white/[0.14] bg-white/[0.06] text-[#e7eff1] hover:bg-white/[0.12]'}"
              onclick={() => {
                crawlerActivePoint = point;
                if (!map || !hasLocation(point)) return;
                map.flyTo({ center: [point.longitude, point.latitude], zoom: 14, duration: 900 });
              }}
            >
              <span class="block text-[0.74rem] leading-[1.35] break-words">{point.title}</span>
              <span class="block text-[0.63rem] text-[#9aa0a6] break-words">
                {point.crawledAt ? formatCrawlerRelativeAt(point.crawledAt) : ''} / {point.jobId} / {point.httpStatus}
              </span>
              <span class="block text-[0.63rem] text-[#9aa0a6] break-words">
                {point.ip || 'ip unknown'}
                {#if hasLocation(point)} / {formatCrawlerServerLine(point)}{/if}
              </span>
            </button>
          {/each}
        </div>
        {#if crawlerPoints.length > crawlerPanelLimit}
          <span class="block text-[#9aa0a6] text-[0.68rem] mt-0.5">直近の{crawlerPoints.length - crawlerPanelLimit}件を省略</span>
        {/if}
      {/if}
    </div>

    <!-- Layer Controls -->
    <div class="mt-3 pt-[10px] border-t border-white/[0.08] flex flex-col gap-2">
      <label class="flex items-center gap-2 text-[0.78rem] cursor-pointer text-[#ccc]">
        <input
          type="checkbox"
          bind:checked={showMapillaryCoverage}
          onchange={toggleMapillaryCoverage}
          class="appearance-none w-[15px] h-[15px] border border-[#555] rounded-sm bg-transparent cursor-pointer relative flex-shrink-0 checked:bg-[#05CB63] checked:border-[#05CB63] [&:checked::after]:content-[''] [&:checked::after]:absolute [&:checked::after]:left-1 [&:checked::after]:top-px [&:checked::after]:w-1 [&:checked::after]:h-2 [&:checked::after]:border-[#1a1a1a] [&:checked::after]:border-r-2 [&:checked::after]:border-b-2 [&:checked::after]:rotate-45"
        />
        <span>Mapillary {mapillaryToken ? '' : '(token未設定)'}</span>
      </label>
      <label class="flex items-center gap-2 text-[0.78rem] cursor-pointer text-[#ccc]">
        <input
          type="checkbox"
          bind:checked={showH3Grid}
          onchange={onH3ToggleChange}
          class="appearance-none w-[15px] h-[15px] border border-[#555] rounded-sm bg-transparent cursor-pointer relative flex-shrink-0 checked:bg-[#00ffcc] checked:border-[#00ffcc] [&:checked::after]:content-[''] [&:checked::after]:absolute [&:checked::after]:left-1 [&:checked::after]:top-px [&:checked::after]:w-1 [&:checked::after]:h-2 [&:checked::after]:border-[#1a1a1a] [&:checked::after]:border-r-2 [&:checked::after]:border-b-2 [&:checked::after]:rotate-45"
        />
        <span>H3 Grid</span>
      </label>
      {#if showH3Grid}
        <div class="flex items-center gap-2">
          <span class="text-[0.65rem] text-[#888] uppercase flex-shrink-0 w-6">Res</span>
          <input
            type="range"
            min="1"
            max="12"
            bind:value={h3Resolution}
            oninput={onH3ResolutionInput}
            class="flex-1 h-[3px] appearance-none bg-[#444] rounded-sm outline-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[#00ffcc] [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-[#00ffcc] [&::-moz-range-thumb]:border-none [&::-moz-range-thumb]:cursor-pointer"
          />
          <span class="text-[0.78rem] font-mono text-[#00ffcc] w-5 text-right flex-shrink-0">{h3Resolution}</span>
        </div>
      {/if}
      <label class="flex items-center gap-2 text-[0.78rem] cursor-pointer text-[#ccc]">
        <input
          type="checkbox"
          bind:checked={showActorLocations}
          class="appearance-none w-[15px] h-[15px] border border-[#555] rounded-sm bg-transparent cursor-pointer relative flex-shrink-0 checked:bg-[#60a5fa] checked:border-[#60a5fa] [&:checked::after]:content-[''] [&:checked::after]:absolute [&:checked::after]:left-1 [&:checked::after]:top-px [&:checked::after]:w-1 [&:checked::after]:h-2 [&:checked::after]:border-[#1a1a1a] [&:checked::after]:border-r-2 [&:checked::after]:border-b-2 [&:checked::after]:rotate-45"
        />
        <span>
          Actor Locations
          {#if actorLoading}...{:else}({actorPoints.length}){/if}
          {#if actorError}
            <span class="text-[#ef4444]">!</span>
          {/if}
        </span>
      </label>
      <label class="flex items-center gap-2 text-[0.78rem] cursor-pointer text-[#ccc]">
        <input
          type="checkbox"
          bind:checked={showWeatherLayer}
          onchange={toggleWeatherLayer}
          class="appearance-none w-[15px] h-[15px] border border-[#555] rounded-sm bg-transparent cursor-pointer relative flex-shrink-0 checked:bg-[#60a5fa] checked:border-[#60a5fa] [&:checked::after]:content-[''] [&:checked::after]:absolute [&:checked::after]:left-1 [&:checked::after]:top-px [&:checked::after]:w-1 [&:checked::after]:h-2 [&:checked::after]:border-[#1a1a1a] [&:checked::after]:border-r-2 [&:checked::after]:border-b-2 [&:checked::after]:rotate-45"
        />
        <span>Weather {weatherLoading ? '...' : ''}</span>
      </label>
      {#if showWeatherLayer && weatherFeatures.length > 0}
        <div class="text-[0.65rem] text-[#888] pl-[23px] -mt-1">
          <span class="inline-block w-2 h-2 rounded-full bg-[#4ade80] mr-1"></span>&lt;10
          <span class="inline-block w-2 h-2 rounded-full bg-[#fbbf24] mx-1"></span>10-20
          <span class="inline-block w-2 h-2 rounded-full bg-[#ef4444] mx-1"></span>&gt;20 m/s
          {#if weatherError}
            <span class="block text-[#ef4444] mt-0.5">{weatherError}</span>
          {/if}
        </div>
      {/if}
    </div>

    {#if hoveredH3}
      <div class="mt-[10px] pt-[10px] border-t border-white/[0.08]">
        <span class="block text-[0.6rem] text-[#888] uppercase mb-px">HOVER</span>
        <span class="block text-[0.78rem] font-mono">{hoveredH3}</span>
      </div>
    {/if}
    {#if mapError}
      <div class="mt-[10px] pt-[10px] border-t border-white/[0.08]">
        <span class="block text-[0.6rem] text-[#888] uppercase mb-px">MAP STATUS</span>
        <span class="block text-[0.78rem] font-mono">{mapError}</span>
      </div>
    {/if}
  </div>
  {/if}

  <!-- aismarine vessel detail panel (ADR-2605011500) -->
  {#if vesselDetail || vesselDetailLoading}
    <div class="absolute top-4 right-4 w-[320px] max-h-[60vh] overflow-y-auto bg-black/85 text-white rounded-md p-3 text-xs font-mono z-[60] backdrop-blur">
      <div class="flex items-center justify-between mb-2">
        <span class="text-[0.65rem] text-[#888] uppercase tracking-wide">vessel</span>
        <button
          class="text-[#aaa] hover:text-white text-sm leading-none px-1"
          onclick={() => { vesselDetail = null; vesselDetailLoading = false; aismarineCtlRef?.clearSelection?.(); aismarineCtlRef?.clearTrack?.(); }}
          aria-label="close vessel detail"
        >×</button>
      </div>
      {#if vesselDetailLoading}
        <div class="text-[#888]">loading…</div>
      {:else if vesselDetail?.vessel}
        <div class="text-base font-semibold mb-1">
          {vesselDetail.vessel.name ?? `MMSI ${vesselDetail.vessel.mmsi}`}
        </div>
        <div class="text-[0.7rem] text-[#aaa] mb-2 capitalize">
          {vesselDetail.vessel.type_class}
          {#if vesselDetail.vessel.flag_iso}· {vesselDetail.vessel.flag_iso}{/if}
        </div>
        <dl class="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
          <dt class="text-[#888]">MMSI</dt><dd>{vesselDetail.vessel.mmsi}</dd>
          {#if vesselDetail.vessel.imo}<dt class="text-[#888]">IMO</dt><dd>{vesselDetail.vessel.imo}</dd>{/if}
          {#if vesselDetail.vessel.callsign}<dt class="text-[#888]">callsign</dt><dd>{vesselDetail.vessel.callsign}</dd>{/if}
          {#if vesselDetail.vessel.type_code != null}<dt class="text-[#888]">type</dt><dd>{vesselDetail.vessel.type_code}</dd>{/if}
          {#if vesselDetail.vessel.length_m}<dt class="text-[#888]">L × W</dt><dd>{vesselDetail.vessel.length_m}m × {vesselDetail.vessel.width_m ?? '?'}m</dd>{/if}
          {#if vesselDetail.vessel.draught_m}<dt class="text-[#888]">draught</dt><dd>{vesselDetail.vessel.draught_m}m</dd>{/if}
          <dt class="text-[#888]">last seen</dt>
          <dd>{new Date(vesselDetail.vessel.last_seen_ms).toISOString().replace('T', ' ').slice(0, 19)}Z</dd>
        </dl>
        {#if vesselDetail.voyage}
          <div class="mt-3 pt-2 border-t border-white/10">
            <span class="text-[0.6rem] text-[#888] uppercase">voyage</span>
            <div class="mt-1">
              {vesselDetail.voyage.departure_port_locode ?? '?'} → {vesselDetail.voyage.arrival_port_locode ?? '(en route)'}
            </div>
            {#if vesselDetail.voyage.declared_destination}
              <div class="text-[#aaa]">→ {vesselDetail.voyage.declared_destination}</div>
            {/if}
          </div>
        {/if}
        {#if vesselDetail.owners && vesselDetail.owners.length > 0}
          <div class="mt-3 pt-2 border-t border-white/10">
            <span class="text-[0.6rem] text-[#888] uppercase">owner</span>
            {#each vesselDetail.owners as o}
              <div class="mt-1">
                <span class="text-white">{o.name ?? o.lei}</span>
                {#if o.country}<span class="text-[#aaa]"> ({o.country})</span>{/if}
              </div>
              <div class="text-[0.65rem] text-[#888]">
                {#if o.lei}LEI: <code class="text-[#aaa]">{o.lei}</code>{/if}
                {#if o.wikidata_qid}{#if o.lei} · {/if}WD: <a href="https://www.wikidata.org/wiki/{o.wikidata_qid}" target="_blank" class="text-[#aaa] underline">{o.wikidata_qid}</a>{/if}
                {#if o.share_pct != null} · {o.share_pct}%{/if}
                · src: {o.source}
              </div>
            {/each}
          </div>
        {/if}
        {#if vesselDetail.operators && vesselDetail.operators.length > 0}
          <div class="mt-3 pt-2 border-t border-white/10">
            <span class="text-[0.6rem] text-[#888] uppercase">operator</span>
            {#each vesselDetail.operators as o}
              <div class="mt-1">
                <span class="text-white">{o.name ?? o.lei}</span>
                {#if o.country}<span class="text-[#aaa]"> ({o.country})</span>{/if}
                {#if o.role}<span class="text-[#aaa]"> · {o.role}</span>{/if}
              </div>
              <div class="text-[0.65rem] text-[#888]">
                {#if o.lei}LEI: <code class="text-[#aaa]">{o.lei}</code>{/if}
                {#if o.wikidata_qid}{#if o.lei} · {/if}WD: <a href="https://www.wikidata.org/wiki/{o.wikidata_qid}" target="_blank" class="text-[#aaa] underline">{o.wikidata_qid}</a>{/if}
                · src: {o.source}
              </div>
            {/each}
          </div>
        {/if}
        <div class="mt-3 pt-2 border-t border-white/10 text-[#888]">
          {vesselDetail.recentTrack.length} track points (last 24h)
        </div>
      {:else}
        <div class="text-[#888]">no data</div>
      {/if}
    </div>
  {/if}
</div>
