#!/usr/bin/env python3
"""GTFS-JP dry-run row counter (no DB writes, no B2, no auth).

Phase 2 closure tool. Answers "how many vertex_maps_stop_time rows will
this feed produce" before pointing the real dumper at it. Run locally
with one verified feed.zip URL; report numbers back so we can size
Phase 3 (RT) realistically.

Usage:
  python3 gtfs_jp_dryrun.py <feed_url> [--feed-id <id>]

Output (stdout JSON):
  {
    "feed_url": "...",
    "feed_id": "...",
    "files":     {"routes.txt": 12, "stops.txt": 234, ...},
    "projected_rows": {
      "vertex_spatial_route":     12,
      "vertex_spatial_stop":      234,
      "vertex_maps_trip":         876,
      "vertex_maps_stop_time":    18432
    },
    "samples": {
      "route":     {first row},
      "stop":      {first row},
      "trip":      {first row},
      "stop_time": {first row}
    }
  }

Exit code: 0 if zip parses cleanly, 1 otherwise. The tool deliberately
imports the same _build_* functions used by the production dumper so a
green dry-run also covers the parser logic.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import zipfile
from importlib import util as _imp


def _load_dumper_module():
    here = os.path.dirname(os.path.abspath(__file__))
    spec = _imp.spec_from_file_location("gtfs_jp_dumper", os.path.join(here, "gtfs_jp_dumper.py"))
    mod = _imp.module_from_spec(spec)
    # The dumper checks DATABASE_URL inside main(); module import alone
    # does not require it. We never call main() here.
    sys.modules["gtfs_jp_dumper"] = mod
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("feed_url")
    ap.add_argument("--feed-id", default="dryrun")
    ap.add_argument("--agency", default="dryrun-agency")
    ap.add_argument("--prefecture", default="dryrun-pref")
    args = ap.parse_args()

    zip_path = "/tmp/gtfs-dryrun.zip"
    rc = subprocess.run(
        [
            "curl", "--silent", "--show-error", "--location",
            "--retry", "5", "--retry-max-time", "300", "--retry-all-errors",
            "--connect-timeout", "30",
            args.feed_url, "-o", zip_path,
        ],
        check=False,
    ).returncode
    if rc != 0:
        print(json.dumps({"error": f"curl exit {rc}", "feed_url": args.feed_url}))
        return 1

    if not zipfile.is_zipfile(zip_path):
        head = open(zip_path, "rb").read(200)
        print(json.dumps({
            "error": "not a zip (likely 200 HTML 404-disguise)",
            "feed_url": args.feed_url,
            "head_bytes": head[:120].decode("utf-8", errors="replace"),
            "size": os.path.getsize(zip_path),
        }))
        return 1

    dumper = _load_dumper_module()
    files: dict[str, int] = {}
    with zipfile.ZipFile(zip_path) as zf:
        for name in zf.namelist():
            files[name] = sum(1 for _ in zf.open(name)) - 1  # -1 for header
        routes = dumper._read_csv(zf, "routes.txt")
        stops = dumper._read_csv(zf, "stops.txt")
        trips = dumper._read_csv(zf, "trips.txt")
        stop_times = dumper._read_csv(zf, "stop_times.txt")
        calendar = dumper._read_csv(zf, "calendar.txt")

    feed = {"feed_id": args.feed_id, "agency": args.agency, "prefecture": args.prefecture, "url": args.feed_url}
    route_rows = dumper._build_route_rows(feed, routes, trips, stop_times, stops, calendar)
    stop_rows = dumper._build_stop_rows(feed, stops, routes, trips, stop_times)
    trip_rows = dumper._build_trip_rows(feed, trips)
    stop_time_rows = dumper._build_stop_time_rows(feed, stop_times)

    report = {
        "feed_url": args.feed_url,
        "feed_id": args.feed_id,
        "files": files,
        "projected_rows": {
            "vertex_spatial_route": len(route_rows),
            "vertex_spatial_stop": len(stop_rows),
            "vertex_maps_trip": len(trip_rows),
            "vertex_maps_stop_time": len(stop_time_rows),
        },
        "samples": {
            "route": route_rows[0] if route_rows else None,
            "stop": stop_rows[0] if stop_rows else None,
            "trip": trip_rows[0] if trip_rows else None,
            "stop_time": stop_time_rows[0] if stop_time_rows else None,
        },
    }
    print(json.dumps(report, ensure_ascii=False, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
