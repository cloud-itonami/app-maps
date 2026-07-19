#!/usr/bin/env python3
"""Ferry / sea-route bulk dumper — resident worker (海路).

POST /trigger queries the OSM Overpass API for ``relation[route=ferry]``
worldwide (paginated by continent bbox) and INSERTs into RisingWave
``vertex_spatial`` as label = "SeaRoute". A second pass pulls
``node[amenity=ferry_terminal] | node[harbour=yes]`` to register / refresh
"Port" rows that anchor each ferry leg.

Output schema (vertex_spatial extras land in props JSON):
  - SeaRoute  → {osm_relation_id, operator, ref, name_en, from, to, network,
                 duration_min, frequency, distance_nmi}
  - Port      → {osm_node_id, name_en, ferry_terminal, harbour}

Source license: ODbL (OSM). Path-based DID:
  did:web:maps.etzhayyim.com:registry:osm:ferry

ENV:
  DATABASE_URL, B2_ACCESS_KEY_ID, B2_SECRET_ACCESS_KEY,
  B2_ENDPOINT, B2_BUCKET, B2_PREFIX (default maps-bulk-ingest/ferry-routes)
  OVERPASS_URL (default https://overpass-api.de/api/interpreter)
  OVERPASS_TIMEOUT_S (default 600)
  CONTINENT_BBOX (default ALL — comma-separated continent slugs from
    {asia, europe, africa, na, sa, oceania, jp})
  SHARD_ROWS, PORT (defaults 5000, 8080)
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from io import BytesIO
from threading import Lock, Thread

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
log = logging.getLogger("ferry_routes_dumper")

DATABASE_URL = os.environ.get("DATABASE_URL")
B2_BUCKET = os.environ.get("B2_BUCKET", "etzhayyim-nats")
B2_PREFIX = os.environ.get("B2_PREFIX", "maps-bulk-ingest/ferry-routes")
B2_ENDPOINT = os.environ.get("B2_ENDPOINT", "https://s3.us-west-004.backblazeb2.com")
PORT = int(os.environ.get("PORT", "8080"))
SHARD_ROWS = int(os.environ.get("SHARD_ROWS", "5000"))
OVERPASS_URL = os.environ.get("OVERPASS_URL", "https://overpass-api.de/api/interpreter")
OVERPASS_TIMEOUT_S = int(os.environ.get("OVERPASS_TIMEOUT_S", "600"))
CONTINENT_FILTER = os.environ.get("CONTINENT_BBOX", "ALL")

# bbox = (south, west, north, east)
CONTINENT_BBOX = {
    "jp":      (24.0, 122.0, 46.0, 146.0),
    "asia":    (-11.0, 26.0, 81.0, 180.0),
    "europe":  (34.0, -32.0, 72.0, 45.0),
    "africa":  (-35.0, -18.0, 38.0, 52.0),
    "na":      (5.0, -170.0, 84.0, -50.0),
    "sa":      (-57.0, -82.0, 13.0, -34.0),
    "oceania": (-50.0, 110.0, 0.0, 180.0),
}


def _selected_bboxes() -> list[tuple[str, tuple[float, float, float, float]]]:
    if CONTINENT_FILTER == "ALL":
        return list(CONTINENT_BBOX.items())
    out: list[tuple[str, tuple[float, float, float, float]]] = []
    for slug in CONTINENT_FILTER.split(","):
        slug = slug.strip()
        if slug in CONTINENT_BBOX:
            out.append((slug, CONTINENT_BBOX[slug]))
    return out or list(CONTINENT_BBOX.items())


_state = {
    "running": False,
    "started_at": None,
    "completed_at": None,
    "current_bbox": None,
    "bboxes_done": 0,
    "bboxes_total": 0,
    "searoutes": 0,
    "ports": 0,
    "rows_written": 0,
    "errors": [],
}
_lock = Lock()


def _b2():
    return boto3.client(
        "s3",
        endpoint_url=B2_ENDPOINT,
        aws_access_key_id=os.environ["B2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["B2_SECRET_ACCESS_KEY"],
    )


def _overpass(query: str) -> dict:
    """Run an Overpass QL query via curl --data-urlencode."""
    rc = subprocess.run(
        [
            "curl", "--silent", "--show-error",
            "--retry", "5", "--retry-max-time", str(OVERPASS_TIMEOUT_S),
            "--retry-all-errors", "--connect-timeout", "30",
            "--max-time", str(OVERPASS_TIMEOUT_S + 60),
            "--data-urlencode", f"data={query}",
            OVERPASS_URL,
            "-o", "/tmp/overpass.json",
        ],
        check=False,
    ).returncode
    if rc != 0:
        raise RuntimeError(f"overpass curl exit {rc}")
    with open("/tmp/overpass.json", encoding="utf-8") as f:
        return json.load(f)


def _bbox_str(bbox: tuple[float, float, float, float]) -> str:
    s, w, n, e = bbox
    return f"{s},{w},{n},{e}"


def _build_searoute_rows(slug: str, bbox: tuple[float, float, float, float],
                         elements: list[dict]) -> list[dict]:
    repo_did = "did:web:maps.etzhayyim.com"
    rows: list[dict] = []
    for el in elements:
        if el.get("type") != "relation":
            continue
        tags = el.get("tags") or {}
        if tags.get("route") != "ferry":
            continue
        rid = el.get("id")
        if not rid:
            continue
        # Overpass `out center` puts the geometric centroid here.
        center = el.get("center") or {}
        try:
            lat = float(center["lat"])
            lng = float(center["lon"])
        except (KeyError, ValueError):
            continue
        rkey = f"osm-ferry-{rid}"[:64]
        name = (
            tags.get("name:en") or tags.get("name")
            or f"{tags.get('from', '?')} → {tags.get('to', '?')}"
        )[:200]
        props = {
            "osm_relation_id": rid,
            "continent": slug,
            "operator": tags.get("operator"),
            "ref": tags.get("ref"),
            "network": tags.get("network"),
            "from": tags.get("from"),
            "to": tags.get("to"),
            "via": tags.get("via"),
            "name": tags.get("name"),
            "name_en": tags.get("name:en"),
            "duration_min": tags.get("duration"),
            "frequency": tags.get("interval") or tags.get("opening_hours"),
            "distance_nmi": tags.get("distance"),
            "fee": tags.get("fee"),
            "wheelchair": tags.get("wheelchair"),
        }
        rows.append({
            "vertex_id": f"at://{repo_did}/com.etzhayyim.apps.maps.seaRoute/{rkey}",
            "rkey": rkey,
            "repo": repo_did,
            "label": "SeaRoute",
            "did": repo_did,
            "name": name,
            "display_name": name,
            "lat": lat,
            "lng": lng,
            "source_did": "did:web:maps.etzhayyim.com:registry:osm:ferry",
            "source": "osm-overpass",
            "category": "seaRoute",
            "description": (f"{tags.get('operator','?')} — {tags.get('from','?')} → {tags.get('to','?')}")[:500],
            "country": None,
            "region_id": slug,
            "owner_did": repo_did,
            "sensitivity_ord": 0,
            "created_date": datetime.now(timezone.utc).date().isoformat(),
            "node_label": "SeaRoute",
            "props": json.dumps(props, ensure_ascii=False),
        })
    return rows


def _build_port_rows(slug: str, elements: list[dict]) -> list[dict]:
    repo_did = "did:web:maps.etzhayyim.com"
    rows: list[dict] = []
    for el in elements:
        if el.get("type") != "node":
            continue
        tags = el.get("tags") or {}
        if not (tags.get("amenity") == "ferry_terminal" or tags.get("harbour") == "yes"):
            continue
        nid = el.get("id")
        try:
            lat = float(el["lat"])
            lng = float(el["lon"])
        except (KeyError, ValueError):
            continue
        rkey = f"osm-port-{nid}"[:64]
        name = (tags.get("name:en") or tags.get("name") or f"port-{nid}")[:200]
        props = {
            "osm_node_id": nid,
            "continent": slug,
            "name": tags.get("name"),
            "name_en": tags.get("name:en"),
            "ferry_terminal": tags.get("amenity") == "ferry_terminal",
            "harbour": tags.get("harbour"),
            "operator": tags.get("operator"),
        }
        rows.append({
            "vertex_id": f"at://{repo_did}/com.etzhayyim.apps.maps.port/{rkey}",
            "rkey": rkey,
            "repo": repo_did,
            "label": "Port",
            "did": repo_did,
            "name": name,
            "display_name": name,
            "lat": lat,
            "lng": lng,
            "source_did": "did:web:maps.etzhayyim.com:registry:osm:ferry",
            "source": "osm-overpass",
            "category": "port",
            "description": (f"OSM ferry terminal / harbour: {name}")[:500],
            "country": None,
            "region_id": slug,
            "owner_did": repo_did,
            "sensitivity_ord": 0,
            "created_date": datetime.now(timezone.utc).date().isoformat(),
            "node_label": "Port",
            "props": json.dumps(props, ensure_ascii=False),
        })
    return rows


def _flush_shard(rows: list[dict], dump_id: str, kind: str, shard_idx: int) -> str:
    if not rows:
        return ""
    table = pa.Table.from_pylist(rows)
    buf = BytesIO()
    pq.write_table(table, buf, compression="zstd")
    buf.seek(0)
    key = f"{B2_PREFIX}/{dump_id}/{kind}/shard-{shard_idx:05d}.parquet"
    _b2().put_object(Bucket=B2_BUCKET, Key=key, Body=buf.getvalue())
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


def _process_bbox(slug: str, bbox: tuple[float, float, float, float], dump_id: str) -> dict:
    bb = _bbox_str(bbox)
    # SeaRoute relations
    relations_query = (
        f"[out:json][timeout:{OVERPASS_TIMEOUT_S}];"
        f"relation[\"route\"=\"ferry\"]({bb});"
        f"out center tags;"
    )
    rel_data = _overpass(relations_query)
    sr_rows = _build_searoute_rows(slug, bbox, rel_data.get("elements", []))

    # Ports
    ports_query = (
        f"[out:json][timeout:{OVERPASS_TIMEOUT_S}];("
        f"node[\"amenity\"=\"ferry_terminal\"]({bb});"
        f"node[\"harbour\"=\"yes\"]({bb}););"
        f"out tags;"
    )
    port_data = _overpass(ports_query)
    port_rows = _build_port_rows(slug, port_data.get("elements", []))

    written = 0
    shard_idx = 0
    for kind, rows in (("searoutes", sr_rows), ("ports", port_rows)):
        for i in range(0, len(rows), SHARD_ROWS):
            chunk = rows[i : i + SHARD_ROWS]
            _flush_shard(chunk, dump_id, f"{slug}-{kind}", shard_idx)
            written += _insert_rows_into_substrate(chunk)
            shard_idx += 1
    return {"slug": slug, "searoutes": len(sr_rows), "ports": len(port_rows), "rows_written": written}


def _run_dump():
    dump_id = datetime.now(timezone.utc).strftime("%Y%m%d")
    bboxes = _selected_bboxes()
    with _lock:
        if _state["running"]:
            return
        _state.update(
            running=True,
            started_at=datetime.now(timezone.utc).isoformat(),
            completed_at=None,
            current_bbox=None,
            bboxes_done=0,
            bboxes_total=len(bboxes),
            searoutes=0,
            ports=0,
            rows_written=0,
            errors=[],
        )
    log.info("starting dump %s bboxes=%d", dump_id, len(bboxes))
    for slug, bbox in bboxes:
        with _lock:
            _state["current_bbox"] = slug
        try:
            res = _process_bbox(slug, bbox, dump_id)
            with _lock:
                _state["bboxes_done"] += 1
                _state["searoutes"] += res["searoutes"]
                _state["ports"] += res["ports"]
                _state["rows_written"] += res["rows_written"]
            log.info("bbox %s: %s", slug, res)
        except Exception as e:
            log.exception("bbox %s failed", slug)
            with _lock:
                _state["errors"].append({"bbox": slug, "error": str(e)})
    with _lock:
        _state["running"] = False
        _state["current_bbox"] = None
        _state["completed_at"] = datetime.now(timezone.utc).isoformat()
    log.info("dump %s complete", dump_id)


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
    log.info("listening on :%d (continents=%s)", PORT, CONTINENT_FILTER)
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
