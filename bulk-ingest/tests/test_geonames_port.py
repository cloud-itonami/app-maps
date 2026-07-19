"""Tests for the geonames_dumper.py kotodama.substrate port.

Verifies the pure converter (`_geonames_row_to_feature`) produces a record
shape that matches `com.etzhayyim.maps.feature` lexicon expectations. Does
not require network access; the substrate primitive itself is tested
separately in 40-engine/kotoba/crates/kotoba-kotodama/py/tests/test_substrate.py.

Run with: pytest 60-apps/etzhayyim-project-maps/bulk-ingest/tests/
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


# Bulk-ingest is not a Python package (just a container build context);
# add `workers/` to sys.path so we can import geonames_dumper as a module.
WORKERS_DIR = Path(__file__).resolve().parent.parent / "workers"
if str(WORKERS_DIR) not in sys.path:
    sys.path.insert(0, str(WORKERS_DIR))

# B2 envs are only consulted lazily inside _b2(); module import is safe
# without them. Set harmless defaults defensively.
os.environ.setdefault("B2_ACCESS_KEY_ID", "")
os.environ.setdefault("B2_SECRET_ACCESS_KEY", "")

import geonames_dumper  # noqa: E402


SAMPLE_ROW = {
    "vertex_id": "at://did:web:maps.etzhayyim.com/com.etzhayyim.apps.maps.spot/geonames-1850147",
    "rkey": "geonames-1850147",
    "repo": "did:web:maps.etzhayyim.com",
    "label": "Place",
    "did": "did:web:maps.etzhayyim.com",
    "collection": "com.etzhayyim.apps.maps.spot",
    "name": "Tokyo",
    "lat": 35.6895,
    "lng": 139.69171,
    "source_did": "did:web:maps.etzhayyim.com:registry:geonames:bulk",
    "category": "geonames-p",
    "description": "PPLC pop=8336599 cc=JP",
    "country": "JP",
    "owner_did": "did:web:maps.etzhayyim.com",
    "sensitivity_ord": 0,
    "created_date": "2026-05-23",
}


def test_converter_preserves_rkey():
    rkey, _ = geonames_dumper._geonames_row_to_feature(SAMPLE_ROW)
    assert rkey == "geonames-1850147"


def test_converter_label():
    _, record = geonames_dumper._geonames_row_to_feature(SAMPLE_ROW)
    assert record["label"] == "Place"
    assert record["name"] == "Tokyo"


def test_converter_geometry_is_geojson_string():
    _, record = geonames_dumper._geonames_row_to_feature(SAMPLE_ROW)
    geom = json.loads(record["geometryGeoJson"])
    assert geom["type"] == "Point"
    assert geom["coordinates"][0] == 139.69171  # lng first
    assert geom["coordinates"][1] == 35.6895  # lat second


def test_converter_bbox_microdegrees_integer():
    _, record = geonames_dumper._geonames_row_to_feature(SAMPLE_ROW)
    assert isinstance(record["bboxWestE7"], int)
    assert isinstance(record["bboxNorthE7"], int)
    # Point bbox: west == east, south == north
    assert record["bboxWestE7"] == record["bboxEastE7"]
    assert record["bboxSouthE7"] == record["bboxNorthE7"]
    # Microdegree encoding
    assert record["bboxWestE7"] == int(round(139.69171 * 1e7))
    assert record["bboxSouthE7"] == int(round(35.6895 * 1e7))


def test_converter_properties_is_json_string():
    _, record = geonames_dumper._geonames_row_to_feature(SAMPLE_ROW)
    props = json.loads(record["properties"])
    assert props["category"] == "geonames-p"
    assert props["country"] == "JP"
    assert props["description"].startswith("PPLC pop=")


def test_converter_source_did_fallback():
    row = dict(SAMPLE_ROW)
    row["source_did"] = None  # type: ignore[assignment]
    _, record = geonames_dumper._geonames_row_to_feature(row)
    assert record["sourceDid"] == "did:web:maps.etzhayyim.com:registry:geonames:bulk"


def test_converter_includes_h3_fields():
    _, record = geonames_dumper._geonames_row_to_feature(SAMPLE_ROW)
    # h3 may be available or not; the field is always set.
    assert "h3Cell" in record
    assert record["h3Resolution"] == int(os.environ.get("SUBSTRATE_H3_RES", "8"))


def test_converter_created_at_is_iso():
    _, record = geonames_dumper._geonames_row_to_feature(SAMPLE_ROW)
    # YYYY-MM-DDTHH:MM:SSZ
    assert record["createdAt"].endswith("Z")
    assert "T" in record["createdAt"]
