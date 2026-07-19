# Rebuild runbook — maps-spatial-rw L0-projection

Authoritative: [ADR-2605231500](../../../90-docs/adr/2605231500-kotoba-datomic-projection.md)
+ [`kotoba-datomic-projection.edn`](../appview/maps-ui-uqpel6i6/kotoba-datomic-projection.edn)
+ [`MIGRATION-TODO.md`](../MIGRATION-TODO.md).

This document is the **rebuild guarantee** for the maps projection. The
projection's L0-projection status is conditional on this procedure remaining
executable by any third party given the inputs listed in §1.

## 1. Inputs

A third party (operator with no prior maps state) needs:

| Input | Source | Auth |
|---|---|---|
| atproto PDS read access | `maps.etzhayyim.com` PDS (public-read on `com.etzhayyim.maps.*` collections) | none required for public records; service JWT for `com.etzhayyim.encrypted.*` |
| IPFS gateway | `https://ipfs.etzhayyim.com` OR any public gateway | none |
| Base L2 RPC | `https://mainnet.base.org` OR any Base mainnet RPC | none |
| `com.etzhayyim.kotoba-datomic.attestation` collection (for L1+ rebuilds) | same PDS | none |
| Empty RisingWave (or any compatible substrate) instance | operator-supplied | operator |
| 30-graph schema migrations | `30-graph/graph-schema/migrations/*.ts` (in this monorepo) | none |

What the operator MUST NOT need:

- a snapshot file hand-produced by the previous operator
- credentials to a deleted system
- any non-public hand-curated config

## 2. Procedure (L0 — manual)

L0 rebuild is a documented sequence; no rebuild tool is required at this
tier. The L1 tier requires the procedure below to be automated as
`tools/rebuild-spatial-projection.ts`.

### 2.1. Prepare destination

```sh
# Apply the schema migrations against the empty projection instance.
cd 30-graph/graph-schema && pnpm db:migrate latest

# Verify the projection tables exist.
psql "$DATABASE_URL" -c "\dt vertex_spatial vertex_maps_* mv_maps_*"
```

### 2.2. Enumerate source records

For each NSID in `kotoba-datomic-projection.edn [source_collections]`:

```sh
# List all repos that publish this collection (typically just maps.etzhayyim.com,
# but cross-actor write paths may produce records on other repos).
curl -s "https://pds.etzhayyim.com/xrpc/com.atproto.repo.listRecords?repo=did:web:maps.etzhayyim.com&collection={NSID}&limit=100"
# Paginate via `cursor`.
```

Persist the resulting set as `(uri, cid, recordJson)` triples in a temp file
(JSON-LD lines or sqlite — operator choice).

### 2.3. Re-apply each record to the projection

For each `(uri, cid, recordJson)`:

1. Identify the destination table via `vertex-spatial-projection.ts`
   `mapsEntityToLabel(record)`. The label-to-table mapping is the canonical
   reference (snake_case column transformation, `props` overflow JSON
   handling, ON CONFLICT idempotency).
2. INSERT into the projection table with `ON CONFLICT (vertex_id) DO UPDATE`
   per the projection's existing convention.
3. If the record references a blob (gsplat PLY/GLB, satellite COG), pin the
   referenced CID locally for cache locality. The blob does NOT need to be
   re-uploaded — IPFS is the canonical store.

Order does not matter for record-only rebuild (records carry their full
state). Order DOES matter for streaming MVs — see §3.

### 2.4. Rebuild streaming MVs

Streaming MVs (`mv_maps_recent_vehicle_position`, `mv_maps_recent_trip_update`,
`mv_maps_active_alerts`, `mv_maps_gsplat_job_latest`) are derived from the
base tables. After §2.3 completes, refresh them:

```sql
-- Each MV's CREATE MATERIALIZED VIEW definition is in
-- 30-graph/graph-schema/migrations/20260428160000_vertex_maps_realtime.ts
-- For RisingWave streaming MVs, REFRESH is incremental from source.
SELECT pg_sleep(60);  -- allow streaming MV to catch up
```

### 2.5. Verify

```sql
SELECT COUNT(*) FROM vertex_spatial;
-- Compare against the source PDS record count for the relevant collections.
-- Expect: projection row count ≈ source record count (within ±0.1% for
-- streaming MV lag and the enumerated non_determinism rows).
```

## 3. Rebuild time

Per the manifest: **~240 min wall clock** on the current Murakumo fleet.
Bottlenecks:

| Phase | Time | Notes |
|---|---|---|
| `vertex_spatial` re-derive (~10M rows) | ~120 min | dominated by Kysely batched INSERT, parallelizable 5-way |
| GTFS feed re-import (~5M stop_times) | ~60 min | per-feed `DELETE + re-INSERT` (RW append-only, no UPSERT) |
| gsplat job log replay (6 month history) | ~30 min | append-only, no CID re-pin needed |
| Streaming MV catch-up | ~30 min | RW streaming pipeline lag |

## 4. L0-projection → L1-projection promotion

To bump this projection to L1-projection per [ADR-2605231500](../../../90-docs/adr/2605231500-kotoba-datomic-projection.md):

- [ ] Implement `tools/rebuild-spatial-projection.ts` automating §2.1–§2.5
- [ ] Add a CI smoke job that:
  - spins up an ephemeral RisingWave
  - replays §2 against a 1% slice of the source PDS
  - asserts the projection row count matches expected
  - tears down
- [ ] Wire the projection consumer (currently maps-ui Worker) to subscribe
  to `com.atproto.sync.subscribeRepos` for `maps.etzhayyim.com` and refuse
  writes whose source commit seq < last seen seq (out-of-order rejection)
- [ ] Document the drift detector cadence (suggested: nightly random-CID
  re-derive on 100 records, alert on any divergence)

## 5. Cross-references

- The label-to-table mapping is the canonical reference; if this runbook
  drifts from `appview/maps-ui-uqpel6i6/src/vertex-spatial-projection.ts`,
  trust the code.
- Migration order from primary tier (Tier A/B/C/D) is in
  [`MIGRATION-TODO.md`](../MIGRATION-TODO.md).
- The kotoba-datomic conformance definitions are in
  ADR-2605262130; historical conformance provenance is in
  [ADR-2607192500](../../../90-docs/adr/2607192500-protocol-libp2p-and-empty-engine-shell-drain.edn).
