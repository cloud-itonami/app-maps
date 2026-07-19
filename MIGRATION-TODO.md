# maps — kotoba-datomic migration TODO

Authoritative target: **kotoba-datomic L1 witnessed** for low-write entity registrations, **kotoba-datomic L0 nominal** for blob registries, **kotoba-datomic-projection** (ADR TBD) for hot-path spatial / GTFS-RT queries. See:

- [ADR-2605231400](../../90-docs/adr/2605231400-kotoba-datomic-holochain-iso-substrate.md) — kotoba-datomic naming + 7-layer mapping
- [ADR-2605172000](../../90-docs/adr/2605172000-etzhayyim-kotoba-substrate.md) — kotoba substrate hard rules
- [ADR-2607192500](../../90-docs/adr/2607192500-protocol-libp2p-and-empty-engine-shell-drain.edn) — historical kotoba-datomic spec provenance; current owner ADR-2605262130

## Current state (2026-05-23)

| Layer | Substrate | Charter status |
|---|---|---|
| Domain / DID | `maps.etzhayyim.com` / `did:web:maps.etzhayyim.com` | ✅ migrated |
| Lexicons | `com.etzhayyim.apps.maps.*` (47 record kinds) | ⚠️ NSID prefix not yet cut over to `com.etzhayyim.maps.*` |
| Write path | `createKyselyDb(env.HYPERDRIVE).insertInto("vertex_spatial")` direct, ADR-0036 bypass | ❌ violates ADR-2605172000 (centralized RW) |
| Read path | `createKyselyDb(env.HYPERDRIVE).selectFrom(...)` direct | ❌ violates ADR-2605172000 |
| Blob | B2 (`maps-bulk-ingest/gsplat*`) + R2 + Cloudflare Tile | ❌ centralized object stores; content-addressed paths exist (SHA-256 prefix shard) so swap to IPFS is mechanical |
| Bulk-ingest pods | 13 K8s pods (GTFS-JP / OpenFlights / Ferry / GTFS-RT / gsplat / overture / wikidata / wikipedia / geonames / noaa-ais / aismarine ×2 / maps-search) all `asyncpg → RW` | ❌ all violate ADR-2605172000 |
| Worker source | `appview/maps-ui-uqpel6i6/src/app.ts` 66 Kysely call sites; `collection-commands.ts` 0 (already SDK-routed) | partial |

## Tier classification

Every maps write/read maps to the current kotoba arrangement contract; historical tier provenance remains in [ADR-2607192500](../../90-docs/adr/2607192500-protocol-libp2p-and-empty-engine-shell-drain.edn):

### Tier A — kotoba-datomic L0 ready (pure MST migration, low write rate)

| Surface | Commands | Lex/policy work |
|---|---|---|
| Geo DID Management (8) | `register_region`, `resolve_geo_alias`, `list_geo_aliases`, `list_vertical_zones`, `list_natural_zones`, `list_layer_coordinators`, `resolve_zones_3d`, `list_geo_schemes` | rkey policy: `literal:{nanoid}` (canonical) / `literal:{scheme}:{code}` (alias) |
| Source DID registry (14 DIDs) | `registerSource`, `listSources` | rkey: `literal:{did-suffix}` |
| Display layer (2) | `display_layer_define`, `list_display_layers` | rkey: `literal:{layer-id}` |
| Collection plumbing (4) | `createCollectionJob`, `advanceJob`, `listJobs`, `getJobStatus` | event log, rkey: `tid` |
| Registry & Legal Entity (22 register/list commands per ADR-0013) | LegalEntity, LandRegistry, PropertyRegistry, BusinessRegistry, ConstructionPermit, OperatingLicense, ZoningRecord + ownership/registry-link commands | rkey: `literal:{registry_type}:{registry_number}` |

**Tier A is ~46 of 172 commands. Migration is mechanical: swap `createKyselyDb(env.HYPERDRIVE).insertInto(...)` → `sdk.write({collection, record})`; reads via `sdk.read({collection, prefix})`. Pattern reference: [`60-apps/etzhayyim-project-open-isic/kotoba/`](../etzhayyim-project-open-isic/kotoba/).**

### Tier B — kotoba-datomic L1 witnessed (one-shot heritage data, low write rate, append-only)

| Surface | Commands | Notes |
|---|---|---|
| Geography Intelligence (18) | `register_{spot,river,lake,coastline,mountain,maritime_zone,admin_area}` + variants | one-shot per real-world feature; ≥3-of-5 witness validates Lexicon schema + boundary polygon sanity |
| Building / Floor / Asset registration (Digital Twin subset) | `register_building`, `register_building_floor`, `register_asset` | append-only registry; updates via `Supersedes` edge |
| Transport infrastructure registration (12) | register-side of `road / railway / sea_route / air_route / bus_route / waterway / port / airport / station / bus_stop / parking / ev_charger` | append-only; live timetable / RT goes to Tier C projection |
| Web Crawl Geo Entities | `list_web_crawl_geo_entities` (write side via `seed_geo_domains` → cross-actor) | append-only by definition; witness validates extraction provenance + NER confidence |
| Vision / Satellite metadata | `vision_import_entities`, `satellite_import_scene`, `list_vision_results`, `list_satellite_scenes` | metadata-only; blob in Tier D |
| Mapraly POI batch | `mapraly_import_poi`, `mapraly_list_pois` | append-only; per-source provenance via `source_did` |

**Tier B is ~50 commands. Requires `witness-selector.ts` + `quorum.ts` (kotoba-datomic-witnesses, follow-up #2-#3 from ADR-2605231400 implementation plan) before migration starts.**

### Tier C — kotoba-datomic-projection required (hot path, sub-100ms reads, cannot go pure MST)

| Surface | Commands | Why |
|---|---|---|
| Tile vector overlay | `com.etzhayyim.apps.maps.tileGeoJson` (XRPC) | bbox spatial query on `vertex_spatial WHERE label IN (...)`, sub-100ms target |
| H3 chunk overlay | `com.etzhayyim.apps.maps.getChunk` | `cellToBoundary → union bbox → 1 query → centroid → owning cell` routing, cache key = h3Cell |
| GTFS-RT realtime | `realtimeDelaysAtStop` + `mv_maps_recent_vehicle_position` / `mv_maps_recent_trip_update` / `mv_maps_active_alerts` streaming MV | 30s polling cadence, sub-50ms read, RW streaming MV pruning windows |
| GTFS static timetable | `nextDeparturesAtStop` with `idx_maps_stop_time_stop_dep (stop_id, departure_time)` | sub-50ms read on 5M+ row table |
| Graph traversal | `graph_traverse` (depth 1-5), `graph_neighbors`, `search_resources` (multi-label) | range / join / aggregate semantics outside MST prefix-scan |
| Spatial analytics | `infra_query` (type+location filter), `infra_cross_section` (7 layer depth/color map) | spatial intersection queries |
| Spatiotemporal | `spatial_event_query`, `spatial_version_query`, `spatial_relation_query`, `timeline`, `spatial_diff` | range queries on (time, location, label) tuples |
| Sensor | `sensor_query` (range), `sensor_latest`, `list_sensor_alerts` | append-write Tier B, but reads need indexed time series |
| Search | `spot_search` (area+category+query), `spot_recommend` (rating-based nearby), `search_places` | full-text + spatial + ranking |

**Tier C is ~60 commands. Blocked on kotoba-datomic-projection ADR (follow-up #6 from ADR-2605231400 implementation plan). Until that ADR lands, Tier C continues to run on RW as a Charter Rider §carve-out transition state — see [ADR-2605222330](../../90-docs/adr/2605222330-etzhayyim-com-substrate-violation-transition-window.md) for the analogous etzhayyim.com transition-window precedent.**

### Tier D — IPFS blob (content-addressed, swap B2/R2 → IPFS direct)

| Asset | Current store | Path scheme | Status |
|---|---|---|---|
| gsplat PLY (Phase 2 trainer output) | B2 `maps-bulk-ingest/gsplat/{ab}/{sha256}.ply` | already SHA-256 content-addressed, immutable Cache-Control | ✅ migration is bucket swap + CID embed |
| gsplat baked GLB (TSDF fusion mesh) | B2 `maps-bulk-ingest/gsplat/{ab}/{sha256}.glb` | same scheme | ✅ same as above |
| Satellite COGs (Sentinel-2 / Landsat / HLS / NAIP) | external STAC URLs (no maps-owned blob) | n/a | ✅ no migration needed; STAC URL stored in record |
| Mapillary street view | external URL | n/a | ✅ no migration |
| User post images (with EXIF) | atproto PDS blob (`@atproto/api` upload) | atproto-native | ✅ already kotoba-datomic-aligned (PDS blob ≈ IPFS CID) |
| Web crawl WET/WAT records | via `site.etzhayyim.com` cross-actor | external | ✅ delegated, no maps-side action |
| OSM raster tile fallback (zoom ≥ 7) | external (`tile.openstreetmap.org`) | n/a | ✅ no maps-owned blob; tracked as `[[migrations]] maps-shader-view-precision` for elimination |

**Tier D is mechanically the simplest. Replace 1 file: `bulk-ingest/workers/gsplat_train_dumper.py` `_b2_head` / `_b2_put` → `ipfs_pin` via `@etzhayyim/sdk` Python equivalent (TBD kotodama primitive).**

## Bulk-ingest pod tier mapping

All 13 pods currently use `asyncpg → RisingWave`. Per-pod migration target:

| Pod | RW call sites | Target tier | Action |
|---|---:|---|---|
| `gtfs_jp_dumper.py` | 7 | C (RT-adjacent timetable) | RW retained, reframe as projection input once ADR lands |
| `gtfs_rt_dumper.py` | 6 | C (streaming MV) | RW retained, projection input |
| `openflights_dumper.py` | 6 | B (append-only ODbL routes) | port to SDK.write |
| `ferry_routes_dumper.py` | 6 | B (append-only OSM ferry) | port to SDK.write |
| `geonames_dumper.py` | 6 | A (place gazetteer, low write) | port to SDK.write |
| `overture_maps_dumper.py` | 9 | B (heritage building / road) | port to SDK.write + witness |
| `wikidata_dumper.py` | 7 | B (HQ coords / corporations) | port to SDK.write + witness |
| `wikipedia_dumper.py` | 6 | B (article-derived POIs) | port to SDK.write + witness |
| `gsplat_train_dumper.py` | 9 | D (blob) + B (job event log) | IPFS blob migration + job log via SDK.write |
| `noaa_ais_dumper.py` | 7 | C (vessel position RT) | RW retained, projection input |
| `aismarine_consumer.py` | 11 | C (vessel position stream) | RW retained, projection input |
| `aismarine_wikidata_lei.py` | 6 | A (LEI registry join) | port to SDK.write |
| `maps_search_ivf_backfill.py` | 7 | C (vector index for spot_search) | projection input |

## Phased migration plan

### Phase 0 — Audit & prerequisite (this commit + 1 week)

- [x] Adopt `kotoba-datomic` as architecture name (ADR-2605231400)
- [x] This `MIGRATION-TODO.md` published
- [x] Implement `20-actors/etzhayyim-sdk/src/kotoba-datomic/{witness-selector,quorum}.ts` (ADR-2605231400 implementation plan #1-#2, shipped 2026-05-23)
- [x] Lexicon `com.etzhayyim.kotoba-datomic.{attestation,membraneRule}` published (ADR-2605231400 #3, shipped 2026-05-23)
- [x] kotoba-datomic-projection ADR drafted ([ADR-2605231500](../../90-docs/adr/2605231500-kotoba-datomic-projection.md), shipped 2026-05-23) — unblocks Tier C

### Phase 1 — Tier A migration (2 weeks after Phase 0)

- [x] **Source DID registry** (`registerSource` / `listSources`) — ported 2026-05-23. Package: [`kotoba/src/source/`](kotoba/src/source/). Lexicon: [`source.json`](../../orgs/etzhayyim/com-etzhayyim-maps/wire/lex/source.json). 24-record seed in [`kotoba/data/sources.json`](kotoba/data/sources.json). 53 vitest. Pending: live PDS seed run after `ETZ_SEEDER_DID` + auth wired
- [x] **Geo DID Management** (8 commands) — ported 2026-05-23. Package: [`kotoba/src/geo/`](kotoba/src/geo/). 5 lexicons: [`region.json`](../../orgs/etzhayyim/com-etzhayyim-maps/wire/lex/region.json), [`geoAlias.json`](../../orgs/etzhayyim/com-etzhayyim-maps/wire/lex/geoAlias.json), [`verticalZone.json`](../../orgs/etzhayyim/com-etzhayyim-maps/wire/lex/verticalZone.json), [`naturalZone.json`](../../orgs/etzhayyim/com-etzhayyim-maps/wire/lex/naturalZone.json), [`layerCoordinator.json`](../../orgs/etzhayyim/com-etzhayyim-maps/wire/lex/layerCoordinator.json). 59-record seed (14 vertical + 34 natural + 11 layer) + 29-scheme manifest. 41 vitest. **Note**: `resolveZones3d` returns vertical zone only; natural-zone polygon intersection is a kotoba-datomic-projection (Tier C). Region/Alias seeds are pipeline-driven (Wikidata SPARQL → bulk-ingest), not in this constant-fixture seeder
- [x] **Display layer** (`display_layer_define` / `list_display_layers`) — ported 2026-05-23. Package: [`kotoba/src/display-layer/`](kotoba/src/display-layer/). Lexicon: [`displayLayer.json`](../../orgs/etzhayyim/com-etzhayyim-maps/wire/lex/displayLayer.json) (8 render kinds: fill/line/circle/symbol/extrude/heatmap/raster/gsplat). 24 vitest. No constant seed — operator-defined
- [x] **Registry & Legal Entity register/list** (22 commands) — ported 2026-05-23. Package: [`kotoba/src/registry/`](kotoba/src/registry/). 3 discriminated lexicons: [`legalEntity.json`](../../orgs/etzhayyim/com-etzhayyim-maps/wire/lex/legalEntity.json) (6 entity types), [`registry.json`](../../orgs/etzhayyim/com-etzhayyim-maps/wire/lex/registry.json) (8 registry types), [`ownership.json`](../../orgs/etzhayyim/com-etzhayyim-maps/wire/lex/ownership.json) (5 relations + sharePctBps as bps integer to avoid float drift). 34 vitest. `ownershipChain` + `entityHistory` are TID-keyed event log scans (sort by `effectiveDate`). No constant seed — pipeline-driven (GLEIF / NTA / OpenCorporates etc.)
- [x] **Collection plumbing** (`createCollectionJob` / `advanceJob` / `listJobs` / `getJobStatus`) — ported 2026-05-23. Package: [`kotoba/src/collection/`](kotoba/src/collection/). 2 lexicons: [`collectionJob.json`](../../orgs/etzhayyim/com-etzhayyim-maps/wire/lex/collectionJob.json) (immutable descriptor, `literal:{jobId}` rkey) + [`jobEvent.json`](../../orgs/etzhayyim/com-etzhayyim-maps/wire/lex/jobEvent.json) (append-only TID-keyed event log; 6 states, 4 terminal). `summariseEvents()` reducer derives latest state by sorting events ascending and cascading optional fields. 45 vitest. Fan-out: `advanceJob` writes a new event, never mutates the descriptor (matches kotoba-datomic append-only invariant)
- [x] **`kotodama.substrate` Python SDK primitive** — shipped 2026-05-23. Module at `40-engine/kotoba/crates/kotoba-kotodama/py/src/kotodama/substrate/` with `Etzhayyim` class (`write` / `read` / `verify`) mirroring the TS `@etzhayyim/sdk` shape. httpx + mock-transport; 18/18 tests pass. Auth: `session_jwt` (user) or `internal_token` (service-to-service via `x-kotodama-verified`). `verify()` is scaffold (parity with TS 0.1.0-alpha)
- [x] **`geonames_dumper.py` pod** — ported 2026-05-23. `USE_PYKOTODAMA_SUBSTRATE=1` env flag enables `kotodama.substrate` write path to `com.etzhayyim.maps.feature`; legacy psycopg2 path retained as fallback. `_geonames_row_to_feature()` pure converter (h3-py via lazy import; bbox in microdegrees per lexicon). 8 converter tests in `bulk-ingest/tests/test_geonames_port.py`
- [ ] `aismarine_wikidata_lei.py` pod — recipe documented in [`bulk-ingest/PORT-NOTES.md`](bulk-ingest/PORT-NOTES.md) (2 INSERT sites → 2 `com.etzhayyim.maps.ownership` records each). Pod file annotated with migration target. Apply the same 5-step pattern as geonames port
- [ ] Validation: all 46 Tier A commands return identical results before/after via golden-file integration test

### Phase 2 — Tier D blob migration (parallel with Phase 1)

- [ ] IPFS pin primitive for kotodama (analog of `@etzhayyim/sdk` TS `pds.uploadBlob`)
- [ ] `gsplat_train_dumper.py`: B2 `_b2_head` / `_b2_put` → `ipfs_pin` (preserve SHA-256 path scheme; CID embedded in `vertex_maps_gsplat_asset.blob_cid`)
- [ ] `gsplat_train_dumper.py`: same for baked GLB
- [ ] Backfill: existing B2 blobs (`bulk-ingest/tools/rewrite_gsplat_cache_control.py` analog) → IPFS pin + CID emit in MST
- [ ] Charter Rider Cache-Control invariant preserved (`immutable, public, max-age=86400`)
- [ ] Browser-side change: `kami-engine` PLY/GLB loader URL: B2 → IPFS gateway (parameterized, fallback to B2 during transition)

### Phase 3 — Tier B L1 witnessed migration (3 weeks after Phase 0)

- [x] **Pre-req: witness-selector + quorum + Murakumo fleet capacity check** — shipped 2026-05-23. `@etzhayyim/sdk/kotoba-datomic` exports `selectWitnesses` + `collectQuorum` + `produceAttestation` + `writeWithWitnesses` + `createInMemoryWitnessTransport` + `createPdsPollingWitnessTransport`. Fleet capacity sized in ADR-2605231400 (10 nodes × 15 cells, fanout 5 → ~6.7 cells/quorum-task)
- [x] **Tier B production demo: `register_mountain` (+ `register_feature` + `register_building`)** — shipped 2026-05-23. Package: [`kotoba/src/feature/`](kotoba/src/feature/). Lexicon: existing [`feature.json`](../../orgs/etzhayyim/com-etzhayyim-maps/wire/lex/feature.json) (label-discriminated). `featureSchemaValidator` checks 4 required fields + bbox quad invariant. `DEFAULT_FEATURE_MEMBRANE_RULE` 3-of-5/council fixture. 9 vitest including end-to-end Mount Fuji registration with mock 30-cell fleet → witnessed/accept verdict + 4 rejection paths (missing h3Cell, malformed geometry, h3Resolution out of range, partial bbox)
- [ ] Remaining Geography Intelligence (17 commands) — port + witness following the `register_mountain` pattern (same lexicon, label-discriminated)
- [ ] Building / Floor / Asset registration — `register_building` shipped as part of demo; remaining 11 commands (Floor / Asset / Sensor / TwinState) port + witness
- [ ] Transport infrastructure register-side (12) — port + witness, label-discriminated
- [ ] `overture_maps_dumper.py` + `wikidata_dumper.py` + `wikipedia_dumper.py` + `openflights_dumper.py` + `ferry_routes_dumper.py` pods — `asyncpg` → SDK write + witness
- [ ] Web Crawl Geo Entity ingest path — port + witness
- [ ] Vision / Satellite metadata commands (8) — port + witness
- [ ] Mapraly batch (3) — port + witness
- [ ] Validation: ≥3-of-5 attestation persisted alongside CID for every Tier B record

### Phase 4 — kotoba-datomic-projection ADR + Tier C design (blocked on follow-up #5)

- [ ] ADR draft: defines `kotoba-datomic-projection` (regenerable cache layer reading from kotoba-datomic-chain + kotoba-datomic-dht, replayed deterministically)
- [ ] Reframe `vertex_spatial` and `vertex_maps_*` RW tables as kotoba-datomic-projection outputs (NOT canonical state)
- [ ] Snapshot-and-replay tool: rebuild any projection table from MST + IPFS without operator intervention
- [ ] Test: drop projection DB, replay from MST, byte-identical to pre-drop state for fixed slice

### Phase 5 — Tier C reframing (4-8 weeks after Phase 4 ADR lands)

- [ ] `tileGeoJson` XRPC: backend swap (still RW under the hood, but reads marked "kotoba-datomic-projection L1-projection conformance")
- [ ] `getChunk`, `realtimeDelaysAtStop`, `nextDeparturesAtStop`, `graph_traverse`, `graph_neighbors`, `search_resources`, `infra_query`, `infra_cross_section`, `spatial_event_query` + 8 other Tier C reads — projection-conformance label
- [ ] GTFS-RT MV writes: dumper writes to MST first, projection MV consumes MST commits as input (streaming projection rebuild)
- [ ] Operator playbook: how to drop & replay projection DB (drift detection, repair)

### Phase 6 — L2 anchored archival conformance (8+ weeks)

- [ ] `EtzhayyimAnchor` deployed on Base Sepolia, then mainnet (depends on Council bootstrap completion per ADR-2605192300)
- [ ] anchor-cron schedule for `maps.etzhayyim.com` PDS MST roots (default every 6 h or 1024 commits)
- [ ] Archival audit lexicon: query any historical Building/AdminArea registration via `e.verify(uri)` → Merkle proof + on-chain anchor tx

## Open questions

- **OQ-M-1** (Lexicon NSID cutover): when does `com.etzhayyim.apps.maps.*` migrate to `com.etzhayyim.maps.*`? This is independent of kotoba-datomic conformance but needed for Charter §1 doctrinal-position consistency (operating entity = etzhayyim, not etzhayyim). Suggest: bundle into Phase 1.
- **OQ-M-2** (Witness on encrypted user-post EXIF): per [ADR-2605181100](../../90-docs/adr/2605181100-app-etzhayyim-encrypted-records.md) `com.etzhayyim.encrypted.*` envelope, can a witness validate envelope structure + signature without decrypting EXIF payload? Tracked as kotoba-datomic SPEC OQ-1; resolution blocks user post path.
- **OQ-M-3** (Search index witness): vector IVF backfill (`maps_search_ivf_backfill.py`) produces a derived structure (embedding index), not a primary record. Treat as kotoba-datomic-projection (Tier C) or as a derived Tier B record kind with witness over the embedding model hash? Suggest projection unless audit trail is needed.
- **OQ-M-4** (Cross-actor invoke during witness): commands that `sdk.pds.dispatch({type:"invoke", payload:{did:"site.etzhayyim.com", ...}})` (e.g., `seed_geo_domains`) — does the witness wait for the cross-actor reply, or attest only on the dispatch envelope? Suggest envelope-only attestation; downstream actor produces its own witnessed records.
- **OQ-M-5** (gsplat job state log): `vertex_maps_gsplat_job` is high-frequency append (per-phase events). Treat as Tier B (witness every event) or Tier C (projection from MST job log)? Suggest C — witness overhead per heartbeat would balloon validation load.

## Out of scope for this TODO

- NSID cutover ritual (OQ-M-1) — needs its own short ADR if not bundled with Phase 1
- Charter Rider implications for any commercial / paid maps surface — none currently, but if `tileGeoJson` gets metered, ADR-2605192115 §4 carve-out review required
- KAMI 3D rendering / WASM bindings / shader precision migrations — separate `deps.toml [[migrations]] maps-shader-view-precision` track, not kotoba-datomic-blocking
- `maps-tile-server-t1l3srv0` standalone tile server — independent migration, audit in follow-up PR

## Success criteria

The maps app is **kotoba-datomic L1-witnessed conformant** when:

1. zero `createKyselyDb(env.HYPERDRIVE)` call sites remain in `appview/maps-ui-uqpel6i6/src/app.ts` except those explicitly marked `// kotoba-datomic-projection` and covered by Phase 4 ADR
2. zero `asyncpg.connect(RW_DSN)` call sites remain in `bulk-ingest/workers/` except Tier C (GTFS-RT / NOAA AIS / aismarine / search-IVF)
3. every Tier B record carries ≥3-of-5 attestation in its companion `com.etzhayyim.kotoba-datomic.attestation` record
4. CI lint (`70-tools/scripts/lint/substrate-boundary.mjs`) passes without `maps-` exemption
5. PDS MST root for `maps.etzhayyim.com` anchors to Base L2 within 6 h SLA

---

## RW → MST substrate codemod (2026-05-23)

<!-- rw-mst-codemod-progress:2605231900 -->

**Status**: 🟡 partial — substrate seam shipped + 1 worker migrated. See
[`bulk-ingest/workers/MIGRATION-TODO.md`](bulk-ingest/workers/MIGRATION-TODO.md)
for the per-worker checklist.

### Applied

- New `bulk-ingest/workers/_etzhayyim_substrate.py` — `open_substrate_writer()`
  context manager. Dispatches on `ETZHAYYIM_SUBSTRATE_MODE` (`mst` → PDS XRPC
  + MST + IPFS + Base L2 anchor; `rw` → transitional psycopg2 fallback).
- `openflights_dumper.py` migrated end-to-end (reference impl, zero behavioural
  change in `rw` mode).
- 12 remaining workers annotated with `# CHARTER-VIOLATION §substrate` so the
  substrate-boundary lint catches future commits.

### Remaining

- 12 worker files: same mechanical refactor as openflights_dumper. See
  per-file checklist in `bulk-ingest/workers/MIGRATION-TODO.md`.
- Lexicons for the 51 maps node labels (`com.etzhayyim.apps.maps.{label}`) —
  several exist; remaining ones need scaffolds before `ETZHAYYIM_SUBSTRATE_MODE=mst`
  can be flipped in production.

_Closed (Stage 1) by `70-tools/scripts/codemod/2605231900-maps-psycopg-substrate-annotate.mjs`._
