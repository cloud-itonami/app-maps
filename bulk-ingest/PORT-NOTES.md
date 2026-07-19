# bulk-ingest kotodama.substrate port notes

Migration recipe for the maps bulk-ingest Python pods per kotoba-datomic
Phase 1 Tier A (see [`../MIGRATION-TODO.md`](../MIGRATION-TODO.md) +
[ADR-2605231400](../../../90-docs/adr/2605231400-kotoba-datomic-holochain-iso-substrate.md)).

The pattern preserves the existing legacy psycopg2 → RisingWave INSERT
code path and adds a parallel kotodama.substrate write path gated by
`USE_PYKOTODAMA_SUBSTRATE=1`. When the new path is enabled and proven, the
legacy path can be deleted and the pod is kotoba-datomic L0-nominal.

## Pattern recipe (5 steps)

1. **Add env flag + substrate config (~10 lines)** near the existing
   env block:
   ```python
   USE_PYKOTODAMA_SUBSTRATE = os.environ.get("USE_PYKOTODAMA_SUBSTRATE", "0") == "1"
   SUBSTRATE_DID = os.environ.get("SUBSTRATE_DID", "did:web:maps.etzhayyim.com")
   SUBSTRATE_COLLECTION = "com.etzhayyim.maps.<feature|legalEntity|ownership>"
   SUBSTRATE_BATCH = int(os.environ.get("SUBSTRATE_BATCH", "100"))
   ```

2. **Add a pure row-to-record converter** (`_<pod>_row_to_record`) that
   takes the legacy vertex_*/edge_* row dict and returns an
   `(rkey, record)` tuple matching the target lexicon. Keep this function
   pure — no I/O — so it can be unit-tested without a live PDS.

3. **Add the async substrate writer**:
   ```python
   async def _write_via_substrate(rows: list[dict], batch_size: int = SUBSTRATE_BATCH) -> int:
       from kotodama.substrate import Etzhayyim, WriteOpts
       total = 0
       async with Etzhayyim(did=SUBSTRATE_DID) as e:
           for i in range(0, len(rows), batch_size):
               for row in rows[i : i + batch_size]:
                   rkey, record = _<pod>_row_to_record(row)
                   await e.write(WriteOpts(collection=SUBSTRATE_COLLECTION, record=record, rkey=rkey))
                   total += 1
       return total
   ```

4. **Add the sync dispatcher** between the existing INSERT site and the
   new path:
   ```python
   def _insert_rows_dispatch(rows: list[dict]) -> int:
       if USE_PYKOTODAMA_SUBSTRATE:
           import asyncio
           return asyncio.run(_write_via_substrate(rows))
       return _insert_rows_into_rw(rows)
   ```
   Then replace the call site `_insert_rows_into_rw(rows)` →
   `_insert_rows_dispatch(rows)`. The legacy function stays in place as a
   fallback.

5. **Add a converter test** in `bulk-ingest/tests/` — pure functions, no
   network. Pattern: import the pod module via `sys.path.insert`, feed it
   a representative row dict, assert the record shape matches the lexicon.

## Per-pod status

| Pod | Status | Target lexicon | Notes |
|---|---|---|---|
| **`geonames_dumper.py`** | ✅ Ported 2026-05-23. Legacy path preserved; substrate path under `USE_PYKOTODAMA_SUBSTRATE=1`. 8 converter tests | `com.etzhayyim.maps.feature` | Each geonames row → 1 feature record. h3Cell computed via h3-py (lazy import; falls back to `unknown-resN` placeholder if h3 missing). bbox is point (W=E, S=N) in microdegrees |
| **`aismarine_wikidata_lei.py`** | ⏳ Skeleton TBD | `com.etzhayyim.maps.ownership` (vessel → corp/operator edges) | Apply the 5-step recipe. 2 INSERT call sites (`edge_vessel_owned_by` + `edge_vessel_operated_by`) → 2 ownership records each iteration. The pod reads `vertex_vessel` by IMO → looks up MMSI in Wikidata LEI registry → writes edges. Substrate side: vessel and operator are LegalEntity records (pre-existing or seeded separately); ownership record points subjectUri → operator, objectUri → vessel |
| `gtfs_jp_dumper.py` | Phase 1 (Tier C) — projection retained, no port | — | streaming-MV input, stays on RW |
| `gtfs_rt_dumper.py` | Phase 1 (Tier C) | — | streaming-MV input |
| `openflights_dumper.py` | Phase 1 (Tier B, requires witness) | `com.etzhayyim.maps.feature` (Airport) + a new flight-route lexicon | TBD |
| `ferry_routes_dumper.py` | Phase 1 (Tier B) | `com.etzhayyim.maps.feature` (SeaRoute / Port) | TBD |
| `gsplat_train_dumper.py` | Phase 2 (Tier D blob) | IPFS pin via kotodama.substrate.upload_blob (TBD primitive) + `com.etzhayyim.maps.gsplatAsset` | Larger refactor — TBD |
| `wikidata_dumper.py` / `wikipedia_dumper.py` / `overture_maps_dumper.py` | Phase 1 (Tier B) | `com.etzhayyim.maps.feature` | TBD |
| `noaa_ais_dumper.py` / `aismarine_consumer.py` | Phase 1 (Tier C) | — | vessel position stream, stays on RW |
| `maps_search_ivf_backfill.py` | Phase 1 (Tier C) | — | vector index, projection only |

## Env vars (geonames-style)

| Var | Default | Purpose |
|---|---|---|
| `USE_PYKOTODAMA_SUBSTRATE` | `0` | Set to `1` to enable substrate write path |
| `SUBSTRATE_DID` | `did:web:maps.etzhayyim.com` | Acting DID for PDS createRecord |
| `SUBSTRATE_BATCH` | `100` | Records per batch (substrate Etzhayyim.write loop) |
| `ETZ_PDS_URL` | `https://pds.etzhayyim.com` | PDS endpoint (read by `kotodama.substrate.Etzhayyim`) |
| `ETZ_SESSION_JWT` | — | User-side auth (preferred for human-driven seeds) |
| `KOTODAMA_INTERNAL_TOKEN` | — | Service-to-service auth (used by pod-side workers) |
| `SUBSTRATE_H3_RES` | `8` | H3 resolution for `h3Cell` field (≈neighborhood) |

## CI / smoke

| Check | Command | Status |
|---|---|---|
| Substrate primitive tests | `pytest 40-engine/kotoba/crates/kotoba-kotodama/py/tests/test_substrate.py` | ✅ 18/18 |
| KotobaDatomic Python primitives | `pytest 40-engine/kotoba/crates/kotoba-kotodama/py/tests/test_kotoba-datomic.py` | ✅ 17/17 |
| Cell-runner /kotoba-datomic/attest endpoint | `pytest 40-engine/kotoba/crates/kotoba-kotodama/py/tests/test_cell_runner_attest.py` | ✅ 7/7 |
| Geonames port converter tests | `pytest 60-apps/etzhayyim-project-maps/bulk-ingest/tests/test_geonames_port.py` | ✅ 8/8 |
| Live PDS smoke (manual) | `USE_PYKOTODAMA_SUBSTRATE=1 ETZ_SESSION_JWT=... python workers/geonames_dumper.py` against a test PDS | ⏳ pending operator wiring |
| Murakumo cell witness smoke (manual) | TS orchestrator → `createPdsPollingWitnessTransport({requestEndpoint: (c) => "http://{c.node}:13000/kotoba-datomic/attest"})` against a launchd-managed cell-runner | ⏳ pending operator wiring |

## What this is NOT

- A removal of the legacy RW INSERT path. That stays as the default while
  the operator validates the substrate path against a test PDS.
- A blob migration for parquet shards. Per MIGRATION-TODO Phase 2 (Tier D)
  the gsplat PLY/GLB blobs migrate from B2 → IPFS. Parquet shards (this
  pod's output) follow that same pattern but are tracked separately.
- A Python equivalent of `kotodama.substrate.upload_blob`. That
  primitive doesn't exist yet — gsplat / parquet blob migration is Phase 2.
- Witness validation. Geonames writes to `com.etzhayyim.maps.feature`
  which is Tier B in MIGRATION-TODO (witnessed). The pod port establishes
  the SDK write path; witness wiring happens at the `@etzhayyim/sdk` /
  `kotodama.substrate` layer once `com.etzhayyim.kotoba-datomic.attestation`
  consumers are live in Murakumo cells (per ADR-2605231400 §5).
