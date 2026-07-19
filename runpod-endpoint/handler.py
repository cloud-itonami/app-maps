"""maps Sentinel RunPod Serverless handler. ADR-2604271800.

Three analysis types selected by `event["input"]["analysisType"]`:

  - changeDetection : Sentinel-2 baseline + current → land-cover delta.
                       Default: BIT (Bitemporal Image Transformer)
                       weights from torchgeo. Sources two COG URLs
                       (sceneUri current + baselineUri).
  - landUse         : Sentinel-2 single scene → land-cover semantic
                       segmentation. Default: U-Net w/ Prithvi-100M
                       (NASA-IBM Earth Foundation Model) head.
  - sarFlood        : Sentinel-1 GRD VV → flood mask. Default: U-Net
                       trained on Sen1Floods11 dataset.

Contract with the LangServer primitive (`maps.sentinel.runpod.analyze`):

  Request:
    {
      "input": {
        "model":         "sentinel2_change_siamese" | "sentinel2_landuse_unet" | "sentinel1_flood_unet",
        "analysisType":  "changeDetection" | "landUse" | "sarFlood",
        "sceneUri":      "at://did:web:maps.etzhayyim.com/com.etzhayyim.apps.maps.satelliteScene/…",
        "platform":      "sentinel-2-l2a" | "sentinel-1-grd",
        "cogUrl":        "https://…/B04.tif" | "https://…/iw_grd_vv.tif",
        "datetime":      "2026-04-26T01:23:45Z",
        "bbox":          [minLon, minLat, maxLon, maxLat],
        "baselineUri":   "(changeDetection only) at://…",
        "modelVersion":  "(optional) pin worker model version"
      }
    }

  Response (RunPod handler returns this dict; RunPod wraps it as
  `output`):
    {
      "summary":      "land cover: 62% forest, 22% built-up, 16% water",
      "confidence":   0.78,                         # 0..1
      "modelVersion": "sentinel2_landuse_unet@v1",
      "result": {
        "stats":         { … per-model JSON … },
        "geojson":       { … optional change/flood polygon … },
        "tilePngUrl":    "(optional) inline preview"
      }
    }

NOTE on dependencies: this file is a SCAFFOLD. The real model load
happens in `_load_model_*` hooks — wire them to the actual weights
once the endpoint is provisioned. Until then the handler returns a
deterministic stub so the LangServer primitive contract can be smoke
tested without GPU cost.

Reference: https://docs.runpod.io/serverless/workers/handler-functions
"""

from __future__ import annotations

import json
import os
import time
import traceback
from typing import Any

# RunPod SDK is provided by the runpod/worker-* base image.
try:
    import runpod  # type: ignore
except ImportError:
    runpod = None  # local-test fallback

# Heavy deps (torch, rasterio, etc.) load lazily so the cold-start
# warm path stays under 5s when the model is already cached.

_MODEL_CACHE: dict[str, Any] = {}


# ──────────────────────────────────────────────────────────────────────
# Model registry (per analysis type)
# ──────────────────────────────────────────────────────────────────────

_MODEL_REGISTRY = {
    "changeDetection": {
        "default": "sentinel2_change_siamese@v1",
        "weights_uri": os.environ.get(
            "MODEL_S2_CHANGE",
            "hf://torchgeo/bit-base-sentinel2",
        ),
        "input_bands": ["B04", "B03", "B02"],  # RGB
    },
    "landUse": {
        "default": "sentinel2_landuse_unet@v1",
        "weights_uri": os.environ.get(
            "MODEL_S2_LANDUSE",
            "hf://ibm-nasa-geospatial/Prithvi-100M",
        ),
        "input_bands": ["B04", "B03", "B02", "B08"],  # RGB + NIR
    },
    "sarFlood": {
        "default": "sentinel1_flood_unet@v1",
        "weights_uri": os.environ.get(
            "MODEL_S1_FLOOD",
            "hf://cloudtostreet/sen1floods11-unet",
        ),
        "input_bands": ["VV"],
    },
}


# ──────────────────────────────────────────────────────────────────────
# COG fetching
# ──────────────────────────────────────────────────────────────────────


def _fetch_cog_window(cog_url: str, bbox: list[float]) -> Any:
    """Fetch the bbox-clipped window of a COG. SCAFFOLD — replace with
    rasterio + rio-tiler when wiring real models.

    Returns a 3-D array (bands, h, w) as a numpy array, or raises.
    """
    # Real implementation will be approximately:
    #   import rasterio
    #   from rasterio.warp import transform_bounds
    #   from rasterio.windows import from_bounds
    #   with rasterio.open(cog_url) as src:
    #       win_bounds = transform_bounds("EPSG:4326", src.crs, *bbox)
    #       win = from_bounds(*win_bounds, transform=src.transform)
    #       arr = src.read(window=win, out_shape=(src.count, 256, 256))
    #   return arr
    raise NotImplementedError("COG fetch wiring pending — see scaffold note")


# ──────────────────────────────────────────────────────────────────────
# Per-analysis handlers
# ──────────────────────────────────────────────────────────────────────


def _stub_result(analysis_type: str, model_version: str, scene_uri: str) -> dict[str, Any]:
    """Deterministic stub so the BPMN smoke test can run end-to-end
    before real weights are wired."""
    seed = sum(ord(c) for c in (scene_uri or "")) % 100
    confidence = round(0.55 + (seed % 40) / 100.0, 2)
    summary = {
        "changeDetection": (
            f"(stub) ~{seed}% pixels changed vs baseline; dominant class: "
            "built-up expansion."
        ),
        "landUse": (
            f"(stub) land cover: {seed}% forest, "
            f"{(seed * 3) % 100}% built-up, water remainder."
        ),
        "sarFlood": (
            f"(stub) flood extent ~{seed} km², confidence "
            f"{confidence:.2f}, primary corridor along scene centroid."
        ),
    }[analysis_type]
    return {
        "summary": summary,
        "confidence": confidence,
        "modelVersion": model_version,
        "result": {
            "stats": {"stub": True, "seed": seed},
            "geojson": None,
            "tilePngUrl": None,
        },
    }


def _run_change_detection(input_: dict[str, Any]) -> dict[str, Any]:
    cfg = _MODEL_REGISTRY["changeDetection"]
    model_version = str(input_.get("modelVersion") or cfg["default"])
    if not input_.get("baselineUri"):
        return {
            "summary": "(error) changeDetection requires baselineUri",
            "confidence": 0.0,
            "modelVersion": model_version,
            "result": {"error": "missing_baselineUri"},
        }
    # TODO: load model from cfg["weights_uri"], fetch both COGs, run
    # bitemporal inference. For now, return stub.
    return _stub_result("changeDetection", model_version, str(input_.get("sceneUri") or ""))


def _run_land_use(input_: dict[str, Any]) -> dict[str, Any]:
    cfg = _MODEL_REGISTRY["landUse"]
    model_version = str(input_.get("modelVersion") or cfg["default"])
    return _stub_result("landUse", model_version, str(input_.get("sceneUri") or ""))


def _run_sar_flood(input_: dict[str, Any]) -> dict[str, Any]:
    cfg = _MODEL_REGISTRY["sarFlood"]
    model_version = str(input_.get("modelVersion") or cfg["default"])
    return _stub_result("sarFlood", model_version, str(input_.get("sceneUri") or ""))


_DISPATCH = {
    "changeDetection": _run_change_detection,
    "landUse": _run_land_use,
    "sarFlood": _run_sar_flood,
}


# ──────────────────────────────────────────────────────────────────────
# RunPod handler
# ──────────────────────────────────────────────────────────────────────


def handler(event: dict[str, Any]) -> dict[str, Any]:
    """RunPod Serverless entry point.

    `event["input"]` carries the request from the LangServer primitive.
    Return value becomes RunPod's `output` field. We deliberately
    return a dict (not an exception) on validation errors so the
    LangServer side captures the structured failure in OCEL audit
    rather than a 500."""
    started = time.time()
    try:
        input_ = event.get("input") or {}
        analysis_type = str(input_.get("analysisType") or "")
        if analysis_type not in _DISPATCH:
            return {
                "summary": f"(error) unknown analysisType: {analysis_type!r}",
                "confidence": 0.0,
                "modelVersion": "",
                "result": {"error": "unknown_analysis_type"},
                "runtimeMs": int((time.time() - started) * 1000),
            }
        out = _DISPATCH[analysis_type](input_)
        out["runtimeMs"] = int((time.time() - started) * 1000)
        return out
    except Exception as e:  # noqa: BLE001
        return {
            "summary": f"(handler error) {e}",
            "confidence": 0.0,
            "modelVersion": "",
            "result": {"error": str(e), "trace": traceback.format_exc()[-2000:]},
            "runtimeMs": int((time.time() - started) * 1000),
        }


if __name__ == "__main__":
    if runpod is None:
        # Local test path. Fake an event and dump JSON.
        sample = {
            "input": {
                "analysisType": "landUse",
                "sceneUri": "at://did:web:maps.etzhayyim.com/com.etzhayyim.apps.maps.satelliteScene/scn-s-20260427-deadbeef",
                "platform": "sentinel-2-l2a",
                "cogUrl": "https://example.com/dummy.tif",
                "bbox": [139.5, 35.3, 139.95, 35.7],
            }
        }
        print(json.dumps(handler(sample), indent=2))
    else:
        runpod.serverless.start({"handler": handler})
