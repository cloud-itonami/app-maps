# maps bulk-ingest — long-running dumper workers

24-hour coverage acceleration plan, Phase 2. K8s-resident workers that
download upstream bulk dumps (Wikipedia / OSM Planet), filter to geo-bearing
rows, and write live to RisingWave — bypassing the per-row CF Worker
dispatch pipeline.

## Active dumpers (2026-04-27)

- **wikipedia** — 107 lang `geo_tags.sql.gz` + `page.sql.gz` (~1-50 MB/lang).
  Robust: per-lang failures self-isolate.
- **overture-maps** — Stream Overture Maps Foundation GeoParquet releases (places, buildings, etc.) directly from S3 using pyarrow. Fast, requires no heavy local storage/PVC, robust metadata. Replaces the legacy 78GB planet.osm.pbf osmium pipeline.
- **geonames** — `download.geonames.org/export/dump/{cities1000|allCountries}.zip`
  TSV → `vertex_spatial`. Cheap (~12M rows full).
- **gtfs-jp** — per-prefecture GTFS-JP feeds (gtfs.jp aggregator + per-agency
  mirrors; default seed: Tokyo Metro / Toei / JR West / Chuo Bus). Parses
  `routes.txt` / `stops.txt` / `trips.txt` / `stop_times.txt` /
  `calendar.txt` and writes Railway / BusRoute / Station / BusStop rows
  with `{first_departure, last_departure, num_trips, num_stops,
  service_days{mon..sun}}` summary in `props`. BPMN
  `com.etzhayyim.apps.maps.bulkRefreshGtfsJp` (R/PT24H).
- **openflights** — `airports.dat` + `routes.dat` + `airlines.dat` (ODbL).
  ~7.7K Airport + ~67K AirRoute (one row per (airline, src, dst); midpoint
  lat/lng anchor; src/dst metadata in `props`). BPMN
  `com.etzhayyim.apps.maps.bulkRefreshOpenflights` (R/P7D).
- **ferry-routes** — OSM Overpass `relation[route=ferry]` worldwide
  (paginated by 7 continent bboxes) + `node[amenity=ferry_terminal]` /
  `node[harbour=yes]`. Writes SeaRoute / Port. BPMN
  `com.etzhayyim.apps.maps.bulkRefreshFerryRoutes` (R/P7D). ODbL.

## Disabled dumpers

- **wikidata** (`scale --replicas=0`, 2026-04-25) — `latest-all.json.gz` is a
  100GB monolithic single-stream file; HTTP/gzip cannot recover from network
  drops mid-stream (gzip decompressor state breaks on byte-range resume,
  observed `BrokenPipeError` / `zlib Error -3` every 7-15 min). curl
  `--retry-all-errors` does not help because the issue is gzip-state, not
  HTTP retry. **Wikidata coverage handled by Worker SPARQL dispatcher**
  (`runWikidata` in `appview/maps-ui-uqpel6i6/src/collection-commands.ts`)
  — per-profile typed queries with OFFSET pagination, ~600k rows/h potential.
  The 190k rows already loaded by the v1.0.4 wikidata bulk run remain in
  `vertex_spatial` (deterministic vertex_id → no duplicates on re-add).

## Architecture

```
┌─────────────────────────────────┐
│  BPMN timer R/PT24H             │  com.etzhayyim.apps.maps.bulkRefreshXxx
│  generic.http.fetch             │   (LangServer-deployed)
│      ↓ POST /trigger            │
└─────────┬───────────────────────┘
          │
┌─────────▼───────────────────────┐
│  K8s Deployment (resident pod)  │  vhf-16c-64gb spot, $0.27/h
│  bulk-ingest-{wikidata,wp,osm}  │
│   ├─ download (4-12h)           │
│   ├─ parse + filter (4-8h)      │
│   ├─ write parquet → B2         │
│   └─ COPY FROM s3 → RisingWave  │
└─────────┬───────────────────────┘
          │
┌─────────▼───────────────────────┐
│  RisingWave vertex_spatial      │  +5-50M rows / dump
└─────────────────────────────────┘
```

Status & logs reachable via MCP tools:
- `maps.bulk.refresh_wikidata` — trigger Wikidata dump
- `maps.bulk.refresh_wikipedia` — trigger Wikipedia geosearch dump
- `maps.bulk.refresh_overture_maps` — trigger Overture Maps dump
- `maps.bulk.status` — query current job status across all dumpers

## Why not the existing CF Worker dispatch?

| Constraint | CF Worker | K8s Deployment |
|---|---|---|
| Max runtime | 30s CPU | unlimited |
| Disk | none (R2 only) | 100GB ephemeral PVC |
| Memory | 128MB | 64GB+ |
| Streaming JSON.gz parse | ✗ | ✓ |
| `COPY FROM s3://` to RW | ✗ (no client lib) | ✓ (psycopg2) |

Bulk dumpers MUST be K8s pods. The CF Worker dispatch keeps for
incremental crawl; bulk fills the long tail in single passes.

## Scripts

| Script | Source | Output rows | Runtime |
|---|---|---|---|
| `wikidata_dumper.py` | `latest-all.json.gz` (100GB) → P625 filter | ~5M | 8-12h |
| `wikipedia_dumper.py` | per-lang geosearch dumps → coords | ~14M | 4-6h |
| `overture_maps_dumper.py` | S3 release (GeoParquet streams) | ~50M | 2-4h |
| `geonames_dumper.py` | geonames.org/export/dump/*.zip | ~12M | 1-2h |
| `gtfs_jp_dumper.py` | gtfs.jp + per-agency feed.zip × N | ~500K | 30-90 min |
| `openflights_dumper.py` | OpenFlights routes.dat + airports.dat | ~75K | <5 min |
| `ferry_routes_dumper.py` | OSM Overpass relation[route=ferry] worldwide | ~5K | 5-15 min |

All three write Parquet to `b2://etzhayyim-nats/maps-bulk-ingest/{date}/{source}/`,
then `COPY` into `vertex_spatial` via psql. Parquet stays for replay
(GDPR-Art-17 erasure of specific entities is via SQL DELETE, not parquet
delete — keep an audit trail).

## Deploy

```bash
# Build image (one-time)
docker build -t ghcr.io/etzhayyim/maps-bulk-ingest:1.0.0 60-apps/etzhayyim-project-maps/bulk-ingest/
docker push ghcr.io/etzhayyim/maps-bulk-ingest:1.0.0

# Deploy resident worker
kubectl apply -f 60-apps/etzhayyim-project-maps/bulk-ingest/k8s/deployment.yaml

# Trigger via MCP tool (or BPMN timer)
etzhayyim mcp call maps.bulk.refresh_wikidata
```

## Cost

- Pod: vhf-16c-64gb spot ≈ $0.27/h × 8h = **$2.16 / dump**
- B2 storage: 5GB parquet × $0.005/GB-mo = **$0.03/mo**
- Bandwidth (download): Wikidata/Wikipedia/OSM mirrors = free egress
- Bandwidth (B2 → RW): same Vultr DC = **$0** (Bandwidth Ally)

Total: **$2-5 per full refresh, monthly**.
