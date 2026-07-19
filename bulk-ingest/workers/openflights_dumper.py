#!/usr/bin/env python3
"""OpenFlights bulk dumper — resident worker (空路 / scheduled flight legs).

POST /trigger downloads:
  - airports.dat  (~7,700 rows) — Airport metadata
  - routes.dat    (~67,500 rows) — scheduled point-to-point legs

…and writes them into RisingWave ``vertex_spatial``:

  - Airport rows: label = "Airport"
  - Route legs:   label = "AirRoute" (one row per (airline, src, dst) pair).
                  midpoint lat/lng = arithmetic midpoint of src+dst.
                  props = {airline, airline_id, src_iata, src_icao,
                           dst_iata, dst_icao, codeshare, stops, equipment}.

Source license: ODbL (Open Data Commons Open Database License). The data
is community-curated — it is the canonical free flight-route dataset and
is what most carriers' "route map" pages still trace back to.

ENV:
  DATABASE_URL, B2_ACCESS_KEY_ID, B2_SECRET_ACCESS_KEY,
  B2_ENDPOINT, B2_BUCKET, B2_PREFIX (default maps-bulk-ingest/openflights)
  OPENFLIGHTS_AIRPORTS_URL (default raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat)
  OPENFLIGHTS_ROUTES_URL   (default raw.githubusercontent.com/jpatokal/openflights/master/data/routes.dat)
  SHARD_ROWS, PORT (defaults 5000, 8080)
"""
from __future__ import annotations

import csv
import io
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
import pyarrow as pa
import pyarrow.parquet as pq

# Per ADR-2605172000 (kotoba substrate), all maps writes route through
# the substrate seam below; direct psycopg2 imports in this worker are
# no longer permitted. The seam still supports a transitional RW mode
# (psycopg2 under the hood) gated on ETZHAYYIM_SUBSTRATE_MODE.
from _etzhayyim_substrate import open_substrate_writer

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("openflights_dumper")

DATABASE_URL = os.environ.get("DATABASE_URL")
B2_BUCKET = os.environ.get("B2_BUCKET", "etzhayyim-nats")
B2_PREFIX = os.environ.get("B2_PREFIX", "maps-bulk-ingest/openflights")
B2_ENDPOINT = os.environ.get("B2_ENDPOINT", "https://s3.us-west-004.backblazeb2.com")
PORT = int(os.environ.get("PORT", "8080"))
SHARD_ROWS = int(os.environ.get("SHARD_ROWS", "5000"))
AIRPORTS_URL = os.environ.get(
    "OPENFLIGHTS_AIRPORTS_URL",
    "https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat",
)
ROUTES_URL = os.environ.get(
    "OPENFLIGHTS_ROUTES_URL",
    "https://raw.githubusercontent.com/jpatokal/openflights/master/data/routes.dat",
)
AIRLINES_URL = os.environ.get(
    "OPENFLIGHTS_AIRLINES_URL",
    "https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat",
)

_state = {
    "running": False,
    "started_at": None,
    "completed_at": None,
    "airports": 0,
    "airroutes": 0,
    "rows_written": 0,
    "error": None,
}
_lock = Lock()


def _b2():
    return boto3.client(
        "s3",
        endpoint_url=B2_ENDPOINT,
        aws_access_key_id=os.environ["B2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["B2_SECRET_ACCESS_KEY"],
    )


def _curl(url: str, dest: str) -> None:
    rc = subprocess.run(
        [
            "curl", "--silent", "--location",
            "--retry", "10", "--retry-max-time", "300", "--retry-all-errors",
            "--connect-timeout", "30",
            url, "-o", dest,
        ],
        check=False,
    ).returncode
    if rc != 0:
        raise RuntimeError(f"curl exit {rc} for {url}")


def _read_psv(path: str) -> list[list[str]]:
    """OpenFlights .dat is RFC4180-ish CSV with no header."""
    with open(path, encoding="utf-8", errors="replace") as f:
        return [row for row in csv.reader(f)]


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
    transitional). The function name retains its caller-visible
    behaviour: idempotent upsert keyed on ``vertex_id``.
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


def _build_airport_rows(airports_rows: list[list[str]]) -> tuple[list[dict], dict[str, dict]]:
    """OpenFlights airports.dat schema (1-indexed in their docs):
      0 airport_id, 1 name, 2 city, 3 country, 4 iata, 5 icao,
      6 lat, 7 lng, 8 alt_ft, 9 tz, 10 dst, 11 tz_olson,
      12 type, 13 source
    """
    repo_did = "did:web:maps.etzhayyim.com"
    rows: list[dict] = []
    by_id: dict[str, dict] = {}
    for r in airports_rows:
        if len(r) < 8:
            continue
        try:
            apid = r[0]
            name = r[1][:200]
            city = r[2]
            country = r[3]
            iata = r[4] if r[4] != "\\N" else ""
            icao = r[5] if r[5] != "\\N" else ""
            lat = float(r[6])
            lng = float(r[7])
        except (ValueError, IndexError):
            continue
        by_id[apid] = {
            "iata": iata, "icao": icao, "lat": lat, "lng": lng,
            "name": name, "city": city, "country": country,
        }
        # also key by IATA / ICAO for routes.dat lookup
        if iata:
            by_id[iata] = by_id[apid]
        if icao:
            by_id[icao] = by_id[apid]
        rkey = f"openflights-{(icao or iata or apid)}"[:64]
        props = {
            "openflights_id": apid,
            "iata": iata,
            "icao": icao,
            "city": city,
            "country": country,
            "altitude_ft": r[8] if len(r) > 8 else None,
            "tz_offset": r[9] if len(r) > 9 else None,
            "tz_olson": r[11] if len(r) > 11 else None,
            "type": r[12] if len(r) > 12 else None,
        }
        rows.append({
            "vertex_id": f"at://{repo_did}/com.etzhayyim.apps.maps.airport/{rkey}",
            "rkey": rkey,
            "repo": repo_did,
            "label": "Airport",
            "did": repo_did,
            "name": name,
            "display_name": name,
            "lat": lat,
            "lng": lng,
            "source_did": "did:web:maps.etzhayyim.com:registry:openflights",
            "source": "openflights",
            "category": "airport",
            "description": (f"{iata or icao} {city}, {country}")[:500],
            "country": (country or "")[:8],
            "owner_did": repo_did,
            "sensitivity_ord": 0,
            "created_date": datetime.now(timezone.utc).date().isoformat(),
            "node_label": "Airport",
            "props": json.dumps(props, ensure_ascii=False),
        })
    return rows, by_id


def _build_airroute_rows(routes_rows: list[list[str]],
                         airports_by_key: dict[str, dict],
                         airlines_by_id: dict[str, dict]) -> list[dict]:
    """OpenFlights routes.dat schema (no header):
      0 airline, 1 airline_id, 2 src_iata, 3 src_id, 4 dst_iata, 5 dst_id,
      6 codeshare, 7 stops, 8 equipment
    """
    repo_did = "did:web:maps.etzhayyim.com"
    rows: list[dict] = []
    for r in routes_rows:
        if len(r) < 9:
            continue
        airline = r[0]
        airline_id = r[1] if r[1] != "\\N" else ""
        src = r[2]
        dst = r[4]
        if not src or not dst:
            continue
        sa = airports_by_key.get(src) or airports_by_key.get(r[3])
        da = airports_by_key.get(dst) or airports_by_key.get(r[5])
        if not sa or not da:
            continue
        mid_lat = (sa["lat"] + da["lat"]) / 2.0
        mid_lng = (sa["lng"] + da["lng"]) / 2.0
        rkey = f"openflights-{airline}-{src}-{dst}"[:64]
        airline_meta = airlines_by_id.get(airline_id, {})
        props = {
            "airline": airline,
            "airline_id": airline_id,
            "airline_name": airline_meta.get("name"),
            "airline_country": airline_meta.get("country"),
            "src_iata": sa.get("iata"),
            "src_icao": sa.get("icao"),
            "src_lat": sa["lat"], "src_lng": sa["lng"],
            "src_name": sa.get("name"), "src_country": sa.get("country"),
            "dst_iata": da.get("iata"),
            "dst_icao": da.get("icao"),
            "dst_lat": da["lat"], "dst_lng": da["lng"],
            "dst_name": da.get("name"), "dst_country": da.get("country"),
            "codeshare": r[6],
            "stops": r[7],
            "equipment": r[8],
        }
        rows.append({
            "vertex_id": f"at://{repo_did}/com.etzhayyim.apps.maps.airRoute/{rkey}",
            "rkey": rkey,
            "repo": repo_did,
            "label": "AirRoute",
            "did": repo_did,
            "name": f"{airline} {src}→{dst}"[:200],
            "display_name": f"{airline} {src}→{dst}",
            "lat": mid_lat,
            "lng": mid_lng,
            "source_did": "did:web:maps.etzhayyim.com:registry:openflights",
            "source": "openflights",
            "category": "airRoute",
            "description": (f"{airline_meta.get('name', airline)} {sa.get('name','')} → {da.get('name','')}")[:500],
            "country": (sa.get("country") or "")[:8],
            "owner_did": repo_did,
            "sensitivity_ord": 0,
            "created_date": datetime.now(timezone.utc).date().isoformat(),
            "node_label": "AirRoute",
            "props": json.dumps(props, ensure_ascii=False),
        })
    return rows


def _read_airlines(path: str) -> dict[str, dict]:
    """airlines.dat schema:
      0 airline_id, 1 name, 2 alias, 3 iata, 4 icao, 5 callsign,
      6 country, 7 active
    """
    out: dict[str, dict] = {}
    if not os.path.exists(path):
        return out
    for r in _read_psv(path):
        if len(r) < 8:
            continue
        aid = r[0]
        out[aid] = {"name": r[1], "iata": r[3], "icao": r[4], "country": r[6]}
    return out


def _run_dump():
    dump_id = datetime.now(timezone.utc).strftime("%Y%m%d")
    with _lock:
        if _state["running"]:
            return
        _state.update(
            running=True,
            started_at=datetime.now(timezone.utc).isoformat(),
            completed_at=None,
            airports=0,
            airroutes=0,
            rows_written=0,
            error=None,
        )
    try:
        ap_path = "/tmp/airports.dat"
        rt_path = "/tmp/routes.dat"
        al_path = "/tmp/airlines.dat"
        _curl(AIRPORTS_URL, ap_path)
        _curl(ROUTES_URL, rt_path)
        try:
            _curl(AIRLINES_URL, al_path)
        except Exception as e:
            log.warning("airlines.dat fetch failed (%s) — continuing without airline metadata", e)

        airports_raw = _read_psv(ap_path)
        routes_raw = _read_psv(rt_path)
        airlines = _read_airlines(al_path)

        ap_rows, ap_by_key = _build_airport_rows(airports_raw)
        rt_rows = _build_airroute_rows(routes_raw, ap_by_key, airlines)

        with _lock:
            _state["airports"] = len(ap_rows)
            _state["airroutes"] = len(rt_rows)

        written = 0
        shard_idx = 0
        for kind, rows in (("airports", ap_rows), ("airroutes", rt_rows)):
            for i in range(0, len(rows), SHARD_ROWS):
                chunk = rows[i : i + SHARD_ROWS]
                _flush_shard(chunk, dump_id, kind, shard_idx)
                written += _insert_rows_into_substrate(chunk)
                shard_idx += 1
                with _lock:
                    _state["rows_written"] = written
        log.info("dump %s done: airports=%d routes=%d rows_written=%d",
                 dump_id, len(ap_rows), len(rt_rows), written)
    except Exception as e:
        log.exception("dump failed")
        with _lock:
            _state["error"] = str(e)
    finally:
        with _lock:
            _state["running"] = False
            _state["completed_at"] = datetime.now(timezone.utc).isoformat()


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
    log.info("listening on :%d", PORT)
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
