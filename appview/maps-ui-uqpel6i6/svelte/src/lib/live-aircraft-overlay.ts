/**
 * Live aircraft overlay (Flightradar24-equivalent, 2026-05-05).
 *
 * Polls `com.etzhayyim.apps.maps.listLiveAircraft` every 10 s for aircraft within
 * the current viewport bbox. Renders as KAMI circle features colored by
 * source (opensky/adsb-fi). Click handler forwards to host for callsign
 * + altitude detail panel.
 *
 * Data freshness: BPMN R/PT10S timer drives `flight.live.poll`, so the
 * server-side window is at most ~10 s old. Client polls match cadence.
 */
import { listLiveAircraft, type LiveAircraft } from './api';
import type { KamiMapBridge } from './kami-bridge';

const POLL_INTERVAL_MS = 10_000;
const MAX_AIRCRAFT_PER_FETCH = 1500;
const MAX_AGE_SEC = 120;
const SOURCE_ID = 'live-aircraft';
const LAYER_ID = 'live-aircraft-layer';

const SOURCE_COLOR: Record<string, string> = {
  opensky: '#10b981',
  'adsb-fi': '#3b82f6',
  unknown: '#9ca3af',
};

export type AircraftClickHandler = (a: LiveAircraft) => void;

const EMPTY_FC = { type: 'FeatureCollection' as const, features: [] };

export function applyLiveAircraftOverlay(
  map: KamiMapBridge,
  opts: { onAircraftClick?: AircraftClickHandler } = {},
): () => void {
  map.addSource(SOURCE_ID, { type: 'geojson', data: EMPTY_FC } as never);
  map.addLayer({
    id: LAYER_ID,
    type: 'circle',
    source: SOURCE_ID,
    minzoom: 3,
    paint: {
      'circle-color': [
        'match', ['get', 'source'],
        'opensky', SOURCE_COLOR.opensky,
        'adsb-fi', SOURCE_COLOR['adsb-fi'],
        SOURCE_COLOR.unknown,
      ],
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        3, 1.5,
        6, 2.5,
        10, 4,
        14, 6,
      ],
      'circle-stroke-width': 0.5,
      'circle-stroke-color': '#0f172a',
      'circle-opacity': 0.85,
    },
  } as never);

  if (opts.onAircraftClick) {
    const click = (map as unknown as {
      on?: (event: string, layerId: string, handler: (e: { features?: Array<{ properties?: unknown }> }) => void) => void;
    }).on;
    if (typeof click === 'function') {
      click.call(map, 'click', LAYER_ID, (e) => {
        const feat = e.features?.[0];
        if (feat && feat.properties) {
          opts.onAircraftClick!(feat.properties as LiveAircraft);
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
      const bounds = map.getBounds();
      const sw = bounds.getSouthWest();
      const ne = bounds.getNorthEast();
      const res = await listLiveAircraft({
        minLat: sw.lat,
        maxLat: ne.lat,
        minLon: sw.lng,
        maxLon: ne.lng,
        maxAgeSec: MAX_AGE_SEC,
        limit: MAX_AIRCRAFT_PER_FETCH,
      });
      const features = res.aircraft.map((a) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [a.lon, a.lat] },
        properties: a,
      }));
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

  const onMoveend = (map as unknown as {
    on?: (event: string, handler: () => void) => void;
  }).on;
  if (typeof onMoveend === 'function') {
    onMoveend.call(map, 'moveend', refresh);
  }

  void refresh();

  return () => {
    stopped = true;
    if (timer != null) clearTimeout(timer);
    try { map.removeLayer(LAYER_ID); } catch {}
    try { (map as unknown as { removeSource?: (id: string) => void }).removeSource?.(SOURCE_ID); } catch {}
  };
}

export { SOURCE_COLOR as AIRCRAFT_SOURCE_COLOR };
