# maps RunPod Serverless endpoint. ADR-2604271800.
#
# Phase 1 (scaffold) base image: pure Python, no GPU. The handler
# returns deterministic stubs so the LangServer contract can be exercised
# end-to-end before model weights are wired.
#
# Phase 2 (real models) flip BASE to `runpod/pytorch:2.4-cuda12.4` and
# uncomment the geospatial stack in requirements.txt. The handler
# entrypoint stays the same.

ARG BASE=python:3.11-slim
FROM ${BASE}

WORKDIR /app

# Phase 2 only: GDAL system deps for rasterio.
# RUN apt-get update && apt-get install -y --no-install-recommends \
#     libgdal32 \
#     gdal-bin \
#  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY handler.py .

# RunPod Serverless entrypoint. SDK reads the handler from the
# environment + module path on container start.
CMD ["python", "-u", "handler.py"]
