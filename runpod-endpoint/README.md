# maps RunPod Serverless endpoint

Worker-side counterpart to the maps Sentinel L7 pipeline (ADR-2604271800).
Invoked by `maps.sentinel.runpod.analyze` LangServer primitive
(`40-engine/kotoba/crates/kotoba-kotodama/py/src/kotodama/primitives/maps_sentinel.py`)
through the standard RunPod `/run` + `/status/{job_id}` polling path.

## Files

| File | Purpose |
|---|---|
| `handler.py` | RunPod entry. Three analysis types (changeDetection / landUse / sarFlood) dispatched by `event.input.analysisType`. Phase 1 returns deterministic stubs. |
| `Dockerfile` | Slim Python 3.11 base for Phase 1; flip `BASE` to `runpod/pytorch:2.4-cuda12.4` for Phase 2. |
| `requirements.txt` | `runpod` only for Phase 1; geospatial stack listed but commented for Phase 2. |

## Phases

### Phase 1 — Stub endpoint (where we are today)

Goal: prove the AgentGateway MCP + pod-side LangServer + RunPod chain end-to-end without GPU
cost. Deterministic seed-based outputs let the runbook smoke test
assert specific shapes.

```bash
# Local handler test (no RunPod SDK on path → script entry returns stub)
python handler.py
# → {"summary": "(stub) land cover: 75% forest, …", "confidence": 0.93, …}

# Build + push
IMAGE=ghcr.io/etzhayyim/maps-runpod-sentinel:phase1-$(date -u +%Y%m%d%H%M%S)
docker build --platform linux/amd64 -t "$IMAGE" .
docker push "$IMAGE"
```

Then in RunPod console:
1. **Templates → New Template** with that image, Container Disk 5 GB,
   no GPU required (Phase 1).
2. **Serverless → New Endpoint** → name `maps-sentinel`, attach
   template, `Workers Min=0 / Max=2`, `Idle Timeout=10s`. CPU-only
   instance is fine for stubs (e.g. `1 vCPU / 1 GiB`).
3. Copy the endpoint id; this is `RUNPOD_ENDPOINT_ID_MAPS` in
   `mitama-udf-pool` secrets.

### Phase 2 — Real inference

Wire the three model paths in order of impact:

1. **landUse** (single-scene S-2, easiest to validate): IBM-NASA
   `Prithvi-100M` foundation model with the published land-cover
   head. ~370 MB weights, A4000 24 GiB sufficient.
2. **sarFlood** (single-scene S-1): `cloudtostreet/sen1floods11-unet`
   weights + a custom rasterio loader for VV polarization. RTX 4000
   adequate.
3. **changeDetection** (bitemporal S-2): `torchgeo` BIT pretrained
   weights. Needs both COGs in memory; bump container disk to 10 GB.

Per-model wiring lives in `_run_*` functions in `handler.py`.
Replace `_stub_result(...)` with the real `_load_model_X()` +
`_predict()` body. Keep the same response shape so the LangServer
primitive doesn't change.

GPU instance recommendation: `RTX 4000 Ada` (16 GiB VRAM, $0.0002/s).
Cold-start with weights baked into the image is ~8s; first-warm
inference for a 1024×1024 S-2 tile is ~2s.

## Environment variables (handler-side)

All optional; defaults point at HuggingFace public weights.

| Var | Default | Purpose |
|---|---|---|
| `MODEL_S2_CHANGE` | `hf://torchgeo/bit-base-sentinel2` | bitemporal S-2 weights |
| `MODEL_S2_LANDUSE` | `hf://ibm-nasa-geospatial/Prithvi-100M` | S-2 land cover |
| `MODEL_S1_FLOOD` | `hf://cloudtostreet/sen1floods11-unet` | S-1 GRD flood |

Set via the RunPod template "Environment Variables" panel; do not
bake API keys into the image.

## Contract

Wire format documented in `handler.py` module docstring. Both sides
of the contract live in this repo:

- **Caller**: `40-engine/kotoba/crates/kotoba-kotodama/py/src/kotodama/primitives/maps_sentinel.py:_runpod_invoke_sync`
- **Callee** (this repo): `handler.py:handler`

Lexicon `00-contracts/lexicons/com/etzhayyim/apps/maps/sentinelAnalyze.json`
constrains the user-facing surface; the handler contract sits one
layer below that.

## Out of scope

- Model training (we use published pretrained weights).
- Per-AOI fine-tuning loop (Phase 3 if change-detection precision
  isn't enough on JP urban contexts).
- Webhook / async result delivery — LangServer primitive uses sync
  `/run` + poll, which is sufficient for sub-10-min runs and
  avoids extra plumbing.
