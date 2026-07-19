# maps-tile-server (nanoid `t1l3srv0`)

Self-hosted MVT tile server reading **OpenMapTiles**-schema **PMTiles** from
Cloudflare R2. Serves standard Mapbox Vector Tiles over
`https://tiles.maps.etzhayyim.com/v1/{z}/{x}/{y}.pbf`.

## Routes

| Path | Purpose |
|---|---|
| `GET /v1/{z}/{x}/{y}.pbf`  | MVT tile bytes (OpenMapTiles schema). 204 on missing. |
| `GET /v1/manifest.json`     | Current PMTiles version + build metadata. |
| `GET /v1/style.json`        | Minimal MapLibre style (kami-bridge ignores it). |
| `GET /health`               | `{ok:true}` |
| `GET /`                     | Capability summary. |

## Bindings (`wrangler.jsonc`)

| Binding | Kind | Resource |
|---|---|---|
| `TILES`          | R2  | `etzhayyim-maps-tiles` |
| `TILE_MANIFEST`  | KV  | `maps-tile-manifest` (60 s TTL cache of `manifest.json`) |

## R2 layout

```
etzhayyim-maps-tiles/
  v1/
    manifest.json              # { version, pmtilesKey, builtAt, bytes, ... }
    planet-{VERSION}.pmtiles   # tilemaker output
```

Built by `50-infra/k8s/maps-tilemaker-build`. Rollback = re-upload an older
`manifest.json`.

## PMTiles v3 reader

`src/pmtiles.ts` — ~430 LoC, zero npm deps. Implements:

- 127-byte header parsing
- Hilbert-curve `(z,x,y) → tile_id` mapping
- Directory varint decoder (5 streams: tile_id delta, run_length, length, offset)
- Root → leaf directory descent (one hop max)
- Gzip decompression via `DecompressionStream` (WHATWG, CF Worker native)
- Per-isolate cache for header + root dir (immutable for a given `pmtilesKey`)

Cold tile fetch = 3–4 R2 ranged GETs (header, root, leaf?, tile).
Warm (cached header + root) = 1–2 R2 ranged GETs. OpenMapTiles z14 tiles are
typically 50–200 KiB — comfortably below the Worker 25 MiB response cap.

**Unsupported**: brotli/zstd-compressed internal dirs or tiles (CF Workers
only expose gzip + deflate via `DecompressionStream`). tilemaker defaults to
gzip, so this is normally a non-issue.

## Deploy

```bash
cd 60-apps/etzhayyim-project-maps/appview/maps-tile-server-t1l3srv0

# one-time: create KV namespace and paste the id into wrangler.jsonc
wrangler kv:namespace create TILE_MANIFEST

# one-time: create R2 bucket
wrangler r2 bucket create etzhayyim-maps-tiles

# deploy
etzhayyim deploy
```

## Post-deploy smoke test

```bash
curl -sS https://tiles.maps.etzhayyim.com/health
curl -sS https://tiles.maps.etzhayyim.com/v1/manifest.json | jq .
curl -sS -o /tmp/t.pbf -w '%{http_code} %{size_download} %{content_type}\n' \
  https://tiles.maps.etzhayyim.com/v1/0/0/0.pbf
```

## Version bump procedure

1. Kick `maps-tilemaker-build` K8s Job (see `50-infra/k8s/maps-tilemaker-build/README.md`).
2. Job writes `v1/planet-{VERSION}.pmtiles` then `v1/manifest.json`.
3. Purge KV cache: `wrangler kv:key delete --binding=TILE_MANIFEST "manifest:v1"`
   (or wait ≤ 60 s for natural TTL).
4. Smoke test (above). Per-isolate `pmtilesCache` keyed on `pmtilesKey`
   self-invalidates when the key rotates.

## Auth

- **Current**: public, no auth (z 0–14). Intended for browser clients.
- **TODO**: z ≥ 15 gated by AT session JWT + CF WAF rate-limit rule
  (document in the next iteration — not in scope here).
- **Rate limiting**: rely on CF WAF / Bot Fight for now; configure per-zone
  rules on `tiles.maps.etzhayyim.com`.

## R2 cost model

- Each tile fetch on a warm isolate ≈ 1 Class B op (GET with Range) against R2.
- Cold isolate adds header (1 op) + root dir (1 op) + optional leaf dir (1 op)
  — so at most 4 ops per first tile after isolate spawn.
- Egress from R2 → Worker is inside Cloudflare. Client egress is cached
  heavily at edge (`s-maxage=604800`).
- Worst-case budget: 10 M tile requests/day × 1.2 avg ops = 12 M Class B ops/day
  ≈ $0.36/day for Class B at published rates (rates change — verify).

## Integration

- Frontend switch: point `cfg.mapTileUrl` in `maps-ui-uqpel6i6/svelte` at
  `https://tiles.maps.etzhayyim.com/v1/{z}/{x}/{y}.pbf` and call
  `applyOpenMapTilesStyle(map, tileUrl)` from
  `./src/lib/kami-openmaptiles-style.ts`.
- Parent agent is handling the runtime config swap — do not change
  `App.svelte` in this deliverable.
