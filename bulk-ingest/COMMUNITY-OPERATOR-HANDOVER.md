# maps bulk-ingest — community-operator handover

Per [ADR-2605231525](../../../90-docs/adr/2605231525-no-server-key-religious-corp-architecture.md)
(No-Server-Key Religious-Corp Architecture) **Stage B**, the 13 bulk-ingest
pods that today run in the etzhayyim-operated k8s cluster will be
republished as **community-operated** repositories. etzhayyim infrastructure
will no longer hold the upstream-API credentials (`B2_ACCESS_KEY_ID`,
`MAPILLARY_ACCESS_TOKEN`, `RUNPOD_API_KEY`, `ODPT_API_KEY`,
`EMBED_AUTH_TOKEN`, `DATABASE_URL`) — instead, each pod is owned by a
community operator who runs it with their own credentials and submits
member-signed AT records that the etzhayyim relay subscribes to.

## Why

The substrate seam (`workers/_etzhayyim_substrate.py`) already supports
this transition: when `ETZHAYYIM_SUBSTRATE_MODE=mst`, every write goes
through PDS `com.atproto.repo.createRecord` (signed by the community
operator's own DID), not into a centralised RisingWave. The handover
flips the *operator* — the data path is unchanged.

## Repo split plan

| # | Existing pod | Community repo | Upstream | Operator credential | Cadence |
|---|---|---|---|---|---|
| 1 | `bulk-ingest-openflights` | `etzhayyim-community/maps-openflights-dumper` | OpenFlights ODbL | (none — public CSV) | R/P7D |
| 2 | `bulk-ingest-overture-maps` | `etzhayyim-community/maps-overture-dumper` | Overture Maps GeoParquet | AWS anon S3 | configurable |
| 3 | `bulk-ingest-gtfs-jp` | `etzhayyim-community/maps-gtfs-jp-dumper` | MLIT GTFS-JP × per-agency | per-agency feed URL index (operator-curated B2 / GitHub) | R/PT24H |
| 4 | `bulk-ingest-gtfs-rt` | `etzhayyim-community/maps-gtfs-rt-dumper` | ODPT realtime | `ODPT_API_KEY` (operator) | continuous |
| 5 | `bulk-ingest-geonames` | `etzhayyim-community/maps-geonames-dumper` | GeoNames | (none — public) | R/PT24H |
| 6 | `bulk-ingest-wikidata` | `etzhayyim-community/maps-wikidata-dumper` | Wikidata SPARQL | (none — public) | weekly |
| 7 | `bulk-ingest-wikipedia` | `etzhayyim-community/maps-wikipedia-dumper` | Wikipedia | (none — public) | weekly |
| 8 | `bulk-ingest-ferry-routes` | `etzhayyim-community/maps-ferry-routes-dumper` | OSM Overpass | (none — public) | R/P7D |
| 9 | `bulk-ingest-aismarine` | `etzhayyim-community/maps-aismarine-dumper` | NOAA AIS + WikiData LEI | NOAA AIS public, WikiData public | continuous |
| 10 | `cronjob-aismarine-noaa` | (subsumed into #9) | — | — | scheduled |
| 11 | `cronjob-maps-search-ivf` | `etzhayyim-community/maps-search-ivf-backfill` | derived index | (none) | scheduled |
| 12 | `bulk-ingest-gsplat-train` | `etzhayyim-community/maps-gsplat-trainer` | Mapillary + RunPod | `MAPILLARY_ACCESS_TOKEN` + `RUNPOD_API_KEY` (operator) | on-demand |
| 13 | `bulk-ingest-embedder` | `etzhayyim-community/maps-embedder` | local embedding model | (none — runs on operator pod) | continuous |

## Per-pod handover checklist

For each pod, the cutover follows the same checklist:

1. **Fork the source code** from `60-apps/etzhayyim-project-maps/bulk-ingest/workers/<pod>.py` (+ `k8s/deployment-<pod>.yaml`) into the new community repo. Preserve the substrate seam (`_etzhayyim_substrate.py`) verbatim — it is the contract.
2. **The community operator generates a fresh did:plc / did:web** for the pod itself (not a person). The pod's DID becomes the `sender` of every emitted `com.etzhayyim.apps.maps.*` record. Suggested handle: `<dataset>.ingest.community.etzhayyim.com`.
3. **`ETZHAYYIM_SUBSTRATE_MODE=mst`** is set on the community pod. `ETZHAYYIM_PDS_HANDLE` / `ETZHAYYIM_PDS_APP_PASSWORD` point at the operator's own PDS (or a community PDS that the operator controls).
4. **etzhayyim removes** the k8s deployment from its cluster (`kubectl -n maps-bulk-ingest delete deploy/bulk-ingest-<pod>`). The accompanying Secret containing the upstream-API credential is deleted.
5. **The etzhayyim relay subscribes** to the new community PDS via `com.atproto.sync.subscribeRepos`. The existing kotoba-datomic-projection rebuild path (`60-apps/etzhayyim-project-maps/bulk-ingest/workers/kotoba-datomic-projection.edn`) sees the new records and projects them into the read cache exactly as if the etzhayyim-operated pod were still emitting them.
6. **BPMN process updates**: the `bulkRefresh<Source>` BPMN message-start used to fire the etzhayyim-operated pod. After cutover the BPMN process either (a) becomes a community-PDS firehose subscription, or (b) is deactivated entirely (community operator's own scheduler drives the cadence). The `Cadence` row stays in this document as a recommendation, not as an etzhayyim-enforced contract.

## Charter compliance gate

Per ADR-2605192300 (Bootstrap Council) and ADR-2605192230 (3-tier
enforcement), a community pod's DID must be **Charter-aligned**:

- The pod's DID is registered with `ChartersComplianceRegistry`.
- The pod's source code is published under Apache 2.0 + Charter Rider v2.0 (this repo's standard licence).
- The community operator is not a Non-Aligned Entity per Charter Rider §2(a)-(h).

The etzhayyim relay enforces this gate on the subscription side:
records emitted by a DID that is `isNonAlignedAddress(addr) == true`
are dropped before projection.

## Bootstrap fallback

Until at least one community operator volunteers for each pod, the
existing etzhayyim-operated k8s deployments remain in service. The
ADR-2605231525 invariant is satisfied via the `// no-server-key:
read-only` exemption marker on the legacy deployment manifests — the
exemption notes that the deployment is **temporary, pending Stage B
handover**, and lists the GitHub issue tracking the handover. When
the issue closes, the exemption marker is removed and the deployment
is deleted in the same PR.

## Tracking

- Per-pod GitHub issues will be opened under `etzhayyim/root` with
  the label `stage-b-handover` and an assignee (the volunteering
  community operator). Until then, the rows in the table above are
  the canonical TODO list.
- Stage B is considered complete when all 13 rows have a green
  checkmark and the `e7m verify --no-server-key` invariant
  (Stage E) passes with the exemption count at zero.

## See also

- `_etzhayyim_substrate.py` — substrate seam (already supports mst mode)
- `workers/MIGRATION-TODO.md` — per-worker Stage 2 refactor checklist
- `kotoba-datomic-projection.edn` — declares the RW projection as L0-rebuildable from MST
