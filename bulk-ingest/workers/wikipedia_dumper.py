#!/usr/bin/env python3
"""Wikipedia bulk dumper — resident worker.

Per-lang loop:
  1. Download `{lang}wiki-latest-geo_tags.sql.gz` (~5-50MB per lang)
  2. Download `{lang}wiki-latest-page.sql.gz` (~50-500MB per lang) for titles
  3. Parse MySQL INSERT VALUES → JOIN page_id → (lat, lon, title)
  4. Write Parquet shards → B2
  5. COPY INTO vertex_spatial

Why geo_tags.sql.gz vs XML dumps:
  - XML dump (latest-pages-articles.xml.bz2) for ja-wiki is 4 GB compressed
  - geo_tags.sql.gz for ja-wiki is 8 MB compressed (only geotagged subset)
  - 500x bandwidth + parse-time saving for the same data we want.

ENV (same as wikidata_dumper.py):
  DATABASE_URL, B2_BUCKET, B2_PREFIX, B2_ACCESS_KEY_ID, B2_SECRET_ACCESS_KEY
  WIKIPEDIA_LANGS       comma-separated. Default: matches the 107 langs in
                        vertex_maps_coverage_target wikipedia:* targets.
  PORT                  8080
"""
from __future__ import annotations

import concurrent.futures
import gzip
import json
import logging
import os
import re
import sys
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from io import BytesIO
from threading import Lock, Thread
from typing import Iterator
from urllib.request import Request, urlopen

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
log = logging.getLogger("wikipedia_dumper")

DATABASE_URL = os.environ.get("DATABASE_URL")
B2_BUCKET = os.environ.get("B2_BUCKET", "etzhayyim-nats")
B2_PREFIX = os.environ.get("B2_PREFIX", "maps-bulk-ingest/wikipedia")
B2_ENDPOINT = os.environ.get("B2_ENDPOINT", "https://s3.us-west-004.backblazeb2.com")
PORT = int(os.environ.get("PORT", "8080"))
DEFAULT_LANGS = (
    "en,ja,fr,de,es,it,ru,zh,pt,ar,nl,pl,sv,vi,id,ko,tr,uk,ceb,war,no,fi,he,hu,cs,"
    "ca,bg,sk,el,da,ro,sr,hr,fa,th,az,kk,ms,et,sl,lv,lt,la,uz,bn,hi,ta,te,ml,mr,"
    "ne,gu,kn,pa,si,my,km,jv,su,el,is,ga,cy,af,sw,sq,gd,yi,wa,ha,mi,mt,vec,bar,"
    "scn,pms,lmo,ba,fy,an,ckb,tt,min,tg,ast,mg,ky,eo,am,io,xh,zu,so,ig,yo,haw,sah,"
    "lb,vo,mn,ka,or,as"
)
WIKIPEDIA_LANGS = [s.strip() for s in os.environ.get("WIKIPEDIA_LANGS", DEFAULT_LANGS).split(",") if s.strip()]
SHARD_ROWS = int(os.environ.get("SHARD_ROWS", "10000"))
FLUSH_INTERVAL_SEC = float(os.environ.get("FLUSH_INTERVAL_SEC", "60"))
_flush_pool = concurrent.futures.ThreadPoolExecutor(max_workers=2)

_state = {
    "running": False,
    "started_at": None,
    "current_lang": None,
    "rows_per_lang": {},
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
    """Check if a sub-job (e.g. lang) is already marked done in B2."""
    try:
        _b2().head_object(Bucket=B2_BUCKET, Key=f"{B2_PREFIX}/{dump_id}/.done/{key}")
        return True
    except Exception:
        return False


def _mark_done(dump_id: str, key: str) -> None:
    """Write completion marker for a sub-job to B2."""
    try:
        _b2().put_object(
            Bucket=B2_BUCKET,
            Key=f"{B2_PREFIX}/{dump_id}/.done/{key}",
            Body=datetime.now(timezone.utc).isoformat().encode(),
        )
    except Exception as e:
        log.warning("failed to mark %s done: %s", key, e)


# MySQL INSERT VALUES tuple parser. Lines look like:
#   INSERT INTO `geo_tags` VALUES (1,123,1,'earth',45.0,-72.5,...),(2,...),...;
# We don't need a full SQL parser — just regex-match parenthesized tuples.
_TUPLE_RE = re.compile(rb"\(([^)]+)\)")
_FIELD_RE = re.compile(rb"(?:'((?:[^'\\]|\\.)*)'|([^,]+))")


def _parse_mysql_dump(url: str) -> Iterator[list]:
    """Yield each row as a list of strings (fields decoded best-effort).

    Streams gzipped content line-by-line and emits tuples for INSERT VALUES.
    """
    log.info("fetching %s", url)
    req = Request(url, headers={"User-Agent": "etzhayyim-maps-bulk-ingest/1.0 (contact@etzhayyim.com)"})
    with urlopen(req, timeout=300) as resp, gzip.open(resp, "rb") as f:
        for line in f:
            if not line.startswith(b"INSERT INTO"):
                continue
            for m in _TUPLE_RE.finditer(line):
                fields_raw = m.group(1)
                fields = []
                for fm in _FIELD_RE.finditer(fields_raw):
                    quoted = fm.group(1)
                    if quoted is not None:
                        fields.append(quoted.decode("utf-8", errors="replace"))
                    else:
                        unq = fm.group(2)
                        if unq:
                            fields.append(unq.decode("utf-8", errors="replace").strip())
                yield fields


def _load_geo_tags(lang: str) -> dict[int, tuple[float, float]]:
    """page_id → (lat, lon). geo_tags schema:
    gt_id, gt_page_id, gt_globe, gt_primary, gt_lat, gt_lon, gt_dim, gt_type, gt_name, gt_country, gt_region
    """
    url = f"https://dumps.wikimedia.org/{lang}wiki/latest/{lang}wiki-latest-geo_tags.sql.gz"
    out: dict[int, tuple[float, float]] = {}
    for row in _parse_mysql_dump(url):
        try:
            page_id = int(row[1])
            lat = float(row[4])
            lon = float(row[5])
            if lat == 0 and lon == 0:
                continue
            # Keep only primary tag per page (gt_primary col idx 3 = '1' or '0')
            if row[3] != "1" and page_id in out:
                continue
            out[page_id] = (lat, lon)
        except (ValueError, IndexError):
            continue
    log.info("[%s] loaded %d geo_tags", lang, len(out))
    return out


def _load_page_titles(lang: str, wanted: set[int]) -> dict[int, str]:
    """page_id → title. page schema is much wider; we pull (page_id, page_namespace, page_title).
    Only namespace=0 (article).
    """
    url = f"https://dumps.wikimedia.org/{lang}wiki/latest/{lang}wiki-latest-page.sql.gz"
    out: dict[int, str] = {}
    for row in _parse_mysql_dump(url):
        try:
            page_id = int(row[0])
            if page_id not in wanted:
                continue
            ns = int(row[1])
            if ns != 0:
                continue
            title = row[2].replace("_", " ")
            out[page_id] = title
        except (ValueError, IndexError):
            continue
    log.info("[%s] resolved %d / %d titles", lang, len(out), len(wanted))
    return out


def _row(lang: str, page_id: int, title: str, lat: float, lon: float) -> dict:
    return {
        "vertex_id": f"at://did:web:maps.etzhayyim.com/com.etzhayyim.apps.maps.spot/wp-{lang}-{page_id}",
        "rkey": f"wp-{lang}-{page_id}",
        "repo": "did:web:maps.etzhayyim.com",
        "label": "Spot",
        "did": "did:web:maps.etzhayyim.com",
        "collection": "com.etzhayyim.apps.maps.spot",
        "name": title[:200],
        "lat": lat,
        "lng": lon,
        "source_did": f"did:web:maps.etzhayyim.com:wikipedia:{lang}:bulk",
        "category": f"wikipedia-{lang}",
        "description": "",
        "owner_did": "did:web:maps.etzhayyim.com",
        "sensitivity_ord": 0,
        "created_date": datetime.now(timezone.utc).date().isoformat(),
    }


def _flush(rows: list[dict], dump_id: str, lang: str, idx: int) -> str:
    if not rows:
        return ""
    table = pa.Table.from_pylist(rows)
    buf = BytesIO()
    pq.write_table(table, buf, compression="zstd")
    key = f"{B2_PREFIX}/{dump_id}/{lang}/shard-{idx:05d}.parquet"
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


def _run_dump():
    dump_id = datetime.now(timezone.utc).strftime("%Y%m%d")
    with _lock:
        if _state["running"]:
            log.warning("already running")
            return
        _state.update(
            running=True,
            started_at=datetime.now(timezone.utc).isoformat(),
            current_lang=None,
            rows_per_lang={},
            rows_written=0,
            error=None,
            completed_at=None,
        )
    try:
        rw_total = 0
        for lang in WIKIPEDIA_LANGS:
            with _lock:
                _state["current_lang"] = lang
            if _is_done(dump_id, f"wp-{lang}"):
                log.info("[%s] skip — already done in dump %s", lang, dump_id)
                with _lock:
                    _state["rows_per_lang"][lang] = "skipped"
                continue
            try:
                geo = _load_geo_tags(lang)
                if not geo:
                    _mark_done(dump_id, f"wp-{lang}")
                    continue
                titles = _load_page_titles(lang, set(geo.keys()))
                shard_rows: list[dict] = []
                shard_idx = 0
                lang_rw = 0
                last_flush = time.time()
                for page_id, (lat, lon) in geo.items():
                    title = titles.get(page_id)
                    if not title:
                        continue
                    shard_rows.append(_row(lang, page_id, title, lat, lon))
                    should_flush = (
                        len(shard_rows) >= SHARD_ROWS
                        or (shard_rows and time.time() - last_flush >= FLUSH_INTERVAL_SEC)
                    )
                    if should_flush:
                        fut_b2 = _flush_pool.submit(_flush, list(shard_rows), dump_id, lang, shard_idx)
                        ins = _insert_rows_into_substrate(shard_rows)
                        fut_b2.result()
                        rw_total += ins
                        lang_rw += ins
                        log.info("[%s] shard %d r2=%d rw=%d cum=%d", lang, shard_idx, len(shard_rows), ins, rw_total)
                        shard_rows.clear()
                        shard_idx += 1
                        last_flush = time.time()
                        with _lock:
                            _state["rows_written"] = rw_total
                if shard_rows:
                    fut_b2 = _flush_pool.submit(_flush, list(shard_rows), dump_id, lang, shard_idx)
                    ins = _insert_rows_into_substrate(shard_rows)
                    fut_b2.result()
                    rw_total += ins
                    lang_rw += ins
                    log.info("[%s] final shard %d r2=%d rw=%d cum=%d", lang, shard_idx, len(shard_rows), ins, rw_total)
                with _lock:
                    _state["rows_per_lang"][lang] = lang_rw
                    _state["rows_written"] = rw_total
                _mark_done(dump_id, f"wp-{lang}")
            except Exception as e:
                log.warning("[%s] failed: %s", lang, e)
        log.info("dump complete, rw_total=%d", rw_total)
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
                    return self._json(409, {"error": "running", "state": _state})
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
    log.info("listening on :%d (langs=%d)", PORT, len(WIKIPEDIA_LANGS))
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
