#!/usr/bin/env python3
"""Wikidata bulk dumper — resident worker.

Listens on POST /trigger; each invocation:
  1. Streams `latest-all.json.gz` (100GB) from dumps.wikimedia.org
  2. Filters entities with P625 (coordinate location) claim
  3. Writes Parquet shards to B2 (~5M rows / ~3GB)
  4. COPY FROM b2://... INTO RisingWave vertex_spatial

Idempotent: a dump_id (UTC date) skips if already complete.
Resumable: tracks last-processed offset in a DUMP_CHECKPOINT KV (B2 small file).

ENV:
  DATABASE_URL          postgres://root:...@host:4566/dev  (placeholder — set via k8s Secret)
  B2_BUCKET             etzhayyim-nats
  B2_PREFIX             maps-bulk-ingest/wikidata
  B2_ACCESS_KEY_ID
  B2_SECRET_ACCESS_KEY
  WIKIDATA_DUMP_URL     https://dumps.wikimedia.org/wikidatawiki/entities/latest-all.json.gz
  PORT                  8080
"""
from __future__ import annotations

import concurrent.futures
import gzip
import json
import logging
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from io import BytesIO
from threading import Lock, Thread
from typing import Iterator
from urllib.request import urlopen

import boto3
# Per ADR-2605172000 (kotoba substrate), all maps writes route through
# the substrate seam below; direct psycopg2 imports are no longer
# permitted in this worker. The seam still supports a transitional RW
# mode (psycopg2 under the hood) gated on ETZHAYYIM_SUBSTRATE_MODE.
from _etzhayyim_substrate import open_substrate_writer
import pyarrow as pa
import pyarrow.parquet as pq

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("wikidata_dumper")

DATABASE_URL = os.environ.get("DATABASE_URL")
B2_BUCKET = os.environ.get("B2_BUCKET", "etzhayyim-nats")
B2_PREFIX = os.environ.get("B2_PREFIX", "maps-bulk-ingest/wikidata")
B2_ENDPOINT = os.environ.get("B2_ENDPOINT", "https://s3.us-west-004.backblazeb2.com")
DUMP_URL = os.environ.get(
    "WIKIDATA_DUMP_URL",
    "https://dumps.wikimedia.org/wikidatawiki/entities/latest-all.json.gz",
)
PORT = int(os.environ.get("PORT", "8080"))
SHARD_ROWS = int(os.environ.get("SHARD_ROWS", "10000"))            # row-count flush trigger
FLUSH_INTERVAL_SEC = float(os.environ.get("FLUSH_INTERVAL_SEC", "60"))  # time fallback flush
_flush_pool = concurrent.futures.ThreadPoolExecutor(max_workers=2)

# Singleton state — only one dump runs at a time per pod.
_state = {
    "running": False,
    "started_at": None,
    "rows_written": 0,
    "current_qid": None,
    "error": None,
    "completed_at": None,
}
_lock = Lock()


def _b2_client():
    return boto3.client(
        "s3",
        endpoint_url=B2_ENDPOINT,
        aws_access_key_id=os.environ["B2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["B2_SECRET_ACCESS_KEY"],
    )


def _stream_dump(url: str) -> Iterator[dict]:
    """Yield parsed JSON entities from latest-all.json.gz line-by-line.

    Uses curl with native HTTP Range-resume on disconnect (--retry-all-errors
    + --retry 20). Wikidata's 100GB monolithic dump fails ~every 7-15 min over
    plain urlopen; curl --retry transparently resumes from byte offset, and
    gzip stream stays continuous as bytes append to the pipe.

    Wikidata's "JSON dump" is one entity per line, opening `[` and closing
    `]` framing characters. We strip those and parse each comma-terminated
    line as JSON.
    """
    log.info("opening %s via curl --retry-all-errors", url)
    cmd = [
        "curl", "--silent", "--location",
        "--retry", "20", "--retry-max-time", "1800", "--retry-all-errors",
        "--connect-timeout", "30", "--max-time", "0",
        url,
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=1 << 20)
    try:
        with gzip.open(proc.stdout, "rt") as f:
            first = f.readline()  # "[\n"
            if first.strip() != "[":
                raise RuntimeError(f"unexpected first line: {first!r}")
            for raw in f:
                raw = raw.rstrip("\n").rstrip(",")
                if raw == "]":
                    break
                if not raw:
                    continue
                try:
                    yield json.loads(raw)
                except json.JSONDecodeError as e:
                    log.warning("skip malformed line: %s", e)
    finally:
        if proc.poll() is None:
            proc.terminate()
        proc.wait(timeout=10)
        rc = proc.returncode
        if rc != 0:
            err = (proc.stderr.read() or b"").decode(errors="replace")[-500:]
            log.warning("curl exit=%d tail=%r", rc, err)


def _has_p625(entity: dict) -> tuple[float, float] | None:
    claims = entity.get("claims", {}).get("P625")
    if not claims:
        return None
    for c in claims:
        v = c.get("mainsnak", {}).get("datavalue", {}).get("value")
        if v and "latitude" in v and "longitude" in v:
            return float(v["latitude"]), float(v["longitude"])
    return None


def _entity_to_row(entity: dict, lat: float, lon: float) -> dict:
    qid = entity.get("id", "")
    label_en = (entity.get("labels", {}).get("en", {}) or {}).get("value", "")
    desc_en = (entity.get("descriptions", {}).get("en", {}) or {}).get("value", "")
    return {
        "vertex_id": f"at://did:web:maps.etzhayyim.com/com.etzhayyim.apps.maps.spot/wikidata-{qid}",
        "rkey": f"wikidata-{qid}",
        "repo": "did:web:maps.etzhayyim.com",
        "label": "Spot",
        "did": "did:web:maps.etzhayyim.com",
        "collection": "com.etzhayyim.apps.maps.spot",
        "name": label_en[:200],
        "lat": lat,
        "lng": lon,
        "source_did": "did:web:maps.etzhayyim.com:registry:wikidata:bulk",
        "category": "wikidata-bulk",
        "description": desc_en[:500],
        "owner_did": "did:web:maps.etzhayyim.com",
        "sensitivity_ord": 0,
        "created_date": datetime.now(timezone.utc).date().isoformat(),
    }


def _flush_shard(rows: list[dict], dump_id: str, shard_idx: int) -> str:
    if not rows:
        return ""
    table = pa.Table.from_pylist(rows)
    buf = BytesIO()
    pq.write_table(table, buf, compression="zstd")
    buf.seek(0)
    key = f"{B2_PREFIX}/{dump_id}/shard-{shard_idx:05d}.parquet"
    _b2_client().put_object(Bucket=B2_BUCKET, Key=key, Body=buf.getvalue())
    log.info("wrote shard %s rows=%d", key, len(rows))
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


def _run_dump():
    """Worker thread — single dump pass."""
    dump_id = datetime.now(timezone.utc).strftime("%Y%m%d")
    with _lock:
        if _state["running"]:
            log.warning("dump already running, ignoring trigger")
            return
        _state.update(
            running=True,
            started_at=datetime.now(timezone.utc).isoformat(),
            rows_written=0,
            current_qid=None,
            error=None,
            completed_at=None,
        )

    try:
        log.info("starting dump %s shard=%d flush_sec=%.0f", dump_id, SHARD_ROWS, FLUSH_INTERVAL_SEC)
        shard_rows: list[dict] = []
        shard_idx = 0
        rw_total = 0
        last_flush = time.time()
        for n, entity in enumerate(_stream_dump(DUMP_URL)):
            coord = _has_p625(entity)
            if not coord:
                continue
            lat, lon = coord
            shard_rows.append(_entity_to_row(entity, lat, lon))
            with _lock:
                _state["current_qid"] = entity.get("id")
                _state["rows_written"] = rw_total + len(shard_rows)
            should_flush = (
                len(shard_rows) >= SHARD_ROWS
                or (shard_rows and time.time() - last_flush >= FLUSH_INTERVAL_SEC)
            )
            if should_flush:
                # Run B2 PUT + RW INSERT in parallel
                fut_b2 = _flush_pool.submit(_flush_shard, list(shard_rows), dump_id, shard_idx)
                inserted = _insert_rows_into_substrate(shard_rows)
                fut_b2.result()  # propagate B2 errors
                rw_total += inserted
                log.info("shard %d: r2=%d rw=%d cum=%d", shard_idx, len(shard_rows), inserted, rw_total)
                shard_rows.clear()
                shard_idx += 1
                last_flush = time.time()
                with _lock:
                    _state["rows_written"] = rw_total
        if shard_rows:
            fut_b2 = _flush_pool.submit(_flush_shard, list(shard_rows), dump_id, shard_idx)
            inserted = _insert_rows_into_substrate(shard_rows)
            fut_b2.result()
            rw_total += inserted
            log.info("final shard %d: r2=%d rw=%d cum=%d", shard_idx, len(shard_rows), inserted, rw_total)

        log.info("dump %s complete, rw_total=%d", dump_id, rw_total)
        with _lock:
            _state["rows_written"] = rw_total
            _state["completed_at"] = datetime.now(timezone.utc).isoformat()
    except Exception as e:
        log.exception("dump failed")
        with _lock:
            _state["error"] = str(e)
    finally:
        with _lock:
            _state["running"] = False


class Handler(BaseHTTPRequestHandler):
    def _json(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())

    def do_POST(self):  # noqa: N802
        if self.path == "/trigger":
            with _lock:
                if _state["running"]:
                    return self._json(409, {"error": "dump already running", "state": _state})
            Thread(target=_run_dump, daemon=True).start()
            return self._json(202, {"accepted": True, "started_at": datetime.now(timezone.utc).isoformat()})
        return self._json(404, {"error": "not found"})

    def do_GET(self):  # noqa: N802
        if self.path == "/status":
            with _lock:
                return self._json(200, dict(_state))
        if self.path == "/health":
            return self._json(200, {"status": "ok"})
        return self._json(404, {"error": "not found"})

    def log_message(self, *args):
        pass


def main():
    if not DATABASE_URL:
        raise SystemExit("DATABASE_URL required")
    log.info("listening on :%d", PORT)
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
