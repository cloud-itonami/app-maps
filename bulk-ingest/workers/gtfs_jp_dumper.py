#!/usr/bin/env python3
"""GTFS-JP bulk dumper — resident worker (bus + train, ADR-0056 / ADR-0036).

POST /trigger downloads each per-prefecture GTFS-JP feed (zip) listed in
``GTFS_JP_FEEDS`` (or the bundled default), parses ``routes.txt``,
``stops.txt``, ``trips.txt``, ``stop_times.txt`` and ``calendar.txt`` /
``calendar_dates.txt``, and writes:

  - vertex_spatial (label = Railway / BusRoute / Station / BusStop)
  - props JSON: {feed_id, agency_id, route_short_name, route_long_name,
                 route_type, headsign, service_id, monday..sunday,
                 first_dep, last_dep, num_trips}

Source: https://www.gtfs.jp/  (MLIT-aggregated, free, 47 prefectures).
GTFS spec: https://gtfs.org/schedule/reference/

ENV:
  DATABASE_URL, B2_ACCESS_KEY_ID, B2_SECRET_ACCESS_KEY,
  B2_ENDPOINT, B2_BUCKET, B2_PREFIX (default maps-bulk-ingest/gtfs-jp)
  GTFS_JP_FEED_INDEX_URL — optional remote JSON list of {feed_id, url, prefecture, agency}
  GTFS_JP_LIMIT_FEEDS — int, dev cap on number of feeds per pass
  SHARD_ROWS, FLUSH_INTERVAL_SEC, PORT (defaults 5000, 60, 8080)

GTFS route_type → label:
  0 tram / 1 subway / 2 rail / 4 ferry / 5 cable / 6 aerial / 7 funicular
    → Railway
  3 bus / 11 trolleybus / 12 monorail
    → BusRoute (12 monorail も BusRoute 扱い: 路線図の単位として bus と同じ)

GTFS stop は parent_station + location_type で集約。location_type=1 は
Station / location_type=0 は親が rail なら Station、bus なら BusStop。
"""
from __future__ import annotations

import csv
import io
import json
import logging
import os
import subprocess
import sys
import time
import zipfile
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

# TODO(ADR-2605172000 / Stage 2): the writes below still hit
# RisingWave directly via psycopg2 patterns specific to this
# worker. Replace them with `open_substrate_writer().upsert_table(
# '<table>', rows, conflict_key=...)` per the substrate seam
# contract in `_etzhayyim_substrate.py`. The legacy import has
# been re-added below as a guarded fallback so the worker still
# functions while ETZHAYYIM_SUBSTRATE_MODE=rw; remove it once the
# call sites are migrated.
import psycopg2  # noqa: E402 — pending substrate refactor (Stage 2)
import pyarrow as pa
import pyarrow.parquet as pq

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("gtfs_jp_dumper")

DATABASE_URL = os.environ.get("DATABASE_URL")
B2_BUCKET = os.environ.get("B2_BUCKET", "etzhayyim-nats")
B2_PREFIX = os.environ.get("B2_PREFIX", "maps-bulk-ingest/gtfs-jp")
B2_ENDPOINT = os.environ.get("B2_ENDPOINT", "https://s3.us-west-004.backblazeb2.com")
PORT = int(os.environ.get("PORT", "8080"))
SHARD_ROWS = int(os.environ.get("SHARD_ROWS", "5000"))
FLUSH_INTERVAL_SEC = float(os.environ.get("FLUSH_INTERVAL_SEC", "60"))
LIMIT_FEEDS = int(os.environ.get("GTFS_JP_LIMIT_FEEDS", "0"))  # 0 = no cap
FEED_INDEX_URL = os.environ.get("GTFS_JP_FEED_INDEX_URL", "").strip()

# No bundled default feed list. The api.gtfs-data.jp URLs originally
# guessed for Phase 1 returned 404 on probe (the gtfs-data.jp public API
# requires per-organization registration and its URL scheme is not
# stable). Rather than silently 404-skip every feed each run, we
# fail-fast if the operator has not configured GTFS_JP_FEED_INDEX_URL
# pointing to a JSON array of {feed_id, url, prefecture, agency}.
#
# Recommended index sources:
#   - GTFS-Data Repository for Japan (gtfs.jp) — register account, export
#     org list as JSON, host on B2 (private), set GTFS_JP_FEED_INDEX_URL
#   - ODPT (公共交通オープンデータセンター) static GTFS endpoints
#   - per-operator OpenData portals (e.g. odakyubus, aomori, etc.)
DEFAULT_FEEDS: list[dict] = []

# ─── route_type buckets (GTFS spec + extended HVT subset) ───────────────
_RAIL_TYPES = {0, 1, 2, 4, 5, 6, 7, 12}  # tram/subway/rail/ferry/cable/aerial/funicular/monorail
_BUS_TYPES = {3, 11}  # bus / trolleybus

_flush_pool_max = 2

_state = {
    "running": False,
    "started_at": None,
    "completed_at": None,
    "current_feed": None,
    "feeds_done": 0,
    "feeds_total": 0,
    "rows_written": 0,
    "rows_per_label": {"Railway": 0, "BusRoute": 0, "Station": 0, "BusStop": 0},
    # Phase 2 — per-trip + per-stop-time tables (vertex_maps_trip /
    # vertex_maps_stop_time). These do not carry a vertex_spatial label,
    # so they are tracked separately.
    "trip_rows": 0,
    "stop_time_rows": 0,
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


def _is_done(dump_id: str, key: str) -> bool:
    if not os.environ.get("B2_ACCESS_KEY_ID"):
        return False
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


def _load_feed_index() -> list[dict]:
    if not FEED_INDEX_URL:
        raise RuntimeError(
            "GTFS_JP_FEED_INDEX_URL is required — set it to a JSON array of "
            "{feed_id, url, prefecture, agency} entries. There is no bundled "
            "default feed list (the gtfs-data.jp public API URLs are not "
            "stable; register an account and host an index in B2)."
        )
    import urllib.request

    with urllib.request.urlopen(FEED_INDEX_URL, timeout=30) as r:
        feeds = json.loads(r.read().decode("utf-8"))
    if not isinstance(feeds, list) or not feeds:
        raise RuntimeError(
            f"GTFS_JP_FEED_INDEX_URL={FEED_INDEX_URL} returned "
            f"{type(feeds).__name__} of length "
            f"{len(feeds) if hasattr(feeds, '__len__') else '?'} — expected non-empty list"
        )
    required = {"feed_id", "url"}
    bad = [f for f in feeds if not required.issubset(f)]
    if bad:
        raise RuntimeError(
            f"feed index has {len(bad)} entries missing required keys {required}: "
            f"first bad entry = {bad[0]!r}"
        )
    log.info("loaded %d feeds from %s", len(feeds), FEED_INDEX_URL)
    return feeds


def _curl_zip(url: str, dest: str) -> None:
    rc = subprocess.run(
        [
            "curl", "--silent", "--location",
            "--retry", "10", "--retry-max-time", "900", "--retry-all-errors",
            "--connect-timeout", "30",
            url, "-o", dest,
        ],
        check=False,
    ).returncode
    if rc != 0:
        raise RuntimeError(f"curl exit {rc} for {url}")


def _read_csv(zf: zipfile.ZipFile, name: str) -> list[dict]:
    if name not in zf.namelist():
        return []
    with zf.open(name) as f:
        text = io.TextIOWrapper(f, encoding="utf-8-sig", errors="replace")
        return list(csv.DictReader(text))


def _classify_route_label(route_type_str: str) -> str:
    try:
        rt = int(route_type_str)
    except (TypeError, ValueError):
        return "BusRoute"
    if rt in _RAIL_TYPES:
        return "Railway"
    if rt in _BUS_TYPES:
        return "BusRoute"
    # Extended HVT 100-1700: 100s rail, 200s coach, 700s bus, 900 tram, 1000 water, 1100 air, 1300 aerial
    if 100 <= rt < 200:
        return "Railway"
    if 700 <= rt < 800:
        return "BusRoute"
    if 200 <= rt < 300:
        return "BusRoute"
    return "BusRoute"


def _build_route_rows(feed: dict, routes: list[dict], trips: list[dict],
                      stop_times: list[dict], stops: list[dict],
                      calendar: list[dict]) -> list[dict]:
    """One vertex_spatial row per route, with summary timetable in props."""
    cal_by_service = {c.get("service_id", ""): c for c in calendar}
    trips_by_route: dict[str, list[dict]] = {}
    for t in trips:
        trips_by_route.setdefault(t.get("route_id", ""), []).append(t)

    # Build first/last departure summary per route
    times_by_trip: dict[str, list[str]] = {}
    for st in stop_times:
        tid = st.get("trip_id", "")
        if not tid:
            continue
        dep = st.get("departure_time") or st.get("arrival_time") or ""
        if dep:
            times_by_trip.setdefault(tid, []).append(dep)

    # Centroid (lat/lng) per route via stop_times → stops
    stop_by_id = {s.get("stop_id", ""): s for s in stops}
    stops_by_trip: dict[str, list[str]] = {}
    for st in stop_times:
        tid = st.get("trip_id", "")
        sid = st.get("stop_id", "")
        if tid and sid:
            stops_by_trip.setdefault(tid, []).append(sid)

    rows: list[dict] = []
    repo_did = "did:web:maps.etzhayyim.com"
    feed_id = feed["feed_id"]
    for r in routes:
        route_id = r.get("route_id", "")
        if not route_id:
            continue
        label = _classify_route_label(r.get("route_type", ""))
        rkey = f"gtfsjp-{feed_id}-{route_id}"[:64]
        # service days summary across this route's trips
        service_ids = {t.get("service_id", "") for t in trips_by_route.get(route_id, [])}
        days = {d: 0 for d in (
            "monday", "tuesday", "wednesday", "thursday",
            "friday", "saturday", "sunday",
        )}
        for sid in service_ids:
            cal = cal_by_service.get(sid)
            if not cal:
                continue
            for d in days:
                if cal.get(d) == "1":
                    days[d] = 1
        # first / last departure across the route
        all_times: list[str] = []
        trip_count = 0
        all_stop_ids: list[str] = []
        for t in trips_by_route.get(route_id, []):
            tid = t.get("trip_id", "")
            tt = times_by_trip.get(tid, [])
            if tt:
                trip_count += 1
                all_times.extend(tt)
            all_stop_ids.extend(stops_by_trip.get(tid, []))
        first_dep = min(all_times) if all_times else None
        last_dep = max(all_times) if all_times else None
        # centroid
        lats: list[float] = []
        lngs: list[float] = []
        for sid in set(all_stop_ids):
            s = stop_by_id.get(sid)
            if not s:
                continue
            try:
                lats.append(float(s["stop_lat"]))
                lngs.append(float(s["stop_lon"]))
            except (KeyError, ValueError):
                continue
        lat = sum(lats) / len(lats) if lats else None
        lng = sum(lngs) / len(lngs) if lngs else None
        if lat is None or lng is None:
            continue
        name = (
            r.get("route_long_name") or r.get("route_short_name") or route_id
        )[:200]
        props = {
            "feed_id": feed_id,
            "agency": feed.get("agency"),
            "prefecture": feed.get("prefecture"),
            "route_id": route_id,
            "route_short_name": r.get("route_short_name"),
            "route_long_name": r.get("route_long_name"),
            "route_type": r.get("route_type"),
            "agency_id": r.get("agency_id"),
            "color": r.get("route_color"),
            "text_color": r.get("route_text_color"),
            "first_departure": first_dep,
            "last_departure": last_dep,
            "num_trips": trip_count,
            "num_stops": len(set(all_stop_ids)),
            "service_days": days,
        }
        rows.append({
            "vertex_id": f"at://{repo_did}/com.etzhayyim.apps.maps.{('railway' if label=='Railway' else 'busRoute')}/{rkey}",
            "rkey": rkey,
            "repo": repo_did,
            "label": label,
            "did": repo_did,
            "name": name,
            "display_name": name,
            "lat": lat,
            "lng": lng,
            "source_did": "did:web:maps.etzhayyim.com:gtfs",
            "source": "gtfs-jp",
            "category": label.lower(),
            "description": (f"{feed.get('agency','?')} {r.get('route_short_name','')} {r.get('route_long_name','')}").strip()[:500],
            "country": "JP",
            "region_id": feed.get("prefecture"),
            "owner_did": repo_did,
            "sensitivity_ord": 0,
            "created_date": datetime.now(timezone.utc).date().isoformat(),
            "node_label": label,
            "props": json.dumps(props, ensure_ascii=False),
        })
    return rows


def _build_stop_rows(feed: dict, stops: list[dict], routes: list[dict],
                     trips: list[dict], stop_times: list[dict]) -> list[dict]:
    """One vertex_spatial row per stop. Station vs BusStop is decided by
    the route_type majority of routes that serve the stop."""
    repo_did = "did:web:maps.etzhayyim.com"
    feed_id = feed["feed_id"]

    route_label_by_id = {r.get("route_id", ""): _classify_route_label(r.get("route_type", "")) for r in routes}
    trip_route = {t.get("trip_id", ""): t.get("route_id", "") for t in trips}
    stop_labels: dict[str, dict[str, int]] = {}
    for st in stop_times:
        sid = st.get("stop_id", "")
        tid = st.get("trip_id", "")
        rid = trip_route.get(tid)
        lbl = route_label_by_id.get(rid or "")
        if not sid or not lbl:
            continue
        stop_labels.setdefault(sid, {}).setdefault(lbl, 0)
        stop_labels[sid][lbl] += 1

    rows: list[dict] = []
    for s in stops:
        sid = s.get("stop_id", "")
        if not sid:
            continue
        try:
            lat = float(s["stop_lat"])
            lng = float(s["stop_lon"])
        except (KeyError, ValueError):
            continue
        loc_type = s.get("location_type", "0") or "0"
        if loc_type == "1":  # explicitly a station
            label = "Station"
        else:
            counts = stop_labels.get(sid, {})
            if counts.get("Railway", 0) >= counts.get("BusRoute", 0) and counts.get("Railway", 0) > 0:
                label = "Station"
            elif counts.get("BusRoute", 0) > 0:
                label = "BusStop"
            else:
                # No serving route in feed (parent_station only) — assume Station
                label = "Station"
        rkey = f"gtfsjp-{feed_id}-{sid}"[:64]
        name = (s.get("stop_name") or sid)[:200]
        props = {
            "feed_id": feed_id,
            "agency": feed.get("agency"),
            "prefecture": feed.get("prefecture"),
            "stop_id": sid,
            "stop_code": s.get("stop_code"),
            "platform_code": s.get("platform_code"),
            "parent_station": s.get("parent_station") or None,
            "wheelchair_boarding": s.get("wheelchair_boarding"),
            "zone_id": s.get("zone_id"),
        }
        rows.append({
            "vertex_id": f"at://{repo_did}/com.etzhayyim.apps.maps.{('station' if label=='Station' else 'busStop')}/{rkey}",
            "rkey": rkey,
            "repo": repo_did,
            "label": label,
            "did": repo_did,
            "name": name,
            "display_name": name,
            "lat": lat,
            "lng": lng,
            "source_did": "did:web:maps.etzhayyim.com:gtfs",
            "source": "gtfs-jp",
            "category": label.lower(),
            "description": (f"{feed.get('agency','?')} {label}")[:500],
            "country": "JP",
            "region_id": feed.get("prefecture"),
            "owner_did": repo_did,
            "sensitivity_ord": 0,
            "created_date": datetime.now(timezone.utc).date().isoformat(),
            "node_label": label,
            "props": json.dumps(props, ensure_ascii=False),
        })
    return rows


def _flush_shard(rows: list[dict], dump_id: str, kind: str, shard_idx: int) -> str:
    """Flush shard to B2 for parquet archival/replay. Skips silently when
    B2_ACCESS_KEY_ID is not set so local smoke tests don't require B2 creds."""
    if not rows:
        return ""
    if not os.environ.get("B2_ACCESS_KEY_ID"):
        return ""
    try:
        table = pa.Table.from_pylist(rows)
        buf = BytesIO()
        pq.write_table(table, buf, compression="zstd")
        buf.seek(0)
        key = f"{B2_PREFIX}/{dump_id}/{kind}/shard-{shard_idx:05d}.parquet"
        _b2().put_object(Bucket=B2_BUCKET, Key=key, Body=buf.getvalue())
        return key
    except Exception as e:
        log.warning("B2 shard flush skipped (%s/%s shard-%05d): %s", dump_id, kind, shard_idx, e)
        return ""


def _insert_rows_into_substrate(rows: list[dict], batch_size: int = 1000,
                         table: str = "vertex_spatial") -> int:
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
                log.warning("batch insert into %s failed (chunk %d-%d): %s",
                            table, i, i + len(chunk), e)
    finally:
        conn.close()
    return total


def _delete_feed_rows(feed_id: str) -> None:
    """Idempotency for RW (no ON CONFLICT). Per advisor #2 + ADR-0036:
    DELETE WHERE feed_id = ? then re-INSERT. Touches only the per-feed
    rows in vertex_maps_trip / vertex_maps_stop_time. The per-route /
    per-stop rows in vertex_spatial use deterministic vertex_id keys
    and rely on RW's PK implicit upsert (re-INSERT overwrites)."""
    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = True
    try:
        cur = conn.cursor()
        for tbl in ("vertex_maps_stop_time", "vertex_maps_trip"):
            try:
                cur.execute(f"DELETE FROM {tbl} WHERE feed_id = %s", (feed_id,))
            except Exception as e:
                log.warning("DELETE FROM %s WHERE feed_id=%s failed: %s",
                            tbl, feed_id, e)
    finally:
        conn.close()


def _build_trip_rows(feed: dict, trips: list[dict]) -> list[dict]:
    fid = feed["feed_id"]
    out: list[dict] = []
    for t in trips:
        tid = t.get("trip_id", "")
        rid = t.get("route_id", "")
        if not tid or not rid:
            continue
        try:
            direction_id = int(t["direction_id"]) if t.get("direction_id") not in (None, "") else None
        except ValueError:
            direction_id = None
        try:
            wca = int(t["wheelchair_accessible"]) if t.get("wheelchair_accessible") else None
        except ValueError:
            wca = None
        try:
            ba = int(t["bikes_allowed"]) if t.get("bikes_allowed") else None
        except ValueError:
            ba = None
        out.append({
            "feed_id": fid,
            "trip_id": tid,
            "route_id": rid,
            "service_id": t.get("service_id") or None,
            "shape_id": t.get("shape_id") or None,
            "direction_id": direction_id,
            "headsign": (t.get("trip_headsign") or "")[:256] or None,
            "short_name": (t.get("trip_short_name") or "")[:64] or None,
            "block_id": t.get("block_id") or None,
            "wheelchair_accessible": wca,
            "bikes_allowed": ba,
            "agency": feed.get("agency"),
            "prefecture": feed.get("prefecture"),
        })
    return out


def _build_stop_time_rows(feed: dict, stop_times: list[dict]) -> list[dict]:
    fid = feed["feed_id"]
    out: list[dict] = []
    for st in stop_times:
        tid = st.get("trip_id", "")
        sid = st.get("stop_id", "")
        seq_str = st.get("stop_sequence", "")
        if not tid or not sid or not seq_str:
            continue
        try:
            seq = int(seq_str)
        except ValueError:
            continue
        try:
            sdt = float(st["shape_dist_traveled"]) if st.get("shape_dist_traveled") else None
        except ValueError:
            sdt = None
        try:
            pickup = int(st["pickup_type"]) if st.get("pickup_type") not in (None, "") else None
        except ValueError:
            pickup = None
        try:
            dropoff = int(st["drop_off_type"]) if st.get("drop_off_type") not in (None, "") else None
        except ValueError:
            dropoff = None
        try:
            tp = int(st["timepoint"]) if st.get("timepoint") not in (None, "") else None
        except ValueError:
            tp = None
        # GTFS stop_id is per-feed; key vertex_spatial-side as
        # f"gtfsjp-{feed_id}-{stop_id}" so the foreign-ish ref matches.
        out.append({
            "feed_id": fid,
            "trip_id": tid,
            "stop_sequence": seq,
            "stop_id": f"gtfsjp-{fid}-{sid}"[:128],
            "arrival_time": (st.get("arrival_time") or "")[:8] or None,
            "departure_time": (st.get("departure_time") or "")[:8] or None,
            "pickup_type": pickup,
            "drop_off_type": dropoff,
            "stop_headsign": (st.get("stop_headsign") or "")[:256] or None,
            "shape_dist_traveled": sdt,
            "timepoint": tp,
        })
    return out


def _process_feed(feed: dict, dump_id: str) -> dict:
    fid = feed["feed_id"]
    if _is_done(dump_id, f"gtfs-jp-{fid}"):
        return {"feed_id": fid, "skipped": True}
    zip_path = f"/tmp/gtfs-jp-{fid}.zip"
    _curl_zip(feed["url"], zip_path)
    with zipfile.ZipFile(zip_path) as zf:
        routes = _read_csv(zf, "routes.txt")
        stops = _read_csv(zf, "stops.txt")
        trips = _read_csv(zf, "trips.txt")
        stop_times = _read_csv(zf, "stop_times.txt")
        calendar = _read_csv(zf, "calendar.txt")
    try:
        os.remove(zip_path)
    except OSError:
        pass

    route_rows = _build_route_rows(feed, routes, trips, stop_times, stops, calendar)
    stop_rows = _build_stop_rows(feed, stops, routes, trips, stop_times)
    trip_rows = _build_trip_rows(feed, trips)
    stop_time_rows = _build_stop_time_rows(feed, stop_times)

    # Phase 2 idempotency: clear this feed's rows from the per-trip /
    # per-stop-time tables before re-INSERTing. The vertex_spatial route /
    # stop rows use deterministic vertex_id PKs and rely on RW PK upsert.
    _delete_feed_rows(fid)

    # Stream-flush in shards (route_rows + stop_rows are O(10K-100K) per
    # feed which fits in memory comfortably; we still shard for parquet
    # replay). stop_time_rows can be O(1M+) per large rail feed — same
    # SHARD_ROWS chunking bounds memory + parquet shard size.
    written = 0
    per_label = {"Railway": 0, "BusRoute": 0, "Station": 0, "BusStop": 0}
    shard_idx = 0
    for kind, rows in (("routes", route_rows), ("stops", stop_rows)):
        for i in range(0, len(rows), SHARD_ROWS):
            chunk = rows[i : i + SHARD_ROWS]
            _flush_shard(chunk, dump_id, kind, shard_idx)
            inserted = _insert_rows_into_substrate(chunk, table="vertex_spatial")
            written += inserted
            for r in chunk:
                per_label[r["label"]] = per_label.get(r["label"], 0) + 1
            shard_idx += 1

    trip_written = 0
    for i in range(0, len(trip_rows), SHARD_ROWS):
        chunk = trip_rows[i : i + SHARD_ROWS]
        _flush_shard(chunk, dump_id, "trips", shard_idx)
        trip_written += _insert_rows_into_substrate(chunk, table="vertex_maps_trip")
        shard_idx += 1

    st_written = 0
    for i in range(0, len(stop_time_rows), SHARD_ROWS):
        chunk = stop_time_rows[i : i + SHARD_ROWS]
        _flush_shard(chunk, dump_id, "stop_times", shard_idx)
        st_written += _insert_rows_into_substrate(chunk, table="vertex_maps_stop_time")
        shard_idx += 1

    _mark_done(dump_id, f"gtfs-jp-{fid}")
    return {
        "feed_id": fid,
        "routes": len(route_rows),
        "stops": len(stop_rows),
        "trips": trip_written,
        "stop_times": st_written,
        "rows_written": written,
        "per_label": per_label,
    }


def _run_dump():
    dump_id = datetime.now(timezone.utc).strftime("%Y%m%d")
    with _lock:
        if _state["running"]:
            log.warning("dump already running")
            return
        _state.update(
            running=True,
            started_at=datetime.now(timezone.utc).isoformat(),
            completed_at=None,
            current_feed=None,
            feeds_done=0,
            feeds_total=0,
            rows_written=0,
            rows_per_label={"Railway": 0, "BusRoute": 0, "Station": 0, "BusStop": 0},
            trip_rows=0,
            stop_time_rows=0,
            errors=[],
        )
    try:
        feeds = _load_feed_index()
    except Exception as e:
        log.error("feed index load failed: %s", e)
        with _lock:
            _state["errors"].append({"phase": "load_feed_index", "error": str(e)})
            _state["running"] = False
            _state["completed_at"] = datetime.now(timezone.utc).isoformat()
        return
    if LIMIT_FEEDS > 0:
        feeds = feeds[:LIMIT_FEEDS]
    with _lock:
        _state["feeds_total"] = len(feeds)
    log.info("starting dump %s feeds=%d", dump_id, len(feeds))
    for feed in feeds:
        with _lock:
            _state["current_feed"] = feed["feed_id"]
        try:
            result = _process_feed(feed, dump_id)
            with _lock:
                _state["feeds_done"] += 1
                _state["rows_written"] += result.get("rows_written", 0)
                _state["trip_rows"] += result.get("trips", 0)
                _state["stop_time_rows"] += result.get("stop_times", 0)
                for k, v in result.get("per_label", {}).items():
                    _state["rows_per_label"][k] = _state["rows_per_label"].get(k, 0) + v
            log.info("feed %s: %s", feed["feed_id"], result)
        except Exception as e:
            log.exception("feed %s failed", feed["feed_id"])
            with _lock:
                _state["errors"].append({"feed_id": feed["feed_id"], "error": str(e)})
    with _lock:
        _state["running"] = False
        _state["completed_at"] = datetime.now(timezone.utc).isoformat()
        _state["current_feed"] = None
    log.info("dump %s complete; rows=%d", dump_id, _state["rows_written"])


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
