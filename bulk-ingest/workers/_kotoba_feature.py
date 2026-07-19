"""_kotoba_feature — vertex_spatial row → kotoba :feature/* mapping for the bulk-ingest dumpers.

ADR-2606064500 (R2). The canonical legacy-row → kotoba Datom shape used by the `kotoba`
substrate-writer mode. Kept in lockstep with `orgs/etzhayyim/com-etzhayyim-maps/methods/ingest.py` (_LABEL_MAP)
and `maps-spatial-ontology.kotoba.edn` (`:feature/label` keywords); a test asserts the label
map matches the canonical one so the two write paths (the maps Worker adapter + the bulk
dumpers) never disagree on a stored keyword.

stdlib only; real H3 cells stamped when an `h3` package is importable, else deferred (the cell
index is stamped wherever h3 is available — the maps adapter or a dumper image that ships h3).
"""
from __future__ import annotations
import json
from typing import Any, Iterable

# H3 resolutions the maps client queries (the zoom→LOD ladder; ontology §2).
CELL_RESOLUTIONS = (2, 4, 6, 8, 10, 12)

# legacy vertex_spatial.label (PascalCase) → kotoba :feature/label keyword.
# MUST equal orgs/etzhayyim/com-etzhayyim-maps/methods/ingest.py _LABEL_MAP (asserted by test_kotoba_substrate.py).
_LABEL_MAP = {
    "Place": ":place", "Road": ":road", "Railway": ":railway", "Building": ":building",
    "River": ":river", "Lake": ":lake", "Coastline": ":coastline", "AdminArea": ":admin-area",
    "Mountain": ":mountain", "Port": ":port", "Airport": ":airport", "Station": ":station",
    "BusStop": ":bus-stop", "BusRoute": ":bus-route", "SeaRoute": ":sea-route",
    "AirRoute": ":air-route", "LegalEntity": ":legal-entity", "LandRegistry": ":registry",
    "SatelliteScene": ":satellite-scene", "Spot": ":place",
}


def fold_label(label: Any) -> str:
    """Legacy PascalCase label → :feature/label keyword (lowercase-kebab)."""
    if not label:
        return ":unknown"
    s = str(label)
    if s.startswith(":"):
        return s
    return _LABEL_MAP.get(s, ":" + s.strip().lower().replace(" ", "-"))


def stamp_cells(lat: Any, lon: Any) -> dict[str, str]:
    """Owning H3 cell at each queryable resolution, or {} when h3 is absent / coords missing.
    Uses latlng_to_cell DIRECTLY at each res (matches the TS adapter + ingest.py; H3 is not
    perfectly hierarchical, so stamp and query must use the same method)."""
    if not (isinstance(lat, (int, float)) and isinstance(lon, (int, float))):
        return {}
    try:
        import h3
        def cell(r):
            try:
                return h3.latlng_to_cell(lat, lon, r)   # h3 >= 4
            except AttributeError:
                return h3.geo_to_h3(lat, lon, r)        # h3 == 3
        return {f"feature.cell/r{r}": cell(r) for r in CELL_RESOLUTIONS}
    except Exception:
        return {}


# ── name-search index tokens (ADR-2606064500 R2) ──
# MUST equal orgs/etzhayyim/com-etzhayyim-maps/methods/search.py `name_tokens` (asserted by test_kotoba_substrate)
# so a feature is name-searchable regardless of which write path (maps adapter / bulk dumper)
# ingested it. ASCII name-prefixes (len 2..12) + CJK bigrams.
_MAX_PREFIX = 12


def _is_cjk(ch: str) -> bool:
    o = ord(ch)
    return (0x3040 <= o <= 0x30FF or 0x3400 <= o <= 0x9FFF
            or 0xF900 <= o <= 0xFAFF or 0xFF66 <= o <= 0xFF9D)


def _name_runs(name: str):
    out, buf, kind = [], [], None
    for ch in (name or "").lower():
        k = "cjk" if _is_cjk(ch) else ("ascii" if ch.isalnum() else None)
        if k != kind:
            if buf:
                out.append((kind, "".join(buf)))
            buf, kind = [], k
        if k is not None:
            buf.append(ch)
    if buf and kind is not None:
        out.append((kind, "".join(buf)))
    return out


def name_tokens(name: str) -> set[str]:
    """INDEX tokens for a feature name (stored as :feature/name-token)."""
    toks: set[str] = set()
    for kind, text in _name_runs(name):
        if kind == "ascii" and len(text) >= 2:
            for n in range(2, min(len(text), _MAX_PREFIX) + 1):
                toks.add(text[:n])
        elif kind == "cjk":
            toks.update(text[i:i + 2] for i in range(len(text) - 1))
            if len(text) == 1:
                toks.add(text)
    return toks


_PROMOTED = ("geometry", "heightM", "height_m", "levels", "floors")


def row_to_entity(row: dict[str, Any]) -> dict[str, Any] | None:
    """One vertex_spatial row dict → a kg.ingest_batch entity {id, type, label_en, claims}."""
    fid = row.get("vertex_id") or row.get("id")
    if not fid:
        return None
    lat = row.get("lat")
    lon = row.get("lng", row.get("lon"))
    props = row.get("props")
    if isinstance(props, str):
        try:
            props = json.loads(props)
        except Exception:
            props = {}
    props = props or {}

    claims: list[dict[str, str]] = [
        {"pred": "feature/label", "value": fold_label(row.get("label"))},
        {"pred": "feature/sourcing", "value": ":representative"},  # G3 — a bulk feed is bounded
    ]

    def add(pred: str, value: Any) -> None:
        if value not in (None, ""):
            claims.append({"pred": pred, "value": str(value)})

    add("feature/name", row.get("name"))
    add("feature/display-name", row.get("display_name"))
    add("feature/category", row.get("category"))
    add("feature/source-did", row.get("source_did"))
    if isinstance(lat, (int, float)):
        add("feature/lat", lat)
    if isinstance(lon, (int, float)):
        add("feature/lon", lon)
    h = props.get("heightM", props.get("height_m"))
    if isinstance(h, (int, float)):
        add("feature/height-m", float(h))
    lv = props.get("levels", props.get("floors"))
    if isinstance(lv, (int, float)):
        add("feature/levels", int(lv))
    geom = props.get("geometry")
    if geom is not None:
        add("feature/geometry", json.dumps(geom, ensure_ascii=False))
    rest = {k: v for k, v in props.items() if k not in _PROMOTED}
    if rest:
        add("feature/props", json.dumps(rest, ensure_ascii=False))
    for k, v in stamp_cells(lat, lon).items():
        add(k, v)
    # name-search index — so a dumper-ingested feature is name-searchable (search.py)
    toks: set[str] = set()
    for nm in (row.get("name"), row.get("display_name")):
        if nm:
            toks |= name_tokens(str(nm))
    for t in sorted(toks):
        claims.append({"pred": "feature/name-token", "value": t})

    return {
        "id": str(fid),
        "type": "maps-feature",
        "label_en": row.get("name") or row.get("display_name") or str(fid),
        "claims": claims,
        "relations": [],
    }


def rows_to_batch(rows: Iterable[dict[str, Any]]) -> dict[str, list]:
    """vertex_spatial rows → a kg.ingest_batch body."""
    entities = [e for e in (row_to_entity(r) for r in rows) if e is not None]
    return {"entities": entities}


# ── auxiliary tables → kotoba records (ADR-2606064500 R2 aux; maps-transit-ontology) ──
#    NOT placed features (a trip is a schedule, a stop-time a call) → :transit.trip/* and
#    :transit.stop-time/* instead of :feature/*. Successor to the GTFS RisingWave aux tables
#    vertex_maps_trip / vertex_maps_stop_time.

def _claims(pairs: Iterable[tuple[str, Any]]) -> list[dict[str, str]]:
    return [{"pred": p, "value": str(v)} for p, v in pairs if v not in (None, "")]


def trip_row_to_entity(row: dict[str, Any]) -> dict[str, Any] | None:
    feed, trip = row.get("feed_id"), row.get("trip_id")
    if not (feed and trip):
        return None
    tid = f"trip.{feed}.{trip}"
    claims = _claims([
        ("transit.trip/feed", feed), ("transit.trip/trip-id", trip),
        ("transit.trip/route", row.get("route_id")), ("transit.trip/service", row.get("service_id")),
        ("transit.trip/shape", row.get("shape_id")), ("transit.trip/direction", row.get("direction_id")),
        ("transit.trip/headsign", row.get("headsign")), ("transit.trip/short-name", row.get("short_name")),
        ("transit.trip/block", row.get("block_id")),
        ("transit.trip/wheelchair-accessible", row.get("wheelchair_accessible")),
        ("transit.trip/bikes-allowed", row.get("bikes_allowed")),
        ("transit.trip/agency", row.get("agency")), ("transit.trip/prefecture", row.get("prefecture")),
        ("transit.trip/sourcing", ":representative"),
    ])
    return {"id": tid, "type": "transit-trip",
            "label_en": row.get("headsign") or row.get("short_name") or tid,
            "claims": claims, "relations": []}


def stop_time_row_to_entity(row: dict[str, Any]) -> dict[str, Any] | None:
    feed, trip, seq = row.get("feed_id"), row.get("trip_id"), row.get("stop_sequence")
    if not (feed and trip) or seq is None:
        return None
    sid = f"stoptime.{feed}.{trip}.{seq}"
    claims = _claims([
        ("transit.stop-time/trip", f"trip.{feed}.{trip}"),
        ("transit.stop-time/stop", row.get("stop_id")),
        ("transit.stop-time/sequence", seq),
        ("transit.stop-time/arrival-time", row.get("arrival_time")),
        ("transit.stop-time/departure-time", row.get("departure_time")),
        ("transit.stop-time/pickup-type", row.get("pickup_type")),
        ("transit.stop-time/drop-off-type", row.get("drop_off_type")),
        ("transit.stop-time/headsign", row.get("stop_headsign")),
        ("transit.stop-time/shape-dist", row.get("shape_dist_traveled")),
        ("transit.stop-time/timepoint", row.get("timepoint")),
        ("transit.stop-time/sourcing", ":representative"),
    ])
    return {"id": sid, "type": "transit-stop-time", "label_en": sid,
            "claims": claims, "relations": []}


# table name → row-mapper. Tables absent here have no kotoba schema yet (R2 follow-up).
AUX_TABLE_MAPPERS = {
    "vertex_maps_trip": trip_row_to_entity,
    "vertex_maps_stop_time": stop_time_row_to_entity,
}


def aux_rows_to_batch(table: str, rows: Iterable[dict[str, Any]]) -> dict[str, list] | None:
    """Known aux table's rows → kg.ingest_batch, or None if the table has no kotoba mapping
    yet (the caller raises so an unmapped table is never a silent drop)."""
    mapper = AUX_TABLE_MAPPERS.get(table)
    if mapper is None:
        return None
    return {"entities": [e for e in (mapper(r) for r in rows) if e is not None]}
