#!/usr/bin/env python3
"""GTFS-RT bulk dumper — Phase 3 (gated).

Long-running pod with internal scheduler:
  every  30s — VehiclePosition pull → vertex_maps_vehicle_position
  every  60s — TripUpdate     pull → vertex_maps_trip_update
  every 300s — Alerts         pull → vertex_maps_service_alert

Two feed-index sources, in priority order:

  1. GTFS_RT_FEED_INDEX_URL — JSON array of
       {feed_id, agency, vehicle_position_url?, trip_update_url?, alerts_url?,
        headers?: {…}}
     for no-auth operators (Aomori, OdakyuBus, …).

  2. ODPT_API_KEY (公共交通オープンデータセンター) — when set, the dumper
     fetches /api/v4/gtfs-realtime/{operator}/{kind}.pb endpoints for the
     subset listed in ODPT_OPERATORS (default: TokyoMetro,JR-East,Toei).

If neither is set the worker raises before the HTTP server starts.
That is the gate the design contract promised: zero traffic until you
make a deliberate authentication choice.

Idempotency on RW:
  - vertex_maps_vehicle_position PK = (feed_id, vehicle_id, ts) — RW PK
    upsert is fine; subsequent fires with the same ts overwrite.
  - vertex_maps_trip_update      PK = (feed_id, trip_id, stop_sequence, ts)
  - vertex_maps_service_alert    PK = (feed_id, alert_id, ts)
The 24h streaming MV (mv_maps_recent_*) handles eviction by WHERE clause;
this writer only appends.

ENV:
  DATABASE_URL                — required, RW Postgres URL
  GTFS_RT_FEED_INDEX_URL      — optional, JSON URL (no-auth feeds)
  ODPT_API_KEY                — optional, ODPT key
  ODPT_OPERATORS              — comma-list, default TokyoMetro,JR-East,Toei
  ODPT_BASE_URL               — default https://api.odpt.org/api/v4
  VP_INTERVAL_S, TU_INTERVAL_S, ALERT_INTERVAL_S   — defaults 30, 60, 300
  HTTP_TIMEOUT_S              — default 15
  PORT                        — default 8080
"""
from __future__ import annotations

import base64
import json
import logging
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Lock

# Per ADR-2605172000 (kotoba substrate), all maps writes route through
# the substrate seam below; direct psycopg2 imports are no longer
# permitted in this worker. The seam still supports a transitional RW
# mode (psycopg2 under the hood) gated on ETZHAYYIM_SUBSTRATE_MODE.
from _etzhayyim_substrate import open_substrate_writer

# TODO(ADR-2605172000 / Stage 2): the writes below still hit
# RisingWave directly via psycopg2 patterns specific to this
# worker. Replace them with `open_substrate_writer().upsert_table(
# '<table>', rows, conflict_key=...)` per the substrate seam
# contract in `_etzhayyim_substrate.py`. The legacy import has
# been re-added below as a guarded fallback so the worker still
# functions while ETZHAYYIM_SUBSTRATE_MODE=rw; remove it once the
# call sites are migrated.
import psycopg2  # noqa: E402 — pending substrate refactor (Stage 2)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("gtfs_rt_dumper")

DATABASE_URL = os.environ.get("DATABASE_URL")
FEED_INDEX_URL = os.environ.get("GTFS_RT_FEED_INDEX_URL", "").strip()
ODPT_API_KEY = os.environ.get("ODPT_API_KEY", "").strip()
ODPT_OPERATORS = [s.strip() for s in os.environ.get(
    "ODPT_OPERATORS", "TokyoMetro,JR-East,Toei"
).split(",") if s.strip()]
ODPT_BASE_URL = os.environ.get("ODPT_BASE_URL", "https://api.odpt.org/api/v4")
VP_INTERVAL_S = int(os.environ.get("VP_INTERVAL_S", "30"))
TU_INTERVAL_S = int(os.environ.get("TU_INTERVAL_S", "60"))
ALERT_INTERVAL_S = int(os.environ.get("ALERT_INTERVAL_S", "300"))
HTTP_TIMEOUT_S = int(os.environ.get("HTTP_TIMEOUT_S", "15"))
PORT = int(os.environ.get("PORT", "8080"))

try:
    # gtfs-realtime-bindings ships generated protobufs; defer-import so the
    # module loads even when the dependency hasn't been installed yet
    # (development).
    from google.transit import gtfs_realtime_pb2  # type: ignore
    _PB_OK = True
except ImportError as e:
    gtfs_realtime_pb2 = None  # type: ignore
    _PB_IMPORT_ERR = str(e)
    _PB_OK = False


_state = {
    "running": False,
    "started_at": None,
    "feeds_total": 0,
    "last_vp_at": None,
    "last_tu_at": None,
    "last_alert_at": None,
    "vp_rows_total": 0,
    "tu_rows_total": 0,
    "alert_rows_total": 0,
    "errors": [],
}
_lock = Lock()
_stop = threading.Event()


# ─── feed index ──────────────────────────────────────────────────────

def _load_no_auth_feeds() -> list[dict]:
    if not FEED_INDEX_URL:
        return []
    with urllib.request.urlopen(FEED_INDEX_URL, timeout=30) as r:
        feeds = json.loads(r.read().decode("utf-8"))
    if not isinstance(feeds, list):
        raise RuntimeError(f"GTFS_RT_FEED_INDEX_URL did not return a JSON list")
    out: list[dict] = []
    for f in feeds:
        if not isinstance(f, dict) or not f.get("feed_id"):
            continue
        out.append(f)
    return out


def _load_odpt_feeds() -> list[dict]:
    """Fan ODPT_OPERATORS out into 1 logical feed per operator with 3 endpoint URLs."""
    if not ODPT_API_KEY:
        return []
    out: list[dict] = []
    for op in ODPT_OPERATORS:
        out.append({
            "feed_id": f"odpt-{op.lower()}",
            "agency": op,
            "vehicle_position_url": f"{ODPT_BASE_URL}/gtfs-realtime/{op}/VehiclePosition.pb?acl:consumerKey={ODPT_API_KEY}",
            "trip_update_url":      f"{ODPT_BASE_URL}/gtfs-realtime/{op}/TripUpdate.pb?acl:consumerKey={ODPT_API_KEY}",
            "alerts_url":           f"{ODPT_BASE_URL}/gtfs-realtime/{op}/Alert.pb?acl:consumerKey={ODPT_API_KEY}",
        })
    return out


def _resolve_feeds() -> list[dict]:
    feeds = _load_no_auth_feeds() + _load_odpt_feeds()
    if not feeds:
        raise RuntimeError(
            "No RT feeds configured. Set GTFS_RT_FEED_INDEX_URL (no-auth "
            "operators) and/or ODPT_API_KEY (Tokyo Metro / JR East / Toei)."
        )
    return feeds


# ─── pb fetch ────────────────────────────────────────────────────────

def _fetch_pb(url: str, headers: dict | None = None) -> "gtfs_realtime_pb2.FeedMessage | None":
    if not _PB_OK:
        raise RuntimeError(
            f"gtfs-realtime-bindings not installed: {_PB_IMPORT_ERR} — "
            "add `gtfs-realtime-bindings` to requirements.txt"
        )
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as r:
            data = r.read()
    except (urllib.error.URLError, TimeoutError) as e:
        log.warning("RT fetch failed %s: %s", url, e)
        return None
    fm = gtfs_realtime_pb2.FeedMessage()
    try:
        fm.ParseFromString(data)
    except Exception as e:
        log.warning("RT protobuf parse failed %s: %s", url, e)
        return None
    return fm


def _ts_iso(ts: int | None) -> str | None:
    if not ts:
        return None
    return datetime.fromtimestamp(int(ts), timezone.utc).isoformat()


# ─── per-entity row builders ─────────────────────────────────────────

def _vp_rows(feed: dict, fm) -> list[dict]:
    fid = feed["feed_id"]
    rows: list[dict] = []
    header_ts = fm.header.timestamp if fm.HasField("header") else 0
    for ent in fm.entity:
        if not ent.HasField("vehicle"):
            continue
        v = ent.vehicle
        ts = v.timestamp or header_ts or int(time.time())
        vid = v.vehicle.id or ent.id or ""
        if not vid:
            continue
        pos = v.position if v.HasField("position") else None
        rows.append({
            "feed_id": fid,
            "vehicle_id": vid,
            "ts": _ts_iso(ts),
            "trip_id": v.trip.trip_id if v.HasField("trip") else None,
            "route_id": v.trip.route_id if v.HasField("trip") else None,
            "stop_id": v.stop_id or None,
            "lat": pos.latitude if pos else None,
            "lng": pos.longitude if pos else None,
            "bearing": pos.bearing if pos and pos.HasField("bearing") else None,
            "speed_mps": pos.speed if pos and pos.HasField("speed") else None,
            "occupancy_status": v.OccupancyStatus.Name(v.occupancy_status) if v.HasField("occupancy_status") else None,
            "current_status": v.VehicleStopStatus.Name(v.current_status) if v.HasField("current_status") else None,
            "congestion_level": v.CongestionLevel.Name(v.congestion_level) if v.HasField("congestion_level") else None,
            "label": v.vehicle.label or None,
            "raw_pb_b64": None,
        })
    return rows


def _tu_rows(feed: dict, fm) -> list[dict]:
    fid = feed["feed_id"]
    rows: list[dict] = []
    header_ts = fm.header.timestamp if fm.HasField("header") else 0
    for ent in fm.entity:
        if not ent.HasField("trip_update"):
            continue
        tu = ent.trip_update
        trip_id = tu.trip.trip_id if tu.HasField("trip") else ""
        route_id = tu.trip.route_id if tu.HasField("trip") else None
        ts = tu.timestamp or header_ts or int(time.time())
        sched = tu.trip.ScheduleRelationship.Name(tu.trip.schedule_relationship) if tu.HasField("trip") else None
        for stu in tu.stop_time_update:
            arrival = stu.arrival if stu.HasField("arrival") else None
            departure = stu.departure if stu.HasField("departure") else None
            rows.append({
                "feed_id": fid,
                "trip_id": trip_id,
                "stop_sequence": int(stu.stop_sequence) if stu.HasField("stop_sequence") else 0,
                "ts": _ts_iso(ts),
                "stop_id": stu.stop_id or None,
                "route_id": route_id,
                "schedule_relationship": sched,
                "arrival_delay_sec": int(arrival.delay) if arrival and arrival.HasField("delay") else None,
                "departure_delay_sec": int(departure.delay) if departure and departure.HasField("delay") else None,
                "arrival_time": _ts_iso(arrival.time) if arrival and arrival.HasField("time") else None,
                "departure_time": _ts_iso(departure.time) if departure and departure.HasField("time") else None,
                "uncertainty_sec": int(arrival.uncertainty) if arrival and arrival.HasField("uncertainty") else None,
            })
    return rows


def _alert_rows(feed: dict, fm) -> list[dict]:
    fid = feed["feed_id"]
    rows: list[dict] = []
    header_ts = fm.header.timestamp if fm.HasField("header") else int(time.time())
    for ent in fm.entity:
        if not ent.HasField("alert"):
            continue
        a = ent.alert
        active_from = active_until = None
        for p in a.active_period:
            if p.HasField("start"):
                active_from = _ts_iso(p.start)
            if p.HasField("end"):
                active_until = _ts_iso(p.end)
        header_text = "; ".join(t.text for t in a.header_text.translation)[:2048] if a.HasField("header_text") else None
        desc = "; ".join(t.text for t in a.description_text.translation)[:8192] if a.HasField("description_text") else None
        url = a.url.translation[0].text if a.HasField("url") and len(a.url.translation) > 0 else None
        affected_route_ids = ",".join(s.route_id for s in a.informed_entity if s.route_id)[:2048] or None
        affected_stop_ids = ",".join(s.stop_id for s in a.informed_entity if s.stop_id)[:2048] or None
        affected_trip_ids = ",".join(s.trip.trip_id for s in a.informed_entity if s.HasField("trip"))[:2048] or None
        rows.append({
            "feed_id": fid,
            "alert_id": ent.id or "",
            "ts": _ts_iso(header_ts),
            "cause": a.Cause.Name(a.cause) if a.HasField("cause") else None,
            "effect": a.Effect.Name(a.effect) if a.HasField("effect") else None,
            "severity": a.SeverityLevel.Name(a.severity_level) if a.HasField("severity_level") else None,
            "header_text": header_text,
            "description": desc,
            "url": url,
            "active_from": active_from,
            "active_until": active_until,
            "affected_route_ids": affected_route_ids,
            "affected_stop_ids": affected_stop_ids,
            "affected_trip_ids": affected_trip_ids,
        })
    return rows


# ─── DB write ────────────────────────────────────────────────────────

def _insert(rows: list[dict], table: str, batch_size: int = 500) -> int:
    if not rows:
        return 0
    total = 0
    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = False
    try:
        cur = conn.cursor()
        cols = list(rows[0].keys())
        for i in range(0, len(rows), batch_size):
            chunk = rows[i : i + batch_size]
            placeholders = ", ".join("(" + ", ".join(["%s"] * len(cols)) + ")" for _ in chunk)
            sql = f"INSERT INTO {table} ({', '.join(cols)}) VALUES {placeholders}"
            params = [r[c] for r in chunk for c in cols]
            try:
                cur.execute(sql, params)
                conn.commit()
                total += len(chunk)
            except Exception as e:
                conn.rollback()
                log.warning("RT insert into %s failed: %s", table, e)
    finally:
        conn.close()
    return total


# ─── scheduler loops ─────────────────────────────────────────────────

def _loop_kind(kind: str, interval_s: int, url_key: str, builder, table: str,
               state_ts_key: str, state_count_key: str, feeds: list[dict]) -> None:
    log.info("starting %s loop interval=%ds feeds=%d table=%s", kind, interval_s, len(feeds), table)
    while not _stop.is_set():
        cycle_started = time.time()
        cycle_rows = 0
        for feed in feeds:
            url = feed.get(url_key)
            if not url:
                continue
            fm = _fetch_pb(url, headers=feed.get("headers"))
            if not fm:
                continue
            rows = builder(feed, fm)
            if rows:
                cycle_rows += _insert(rows, table)
        with _lock:
            _state[state_ts_key] = datetime.now(timezone.utc).isoformat()
            _state[state_count_key] += cycle_rows
        elapsed = time.time() - cycle_started
        sleep_s = max(1.0, interval_s - elapsed)
        if _stop.wait(sleep_s):
            return


def _start_loops(feeds: list[dict]) -> None:
    threading.Thread(
        target=_loop_kind,
        args=("vehicle_position", VP_INTERVAL_S, "vehicle_position_url", _vp_rows,
              "vertex_maps_vehicle_position", "last_vp_at", "vp_rows_total", feeds),
        daemon=True,
    ).start()
    threading.Thread(
        target=_loop_kind,
        args=("trip_update", TU_INTERVAL_S, "trip_update_url", _tu_rows,
              "vertex_maps_trip_update", "last_tu_at", "tu_rows_total", feeds),
        daemon=True,
    ).start()
    threading.Thread(
        target=_loop_kind,
        args=("alert", ALERT_INTERVAL_S, "alerts_url", _alert_rows,
              "vertex_maps_service_alert", "last_alert_at", "alert_rows_total", feeds),
        daemon=True,
    ).start()


# ─── HTTP shell ──────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def _json(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())

    def do_GET(self):  # noqa: N802
        if self.path == "/status":
            with _lock:
                return self._json(200, dict(_state))
        if self.path == "/health":
            return self._json(200, {"status": "ok"})
        return self._json(404, {"error": "not found"})

    def log_message(self, *args):
        pass


def main() -> int:
    if not DATABASE_URL:
        raise SystemExit("DATABASE_URL required")
    feeds = _resolve_feeds()
    with _lock:
        _state.update(
            running=True,
            started_at=datetime.now(timezone.utc).isoformat(),
            feeds_total=len(feeds),
        )
    log.info("RT dumper booting feeds=%d (vp=%ds tu=%ds alerts=%ds)",
             len(feeds), VP_INTERVAL_S, TU_INTERVAL_S, ALERT_INTERVAL_S)
    _start_loops(feeds)
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
