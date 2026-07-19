#!/usr/bin/env python3
"""Overture Maps bulk dumper — resident worker.

Uses Overture Maps GeoParquet releases (from s3://overturemaps-us-west-2/release/...)
to stream 'places', 'buildings', etc. directly into RisingWave, bypassing the
need to download and parse the 78GB OSM Planet PBF.

Workflow:
  1. Use pyarrow.dataset to read Overture GeoParquet directly from S3 (no full download).
  2. Map Overture schemas (categories) to our `vertex_spatial` labels.
  3. Write Parquet shards to B2 (for idempotency and backup).
  4. Batch INSERT into RisingWave.

ENV:
  DATABASE_URL, B2_BUCKET, B2_PREFIX, B2_ACCESS_KEY_ID, B2_SECRET_ACCESS_KEY
  OVERTURE_RELEASE      e.g. "2024-04-16-beta.0"
  OVERTURE_THEMES       comma-separated themes (default: "places,buildings")
  PORT                  8080
"""
from __future__ import annotations

import concurrent.futures
import json
import logging
import os
import sys
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from io import BytesIO
from threading import Lock, Thread

import boto3
import pyarrow as pa
import pyarrow.dataset as ds
import pyarrow.parquet as pq

# Per ADR-2605172000 (kotoba substrate), all maps writes route through
# the substrate seam below; direct psycopg2 imports are no longer
# permitted in this worker. The seam still supports a transitional RW
# mode (psycopg2 under the hood) gated on ETZHAYYIM_SUBSTRATE_MODE.
from _etzhayyim_substrate import open_substrate_writer

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("overture_maps_dumper")

DATABASE_URL = os.environ.get("DATABASE_URL")
B2_BUCKET = os.environ.get("B2_BUCKET", "etzhayyim-nats")
B2_PREFIX = os.environ.get("B2_PREFIX", "maps-bulk-ingest/overture-maps")
B2_ENDPOINT = os.environ.get("B2_ENDPOINT", "https://s3.us-west-004.backblazeb2.com")
PORT = int(os.environ.get("PORT", "8080"))
SHARD_ROWS = int(os.environ.get("SHARD_ROWS", "10000"))
FLUSH_INTERVAL_SEC = float(os.environ.get("FLUSH_INTERVAL_SEC", "60"))

OVERTURE_RELEASE = os.environ.get("OVERTURE_RELEASE", "2026-04-15.0")
OVERTURE_THEMES = [s.strip() for s in os.environ.get("OVERTURE_THEMES", "places").split(",") if s.strip()]

_flush_pool = concurrent.futures.ThreadPoolExecutor(max_workers=2)

_state = {
    "running": False,
    "started_at": None,
    "current_theme": None,
    "rows_per_theme": {},
    "rows_written": 0,
    "error": None,
    "completed_at": None,
}
_lock = Lock()


def _b2():
    return boto3.client(
        "s3",
        endpoint_url=B2_ENDPOINT,
        aws_access_key_id=os.environ["B2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["B2_SECRET_ACCESS_KEY"],
    )


def _is_done(dump_id: str, key: str) -> bool:
    try:
        _b2().head_object(Bucket=B2_BUCKET, Key=f"{B2_PREFIX}/{dump_id}/.done/{key}")
        return True
    except Exception:
        return False


def _mark_done(dump_id: str, key: str) -> None:
    try:
        _b2().put_object(
            Bucket=B2_BUCKET,
            Key=f"{B2_PREFIX}/{dump_id}/.done/{key}",
            Body=datetime.now(timezone.utc).isoformat().encode(),
        )
    except Exception as e:
        log.warning("failed to mark %s done: %s", key, e)


def _map_overture_category_to_label(theme: str, category: str | None) -> str:
    if theme == "buildings":
        return "Building"
    if theme == "places":
        if not category:
            return "Spot"
        c = category.lower()
        if "school" in c or "education" in c:
            return "School"
        if "restaurant" in c or "food" in c:
            return "Restaurant"
        if "hotel" in c or "accommodation" in c:
            return "Hotel"
        if "cafe" in c or "coffee" in c:
            return "Cafe"
        if "hospital" in c or "clinic" in c:
            return "Hospital"
        if "museum" in c or "tourism" in c:
            return "Museum"
    return "Spot"


def _row_from_overture(theme: str, record: dict) -> dict | None:
    """Map an Overture Maps dictionary record to our vertex_spatial row."""
    # Common Overture fields: id, geometry (WKB/GeoJSON bytes), bbox, names, categories
    ov_id = record.get("id")
    if not ov_id:
        return None

    # Handle names (Overture names is often a struct/json)
    names = record.get("names", {})
    name = None
    if isinstance(names, dict):
        name = names.get("primary") or names.get("common")
    elif isinstance(names, str):
        name = names # sometimes already parsed

    if not name:
        return None

    # Determine coordinates from bbox or geometry (simplification for point extraction)
    lat, lon = None, None
    bbox = record.get("bbox")
    if isinstance(bbox, dict) and "xmin" in bbox and "ymin" in bbox and "xmax" in bbox and "ymax" in bbox:
        lon = (bbox["xmin"] + bbox["xmax"]) / 2.0
        lat = (bbox["ymin"] + bbox["ymax"]) / 2.0

    if lat is None or lon is None:
        return None

    category = None
    cats = record.get("categories")
    if isinstance(cats, dict):
        category = cats.get("main")
    elif isinstance(cats, list) and cats:
        category = cats[0]
    elif isinstance(cats, str):
        category = cats

    label = _map_overture_category_to_label(theme, category)

    return {
        "vertex_id": f"at://did:web:maps.etzhayyim.com/com.etzhayyim.apps.maps.{label.lower()}/overture-{ov_id}",
        "rkey": f"overture-{ov_id}",
        "repo": "did:web:maps.etzhayyim.com",
        "label": label,
        "did": "did:web:maps.etzhayyim.com",
        "collection": f"com.etzhayyim.apps.maps.{label.lower()}",
        "name": str(name)[:200],
        "lat": lat,
        "lng": lon,
        "source_did": "did:web:maps.etzhayyim.com:infrastructure:bulk:overture",
        "props": json.dumps({"overture_id": ov_id, "category": category}),
    }


def _flush(rows: list[dict], dump_id: str, theme: str, idx: int) -> str:
    if not rows:
        return ""
    table = pa.Table.from_pylist(rows)
    buf = BytesIO()
    pq.write_table(table, buf, compression="zstd")
    key = f"{B2_PREFIX}/{dump_id}/{theme}/shard-{idx:05d}.parquet"
    _b2().put_object(Bucket=B2_BUCKET, Key=key, Body=buf.getvalue())
    log.info("wrote %s rows=%d", key, len(rows))
    return key


def _insert_rows_into_substrate(rows: list[dict], batch_size: int = 1000) -> int:
    """Upsert ingested rows via the etzhayyim substrate seam.

    Per ADR-2605172000 the writer dispatches on
    ``ETZHAYYIM_SUBSTRATE_MODE``: ``mst`` (PDS → MST + IPFS + Base L2
    anchor, post-migration) or ``rw`` (psycopg2 → vertex_spatial,
    transitional). Idempotent upsert keyed on ``vertex_id``.
    """
    if not rows:
        return 0
    total = 0
    with open_substrate_writer() as writer:
        for i in range(0, len(rows), batch_size):
            chunk = rows[i : i + batch_size]
            try:
                total += writer.upsert_vertex_spatial(chunk)
            except Exception as e:
                log.warning(
                    "substrate upsert failed (chunk %d-%d): %s",
                    i,
                    i + len(chunk),
                    e,
                )
    return total


def _process_theme(theme: str, dump_id: str) -> int:
    log.info("Processing Overture theme: %s (release %s)", theme, OVERTURE_RELEASE)

    # S3 path to Overture Maps release
    bucket_path = f"overturemaps-us-west-2/release/{OVERTURE_RELEASE}/theme={theme}"

    try:
        from pyarrow import fs
        s3 = fs.S3FileSystem(anonymous=True, region="us-west-2")
        dataset = ds.dataset(bucket_path, filesystem=s3, format="parquet")
    except Exception as e:
        log.error("Failed to load Overture dataset %s: %s", bucket_path, e)
        return 0

    rw_total = 0
    shard_rows: list[dict] = []
    shard_idx = 0
    last_flush = time.time()

    # Stream record batches
    for batch in dataset.to_batches(columns=["id", "names", "bbox", "categories"], batch_size=1000):
        for record in batch.to_pylist():
            row = _row_from_overture(theme, record)
            if not row:
                continue

            shard_rows.append(row)

            should_flush = (
                len(shard_rows) >= SHARD_ROWS
                or (time.time() - last_flush) > FLUSH_INTERVAL_SEC
            )
            if should_flush:
                f_rows = shard_rows[:]
                shard_rows.clear()
                _flush_pool.submit(_flush, f_rows, dump_id, theme, shard_idx)
                rw_total += _insert_rows_into_substrate(f_rows)
                shard_idx += 1
                last_flush = time.time()

                with _lock:
                    _state["rows_per_theme"][theme] = rw_total
                    _state["rows_written"] = sum(_state["rows_per_theme"].values())

    if shard_rows:
        _flush_pool.submit(_flush, shard_rows, dump_id, theme, shard_idx)
        rw_total += _insert_rows_into_substrate(shard_rows)
        with _lock:
            _state["rows_per_theme"][theme] = rw_total
            _state["rows_written"] = sum(_state["rows_per_theme"].values())

    return rw_total


def _run_dump() -> None:
    if not DATABASE_URL:
        log.error("DATABASE_URL is not set.")
        with _lock:
            _state["running"] = False
            _state["error"] = "DATABASE_URL is not set."
        return

    dump_id = datetime.now(timezone.utc).strftime("%Y%m%d")
    log.info("starting Overture Maps dump %s", dump_id)

    try:
        for theme in OVERTURE_THEMES:
            if _is_done(dump_id, theme):
                log.info("theme %s already done for %s, skipping", theme, dump_id)
                continue

            with _lock:
                _state["current_theme"] = theme
                if theme not in _state["rows_per_theme"]:
                    _state["rows_per_theme"][theme] = 0

            _process_theme(theme, dump_id)
            _mark_done(dump_id, theme)

        log.info("dump %s complete", dump_id)
        with _lock:
            _state["completed_at"] = datetime.now(timezone.utc).isoformat()
            _state["error"] = None
    except Exception as e:
        log.exception("dump failed")
        with _lock:
            _state["error"] = str(e)
    finally:
        with _lock:
            _state["running"] = False


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok\n")
            return
        if self.path == "/status":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            with _lock:
                self.wfile.write(json.dumps(_state).encode())
            return
        self.send_error(404)

    def do_POST(self):
        if self.path == "/trigger":
            with _lock:
                if _state["running"]:
                    self.send_response(409)
                    self.end_headers()
                    self.wfile.write(b"already running\n")
                    return
                _state["running"] = True
                _state["started_at"] = datetime.now(timezone.utc).isoformat()
                _state["completed_at"] = None
                _state["error"] = None
                _state["rows_per_theme"] = {}
                _state["rows_written"] = 0
            Thread(target=_run_dump, daemon=True).start()
            self.send_response(202)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps(
                    {"accepted": True, "started_at": _state["started_at"]}
                ).encode()
            )
            return
        self.send_error(404)


if __name__ == "__main__":
    if not DATABASE_URL:
        raise SystemExit("DATABASE_URL required")
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    log.info("listening on :%d (themes=%s)", PORT, ",".join(OVERTURE_THEMES))
    server.serve_forever()
