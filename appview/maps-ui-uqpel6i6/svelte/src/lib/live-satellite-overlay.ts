/**
 * Live satellite overlay (N2YO-equivalent, 2026-05-05).
 *
 * Polls `com.etzhayyim.apps.maps.listLiveSatellites` every 30 s for currently-
 * overhead passes (AOS..LOS straddles wallclock now). Renders each pass's
 * observer cell as a marker scaled by max elevation. Click handler forwards
 * to host for NORAD ID + name detail panel.
 *
 * Phase 2.2 (2026-05-05): server returns real H3 res-5 cell IDs in
 * `observerH3`. We resolve them via h3-js cellToLatLng. Legacy name slugs
 * (e.g. "tokyo_bay") are still recognized via the OBSERVER_LATLON fallback
 * so older rows in vertex_satellite_pass keep rendering until they age out.
 */
import { cellToLatLng } from 'h3-js';
import { listLiveSatellites, type LiveSatellite } from './api';
import type { KamiMapBridge } from './kami-bridge';

const POLL_INTERVAL_MS = 30_000;
const MAX_PER_FETCH = 500;
const SOURCE_ID = 'live-satellite';
const LAYER_ID = 'live-satellite-layer';

export type SatelliteClickHandler = (s: LiveSatellite) => void;

const EMPTY_FC = { type: 'FeatureCollection' as const, features: [] };

// Bootstrap observer name → (lat, lon). Mirror of kotodama
// satellite_live._BOOTSTRAP_OBSERVERS. When promoted to real H3 res-5,
// both ends switch in lockstep.
const OBSERVER_LATLON: Record<string, [number, number]> = {
  // Japan bays
  tokyo_bay: [35.50, 139.72],
  osaka_bay: [34.67, 135.25],
  ise_bay: [35.02, 136.87],
  hakata_bay: [33.62, 130.37],
  sendai_bay: [38.25, 141.07],
  naha_okinawa: [26.22, 127.75],
  sapporo_ishikari: [43.22, 141.37],
  niigata_port: [37.95, 139.15],
  hiroshima_bay: [34.35, 132.47],
  sendai_shiogama: [38.35, 141.10],
  kagoshima_bay: [31.60, 130.67],
  niihama_seto: [33.97, 133.35],
  // Global megacities + ports (Phase 2)
  new_york: [40.71, -74.01],
  los_angeles: [34.05, -118.24],
  chicago: [41.88, -87.63],
  houston: [29.76, -95.37],
  san_francisco: [37.77, -122.42],
  miami: [25.76, -80.19],
  toronto: [43.65, -79.38],
  mexico_city: [19.43, -99.13],
  sao_paulo: [-23.55, -46.63],
  rio_de_janeiro: [-22.91, -43.17],
  buenos_aires: [-34.61, -58.38],
  lima: [-12.05, -77.04],
  bogota: [4.71, -74.07],
  london: [51.51, -0.13],
  paris: [48.86, 2.35],
  madrid: [40.42, -3.70],
  berlin: [52.52, 13.40],
  rome: [41.90, 12.50],
  moscow: [55.76, 37.62],
  istanbul: [41.01, 28.98],
  cairo: [30.04, 31.24],
  lagos: [6.52, 3.38],
  johannesburg: [-26.20, 28.05],
  nairobi: [-1.29, 36.82],
  dubai: [25.20, 55.27],
  riyadh: [24.71, 46.68],
  tehran: [35.69, 51.39],
  karachi: [24.86, 67.01],
  mumbai: [19.08, 72.88],
  delhi: [28.61, 77.21],
  bangalore: [12.97, 77.59],
  dhaka: [23.81, 90.41],
  bangkok: [13.76, 100.50],
  singapore: [1.35, 103.82],
  jakarta: [-6.21, 106.85],
  manila: [14.60, 120.98],
  ho_chi_minh: [10.82, 106.63],
  kuala_lumpur: [3.14, 101.69],
  hong_kong: [22.32, 114.17],
  shanghai: [31.23, 121.47],
  beijing: [39.90, 116.41],
  shenzhen: [22.54, 114.06],
  guangzhou: [23.13, 113.26],
  seoul: [37.57, 126.98],
  taipei: [25.03, 121.57],
  sydney: [-33.87, 151.21],
  melbourne: [-37.81, 144.96],
  auckland: [-36.85, 174.76],
  honolulu: [21.31, -157.86],
  anchorage: [61.22, -149.90],
  reykjavik: [64.15, -21.94],
  stockholm: [59.33, 18.07],
  helsinki: [60.17, 24.94],
};

export function applyLiveSatelliteOverlay(
  map: KamiMapBridge,
  opts: { onSatelliteClick?: SatelliteClickHandler } = {},
): () => void {
  map.addSource(SOURCE_ID, { type: 'geojson', data: EMPTY_FC } as never);
  map.addLayer({
    id: LAYER_ID,
    type: 'circle',
    source: SOURCE_ID,
    minzoom: 2,
    paint: {
      // Phase 2.3: ONE marker per observer cell (was: one per pass, which
      // stacked thousands of opaque circles at the same lat/lon and made
      // the overlay look like a giant blob covering half the globe).
      'circle-color': '#ec4899',
      'circle-radius': [
        // Size scales with passCount (number of currently-overhead sats
        // for this cell): more sats = bigger marker. Capped to 10px so
        // dense observers don't dominate the basemap.
        'interpolate', ['linear'],
        ['coalesce', ['get', 'passCount'], 1],
        1, 4,
        10, 6,
        50, 8,
        200, 10,
      ],
      'circle-stroke-width': 1.5,
      'circle-stroke-color': '#831843',
      'circle-opacity': 0.6,
    },
  } as never);

  if (opts.onSatelliteClick) {
    const click = (map as unknown as {
      on?: (event: string, layerId: string, handler: (e: { features?: Array<{ properties?: unknown }> }) => void) => void;
    }).on;
    if (typeof click === 'function') {
      click.call(map, 'click', LAYER_ID, (e) => {
        const feat = e.features?.[0];
        if (feat && feat.properties) {
          opts.onSatelliteClick!(feat.properties as LiveSatellite);
        }
      });
    }
  }

  let pending = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const refresh = async () => {
    if (pending || stopped) return;
    pending = true;
    try {
      const res = await listLiveSatellites({ limit: MAX_PER_FETCH });
      // Phase 2.3 (2026-05-05): aggregate per observer cell. Without this,
      // each currently-overhead pass creates its own Point feature at the
      // SAME lat/lon (the observer cell), and 1000+ stacked circles with
      // circle-opacity: 0.75 produce an opaque blob covering a huge area
      // of the globe. Grouping by `observerH3` and rendering ONE marker
      // per cell + a count badge collapses the cardinality from passes
      // → cells (~tens at most). Pick max-elevation pass for marker size.
      type CellAgg = {
        observerH3: string;
        lat: number;
        lon: number;
        passCount: number;
        maxElevationDeg: number;
        nightVisibleCount: number;
        topNoradId?: number;
      };
      const cellByKey: Record<string, CellAgg> = {};
      for (const s of res.satellites) {
        if (!s.observerH3) continue;
        // Resolve observer lat/lon: real H3 res-5 cell ID first, slug fallback.
        let lat: number | undefined;
        let lon: number | undefined;
        try {
          const [la, lo] = cellToLatLng(s.observerH3);
          if (Number.isFinite(la) && Number.isFinite(lo)) {
            lat = la;
            lon = lo;
          }
        } catch {
          // Fall through.
        }
        if (lat === undefined || lon === undefined) {
          const ll = OBSERVER_LATLON[s.observerH3];
          if (!ll) continue;
          lat = ll[0];
          lon = ll[1];
        }
        const agg = cellByKey[s.observerH3] ?? {
          observerH3: s.observerH3,
          lat,
          lon,
          passCount: 0,
          maxElevationDeg: 0,
          nightVisibleCount: 0,
        };
        agg.passCount += 1;
        if (s.maxElevationDeg && s.maxElevationDeg > agg.maxElevationDeg) {
          agg.maxElevationDeg = s.maxElevationDeg;
          agg.topNoradId = s.noradId;
        }
        if (s.visibleAtNight) agg.nightVisibleCount += 1;
        cellByKey[s.observerH3] = agg;
      }
      const features = Object.values(cellByKey)
        .map((c) => {
          return {
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [c.lon, c.lat] },
            properties: c,
          };
        })
        .filter((f): f is NonNullable<typeof f> => f !== null);
      const fc = { type: 'FeatureCollection' as const, features };
      const src = map.getSource(SOURCE_ID);
      if (src && typeof src.setData === 'function') src.setData(fc as never);
    } catch {
      // transient XRPC error; retry next tick
    } finally {
      pending = false;
      if (!stopped) timer = setTimeout(refresh, POLL_INTERVAL_MS);
    }
  };

  void refresh();

  return () => {
    stopped = true;
    if (timer != null) clearTimeout(timer);
    try { map.removeLayer(LAYER_ID); } catch {}
    try { (map as unknown as { removeSource?: (id: string) => void }).removeSource?.(SOURCE_ID); } catch {}
  };
}
