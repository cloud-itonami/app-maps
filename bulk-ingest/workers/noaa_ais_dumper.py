#!/usr/bin/env python3
"""NOAA MarineCadastre AIS bulk dumper — Phase 1.1 no-API-key path
(ADR-2605011500 §Addendum 2026-05-05).

Daily one-shot CronJob. No long-running process, no aisstream API key:

  1. Find the most-recent NOAA daily zip (default: scan T-2 .. T-16).
  2. Stream-extract the CSV (5-10 GB unzipped, never materialized fully).
  3. Decimate per MMSI to 1 row per SAMPLE_INTERVAL_S (default 600s = 10min).
  4. Bulk INSERT into vertex_vessel_position + vertex_vessel via psycopg2.

The decimation collapses NOAA's 1-min/5-min broadcast cadence into a
scope manageable for a Phase 1.1 demo (~600K-1M positions/day kept,
down from ~30-50M raw).

Source: https://coast.noaa.gov/htdata/CMSP/AISDataHandler/{year}/AIS_{year}_{mm}_{dd}.zip
License: NOAA U.S. Government work, public domain.
Coverage: U.S. coastal + EEZ (Atlantic / Pacific / Great Lakes / HI / AK / Guam).

ENV:
  DATABASE_URL                 — required, RisingWave Postgres URL
  TARGET_DATE                  — optional YYYY-MM-DD; auto if empty
  SAMPLE_INTERVAL_S            — default 600 (10 min decimation)
  BATCH_SIZE                   — default 5000 (rows per executemany)
  DML_RATE_LIMIT               — default 5000 (RW INSERT throttle)
  MAX_LOOKBACK_DAYS            — default 16 (HEAD scan window)
  HTTP_TIMEOUT_S               — default 600
  TMP_DIR                      — default /tmp
  DRY_RUN                      — '1' = parse + count only, no DB write
"""
from __future__ import annotations

import csv
import datetime as _dt
import io
import json
import logging
import os
import sys
import time
import urllib.request
import urllib.error
import zipfile
from typing import Any, Iterator

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
log = logging.getLogger("noaa_ais_dumper")

NOAA_BASE = "https://coast.noaa.gov/htdata/CMSP/AISDataHandler"
DATABASE_URL = os.environ.get("DATABASE_URL")
TARGET_DATE = os.environ.get("TARGET_DATE", "").strip()
SAMPLE_INTERVAL_S = int(os.environ.get("SAMPLE_INTERVAL_S", "600"))
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "5000"))
DML_RATE_LIMIT = int(os.environ.get("DML_RATE_LIMIT", "5000"))
MAX_LOOKBACK_DAYS = int(os.environ.get("MAX_LOOKBACK_DAYS", "16"))
HTTP_TIMEOUT_S = int(os.environ.get("HTTP_TIMEOUT_S", "600"))
TMP_DIR = os.environ.get("TMP_DIR", "/tmp")
DRY_RUN = os.environ.get("DRY_RUN", "0") == "1"

SOURCE = "noaa-marinecadastre"


# ─── helpers ──────────────────────────────────────────────────────────

def _maybe_int(v: Any) -> int | None:
    if v is None or v == "":
        return None
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def _maybe_float(v: Any) -> float | None:
    if v is None or v == "":
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f:  # NaN
        return None
    return f


def _maybe_str(v: Any) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _today() -> _dt.date:
    return _dt.datetime.now(tz=_dt.timezone.utc).date()


def _zip_url(d: _dt.date) -> str:
    return f"{NOAA_BASE}/{d.year}/AIS_{d.year}_{d.month:02d}_{d.day:02d}.zip"


def _http_head_ok(url: str, timeout: int = 15) -> bool:
    req = urllib.request.Request(url, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return 200 <= r.status < 300
    except urllib.error.HTTPError as e:
        return False
    except Exception as e:
        log.debug("HEAD %s exception: %s", url, e)
        return False


def find_published_date() -> _dt.date:
    """If TARGET_DATE env set, parse it; else scan T-2 .. T-(MAX_LOOKBACK)."""
    if TARGET_DATE:
        try:
            return _dt.date.fromisoformat(TARGET_DATE)
        except ValueError as e:
            raise RuntimeError(f"TARGET_DATE invalid: {TARGET_DATE!r} ({e})")

    today = _today()
    for delta in range(2, MAX_LOOKBACK_DAYS + 1):
        d = today - _dt.timedelta(days=delta)
        url = _zip_url(d)
        if _http_head_ok(url):
            return d
    raise RuntimeError(
        f"No NOAA AIS file found in T-2..T-{MAX_LOOKBACK_DAYS} from {today}"
    )


def download_zip(d: _dt.date) -> str:
    url = _zip_url(d)
    dest = os.path.join(TMP_DIR, f"ais_{d.isoformat()}.zip")
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        log.info("zip already cached at %s (%.1f MB)", dest, os.path.getsize(dest) / 1e6)
        return dest
    log.info("downloading %s → %s", url, dest)
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(url, timeout=HTTP_TIMEOUT_S) as resp, open(dest, "wb") as out:
            chunk = 1024 * 1024
            total = 0
            while True:
                buf = resp.read(chunk)
                if not buf:
                    break
                out.write(buf)
                total += len(buf)
        elapsed = time.monotonic() - t0
        log.info("downloaded %.1f MB in %.1fs", total / 1e6, elapsed)
    except Exception:
        if os.path.exists(dest):
            os.remove(dest)
        raise
    return dest


def stream_csv_rows(zip_path: str) -> Iterator[dict[str, str]]:
    with zipfile.ZipFile(zip_path) as z:
        csvs = [n for n in z.namelist() if n.lower().endswith(".csv")]
        if not csvs:
            raise RuntimeError(f"no CSV in {zip_path}")
        if len(csvs) > 1:
            log.warning("multiple CSVs in zip, using first: %s (others: %s)", csvs[0], csvs[1:])
        with z.open(csvs[0]) as raw:
            tio = io.TextIOWrapper(raw, encoding="utf-8", errors="replace")
            reader = csv.DictReader(tio)
            for row in reader:
                yield row


# ─── row mappers ──────────────────────────────────────────────────────

# NOAA AIS post-2015 schema (column-name canonical):
#   MMSI, BaseDateTime, LAT, LON, SOG, COG, Heading, VesselName, IMO,
#   CallSign, VesselType, Status, Length, Width, Draft, Cargo, TransceiverClass

def _parse_ts_ms(s: str) -> int | None:
    if not s:
        return None
    try:
        # NOAA emits 'YYYY-MM-DDTHH:MM:SS' (no tz, all UTC by spec).
        dt = _dt.datetime.fromisoformat(s).replace(tzinfo=_dt.timezone.utc)
        return int(dt.timestamp() * 1000)
    except (TypeError, ValueError):
        return None


def to_position(r: dict[str, str]) -> dict | None:
    mmsi = _maybe_int(r.get("MMSI"))
    ts_ms = _parse_ts_ms(r.get("BaseDateTime", ""))
    lat = _maybe_float(r.get("LAT"))
    lon = _maybe_float(r.get("LON"))
    if mmsi is None or ts_ms is None or lat is None or lon is None:
        return None
    if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0):
        return None
    return {
        "mmsi": mmsi,
        "ts_ms": ts_ms,
        "lat": lat,
        "lon": lon,
        "sog_knot": _maybe_float(r.get("SOG")),
        "cog_deg": _maybe_float(r.get("COG")),
        "heading_deg": _maybe_int(r.get("Heading")),
        "nav_status": _maybe_int(r.get("Status")),
        "source": SOURCE,
    }


def to_master(r: dict[str, str], ts_ms: int) -> dict | None:
    mmsi = _maybe_int(r.get("MMSI"))
    if mmsi is None:
        return None
    name = _maybe_str(r.get("VesselName"))
    imo_raw = _maybe_str(r.get("IMO"))  # NOAA writes 'IMO0000000' for unknown
    imo = None
    if imo_raw and imo_raw.upper().startswith("IMO"):
        imo = _maybe_int(imo_raw[3:])
    elif imo_raw:
        imo = _maybe_int(imo_raw)
    return {
        "mmsi": mmsi,
        "imo": imo,
        "callsign": _maybe_str(r.get("CallSign")),
        "name": name,
        "type_code": _maybe_int(r.get("VesselType")),
        "length_m": _maybe_float(r.get("Length")),
        "width_m": _maybe_float(r.get("Width")),
        "draught_m": _maybe_float(r.get("Draft")),
        "ts_ms": ts_ms,
    }


# ─── DB writers (mirror task_aismarine_position_batch_insert + master_upsert) ──

def _today_iso_date() -> str:
    return _dt.date.today().isoformat()


def _position_vid(mmsi: int, ts_ms: int) -> str:
    return f"mmsi:{mmsi}:ts:{ts_ms}"


def _vessel_vid(mmsi: int) -> str:
    return f"mmsi:{mmsi}"


def insert_positions(cur, rows: list[dict]) -> int:
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
    cur.executemany(
        """
        INSERT INTO vertex_vessel_position
          (vertex_id, created_date, mmsi, ts_ms, lat, lon,
           sog_knot, cog_deg, heading_deg, nav_status, source)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        payload,
    )
    return len(rows)


def upsert_masters(cur, rows: list[dict]) -> int:
    if not rows:
        return 0
    today = _today_iso_date()
    upserted = 0
    for r in rows:
        mmsi = r["mmsi"]
        vid = _vessel_vid(mmsi)
        ts_ms = int(r["ts_ms"])

        cur.execute(
            "SELECT imo, callsign, name, type_code, length_m, width_m, draught_m, first_seen_ms "
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
        # libpq sends Python int as 'integer'; cast to satisfy UDF signatures.
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
    return upserted


# ─── main ─────────────────────────────────────────────────────────────

def main() -> int:
    if not DATABASE_URL and not DRY_RUN:
        log.error("DATABASE_URL is required (or set DRY_RUN=1)")
        return 2

    target = find_published_date()
    log.info("target date: %s", target.isoformat())

    zip_path = download_zip(target)

    bucket_seen: set[tuple[int, int]] = set()
    masters: dict[int, dict] = {}
    pos_batch: list[dict] = []

    total_rows = 0
    total_invalid = 0
    total_kept = 0
    total_pos_inserted = 0
    total_masters_upserted = 0

    conn = None if DRY_RUN else psycopg2.connect(DATABASE_URL)
    cur = None if conn is None else conn.cursor()
    if cur is not None:
        cur.execute(f"SET dml_rate_limit = {int(DML_RATE_LIMIT)}")

    try:
        for raw_row in stream_csv_rows(zip_path):
            total_rows += 1
            pos = to_position(raw_row)
            if pos is None:
                total_invalid += 1
                continue

            bucket = pos["ts_ms"] // (SAMPLE_INTERVAL_S * 1000)
            key = (pos["mmsi"], bucket)
            if key in bucket_seen:
                continue
            bucket_seen.add(key)
            total_kept += 1
            pos_batch.append(pos)

            if pos["mmsi"] not in masters:
                m = to_master(raw_row, pos["ts_ms"])
                if m is not None:
                    masters[m["mmsi"]] = m

            if len(pos_batch) >= BATCH_SIZE and cur is not None:
                total_pos_inserted += insert_positions(cur, pos_batch)
                conn.commit()  # type: ignore[union-attr]
                pos_batch = []

        if pos_batch and cur is not None:
            total_pos_inserted += insert_positions(cur, pos_batch)
            conn.commit()  # type: ignore[union-attr]

        if cur is not None:
            log.info("upserting %d vessel master rows", len(masters))
            total_masters_upserted = upsert_masters(cur, list(masters.values()))
            conn.commit()  # type: ignore[union-attr]

    finally:
        if cur is not None:
            cur.close()
        if conn is not None:
            conn.close()

    summary = {
        "ok": True,
        "target_date": target.isoformat(),
        "source": SOURCE,
        "total_rows_seen": total_rows,
        "total_rows_invalid": total_invalid,
        "total_rows_kept_after_decimate": total_kept,
        "decimate_interval_s": SAMPLE_INTERVAL_S,
        "positions_inserted": total_pos_inserted,
        "masters_upserted": total_masters_upserted,
        "unique_mmsi": len(masters),
        "dry_run": DRY_RUN,
    }
    log.info("done: %s", json.dumps(summary, ensure_ascii=False))
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
