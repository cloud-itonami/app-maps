/**
 * maps-tile-server — self-hosted MVT tile server.
 *
 * Route surface (tiles-maps.etzhayyim.com):
 *   GET /v1/{z}/{x}/{y}.pbf   → MVT tile bytes (OpenMapTiles schema)
 *   GET /v1/manifest.json     → current PMTiles version + build metadata
 *   GET /v1/style.json        → MapLibre-compatible style (kami ignores it)
 *   GET /health               → liveness
 *
 * Storage:
 *   R2 binding TILES       → etzhayyim-maps-tiles bucket
 *     v1/planet-{VERSION}.pmtiles  — built by 50-infra/k8s/maps-tilemaker-build
 *     v1/manifest.json             — { version, pmtilesKey, builtAt, bytes, ... }
 *   KV binding TILE_MANIFEST
 *     manifest:v1            — cached manifest.json (TTL 60 s)
 *     style:v1               — cached style.json
 *
 * Auth: public (z 0–14). z ≥ 15 auth is a TODO — wire via AT session JWT
 * + rate-limit via Cloudflare WAF (not implemented here).
 *
 * Single-file principle (60-apps/CLAUDE.md) — this file holds all HTTP logic.
 * PMTiles v3 directory / tile resolution lives in ./pmtiles.ts.
 */

import { newPmtilesCache, readTile, type PmtilesCache } from './pmtiles';

// ── Env bindings (CF Worker) ─────────────────────────────────────────────────

interface Env {
  TILES: R2Bucket;
  TILE_MANIFEST: KVNamespace;
  TILE_MANIFEST_KEY: string;
  TILE_MANIFEST_TTL_SECONDS: string;
  TILE_R2_MANIFEST_KEY: string;
  TILE_ATTRIBUTION: string;
  APP_NANOID: string;
}

interface TileManifest {
  schema: string;
  version: string;
  pmtilesKey: string;
  builtAt: string;
  bytes?: number;
  source?: string;
  tileFormat?: string;
  minZoom?: number;
  maxZoom?: number;
}

// ── Per-isolate cache for PMTiles header + root directory ────────────────────
//
// CF Worker isolates are reused across requests for ~minutes; header and root
// directory are immutable for a given object key. Rotating pmtilesKey (new
// version) invalidates automatically (cache key mismatch).
const pmtilesCache: PmtilesCache = newPmtilesCache();

// ── Worker entry ─────────────────────────────────────────────────────────────

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return new Response('method not allowed', {
        status: 405,
        headers: { Allow: 'GET, HEAD' },
      });
    }

    if (pathname === '/health' || pathname === '/_worker/health') {
      return json({ ok: true, app: 'maps-tile-server', nanoid: env.APP_NANOID });
    }

    if (pathname === '/v1/manifest.json') {
      const manifest = await loadManifest(env);
      if (!manifest) return json({ error: 'manifest not found' }, 503);
      return json(manifest, 200, {
        'Cache-Control': `public, max-age=${env.TILE_MANIFEST_TTL_SECONDS || '60'}`,
      });
    }

    if (pathname === '/v1/style.json') {
      return serveStyle(req, env);
    }

    // /v1/{z}/{x}/{y}.pbf
    const tileMatch = /^\/v1\/(\d+)\/(\d+)\/(\d+)\.pbf$/.exec(pathname);
    if (tileMatch) {
      const z = Number(tileMatch[1]);
      const x = Number(tileMatch[2]);
      const y = Number(tileMatch[3]);
      return serveTile(env, z, x, y);
    }

    // Root catch-all: a terse capability description (helps debugging CNAMEs).
    if (pathname === '/' || pathname === '/_app/meta') {
      return json({
        app: 'maps-tile-server',
        nanoid: env.APP_NANOID,
        endpoints: {
          tile: '/v1/{z}/{x}/{y}.pbf',
          manifest: '/v1/manifest.json',
          style: '/v1/style.json',
          health: '/health',
        },
        attribution: env.TILE_ATTRIBUTION,
      });
    }

    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// ── Handlers ─────────────────────────────────────────────────────────────────

async function serveTile(env: Env, z: number, x: number, y: number): Promise<Response> {
  if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y)) {
    return new Response('bad tile coords', { status: 400 });
  }
  if (z < 0 || z > 22) return new Response('zoom out of range', { status: 400 });
  const maxCoord = 1 << z;
  if (x < 0 || x >= maxCoord || y < 0 || y >= maxCoord) {
    return new Response('xy out of range', { status: 400 });
  }

  const manifest = await loadManifest(env);
  if (!manifest) return new Response('manifest unavailable', { status: 503 });

  const result = await readTile(
    env.TILES as unknown as {
      get(
        key: string,
        options: { range: { offset: number; length: number } },
      ): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
    },
    manifest.pmtilesKey,
    z,
    x,
    y,
    { cache: pmtilesCache },
  );

  if (!result) {
    // Empty 204: most MapLibre/kami clients treat missing tiles as transparent.
    return new Response(null, {
      status: 204,
      headers: {
        'Cache-Control': 'public, max-age=3600',
        'X-PMTiles-Version': manifest.version,
      },
    });
  }

  const headers = new Headers({
    'Content-Type': 'application/vnd.mapbox-vector-tile',
    // Client cache 1 d, edge cache 7 d (versioned manifest flips on rebuild).
    'Cache-Control': 'public, max-age=86400, s-maxage=604800',
    'X-PMTiles-Version': manifest.version,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD',
  });

  // CF Worker response cap is 25 MiB; OMT z14 tiles are typically < 200 KiB,
  // so we never approach the limit. Still: defensive log if we somehow do.
  if (result.bytes.byteLength > 10 * 1024 * 1024) {
    console.warn(`tile ${z}/${x}/${y} is ${result.bytes.byteLength} bytes — suspiciously large`);
  }

  const body = result.bytes.slice().buffer;
  return new Response(body, { status: 200, headers });
}

async function serveStyle(req: Request, env: Env): Promise<Response> {
  const cacheKey = 'style:v1';
  const ttl = Number(env.TILE_MANIFEST_TTL_SECONDS || '60');
  const cached = await env.TILE_MANIFEST.get(cacheKey);
  if (cached) {
    return new Response(cached, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${ttl}`,
      },
    });
  }
  const origin = new URL(req.url).origin;
  const style = buildStyleJson(origin, env.TILE_ATTRIBUTION);
  const body = JSON.stringify(style);
  await env.TILE_MANIFEST.put(cacheKey, body, { expirationTtl: Math.max(ttl, 60) });
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${ttl}`,
    },
  });
}

async function loadManifest(env: Env): Promise<TileManifest | null> {
  const cacheKey = env.TILE_MANIFEST_KEY || 'manifest:v1';
  const ttl = Number(env.TILE_MANIFEST_TTL_SECONDS || '60');

  const cached = await env.TILE_MANIFEST.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached) as TileManifest;
    } catch {
      // fall through to R2 on parse error
    }
  }
  const r2Key = env.TILE_R2_MANIFEST_KEY || 'v1/manifest.json';
  const obj = await env.TILES.get(r2Key);
  if (!obj) return null;
  const text = await obj.text();
  try {
    const parsed = JSON.parse(text) as TileManifest;
    await env.TILE_MANIFEST.put(cacheKey, text, { expirationTtl: Math.max(ttl, 60) });
    return parsed;
  } catch {
    return null;
  }
}

// ── MapLibre style (minimal; kami-bridge ignores it) ─────────────────────────

function buildStyleJson(origin: string, attribution: string): Record<string, unknown> {
  return {
    version: 8,
    name: 'etzhayyim-openmaptiles',
    glyphs: `${origin}/fonts/{fontstack}/{range}.pbf`, // not served — placeholder
    sources: {
      openmaptiles: {
        type: 'vector',
        tiles: [`${origin}/v1/{z}/{x}/{y}.pbf`],
        minzoom: 0,
        maxzoom: 14,
        attribution,
      },
    },
    // Layer list identical to the kami-openmaptiles-style mapping (TS side
    // re-derives these, but we publish them here for standard MapLibre users).
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#f7f4ec' } },
      { id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water',
        paint: { 'fill-color': '#a0c8e0', 'fill-opacity': 1.0 } },
      { id: 'landuse-park', type: 'fill', source: 'openmaptiles', 'source-layer': 'landuse',
        filter: ['==', 'class', 'park'],
        paint: { 'fill-color': '#c8e8b8', 'fill-opacity': 0.7 } },
      { id: 'landuse-residential', type: 'fill', source: 'openmaptiles', 'source-layer': 'landuse',
        filter: ['==', 'class', 'residential'],
        paint: { 'fill-color': '#e8e8d8', 'fill-opacity': 0.7 } },
      { id: 'landuse-industrial', type: 'fill', source: 'openmaptiles', 'source-layer': 'landuse',
        filter: ['==', 'class', 'industrial'],
        paint: { 'fill-color': '#d8d0c8', 'fill-opacity': 0.7 } },
      { id: 'transport-highway', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation',
        filter: ['==', 'class', 'motorway'],
        paint: { 'line-color': '#ffb86c', 'line-width': 3 } },
      { id: 'transport-railway', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation',
        filter: ['==', 'class', 'rail'],
        paint: { 'line-color': '#888888', 'line-width': 1 } },
      { id: 'transport-path', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation',
        filter: ['==', 'class', 'path'],
        paint: { 'line-color': '#aa8844', 'line-width': 1 } },
      { id: 'building', type: 'fill', source: 'openmaptiles', 'source-layer': 'building',
        paint: { 'fill-color': '#d0c8b8', 'fill-opacity': 0.9 } },
      { id: 'boundary', type: 'line', source: 'openmaptiles', 'source-layer': 'boundary',
        paint: { 'line-color': '#777777', 'line-width': 1 } },
      { id: 'place', type: 'circle', source: 'openmaptiles', 'source-layer': 'place',
        filter: ['in', 'class', 'city', 'town'],
        paint: { 'circle-color': '#333333', 'circle-radius': 3 } },
    ],
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra },
  });
}
