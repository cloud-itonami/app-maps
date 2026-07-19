"""maps Gsplat (3D Gaussian Splatting) RunPod Serverless handler.

ADR-2605092800. Two modes selected by `event["input"]["mode"]`:

  * `train` (default) — Mapillary photos → COLMAP SfM → gsplat
    training → PLY. Output consumed by `kami-pipelines::GsplatAdapter`
    for in-browser preview.
  * `bake` — splat PLY → multi-view RGB+D render via gsplat →
    Open3D ScalableTSDFVolume fusion → marching cubes mesh →
    quadric_decimation to ~5k triangles → trimesh-packed GLB.
    Output consumed by `kami-app-maps3d::set_mesh_tile` for runtime
    static delivery (260416 design preserved).

Pipeline (train):
  1. download N images by URL into a working dir
  2. COLMAP: feature_extractor → exhaustive_matcher → mapper
     → camera poses + sparse cloud
  3. gsplat training with `DefaultStrategy` densification
     (clone+split+prune) until `--max-steps` (default 7 000),
     supports `sh_degree ∈ [0,3]`
  4. export PLY (3DGS-paper schema: x,y,z,opacity,scale_*,rot_*,f_dc_*)
     plus `f_rest_*` if `exportRest=true`

Phase 1 (THIS FILE)
  Returns a deterministic *synthetic* splat cloud (a small ring of
  Gaussians colour-keyed by image count) so the BPMN + bulk-ingest
  + B2 + RW INSERT path can be exercised without GPU cost. Same
  output schema as Phase 2.

Phase 2 (real)
  Flip `_run_train_real` in by setting `RUNPOD_PHASE=2` (or by
  default once the image is built with CUDA + COLMAP + gsplat). The
  real path expects:

    apt: colmap (cuda)
    pip: torch, gsplat, pycolmap, nerfstudio (or just gsplat with
         a thin train loop), pillow, requests

  L40S 48 GiB is recommended; ~80 images converges in 8-15 min,
  COLMAP itself is 3-8 min depending on image count + resolution.

Contract with the bulk-ingest dumper pod
(`60-apps/.../bulk-ingest/workers/gsplat_train_dumper.py`):

  Request:
    {
      "input": {
        "trainJobId":   "gsplattrain-…",
        "tileH3":       "8c2a1072b59ffff",
        "lat":          35.6812,
        "lng":          139.7671,
        "radiusM":      50,
        "imageUrls":    ["https://images.mapillary.com/…", …],
        "imageIds":     ["mapillary-image-id-1", …],
        "maxImages":    80,
        "maxSteps":     7000,
        "shDegree":     0,
        "priority":     "normal" | "low" | "high"
      }
    }

  Response:
    {
      "trainJobId":  "gsplattrain-…",
      "tileH3":      "8c2a1072b59ffff",
      "splatCount":  4321,
      "shDegree":    0,
      "format":      "ply",
      "plyBase64":   "<base64 of binary PLY>",
      "byteSize":    234567,
      "stats": {
        "imageCount":   78,
        "colmapSec":    241,
        "trainSec":     612,
        "stub":         false
      },
      "modelVersion": "gsplat@v1",
      "runtimeMs":    854000
    }

  On error the same dict is returned with `splatCount=0`,
  `plyBase64=""`, and `stats.error` set.

Reference: https://docs.runpod.io/serverless/workers/handler-functions
"""

from __future__ import annotations

import base64
import io
import json
import math
import os
import struct
import time
import traceback
from typing import Any

try:
    import runpod  # provided by runpod/worker-* base image
except ImportError:
    runpod = None  # local-test fallback


# ── PLY writer (binary little-endian, 3DGS schema) ─────────────────────

# 14 properties × float32 = 56 bytes per splat. Matches what
# `kami_render::splat_loader::load_ply` expects (DC-band only path).
_PLY_PROPS_BASE = (
    "x", "y", "z",
    "opacity",
    "scale_0", "scale_1", "scale_2",
    "rot_0", "rot_1", "rot_2", "rot_3",
    "f_dc_0", "f_dc_1", "f_dc_2",
)
# Backwards-compat alias kept for callers / tests written before the
# higher-SH support landed.
_PLY_PROPS = _PLY_PROPS_BASE


def _ply_props_with_rest(sh_rest_per_splat: int) -> tuple[str, ...]:
    """Append `f_rest_0..N` properties for higher-SH coefficients.
    `kami_render::splat_loader` ignores unknown properties — additive
    `f_rest_*` is therefore safe for our renderer while still
    interoperable with SuperSplat / Inria's reference viewer."""
    extra = tuple(f"f_rest_{i}" for i in range(sh_rest_per_splat))
    return _PLY_PROPS_BASE + extra


def _write_ply(splats: list[tuple[float, ...]],
               props: tuple[str, ...] | None = None) -> bytes:
    """Pack splats into the standard 3DGS binary little-endian PLY.
    Each tuple matches `props` (default `_PLY_PROPS_BASE`). Caller
    converts opacity → logit-space and scale → log-space (the
    renderer applies sigmoid / exp respectively)."""
    props = props or _PLY_PROPS_BASE
    header = (
        "ply\nformat binary_little_endian 1.0\n"
        f"element vertex {len(splats)}\n"
        + "".join(f"property float {p}\n" for p in props)
        + "end_header\n"
    ).encode("ascii")
    body = io.BytesIO()
    fmt = "<" + "f" * len(props)
    for s in splats:
        body.write(struct.pack(fmt, *s))
    return header + body.getvalue()


# ── Phase 1 stub ───────────────────────────────────────────────────────


def _run_train_stub(payload: dict[str, Any]) -> dict[str, Any]:
    """Deterministic stub: a 1024-splat ring colour-keyed by image
    count. Lets the BPMN + dumper + B2 + RW path be smoke-tested
    without provisioning a GPU."""
    image_urls = list(payload.get("imageUrls") or [])
    image_count = max(1, min(len(image_urls), int(payload.get("maxImages") or 80)))
    seed = sum(ord(c) for c in str(payload.get("tileH3") or "")) % 100

    splats: list[tuple[float, ...]] = []
    n_splats = 1024
    log_scale = math.log(0.06)
    opacity_logit = 2.5  # ~σ(2.5) = 0.92
    # Hue rotates with seed so each tile gets a recognisably different palette.
    base_hue = (seed % 360) / 360.0
    for i in range(n_splats):
        u = i / n_splats
        # Two interleaved rings + a soft cloud puff in the middle
        ring = i % 3
        if ring == 0:
            r = 1.0
            theta = u * math.pi * 2
            x = math.cos(theta) * r
            y = 0.0
            z = math.sin(theta) * r
        elif ring == 1:
            r = 1.6
            theta = u * math.pi * 2 + 0.4
            x = math.cos(theta) * r
            y = math.sin(u * math.pi * 4) * 0.3
            z = math.sin(theta) * r
        else:
            theta = u * math.pi * 2
            r = 0.5 + 0.4 * math.sin(u * math.pi * 6)
            x = math.cos(theta) * r
            y = (u - 0.5) * 0.6
            z = math.sin(theta) * r
        # HSV → RGB-ish for a lively palette
        h = (base_hue + u) % 1.0
        rgb = _hsv_to_rgb(h, 0.55, 0.95)
        splats.append((
            x, y, z,
            opacity_logit,
            log_scale, log_scale, log_scale,
            1.0, 0.0, 0.0, 0.0,
            rgb[0] - 0.5, rgb[1] - 0.5, rgb[2] - 0.5,
        ))

    ply_bytes = _write_ply(splats)
    return {
        "trainJobId": payload.get("trainJobId") or "",
        "tileH3":     payload.get("tileH3") or "",
        "splatCount": len(splats),
        "shDegree":   0,
        "format":     "ply",
        "plyBase64":  base64.b64encode(ply_bytes).decode("ascii"),
        "byteSize":   len(ply_bytes),
        "stats": {
            "imageCount": image_count,
            "colmapSec":  0,
            "trainSec":   0,
            "stub":       True,
        },
        "modelVersion": "gsplat-stub@v1",
    }


def _hsv_to_rgb(h: float, s: float, v: float) -> tuple[float, float, float]:
    i = int(h * 6.0) % 6
    f = h * 6.0 - i
    p = v * (1.0 - s)
    q = v * (1.0 - f * s)
    t = v * (1.0 - (1.0 - f) * s)
    return [
        (v, t, p), (q, v, p), (p, v, t),
        (p, q, v), (t, p, v), (v, p, q),
    ][i]


# ── Phase 2 real (GPU): Mapillary → COLMAP → gsplat → PLY ─────────────
#
# Adapted from the reference at
# https://github.com/nerfstudio-project/gsplat/blob/main/examples/simple_trainer.py
#
# Now uses `gsplat.strategy.DefaultStrategy` (clone + split + prune
# densification) which is the standard 3DGS densification schedule —
# adds plenty of detail when COLMAP's sparse cloud under-populates
# texture-rich regions, and prunes near-transparent gaussians during
# warmup.
#
# `sh_degree` configurable from payload (0..3). DC band always exported
# in the renderer-compatible `f_dc_*` slot; higher-band coefficients
# optionally exported as `f_rest_*` (caller passes `exportRest=true`).
# Our `kami_render::splat_loader::load_ply` ignores `f_rest_*` so it
# falls back to DC quality — but SuperSplat / Inria's viewer can still
# light the asset correctly when `exportRest=true`.
#
# PLY output schema matches `kami_render::splat_loader::load_ply` for
# the DC band: x, y, z, opacity (logit), scale_0/1/2 (log),
# rot_0/1/2/3 (wxyz), f_dc_0/1/2 (the renderer evaluates
# `max(sh_dc + 0.5, 0)` so we write `(rgb_color * SH_C0)` here — see
# `_SH_C0` below).

_TRAIN_RES_LONG = 1024            # downsample longest image side to this
_OPACITY_CULL_LOGIT_THRESH = -3.0  # σ(-3) ≈ 0.047 — final post-train cap
_SH_C0 = 0.28209479177387814       # SH band-0 coefficient
_DEFAULT_MAX_STEPS = 7000
_MAX_SH_DEGREE = 3
# Mirrors `kami_pipelines::MAX_SPLATS_PER_CLOUD` — final hard cap so
# a successful densification doesn't blow past renderer budget. Bumped
# 50k → 100k 2026-05-10 (CPU sort still fits 60 fps on M-series).
_MAX_SPLATS_OUT = 100_000


def _run_train_real(payload: dict[str, Any]) -> dict[str, Any]:
    """Real COLMAP + gsplat path. Imports torch / pycolmap lazily so
    Phase 1 images stay slim. Falls back to the stub on any failure
    so the BPMN never hard-fails."""
    # Lazy heavy deps. If any of these are missing we fall through to
    # the stub — the operator promotes Phase 2 by rebuilding the image
    # with the heavy block in `requirements.txt` enabled.
    try:
        import tempfile  # noqa: F401
        import shutil
        import urllib.request
        import random
        import numpy as np
        import torch
        import torch.nn.functional as F
        import imageio.v3 as iio
        import pycolmap
        from gsplat import rasterization
        try:
            from gsplat.strategy import DefaultStrategy
            _has_strategy = True
        except Exception:
            DefaultStrategy = None  # type: ignore
            _has_strategy = False
    except ImportError as e:
        return _attach_error(_run_train_stub(payload), f"phase2 deps missing: {e}")

    if not torch.cuda.is_available():
        return _attach_error(_run_train_stub(payload), "phase2 requires CUDA — no GPU visible")

    workdir = tempfile.mkdtemp(prefix="gsplat-")
    try:
        image_dir = os.path.join(workdir, "images")
        os.makedirs(image_dir, exist_ok=True)
        urls = list(payload.get("imageUrls") or [])
        max_images = max(8, min(int(payload.get("maxImages") or 80), 400))
        urls = urls[:max_images]
        if not urls:
            return _attach_error(_run_train_stub(payload), "phase2: no image urls in payload")

        # 1) Download
        t_dl = time.time()
        saved = 0
        for i, url in enumerate(urls):
            dst = os.path.join(image_dir, f"frame_{i:04d}.jpg")
            try:
                # Mapillary thumb_2048 URLs are pre-signed; no extra auth.
                urllib.request.urlretrieve(url, dst)
                # Sanity check: imageio decodes successfully (filters out
                # the rare zero-byte / 403-content responses).
                _ = iio.imread(dst)
                saved += 1
            except Exception as ex:
                continue
        dl_sec = int(time.time() - t_dl)
        if saved < 8:
            return _attach_error(_run_train_stub(payload),
                                 f"phase2: only {saved} usable images (need ≥8)")

        # 2) COLMAP SfM
        t_colmap = time.time()
        db_path = os.path.join(workdir, "database.db")
        sparse_dir = os.path.join(workdir, "sparse")
        os.makedirs(sparse_dir, exist_ok=True)
        # AUTO = let pycolmap pick a per-image camera model. Mapillary
        # mixes phones / GoPro / dashcam so per-image is correct.
        pycolmap.extract_features(
            db_path, image_dir, camera_mode=pycolmap.CameraMode.AUTO,
        )
        pycolmap.match_exhaustive(db_path)
        recons = pycolmap.incremental_mapping(db_path, image_dir, sparse_dir)
        if not recons:
            return _attach_error(_run_train_stub(payload),
                                 "phase2: COLMAP produced no reconstruction")
        rec = max(recons.values(), key=lambda r: len(r.images))
        if len(rec.images) < 6:
            return _attach_error(_run_train_stub(payload),
                                 f"phase2: COLMAP registered only {len(rec.images)} images")
        n_points = len(rec.points3D)
        if n_points < 256:
            return _attach_error(_run_train_stub(payload),
                                 f"phase2: COLMAP sparse cloud only {n_points} pts")
        colmap_sec = int(time.time() - t_colmap)

        # 3) Init Gaussians from sparse cloud
        t_train = time.time()
        device = torch.device("cuda")
        pts = np.stack([np.asarray(p.xyz, dtype=np.float32) for p in rec.points3D.values()])
        rgb = np.stack(
            [np.asarray(p.color, dtype=np.float32) / 255.0 for p in rec.points3D.values()]
        )
        # Initial isotropic scale = 1/3 of mean k-NN distance (k=4).
        knn_dist = _knn_mean_dist(pts, k=4)
        init_log_scale = np.log(np.clip(knn_dist / 3.0, 1e-4, None)).astype(np.float32)
        n_g = pts.shape[0]
        # SH degree (0..3). K = (sh_degree+1)^2 coefficients × 3
        # channels. Coefficient 0 is the DC band; the rest carry view
        # dependence (specular).
        sh_degree = max(0, min(int(payload.get("shDegree") or 0), _MAX_SH_DEGREE))
        K = (sh_degree + 1) ** 2

        means = torch.tensor(pts, device=device, dtype=torch.float32, requires_grad=True)
        scales = torch.tensor(
            np.tile(init_log_scale[:, None], (1, 3)),
            device=device, dtype=torch.float32, requires_grad=True,
        )
        quats = torch.zeros(n_g, 4, device=device, requires_grad=True)
        with torch.no_grad():
            quats[:, 0] = 1.0
        opacities = torch.full((n_g,), -2.2, device=device, requires_grad=True)
        # gsplat's SH DC convention: (rgb - 0.5) / SH_C0
        sh_dc = torch.tensor(
            (rgb - 0.5) / _SH_C0, device=device, dtype=torch.float32, requires_grad=True,
        )
        # Higher SH bands init to zero — they pick up specular terms
        # during training. Shape: (N, K-1, 3) so the concat with
        # `sh_dc[:, None, :]` produces (N, K, 3) feed to rasterization.
        if K > 1:
            sh_rest = torch.zeros(
                n_g, K - 1, 3, device=device, dtype=torch.float32, requires_grad=True,
            )
        else:
            sh_rest = None

        # Scene extent for LR scaling — average distance between camera
        # centers. Standard 3DGS heuristic.
        cams_world = np.stack([
            np.linalg.inv(np.asarray(img.cam_from_world.matrix(), dtype=np.float32))[:3, 3]
            for img in rec.images.values()
        ])
        scene_extent = float(np.max(np.linalg.norm(
            cams_world - cams_world.mean(axis=0, keepdims=True), axis=1
        ))) or 1.0

        param_groups: list[dict[str, Any]] = [
            {"params": [means],     "lr": 1.6e-4 * scene_extent, "name": "means"},
            {"params": [scales],    "lr": 5e-3,                  "name": "scales"},
            {"params": [quats],     "lr": 1e-3,                  "name": "quats"},
            {"params": [opacities], "lr": 5e-2,                  "name": "opacities"},
            {"params": [sh_dc],     "lr": 2.5e-3,                "name": "sh_dc"},
        ]
        if sh_rest is not None:
            # Standard 3DGS schedule: rest LR is 1/20 of DC LR.
            param_groups.append({"params": [sh_rest], "lr": 1.25e-4, "name": "sh_rest"})
        optimizer = torch.optim.Adam(param_groups, eps=1e-15)

        # gsplat DefaultStrategy needs handles to the *logical* params
        # so its clone/split/prune can splice tensors. We pack them in
        # the dict shape simple_trainer.py expects.
        if _has_strategy and DefaultStrategy is not None:
            strategy = DefaultStrategy(
                prune_opa=0.005,
                grow_grad2d=0.0002,
                grow_scale3d=0.01,
                prune_scale3d=0.1,
                refine_start_iter=500,
                refine_stop_iter=int(payload.get("maxSteps") or _DEFAULT_MAX_STEPS) - 500,
                refine_every=100,
                reset_every=3000,
                absgrad=False,
                revised_opacity=False,
                verbose=False,
            )
            try:
                strategy.check_sanity({
                    "means": means, "scales": scales, "quats": quats,
                    "opacities": opacities, "sh0": sh_dc,
                    **({"shN": sh_rest} if sh_rest is not None else {}),
                })
            except Exception:
                # gsplat versions diverge on the sanity check key names.
                # Non-fatal — we still call step_pre/post_backward below.
                pass
            strategy_state = strategy.initialize_state(scene_scale=scene_extent)
        else:
            strategy = None
            strategy_state = None

        # Load images + cameras (downsampled to TRAIN_RES_LONG).
        # Hold out 10% of registered views (capped at 8) for the
        # post-train PSNR / L1 quality gauge — the operator uses that
        # number to flag bad scenes before bake or republish.
        all_views = _build_train_views(rec, image_dir, device, _TRAIN_RES_LONG)
        if not all_views:
            return _attach_error(_run_train_stub(payload),
                                 "phase2: no usable image/camera pairs after COLMAP")
        random.seed(13)
        shuffled = list(range(len(all_views)))
        random.shuffle(shuffled)
        n_holdout = min(8, max(1, len(all_views) // 10)) if len(all_views) >= 12 else 0
        holdout_idx = set(shuffled[:n_holdout])
        train_views = [v for i, v in enumerate(all_views) if i not in holdout_idx]
        eval_views  = [v for i, v in enumerate(all_views) if i in holdout_idx]

        max_steps = max(500, min(int(payload.get("maxSteps") or _DEFAULT_MAX_STEPS), 30_000))

        # Track tensor identities through densification — DefaultStrategy
        # rebinds them in place via the optimizer's param groups.
        def _gather_params() -> dict[str, Any]:
            d = {
                "means":     means,
                "scales":    scales,
                "quats":     quats,
                "opacities": opacities,
                "sh0":       sh_dc,
            }
            if sh_rest is not None:
                d["shN"] = sh_rest
            return d

        for step in range(max_steps):
            view = random.choice(train_views)
            img_t, K_view, viewmat, w, h = view
            # Pack SH into shape (N, K, 3)
            if sh_rest is not None:
                colors_in = torch.cat([sh_dc[:, None, :], sh_rest], dim=1)
            else:
                colors_in = sh_dc[:, None, :]
            rendered, _alpha, info = rasterization(
                means=means,
                quats=F.normalize(quats, dim=-1),
                scales=torch.exp(scales),
                opacities=torch.sigmoid(opacities),
                colors=colors_in,
                viewmats=viewmat[None],                       # (1, 4, 4)
                Ks=K_view[None],                              # (1, 3, 3)
                width=w,
                height=h,
                sh_degree=sh_degree,
                packed=True,
            )
            rendered = rendered[0]                           # (H, W, 3)
            l1 = (rendered - img_t).abs().mean()
            loss = l1
            optimizer.zero_grad(set_to_none=True)
            if strategy is not None:
                try:
                    strategy.step_pre_backward(
                        params=_gather_params(),
                        optimizers={"adam": optimizer},
                        state=strategy_state,
                        step=step,
                        info=info,
                    )
                except Exception:
                    pass
            loss.backward()
            optimizer.step()
            if strategy is not None:
                try:
                    strategy.step_post_backward(
                        params=_gather_params(),
                        optimizers={"adam": optimizer},
                        state=strategy_state,
                        step=step,
                        info=info,
                        packed=True,
                    )
                except Exception:
                    pass
                # The strategy re-binds tensors inside the param dict
                # by index; re-fetch our handles so the next iteration
                # sees the updated identities.
                params_now = _gather_params()
                means     = params_now["means"]
                scales    = params_now["scales"]
                quats     = params_now["quats"]
                opacities = params_now["opacities"]
                sh_dc     = params_now["sh0"]
                if sh_rest is not None:
                    sh_rest = params_now.get("shN", sh_rest)

            n_g = int(means.shape[0])

        train_sec = int(time.time() - t_train)

        # 4a) Held-out quality gauge — render each eval view + compare
        # to ground truth. Mean L1 over [0,1] images; PSNR derived
        # from MSE. `eval_views` is empty for tiny scenes — skip
        # silently in that case.
        eval_l1 = float("nan")
        eval_psnr = float("nan")
        if eval_views:
            with torch.no_grad():
                losses = []
                mses = []
                for img_t, K_view, viewmat, w, h in eval_views:
                    if sh_rest is not None:
                        colors_in = torch.cat([sh_dc[:, None, :], sh_rest], dim=1)
                    else:
                        colors_in = sh_dc[:, None, :]
                    rendered, _alpha, _info = rasterization(
                        means=means,
                        quats=F.normalize(quats, dim=-1),
                        scales=torch.exp(scales),
                        opacities=torch.sigmoid(opacities),
                        colors=colors_in,
                        viewmats=viewmat[None],
                        Ks=K_view[None],
                        width=w, height=h,
                        sh_degree=sh_degree,
                        packed=True,
                    )
                    rendered = rendered[0].clamp(0, 1)
                    diff = (rendered - img_t)
                    losses.append(diff.abs().mean().item())
                    mses.append((diff * diff).mean().item())
                eval_l1 = float(np.mean(losses)) if losses else float("nan")
                mean_mse = float(np.mean(mses)) if mses else float("nan")
                if mean_mse > 1e-9 and np.isfinite(mean_mse):
                    eval_psnr = float(-10.0 * math.log10(mean_mse))

        # 4) Final opacity cull + cap.
        with torch.no_grad():
            keep_mask = opacities > _OPACITY_CULL_LOGIT_THRESH
            kept = int(keep_mask.sum().item())
            if 256 <= kept < int(means.shape[0]):
                means     = means[keep_mask]
                scales    = scales[keep_mask]
                quats     = quats[keep_mask]
                opacities = opacities[keep_mask]
                sh_dc     = sh_dc[keep_mask]
                if sh_rest is not None:
                    sh_rest = sh_rest[keep_mask]
            if int(means.shape[0]) > _MAX_SPLATS_OUT:
                _topk = torch.topk(opacities, _MAX_SPLATS_OUT).indices
                means     = means[_topk]
                scales    = scales[_topk]
                quats     = quats[_topk]
                opacities = opacities[_topk]
                sh_dc     = sh_dc[_topk]
                if sh_rest is not None:
                    sh_rest = sh_rest[_topk]
            quats = F.normalize(quats, dim=-1)
            n_final = int(means.shape[0])

            # Opacity-descending sort so the on-disk PLY is naturally LOD-ed:
            # an HTTP Range fetch of the first M bytes returns the top-M
            # highest-opacity splats. The PLY loader tolerates truncated
            # bodies (`if base + stride > body.len() { break }`) so the
            # browser can use this to pull a fraction of a tile when the
            # player is far from its centre.
            if n_final > 1:
                order = torch.argsort(opacities, descending=True)
                means     = means[order]
                scales    = scales[order]
                quats     = quats[order]
                opacities = opacities[order]
                sh_dc     = sh_dc[order]
                if sh_rest is not None:
                    sh_rest = sh_rest[order]

        # 5) Pack into the renderer's PLY schema. `kami_render` evaluates
        # `color = max(sh_dc + 0.5, 0)` on the DC band only, so we
        # multiply the gsplat-convention DC by SH_C0 on the way out.
        # `f_rest_*` carry the higher SH bands when `exportRest=true`.
        export_rest = bool(payload.get("exportRest")) and sh_rest is not None and sh_rest.shape[1] > 0
        means_np  = means.detach().cpu().numpy()
        scales_np = scales.detach().cpu().numpy()
        quats_np  = quats.detach().cpu().numpy()
        op_np     = opacities.detach().cpu().numpy()
        sh_dc_np  = (sh_dc.detach().cpu().numpy() * _SH_C0).astype(np.float32)
        if export_rest:
            sh_rest_np = sh_rest.detach().cpu().numpy().astype(np.float32)  # type: ignore[union-attr]
            sh_rest_per = int(sh_rest_np.shape[1] * sh_rest_np.shape[2])
            props = _ply_props_with_rest(sh_rest_per)
        else:
            sh_rest_np = None
            sh_rest_per = 0
            props = _PLY_PROPS_BASE
        splats: list[tuple[float, ...]] = []
        for i in range(n_final):
            row = [
                float(means_np[i, 0]), float(means_np[i, 1]), float(means_np[i, 2]),
                float(op_np[i]),
                float(scales_np[i, 0]), float(scales_np[i, 1]), float(scales_np[i, 2]),
                float(quats_np[i, 0]), float(quats_np[i, 1]),
                float(quats_np[i, 2]), float(quats_np[i, 3]),
                float(sh_dc_np[i, 0]), float(sh_dc_np[i, 1]), float(sh_dc_np[i, 2]),
            ]
            if export_rest and sh_rest_np is not None:
                # 3DGS PLY convention: rest stored channel-major
                # (R,R,R,...,G,G,G,...,B,B,B,...).
                rest_block = sh_rest_np[i]  # (K-1, 3)
                row.extend(float(v) for v in rest_block[:, 0].ravel())
                row.extend(float(v) for v in rest_block[:, 1].ravel())
                row.extend(float(v) for v in rest_block[:, 2].ravel())
            splats.append(tuple(row))
        ply_bytes = _write_ply(splats, props=props)

        return {
            "trainJobId": payload.get("trainJobId") or "",
            "tileH3":     payload.get("tileH3") or "",
            "splatCount": n_final,
            "shDegree":   sh_degree,
            "format":     "ply",
            "plyBase64":  base64.b64encode(ply_bytes).decode("ascii"),
            "byteSize":   len(ply_bytes),
            "stats": {
                "imageCount":      saved,
                "registeredCount": len(rec.images),
                "registeredRatio": (len(rec.images) / float(saved)) if saved else 0.0,
                "sparsePointCount": n_points,
                "holdoutCount":    len(eval_views),
                "evalL1":          (None if (eval_l1 != eval_l1) else eval_l1),
                "evalPsnr":        (None if (eval_psnr != eval_psnr) else eval_psnr),
                "downloadSec":     dl_sec,
                "colmapSec":       colmap_sec,
                "trainSec":        train_sec,
                "trainSteps":      max_steps,
                "shDegree":        sh_degree,
                "exportRest":      export_rest,
                "densification":   _has_strategy,
                "stub":            False,
            },
            "modelVersion": "gsplat@v1.4-default",
        }
    except Exception as e:
        # Bubble up structured failure rather than letting RunPod 500 —
        # the dumper pod records this in OCEL.
        return _attach_error(_run_train_stub(payload), f"phase2 unexpected: {e}")
    finally:
        try:
            shutil.rmtree(workdir, ignore_errors=True)  # type: ignore[name-defined]
        except Exception:
            pass


def _knn_mean_dist(pts, k: int):
    """O(N²) brute-force k-NN distance — fine for ≤50k sparse points;
    avoids a scipy dependency on the slim Phase 1 image."""
    import numpy as np
    n = pts.shape[0]
    # Chunk the pairwise distance to keep the memory footprint sane.
    out = np.zeros(n, dtype=np.float32)
    chunk = 4096
    for start in range(0, n, chunk):
        end = min(start + chunk, n)
        diff = pts[start:end, None, :] - pts[None, :, :]
        d2 = (diff * diff).sum(axis=-1)
        # Exclude self.
        np.fill_diagonal(d2[:, start:end], np.inf)
        # k smallest
        k_small = np.partition(d2, kth=k, axis=1)[:, :k]
        out[start:end] = np.sqrt(np.maximum(k_small, 0.0).mean(axis=1))
    return out


def _build_train_views(rec, image_dir: str, device, target_long: int):
    """Resolve each registered COLMAP image to (img_tensor, K, viewmat,
    width, height) at the downsampled resolution. Cameras with no
    valid jpeg or unsupported model are skipped (not fatal)."""
    import os as _os
    import numpy as np
    import torch
    import imageio.v3 as iio

    out: list[tuple] = []
    for img in rec.images.values():
        cam = rec.cameras[img.camera_id]
        path = _os.path.join(image_dir, img.name)
        try:
            arr = iio.imread(path)
        except Exception:
            continue
        if arr.ndim == 2:
            arr = np.stack([arr, arr, arr], axis=-1)
        if arr.shape[2] == 4:
            arr = arr[..., :3]
        H, W = arr.shape[:2]
        long_side = max(H, W)
        if long_side > target_long:
            scale = target_long / float(long_side)
            new_w = int(round(W * scale))
            new_h = int(round(H * scale))
            arr = _resize_rgb(arr, new_w, new_h)
            H, W = new_h, new_w
        else:
            scale = 1.0
        img_t = torch.tensor(arr, device=device, dtype=torch.float32) / 255.0  # (H, W, 3)

        try:
            K_full = np.asarray(cam.calibration_matrix(), dtype=np.float32)
        except Exception:
            continue
        K = K_full.copy()
        K[0, :] *= scale
        K[1, :] *= scale
        K_t = torch.tensor(K, device=device, dtype=torch.float32)

        c2w = np.linalg.inv(np.asarray(img.cam_from_world.matrix(), dtype=np.float32))
        w2c = np.linalg.inv(c2w).astype(np.float32)
        viewmat = torch.tensor(w2c, device=device, dtype=torch.float32)

        out.append((img_t, K_t, viewmat, W, H))
    return out


def _resize_rgb(arr, new_w: int, new_h: int):
    """Bilinear downsample without pulling in a Pillow/cv2 dependency
    explicitly — uses imageio's underlying pillow if available, else a
    fast numpy nearest-neighbour fallback."""
    try:
        from PIL import Image
        return np.asarray(
            Image.fromarray(arr).resize((new_w, new_h), Image.BILINEAR)
        )
    except Exception:
        # nearest-neighbour fallback so training still proceeds even
        # without Pillow.
        ys = (np.arange(new_h) * (arr.shape[0] / new_h)).astype(np.int64)
        xs = (np.arange(new_w) * (arr.shape[1] / new_w)).astype(np.int64)
        return arr[ys[:, None], xs[None, :]]


def _attach_error(stub: dict[str, Any], err: str) -> dict[str, Any]:
    stats = dict(stub.get("stats") or {})
    stats["error"] = err
    stub["stats"] = stats
    return stub


def _attach_cost(out: dict[str, Any]) -> dict[str, Any]:
    """Estimate RunPod cost from runtimeMs × per-second rate.
    `RUNPOD_COST_USD_PER_SEC` env var overrides the default L40S spot
    rate. Stored on stats so the dumper / SQLMesh rollups can surface
    it without re-deriving."""
    try:
        rate = float(os.environ.get("RUNPOD_COST_USD_PER_SEC", "0.00060"))
    except ValueError:
        rate = 0.00060
    runtime_ms = int(out.get("runtimeMs") or 0)
    if runtime_ms <= 0 or rate <= 0:
        return out
    cost = (runtime_ms / 1000.0) * rate
    stats = dict(out.get("stats") or {})
    stats["estimatedCostUsd"] = round(cost, 6)
    stats["costRateUsdPerSec"] = rate
    out["stats"] = stats
    return out


# ── Bake mode (splat → mesh GLB) ──────────────────────────────────────
#
# Pipeline:
#   1. Decode incoming PLY → (means, opacities, scales, quats, sh_dc).
#   2. Sample N viewpoints around the scene centroid (icosphere shell).
#   3. gsplat.rasterization(render_mode="RGB+D") → RGB + depth per view.
#   4. Open3D ScalableTSDFVolume.integrate(rgbd, intrinsic, extrinsic).
#   5. extract_triangle_mesh() → quadric_decimation to ~target_tris.
#   6. trimesh GLB pack → return base64.
#
# Phase 1 (no GPU) returns a deterministic hand-crafted GLB cube
# scaled to the splat bbox — same purpose as the Phase 1 splat ring:
# exercise the RW / B2 / browser path without burning compute.

_BAKE_TARGET_TRIS = 5_000
_BAKE_VIEW_COUNT = 24
_BAKE_RES = 768


def _run_bake_stub(payload: dict[str, Any]) -> dict[str, Any]:
    """Deterministic stub: a unit-cube GLB centred at the splat
    bbox (or origin if no PLY supplied). Lets the bake BPMN exercise
    the dumper + B2 + RW path without GPU."""
    bbox = _bbox_from_ply_b64(payload.get("plyBase64") or "")
    glb_bytes = _stub_cube_glb(bbox)
    return {
        "trainJobId":   payload.get("trainJobId") or payload.get("bakeJobId") or "",
        "bakeJobId":    payload.get("bakeJobId") or "",
        "tileH3":       payload.get("tileH3") or "",
        "format":       "glb",
        "glbBase64":    base64.b64encode(glb_bytes).decode("ascii"),
        "byteSize":     len(glb_bytes),
        "triangleCount": 12,
        "stats": {
            "stub":       True,
            "renderSec":  0,
            "fuseSec":    0,
            "decimateSec": 0,
            "viewCount":  0,
        },
        "modelVersion": "bake-stub@v1",
    }


def _bbox_from_ply_b64(b64_str: str) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    """Cheap bbox extractor — scans the binary PLY body for the first
    14-float record and reads xyz from each. Falls back to a unit cube
    around origin if anything goes wrong (stub-quality only)."""
    if not b64_str:
        return ((-0.5, -0.5, -0.5), (0.5, 0.5, 0.5))
    try:
        raw = base64.b64decode(b64_str)
        sep = b"end_header\n"
        idx = raw.find(sep)
        if idx < 0:
            return ((-0.5, -0.5, -0.5), (0.5, 0.5, 0.5))
        body = raw[idx + len(sep):]
        # Default 14 floats (DC band only). Higher-SH PLYs are wider
        # but x/y/z are still the first 3 floats.
        stride = 14 * 4
        n = len(body) // stride
        if n == 0:
            return ((-0.5, -0.5, -0.5), (0.5, 0.5, 0.5))
        mins = [float("inf")] * 3
        maxs = [float("-inf")] * 3
        for i in range(min(n, 32_000)):
            off = i * stride
            x, y, z = struct.unpack("<3f", body[off:off + 12])
            for j, v in enumerate((x, y, z)):
                if v < mins[j]:
                    mins[j] = v
                if v > maxs[j]:
                    maxs[j] = v
        return ((mins[0], mins[1], mins[2]), (maxs[0], maxs[1], maxs[2]))
    except Exception:
        return ((-0.5, -0.5, -0.5), (0.5, 0.5, 0.5))


def _stub_cube_glb(bbox: tuple[tuple[float, float, float], tuple[float, float, float]]) -> bytes:
    """Hand-rolled minimal GLB — 8 verts × 12 tris cube fitted to bbox.
    Avoids a trimesh dep on the slim Phase 1 image."""
    (mnx, mny, mnz), (mxx, mxy, mxz) = bbox
    if not all(math.isfinite(v) for v in (mnx, mny, mnz, mxx, mxy, mxz)):
        mnx = mny = mnz = -0.5
        mxx = mxy = mxz = 0.5
    if (mxx - mnx) <= 0 or (mxy - mny) <= 0 or (mxz - mnz) <= 0:
        cx = (mnx + mxx) / 2.0; cy = (mny + mxy) / 2.0; cz = (mnz + mxz) / 2.0
        mnx, mny, mnz = cx - 0.5, cy - 0.5, cz - 0.5
        mxx, mxy, mxz = cx + 0.5, cy + 0.5, cz + 0.5

    verts = [
        (mnx, mny, mnz), (mxx, mny, mnz), (mxx, mxy, mnz), (mnx, mxy, mnz),
        (mnx, mny, mxz), (mxx, mny, mxz), (mxx, mxy, mxz), (mnx, mxy, mxz),
    ]
    tris = [
        (0, 1, 2), (0, 2, 3),  # -Z
        (4, 6, 5), (4, 7, 6),  # +Z
        (0, 4, 5), (0, 5, 1),  # -Y
        (2, 6, 7), (2, 7, 3),  # +Y
        (1, 5, 6), (1, 6, 2),  # +X
        (0, 3, 7), (0, 7, 4),  # -X
    ]

    pos_bytes = b"".join(struct.pack("<3f", *v) for v in verts)
    idx_bytes = b"".join(struct.pack("<3H", *t) for t in tris)
    bin_chunk = pos_bytes + (b"\x00" * ((4 - len(pos_bytes) % 4) % 4)) + idx_bytes
    bin_chunk += b"\x00" * ((4 - len(bin_chunk) % 4) % 4)

    def _bbox_min_max(values: list[tuple[float, float, float]]):
        xs, ys, zs = zip(*values)
        return [min(xs), min(ys), min(zs)], [max(xs), max(ys), max(zs)]

    pmin, pmax = _bbox_min_max(verts)

    pos_offset = 0
    pos_len = len(pos_bytes)
    idx_offset = pos_len + ((4 - pos_len % 4) % 4)

    gltf = {
        "asset": {"version": "2.0", "generator": "kami-maps-gsplat-bake-stub"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes":  [{"mesh": 0, "name": "stub_cube"}],
        "meshes": [{
            "primitives": [{
                "attributes": {"POSITION": 0},
                "indices": 1,
                "mode": 4,
            }]
        }],
        "buffers": [{"byteLength": len(bin_chunk)}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": pos_offset, "byteLength": pos_len, "target": 34962},
            {"buffer": 0, "byteOffset": idx_offset, "byteLength": len(idx_bytes), "target": 34963},
        ],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": len(verts), "type": "VEC3",
             "min": pmin, "max": pmax},
            {"bufferView": 1, "componentType": 5123, "count": len(tris) * 3, "type": "SCALAR"},
        ],
    }
    json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    json_pad = (4 - len(json_bytes) % 4) % 4
    json_bytes = json_bytes + (b" " * json_pad)

    json_chunk = struct.pack("<I", len(json_bytes)) + b"JSON" + json_bytes
    bin_chunk_full = struct.pack("<I", len(bin_chunk)) + b"BIN\0" + bin_chunk
    total_len = 12 + len(json_chunk) + len(bin_chunk_full)
    header = struct.pack("<III", 0x46546C67, 2, total_len)  # "glTF" magic + v2
    return header + json_chunk + bin_chunk_full


def _run_bake_real(payload: dict[str, Any]) -> dict[str, Any]:
    """Real splat→mesh path. Decode the incoming PLY, render N RGB+D
    views via gsplat, fuse with Open3D TSDF, decimate, pack a GLB.
    Falls back to the cube stub on any missing dep / GPU absence /
    decode error so the BPMN never hard-fails."""
    try:
        import math
        import random
        import numpy as np
        import torch
        import torch.nn.functional as F
        import open3d as o3d
        import trimesh
        from gsplat import rasterization
    except ImportError as e:
        return _attach_error(_run_bake_stub(payload), f"bake deps missing: {e}")

    if not torch.cuda.is_available():
        return _attach_error(_run_bake_stub(payload), "bake requires CUDA — no GPU visible")

    b64 = payload.get("plyBase64") or ""
    if not b64:
        return _attach_error(_run_bake_stub(payload), "bake: empty plyBase64 in payload")

    try:
        ply_bytes = base64.b64decode(b64)
    except Exception as e:
        return _attach_error(_run_bake_stub(payload), f"bake: ply b64 decode: {e}")

    splats = _parse_ply_for_bake(ply_bytes)
    if splats is None:
        return _attach_error(_run_bake_stub(payload), "bake: PLY parse failed")
    means_np, opa_np, scales_np, quats_np, sh_dc_np = splats
    n = means_np.shape[0]
    if n < 64:
        return _attach_error(_run_bake_stub(payload), f"bake: only {n} splats — too sparse")

    device = torch.device("cuda")
    means     = torch.tensor(means_np, device=device, dtype=torch.float32)
    opacities = torch.sigmoid(torch.tensor(opa_np, device=device, dtype=torch.float32))
    scales    = torch.exp(torch.tensor(scales_np, device=device, dtype=torch.float32))
    quats     = F.normalize(torch.tensor(quats_np, device=device, dtype=torch.float32), dim=-1)
    # Convert renderer-convention sh_dc (rgb-0.5 magnitude) back to gsplat's
    # SH DC scaling (divide by SH_C0).
    sh_dc = torch.tensor(sh_dc_np, device=device, dtype=torch.float32) / _SH_C0
    colors = sh_dc[:, None, :]  # (N, 1, 3)

    # Centre + radius from bbox
    pmin = means.min(dim=0).values
    pmax = means.max(dim=0).values
    centre = (pmin + pmax) * 0.5
    radius = float(((pmax - pmin) * 0.5).norm().item())
    cam_dist = max(radius * 1.7, 1.5)
    voxel_size = max(radius / 256.0, 0.005)

    # Generate N viewpoints on a fibonacci sphere around the centre
    views = _fibonacci_views(_BAKE_VIEW_COUNT, centre.cpu().numpy(), cam_dist, device)
    width = height = _BAKE_RES
    fov_y = math.pi / 3.0
    f = (height * 0.5) / math.tan(fov_y * 0.5)
    K = torch.tensor(
        [[f, 0, width * 0.5], [0, f, height * 0.5], [0, 0, 1]],
        device=device, dtype=torch.float32,
    )

    t_render = time.time()
    volume = o3d.pipelines.integration.ScalableTSDFVolume(
        voxel_length=voxel_size,
        sdf_trunc=4 * voxel_size,
        color_type=o3d.pipelines.integration.TSDFVolumeColorType.RGB8,
    )
    intr = o3d.camera.PinholeCameraIntrinsic(
        width=width, height=height,
        fx=float(K[0, 0]), fy=float(K[1, 1]),
        cx=float(K[0, 2]), cy=float(K[1, 2]),
    )

    integrated = 0
    for viewmat in views:
        try:
            rgb_d, alpha, info = rasterization(
                means=means, quats=quats, scales=scales, opacities=opacities,
                colors=colors, viewmats=viewmat[None], Ks=K[None],
                width=width, height=height, sh_degree=0, packed=True,
                render_mode="RGB+D",
            )
        except Exception:
            continue
        # rendering = (1, H, W, 4) when render_mode="RGB+D" (RGB + Depth)
        if rgb_d is None or rgb_d.ndim != 4 or rgb_d.shape[-1] < 4:
            continue
        rgb = rgb_d[0, :, :, :3].clamp(0, 1)
        depth = rgb_d[0, :, :, 3]
        # Threshold on alpha — splats with low coverage are unreliable
        # depth signals; skip those pixels by zeroing depth.
        if alpha is not None and alpha.ndim >= 3:
            a = alpha[0, ..., 0] if alpha.ndim == 4 else alpha[0]
            depth = torch.where(a > 0.5, depth, torch.zeros_like(depth))

        rgb_np = (rgb.detach().cpu().numpy() * 255).astype(np.uint8)
        depth_np = depth.detach().cpu().numpy().astype(np.float32)
        if not np.isfinite(depth_np).any() or depth_np.max() <= 0:
            continue
        rgbd = o3d.geometry.RGBDImage.create_from_color_and_depth(
            o3d.geometry.Image(np.ascontiguousarray(rgb_np)),
            o3d.geometry.Image(np.ascontiguousarray(depth_np)),
            depth_scale=1.0, depth_trunc=cam_dist * 4.0, convert_rgb_to_intensity=False,
        )
        extrinsic = viewmat.detach().cpu().numpy().astype(np.float64)
        try:
            volume.integrate(rgbd, intr, extrinsic)
            integrated += 1
        except Exception:
            continue
    render_sec = int(time.time() - t_render)
    if integrated < 6:
        return _attach_error(_run_bake_stub(payload),
                             f"bake: only {integrated}/{_BAKE_VIEW_COUNT} views integrated")

    t_fuse = time.time()
    mesh = volume.extract_triangle_mesh()
    mesh.compute_vertex_normals()
    if len(mesh.triangles) == 0:
        return _attach_error(_run_bake_stub(payload), "bake: TSDF fusion produced empty mesh")
    fuse_sec = int(time.time() - t_fuse)

    t_dec = time.time()
    target = max(64, min(_BAKE_TARGET_TRIS, int(payload.get("targetTriangles") or _BAKE_TARGET_TRIS)))
    if len(mesh.triangles) > target:
        mesh = mesh.simplify_quadric_decimation(target_number_of_triangles=target)
        mesh.compute_vertex_normals()
    decimate_sec = int(time.time() - t_dec)

    verts = np.asarray(mesh.vertices, dtype=np.float32)
    faces = np.asarray(mesh.triangles, dtype=np.uint32)
    colors_v = np.asarray(mesh.vertex_colors, dtype=np.float32) if mesh.has_vertex_colors() else None

    tm = trimesh.Trimesh(vertices=verts, faces=faces, process=False)
    if colors_v is not None and colors_v.size:
        rgba = np.concatenate(
            [(colors_v * 255).clip(0, 255).astype(np.uint8),
             np.full((colors_v.shape[0], 1), 255, dtype=np.uint8)],
            axis=-1,
        )
        tm.visual.vertex_colors = rgba
    glb_bytes = tm.export(file_type="glb")

    return {
        "trainJobId":   payload.get("trainJobId") or "",
        "bakeJobId":    payload.get("bakeJobId") or "",
        "tileH3":       payload.get("tileH3") or "",
        "format":       "glb",
        "glbBase64":    base64.b64encode(glb_bytes).decode("ascii"),
        "byteSize":     len(glb_bytes),
        "triangleCount": int(faces.shape[0]),
        "stats": {
            "stub":         False,
            "viewCount":    integrated,
            "splatCount":   n,
            "renderSec":    render_sec,
            "fuseSec":      fuse_sec,
            "decimateSec":  decimate_sec,
            "voxelSize":    voxel_size,
            "camDist":      cam_dist,
        },
        "modelVersion": "bake@open3d-tsdf-trimesh-v1",
    }


def _parse_ply_for_bake(raw: bytes):
    """Decode a binary-LE PLY into per-splat numpy arrays. Tolerant
    of the wider `f_rest_*` schema (we only need DC + geometry +
    opacity for fusion). Returns None on parse failure."""
    try:
        import numpy as np
    except ImportError:
        return None
    sep = b"end_header\n"
    idx = raw.find(sep)
    if idx < 0:
        return None
    header_text = raw[:idx].decode("ascii", errors="replace")
    body = raw[idx + len(sep):]
    props: list[str] = []
    n_vert = 0
    for line in header_text.splitlines():
        parts = line.strip().split()
        if len(parts) >= 3 and parts[0] == "element" and parts[1] == "vertex":
            try:
                n_vert = int(parts[2])
            except ValueError:
                return None
        elif len(parts) >= 3 and parts[0] == "property":
            props.append(parts[2])
    if not n_vert or len(props) < 14:
        return None
    stride = len(props) * 4
    if len(body) < n_vert * stride:
        return None
    arr = np.frombuffer(body[: n_vert * stride], dtype=np.float32).reshape(n_vert, len(props))
    cols = {p: i for i, p in enumerate(props)}
    needed = ["x", "y", "z", "opacity",
              "scale_0", "scale_1", "scale_2",
              "rot_0", "rot_1", "rot_2", "rot_3",
              "f_dc_0", "f_dc_1", "f_dc_2"]
    if any(k not in cols for k in needed):
        return None
    means  = arr[:, [cols["x"], cols["y"], cols["z"]]].copy()
    opa    = arr[:, cols["opacity"]].copy()
    scales = arr[:, [cols["scale_0"], cols["scale_1"], cols["scale_2"]]].copy()
    quats  = arr[:, [cols["rot_0"], cols["rot_1"], cols["rot_2"], cols["rot_3"]]].copy()
    # Renderer convention: f_dc = rgb - 0.5 already scaled by SH_C0.
    # We keep it as-is and let the caller divide by SH_C0 to get gsplat
    # convention back for rasterization.
    sh_dc  = arr[:, [cols["f_dc_0"], cols["f_dc_1"], cols["f_dc_2"]]].copy()
    return means, opa, scales, quats, sh_dc


def _fibonacci_views(n: int, centre, cam_dist: float, device):
    """Generate N evenly-distributed viewpoints on a sphere around
    `centre`, each looking at `centre`. Returns torch viewmats (w2c)
    on `device`."""
    import math
    import numpy as np
    import torch

    out = []
    golden = math.pi * (3.0 - math.sqrt(5.0))
    for i in range(n):
        y = 1.0 - (i / max(n - 1, 1)) * 2.0
        r = math.sqrt(max(0.0, 1.0 - y * y))
        theta = golden * i
        x = math.cos(theta) * r
        z = math.sin(theta) * r
        cam_pos = np.asarray(centre, dtype=np.float32) + np.asarray([x, y, z], dtype=np.float32) * cam_dist
        forward = np.asarray(centre, dtype=np.float32) - cam_pos
        n_f = np.linalg.norm(forward)
        if n_f < 1e-6:
            continue
        forward /= n_f
        # Stable up: avoid degeneracy when forward is near +/- world up.
        world_up = np.asarray([0, 1, 0], dtype=np.float32)
        if abs(float(np.dot(forward, world_up))) > 0.95:
            world_up = np.asarray([0, 0, 1], dtype=np.float32)
        right = np.cross(forward, world_up)
        right /= max(np.linalg.norm(right), 1e-6)
        up = np.cross(right, forward)
        # World-from-camera (c2w): columns = right, up, -forward
        c2w = np.eye(4, dtype=np.float32)
        c2w[:3, 0] = right
        c2w[:3, 1] = up
        c2w[:3, 2] = -forward
        c2w[:3, 3] = cam_pos
        w2c = np.linalg.inv(c2w).astype(np.float32)
        out.append(torch.tensor(w2c, device=device, dtype=torch.float32))
    return out


# ── RunPod entry ───────────────────────────────────────────────────────


def handler(event: dict[str, Any]) -> dict[str, Any]:
    started = time.time()
    try:
        payload = event.get("input") or {}
        mode = str(payload.get("mode") or "train").lower()
        phase = os.environ.get("RUNPOD_PHASE", "1")
        if mode == "bake":
            if phase == "2":
                out = _run_bake_real(payload)
            else:
                out = _run_bake_stub(payload)
        else:
            if phase == "2":
                out = _run_train_real(payload)
            else:
                out = _run_train_stub(payload)
        out["runtimeMs"] = int((time.time() - started) * 1000)
        out.setdefault("mode", mode)
        out = _attach_cost(out)
        return out
    except Exception as e:  # noqa: BLE001
        return {
            "mode":       (event.get("input") or {}).get("mode") or "train",
            "trainJobId": (event.get("input") or {}).get("trainJobId") or "",
            "bakeJobId":  (event.get("input") or {}).get("bakeJobId") or "",
            "tileH3":     (event.get("input") or {}).get("tileH3") or "",
            "splatCount": 0,
            "shDegree":   0,
            "format":     "ply",
            "plyBase64":  "",
            "glbBase64":  "",
            "byteSize":   0,
            "stats":      {"error": str(e), "trace": traceback.format_exc()[-2000:]},
            "modelVersion": "",
            "runtimeMs":  int((time.time() - started) * 1000),
        }


if __name__ == "__main__":
    if runpod is None:
        # Local smoke — train + bake stubs
        train_sample = {
            "input": {
                "mode":       "train",
                "trainJobId": "gsplattrain-local",
                "tileH3":     "8c2a1072b59ffff",
                "lat":        35.6812,
                "lng":        139.7671,
                "radiusM":    50,
                "imageUrls":  ["http://example/dummy.jpg"] * 12,
                "maxImages":  80,
            }
        }
        train_out = handler(train_sample)
        echo = dict(train_out)
        if echo.get("plyBase64"):
            echo["plyBase64"] = f"<base64 {len(train_out['plyBase64'])} chars>"
        print("train:", json.dumps(echo, indent=2))
        # Round-trip: feed the train PLY into a bake stub.
        bake_sample = {
            "input": {
                "mode":      "bake",
                "bakeJobId": "gsplatbake-local",
                "tileH3":    "8c2a1072b59ffff",
                "plyBase64": train_out.get("plyBase64") or "",
            }
        }
        bake_out = handler(bake_sample)
        echo2 = dict(bake_out)
        if echo2.get("glbBase64"):
            echo2["glbBase64"] = f"<base64 {len(bake_out['glbBase64'])} chars>"
        print("bake:", json.dumps(echo2, indent=2))
    else:
        runpod.serverless.start({"handler": handler})
