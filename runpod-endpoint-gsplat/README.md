# maps Gsplat RunPod Serverless endpoint

Worker-side counterpart to the Mapillary → 3DGS preview pipeline
(ADR-2605092800). Invoked by the bulk-ingest k8s pod
(`60-apps/etzhayyim-project-maps/bulk-ingest/workers/gsplat_train_dumper.py`)
through the standard RunPod `/run` + `/status/{job_id}` polling path.

Sibling layout to `../runpod-endpoint/` (sentinel L7 worker). Same
Phase 1 stub → Phase 2 real promotion scheme.

## Files

| File | Purpose |
|---|---|
| `handler.py` | RunPod entry. Phase 1 emits a deterministic 1024-splat ring; Phase 2 (gated by `RUNPOD_PHASE=2`) runs the real Mapillary → COLMAP → gsplat → PLY pipeline. |
| `Dockerfile` | Slim Python 3.11 base for Phase 1 (CPU). |
| `Dockerfile.phase2` | `runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04` + apt `colmap` + `requirements-phase2.txt` for the real GPU trainer. |
| `requirements.txt` | RunPod SDK only (Phase 1 baseline). |
| `requirements-phase2.txt` | Pinned torch / pycolmap / gsplat / pillow / imageio / numpy stack the Phase 2 image bundles on top. |

## Phases

### Phase 1 — Stub endpoint (where we are today)

Goal: prove the BPMN + bulk-ingest + B2 + RisingWave chain end-to-end
without GPU cost. Deterministic seed-based output (a 1024-splat ring
keyed by `tileH3`) lets the runbook smoke-test specific shapes.

```bash
# Local handler test (no RunPod SDK on path → script entry returns stub)
python handler.py
# → {"trainJobId":"…","splatCount":1024,"format":"ply",
#    "plyBase64":"<base64 …>", "stats":{"stub":true}, …}

# Build + push (CPU image is fine for Phase 1)
IMAGE=ghcr.io/etzhayyim/maps-runpod-gsplat:phase1-$(date -u +%Y%m%d%H%M%S)
docker build --platform linux/amd64 -t "$IMAGE" .
docker push "$IMAGE"
```

Then in RunPod console:

1. **Templates → New Template** with that image, Container Disk
   5 GB, no GPU required (Phase 1).
2. **Serverless → New Endpoint** → name `maps-gsplat`, attach
   template, `Workers Min=0 / Max=2`, `Idle Timeout=10s`. CPU-only
   instance is fine for stubs (e.g. `1 vCPU / 1 GiB`).
3. Copy the endpoint id; this is `RUNPOD_ENDPOINT_ID_GSPLAT` in
   `maps-bulk-ingest-credentials` k8s secret.

### Phase 2 — Real COLMAP + 3DGS (shipped 2026-05-09)

`gsplat` (https://github.com/nerfstudio-project/gsplat) drives the
training; reproducible with the Inria reference math but with a
maintained CUDA backend. Implementation in `_run_train_real` in
`handler.py` follows `gsplat/examples/simple_trainer.py` with three
deliberate simplifications for the maps preview use case:

1. **SH degree = 0** (DC band only). Keeps PLY size small and trains
   fast on Mapillary's mixed lighting / camera mix.
2. **No densification strategy.** COLMAP's sparse cloud is a strong
   init (typically 10k-50k 3D points per Mapillary sequence) and
   densification adds substantial code + memory pressure for marginal
   gains at preview quality. Operators promoting to higher fidelity
   can swap in `gsplat.strategy.DefaultStrategy` / `MCMCStrategy`.
3. **One opacity-cull pass at half-training** — drops contributors
   below σ⁻¹(0.05) ≈ -3.0 logit. Final cap = 50 000 splats (mirrors
   `kami_pipelines::MAX_SPLATS_PER_CLOUD`).

Promotion / build:

```bash
# 1. Build the GPU image (separate Dockerfile so Phase 1 stays slim).
IMAGE=ghcr.io/etzhayyim/maps-runpod-gsplat:phase2-$(date -u +%Y%m%d%H%M%S)
docker build --platform linux/amd64 -f Dockerfile.phase2 -t "$IMAGE" .
docker push "$IMAGE"

# 2. RunPod console:
#    Templates → New Template
#      image           = $IMAGE
#      Container Disk  = 30 GB   (gsplat + COLMAP scratch)
#      Env Vars        = RUNPOD_PHASE=2
#    Serverless → New Endpoint (or update the existing maps-gsplat one)
#      GPU             = L40S 48 GiB  (recommended, ~$0.00060/s)
#                        or A100 80 GiB / RTX 4090 24 GiB for ≤100-image scenes
#      Workers         = Min 0 / Max 2
#      Idle Timeout    = 30 s
#      Container Disk  = 30 GB

# 3. Smoke probe — Phase 2 endpoint accepts the same payload shape
#    as Phase 1; confirm a real /run + /status round-trip:
curl -X POST -H "authorization: Bearer $RUNPOD_API_KEY" \
  -H "content-type: application/json" \
  https://api.runpod.ai/v2/$RUNPOD_ENDPOINT_ID_GSPLAT/run \
  -d '{"input":{"trainJobId":"smoke","tileH3":"smoke","imageUrls":[],"maxImages":12}}'
# → {"id":"...","status":"IN_QUEUE"}
# (zero imageUrls deliberately falls back to the stub so we can
#  verify the wire without hitting Mapillary or training.)
```

### Phase 2 cost / runtime targets (L40S 48 GiB)

| Stage | Wall-clock | Notes |
|---|---|---|
| Mapillary download (80 thumb_2048) | 30-60 s | parallelism in dumper, not handler |
| COLMAP feature_extractor + match + mapper | 3-8 min | CPU-bound; image_count + resolution scales linearly |
| gsplat training (7 000 steps, sh_deg=0) | 6-12 min | dominated by rasterization at 1024-px long-side |
| PLY pack + return | <2 s | 50 000 splats × 56 B = 2.8 MB |
| **Total / scene** | **10-20 min** | **~$0.40 - $0.80** at L40S spot |

Cold-start with weights and apt-installed COLMAP baked in: ~15 s.

## Environment variables (handler-side)

All optional.

| Var | Default | Purpose |
|---|---|---|
| `RUNPOD_PHASE` | `1` | `2` switches to the COLMAP + gsplat path. |
| `GSPLAT_MAX_STEPS` | `7000` | hard cap on training iterations. |
| `GSPLAT_SH_DEGREE` | `0` | spherical-harmonic degree (0 = DC band only). |

Set via the RunPod template "Environment Variables" panel; do not
bake API keys into the image.

## Contract

Wire format documented in `handler.py` module docstring. Both sides
of the contract live in this repo:

- **Caller**: `60-apps/etzhayyim-project-maps/bulk-ingest/workers/gsplat_train_dumper.py`
- **Callee** (this dir): `handler.py:handler`

Lexicon `00-contracts/lexicons/com/etzhayyim/apps/maps/trainGsplatFromMapillary.json`
constrains the user-facing surface; the handler contract sits one
layer below that.

## Out of scope

- Photometric tonemapping / EXIF normalisation — done in the
  dumper before upload.
- Mesh extraction from the trained splat (separate
  `bakeGsplatAsset` path; `vertex_maps_gsplat_asset` →
  `edge_maps_gsplat_baked_to` → `vertex_spatial.Building` mesh GLB).
- Webhook / async result delivery — the dumper uses sync
  `/run` + poll, sufficient for the < 30 min training window
  RunPod permits.
