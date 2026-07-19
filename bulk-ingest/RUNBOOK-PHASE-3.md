# Phase 3 (GTFS-RT) bring-up runbook

Status as of 2026-04-27: **scaffold shipped, replicas=0, awaiting operator action**.

## (1) Verified Phase 2 feed seeds

Use these for `GTFS_JP_FEED_INDEX_URL` — all probed `rc=200 application/zip`,
all parse cleanly through `gtfs_jp_dryrun.py`, all sourced from the public
MobilityData catalog (`https://bit.ly/catalogs-csv`).

```json
[
  {"feed_id": "yamanashi",   "agency": "Yamanashi Bus",        "prefecture": "Yamanashi",
   "url": "http://opendata.busmaps.jp/yamanashi.zip"},
  {"feed_id": "kobe-subway", "agency": "Kobe Municipal Subway", "prefecture": "Hyogo",
   "url": "http://codeforkobe.github.io/kobe-transit/kobe_subway_gtfs.zip"},
  {"feed_id": "unobus",      "agency": "Uno Bus",               "prefecture": "Okayama",
   "url": "http://www3.unobus.co.jp/opendata/GTFS-JP.zip"},
  {"feed_id": "nagai",       "agency": "Nagai Transport",       "prefecture": "Gunma",
   "url": "https://www.nagai-unyu.net/rosen/GTFS/nagai/GTFS-JP_nagaibus-gunma-jp.zip"}
]
```

Yamanashi observed shape (the largest of the 4): **routes 434, stops 2,284,
trips 2,562, stop_times 86,489, calendar_dates 3,944**. Tokyo Metro / JR
East-class operators will be 1-2 orders larger (~ 5-30 M stop_times each)
and need ODPT (no public direct download).

```bash
# Host the index in B2 (publishable, no secrets):
aws --endpoint-url https://s3.us-west-004.backblazeb2.com s3 cp \
  index.json s3://etzhayyim-nats/maps-bulk-ingest/gtfs-jp/index.json --acl public-read

# Then point the dumper at it:
kubectl -n maps-bulk-ingest set env deploy/bulk-ingest-gtfs-jp \
  GTFS_JP_FEED_INDEX_URL=https://etzhayyim-nats.s3.us-west-004.backblazeb2.com/maps-bulk-ingest/gtfs-jp/index.json
```

## (2) ODPT registration runbook (Phase 3, ~5 min)

ODPT (公共交通オープンデータセンター) is the only path to RT for Tokyo
Metro / JR East / Toei. No-auth operators (Aomori, OdakyuBus, Donan, etc.)
publish their own RT URLs and live on `GTFS_RT_FEED_INDEX_URL` instead.

1. **Register**: https://developer.odpt.org/users/sign_up
   - Use `jun@etzhayyim.com` (per CLAUDE.md userEmail).
   - Confirm email link, then complete profile (purpose = "spatial intel platform").
2. **Agree to terms per dataset** at https://developer.odpt.org/info/distribution
   (each operator — TokyoMetro, JR-East, Toei — has its own click-through;
   skipping it on a dataset returns 403 even with a valid key).
3. **Mint key** at https://developer.odpt.org/users/<id>/api_keys → "Generate".
   Copy the `consumerKey` (32-hex string).
4. **Store in macOS Keychain** (per root CLAUDE.md "Local Secret Storage"):
   ```bash
   security add-generic-password \
     -s etzhayyim.transit -a ODPT_API_KEY \
     -w '<paste-the-32-hex-key>' -U
   # Verify:
   security find-generic-password -s etzhayyim.transit -a ODPT_API_KEY -w | wc -c
   # → 33 (32 chars + newline)
   ```
5. **Push to k8s Secret + scale up**:
   ```bash
   kubectl -n maps-bulk-ingest patch secret maps-bulk-ingest-credentials \
     --type=json -p='[{"op":"add","path":"/stringData/ODPT_API_KEY","value":"'$(security find-generic-password -s etzhayyim.transit -a ODPT_API_KEY -w)'"}]'
   kubectl -n maps-bulk-ingest scale deploy/bulk-ingest-gtfs-rt --replicas=1
   kubectl -n maps-bulk-ingest logs -f deploy/bulk-ingest-gtfs-rt
   # Expect: "RT dumper booting feeds=3 (vp=30s tu=60s alerts=300s)"
   #         "starting vehicle_position loop ..."
   ```

If you only want the no-auth slice (no ODPT account today):

```bash
# Skip steps 1-4. Just publish a no-auth RT index in B2:
cat > /tmp/rt-index.json <<'EOF'
[
  {
    "feed_id": "aomori-citybus",
    "agency": "Aomori City Bus",
    "vehicle_position_url": "https://www.aomori-toshikotsu.or.jp/gtfs-rt/vehiclePosition.bin",
    "trip_update_url":      "https://www.aomori-toshikotsu.or.jp/gtfs-rt/tripUpdate.bin",
    "alerts_url":           "https://www.aomori-toshikotsu.or.jp/gtfs-rt/alert.bin"
  }
]
EOF
# (verify each URL with `curl -sLI` first; this list is illustrative —
# operator publication moves around)
aws --endpoint-url https://s3.us-west-004.backblazeb2.com s3 cp \
  /tmp/rt-index.json s3://etzhayyim-nats/maps-bulk-ingest/gtfs-rt/index.json --acl public-read
kubectl -n maps-bulk-ingest set env deploy/bulk-ingest-gtfs-rt \
  GTFS_RT_FEED_INDEX_URL=https://etzhayyim-nats.s3.us-west-004.backblazeb2.com/maps-bulk-ingest/gtfs-rt/index.json
kubectl -n maps-bulk-ingest scale deploy/bulk-ingest-gtfs-rt --replicas=1
```

## (3) Migration static-analysis (pre-`pnpm db:migrate`)

Two new migrations land together:

| File | Contents |
|---|---|
| `30-graph/graph-schema/migrations/20260428150000_vertex_maps_trip_stop_time.ts` | `vertex_maps_trip` + `vertex_maps_stop_time` + 3 btree indexes |
| `30-graph/graph-schema/migrations/20260428160000_vertex_maps_realtime.ts` | `vertex_maps_vehicle_position` + `_trip_update` + `_service_alert` + 3 btree indexes + 3 streaming MVs |

ADR-2604241342 documents 4 known `pnpm db:migrate latest` failure modes
on RisingWave. Each migration was hand-checked against all 4:

| Failure mode | Phase 2 mig | Phase 3 mig |
|---|---|---|
| Kysely metadata corruption (mixing `executeQuery` + `schema.*` builders) | ✓ pure `sql\`…\`` only | ✓ pure `sql\`…\`` only |
| `ON CONFLICT` clauses (RW does not support, throws at parse) | ✓ none | ✓ none |
| `vitest` import inside migration file (pulls dev deps into prod runner) | ✓ none | ✓ none |
| Unsupported DDL (`ALTER TABLE … ALTER COLUMN TYPE`, partition tables, etc.) | ✓ only `CREATE TABLE` + `CREATE INDEX` | ✓ adds `CREATE MATERIALIZED VIEW` (RW-native, supported) |

Streaming MV nuance (Phase 3): `mv_maps_recent_*` use `WHERE ts > now() - INTERVAL '…'`
which RW evaluates as a streaming filter. Stale rows fall out of the view
at compaction time but remain in the base table — that is intended (raw
log retains 24h+ of history for replay; the MV is the cheap query path).
There is no TTL on the base tables; if the volume becomes a problem
add a separate `DELETE FROM … WHERE ts < now() - INTERVAL '7 days'`
job before turning Phase 3 on at scale.

Apply order:

```bash
cd 30-graph/graph-schema
pnpm db:migrate latest 2>&1 | tee /tmp/mig.log
# If kysely_migration row exists but tables missing (corruption case), use:
./scripts/apply-pending.sh

# Verify both migrations:
psql "$DATABASE_URL" -c "\dt vertex_maps_*"
psql "$DATABASE_URL" -c "\di idx_maps_*"
psql "$DATABASE_URL" -c "\dm mv_maps_*"
# Expect: 5 tables, 6 indexes, 3 materialized views
```

## What's still on you

| # | Action | Time | Blocks |
|---|---|---|---|
| 1 | `pnpm db:migrate latest` (Phase 2 + Phase 3 schema) | 2 min | bringing either dumper online |
| 2 | Publish `index.json` for gtfs-jp (use the 4 verified URLs above as a starter) | 10 min | gtfs-jp dumper |
| 3 | Build + push `ghcr.io/etzhayyim/maps-bulk-ingest:1.2.0` (`./deploy.sh build`) | 5 min | both dumpers |
| 4 | `./deploy.sh apply` + scale gtfs-jp `--replicas=1` | 2 min | Phase 2 live |
| 5 | ODPT account (or "no, skip") | 5 min | Phase 3 live |
| 6 | `etzhayyim deploy` for `maps-ui-uqpel6i6` (XRPC handlers) | 5 min | XRPC reachable |

After (1)+(2)+(3)+(4)+(6): `nextDeparturesAtStop` is live for the 4
verified bus operators above. After (5): `realtimeDelaysAtStop` returns
RT delays for ODPT operators.
