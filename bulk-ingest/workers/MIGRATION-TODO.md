# maps bulk-ingest workers — RW → kotoba/MST migration TODO

**Status (2026-06-06)**: 🟡 partial. Substrate seam now supports `kotoba` (canonical Datom
log, ADR-2606064500), `mst` (AT Protocol ingress), and `rw` (transitional). The 6 Tier-1
feature dumpers (openflights/wikidata/wikipedia/ferry_routes/geonames/overture_maps) reach
kotoba through the seam unchanged once `ETZHAYYIM_SUBSTRATE_MODE=kotoba` is set.

## kotoba mode (ADR-2606064500 R2)

`ETZHAYYIM_SUBSTRATE_MODE=kotoba` routes `upsert_vertex_spatial(rows)` →
`_kotoba_feature.rows_to_batch` (the 51 legacy labels fold onto `:feature/label`, the H3-cell
index `:feature.cell/rN` is stamped from the centroid) → `kg.ingest_batch` on the canonical
kotoba Datom log. This is the bulk-feed half of the maps substrate migration; the maps Worker
read/write adapter (`maps-ui/src/kotoba-spatial.ts`) is the interactive half. Both share the
`:feature/*` ontology and the SAME label map (a test asserts `_kotoba_feature._LABEL_MAP` ==
`orgs/etzhayyim/com-etzhayyim-maps/methods/ingest.py _LABEL_MAP`). The dumper also stamps the **name-search
index** `:feature/name-token` via `_kotoba_feature.name_tokens` (a test asserts it equals
`orgs/etzhayyim/com-etzhayyim-maps/methods/search.py name_tokens`), so dumper-ingested features are name-
searchable like adapter-ingested ones.

**Gated (G4/G7, no-server-key):** kotoba mode REQUIRES `MAPS_OPERATOR_GATE=1` + `KOTOBA_ENDPOINT`
+ `KOTOBA_AUTH` (member/operator DID bearer; the pod holds no platform key). Absent any, the
writer construction raises — a dumper flipped to kotoba mode without the gate fails loudly,
never silently drops. `upsert_table` (aux RW tables: vertex_maps_trip, gsplat registries)
maps the GTFS aux tables **`vertex_maps_trip` / `vertex_maps_stop_time`** →
`:transit.trip/*` / `:transit.stop-time/*` (`orgs/etzhayyim/com-etzhayyim-maps/contracts/ontology/maps-transit-ontology.kotoba.edn`);
still-unmapped aux tables (gsplat registries, GTFS-RT) raise `NotImplementedError` (per-table
kotoba schemas = ongoing R2 follow-up). The "next departures at stop X" read =
`AVET(:transit.stop-time/stop, <stop-id>)` sorted by `:transit.stop-time/departure-time`
(the kotoba equivalent of idx_maps_stop_time_stop_dep).

Bring-up (operator): `kubectl -n maps-bulk-ingest set env deploy/<dumper> ETZHAYYIM_SUBSTRATE_MODE=kotoba MAPS_OPERATOR_GATE=1 KOTOBA_ENDPOINT=… KOTOBA_AUTH=…`.
Tests: `python3 workers/test_kotoba_substrate.py` (15 green; real H3 under a venv with `h3`).

---

## (historical) RW → MST migration

## What changed

- Added `_etzhayyim_substrate.py` providing `open_substrate_writer()`
  context manager. Dispatches on `ETZHAYYIM_SUBSTRATE_MODE`:
  - `mst` — writes via PDS XRPC `com.atproto.repo.createRecord` →
    PDS commit pipeline → MST + IPFS + Base L2 anchor.
  - `rw` (default for now) — psycopg2 into `vertex_spatial`, identical
    to the pre-migration behaviour. Logs a deprecation warning on startup.
- `openflights_dumper.py` migrated to `open_substrate_writer()` as the
  reference. The `_insert_rows_into_rw` helper was replaced by
  `_insert_rows_into_substrate`.

## Stage 2 (2026-05-23) — Tier 1 + Tier 2 annotated

The substrate-cutover codemod `70-tools/scripts/codemod/2605232000-maps-psycopg-substrate-apply.py`
applied on 2026-05-23:

- **Tier 1 (fully migrated, standard `_insert_rows_into_rw` pattern, 5 files)**:
  `wikidata_dumper.py`, `wikipedia_dumper.py`, `ferry_routes_dumper.py`,
  `geonames_dumper.py`, `overture_maps_dumper.py`. Each file has its
  `psycopg2` import removed, the seam imported, and the standard
  helper renamed to `_insert_rows_into_substrate` (+ all callers).
  Total: **6** Tier-1 files including `openflights_dumper.py` (the
  initial reference impl).

- **Tier 2 (annotated, `psycopg2` retained as guarded fallback, 7 files)**:
  `gtfs_jp_dumper.py`, `gtfs_rt_dumper.py`, `gsplat_train_dumper.py`,
  `noaa_ais_dumper.py`, `maps_search_ivf_backfill.py`,
  `aismarine_consumer.py`, `aismarine_wikidata_lei.py`. Each file
  imports `open_substrate_writer` AND keeps `import psycopg2  # noqa`
  with an in-file `TODO(ADR-2605172000 / Stage 2)` block. Callers
  using the standard helper name were renamed; the worker-specific
  multi-table / aux-table / executemany call sites still target
  RisingWave directly and need per-file review.

AST-parse smoke for all 13 files passes.

## Remaining (Tier 2 per-table refactor) — same mechanical-shaped surface

For each of the workers below, replace:

```python
import psycopg2
...
conn = psycopg2.connect(DATABASE_URL)
...
cur.execute("INSERT INTO vertex_spatial ...")
```

with:

```python
from _etzhayyim_substrate import open_substrate_writer
...
with open_substrate_writer() as writer:
    writer.upsert_vertex_spatial(rows)
```

Files still needing per-table refactor (Tier 2 — psycopg2 fallback active):

- [ ] `gtfs_jp_dumper.py` — writes to `vertex_spatial` plus
      `vertex_maps_trip` + `vertex_maps_stop_time` (timetable). Use
      `writer.upsert_vertex_spatial(...)` for the spatial rows and
      `writer.upsert_table('vertex_maps_trip', ...)` /
      `writer.upsert_table('vertex_maps_stop_time', ...)` for the aux rows.
- [ ] `gtfs_rt_dumper.py` — aux-table-only writes
      (`vertex_maps_vehicle_position`, `vertex_maps_trip_update`,
      `vertex_maps_service_alert`). Each via `writer.upsert_table(...)`
      with the table-specific composite PK as `conflict_key`.
- [ ] `gsplat_train_dumper.py` — appends to `vertex_maps_gsplat_job`
      (job-state log, append-only). Either `writer.upsert_table(
      'vertex_maps_gsplat_job', rows, conflict_key=None)` or a
      lexicon-shaped record write.
- [ ] `noaa_ais_dumper.py` — `executemany` into
      `vertex_vessel_position` + `vertex_vessel`. Standard
      `writer.upsert_table(...)` calls with `conflict_key='vertex_id'`.
- [ ] `maps_search_ivf_backfill.py` — backfills
      `vertex_vector_embedding_768`. Set `dml_rate_limit=5000` is
      RW-specific; the substrate seam should expose a hint or the
      caller should drop the rate-limit knob (MST batching is the
      bottleneck post-cutover).
- [ ] `aismarine_consumer.py` — long-lived consumer with a shared
      psycopg2 connection. Refactor to acquire the writer per batch
      via `with open_substrate_writer() as writer:`.
- [ ] `aismarine_wikidata_lei.py` — multi-step rate-limited insert.
      Same pattern as `aismarine_consumer`.

Acceptance per file:
- [ ] `psycopg2` import removed.
- [ ] `DATABASE_URL` constant only referenced via the substrate writer.
- [ ] Existing batch sizes and idempotency contracts preserved.
- [ ] Unit / smoke test (if present) passes with `ETZHAYYIM_SUBSTRATE_MODE=rw` (no behavioural change).

## Cutover plan

1. Migrate all 13 workers to `open_substrate_writer()` (above).
2. Land lexicons `com.etzhayyim.apps.maps.{label}` for the 51 node labels
   currently projected onto `vertex_spatial` (Spot, Place, Airport,
   Railway, SeaRoute, BusRoute, Port, Station, BusStop, Parking,
   EvCharger, River, Lake, Coastline, Mountain, MaritimeZone,
   AdminArea, Building, BuildingFloor, PhysicalAsset, …). Several
   already exist under `00-contracts/lexicons/com/etzhayyim/apps/maps/`;
   the rest need scaffolds.
3. Council Lv6+ ratifies the cutover; operator sets
   `ETZHAYYIM_SUBSTRATE_MODE=mst` on the k8s `maps-bulk-ingest` pod
   secret. The legacy psycopg path stays available as a roll-back
   switch for one migration window.
4. After 30 days of clean MST writes, drop the `rw` branch in
   `_etzhayyim_substrate.py` (delete `_RwSubstrateWriter` + remove
   `psycopg2` from the pod image).

## Related ADRs

- ADR-2605172000 — kotoba substrate (this is the migration's anchor).
- ADR-2605172100 — substrate boundary (no fiat processors).
- ADR-2605192115 — Charter Rider §1 (substrate hard rules).
- `/CLAUDE.md` § "Substrate boundary" — the cross-monorepo table.
