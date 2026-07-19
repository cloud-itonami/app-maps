/**
 * KAMI Map Bridge — wraps kami-map WASM with a MapLibre-compat API surface.
 * No JS map rendering library is used; all drawing is delegated to the
 * WebGPU/WebGL2 kami-map WASM module. Markers and popups are HTML overlays
 * positioned via kami-map.project().
 */

// ── MapLibre-compat lightweight types ──

export interface LngLat { lng: number; lat: number; }

export class LngLatBoundsCompat {
  private _sw: LngLat = { lng: Infinity, lat: Infinity };
  private _ne: LngLat = { lng: -Infinity, lat: -Infinity };
  constructor(a?: [number, number] | LngLat, b?: [number, number] | LngLat) {
    if (a) this.extend(a);
    if (b) this.extend(b);
  }
  extend(c: [number, number] | LngLat): this {
    const lng = Array.isArray(c) ? c[0] : c.lng;
    const lat = Array.isArray(c) ? c[1] : c.lat;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return this;
    if (lng < this._sw.lng) this._sw.lng = lng;
    if (lat < this._sw.lat) this._sw.lat = lat;
    if (lng > this._ne.lng) this._ne.lng = lng;
    if (lat > this._ne.lat) this._ne.lat = lat;
    return this;
  }
  getSouthWest(): LngLat { return { ...this._sw }; }
  getNorthEast(): LngLat { return { ...this._ne }; }
  isEmpty(): boolean { return !Number.isFinite(this._sw.lng); }
  toArray(): [[number, number], [number, number]] {
    return [[this._sw.lng, this._sw.lat], [this._ne.lng, this._ne.lat]];
  }
}

export type MarkerOptions = {
  element?: HTMLElement;
  color?: string;
  scale?: number;
  anchor?: 'center' | 'top' | 'bottom' | 'left' | 'right';
};

export class KamiMarker {
  private _el: HTMLElement;
  private _lngLat: [number, number] = [0, 0];
  private _map: KamiMapBridge | null = null;
  private _popup: KamiPopup | null = null;
  private _anchor: MarkerOptions['anchor'];

  constructor(opts: MarkerOptions = {}) {
    this._anchor = opts.anchor ?? 'center';
    if (opts.element) {
      this._el = opts.element;
    } else {
      this._el = document.createElement('div');
      this._el.className = 'kami-marker-default';
      const scale = opts.scale ?? 1;
      const color = opts.color ?? '#1f6feb';
      Object.assign(this._el.style, {
        width: `${16 * scale}px`,
        height: `${24 * scale}px`,
        background: color,
        borderRadius: '50% 50% 50% 0',
        transform: 'rotate(-45deg)',
        border: '2px solid white',
        boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
      } as Partial<CSSStyleDeclaration>);
    }
    Object.assign(this._el.style, {
      position: 'absolute',
      pointerEvents: 'auto',
      willChange: 'transform',
      zIndex: '1',
    });
  }

  setLngLat(c: [number, number] | LngLat): this {
    this._lngLat = Array.isArray(c) ? [c[0], c[1]] : [c.lng, c.lat];
    if (this._map) this._map._updateMarkerDom(this);
    return this;
  }

  getLngLat(): LngLat { return { lng: this._lngLat[0], lat: this._lngLat[1] }; }

  getElement(): HTMLElement { return this._el; }

  setPopup(popup: KamiPopup | null): this {
    this._popup?._detachMarker(this);
    this._popup = popup;
    if (popup) {
      popup._attachMarker(this);
      this._el.addEventListener('click', this._togglePopup);
    } else {
      this._el.removeEventListener('click', this._togglePopup);
    }
    return this;
  }

  togglePopup(): this {
    if (!this._popup || !this._map) return this;
    if (this._popup.isOpen()) this._popup.remove();
    else this._popup.addTo(this._map).setLngLat(this._lngLat);
    return this;
  }

  private _togglePopup = () => this.togglePopup();

  addTo(map: KamiMapBridge): this {
    this._map = map;
    map._overlayRoot().appendChild(this._el);
    map._registerMarker(this);
    map._updateMarkerDom(this);
    return this;
  }

  remove(): this {
    if (this._map) {
      this._map._unregisterMarker(this);
      if (this._el.parentNode) this._el.parentNode.removeChild(this._el);
      this._map = null;
    }
    return this;
  }

  /** Recompute absolute position from the current viewport. */
  _reproject(bridge: KamiMapBridge): void {
    const [x, y] = bridge.project(this._lngLat[0], this._lngLat[1]);
    let tx = x;
    let ty = y;
    let translate = 'translate(-50%, -50%)';
    switch (this._anchor) {
      case 'bottom': translate = 'translate(-50%, -100%)'; break;
      case 'top':    translate = 'translate(-50%, 0)';      break;
      case 'left':   translate = 'translate(0, -50%)';      break;
      case 'right':  translate = 'translate(-100%, -50%)';  break;
      default:       translate = 'translate(-50%, -50%)';
    }
    this._el.style.left = `${tx}px`;
    this._el.style.top = `${ty}px`;
    this._el.style.transform = translate;
  }
}

export type PopupOptions = {
  className?: string;
  closeButton?: boolean;
  closeOnClick?: boolean;
  offset?: number;
  maxWidth?: string;
};

export class KamiPopup {
  private _el: HTMLElement;
  private _content: HTMLElement;
  private _map: KamiMapBridge | null = null;
  private _lngLat: [number, number] = [0, 0];
  private _open = false;
  private _attachedMarkers = new Set<KamiMarker>();
  private _opts: PopupOptions;

  constructor(opts: PopupOptions = {}) {
    this._opts = opts;
    this._el = document.createElement('div');
    this._el.className = `kami-popup ${opts.className ?? ''}`.trim();
    Object.assign(this._el.style, {
      position: 'absolute',
      background: 'white',
      color: '#111',
      padding: '8px 12px',
      borderRadius: '6px',
      boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
      maxWidth: opts.maxWidth ?? '280px',
      pointerEvents: 'auto',
      zIndex: '10',
      transform: 'translate(-50%, calc(-100% - 12px))',
    } as Partial<CSSStyleDeclaration>);
    this._content = document.createElement('div');
    this._el.appendChild(this._content);
    if (opts.closeButton) {
      const btn = document.createElement('button');
      btn.textContent = '✕';
      Object.assign(btn.style, {
        position: 'absolute', top: '2px', right: '4px',
        border: 'none', background: 'transparent', cursor: 'pointer',
      } as Partial<CSSStyleDeclaration>);
      btn.addEventListener('click', () => this.remove());
      this._el.appendChild(btn);
    }
  }

  setLngLat(c: [number, number] | LngLat): this {
    this._lngLat = Array.isArray(c) ? [c[0], c[1]] : [c.lng, c.lat];
    if (this._map) this._map._updatePopupDom(this);
    return this;
  }

  setHTML(html: string): this { this._content.innerHTML = html; return this; }
  setText(text: string): this { this._content.textContent = text; return this; }
  setDOMContent(node: Node): this {
    this._content.innerHTML = '';
    this._content.appendChild(node);
    return this;
  }

  addTo(map: KamiMapBridge): this {
    this._map = map;
    map._overlayRoot().appendChild(this._el);
    map._registerPopup(this);
    this._open = true;
    map._updatePopupDom(this);
    return this;
  }

  remove(): this {
    if (this._map) {
      this._map._unregisterPopup(this);
      if (this._el.parentNode) this._el.parentNode.removeChild(this._el);
      this._map = null;
    }
    this._open = false;
    return this;
  }

  isOpen(): boolean { return this._open; }

  _attachMarker(m: KamiMarker) { this._attachedMarkers.add(m); }
  _detachMarker(m: KamiMarker) { this._attachedMarkers.delete(m); }

  _reproject(bridge: KamiMapBridge) {
    const [x, y] = bridge.project(this._lngLat[0], this._lngLat[1]);
    this._el.style.left = `${x}px`;
    this._el.style.top = `${y}px`;
  }
}

// ── Source + layer bookkeeping for the MapLibre-compat shim ──

type GeoJSONGeom =
  | { type: 'Point'; coordinates: [number, number] }
  | { type: 'MultiPoint'; coordinates: [number, number][] }
  | { type: 'LineString'; coordinates: [number, number][] }
  | { type: 'MultiLineString'; coordinates: [number, number][][] }
  | { type: 'Polygon'; coordinates: [number, number][][] }
  | { type: 'MultiPolygon'; coordinates: [number, number][][][] };

interface GeoJSONFeature {
  type: 'Feature';
  geometry: GeoJSONGeom;
  properties?: Record<string, unknown>;
}
interface GeoJSONFeatureCollection {
  type: 'FeatureCollection';
  features: GeoJSONFeature[];
}

type GeoJSONData = GeoJSONFeature | GeoJSONFeatureCollection | GeoJSONGeom;

interface GeoJSONSource {
  type: 'geojson';
  data: GeoJSONData | string;
}
interface VectorSource {
  type: 'vector';
  tiles?: string[];
  minzoom?: number;
  maxzoom?: number;
}
interface RasterSource {
  type: 'raster';
  tiles: string[];
  tileSize?: number;
}

type Source = GeoJSONSource | VectorSource | RasterSource;

export interface LayerSpec {
  id: string;
  type: 'line' | 'fill' | 'circle' | 'symbol' | 'heatmap' | string;
  source: string;
  minzoom?: number;
  maxzoom?: number;
  paint?: Record<string, any>;
  layout?: Record<string, any>;
  filter?: any[];
  'source-layer'?: string;
}

type MvtGeometry =
  | { type: 'Point'; coordinates: [number, number] }
  | { type: 'MultiPoint'; coordinates: [number, number][] }
  | { type: 'LineString'; coordinates: [number, number][] }
  | { type: 'MultiLineString'; coordinates: [number, number][][] }
  | { type: 'Polygon'; coordinates: [number, number][][] };

interface MvtFeature {
  geometry: MvtGeometry;
  properties?: Record<string, unknown>;
}

interface VectorTileDecoded {
  features: MvtFeature[];
}

type EventName =
  | 'load' | 'click' | 'dblclick' | 'contextmenu'
  | 'mouseenter' | 'mouseleave' | 'mousemove'
  | 'move' | 'moveend' | 'zoom' | 'zoomend';

let KamiMapClass: any = null;
let initFn: any = null;
let wasmReady = false;

/** Lazy-load the KAMI Map WASM module via dynamic script injection. */
async function ensureWasm() {
  if (wasmReady) return;

  // Use globalThis to avoid rollup trying to resolve the dynamic import
  const importFn = new Function('url', 'return import(url)');
  const mod = await importFn('/kami-map/kami_map.js');
  initFn = mod.default;
  KamiMapClass = mod.KamiMap;
  await initFn();
  wasmReady = true;
}

// Offscreen canvas for tile image → RGBA conversion
let offCanvas: HTMLCanvasElement | null = null;
let offCtx: CanvasRenderingContext2D | null = null;

function getOffscreenCtx() {
  if (!offCanvas) {
    offCanvas = document.createElement('canvas');
    offCanvas.width = 256;
    offCanvas.height = 256;
    offCtx = offCanvas.getContext('2d', { willReadFrequently: true })!;
  }
  return offCtx!;
}

function decodeTerrariumHeights(rgba: Uint8ClampedArray): Float32Array {
  const pxCount = Math.floor(rgba.length / 4);
  const out = new Float32Array(pxCount);
  for (let i = 0; i < pxCount; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    out[i] = r * 256 + g + b / 256 - 32768;
  }
  return out;
}

/** Tile cache to avoid re-fetching. */
const tileCache = new Set<string>();
let pendingFetches = 0;

export interface KamiMapOptions {
  center: [number, number]; // [lng, lat]
  zoom: number;
  tileUrl?: string;
  demTileUrl?: string;
  orbitalSystems?: unknown[];
  orbitalBodies?: unknown[];
  celestialCatalogs?: unknown[];
  celestialObjects?: unknown[];
  bearing?: number;
  pitch?: number;
}

export interface KamiMapViewport {
  lng: number;
  lat: number;
  zoom: number;
  bearing: number;
  pitch: number;
}

/**
 * KAMI Map instance — wraps the WASM KamiMap with a JS-friendly API.
 */
export class KamiMapBridge {
  private inner: any;
  private canvas: HTMLCanvasElement;
  private overlayEl: HTMLDivElement;
  private rafId = 0;
  private lastTime = 0;
  private _onMoveEnd: (() => void) | null = null;
  private firstTileLoaded = false;
  private firstTileWaiters: Array<() => void> = [];
  private settleTimer: ReturnType<typeof setTimeout> | null = null;

  // Source + layer bookkeeping for MapLibre-compat shim.
  private sources = new Map<string, Source>();
  private layers = new Map<string, LayerSpec>();
  private markers = new Set<KamiMarker>();
  private popups = new Set<KamiPopup>();
  private listeners = new Map<string, Array<{ layerId?: string; handler: (e: any) => void }>>();
  private lastMoveZoom = NaN;
  private lastMoveCenter: [number, number] = [NaN, NaN];
  private dataFetchers = new Map<string, AbortController>();
  private demTileUrl = '';
  private demTileCache = new Set<string>();
  private demTileFetches = new Set<string>();
  // Vector tile cache: source-layer → tileKey ("z/x/y") → decoded features.
  // Key is `${sourceId}|${sourceLayer}` so multiple layers on the same source
  // (e.g. mapillary "image" + "sequence") cache independently.
  private vectorTileCache = new Map<string, Map<string, VectorTileDecoded>>();
  private vectorTileFetches = new Set<string>();

  private constructor(inner: any, canvas: HTMLCanvasElement) {
    this.inner = inner;
    this.canvas = canvas;

    // HTML overlay root for DOM markers/popups. Sits absolutely over the canvas.
    const parent = canvas.parentElement;
    this.overlayEl = document.createElement('div');
    this.overlayEl.className = 'kami-overlay-root';
    Object.assign(this.overlayEl.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      right: '0',
      bottom: '0',
      pointerEvents: 'none',
      overflow: 'hidden',
    } as Partial<CSSStyleDeclaration>);
    if (parent) {
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      parent.appendChild(this.overlayEl);
    }
  }

  _overlayRoot(): HTMLElement { return this.overlayEl; }
  _registerMarker(m: KamiMarker) { this.markers.add(m); }
  _unregisterMarker(m: KamiMarker) { this.markers.delete(m); }
  _updateMarkerDom(m: KamiMarker) { m._reproject(this); }
  _registerPopup(p: KamiPopup) { this.popups.add(p); }
  _unregisterPopup(p: KamiPopup) { this.popups.delete(p); }
  _updatePopupDom(p: KamiPopup) { p._reproject(this); }

  private callInner<T = any>(names: string[], ...args: any[]): T {
    for (const name of names) {
      const fn = this.inner?.[name];
      if (typeof fn === 'function') {
        return fn.apply(this.inner, args);
      }
    }
    throw new Error(`KAMI method not found: ${names.join(' | ')}`);
  }

  /** Create a KAMI Map on the given canvas element. */
  static async create(canvasId: string, opts: KamiMapOptions): Promise<KamiMapBridge> {
    await ensureWasm();
    if (!opts.tileUrl) {
      throw new Error('KAMI tileUrl is required');
    }
    const inner = await KamiMapClass.create(canvasId, JSON.stringify({
      center: opts.center,
      zoom: opts.zoom,
      'tileUrl': opts.tileUrl,
      'demTileUrl': opts.demTileUrl,
      'orbitalSystems': opts.orbitalSystems,
      'orbitalBodies': opts.orbitalBodies,
      'celestialCatalogs': opts.celestialCatalogs,
      'celestialObjects': opts.celestialObjects,
      bearing: opts.bearing || 0,
      pitch: opts.pitch || 0,
    }));
    const canvas = document.getElementById(canvasId) as HTMLCanvasElement;
    const bridge = new KamiMapBridge(inner, canvas);
    bridge.demTileUrl = opts.demTileUrl ?? '';
    bridge.setupInput();
    bridge.startRenderLoop();
    bridge.fetchTiles();
    return bridge;
  }

  /** Start the render loop. */
  private startRenderLoop() {
    this.lastTime = performance.now();
    const frame = (now: number) => {
      const dt = now - this.lastTime;
      this.lastTime = now;
      this.inner.frame(dt);

      // Reproject DOM overlays each frame so markers/popups track pan/zoom.
      if (this.markers.size || this.popups.size) {
        for (const m of this.markers) m._reproject(this);
        for (const p of this.popups) p._reproject(this);
      }

      // Emit move / moveend when viewport parameters change.
      const vp = this.getViewport();
      if (
        vp.zoom !== this.lastMoveZoom ||
        vp.lng !== this.lastMoveCenter[0] ||
        vp.lat !== this.lastMoveCenter[1]
      ) {
        this.lastMoveZoom = vp.zoom;
        this.lastMoveCenter = [vp.lng, vp.lat];
        this.emit('move', { target: this });
      }

      this.rafId = requestAnimationFrame(frame);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  /** Setup pointer/wheel input forwarding. */
  private setupInput() {
    const c = this.canvas;
    const settleMove = (delayMs: number) => {
      if (this.settleTimer) clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => {
        this.settleTimer = null;
        this._onMoveEnd?.();
        this.fetchTiles();
        this.invalidateOverlayLayers();
        this.emit('moveend', { target: this });
      }, delayMs);
    };
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.callInner(['onPointerDown', 'on_pointer_down'], e.offsetX, e.offsetY, e.button);
    });
    c.addEventListener('pointermove', (e) => {
      this.callInner(['onPointerMove', 'on_pointer_move'], e.offsetX, e.offsetY, e.movementX, e.movementY);
    });
    c.addEventListener('pointerup', (e) => {
      this.callInner(['onPointerUp', 'on_pointer_up'], e.offsetX, e.offsetY);
      settleMove(0);
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.callInner(['onWheel', 'on_wheel'], e.deltaY);
      this.emit('zoom', { target: this });
      settleMove(140);
    }, { passive: false });
    c.addEventListener('click', (e) => this.emit('click', this.makePointerEvent(e)));
    c.addEventListener('dblclick', (e) => this.emit('dblclick', this.makePointerEvent(e)));
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.emit('contextmenu', this.makePointerEvent(e));
    });
    c.addEventListener('mousemove', (e) => this.emit('mousemove', this.makePointerEvent(e)));

    // Resize observer
    new ResizeObserver(() => {
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (w > 0 && h > 0) {
        c.width = w;
        c.height = h;
        this.callInner(['resize'], w, h);
      }
    }).observe(c);
  }

  /** Fetch tiles needed for current viewport. */
  async fetchTiles() {
    if (!this.inner) return;
    try {
      const tilesJson = this.callInner<string>(['tilesToFetch', 'tiles_to_fetch']);
      const tiles = JSON.parse(tilesJson);
      for (const t of tiles) {
        const key = `${t.z}/${t.x}/${t.y}`;
        if (tileCache.has(key)) continue;
        tileCache.add(key);
        pendingFetches++;
        this.fetchSingleTile(t).catch((_err) => {
          tileCache.delete(key);
        }).finally(() => { pendingFetches--; });
      }
    } catch { /* ignore */ }
  }

  private async fetchSingleTile(t: { z: number; x: number; y: number; url: string }) {
    const resp = await fetch(t.url, { mode: 'cors' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const bmp = await createImageBitmap(blob);
    const ctx = getOffscreenCtx();
    ctx.clearRect(0, 0, 256, 256);
    ctx.drawImage(bmp, 0, 0, 256, 256);
    const imageData = ctx.getImageData(0, 0, 256, 256);
    const rgba = new Uint8Array(imageData.data.buffer);
    this.callInner(['uploadTile', 'upload_tile'], t.z, t.x, t.y, rgba, 256, 256);
    if (!this.firstTileLoaded) {
      this.firstTileLoaded = true;
      for (const notify of this.firstTileWaiters) notify();
      this.firstTileWaiters = [];
    }
    bmp.close();
    void this.fetchDemTile(t.z, t.x, t.y);
  }

  private async fetchDemTile(z: number, x: number, y: number) {
    if (!this.demTileUrl) return;
    const tileKey = `${z}/${x}/${y}`;
    if (this.demTileCache.has(tileKey) || this.demTileFetches.has(tileKey)) return;
    this.demTileFetches.add(tileKey);
    try {
      const url = this.demTileUrl
        .replace('{z}', String(z))
        .replace('{x}', String(x))
        .replace('{y}', String(y));
      const resp = await fetch(url, { mode: 'cors' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const bmp = await createImageBitmap(blob);
      const ctx = getOffscreenCtx();
      const width = bmp.width || 256;
      const height = bmp.height || 256;
      if (offCanvas && (offCanvas.width !== width || offCanvas.height !== height)) {
        offCanvas.width = width;
        offCanvas.height = height;
      }
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(bmp, 0, 0, width, height);
      const imageData = ctx.getImageData(0, 0, width, height);
      const heights = decodeTerrariumHeights(imageData.data);
      this.callInner(['uploadDemTile', 'upload_dem_tile'], z, x, y, heights, width, height);
      this.demTileCache.add(tileKey);
      bmp.close();
    } catch (err) {
      console.warn(`kami-bridge: DEM fetch ${z}/${x}/${y} failed`, err);
    } finally {
      this.demTileFetches.delete(tileKey);
    }
  }

  async waitForFirstTile(timeoutMs = 2500): Promise<boolean> {
    if (this.firstTileLoaded) return true;
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.firstTileWaiters.push(() => {
        clearTimeout(timer);
        finish(true);
      });
    });
  }

  // ── MapLibre-compatible API ──

  getCenter(): { lng: number; lat: number } {
    const vp = this.getViewport();
    return { lng: vp.lng, lat: vp.lat };
  }

  getZoom(): number {
    return this.callInner<number>(['getZoom', 'get_zoom']);
  }

  getViewport(): KamiMapViewport {
    const raw = this.callInner<string>(['getViewport', 'get_viewport']);
    return JSON.parse(raw);
  }

  setCenter(lng: number, lat: number) {
    this.callInner(['setCenter', 'set_center'], lng, lat);
    this.fetchTiles();
  }

  setZoom(zoom: number) {
    this.callInner(['setZoom', 'set_zoom'], zoom);
    this.fetchTiles();
  }

  flyTo(opts: { center?: [number, number]; zoom?: number; duration?: number }) {
    const vp = this.getViewport();
    const lng = opts.center?.[0] ?? vp.lng;
    const lat = opts.center?.[1] ?? vp.lat;
    const zoom = opts.zoom ?? vp.zoom;
    const dur = opts.duration ?? 1500;
    this.callInner(['flyTo', 'fly_to'], lng, lat, zoom, dur);
    setTimeout(() => this.fetchTiles(), dur + 100);
    setTimeout(() => this.invalidateOverlayLayers(), dur + 50);
    setTimeout(() => this.emit('moveend', { target: this }), dur + 150);
    return this;
  }

  /** MapLibre-compat alias for flyTo with same interpolation profile. */
  easeTo(opts: { center?: [number, number]; zoom?: number; duration?: number }) {
    return this.flyTo(opts);
  }

  /** MapLibre-compat alias: pan center, optionally preserving zoom. */
  panTo(center: [number, number], opts: { duration?: number } = {}) {
    return this.flyTo({ center, duration: opts.duration ?? 500 });
  }

  /** Return current bearing in degrees. */
  getBearing(): number { return this.getViewport().bearing ?? 0; }

  /** Return current pitch in degrees. */
  getPitch(): number { return this.getViewport().pitch ?? 0; }

  setBearing(degrees: number) { this.callInner(['setBearing', 'set_bearing'], degrees); }
  setPitch(degrees: number) { this.callInner(['setPitch', 'set_pitch'], degrees); }

  /** Set a route line on the map. */
  setRoute(coords: [number, number][], color = '#00ffcc', width = 4) {
    this.callInner(['setRoute', 'set_route'], JSON.stringify(coords), color, width);
  }

  clearLayers() { this.callInner(['clearLayers', 'clear_layers']); }

  /** Screen coord → geographic coord. */
  unproject(screenX: number, screenY: number): [number, number] {
    const raw = this.callInner<string>(['unproject'], screenX, screenY);
    return JSON.parse(raw);
  }

  /** Register moveend callback (called after pan/zoom). */
  onMoveEnd(cb: () => void) { this._onMoveEnd = cb; }

  /** Geographic coord → screen px. Delegates to kami-map project(). */
  project(lng: number, lat: number): [number, number] {
    const raw = this.callInner<string>(['project'], lng, lat);
    return JSON.parse(raw);
  }

  /** Return the HTMLCanvasElement hosting the WebGPU/WebGL2 surface. */
  getCanvas(): HTMLCanvasElement { return this.canvas; }

  /** Return current viewport bounds as a LngLatBoundsCompat. */
  getBounds(): LngLatBoundsCompat {
    const sw = this.unproject(0, this.canvas.height);
    const ne = this.unproject(this.canvas.width, 0);
    return new LngLatBoundsCompat(sw, ne);
  }

  /** Fit map viewport to bounds. Accepts LngLatBoundsCompat or [[lng,lat],[lng,lat]]. */
  fitBounds(
    bounds: LngLatBoundsCompat | [[number, number], [number, number]] | any,
    opts: { padding?: number; duration?: number } = {},
  ): this {
    let sw: LngLat;
    let ne: LngLat;
    if (bounds && typeof (bounds as any).getSouthWest === 'function') {
      sw = (bounds as LngLatBoundsCompat).getSouthWest();
      ne = (bounds as LngLatBoundsCompat).getNorthEast();
    } else if (Array.isArray(bounds) && bounds.length === 2) {
      sw = { lng: bounds[0][0], lat: bounds[0][1] };
      ne = { lng: bounds[1][0], lat: bounds[1][1] };
    } else {
      return this;
    }
    const padding = opts.padding ?? 40;
    this.callInner(['fitBounds', 'fit_bounds'], sw.lng, sw.lat, ne.lng, ne.lat, padding);
    setTimeout(() => this.fetchTiles(), 50);
    this.invalidateOverlayLayers();
    this.emit('moveend', { target: this });
    return this;
  }

  // ── MapLibre-compat: source + layer management ──

  addSource(id: string, src: Source): this {
    this.sources.set(id, src);
    this.rebuildLayersForSource(id);
    return this;
  }

  getSource(id: string): (Source & { setData?: (d: GeoJSONData) => void }) | undefined {
    const existing = this.sources.get(id);
    if (!existing) return undefined;
    const self = this;
    return {
      ...existing,
      setData: (data: GeoJSONData) => {
        if (existing.type !== 'geojson') return;
        (existing as GeoJSONSource).data = data;
        self.rebuildLayersForSource(id);
      },
    } as any;
  }

  removeSource(id: string): this {
    this.sources.delete(id);
    // Drop any layers that referenced it.
    for (const [layerId, spec] of Array.from(this.layers.entries())) {
      if (spec.source === id) this.removeLayer(layerId);
    }
    return this;
  }

  addLayer(spec: LayerSpec): this {
    this.layers.set(spec.id, spec);
    this.realizeLayer(spec);
    if (typeof spec.minzoom === 'number' || typeof spec.maxzoom === 'number') {
      this.callInner(
        ['setLayerZoomRange', 'set_layer_zoom_range'],
        spec.id,
        spec.minzoom ?? 0,
        spec.maxzoom ?? 24,
      );
    }
    return this;
  }

  removeLayer(id: string): this {
    this.layers.delete(id);
    this.callInner(['removeLayer', 'remove_layer'], id);
    return this;
  }

  getLayer(id: string): LayerSpec | undefined { return this.layers.get(id); }

  setLayoutProperty(layerId: string, name: string, value: any): this {
    const spec = this.layers.get(layerId);
    if (!spec) return this;
    spec.layout = { ...(spec.layout ?? {}), [name]: value };
    if (name === 'visibility') {
      this.callInner(['setLayerVisibility', 'set_layer_visibility'], layerId, value !== 'none');
    }
    return this;
  }

  setPaintProperty(layerId: string, name: string, value: any): this {
    const spec = this.layers.get(layerId);
    if (!spec) return this;
    spec.paint = { ...(spec.paint ?? {}), [name]: value };
    this.realizeLayer(spec);
    return this;
  }

  setFilter(layerId: string, filter: any[] | null): this {
    const spec = this.layers.get(layerId);
    if (!spec) return this;
    spec.filter = filter ?? undefined;
    this.realizeLayer(spec);
    return this;
  }

  /** MapLibre no-op placeholders. kami-map has no style spec and no image atlas yet. */
  setStyle(_s: any): this { return this; }
  addControl(_c: any, _pos?: string): this { return this; }
  removeControl(_c: any): this { return this; }
  addImage(_name: string, _img: any): this { return this; }
  hasImage(_name: string): boolean { return false; }
  loadImage(_url: string, cb: (err: any, img: any) => void) { cb(new Error('kami-map has no image atlas'), null); }
  loaded(): boolean { return true; }
  isStyleLoaded(): boolean { return true; }
  triggerRepaint(): void { /* always painting */ }
  queryRenderedFeatures(): any[] { return []; }

  // ── MapLibre-compat: events ──

  on(event: EventName | string, layerIdOrHandler: any, maybeHandler?: any): this {
    let layerId: string | undefined;
    let handler: (e: any) => void;
    if (typeof layerIdOrHandler === 'string') {
      layerId = layerIdOrHandler;
      handler = maybeHandler as (e: any) => void;
    } else {
      handler = layerIdOrHandler as (e: any) => void;
    }
    const list = this.listeners.get(event) ?? [];
    list.push({ layerId, handler });
    this.listeners.set(event, list);
    return this;
  }

  off(event: EventName | string, handler: (e: any) => void): this {
    const list = this.listeners.get(event);
    if (!list) return this;
    const next = list.filter((l) => l.handler !== handler);
    this.listeners.set(event, next);
    return this;
  }

  once(event: EventName | string, handler: (e: any) => void): this {
    const wrap = (e: any) => { this.off(event, wrap); handler(e); };
    return this.on(event, wrap);
  }

  private emit(event: string, payload: any) {
    const list = this.listeners.get(event);
    if (!list || !list.length) return;
    for (const entry of list) {
      // Layer-scoped listeners only fire when no layer id was filtered (we don't
      // do GPU hit-testing yet, so layerId-bound clicks never fire).
      if (entry.layerId) continue;
      try { entry.handler(payload); } catch (err) { console.warn('kami-bridge listener failed', err); }
    }
  }

  private makePointerEvent(e: MouseEvent | PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const [lng, lat] = this.unproject(x, y);
    return {
      point: { x, y },
      lngLat: { lng, lat, wrap: () => ({ lng, lat }), toArray: () => [lng, lat] },
      originalEvent: e,
      target: this,
      preventDefault: () => e.preventDefault(),
    };
  }

  // ── Internal: realize a layer spec against kami-map Rust APIs ──

  private realizeLayer(spec: LayerSpec) {
    const src = this.sources.get(spec.source);
    if (!src) return;
    if (src.type === 'geojson') {
      this.realizeGeoJSONLayer(spec, src as GeoJSONSource);
    } else if (src.type === 'vector') {
      this.realizeVectorLayer(spec, src as VectorSource);
    } else if (src.type === 'raster') {
      // Additional raster tile stacks not supported; base tiles come from create opts.
      console.warn(`kami-bridge: raster source "${spec.source}" ignored`);
    }
  }

  private realizeGeoJSONLayer(spec: LayerSpec, src: GeoJSONSource) {
    const data = src.data;
    const applyAndEmit = (resolved: GeoJSONData) => {
      const { lines, polygons, points } = this.normalizeGeoJSON(resolved);
      const color = this.evalColor(spec);
      const opacity = this.evalOpacity(spec);
      const id = spec.id;

      if (spec.type === 'line') {
        const width = this.evalLineWidth(spec);
        if (lines.length > 0) {
          this.callInner(
            ['addLineLayer', 'add_line_layer'],
            id,
            JSON.stringify(lines),
            color,
            width,
          );
        } else {
          this.callInner(['removeLayer', 'remove_layer'], id);
        }
      } else if (spec.type === 'fill') {
        if (polygons.length > 0) {
          this.callInner(
            ['addFillLayer', 'add_fill_layer'],
            id,
            JSON.stringify(polygons),
            color,
            opacity,
          );
        } else {
          this.callInner(['removeLayer', 'remove_layer'], id);
        }
      } else if (spec.type === 'circle' || spec.type === 'symbol' || spec.type === 'heatmap') {
        const radius = this.evalCircleRadius(spec);
        if (points.length > 0) {
          this.callInner(
            ['addCircleLayer', 'add_circle_layer'],
            id,
            JSON.stringify(points),
            color,
            radius,
          );
        } else {
          this.callInner(['removeLayer', 'remove_layer'], id);
        }
      } else {
        console.warn(`kami-bridge: unknown layer type "${spec.type}"`);
      }
    };

    if (typeof data === 'string') {
      this.fetchRemoteGeoJSON(spec.id, data).then(applyAndEmit).catch((err) => {
        console.warn(`kami-bridge: failed to fetch ${data}`, err);
      });
    } else {
      applyAndEmit(data as GeoJSONData);
    }
  }

  // ── Vector tile source: MVT fetch + decode via kami-map.decode_mvt_layer ──

  private realizeVectorLayer(spec: LayerSpec, src: VectorSource) {
    const sourceLayer = spec['source-layer'];
    if (!sourceLayer || !src.tiles?.length) {
      console.warn(`kami-bridge: vector layer "${spec.id}" missing source-layer or tiles[]`);
      return;
    }
    const cacheKey = `${spec.source}|${sourceLayer}`;
    let cache = this.vectorTileCache.get(cacheKey);
    if (!cache) {
      cache = new Map();
      this.vectorTileCache.set(cacheKey, cache);
    }

    const tiles = this.computeVisibleTileCoords(src.minzoom, src.maxzoom);
    for (const t of tiles) {
      const tileKey = `${t.z}/${t.x}/${t.y}`;
      if (cache.has(tileKey)) continue;
      const fetchKey = `${cacheKey}|${tileKey}`;
      if (this.vectorTileFetches.has(fetchKey)) continue;
      this.vectorTileFetches.add(fetchKey);

      const tmpl = src.tiles[0];
      const url = tmpl
        .replace('{z}', String(t.z))
        .replace('{x}', String(t.x))
        .replace('{y}', String(t.y));

      void this.fetchAndDecodeTile(url, t, sourceLayer, cache!, spec)
        .catch((err) => {
          if ((err as any)?.name !== 'AbortError') {
            console.warn(`kami-bridge: MVT fetch ${url} failed`, err);
          }
        })
        .finally(() => { this.vectorTileFetches.delete(fetchKey); });
    }

    // Render whatever is in cache right now.
    this.applyVectorCacheToLayer(spec, cache);
  }

  private async fetchAndDecodeTile(
    url: string,
    t: { z: number; x: number; y: number },
    sourceLayer: string,
    cache: Map<string, VectorTileDecoded>,
    spec: LayerSpec,
  ): Promise<void> {
    const r = await fetch(url, { mode: 'cors' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    const decoded = this.decodeVectorTile(buf, t, sourceLayer);
    cache.set(`${t.z}/${t.x}/${t.y}`, decoded);
    this.applyVectorCacheToLayer(spec, cache);
  }

  private decodeVectorTile(
    buf: Uint8Array,
    t: { z: number; x: number; y: number },
    sourceLayer: string,
  ): VectorTileDecoded {
    try {
      const richJson = this.callInner<string>(
        ['decodeMvtLayerFeatures', 'decode_mvt_layer_features'],
        t.z,
        t.x,
        t.y,
        sourceLayer,
        buf,
      );
      const decoded = JSON.parse(richJson) as Partial<VectorTileDecoded>;
      if (Array.isArray(decoded.features)) {
        return { features: decoded.features as MvtFeature[] };
      }
    } catch {
      // Older wasm bundles expose only decode_mvt_layer().
    }

    const json = this.callInner<string>(
      ['decodeMvtLayer', 'decode_mvt_layer'],
      t.z,
      t.x,
      t.y,
      sourceLayer,
      buf,
    );
    const decoded = JSON.parse(json) as {
      lines?: [number, number][][];
      polygons?: [number, number][][];
      points?: [number, number][];
    };
    const features: MvtFeature[] = [];
    for (const line of decoded.lines ?? []) {
      features.push({ geometry: { type: 'LineString', coordinates: line }, properties: {} });
    }
    for (const polygon of decoded.polygons ?? []) {
      features.push({ geometry: { type: 'Polygon', coordinates: [polygon] }, properties: {} });
    }
    for (const point of decoded.points ?? []) {
      features.push({ geometry: { type: 'Point', coordinates: point }, properties: {} });
    }
    return { features };
  }

  private applyVectorCacheToLayer(
    spec: LayerSpec,
    cache: Map<string, VectorTileDecoded>,
  ) {
    const lines: [number, number][][] = [];
    const polygons: [number, number][][] = [];
    const points: [number, number][] = [];
    for (const decoded of cache.values()) {
      for (const feature of decoded.features) {
        if (!this.featureMatchesFilter(feature, spec.filter)) continue;
        this.pushFeatureGeometry(feature, lines, polygons, points);
      }
    }
    const color = this.evalColor(spec);
    const id = spec.id;
    if (spec.type === 'line' && lines.length) {
      this.callInner(['addLineLayer', 'add_line_layer'], id, JSON.stringify(lines), color, this.evalLineWidth(spec));
    } else if (spec.type === 'fill' && polygons.length) {
      this.callInner(['addFillLayer', 'add_fill_layer'], id, JSON.stringify(polygons), color, this.evalOpacity(spec));
    } else if ((spec.type === 'circle' || spec.type === 'symbol') && points.length) {
      this.callInner(['addCircleLayer', 'add_circle_layer'], id, JSON.stringify(points), color, this.evalCircleRadius(spec));
    } else {
      this.callInner(['removeLayer', 'remove_layer'], id);
    }
  }

  private pushFeatureGeometry(
    feature: MvtFeature,
    lines: [number, number][][],
    polygons: [number, number][][],
    points: [number, number][],
  ) {
    switch (feature.geometry.type) {
      case 'Point':
        points.push(feature.geometry.coordinates);
        break;
      case 'MultiPoint':
        for (const point of feature.geometry.coordinates) points.push(point);
        break;
      case 'LineString':
        lines.push(feature.geometry.coordinates);
        break;
      case 'MultiLineString':
        for (const line of feature.geometry.coordinates) lines.push(line);
        break;
      case 'Polygon':
        for (const ring of feature.geometry.coordinates) polygons.push(ring);
        break;
    }
  }

  private featureMatchesFilter(feature: MvtFeature, filter?: any[]): boolean {
    if (!Array.isArray(filter) || filter.length === 0) return true;
    return this.evalFilterExpr(filter, feature);
  }

  private evalFilterExpr(expr: any, feature: MvtFeature): boolean {
    if (!Array.isArray(expr) || expr.length === 0) return true;
    const [op, ...args] = expr;
    switch (op) {
      case 'all':
        return args.every((arg) => this.evalFilterExpr(arg, feature));
      case 'any':
        return args.some((arg) => this.evalFilterExpr(arg, feature));
      case 'none':
        return args.every((arg) => !this.evalFilterExpr(arg, feature));
      case '==':
        return this.filterValue(args[0], feature) === this.filterValue(args[1], feature);
      case '!=':
        return this.filterValue(args[0], feature) !== this.filterValue(args[1], feature);
      case 'in': {
        const needle = this.filterValue(args[0], feature);
        return args.slice(1).some((arg) => this.filterValue(arg, feature) === needle);
      }
      case '!in': {
        const needle = this.filterValue(args[0], feature);
        return args.slice(1).every((arg) => this.filterValue(arg, feature) !== needle);
      }
      case 'has': {
        const key = args[0];
        return typeof key === 'string' && this.featureProperty(feature, key) !== undefined;
      }
      case '!has': {
        const key = args[0];
        return typeof key === 'string' && this.featureProperty(feature, key) === undefined;
      }
      default:
        return true;
    }
  }

  private filterValue(expr: any, feature: MvtFeature): unknown {
    if (Array.isArray(expr)) {
      const [op, ...args] = expr;
      if (op === 'get' && typeof args[0] === 'string') {
        return this.featureProperty(feature, args[0]);
      }
      return this.evalFilterExpr(expr, feature);
    }
    if (expr === '$type') return this.featureGeometryType(feature);
    if (typeof expr === 'string') {
      const property = this.featureProperty(feature, expr);
      if (property !== undefined) return property;
    }
    return expr;
  }

  private featureProperty(feature: MvtFeature, key: string): unknown {
    if (key === '$type') return this.featureGeometryType(feature);
    return feature.properties?.[key];
  }

  private featureGeometryType(feature: MvtFeature): 'Point' | 'LineString' | 'Polygon' {
    switch (feature.geometry.type) {
      case 'Point':
      case 'MultiPoint':
        return 'Point';
      case 'LineString':
      case 'MultiLineString':
        return 'LineString';
      case 'Polygon':
      default:
        return 'Polygon';
    }
  }

  /** Compute the tile coords covering the current viewport at the layer's zoom. */
  private computeVisibleTileCoords(minzoom: number = 0, maxzoom: number = 22): { z: number; x: number; y: number }[] {
    const vp = this.getViewport();
    const z = Math.max(minzoom, Math.min(Math.floor(vp.zoom), maxzoom));
    // Half-viewport in degrees at this zoom (rough).
    const halfWdeg = (this.canvas.width / 256 / Math.pow(2, z)) * 360 / 2;
    const halfHdeg = (this.canvas.height / 256 / Math.pow(2, z)) * 170 / 2;
    const w = vp.lng - halfWdeg;
    const e = vp.lng + halfWdeg;
    const n = vp.lat + halfHdeg;
    const s = vp.lat - halfHdeg;
    const n2 = 1 << z;
    const lngToX = (lng: number) => Math.floor(((lng + 180) / 360) * n2);
    const latToY = (lat: number) => {
      const r = (lat * Math.PI) / 180;
      return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n2);
    };
    const xMin = Math.max(0, lngToX(w));
    const xMax = Math.min(n2 - 1, lngToX(e));
    const yMin = Math.max(0, latToY(n));
    const yMax = Math.min(n2 - 1, latToY(s));
    const out: { z: number; x: number; y: number }[] = [];
    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        out.push({ z, x, y });
      }
    }
    return out;
  }

  private async fetchRemoteGeoJSON(layerId: string, url: string): Promise<GeoJSONData> {
    this.dataFetchers.get(layerId)?.abort();
    const ctrl = new AbortController();
    this.dataFetchers.set(layerId, ctrl);
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as GeoJSONData;
  }

  private normalizeGeoJSON(data: GeoJSONData): {
    lines: [number, number][][];
    polygons: [number, number][][];
    points: [number, number][];
  } {
    const lines: [number, number][][] = [];
    const polygons: [number, number][][] = [];
    const points: [number, number][] = [];
    const visit = (geom: GeoJSONGeom | undefined) => {
      if (!geom || !geom.type) return;
      switch (geom.type) {
        case 'Point':
          points.push(geom.coordinates);
          break;
        case 'MultiPoint':
          for (const p of geom.coordinates) points.push(p);
          break;
        case 'LineString':
          lines.push(geom.coordinates);
          break;
        case 'MultiLineString':
          for (const ls of geom.coordinates) lines.push(ls);
          break;
        case 'Polygon':
          for (const ring of geom.coordinates) polygons.push(ring);
          break;
        case 'MultiPolygon':
          for (const poly of geom.coordinates) for (const ring of poly) polygons.push(ring);
          break;
      }
    };
    if ((data as any).type === 'FeatureCollection') {
      for (const f of (data as GeoJSONFeatureCollection).features) visit(f.geometry);
    } else if ((data as any).type === 'Feature') {
      visit((data as GeoJSONFeature).geometry);
    } else {
      visit(data as GeoJSONGeom);
    }
    return { lines, polygons, points };
  }

  private evalColor(spec: LayerSpec): string {
    const paint = spec.paint ?? {};
    const raw = paint[`${spec.type}-color`] ?? paint.color ?? '#1f6feb';
    return typeof raw === 'string' ? raw : '#1f6feb';
  }

  private evalOpacity(spec: LayerSpec): number {
    const paint = spec.paint ?? {};
    const raw = paint[`${spec.type}-opacity`] ?? paint.opacity ?? 0.8;
    return typeof raw === 'number' ? raw : 0.8;
  }

  private evalLineWidth(spec: LayerSpec): number {
    const raw = spec.paint?.['line-width'];
    if (typeof raw === 'number') return raw;
    if (Array.isArray(raw)) {
      // Simplified: pick the largest stop value, or fall back.
      const nums = raw.flat().filter((n): n is number => typeof n === 'number');
      if (nums.length) return Math.max(...nums);
    }
    return 3;
  }

  private evalCircleRadius(spec: LayerSpec): number {
    const raw = spec.paint?.['circle-radius'] ?? spec.paint?.['icon-size'];
    if (typeof raw === 'number') return raw * 2; // approximate world-px
    if (Array.isArray(raw)) {
      const nums = raw.flat().filter((n): n is number => typeof n === 'number');
      if (nums.length) return Math.max(...nums) * 2;
    }
    return 6;
  }

  private rebuildLayersForSource(sourceId: string) {
    for (const spec of this.layers.values()) {
      if (spec.source === sourceId) this.realizeLayer(spec);
    }
  }

  private invalidateOverlayLayers() {
    try {
      this.callInner(['invalidateLayers', 'invalidate_layers']);
    } catch {
      /* older wasm without invalidate_layers — ignore */
    }
    // Re-fetch missing vector tiles for the new viewport.
    for (const spec of this.layers.values()) {
      const src = this.sources.get(spec.source);
      if (src?.type === 'vector') this.realizeVectorLayer(spec, src as VectorSource);
    }
  }

  /** Upload a 3D extrusion layer (building footprints + per-polygon heights). */
  addExtrudeLayer(
    id: string,
    rings: [number, number][][],
    heights: number[],
    color = '#78716c',
    opacity = 0.85,
  ) {
    this.callInner(
      ['addExtrudeLayer', 'add_extrude_layer'],
      id,
      JSON.stringify(rings),
      JSON.stringify(heights),
      color,
      opacity,
    );
  }

  /** Stop render loop and free WASM resources. */
  destroy() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.settleTimer) clearTimeout(this.settleTimer);
    for (const c of this.dataFetchers.values()) c.abort();
    this.dataFetchers.clear();
    if (this.overlayEl.parentNode) this.overlayEl.parentNode.removeChild(this.overlayEl);
    this.inner?.free();
    this.inner = null;
  }
}

// Legacy alias for code importing `new maplibregl.LngLatBounds()` patterns.
export const LngLatBounds = LngLatBoundsCompat;
