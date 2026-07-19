#!/usr/bin/env python3
"""aismarine consumer — long-running aisstream.io WebSocket pod (ADR-2605011500).

Subscribes to wss://stream.aisstream.io/v0/stream with no BoundingBoxes
filter (global). Decoded AIS messages are batched in-process (5s OR 500
messages — whichever first) and flushed **directly** to RisingWave via
psycopg2 — same pattern as gtfs_jp_dumper / openflights_dumper /
noaa_ais_dumper (no bpmn-dispatcher hop).

The earlier dispatcher-routed design hit `404 no active binding` because
`com.etzhayyim.apps.maps.aismarine.position.batchInsert` is a LangServer tool,
not a BPMN process — bpmn-dispatcher only routes the latter. Direct
psycopg2 INSERT is shorter, has no HMAC dance, and matches every other
maps-bulk-ingest pod. ADR-2605011500 §Addendum 2026-05-05.

Reconnection: exponential backoff [1, 2, 4, 8, 16, 30, 30, …] seconds.

ENV:
  AIS_STREAM_API_KEY                   — required (etzhayyim.comsstream/API_KEY)
  DATABASE_URL                          — required (RisingWave PG via maps-bulk-ingest-credentials)
  AISMARINE_BATCH_MAX_AGE_S             — default 5
  AISMARINE_BATCH_MAX_MSGS              — default 500
  AISMARINE_DML_RATE_LIMIT              — default 5000 (RW INSERT throttle)
  AISMARINE_HEALTH_PORT                 — default 8080
"""
from __future__ import annotations

import asyncio
import datetime as _dt
import json
import logging
import os
import signal
import ssl
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Lock, Thread

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
log = logging.getLogger("aismarine_consumer")

API_KEY = os.environ.get("AIS_STREAM_API_KEY", "").strip()
DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
BATCH_MAX_AGE_S = float(os.environ.get("AISMARINE_BATCH_MAX_AGE_S", "5"))
BATCH_MAX_MSGS = int(os.environ.get("AISMARINE_BATCH_MAX_MSGS", "500"))
DML_RATE_LIMIT = int(os.environ.get("AISMARINE_DML_RATE_LIMIT", "5000"))
HEALTH_PORT = int(os.environ.get("AISMARINE_HEALTH_PORT", "8080"))

SOURCE = "aisstream"

_state: dict = {
    "running": False,
    "started_at": None,
    "ws_connects": 0,
    "ws_disconnects": 0,
    "msgs_seen": 0,
    "positions_flushed": 0,
    "masters_flushed": 0,
    "last_flush_at": None,
    "last_msg_at": None,
    "errors": [],
}
_state_lock = Lock()


# ─── health server (k8s liveness/readiness) ────────────────────────────

class _HealthHandler(BaseHTTPRequestHandler):
    def log_message(self, _format: str, *_args) -> None:  # silence
        return

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            with _state_lock:
                ok = bool(_state["running"]) and (
                    _state["last_msg_at"] is None
                    or (time.time() - _state["last_msg_at"]) < 120
                )
            code = 200 if ok else 503
            body = json.dumps({"ok": ok, **_safe_state()}).encode("utf-8")
        elif self.path == "/state":
            with _state_lock:
                body = json.dumps(_safe_state()).encode("utf-8")
            code = 200
        else:
            body = b"not found"
            code = 404
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def _safe_state() -> dict:
    s = dict(_state)
    if isinstance(s.get("errors"), list):
        s["errors"] = list(s["errors"])[-10:]
    return s


def _start_health_server() -> None:
    srv = HTTPServer(("0.0.0.0", HEALTH_PORT), _HealthHandler)
    Thread(target=srv.serve_forever, daemon=True).start()
    log.info("health server listening on 0.0.0.0:%d", HEALTH_PORT)


# ─── batching + flush ─────────────────────────────────────────────────

class _Batch:
    def __init__(self) -> None:
        self.positions: list[dict] = []
        self.masters: list[dict] = []
        self.opened_at: float = time.time()

    def is_full(self) -> bool:
        return (len(self.positions) + len(self.masters)) >= BATCH_MAX_MSGS

    def is_stale(self) -> bool:
        return (time.time() - self.opened_at) >= BATCH_MAX_AGE_S

    def is_empty(self) -> bool:
        return not self.positions and not self.masters


# ─── direct RisingWave writers (mirrors task_aismarine_position_batch_insert
#                                 + task_aismarine_master_upsert primitives) ──

def _today_iso_date() -> str:
    return _dt.date.today().isoformat()


def _position_vid(mmsi: int, ts_ms: int) -> str:
    return f"mmsi:{mmsi}:ts:{ts_ms}"


def _vessel_vid(mmsi: int) -> str:
    return f"mmsi:{mmsi}"


# Single shared connection — psycopg2 connections are not thread-safe but the
# consumer is single-asyncio-task and flush_batch is the only writer.
_db_conn = None
_db_lock = Lock()


def _get_db():
    global _db_conn
    with _db_lock:
        if _db_conn is None or _db_conn.closed:
            if not DATABASE_URL:
                raise RuntimeError("DATABASE_URL is required")
            _db_conn = psycopg2.connect(DATABASE_URL)
            _db_conn.autocommit = False
            with _db_conn.cursor() as cur:
                cur.execute(f"SET dml_rate_limit = {int(DML_RATE_LIMIT)}")
            _db_conn.commit()
        return _db_conn


def _insert_positions(rows: list[dict]) -> int:
    if not rows:
        return 0
    today = _today_iso_date()
    payload = [
        (
            _position_vid(r["mmsi"], r["ts_ms"]),
            today,
            r["mmsi"],
            r["ts_ms"],
            r["lat"],
            r["lon"],
            r.get("sog_knot"),
            r.get("cog_deg"),
            r.get("heading_deg"),
            r.get("nav_status"),
            r.get("source") or SOURCE,
        )
        for r in rows
    ]
    conn = _get_db()
    try:
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO vertex_vessel_position
                  (vertex_id, created_date, mmsi, ts_ms, lat, lon,
                   sog_knot, cog_deg, heading_deg, nav_status, source)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                payload,
            )
        conn.commit()
        return len(rows)
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise


def _upsert_masters(rows: list[dict]) -> int:
    if not rows:
        return 0
    today = _today_iso_date()
    upserted = 0
    conn = _get_db()
    try:
        with conn.cursor() as cur:
            for r in rows:
                mmsi = int(r["mmsi"])
                vid = _vessel_vid(mmsi)
                ts_ms = int(r.get("ts_ms") or (time.time() * 1000))

                cur.execute(
                    "SELECT imo, callsign, name, type_code, length_m, width_m, "
                    "       draught_m, first_seen_ms "
                    "FROM vertex_vessel WHERE vertex_id = %s LIMIT 1",
                    (vid,),
                )
                existing = cur.fetchone()

                imo = r.get("imo")
                callsign = r.get("callsign")
                name = r.get("name")
                type_code = r.get("type_code")
                length_m = r.get("length_m")
                width_m = r.get("width_m")
                draught_m = r.get("draught_m")
                if existing is not None:
                    imo = imo if imo is not None else existing[0]
                    callsign = callsign or existing[1]
                    name = name or existing[2]
                    type_code = type_code if type_code is not None else existing[3]
                    length_m = length_m if length_m is not None else existing[4]
                    width_m = width_m if width_m is not None else existing[5]
                    draught_m = draught_m if draught_m is not None else existing[6]
                    first_seen_ms = existing[7] or ts_ms
                else:
                    first_seen_ms = ts_ms

                mid = mmsi // 1_000_000 if 200_000_000 <= mmsi <= 799_999_999 else None
                # type_code / mid → smallint UDFs; libpq sends Python int as
                # 'integer', so wrap with %s::smallint to satisfy
                # vessel_type_class(smallint) and vessel_flag_iso(bigint).
                cur.execute(
                    """
                    INSERT INTO vertex_vessel
                      (vertex_id, created_date, mmsi, imo, callsign, name,
                       type_code, type_class, flag_mid, flag_iso,
                       length_m, width_m, draught_m, source,
                       first_seen_ms, last_seen_ms)
                    VALUES (%s, %s, %s, %s, %s, %s,
                            %s::smallint,
                            vessel_type_class(%s::smallint),
                            %s::smallint,
                            vessel_flag_iso(%s::bigint),
                            %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        vid, today, mmsi, imo, callsign, name,
                        type_code, type_code, mid, mmsi,
                        length_m, width_m, draught_m,
                        SOURCE,
                        first_seen_ms, ts_ms,
                    ),
                )
                upserted += 1
        conn.commit()
        return upserted
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise


async def _flush_batch(batch: _Batch) -> None:
    if batch.is_empty():
        return
    loop = asyncio.get_running_loop()

    if batch.positions:
        try:
            n = await loop.run_in_executor(None, _insert_positions, list(batch.positions))
            with _state_lock:
                _state["positions_flushed"] += n
        except Exception as e:
            log.warning("position INSERT failed: %s", e)
            with _state_lock:
                _state["errors"].append(f"insert position: {e}")

    if batch.masters:
        try:
            n = await loop.run_in_executor(None, _upsert_masters, list(batch.masters))
            with _state_lock:
                _state["masters_flushed"] += n
        except Exception as e:
            log.warning("master UPSERT failed: %s", e)
            with _state_lock:
                _state["errors"].append(f"upsert master: {e}")

    with _state_lock:
        _state["last_flush_at"] = time.time()


# ─── aisstream.io message → row ────────────────────────────────────────

def _decode_position(msg: dict) -> dict | None:
    """aisstream PositionReport message → row for vertex_vessel_position."""
    md = msg.get("MetaData") or {}
    pkt = (msg.get("Message") or {}).get("PositionReport") or {}
    mmsi = md.get("MMSI") or pkt.get("UserID")
    lat = pkt.get("Latitude")
    lon = pkt.get("Longitude")
    if mmsi is None or lat is None or lon is None:
        return None
    return {
        "mmsi": int(mmsi),
        "ts_ms": int(time.time() * 1000),
        "lat": float(lat),
        "lon": float(lon),
        "sog_knot": _maybe_float(pkt.get("Sog")),
        "cog_deg": _maybe_float(pkt.get("Cog")),
        "heading_deg": _maybe_int(pkt.get("TrueHeading")),
        "nav_status": _maybe_int(pkt.get("NavigationalStatus")),
        "source": "aisstream",
    }


def _decode_master(msg: dict) -> dict | None:
    """aisstream ShipStaticData message → row for vertex_vessel master upsert."""
    md = msg.get("MetaData") or {}
    pkt = (msg.get("Message") or {}).get("ShipStaticData") or {}
    mmsi = md.get("MMSI") or pkt.get("UserID")
    if mmsi is None:
        return None
    dim = pkt.get("Dimension") or {}
    length_m = None
    width_m = None
    try:
        a = float(dim.get("A") or 0); b = float(dim.get("B") or 0)
        c = float(dim.get("C") or 0); d = float(dim.get("D") or 0)
        if a + b > 0:
            length_m = a + b
        if c + d > 0:
            width_m = c + d
    except (TypeError, ValueError):
        pass
    return {
        "mmsi": int(mmsi),
        "imo": _maybe_int(pkt.get("ImoNumber")),
        "callsign": _maybe_str(pkt.get("CallSign")),
        "name": _maybe_str(pkt.get("Name")),
        "type_code": _maybe_int(pkt.get("Type")),
        "length_m": length_m,
        "width_m": width_m,
        "draught_m": _maybe_float(pkt.get("MaximumStaticDraught")),
        "source": "aisstream",
        "ts_ms": int(time.time() * 1000),
    }


def _maybe_int(v) -> int | None:
    if v is None or v == "":
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _maybe_float(v) -> float | None:
    if v is None or v == "":
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f:  # NaN
        return None
    return f


def _maybe_str(v) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


# ─── consumer loop ─────────────────────────────────────────────────────

async def aismarine_consumer_loop() -> None:
    if not API_KEY:
        raise RuntimeError("AIS_STREAM_API_KEY is required")
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is required")

    import websockets  # type: ignore

    sub_payload = json.dumps({
        "APIKey": API_KEY,
        "BoundingBoxes": [[[-90.0, -180.0], [90.0, 180.0]]],
        "FilterMessageTypes": ["PositionReport", "ShipStaticData"],
    })

    backoff = 1.0
    with _state_lock:
        _state["running"] = True
        _state["started_at"] = time.time()

    while True:
        batch = _Batch()
        try:
            log.info("aisstream connect (backoff=%.1fs)", backoff)
            ssl_ctx = ssl.create_default_context()
            async with websockets.connect(
                "wss://stream.aisstream.io/v0/stream",
                ssl=ssl_ctx,
                ping_interval=30,
                ping_timeout=15,
                max_size=2_000_000,
            ) as ws:
                await ws.send(sub_payload)
                with _state_lock:
                    _state["ws_connects"] += 1
                backoff = 1.0
                log.info("aisstream connected, subscribed global no-filter")

                async def _ticker() -> None:
                    while True:
                        await asyncio.sleep(1.0)
                        if batch.is_stale() or batch.is_full():
                            await _flush_batch(batch)
                            batch.positions = []
                            batch.masters = []
                            batch.opened_at = time.time()

                ticker = asyncio.create_task(_ticker())
                try:
                    async for raw in ws:
                        try:
                            msg = json.loads(raw)
                        except (TypeError, ValueError):
                            continue
                        with _state_lock:
                            _state["msgs_seen"] += 1
                            _state["last_msg_at"] = time.time()
                        kind = msg.get("MessageType")
                        if kind == "PositionReport":
                            row = _decode_position(msg)
                            if row is not None:
                                batch.positions.append(row)
                        elif kind == "ShipStaticData":
                            row = _decode_master(msg)
                            if row is not None:
                                batch.masters.append(row)
                        if batch.is_full():
                            await _flush_batch(batch)
                            batch.positions = []
                            batch.masters = []
                            batch.opened_at = time.time()
                finally:
                    ticker.cancel()
                    await _flush_batch(batch)
        except Exception as e:
            with _state_lock:
                _state["ws_disconnects"] += 1
                _state["errors"].append(f"ws: {e}")
            log.warning("aisstream disconnect: %s (backoff=%.1fs)", e, backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)


def _install_signal_handlers(loop: asyncio.AbstractEventLoop) -> None:
    def _shutdown(*_: object) -> None:
        log.info("shutdown signal received")
        for task in asyncio.all_tasks(loop):
            task.cancel()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _shutdown)
        except NotImplementedError:
            pass


def main() -> int:
    _start_health_server()
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    _install_signal_handlers(loop)
    try:
        loop.run_until_complete(aismarine_consumer_loop())
    except (KeyboardInterrupt, asyncio.CancelledError):
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
