> **DEPRECATED**: Actor migrated to `orgs/etzhayyim/com-etzhayyim-maps/actor-manifest.jsonld` (T1 MCP-Compose). This project wasm/*/src/app.ts is retained as T3 fallback only.

# etzhayyim-project-maps

Spatial Intelligence + Digital Twin Platform (maps.etzhayyim.com). Graph-first architecture — 自前グラフを育て、データがない時だけ外部ソースから取得・永続化。全外部ソースは path-based DID で identity 管理。

## Rendering (2026-04-17, RisingWave-native + KAMI 3D)

**外部 MVT タイル依存は廃止。** ベクタレイヤは `com.etzhayyim.apps.maps.tileGeoJson` XRPC が `vertex_spatial` から bbox + labels で GeoJSON を返し、KAMI の GeoJSON layer path が描画する。旧 `tiles.maps.etzhayyim.com` MVT 経路は `kami-bridge.ts` が明示的にブロックリスト。

| 層 | 実装 |
|---|---|
| **Base raster** | `tile.openstreetmap.org/{z}/{x}/{y}.png` (KAMI `upload_tile`) — vectorTileUrl が空のとき自動で fallback |
| **Vector overlay (2D)** | `svelte/src/lib/risingwave-overlay.ts` → `com.etzhayyim.apps.maps.tileGeoJson` XRPC → KAMI `addSource(geojson)` + `addLayer(line|fill|circle)` for AdminArea / Coastline / River / Road / Railway / Place |
| **3D extrusion** | viewport diagonal < **500 km** で `Building` / `Mountain` / `Port` / `Airport` / `Station` を `KamiMapBridge.addExtrudeLayer(id, rings, heights, color, opacity)` に送信。KAMI WASM `add_extrude_layer` が earcut roof + 4 辺 sidewall triangles を生成。`heightM` (props) > `levels×3` > default heights の順で解決 |
| **Camera** | Flat mode orthographic に pitch/bearing を Mat4 rotation で適用 (kami-map/src/lib.rs `update_camera_uniform`)。bootstrap で `setPitch(45)` を default 適用。以前 pitch は stored but unused |

### XRPC Contract

- `com.etzhayyim.apps.maps.tileGeoJson` (query) — input `{west, south, east, north, labels[], zoom, limit}`, output `{layers: {[label]: FeatureCollection}, bbox, total}`. 単一クエリ `WHERE label IN (...)` で 1 Hyperdrive round-trip
- `com.etzhayyim.apps.maps.seedBuildings` (procedure) — input `{lat, lng, radiusM, maxBuildings}` → `{written}`. OSM Overpass `way["building"](bbox)` + `out geom tags` で footprint + height/levels を取得、`vertex_spatial` Building 行として永続化
- Heartbeat auto-seed: 4 heartbeat ごと (≈20 min) に `INFRA_SEED_CITIES` を rotate、最大 200 棟/cycle

### KAMI WASM API (新規)

```ts
// TypeScript (kami-bridge wrapper)
map.addExtrudeLayer(id, rings, heights, color = '#78716c', opacity = 0.85);

// Rust (kami-map/src/lib.rs)
pub fn add_extrude_layer(&mut self, id: &str, rings_json: &str, heights_json: &str, color_hex: &str, opacity: f32) -> Result<(), JsValue>;

// Rust (kami-geo/src/mesh.rs)
pub fn polygon_to_extrude_earcut(ring: &[[f64;2]], zoom: f64, center: WorldPx, base: f32, height: f32) -> GeoMesh;
```

### Write Path (2026-04-22, ADR-0036)

**PDS + graph-worker bypass.** 全 `com.etzhayyim.apps.maps.*` domain write は `createKyselyDb(env.HYPERDRIVE).insertInto("vertex_spatial")` で直接 INSERT。entity → label は `src/vertex-spatial-projection.ts` (`mapsEntityToLabel`) が担当、graph-worker の convention と同一。ON CONFLICT (vertex_id) DO UPDATE でべき等。Social derive (`sdk.pds.dispatch({type:"app.bsky.feed.post",...})`) は ADR-0036 で PDS 経由維持。Cross-actor `sdk.pds.dispatch({type:"invoke",...})` も維持 (storage ではなく RPC)。

### Forward Topology: H3 Chunk Overlay (Phase 1+2+3 shipped 2026-04-17)

現在の basemap は依然 OSM `tile.openstreetmap.org` PNG pyramid を使用中だが、**ベクタ + 3D 層は H3-indexed chunk graph に移行済み**。XYZ pyramid 依存は client cache key と update 経路からは排除。

→ 設計: **`90-docs/260417-maps-forward-topology-raw-to-webgpu.md`**

| 要素 | 実装 |
|---|---|
| **XRPC** `com.etzhayyim.apps.maps.getChunk` | input `{h3Cells[], lod, labels[], limit}` → output `{chunks: {[h3Cell]: {[label]: Feature[]}}}`. cellToBoundary → union bbox → 1 query → centroid → owning cell にルーティング |
| **Client cache** `svelte/src/lib/chunk-overlay.ts` | visibleH3Cells (polygonToCells) + LRU 1024 + 64 cell/request バッチ。cache key = h3Cell (pan で stable)。旧 bbox-per-moveend の `risingwave-overlay.ts` を置換 |
| **Zoom → LOD** | zoom `<3/3/6/10/14/17+` → H3 res `2/4/6/8/10/12` (`zoomToLod`) |
| **3D 依然動作** | viewport 500km rule + `addExtrudeLayer` は変更なく、chunk-overlay 側に再実装 |

### Gsplat Preview / QC + Mapillary trainer (ADR-2605092800, 2026-05-09)

3D Gaussian Splatting は **runtime 配信形式に採用しない** (260416 design 維持)。
landmark / 局所再構成の preview / QC 用途のみ。

| 部品 | 場所 | 状態 |
|---|---|---|
| Renderer | `kami_pipelines::GsplatAdapter` (`40-engine/kami-engine/kami-pipelines/src/gsplat.rs`) | shipped — CPU sort + WGSL EWA falloff、≤50k splats / tile cap、**SH degree 0–3 view-dependent evaluation (Inria coeffs, `f_rest_*` storage buffer at bind 3)** — `exportRest=true` で訓練した splat が browser preview で specular する |
| WASM bind | `kami-app-maps3d::set_gsplat_asset / remove_gsplat_asset` | shipped |
| Schema | `vertex_maps_gsplat_asset` + `edge_maps_gsplat_baked_to` (Alembic `r_20260509220000_vertex_maps_gsplat_asset`) | shipped |
| XRPC | `com.etzhayyim.apps.maps.{getGsplatAsset,listGsplatAssets,bakeGsplatAsset,trainGsplatFromMapillary}` | shipped |
| SDK | `@etzhayyim/kami-engine-sdk/gsplat` (`loadGsplatAsset` / `pushToWasm` / `bakeGsplatAsset`) | shipped |
| HTML toggle | `svelte/static/maps-3d.htm?gsplat=1` + 「📷 Train splat here」 button | shipped — 1-ring H3 res-12 prefetch, negative-cache on 404 |
| Trainer endpoint (RunPod) | `runpod-endpoint-gsplat/{handler.py,Dockerfile,Dockerfile.phase2,requirements.txt,requirements-phase2.txt}` | **shipped Phase 1 stub + Phase 2 real trainer + bake mode**. Phase 2 train = Mapillary download + COLMAP SfM (`pycolmap.extract_features` + `match_exhaustive` + `incremental_mapping`) + gsplat training (`gsplat==1.4.0`, **`DefaultStrategy` densification (clone+split+prune)**, **`shDegree ∈ [0,3]`**, opacity-cull at half-step, 50k splat cap). PLY in our renderer's `f_dc/scale/rot` schema; optional `f_rest_*` (`exportRest=true`) for SuperSplat / Inria viewer compat. Phase 2 bake = TSDF fusion (Open3D `ScalableTSDFVolume.integrate` over 24 fibonacci-sphere `RGB+D` views from gsplat) → `simplify_quadric_decimation(5000)` → trimesh GLB. Toggle via `RUNPOD_PHASE=2` + GPU `Dockerfile.phase2`. Mode dispatch via payload `mode: "train" \| "bake"` (default train) |
| Bake mesh registry | `vertex_maps_gsplat_mesh` + `edge_maps_gsplat_baked_to` (Alembic `r_20260510120000_vertex_maps_gsplat_mesh`) | shipped — append-only, lineage edge from splat asset → baked mesh |
| Bake BPMN | `etzhayyim-root/orgs/etzhayyim/com-etzhayyim-maps/wire/bpmn/maps/bakeGsplatAsset.bpmn` | shipped — message-start, correlationKey=tileH3, dispatches to dumper `/trigger/bake` |
| Worker bake handler | `cmdGetGsplatAsset` JOIN `vertex_maps_gsplat_mesh` returns `bakedMesh` + `bakedMeshUrl`; `cmdBakeGsplatAsset` already publishes the BPMN message | shipped |
| HTML bake consumer | `svelte/static/maps-3d.htm` calls `set_mesh_tile(tileH3, glb)` whenever `bakedMeshUrl` is present in the splat fetch response | shipped — same 1-ring H3 res-12 prefetch loop as splat preview |
| Job state log | `vertex_maps_gsplat_job` + `mv_maps_gsplat_job_latest` (Alembic `r_20260510130000_*`) | shipped — append-only phase events (queued/running/completed/failed × per-phase string), 7-day window MV |
| Auto-chain train→bake | dumper pod self-targets `/trigger/bake` after train INSERT (skip via `autoBake:false` in train payload). Bypasses LangServer so a working dumper alone produces both splat + mesh | shipped |
| Quality metrics | train handler holds out 10% of registered views (cap 8), reports `evalL1` / `evalPsnr` / `registeredRatio` in `stats` | shipped |
| Status XRPC | `com.etzhayyim.apps.maps.{getGsplatJobStatus,listGsplatJobs}` reads `mv_maps_gsplat_job_latest` for sub-ms hot path | shipped |
| UI status polling | maps-3d.htm: 「📷 Train splat here」 + 「🔨 Bake mesh here」 buttons each spawn a 5-second poll loop on `getGsplatJobStatus(jobId)` until terminal state, surface phase + elapsed time + final detail in toast | shipped |
| Per-cloud cap | `kami_pipelines::MAX_SPLATS_PER_CLOUD` 50k → 100k (2026-05-10), `_MAX_SPLATS_OUT` in handler.py mirrored — fits 60 fps with M-series CPU sort. True GPU bitonic deferred until 200k+ scenes appear | shipped |
| Jobs HUD | `?jobs=1` (or `window.__maps3d_jobs=true`) shows the 10 most recent gsplat jobs top-right, polls `listGsplatJobs?limit=10` every 30 s. Off by default to avoid extra requests on prod | shipped |
| Auto-evict | `fetchAndPushGsplatTiles` tracks `gsplatLoaded` / `gsplatMeshLoaded` Sets and on each prefetch tick calls `remove_gsplat_asset(tileH3)` + `remove_mesh_tile(tileH3)` for any loaded tile outside the player's current H3 1-ring. Both splat + mesh GPU buffers now actually freed (mesh path was negative-cache-only in the first cut, fixed 2026-05-10) | shipped |
| B2 content-addressing | Dumper computes SHA-256 of PLY / GLB → `{prefix}/{ab}/{full-hash}.{ext}` (2-char prefix shard). `_b2_head` short-circuits identical re-uploads (re-running the same train/bake on the same input → 0 B uploaded). Matches root CLAUDE.md "Content-Addressed Blob Storage" rule | shipped |
| Bake gate consistency | `cmdBakeGsplatAsset` looks up the most recent `mv_maps_gsplat_job_latest` row for the tile and refuses (`error: bake refused: latest train was gated low-PSNR`) when the train was auto-skipped. Operator override via `force: true` in payload | shipped |
| Streaming-LOD splats | Dumper writes the PLY **opacity-descending**; HTML range-fetches `bytes=0-<targetBytes>` keyed by player→tile-centre distance. 4-tier ladder: <15 m=1.0 (full), 15-30 m=0.5, 30-60 m=0.25, >60 m=0.10. `set_gsplat_asset` already replaces by tile name so a closer-distance tier upgrade just re-issues the fetch. PLY loader's existing `if base+stride > body.len() break` short-circuit makes this format-clean — no schema change, no separate LOD blobs to bake | shipped |
| LOD byte budget | `MAX_BYTES_PER_LOD = {1.0:4MB, 0.5:2MB, 0.25:1MB, 0.10:512KB}` capped on top of the fraction so high-SH PLYs (degree=3 ≈ 4× degree=0 bytes/splat) don't blow far-tile bandwidth. For degree=0 the cap rarely binds; for degree=3 100k-splat tiles it caps at 16 % of total even on the closest tier | shipped |
| B2 immutable headers | Content-addressed uploads (PLY + GLB) carry `Cache-Control: public, max-age=86400, immutable`. Safe because SHA-256 keys imply content cannot change. Browsers cache full + Range responses, so re-entering a tile after walk-away → 0 B over the wire | shipped |
| GPU-side LOD | `kami_pipelines::GsplatAdapter::prepare` peeks at the closest splat distance (last entry of the back-to-front sort) and forces `sh_degree=0` in the uniform when > `FAR_SH_THRESHOLD_M = 50 m`. Saves ~30 fragment ops × N fragments per far tile (band-1..3 SH evaluation). View-dependent specular is barely visible past 50 m | shipped |
| Cache rewrite tool | `bulk-ingest/tools/rewrite_gsplat_cache_control.py` — boto3 paginator + `copy_object(MetadataDirective=REPLACE, CacheControl=immutable)` over `maps-bulk-ingest/gsplat*` prefixes. Idempotent (`already up-to-date` skip). One-shot operator run after this PR ships | shipped |
| Parallel 1-ring prefetch | maps-3d.htm: sequential `for (await fetch)` → `Promise.all(cells.map(async ...))` with per-tile try/catch. Drops 1-ring round-trip latency from ~7×RTT to ~1×RTT (HTTP/2 multiplex; HTTP/1.1 caps at 6 concurrent so 7-cell ring stays comfortably within budget) | shipped |
| Cost rollup | `vertex_maps_gsplat_job.cost_usd` column (Alembic `r_20260510140000_*`) + dumper extracts `stats.estimatedCostUsd` from RunPod response. New XRPC `getGsplatCostSummary` returns today/7d/30d totals partitioned by `job_kind`. Jobs HUD shows `$X.XX today · $Y 7d · $Z 30d` line above the row list | shipped |
| Per-tile lifetime spend cap | Both `cmdTrainGsplatFromMapillary` + `cmdBakeGsplatAsset` SUM(cost_usd) for the tile (completed jobs all-time) before publishing the BPMN message; refuse if ≥ `MAPS_GSPLAT_LIFETIME_CAP_USD` (default $10) with `lifetimeSpendUsd` + `capUsd` in error response. Operator override = `force: true` (already in lexicon) | shipped |
| Failure webhook | Dumper POSTs `{text:"..."}` (Slack + Discord compatible) to `GSPLAT_FAILURE_WEBHOOK_URL` env on `_run_train` / `_run_bake` exceptions, after the `_emit_job_state(failed)` row. Best-effort — webhook timeout ≤ 4 s, never masks the underlying job failure. No-op when env not set | shipped |
| Train idempotency | Dumper computes `sha256(",".join(sorted(imageIds)))` after Mapillary list, looks up `mv_maps_gsplat_job_latest` for a prior completed train with the same `(tile_h3, imageids_hash)`. Hit → emit `phase=skipped-duplicate` job-state row, skip RunPod (cost_usd=0), still auto-chain bake against the existing splat row. New `vertex_maps_gsplat_job.imageids_hash` column (Alembic `r_20260510150000_*`) | shipped |
| Trainer dumper pod (k8s) | `bulk-ingest/workers/gsplat_train_dumper.py` + `bulk-ingest/k8s/deployment-gsplat-train.yaml` | **shipped, replicas=0** — gated until operator wires `MAPILLARY_ACCESS_TOKEN` + `RUNPOD_API_KEY` + `RUNPOD_ENDPOINT_ID_GSPLAT` |
| BPMN process | `etzhayyim-root/orgs/etzhayyim/com-etzhayyim-maps/wire/bpmn/maps/trainGsplatFromMapillary.bpmn` | shipped — message-start, correlationKey=tileH3, dispatches to dumper `/trigger` |
| Bake pod (splat → mesh, k8s L8) | not implemented — contract only (`bakeGsplatAsset` enqueues LangServer message) | follow-up |

Runtime delivery は引き続き `mesh_tile` GLB (`maps3d.simplifyAndExport` BPMN)。
splat→mesh の bake pipeline (PLY → `gsplat` mesh extract → Open3D
quadric_decimation → KTX2 texture → `vertex_spatial.Building` upsert) は
`60-apps/etzhayyim-project-maps/bulk-ingest/workers/gsplat_bake_dumper.py` (TODO)
として別 PR で実装する。`edge_maps_gsplat_baked_to` で lineage を残す。

#### Mapillary trainer bring-up

ゲート解除 (operator):

1. `kubectl -n maps-bulk-ingest apply -f 60-apps/etzhayyim-project-maps/bulk-ingest/k8s/deployment-gsplat-train.yaml` (replicas=0 で適用)
2. RunPod template + Serverless endpoint を `runpod-endpoint-gsplat/README.md` 手順で作成、endpoint id を控える
3. `kubectl -n maps-bulk-ingest patch secret maps-bulk-ingest-credentials --type merge -p '{"stringData":{"RUNPOD_API_KEY":"…","RUNPOD_ENDPOINT_ID_GSPLAT":"…","MAPILLARY_ACCESS_TOKEN":"…"}}'`
4. `kubectl -n maps-bulk-ingest scale deploy/bulk-ingest-gsplat-train --replicas=1`
5. (BPMN) `bpmn-engine` deployer pod で `etzhayyim-root/orgs/etzhayyim/com-etzhayyim-maps/wire/bpmn/maps/trainGsplatFromMapillary.bpmn` を再 deploy

Phase 2 (real COLMAP + gsplat) への昇格 (2026-05-09 shipped):

```bash
cd 60-apps/etzhayyim-project-maps/runpod-endpoint-gsplat
IMAGE=ghcr.io/etzhayyim/maps-runpod-gsplat:phase2-$(date -u +%Y%m%d%H%M%S)
docker build --platform linux/amd64 -f Dockerfile.phase2 -t "$IMAGE" .
docker push "$IMAGE"
# RunPod template: image=$IMAGE, GPU=L40S 48GiB, Container Disk=30GB,
# Env: RUNPOD_PHASE=2 (template default already 2 in Dockerfile.phase2).
```

実コスト (L40S, `maxImages=80`/`maxSteps=7000`): COLMAP 3-8 min + gsplat
6-12 min ≈ 1 scene 10-20 min, $0.40-$0.80。Phase 2 は SH degree 0 / no
densification / opacity-cull at half-step / 50k splat cap で preview 品質。
高 fidelity が必要なら `gsplat.strategy.DefaultStrategy` を入れる operator
作業が follow-up。

### Phase 4: OSM.org PNG 依存除去 (partial, 2026-04-17)

**現況 (2026-04-20 browser verified)**: OSM `tile.openstreetmap.org` raster PNG fallback は zoom ≥ 7 で**継続使用中**。完全除去ではない。

- 低 zoom (0-6): Natural Earth ne_110m_land (138KB raw / 51KB gzip, public domain) を `svelte/static/basemap/world-land.geojson` にバンドル、KAMI `basemap-land-fill` 層 (`#2d3a2a`) として描画
- 高 zoom (≥ 7): `tile.openstreetmap.org/{z}/{x}/{y}.png` raster fallback に復帰 (`App.svelte:640`)
- DEM (全 zoom): `elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png` AWS Terrain Tiles 直接取得 (`App.svelte:630`)

**Blocker**: KAMI の earcut/shader precision で f32 が世界座標 1e6+ world-px のとき sign of cross を失う (Natural Earth fill が zoom ≥ 7 で不可視)。詳細と 2 通りの real fix 案は `deps.toml [[migrations]] maps-shader-view-precision` / `maps-landmass-earcut-precision`。

**Cosmetic 課題**: Antarctica polygon が antimeridian (±180°) を跨ぐため earcut 三角化が大きな三角形を生成。zoom 1-2 で visible。`[[migrations]] maps-antimeridian-polygon-split` で follow-up 追跡。

残タスク: Phase 4-proper (shader precision 修正で OSM PNG 完全除去)、Phase 5 (Satellite COG)、Phase 6 (Mapillary)、Phase 1-proper (H3 column back-fill)、subscribeChunks stream、`maps-dem-selfhost` (DEM 自前化)。`deps.toml [[migrations]] maps-forward-topology-raw-to-webgpu` (status: in-progress) 参照。

## App Identity

| Key | Value |
|---|---|
| **nanoid (UI)** | `uqpel6i6` |
| **nanoid (collection)** | `v1m9k2q8` |
| **domain** | `maps.etzhayyim.com` |
| **AT bot DID** | `did:web:maps.etzhayyim.com` |
| **Runtime** | **TS Native** (`src/app.ts` + `@etzhayyim/kotodama-host-sdk` → esbuild bundle) |
| **Data store** | **RisingWave via Hyperdrive (ADR-0036, direct)** — Write: `createKyselyDb(env.HYPERDRIVE).insertInto("vertex_spatial").values(row).onConflict(...).execute()`、PDS + graph-worker bypass。Read: `createKyselyDb(env.HYPERDRIVE).selectFrom("vertex_spatial").where("label", "in", [...]).execute()` — Hyperdrive 1 RTT |
| **UI mode** | `iframe` (SvelteKit-Primary, MapLibre + KAMI engine) |

## Architecture: Graph-First, DID-Scoped Sources

```
Client Request
  → createKyselyDb(env.HYPERDRIVE).selectFrom(...)  (Kysely → Hyperdrive binding → graph Worker → Hyperdrive RisingWave)
    → HIT → return from graph (source_did で provenance 追跡)
    → MISS → collection job record 作成 (async PDS pipeline)
```

**Write path**: `sdk.pds.dispatch({ type: "com.atproto.repo.createRecord", payload: { collection, recordJson } })` → PDS commit pipeline → graph Worker → Hyperdrive RisingWave
**Social path**: `sdk.pds.dispatch({ type: "app.bsky.feed.post", text, ... })`
**Read path**: `createKyselyDb(env.HYPERDRIVE).selectFrom("vertex_*").where(...).execute()` (SQL は 2026-04-13 に archived)
**TTL**: WeatherPoint は `fetched_at` + `ttl_hours` で stale 判定。その他は永続。

## Source DIDs (path-based Multi-DID)

| DID | 外部 API 置換 | TTL | 実装状態 |
|---|---|---|---|
| `did:web:maps.etzhayyim.com:geocode` | Nominatim (OSM) | 無期限 | 実装済 |
| `did:web:maps.etzhayyim.com:weather` | Open-Meteo | 1h | 実装済 |
| `did:web:maps.etzhayyim.com:ip_geolocation` | ip-api | 24h | 実装済 |
| `did:web:maps.etzhayyim.com:infrastructure` | Overpass API (OSM) | 7d | 実装済 (heartbeat dispatch) |
| `did:web:maps.etzhayyim.com:tile` | OpenFreeMap | 30d | 実装済 |
| `did:web:maps.etzhayyim.com:street_view` | Mapillary | 30d | 実装済 |
| `did:web:maps.etzhayyim.com:planet` | OSM Planet | 週次 | 実装済 |
| `did:web:maps.etzhayyim.com:user_post` | User post EXIF geolocation | 無期限 | 実装済 |
| `did:web:maps.etzhayyim.com:mapraly` | Mapraly POI/route | 7d | 実装済 |
| `did:web:maps.etzhayyim.com:vision` | Murakumo Vision analysis | 無期限 | 実装済 |
| `did:web:maps.etzhayyim.com:satellite` | Sentinel-2 / Landsat (STAC) | 30d | 実装済 (heartbeat dispatch) |
| `did:web:maps.etzhayyim.com:seismic` | USGS Earthquake Hazards API | 15m | **実装済 (heartbeat dispatch)** |
| `did:web:maps.etzhayyim.com:gtfs` | MLIT GTFS-JP (全国公共交通, bus + train + 時刻表 summary) | 1d | **実装済 (heartbeat dispatch + bulk-ingest pod, BPMN bulkRefreshGtfsJp R/PT24H)** |
| `did:web:maps.etzhayyim.com:registry:openflights` | OpenFlights routes (空路, ODbL) | 7d | **実装済 (bulk-ingest pod, BPMN bulkRefreshOpenflights R/P7D)** |
| `did:web:maps.etzhayyim.com:registry:osm:ferry` | OSM relation[route=ferry] (海路, ODbL) | 7d | **実装済 (bulk-ingest pod, BPMN bulkRefreshFerryRoutes R/P7D)** |
| `did:web:site.etzhayyim.com` | site.etzhayyim.com Web Crawl (WET/WAT geo extraction) | 7d | 実装済 |
| `did:web:maps.etzhayyim.com:registry:gleif` | GLEIF (Global LEI Foundation) | 30d | **実装済** |
| `did:web:maps.etzhayyim.com:registry:opencorporates` | OpenCorporates | 7d | **実装済** |
| `did:web:maps.etzhayyim.com:registry:wikidata` | Wikidata corporations/properties | 7d | **実装済** |
| `did:web:maps.etzhayyim.com:registry:osm` | OSM operator/owner tags | 7d | **実装済** |
| `did:web:maps.etzhayyim.com:registry:jp-moj` | Japan MOJ 登記情報 | 30d | **実装済** |
| `did:web:maps.etzhayyim.com:registry:jp-nta` | Japan NTA 法人番号 | 1d | **実装済** |
| `did:web:maps.etzhayyim.com:registry:uk-ch` | UK Companies House | 7d | **実装済** |
| `did:web:maps.etzhayyim.com:registry:us-edgar` | US SEC EDGAR | 7d | **実装済** |
| `did:web:maps.etzhayyim.com:registry:eu-br` | EU Business Registries | 30d | **実装済** |
| `did:web:maps.etzhayyim.com:registry:openaddresses` | OpenAddresses global | 30d | **実装済** |

## Transit Architecture — bus / train / 海路 / 空路 (2026-04-27)

路線図 + 運行予定 (時刻表 summary) は CF Worker heartbeat (1 prefecture / fire) では無く、
3 本の K8s bulk-ingest dumper pod が BPMN timer から `/trigger` を受けて
`vertex_spatial` に直接 INSERT する。`kotodama.jsonld` `triggers` の対象外
(handler を経由しないため commit log には乗らない)。

| 経路 | NSID (BPMN) | dumper pod (k8s deploy) | source | label / props 形 |
|---|---|---|---|---|
| 路線 + 駅 + 停留所 + 時刻表 (bus + train) | `com.etzhayyim.apps.maps.bulkRefreshGtfsJp` (R/PT24H) | `bulk-ingest-gtfs-jp` (`workers/gtfs_jp_dumper.py`) | per-agency `feed.zip` × N — **`GTFS_JP_FEED_INDEX_URL` 必須** (JSON array `[{feed_id, url, prefecture, agency}, …]`)。bundled default なし — fail-fast (gtfs-data.jp の URL scheme 非公開のため Phase 1 の guess は 404)。推奨 host: 自前 B2 `maps-bulk-ingest/gtfs-jp/index.json` | Railway / BusRoute / Station / BusStop, props `{first_departure, last_departure, num_trips, num_stops, service_days{mon..sun}, route_short_name, route_long_name, route_type}` |
| 空路 (scheduled flight legs) | `com.etzhayyim.apps.maps.bulkRefreshOpenflights` (R/P7D) | `bulk-ingest-openflights` (`workers/openflights_dumper.py`) | OpenFlights `airports.dat` + `routes.dat` + `airlines.dat` (ODbL) | Airport / AirRoute, props `{airline, airline_id, airline_name, src_iata/icao/lat/lng, dst_iata/icao/lat/lng, codeshare, stops, equipment}` |
| 海路 (ferry routes) | `com.etzhayyim.apps.maps.bulkRefreshFerryRoutes` (R/P7D) | `bulk-ingest-ferry-routes` (`workers/ferry_routes_dumper.py`) | OSM Overpass `relation[route=ferry]` × 7 continent bbox + `node[amenity=ferry_terminal]` / `node[harbour=yes]` (ODbL) | SeaRoute / Port, props `{osm_relation_id, operator, ref, network, from, to, via, duration_min, frequency, distance_nmi, fee, wheelchair}` |

Lexicon: `00-contracts/lexicons/com/etzhayyim/apps/maps/bulkRefresh{GtfsJp,Openflights,FerryRoutes}.json`。
BPMN: `etzhayyim-root/orgs/etzhayyim/com-etzhayyim-maps/wire/bpmn/maps/bulkRefresh{GtfsJp,Openflights,FerryRoutes}.bpmn`。
K8s manifest: `60-apps/etzhayyim-project-maps/bulk-ingest/k8s/deployment-{gtfs-jp,openflights,ferry-routes}.yaml`。
Image: `ghcr.io/etzhayyim/maps-bulk-ingest:1.1.0` (1 image / N command, CMD で worker を切替)。

**運行予定の粒度** (2026-04-27 update, Phase 2 shipped):

- **per-route summary** (Phase 1, vertex_spatial.props) — first/last departure + 便数 + 曜日 service pattern。地図上の "この路線が動いているか" を答える用途。
- **per-stop timetable** (Phase 2, `vertex_maps_trip` + `vertex_maps_stop_time`) — 1 trip 1 row + 1 stop call 1 row。読み取りは `com.etzhayyim.apps.maps.nextDeparturesAtStop` XRPC (idx_maps_stop_time_stop_dep `(stop_id, departure_time)` で sub-50ms)。**(a) "次の電車は X 駅に何時"** read pattern 専用に最適化済み。**(b) "この路線の全時刻表"** が必要になったら `(feed_id, route_id, stop_sequence)` 複合 index を別 migration で追加する (現状 deliberately 未投入、advisor #5)。
- **idempotency**: gtfs_jp_dumper は per-feed `DELETE FROM vertex_maps_{trip,stop_time} WHERE feed_id = ?` → re-INSERT (RW append-only / no `ON CONFLICT`、root CLAUDE.md "Record-log semantics" 規約)。`vertex_spatial` の route/stop 行は deterministic vertex_id PK で RW PK upsert に任せる。

**Cross-feed stop unification** (advisor 2026-04-27 #3, decision = (i) "Accept feed-scoped stop_id"): Tokyo Metro / JR East / Keio の Shibuya は 3 個の独立 `stop_id` (`gtfsjp-tokyo-metro-…` / `gtfsjp-jr-east-…` / `gtfsjp-keio-…`)。`nextDeparturesAtStop` は caller が operator 別 stop_id を渡す。理由: (a) 路線図 UI は operator 別レイヤを既に持つ、(b) 現時点でクロス operator 集約 query の要件なし、(c) RT (Phase 3) も per-feed stop_id 参照のため canonical 化を入れると RT join 路も再設計が必要。**将来 Phase 2.x で必要になったら**、別 migration で `vertex_maps_stop_canonical {canonical_id, label, lat, lng, name_jp, name_en}` + `edge_maps_stop_canonical_alias {canonical_id, feed_id, gtfs_stop_id}` を追加 (ingest-time fuzzy + 50m coord cluster)。`nextDeparturesAtStop` には `canonicalStopId` 任意 param を後付け。`stop_id` カラム形式は不変条件として固定 (`gtfsjp-{feed_id}-{gtfs_stop_id}`)。

**Migration validation runbook** (advisor #1): 30-graph migration `20260428150000_vertex_maps_trip_stop_time.ts` は ADR-2604241342 の "kysely corruption / ON CONFLICT / vitest in migrations / unsupported DDL" 4 失敗パターンに該当しないことを検証済 (生 `CREATE TABLE` + `CREATE INDEX` のみ、`ON CONFLICT` なし、vitest import なし)。RW で実行する手順:
```
cd 30-graph/graph-schema && pnpm db:migrate latest 2>&1 | tee /tmp/mig.log
# 失敗時 (advisor #1 fallback):
30-graph/graph-schema/scripts/apply-pending.sh
# 検証 (psql):
psql $DATABASE_URL -c "\d+ vertex_maps_trip"
psql $DATABASE_URL -c "\d+ vertex_maps_stop_time"
psql $DATABASE_URL -c "\di idx_maps_*"
```

**Phase 2 row-count sizing** (advisor #2): `60-apps/etzhayyim-project-maps/bulk-ingest/workers/gtfs_jp_dryrun.py` で 1 feed の vertex_maps_stop_time 投影行数を DB 書き込みなしで測定する。Phase 3 (RT) サイジングはこの数字で決まる。実行例:
```
python3 60-apps/etzhayyim-project-maps/bulk-ingest/workers/gtfs_jp_dryrun.py \
  https://example.tld/path/to/feed.zip --feed-id tokyo-metro
# stdout JSON projected_rows.vertex_maps_stop_time が単一 feed の見積行数。
# 5M 超えたら Phase 3 RT 設計の table partitioning を見直す。
```

**Schedule realtime (GTFS-RT, 遅延 / 運休)** — Phase 3 scaffold shipped 2026-04-27, **GATED, replicas=0 by default**:

| 部品 | 場所 | 状態 |
|---|---|---|
| Schema | `30-graph/graph-schema/migrations/20260428160000_vertex_maps_realtime.ts` | shipped (3 tables + 3 streaming MV; ADR-2604241342 4 失敗パターンに該当しない: 生 `CREATE TABLE/INDEX/MATERIALIZED VIEW` のみ、`ON CONFLICT` なし、`vitest` import なし) |
| Dumper pod | `60-apps/etzhayyim-project-maps/bulk-ingest/workers/gtfs_rt_dumper.py` | shipped — internal scheduler, 30s VP / 60s TU / 300s alerts; `gtfs-realtime-bindings` protobuf parser; **`_resolve_feeds()` raises if neither `GTFS_RT_FEED_INDEX_URL` nor `ODPT_API_KEY` is set** (CrashLoopBackOff is the gate) |
| K8s deploy | `bulk-ingest/k8s/deployment-gtfs-rt.yaml` | shipped, `replicas: 0` (manual scale up after auth config) |
| XRPC lexicon | `00-contracts/lexicons/com/etzhayyim/apps/maps/realtimeDelaysAtStop.json` | shipped |
| Worker handler | `cmdRealtimeDelaysAtStop` in `appview/maps-ui-uqpel6i6/src/app.ts` | shipped — 3 parallel queries (departures + rtAvailable probe + alerts), `LEFT JOIN mv_maps_recent_trip_update` so RT-offline degrades to static |
| Static path | `cmdNextDeparturesAtStop` | **不変** — RT feed が落ちても静的 timetable は返り続ける (advisor invariant) |
| Tables | `vertex_maps_vehicle_position` PK `(feed_id, vehicle_id, ts)` / `vertex_maps_trip_update` PK `(feed_id, trip_id, stop_sequence, ts)` / `vertex_maps_service_alert` PK `(feed_id, alert_id, ts)` | append-only |
| Streaming MV (window-pruned) | `mv_maps_recent_vehicle_position` (5m DISTINCT ON) / `mv_maps_recent_trip_update` (30m DISTINCT ON) / `mv_maps_active_alerts` (active_until > now AND ts > now-24h DISTINCT ON) | window 内 latest per key |
| Image | `ghcr.io/etzhayyim/maps-bulk-ingest:1.2.0` (`gtfs-realtime-bindings==1.0.0` 追加) | requires rebuild + push |

**End-to-end smoke is NOT performed** — schema migration not yet applied, dumper never connected to a real feed, RT MV not exercised. これは設計上の状態 (operator が ODPT key + ODPT 規約同意なしに RT 通信を開始しないため)。Bring-up:

```
# 1. Apply schema
cd 30-graph/graph-schema && pnpm db:migrate latest
# 2. Build + push image (gtfs-realtime-bindings)
cd 60-apps/etzhayyim-project-maps/bulk-ingest && ./deploy.sh build
# 3. Apply k8s manifest (still replicas=0)
./deploy.sh apply
# 4a. ODPT path:
security add-generic-password -s etzhayyim.transit -a ODPT_API_KEY -w 'XXX' -U
kubectl -n maps-bulk-ingest set env deploy/bulk-ingest-gtfs-rt \
  ODPT_API_KEY=$(security find-generic-password -s etzhayyim.transit -a ODPT_API_KEY -w)
# 4b. or no-auth path:
kubectl -n maps-bulk-ingest set env deploy/bulk-ingest-gtfs-rt \
  GTFS_RT_FEED_INDEX_URL=https://etzhayyim-nats.s3.us-west-004.backblazeb2.com/maps-bulk-ingest/gtfs-rt/index.json
# 5. Scale up
kubectl -n maps-bulk-ingest scale deploy/bulk-ingest-gtfs-rt --replicas=1
# 6. Verify cycle
kubectl -n maps-bulk-ingest logs -f deploy/bulk-ingest-gtfs-rt
curl https://maps.etzhayyim.com/xrpc/com.etzhayyim.apps.maps.realtimeDelaysAtStop?stopId=gtfsjp-...
```

**Schedule realtime (GTFS-RT, 遅延 / 運休)**: 未実装。GTFS-RT VehiclePosition / TripUpdate
は heartbeat dispatch が現実的 (頻度 1 min - 5 min)。bulk-ingest pod の責務外。

## Registry & Legal Entity Architecture (2026-04-13)

### Graph Schema (正規化済み — `props` JSON bag 非依存)

**Vertex Tables:**

| Table | Labels | Key Columns |
|---|---|---|
| `vertex_legal_entity` | LegalEntity, Operator, PropertyOwner, Corporation, GovernmentBody, PublicUtility | entity_type, registration_number, jurisdiction, country, lei, tax_id, industry_code |
| `vertex_registry` | LandRegistry, PropertyRegistry, BusinessRegistry, VehicleRegistry, ConstructionPermit, OperatingLicense, EnvironmentalPermit, ZoningRecord | registry_type, registry_number, jurisdiction, property_type, land_area_sqm, assessed_value, parcel_number |

**Edge Tables:**

| Table | Labels | Key Columns | 意味 |
|---|---|---|---|
| `edge_ownership` | OwnsProperty, TransferredTo, InheritedBy, ForeclosedBy, LeasedTo | share_pct, effective_date, registry_ref | 所有関係チェーン |
| `edge_operates` | Operates, Manages, Maintains, Concessions | license_ref, effective_date | 運営者→施設 |
| `edge_registered_at` | RegisteredAt, FiledWith, LicensedBy, PermittedBy | registry_number, effective_date | 登記先 |
| `edge_verified_by` | VerifiedBy, CertifiedBy, ApprovedBy, AuditedBy | verification_date, confidence | 検証元 |
| `edge_supersedes` | Supersedes, AmendedBy, RevokedBy, ReplacedBy | effective_date, reason | 版管理 |

### Ownership Chain Example

```
(e:LegalEntity {name:"三菱地所", lei:"549300..."})
  -[edge_ownership {label:"OwnsProperty", share_pct:100}]→
(r:LandRegistry {registryNumber:"13-01234", jurisdiction:"東京法務局"})
  -[edge_registered_at {label:"RegisteredAt"}]→
(a:AdminArea {name:"千代田区", adminLevel:3})
```

### Commands (22 new)

register/list: LegalEntity, Operator, PropertyOwner, LandRegistry, PropertyRegistry, BusinessRegistry, ConstructionPermit, OperatingLicense, ZoningRecord + registerOwnership, ownershipChain, entityHistory, seedGlobalRegistries

### Coverage Targets (global registry data)

| Source | Estimated Records | Priority |
|---|---|---|
| GLEIF LEI | ~2.5M legal entities | P0 |
| JP NTA 法人番号 | ~6M corporations | P0 |
| Wikidata corporations (with HQ coords) | ~500K | P0 |
| OpenAddresses | ~1B addresses | P1 |
| OpenCorporates | ~200M companies | P1 |
| OSM operator/owner tags | ~50M POIs | P2 |

## Geo DID Architecture (multi-scheme, 3-layer)

### Layer 1: Visual Layer DIDs (11, KAMI rendering layers)

`did:web:{appId}.etzhayyim.com:layer:{slug}` — tile, poi, route, infra, building, weather, sensor, transport, geography, satellite, event

### Layer 2: Region DIDs (canonical nanoid + scheme alias DIDs)

`did:web:{appId}.etzhayyim.com:region:{nanoid}` — canonical AdminArea DID (stable, scheme-agnostic)
`did:web:{appId}.etzhayyim.com:geo:{scheme}:{code}` — scheme alias DIDs (ISO 3166, JIS, H3, S2, MGRS, etc.)

**Bootstrap**: JP country (1) + 47 prefectures. Each gets canonical DID + 2 alias DIDs (iso3166-2 + jis-x0401).

**32 supported schemes**: iso3166-1/2, jis-x0401/0402, fips, h3, s2, geohash, pluscode, mgrs, maidenhead, utm, flight-level, icao-fir, atmo-layer, elevation, depth-band, infra-depth, iho-sea, eez, bath-zone, koppen, wwf-biome, wwf-ecoregion, tectonic, icao-airport, iata-airport, unlocode, iana-tz

### Layer 3: Zone DIDs (vertical + natural)

`did:web:{appId}.etzhayyim.com:vzone:{slug}` — VerticalZone (atmosphere 5 + underground 4 + ocean 5 = 14)
`did:web:{appId}.etzhayyim.com:nzone:{slug}` — NaturalZone (Köppen 5 + biome 14 + tectonic 15 = 34)

### Graph Nodes

- `AdminArea` — canonical region with all scheme codes as properties
- `GeoAlias` — scheme→canonical resolution (RESOLVES_TO edge)
- `VerticalZone` — altitude/depth bands (minAlt, maxAlt)
- `NaturalZone` — climate/biome/tectonic zones
- `LayerCoordinator` — KAMI visual layer DID actors

### DID Count

| Category | Canonical | Alias | Total | 状態 |
|---|---|---|---|---|
| Layer coordinators | 11 | — | 11 | 実装済 |
| JP country | 1 | 2 (iso3166-1 + unlocode) | 3 | 実装済 |
| JP prefectures | 47 | 94 (iso3166-2 + jis-x0401) | 141 | 実装済 |
| Vertical zones | 14 | 14 | 28 | 実装済 |
| Natural zones | 34 | 34 | 68 | 実装済 |
| Source DIDs | 14 | — | 14 | 実装済 (+seismic, +gtfs, +adsb) |
| 195 sovereign countries | 195 | 390 (iso3166-1 + unlocode) | 585 | **P0 fix済** |
| Major ports (50) | — | 50 (unlocode) | 50 | **P0 fix済** |
| Major airports (40) seed | — | 80 (icao + iata) | 80 | **P0 fix済** |
| **Total** | **316** | **664** | **980** | |
| JP 市区町村 (~1,741) | ~1,741 | ~3,482 | ~5,223 | **pipeline-seeded (Wikidata SPARQL → site pipeline)** |
| World AdminArea tier-2 (~3,900) | ~3,900 | ~3,900 (iso3166-2) | ~7,800 | **pipeline-seeded (Wikidata SPARQL → site pipeline)** |
| World airports 1,000+ | ~1,000 | ~2,000 (icao + iata) | ~3,000 | **pipeline-seeded (OurAirports CSV → site pipeline)** |
| Aircraft SpatialEvents | — | — | streaming | **heartbeat ADS-B (60 min, 4 bbox rotation)** |

## Components (2026-04-22, consolidated)

| Component | Folder | nanoid | Runtime | 役割 | コマンド数 |
|---|---|---|---|---|---|
| maps-ui | `maps-ui-uqpel6i6` | uqpel6i6 | TS Native | 全 15 WIT ドメイン + source/job/dataset/POI 統合 | 172 |

**Consolidated 2026-04-22**: 旧 `maps-collection-control-plane-v1m9k2q8` (nanoid v1m9k2q8) は maps-ui に統合 (Worker 1 本化)。16 commands (registerSource/listSources/createCollectionJob/advanceJob/listJobs/getJobStatus/storeDataset/getDataset/listDatasets/getPipelineStats/importOsmPois/importWikidataPois/searchPoi/getPoi/listPoiTypes/registerWriterProfiles) は `src/collection-commands.ts` に移植。`v1m9k2q8.etzhayyim.com` route は削除。

## Commands — maps-ui (uqpel6i6)

### Spatial Intelligence (12)

| Command | Description |
|---|---|
| `search_places` | Search places by name/label |
| `get_place` | Get place by place_id |
| `reverse_geocode` | Reverse geocode lat/lng (graph-first, MISS → collection job) |
| `register_route` | Register route |
| `list_routes` | List routes (filter: route_type) |
| `get_route` | Get route by route_id |
| `weather_at` | Weather at lat/lng (graph-first, MISS → collection job) |
| `weather_grid` | Weather grid query (bbox) |
| `ip_geolocate` | IP geolocation lookup |
| `graph_traverse` | Graph traverse from node (depth 1-5) |
| `graph_neighbors` | Graph neighbors of node |
| `search_resources` | Search all spatial resources (multi-label) |

### Infrastructure Intelligence (10)

`register_infra_network`, `list_infra_networks`, `register_infra_segment`, `list_infra_segments`, `register_infra_node`, `list_infra_nodes`, `register_infra_incident`, `list_infra_incidents`, `infra_query` (type+location filter), `infra_cross_section` (7 layer depth/color map)

### Transport Intelligence (24)

register + list × 12 types: `road`, `railway`, `sea_route`, `air_route`, `bus_route`, `waterway`, `port`, `airport`, `station`, `bus_stop`, `parking`, `ev_charger`

### Geography Intelligence (18)

register + list × 7 types: `spot`, `river`, `lake`, `coastline`, `mountain`, `maritime_zone`, `admin_area` + `spot_search` (area+category+query) + `spot_recommend` (rating-based nearby) + `get_spot`

### Digital Twin (12)

`register_building`, `list_buildings`, `get_building`, `register_building_floor`, `register_asset`, `list_assets`, `device_bind`, `list_devices`, `twin_state_update`, `twin_state_get`, `twin_scene` (KAMI JSON-LD), `occupancy_update`

### Sensor Intelligence (7)

`register_sensor`, `list_sensors`, `sensor_ingest` (batch readings), `sensor_query`, `sensor_latest`, `sensor_alert_set`, `list_sensor_alerts`

### Simulation Intelligence (6)

`simulation_create`, `simulation_run`, `simulation_result`, `forecast_get`, `health_assess`, `maintenance_plan`

### Bayesian Latent World Model (3)

`world_belief_update`, `world_belief_get`, `latent_world_model_run`

Design: `world_belief_update` applies a single Bayesian posterior update for a spatial entity hypothesis and mirrors the posterior into `TwinState`. `latent_world_model_run` reads recent `TwinState`, `SensorReading`, and `SpatialEvent` rows, emits `WorldBelief` + `Forecast`, and records a `WorldModelRun` audit row. This keeps the model graph-first and append-friendly while using the shared platform posterior semantics.

### Spatiotemporal (10)

`spatial_event_record`, `spatial_event_query`, `spatial_version_record`, `spatial_version_query`, `spatial_relation_write`, `spatial_relation_query`, `timeline`, `spatial_diff`, `display_layer_define`, `list_display_layers`

### Post Geolocation (2)

| Command | Description |
|---|---|
| `extract_post_location` | Extract EXIF geolocation from post images → SpatialEvent + Place |
| `list_post_locations` | List geolocated user posts (filter: author, area) |

### Mapraly Intelligence (3)

| Command | Description |
|---|---|
| `mapraly_ingest` | Create Mapraly collection job for region/bbox |
| `mapraly_import_poi` | Import Mapraly POIs/routes (batch) |
| `mapraly_list_pois` | List Mapraly-sourced POIs (filter: category, area) |

### Vision Intelligence (3)

| Command | Description |
|---|---|
| `analyze_image` | Submit image for spatial entity analysis via Murakumo Vision |
| `vision_import_entities` | Import vision-detected entities (Building, Spot, Place, etc.) |
| `list_vision_results` | List vision analysis results (filter: job, kind, confidence) |

### Satellite Intelligence (5)

| Command | Description |
|---|---|
| `satellite_ingest` | Ingest from free STAC catalogs (sentinel-2, landsat, sentinel-1, hls, cop-dem, naip) |
| `satellite_import_scene` | Import satellite scene metadata (sensor_type, stac_collection_id) |
| `satellite_analyze` | Analyze satellite scene via Murakumo Vision (change detection, land use) |
| `list_satellite_scenes` | List satellite scenes (filter: satellite, area, date) |
| `list_satellite_sources` | List available free satellite data sources with STAC endpoints |

### Geo DID Management (8)

| Command | Description |
|---|---|
| `register_region` | Register region with canonical DID + multi-scheme alias DIDs |
| `resolve_geo_alias` | Resolve any geo scheme code to canonical DID |
| `list_geo_aliases` | List geo aliases (filter by scheme) |
| `list_vertical_zones` | List vertical zones (atmosphere/underground/ocean) |
| `list_natural_zones` | List natural zones (climate/biome/tectonic) |
| `list_layer_coordinators` | List KAMI layer coordinator DIDs |
| `resolve_zones_3d` | Resolve all zones at 3D point (horizontal + vertical) |
| `list_geo_schemes` | List all 32 supported geographic code schemes |

### Web Crawl Geo Coverage (3)

| Command | Description |
|---|---|
| `seed_geo_domains` | Seed geo domain crawls via site.etzhayyim.com + CommonCrawl fallback (36 target domains) |
| `list_geo_domains` | List geo domain crawl targets (filter: category, country) |
| `list_web_crawl_geo_entities` | List geo entities extracted from WET/WAT (filter: domain, entityType) |

**Pipeline**: `seedGeoDomains` → cross-actor invoke `site.etzhayyim.com:seedForProject` → site crawls domains + CC fallback → WET/WAT records → maps `handleComAtprotoSyncSubscribeReposCommit` subscribes → WET: Murakumo NER geo entity extraction → WAT: outlink graph + geo sub-page discovery → `WebCrawlGeoEntity` graph nodes

**Target domains (56)**: JP GIS (nlftp.mlit.go.jp, gsi.go.jp, maps.gsi.go.jp, stat.go.jp), JP Transport (JR East/West/Central, Tokyo Metro, Navitime, ekitan), JP Hazard (disaportal.gsi.go.jp, jma.go.jp, j-shis.bosai.go.jp, river.go.jp), JP Municipal GIS (Tokyo/Osaka/Nagoya city), JP Real Estate (reinfolib, land.mlit.go.jp), JP Airport/Port (NRT, KIX, Tokyo Port), Global GIS (OSM, Natural Earth, GADM, Wikidata, Wikipedia, geofabrik, humdata, data.europa.eu), Global Transport (OpenRailwayMap, FlightRadar24, MarineTraffic, OurAirports), Hazard (USGS earthquake, EMSC, tsunami.gov, GDACS, FIRMS wildfire, flood.firetoc.eu), Satellite (Copernicus, USGS earthexplorer), Tourism (JNTO, japan.travel), Infrastructure (TEPCO, Tokyo Waterworks)

### Analytics (1)

`get_dashboard` — 21 entity type counts

### Consolidated commands (formerly maps-collection, 2026-04-22)

`registerSource`, `listSources`, `createCollectionJob`, `advanceJob`, `listJobs`, `getJobStatus`, `storeDataset`, `getDataset`, `listDatasets`, `getPipelineStats`, `importOsmPois`, `importWikidataPois`, `searchPoi`, `getPoi`, `listPoiTypes`, `registerWriterProfiles` — `src/collection-commands.ts` が提供。Writes は ADR-0036 に従い `vertex_spatial` direct + `vertex_maps_job` (job event log) への Hyperdrive Kysely insert。

## Deploy Architecture

### maps-ui — Hono + Svelte CSR (Single Worker)

```
maps.etzhayyim.com / uqpel6i6.etzhayyim.com
  → Single Worker (kotodama-uqpel6i6, src/app.ts)
    ├─ /_app/meta     → host-sdk auto route
    ├─ static assets  → Workers Assets (svelte/build/)
    ├─ / , /?embed=1  → Hono router (Svelte CSR, MapLibre + KAMI)
    ├─ /_heartbeat    → runHeartbeat()
    ├─ /_commit       → handleComAtprotoSyncSubscribeReposCommit() (reactive pipeline)
    └─ /xrpc/{NSID}   → sdk.handleRequest() (87 commands)
```

<!-- maps-collection-control-plane (v1m9k2q8) was consolidated into maps-ui on 2026-04-22. -->


## Write Path (2026-04-22, ADR-0036)

Domain (`com.etzhayyim.apps.maps.*`): `createKyselyDb(env.HYPERDRIVE).insertInto("vertex_spatial")` 直接 INSERT。entity→label は `src/vertex-spatial-projection.ts` が Pascal-case 変換 (`mapsEntityToLabel`)、camelCase→snake_case カラム + `props` JSON 残余。PDS + graph-worker 共に経由しない。

Social posts: `sdk.pds.dispatch({ type: "app.bsky.feed.post", text, ... })` (PDS 経由、federates)。ローカル `post()` 経路は既存の `vertex_repo_record` direct write を維持。

Cross-actor invoke (Murakumo / site.etzhayyim.com): `sdk.pds.dispatch({ type: "invoke", payload: { did, method, params } })` — storage ではなく agent RPC なので PDS 維持。

## Graph Schema

### Node Labels (51 types)

**Core Spatial**: Place, Route, WeatherPoint, CrawlerHost, Region
**Infrastructure**: InfraNetwork, InfraSegment, InfraNode, InfraIncident
**Transport**: Road, Railway, SeaRoute, AirRoute, BusRoute, Waterway, Port, Airport, Station, BusStop, Parking, EvCharger
**Geography**: Spot, River, Lake, Coastline, Mountain, MaritimeZone, AdminArea
**Digital Twin**: Building, BuildingFloor, PhysicalAsset, TwinState, DeviceBinding, Sensor, SensorReading, SensorAlert, HealthAssessment, MaintenancePlan, Simulation, SimulationResult, Forecast
**Spatiotemporal**: SpatialEvent, SpatialVersion, SpatialRelation, DisplayLayer
**Vision**: VisionResult, SatelliteScene, CollectionJob
**Collection**: MapsSource, MapsJob, MapsDataset
**Geo DID**: LayerCoordinator, GeoAlias, VerticalZone, NaturalZone
**Web Crawl**: WebCrawlGeoEntity

### Edge Types

STARTS_AT, ENDS_AT, IN_REGION, PARENT_OF, OBSERVED_AT, LOCATED_AT, SEGMENT_OF, NODE_OF, CONNECTS, FLOOR_OF, ASSET_IN, TWIN_OF, BOUND_TO, MONITORS, RELATES_TO, EVENT_ON, VERSION_OF, DETECTED, SAME_AS, ANALYZED_FROM, RESOLVES_TO, OwnsProperty, TransferredTo, InheritedBy, ForeclosedBy, LeasedTo, Operates, Manages, Maintains, Concessions, RegisteredAt, FiledWith, LicensedBy, PermittedBy, VerifiedBy, CertifiedBy, ApprovedBy, AuditedBy, Supersedes, AmendedBy, RevokedBy, ReplacedBy

## Lexicon (com.etzhayyim.apps.maps.*)

47 record kinds mapped via `LABEL_MAP` in `app.ts`. W Protocol kind `maps.{type}` → AT Lexicon `com.etzhayyim.apps.maps.{type}`.

## Infrastructure Types (infra_type)

| Type | 埋設深度 | KAMI color |
|---|---|---|
| `water` | 1.2m | `#3b82f6` |
| `sewage` | 3.0m | `#78716c` |
| `gas` | 1.5m | `#f59e0b` |
| `electric` | 0.8m | `#eab308` |
| `telecom` | 0.6m | `#10b981` |
| `subway` | 15.0m | `#6366f1` |
| `district_heating` | 1.0m | `#ef4444` |

## External Sources (fallback only)

Nominatim (OSM), Open-Meteo, ip-api, OSM Overpass, MLIT (国土数値情報), GTFS, AIS, ADS-B, OpenChargeMap, OpenFreeMap, Mapillary, Mapraly, Murakumo Vision (qwen3-vl-8b), Sentinel-2 L2A (ESA), Landsat C2L2 (USGS), Sentinel-1 GRD SAR (ESA), HLS (NASA), Copernicus DEM, NAIP (USDA) — 全衛星ソース無料

## Build & Deploy

```bash
# maps-ui (TS native → account-level Worker, single consolidated Worker since 2026-04-22)
cd 60-apps/etzhayyim-project-maps/appview/maps-ui-uqpel6i6
etzhayyim deploy
```

## Current Status (2026-04-13)

### Verified (E2E)

- Both components deployed: TS native, account-level Worker
- maps-ui: **156 XRPC commands** (15 WIT domains + analytics + registry), deduplicated
- maps-collection: 10 XRPC commands (source/job/dataset/stats)
- Write: `sdk.pds.createRecord()` → PDS → graph Worker consumer → `vertex_spatial` (RisingWave)
- Read: `createKyselyDb(env.HYPERDRIVE).selectFrom("vertex_spatial")`
- Social: `sdk.pds.createRecord("app.bsky.feed.post", ...)`
- Heartbeat: OK (both components)
- handleComAtprotoSyncSubscribeReposCommit: OK (maps.* + ipaddress.ip_geo + site.wet/wat/geoRecord cross-app)
- 14 source DIDs (+ seismic, gtfs, adsb)
- 980 Multi-DIDs (195 countries, 50 ports, 40 airports, 48 JP regions, 14 vertical zones, 34 natural zones, 11 layer coordinators)
- 12 Overpass entity types, 14 processGeoRecord handlers, 11 derive.social rules
- 56 geo crawl target domains, web crawl NER → proper graph node write + social
- p10-tables alignment: all 58 maps labels → `vertex_spatial`
- Real-time feeds: USGS seismic, OpenSky ADS-B (8-tile JP), GTFS-JP (47 prefs cycling)
- Post EXIF geolocation, Mapraly ingest, Murakumo Vision, Satellite STAC pipeline
