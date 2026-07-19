/**
 * Dual-path shim for the maps etzhayyim cutover (cutover runbook Stage 2
 * + Stage 3, etzhayyim-root@90-docs/maps-etzhayyim-cutover-runbook.md).
 *
 * Two independent gates, both fire-and-forget — failures must never break
 * the vendor write/read path:
 *
 *   MAPS_DUAL_WRITE_ETZHAYYIM=1
 *     Every successful vertex_spatial INSERT also produces an
 *     com.etzhayyim.maps.feature record on the etzhayyim PDS so the new
 *     substrate accumulates a live mirror.
 *
 *   MAPS_SHADOW_ETZHAYYIM=1
 *     Every tileGeoJson read fires a parallel query against the etzhayyim
 *     reader URL and logs a parity metric line (count delta). Vendor result
 *     is what the client gets — the etzhayyim result is observational only.
 *
 * Env (CF Worker bindings):
 *   MAPS_DUAL_WRITE_ETZHAYYIM, MAPS_SHADOW_ETZHAYYIM        : "1" to enable
 *   MAPS_ETZ_PDS_URL              default https://pds.etzhayyim.com
 *   MAPS_ETZ_PDS_HANDLE           required for dual-write
 *   MAPS_ETZ_PDS_APP_PASSWORD     required for dual-write
 *   MAPS_ETZ_TILE_URL             default https://maps.etzhayyim.com/xrpc/com.etzhayyim.maps.tileGeoJson
 *   MAPS_ETZ_SHADOW_SAMPLE_PCT    default 100 (sample every shadow read)
 */

const COLLECTION = "com.etzhayyim.maps.feature";

interface MirrorEnv {
  MAPS_DUAL_WRITE_ETZHAYYIM?: string;
  MAPS_SHADOW_ETZHAYYIM?: string;
  MAPS_ETZ_PDS_URL?: string;
  MAPS_ETZ_PDS_HANDLE?: string;
  MAPS_ETZ_PDS_APP_PASSWORD?: string;
  MAPS_ETZ_TILE_URL?: string;
  MAPS_ETZ_SHADOW_SAMPLE_PCT?: string;
}

export function isDualWriteEnabled(env: MirrorEnv | undefined): boolean {
  return env?.MAPS_DUAL_WRITE_ETZHAYYIM === "1";
}

export function isShadowReadEnabled(env: MirrorEnv | undefined): boolean {
  return env?.MAPS_SHADOW_ETZHAYYIM === "1";
}

// --- PDS session cache (per-isolate) ---------------------------------------

interface Session {
  did: string;
  accessJwt: string;
  refreshJwt: string;
}

let session: Session | null = null;
let sessionInflight: Promise<Session> | null = null;

async function createSession(env: MirrorEnv): Promise<Session> {
  const handle = env.MAPS_ETZ_PDS_HANDLE;
  const password = env.MAPS_ETZ_PDS_APP_PASSWORD;
  if (!handle || !password) {
    throw new Error("MAPS_ETZ_PDS_HANDLE / MAPS_ETZ_PDS_APP_PASSWORD not configured");
  }
  const pds = env.MAPS_ETZ_PDS_URL ?? "https://pds.etzhayyim.com";
  const res = await fetch(`${pds}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: handle, password }),
  });
  if (!res.ok) {
    throw new Error(`createSession ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as Session;
  return data;
}

async function getSession(env: MirrorEnv): Promise<Session> {
  if (session) return session;
  if (sessionInflight) return sessionInflight;
  sessionInflight = createSession(env)
    .then((s) => {
      session = s;
      sessionInflight = null;
      return s;
    })
    .catch((e) => {
      sessionInflight = null;
      throw e;
    });
  return sessionInflight;
}

// --- Vendor → etzhayyim record projection ---------------------------------

interface VendorRecord {
  /** Vendor maps domain record (post-normalization, pre-vertex_spatial). */
  geometry?: unknown;
  geometryGeoJson?: unknown;
  h3Cell?: unknown;
  h3Resolution?: unknown;
  bboxWestE7?: unknown;
  bboxSouthE7?: unknown;
  bboxEastE7?: unknown;
  bboxNorthE7?: unknown;
  name?: unknown;
  sourceDid?: unknown;
  createdAt?: unknown;
  [k: string]: unknown;
}

function projectVendorToEtzhayyim(label: string, rec: VendorRecord): Record<string, unknown> | null {
  // geometry: vendor records may store as object (preferred) or string (legacy).
  let geometryGeoJson: string | null = null;
  if (typeof rec.geometryGeoJson === "string") {
    geometryGeoJson = rec.geometryGeoJson;
  } else if (rec.geometry && typeof rec.geometry === "object") {
    geometryGeoJson = JSON.stringify(rec.geometry);
  } else if (typeof rec.geometry === "string") {
    geometryGeoJson = rec.geometry;
  }
  if (!geometryGeoJson) return null;

  const h3Cell = typeof rec.h3Cell === "string" ? rec.h3Cell : null;
  const h3Resolution =
    typeof rec.h3Resolution === "number"
      ? rec.h3Resolution
      : Number.isFinite(Number(rec.h3Resolution))
        ? Number(rec.h3Resolution)
        : null;
  if (!h3Cell || h3Resolution == null) return null;

  const out: Record<string, unknown> = {
    $type: COLLECTION,
    label,
    geometryGeoJson,
    h3Cell,
    h3Resolution,
  };
  for (const key of ["bboxWestE7", "bboxSouthE7", "bboxEastE7", "bboxNorthE7"] as const) {
    const v = rec[key];
    if (typeof v === "number") out[key] = v;
  }
  if (typeof rec.name === "string") out.name = rec.name;
  if (typeof rec.sourceDid === "string") out.sourceDid = rec.sourceDid;
  if (typeof rec.createdAt === "string") out.createdAt = rec.createdAt;
  // Any extra vendor fields land in `properties` JSON-string.
  const known = new Set([
    "geometry", "geometryGeoJson", "h3Cell", "h3Resolution",
    "bboxWestE7", "bboxSouthE7", "bboxEastE7", "bboxNorthE7",
    "name", "sourceDid", "createdAt", "$type", "label",
  ]);
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (!known.has(k) && v !== undefined && v !== null) extras[k] = v;
  }
  if (Object.keys(extras).length) out.properties = JSON.stringify(extras);
  return out;
}

// --- Public: dual-write ----------------------------------------------------

/**
 * Fire-and-forget mirror write to the etzhayyim PDS. The caller's
 * promise must not depend on this — it logs and swallows all errors.
 * Returns immediately; the underlying fetch runs in the background.
 */
export function mirrorVertexWrite(
  env: MirrorEnv | undefined,
  collection: string,
  rec: VendorRecord,
  label: string,
): void {
  if (!env || !isDualWriteEnabled(env)) return;
  const body = projectVendorToEtzhayyim(label, rec);
  if (!body) {
    console.warn(`[etzhayyim-mirror] skip unprojectable ${collection}`);
    return;
  }
  void (async () => {
    try {
      const ses = await getSession(env);
      const pds = env.MAPS_ETZ_PDS_URL ?? "https://pds.etzhayyim.com";
      const res = await fetch(`${pds}/xrpc/com.atproto.repo.createRecord`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ses.accessJwt}`,
        },
        body: JSON.stringify({ repo: ses.did, collection: COLLECTION, record: body }),
      });
      if (res.status === 401) {
        session = null;
        console.warn(`[etzhayyim-mirror] DUAL_WRITE_DELTA 401 token-stale; will refresh next call`);
        return;
      }
      if (!res.ok) {
        const txt = (await res.text()).slice(0, 200);
        console.warn(`[etzhayyim-mirror] DUAL_WRITE_DELTA write-failed status=${res.status} ${txt}`);
        return;
      }
      console.log(`[etzhayyim-mirror] dual-wrote ${collection} label=${label}`);
    } catch (e) {
      console.warn(`[etzhayyim-mirror] DUAL_WRITE_DELTA crash ${(e as Error).message?.slice(0, 200)}`);
    }
  })();
}

// --- Public: shadow read ---------------------------------------------------

interface VendorTileResult {
  layers: Record<string, { type: "FeatureCollection"; features: unknown[] }>;
  total: number;
}

interface TileQueryParams {
  west: number;
  south: number;
  east: number;
  north: number;
  labels: string[];
}

/**
 * Fire-and-forget parallel query against the etzhayyim reader. Compares
 * total record counts and emits a single parity log line. Does NOT modify
 * the vendor response.
 */
export function shadowTileGeoJsonRead(
  env: MirrorEnv | undefined,
  vendor: VendorTileResult,
  params: TileQueryParams,
): void {
  if (!env || !isShadowReadEnabled(env)) return;
  const samplePct = Number(env.MAPS_ETZ_SHADOW_SAMPLE_PCT ?? "100");
  if (samplePct < 100 && Math.random() * 100 >= samplePct) return;

  const tileUrl =
    env.MAPS_ETZ_TILE_URL ??
    "https://maps.etzhayyim.com/xrpc/com.etzhayyim.maps.tileGeoJson";

  void (async () => {
    try {
      const url = new URL(tileUrl);
      url.searchParams.set("westE7", String(Math.round(params.west * 1e7)));
      url.searchParams.set("southE7", String(Math.round(params.south * 1e7)));
      url.searchParams.set("eastE7", String(Math.round(params.east * 1e7)));
      url.searchParams.set("northE7", String(Math.round(params.north * 1e7)));
      for (const lab of params.labels) url.searchParams.append("labels", lab);
      const startMs = Date.now();
      const res = await fetch(url.toString());
      const latencyMs = Date.now() - startMs;
      if (!res.ok) {
        console.warn(
          `[etzhayyim-mirror] SHADOW_PARITY etz-status=${res.status} vendor-total=${vendor.total} latency-ms=${latencyMs}`,
        );
        return;
      }
      const body = (await res.json()) as { total?: number; layers?: string };
      const etzTotal = Number(body.total ?? 0);
      const vendorTotal = vendor.total;
      const ratio = vendorTotal > 0 ? etzTotal / vendorTotal : etzTotal === 0 ? 1 : Infinity;
      // Per-label breakdown helps spot which label is drifting.
      const vendorPerLabel = Object.fromEntries(
        Object.entries(vendor.layers).map(([l, fc]) => [l, fc.features.length]),
      );
      let etzPerLabel: Record<string, number> = {};
      try {
        const parsed = JSON.parse(body.layers ?? "{}") as Record<
          string,
          { features: unknown[] }
        >;
        etzPerLabel = Object.fromEntries(
          Object.entries(parsed).map(([l, fc]) => [l, fc.features.length]),
        );
      } catch {
        /* keep empty */
      }
      console.log(
        `[etzhayyim-mirror] SHADOW_PARITY vendor=${vendorTotal} etz=${etzTotal} ratio=${ratio.toFixed(3)} latency-ms=${latencyMs} per-label-vendor=${JSON.stringify(vendorPerLabel)} per-label-etz=${JSON.stringify(etzPerLabel)}`,
      );
    } catch (e) {
      console.warn(`[etzhayyim-mirror] SHADOW_PARITY crash ${(e as Error).message?.slice(0, 200)}`);
    }
  })();
}
