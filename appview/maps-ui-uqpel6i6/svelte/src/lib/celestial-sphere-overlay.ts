/**
 * Celestial sphere background overlay (NASA HYG + OpenNGC, 2026-05-06).
 *
 * Fetches naked-eye stars + deep-sky objects from
 * `com.etzhayyim.apps.maps.listCelestialObjects` and paints them on a fixed
 * absolutely-positioned <canvas> behind the KAMI map canvas. Each object
 * is positioned by inverse stereographic projection of its (RA, Dec).
 *
 * Designed for Globe view (zoom < 3 in KAMI mode). At higher zoom the
 * camera is tilted enough that the celestial sphere isn't really visible
 * anyway, so the overlay just runs continuously and the canvas is layered
 * behind the WebGPU surface.
 *
 * Star size + alpha derived from `renderPriority` (HYG: brighter = higher;
 * NGC: brighter V mag = higher).
 *
 * Spectral class color map (rough O-B-A-F-G-K-M):
 *   O: blue-white   B: blue-white   A: white   F: yellow-white
 *   G: yellow       K: orange       M: red
 *
 * Cadence: load once, repaint on resize. Catalog is static (R/P30D refresh).
 */

import { unwrapXrpcResponse, type CelestialObject } from './api';

export interface CelestialOverlayHandle {
  destroy: () => void;
  setVisible: (visible: boolean) => void;
}

const SPECTRAL_COLOR: Record<string, string> = {
  O: '#9bb0ff', B: '#aabfff', A: '#cad7ff', F: '#f8f7ff',
  G: '#fff4ea', K: '#ffd2a1', M: '#ffcc6f',
};

function colorForSpect(s: string | null | undefined): string {
  if (!s) return '#ffffff';
  const c = s.charAt(0).toUpperCase();
  return SPECTRAL_COLOR[c] ?? '#ffffff';
}

// Convert RA/Dec (degrees) → unit 3-vector in equatorial frame.
function radecToVec(raDeg: number, decDeg: number): [number, number, number] {
  const ra = (raDeg * Math.PI) / 180;
  const dec = (decDeg * Math.PI) / 180;
  const cd = Math.cos(dec);
  return [Math.cos(ra) * cd, Math.sin(ra) * cd, Math.sin(dec)];
}

export function applyCelestialSphereOverlay(): CelestialOverlayHandle {
  // Position behind everything; pointer-events-none.
  const canvas = document.createElement('canvas');
  canvas.id = 'celestial-sphere-overlay';
  canvas.style.cssText = [
    'position:fixed', 'inset:0', 'width:100vw', 'height:100vh',
    'z-index:0', 'pointer-events:none', 'background:radial-gradient(ellipse at center, #0a0a18 0%, #050510 60%, #000000 100%)',
  ].join(';');
  document.body.appendChild(canvas);

  let stars: CelestialObject[] = [];
  let stopped = false;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return {
      destroy: () => { canvas.remove(); },
      setVisible: () => {},
    };
  }

  const repaint = () => {
    if (stopped) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Background already in CSS gradient — clear leaves transparency.
    ctx.clearRect(0, 0, w, h);

    // Camera: simple equirectangular mapping. We don't have access to the
    // KAMI render camera matrix here (would require kami-bridge state
    // export); for v1 we paint stars as if looking outward from earth's
    // centre at lat=0, lon=0. The result is a wide angle backdrop that
    // approximately matches what a globe-view viewer would see at zoom 0–2.
    // Stars at roughly (RA, Dec) → screen using a simple azimuthal
    // projection so the result is recognisable (Big Dipper / Orion etc).
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(w, h) * 0.55;

    for (const s of stars) {
      if (s.raDeg == null || s.decDeg == null) continue;
      const [x, y, z] = radecToVec(s.raDeg, s.decDeg);
      // Azimuthal: (x, z) → 2D, drop y. z = up.
      // Behind-camera (y > 0) skipped for compactness.
      if (y > 0.05) continue;
      const u = cx + x * radius;
      const v = cy - z * radius;
      const priority = Math.max(1, Math.min(s.renderPriority ?? 5, 60));
      // Brighter = larger radius + higher alpha. Cap so the overlay stays subtle.
      const r = 0.4 + Math.min(2.5, priority / 14);
      const alpha = Math.min(0.95, 0.25 + priority / 60);
      ctx.beginPath();
      ctx.arc(u, v, r, 0, Math.PI * 2);
      ctx.fillStyle = s.kind === 'star'
        ? colorForSpect(s.spectralClass ?? null)
        : (s.kind === 'galaxy' ? '#fbcfe8' : (s.kind === 'globular_cluster' || s.kind === 'open_cluster' ? '#f0abfc' : '#a78bfa'));
      ctx.globalAlpha = alpha;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };

  const loadStars = async () => {
    try {
      // Stars first (mag-priority ordered), then deep-sky.
      const url = '/xrpc/com.etzhayyim.apps.maps.listCelestialObjects?limit=8000';
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) return;
      const body = await res.json() as { objects?: CelestialObject[] };
      stars = body.objects ?? [];
      repaint();
    } catch {
      // Network/initial fetch can fail before the worker is ready; retry once.
      setTimeout(loadStars, 5000);
    }
  };

  void loadStars();
  window.addEventListener('resize', repaint);

  return {
    destroy: () => {
      stopped = true;
      window.removeEventListener('resize', repaint);
      canvas.remove();
    },
    setVisible: (visible: boolean) => {
      canvas.style.display = visible ? 'block' : 'none';
    },
  };
}
