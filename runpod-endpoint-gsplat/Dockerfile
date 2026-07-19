# maps Gsplat (3D Gaussian Splatting) RunPod Serverless endpoint —
# Phase 1 (CPU stub). ADR-2605092800.
#
# `handler.py` emits a deterministic 1024-splat ring so the BPMN +
# bulk-ingest + B2 + RW INSERT path is exercisable before a real GPU
# endpoint is provisioned.
#
# Phase 2 (real Mapillary → COLMAP → gsplat trainer) lives in
# `Dockerfile.phase2` — see README §Phase 2.

FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY handler.py .

# Phase 1 default. The RunPod template Environment Variable panel
# can override this to `2`, but the slim image lacks COLMAP / gsplat
# / torch so `_run_train_real` will fall through to the stub with a
# structured `phase2 deps missing` error. Use Dockerfile.phase2 for
# real training.
ENV RUNPOD_PHASE=1

CMD ["python", "-u", "handler.py"]
