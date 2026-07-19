/**
 * kotoba-spatial — the kotoba-native data-access adapter for the maps spatial substrate.
 * ADR-2606064500. The migration leverage point (§3): the 172 maps commands all funnel
 * through `getDb().selectFrom("vertex_spatial")` / `.insertInto("vertex_spatial")`. This
 * adapter exposes the narrow surface they need, backed by the kotoba Datom log instead of
 * RisingWave, so the substrate swaps under one module rather than 172 rewrites.
 *
 * SPATIAL INDEX (§2 — H3-cell-as-Datom + AVET): every feature stores its owning H3 cell at
 * each queryable resolution (:feature.cell/rN). A getChunk read becomes, per requested cell,
 * an AVET probe `AVET(:feature.cell/r{lod}, <cell>) → subjects` — O(cells), never a bbox scan.
 *
 * FAIL-OPEN (§3): all reads/writes are best-effort. With KOTOBA_ENDPOINT unset (or on any
 * error) the functions return null, and the caller falls through to the legacy RisingWave
 * path untouched. This makes the cut-over additive and reversible until R3 removes RisingWave.
 *
 * NO-SERVER-KEY (§4 / ADR-2605231525): ingest is a member/operator-DID-signed CACAO batch
 * (KOTOBA_AUTH bearer). The maps Worker never holds a platform signing key. Live ingest is
 * additionally outward-gated (MAPS_OPERATOR_GATE) — R0 ships reads only.
 */
import { latLngToCell } from "h3-js";
import type { AnyRow } from "./geometry";

/** H3 resolutions the client queries — the app's zoom→LOD ladder (ontology §2). */
export const CELL_RESOLUTIONS = [2, 4, 6, 8, 10, 12] as const;
export type CellRes = (typeof CELL_RESOLUTIONS)[number];

/**
 * legacy vertex_spatial.label (PascalCase) ↔ kotoba :feature/label keyword (lowercase-kebab).
 * MUST stay in lockstep with methods/ingest.py `_LABEL_MAP` — the read filter, the write path,
 * and the Python ingest all have to agree on the stored keyword, or AVET(:feature/label, …)
 * matches nothing. The reverse map restores the PascalCase the client keys its render layers
 * by, so a kotoba-served chunk is byte-identical to a RisingWave-served one.
 */
const LABEL_TO_KEYWORD: Record<string, string> = {
  Place: ":place", Road: ":road", Railway: ":railway", Building: ":building",
  River: ":river", Lake: ":lake", Coastline: ":coastline", AdminArea: ":admin-area",
  Mountain: ":mountain", Port: ":port", Airport: ":airport", Station: ":station",
  BusStop: ":bus-stop", BusRoute: ":bus-route", SeaRoute: ":sea-route", AirRoute: ":air-route",
  LegalEntity: ":legal-entity", LandRegistry: ":registry", SatelliteScene: ":satellite-scene",
  Spot: ":place",
};
const KEYWORD_TO_LABEL: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const [label, kw] of Object.entries(LABEL_TO_KEYWORD)) if (!(kw in m)) m[kw] = label; // first wins
  return m;
})();

/** Fold a legacy PascalCase label (or an already-keyworded one) to its :feature/label keyword. */
export function foldLabel(label: string): string {
  if (label.startsWith(":")) return label;
  return LABEL_TO_KEYWORD[label] ?? `:${label.trim().toLowerCase().replace(/\s+/g, "-")}`;
}
/** Restore the PascalCase label the client render layers are keyed by, from a keyword. */
export function legacyLabel(keyword: string): string {
  const kw = keyword.startsWith(":") ? keyword : `:${keyword}`;
  return KEYWORD_TO_LABEL[kw] ?? keyword.replace(/^:/, "");
}

const KOTOBA_TIMEOUT_MS = 1200;
const KG_ENTITY_NSID = "com.etzhayyim.apps.kotobase.kg.entity";
const KG_QUERY_NSID = "com.etzhayyim.apps.kotoba.graph.sparql";
const KG_INGEST_NSID = "com.etzhayyim.apps.kotobase.kg.ingest_batch";

export interface KotobaSpatialEnv {
  KOTOBA_ENDPOINT?: unknown;
  KOTOBA_AUTH?: unknown;
  MAPS_OPERATOR_GATE?: unknown;
}

/** The kotoba HTTP base, or null when maps is not (yet) wired to a kotoba endpoint. */
export function kotobaEndpoint(env: KotobaSpatialEnv): string | null {
  const base = typeof env.KOTOBA_ENDPOINT === "string" ? env.KOTOBA_ENDPOINT.trim() : "";
  return base ? base.replace(/\/+$/, "") : null;
}

/**
 * The owning H3 cell of a centroid at every queryable resolution — the spatial index keys.
 * Computed with latLngToCell(lat, lon, r) DIRECTLY at each resolution (NOT cellToParent of a
 * res-15 cell): H3 is not perfectly hierarchical, so the direct owning cell is what the
 * client computes for the visible cells it queries — ingest stamp and query key must use the
 * identical method or a feature stamped under cell A could be queried under cell B and missed.
 * This is the production cell stamp the Python ingest.py defers to when `h3` is not installed
 * (ADR-2606064500 §3) — methods/ingest.py uses latlng_to_cell at each res identically.
 */
export function stampCells(lat: number, lon: number): Record<string, string> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return {};
  const out: Record<string, string> = {};
  for (const r of CELL_RESOLUTIONS) out[`feature.cell/r${r}`] = latLngToCell(lat, lon, r);
  return out;
}

interface KgClaim { pred?: string; value?: unknown }

/** Flatten a kotoba feature entity's claims into the AnyRow shape cmdGetChunk consumes. */
export function entityToRow(entity: Record<string, unknown>): AnyRow | null {
  const id = typeof entity.id === "string" ? entity.id
    : typeof entity.entity_id === "string" ? entity.entity_id : null;
  if (!id) return null;
  const claims: KgClaim[] = Array.isArray(entity.claims) ? (entity.claims as KgClaim[]) : [];
  const row: Record<string, unknown> = { vertex_id: id, did: null };
  for (const c of claims) {
    if (!c || typeof c.pred !== "string") continue;
    const p = c.pred.startsWith("feature/") ? c.pred.slice("feature/".length) : c.pred;
    const v = c.value;
    switch (p) {
      // restore the PascalCase label the client keys its render layers by (kotoba stores the
      // kebab keyword; a RisingWave row carried "Building", so a kotoba row must too)
      case "label":        row.label = typeof v === "string" ? legacyLabel(v) : v; break;
      case "name":         row.name = v; break;
      case "display-name": row.display_name = v; break;
      case "category":     row.category = v; break;
      case "status":       row.status = typeof v === "string" ? v.replace(/^:/, "") : v; break;
      case "source-did":   row.source_did = v; row.did = v; break;
      case "lat":          row.lat = typeof v === "string" ? Number(v) : v; break;
      case "lon":          row.lng = typeof v === "string" ? Number(v) : v; break;
      // MERGE the props bag into the props object (never overwrite — geometry may already be
      // there; the geometry claim can arrive before OR after this one)
      case "props":        mergePropsBag(row, v); break;
      case "geometry":     mergeGeometryIntoProps(row, v); break;
      case "height-m":     mergePropsKey(row, "heightM", typeof v === "string" ? Number(v) : v); break;
      case "levels":       mergePropsKey(row, "levels", typeof v === "string" ? Number(v) : v); break;
      default: break; // cell attrs etc. are index keys, not row fields
    }
  }
  return row as AnyRow;
}

function ensurePropsObject(row: Record<string, unknown>): Record<string, unknown> {
  if (typeof row.props === "string") {
    try { row.props = JSON.parse(row.props); } catch { row.props = {}; }
  }
  if (typeof row.props !== "object" || row.props === null) row.props = {};
  return row.props as Record<string, unknown>;
}
function mergePropsBag(row: Record<string, unknown>, bag: unknown) {
  const p = ensurePropsObject(row);
  let obj: unknown = bag;
  if (typeof bag === "string") { try { obj = JSON.parse(bag); } catch { return; } }
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k === "geometry" && p.geometry !== undefined) continue; // don't clobber a parsed geometry
      p[k] = v;
    }
  }
}
function mergeGeometryIntoProps(row: Record<string, unknown>, geom: unknown) {
  const p = ensurePropsObject(row);
  if (typeof geom === "string") { try { p.geometry = JSON.parse(geom); } catch { /* skip */ } }
  else if (geom && typeof geom === "object") p.geometry = geom;
}
function mergePropsKey(row: Record<string, unknown>, key: string, val: unknown) {
  if (val === undefined || (typeof val === "number" && !Number.isFinite(val))) return;
  ensurePropsObject(row)[key] = val;
}

async function postJson(url: string, body: unknown, auth?: string): Promise<unknown | null> {
  try {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    if (auth) headers.authorization = `Bearer ${auth}`;
    const res = await fetch(url, {
      method: "POST", headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(KOTOBA_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/**
 * The getChunk hot-path read (§2). For each requested H3 cell at res=lod, AVET-probe the
 * features owning that cell, filtered by label. Returns rows shaped for cmdGetChunk, or null
 * on any failure (caller falls through to RisingWave — fail-open §3).
 *
 * The query is issued as an AVET predicate+object lookup over the kotoba graph endpoint. The
 * live endpoint wiring is R1/operator-gated; until KOTOBA_ENDPOINT is set this returns null
 * and the legacy path serves unchanged.
 */
export async function queryByCells(
  env: KotobaSpatialEnv,
  opts: { cells: string[]; lod: number; labels: string[]; limit: number },
): Promise<AnyRow[] | null> {
  const base = kotobaEndpoint(env);
  if (!base) return null;
  const res = Math.round(opts.lod);
  // only the stamped resolutions are indexed; any other lod has no cells → fall through to
  // RisingWave rather than return a false-empty (§2 ladder; S2)
  if (!(CELL_RESOLUTIONS as readonly number[]).includes(res)) return null;
  const cellPred = `feature.cell/r${res}`;
  // AVET cell probe per requested cell, label-filtered. Shaped as a structured graph query;
  // the kotoba planner routes (cellPred, cell) → AVET → subjects. Labels are folded to the
  // stored :feature/label keyword (PascalCase "Building" → ":building") — B1.
  const query = {
    index: "avet",
    predicate: cellPred,
    objects: opts.cells,
    filter: { predicate: "feature/label", in: opts.labels.map(foldLabel) },
    select: ["feature/label", "feature/name", "feature/display-name", "feature/category",
             "feature/status", "feature/source-did", "feature/lat", "feature/lon",
             "feature/geometry", "feature/height-m", "feature/levels", "feature/props"],
    limit: opts.limit,
  };
  const body = await postJson(`${base}/xrpc/${KG_QUERY_NSID}`, query, asString(env.KOTOBA_AUTH));
  if (!body || typeof body !== "object") return null;
  const entities = (body as { entities?: unknown }).entities
    ?? (body as { rows?: unknown }).rows
    ?? (body as { results?: unknown }).results;
  if (!Array.isArray(entities)) return null;
  const rows: AnyRow[] = [];
  for (const e of entities) {
    if (e && typeof e === "object") {
      const row = entityToRow(e as Record<string, unknown>);
      if (row) rows.push(row);
    }
  }
  return rows;
}

/** Point lookup by feature id (EAVT). Fail-open. */
export async function getFeature(env: KotobaSpatialEnv, id: string): Promise<AnyRow | null> {
  const base = kotobaEndpoint(env);
  if (!base) return null;
  try {
    const url = `${base}/xrpc/${KG_ENTITY_NSID}?id=${encodeURIComponent(id)}`;
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(KOTOBA_TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    const entity = (body.entity && typeof body.entity === "object") ? body.entity as Record<string, unknown> : body;
    return entityToRow(entity);
  } catch { return null; }
}

export interface FeatureInput {
  vertex_id?: string; id?: string;
  label?: string; name?: string; display_name?: string; category?: string;
  status?: string; source_did?: string;
  lat?: number; lng?: number; lon?: number;
  height_m?: number; levels?: number;
  geometry?: unknown; props?: unknown;
}

/** Build the kg.ingest_batch body for a set of features, stamping the H3-cell index (§2). */
export function buildIngestBatch(features: FeatureInput[]): { entities: unknown[] } {
  const entities = features.map((f) => {
    const id = f.vertex_id ?? f.id;
    const lat = f.lat, lon = f.lng ?? f.lon;
    const claims: { pred: string; value: string }[] = [];
    const push = (pred: string, value: unknown) => {
      if (value === undefined || value === null || value === "") return;
      claims.push({ pred, value: String(value) });
    };
    push("feature/label", f.label ? foldLabel(f.label) : undefined); // kebab keyword, matches ingest.py
    push("feature/name", f.name);
    push("feature/display-name", f.display_name);
    push("feature/category", f.category);
    push("feature/status", f.status);
    push("feature/source-did", f.source_did);
    push("feature/sourcing", ":representative");
    if (Number.isFinite(lat as number)) push("feature/lat", lat);
    if (Number.isFinite(lon as number)) push("feature/lon", lon);
    if (Number.isFinite(f.height_m as number)) push("feature/height-m", f.height_m);
    if (Number.isFinite(f.levels as number)) push("feature/levels", f.levels);
    if (f.geometry !== undefined) push("feature/geometry", JSON.stringify(f.geometry));
    if (f.props !== undefined) push("feature/props", typeof f.props === "string" ? f.props : JSON.stringify(f.props));
    // the spatial index keys
    if (Number.isFinite(lat as number) && Number.isFinite(lon as number)) {
      for (const [k, v] of Object.entries(stampCells(lat as number, lon as number))) push(k, v);
    }
    return { id, type: "maps-feature", label_en: f.name ?? f.display_name ?? id, claims, relations: [] };
  });
  return { entities };
}

/**
 * Write features to the kotoba Datom log via kg.ingest_batch. Outward-gated (§4/§7):
 * refuses unless MAPS_OPERATOR_GATE=1 AND a KOTOBA_AUTH member/operator bearer is present
 * (no-server-key — the Worker never signs). Returns the count written, or null on
 * gate-refusal / failure (caller keeps the legacy write path).
 */
export async function ingestFeatures(env: KotobaSpatialEnv, features: FeatureInput[]): Promise<number | null> {
  const base = kotobaEndpoint(env);
  const auth = asString(env.KOTOBA_AUTH);
  if (!base) return null;
  if (String(env.MAPS_OPERATOR_GATE) !== "1" || !auth) return null; // G7 + G4: gated, member-signed
  const batch = buildIngestBatch(features);
  const body = await postJson(`${base}/xrpc/${KG_INGEST_NSID}`, batch, auth);
  return body ? batch.entities.length : null;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}
