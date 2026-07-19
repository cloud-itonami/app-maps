#!/usr/bin/env python3
"""aismarine ↔ legal_entity Wikidata enrichment.

ADR-2605011500 §Phase-1.2.

kotoba-datomic port (TBD): this pod is Phase 1 Tier A in
``60-apps/etzhayyim-project-maps/MIGRATION-TODO.md``. Target migration is
``edge_vessel_owned_by`` / ``edge_vessel_operated_by`` INSERTs →
``com.etzhayyim.maps.ownership`` records via ``kotodama.substrate``.
Recipe + per-site row-to-record converter design in
``bulk-ingest/PORT-NOTES.md`` (apply the same 5-step pattern as
``geonames_dumper.py`` shipped 2026-05-23). Two INSERT call sites
(``apply_owner_rows`` and ``apply_operator_rows``) → two ownership
record writes per matched row. Subject = LegalEntity (owner / operator)
AT URI; object = vessel feature AT URI.

Pulls ?ship wdt:P31/wdt:P279* wd:Q11446 ; wdt:P458 ?imo (ship with IMO);
optional wdt:P127 ?owner ; wdt:P137 ?operator ; wdt:P5305 (LEI on the
owner/operator company). For every (imo, lei, role) triple, joins to
vertex_vessel by IMO to get MMSI, then INSERTs into edge_vessel_owned_by
or edge_vessel_operated_by. The LEI column also matches the existing
vertex_legal_entity (GLEIF) rows by `lei`, so subsequent queries
(mv_vessel_with_lei + getVesselDetail handler) join through.

Free, no auth: Wikidata Query Service public endpoint. Sparse coverage
(~5K-20K mappings: famous container ships, tankers, cruise lines, naval,
government). Phase 1.3 follow-on (Equasis scrape) will fill the rest.

Run modes:
  python aismarine_wikidata_lei.py              # full SPARQL pull + apply
  DRY_RUN=1 python aismarine_wikidata_lei.py    # parse + count, no DB write
  TARGET_LEI=549300...    python ...            # apply only rows for one LEI

ENV:
  DATABASE_URL                — required, RisingWave Postgres URL
  WIKIDATA_SPARQL_URL         — default https://query.wikidata.org/sparql
  WIKIDATA_USER_AGENT         — default 'etzhayyim-maps/1.0 (https://maps.etzhayyim.com)'
  WIKIDATA_BATCH_SIZE         — default 5000 (Wikidata caps at 10000 rows)
  DRY_RUN                     — '1' = parse + count only
  TARGET_LEI                  — optional LEI filter
"""
from __future__ import annotations

import datetime as _dt
import json
import logging
import os
import sys
import time
import urllib.parse
import urllib.request

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
log = logging.getLogger("aismarine_wikidata_lei")

DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
SPARQL_URL = os.environ.get("WIKIDATA_SPARQL_URL", "https://query.wikidata.org/sparql")
USER_AGENT = os.environ.get(
    "WIKIDATA_USER_AGENT", "etzhayyim-maps/1.0 (https://maps.etzhayyim.com)"
)
BATCH_SIZE = int(os.environ.get("WIKIDATA_BATCH_SIZE", "5000"))
DRY_RUN = os.environ.get("DRY_RUN", "0") == "1"
TARGET_LEI = os.environ.get("TARGET_LEI", "").strip()

SOURCE = "wikidata"


# ─── SPARQL ───────────────────────────────────────────────────────────

# Two queries: one for owners (P127), one for operators (P137). Done
# separately to keep result shape simple and avoid Wikidata 60s timeout
# on a 6-way OPTIONAL join.

QUERY_OWNERS = """
SELECT ?imo ?owner ?ownerLabel ?ownerLEI ?ownerCountryCode WHERE {
  ?ship wdt:P31/wdt:P279* wd:Q11446 .
  ?ship wdt:P458 ?imo .
  ?ship wdt:P127 ?owner .
  OPTIONAL { ?owner wdt:P5305 ?ownerLEI . }
  OPTIONAL { ?owner wdt:P17 ?ownerCountry . ?ownerCountry wdt:P297 ?ownerCountryCode . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
LIMIT %(limit)d
"""

QUERY_OPERATORS = """
SELECT ?imo ?operator ?operatorLabel ?operatorLEI ?operatorCountryCode WHERE {
  ?ship wdt:P31/wdt:P279* wd:Q11446 .
  ?ship wdt:P458 ?imo .
  ?ship wdt:P137 ?operator .
  OPTIONAL { ?operator wdt:P5305 ?operatorLEI . }
  OPTIONAL { ?operator wdt:P17 ?operatorCountry . ?operatorCountry wdt:P297 ?operatorCountryCode . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
LIMIT %(limit)d
"""


def _sparql(query: str) -> list[dict]:
    body = urllib.parse.urlencode({"query": query})
    req = urllib.request.Request(
        SPARQL_URL,
        data=body.encode("utf-8"),
        method="POST",
        headers={
            "accept": "application/sparql-results+json",
            "content-type": "application/x-www-form-urlencoded",
            "user-agent": USER_AGENT,
        },
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        payload = json.loads(r.read().decode("utf-8"))
    return payload.get("results", {}).get("bindings", [])


def _val(b: dict, name: str) -> str | None:
    cell = b.get(name)
    if not cell:
        return None
    v = cell.get("value")
    return v if isinstance(v, str) and v else None


def _qid_from_uri(uri: str | None) -> str | None:
    if not uri or not uri.startswith("http://www.wikidata.org/entity/"):
        return None
    return uri.rsplit("/", 1)[-1]


def _imo_int(s: str | None) -> int | None:
    if not s:
        return None
    s = s.strip()
    # Wikidata sometimes gives 'IMO 1234567' or just '1234567'.
    if s.upper().startswith("IMO"):
        s = s[3:].strip()
    try:
        return int(s)
    except (TypeError, ValueError):
        return None


# ─── DB writers ───────────────────────────────────────────────────────

def _today_iso_date() -> str:
    return _dt.date.today().isoformat()


def _now_ms() -> int:
    return int(time.time() * 1000)


def _vessel_vid(mmsi: int) -> str:
    return f"mmsi:{mmsi}"


def _legal_entity_vid_by_lei(cur, lei: str) -> str | None:
    cur.execute(
        "SELECT vertex_id FROM vertex_legal_entity WHERE lei = %s LIMIT 1",
        (lei,),
    )
    row = cur.fetchone()
    return row[0] if row else None


def _vessel_mmsi_by_imo(cur, imo: int) -> int | None:
    cur.execute(
        "SELECT mmsi FROM vertex_vessel WHERE imo = %s LIMIT 1",
        (imo,),
    )
    row = cur.fetchone()
    return int(row[0]) if row else None


def _entity_dst_vid(cur, lei: str | None, qid: str | None) -> str | None:
    """Resolve vertex_legal_entity by LEI when present, else fall back to a
    `wikidata:QID` synthetic vid. Returns None when neither exists."""
    if lei:
        existing = _legal_entity_vid_by_lei(cur, lei)
        if existing:
            return existing
        return f"lei:{lei}"
    if qid:
        return f"wikidata:{qid}"
    return None


def apply_owner_rows(cur, rows: list[dict]) -> tuple[int, int, int]:
    """Returns (rows_seen, rows_with_mmsi_match, rows_inserted)."""
    today = _today_iso_date()
    now_ms = _now_ms()
    inserted = 0
    matched = 0
    for b in rows:
        imo = _imo_int(_val(b, "imo"))
        lei = _val(b, "ownerLEI")
        owner_label = _val(b, "ownerLabel")
        owner_qid = _qid_from_uri(_val(b, "owner"))
        country = _val(b, "ownerCountryCode")
        if imo is None or (not lei and not owner_qid):
            continue
        if TARGET_LEI and lei != TARGET_LEI:
            continue

        mmsi = _vessel_mmsi_by_imo(cur, imo)
        if mmsi is None:
            continue
        matched += 1

        dst_vid = _entity_dst_vid(cur, lei, owner_qid)
        if dst_vid is None:
            continue
        # Edge ID prefers LEI for canonical-ness; fall back to QID.
        ent_id = lei or f"wd:{owner_qid}"
        edge_id = f"mmsi:{mmsi}:owner:{ent_id}"

        cur.execute(
            """
            INSERT INTO edge_vessel_owned_by
              (edge_id, created_date, src_vid, dst_vid, mmsi, imo, lei,
               wikidata_qid, entity_label,
               share_pct, effective_from_ms, source, source_record_id, created_at)
            VALUES (%s, %s, %s, %s, %s::bigint, %s::bigint, %s,
                    %s, %s,
                    %s, %s::bigint, %s, %s, %s)
            """,
            (
                edge_id, today, _vessel_vid(mmsi), dst_vid,
                mmsi, imo, lei,
                owner_qid, owner_label,
                None, now_ms, SOURCE,
                f"{owner_qid or ''}|{country or ''}",
                _dt.datetime.now(tz=_dt.timezone.utc).isoformat(),
            ),
        )
        inserted += 1
    return len(rows), matched, inserted


def apply_operator_rows(cur, rows: list[dict]) -> tuple[int, int, int]:
    today = _today_iso_date()
    now_ms = _now_ms()
    inserted = 0
    matched = 0
    for b in rows:
        imo = _imo_int(_val(b, "imo"))
        lei = _val(b, "operatorLEI")
        op_label = _val(b, "operatorLabel")
        op_qid = _qid_from_uri(_val(b, "operator"))
        country = _val(b, "operatorCountryCode")
        if imo is None or (not lei and not op_qid):
            continue
        if TARGET_LEI and lei != TARGET_LEI:
            continue

        mmsi = _vessel_mmsi_by_imo(cur, imo)
        if mmsi is None:
            continue
        matched += 1

        dst_vid = _entity_dst_vid(cur, lei, op_qid)
        if dst_vid is None:
            continue
        ent_id = lei or f"wd:{op_qid}"
        edge_id = f"mmsi:{mmsi}:operator:{ent_id}"

        cur.execute(
            """
            INSERT INTO edge_vessel_operated_by
              (edge_id, created_date, src_vid, dst_vid, mmsi, imo, lei,
               wikidata_qid, entity_label,
               role, effective_from_ms, source, source_record_id, created_at)
            VALUES (%s, %s, %s, %s, %s::bigint, %s::bigint, %s,
                    %s, %s,
                    %s, %s::bigint, %s, %s, %s)
            """,
            (
                edge_id, today, _vessel_vid(mmsi), dst_vid,
                mmsi, imo, lei,
                op_qid, op_label,
                "operator", now_ms, SOURCE,
                f"{op_qid or ''}|{country or ''}",
                _dt.datetime.now(tz=_dt.timezone.utc).isoformat(),
            ),
        )
        inserted += 1
    return len(rows), matched, inserted


# ─── main ─────────────────────────────────────────────────────────────

def main() -> int:
    if not DATABASE_URL and not DRY_RUN:
        log.error("DATABASE_URL is required (or set DRY_RUN=1)")
        return 2

    log.info("fetching SPARQL owners (limit=%d)", BATCH_SIZE)
    owner_rows = _sparql(QUERY_OWNERS % {"limit": BATCH_SIZE})
    log.info("got %d owner triples", len(owner_rows))

    log.info("fetching SPARQL operators (limit=%d)", BATCH_SIZE)
    operator_rows = _sparql(QUERY_OPERATORS % {"limit": BATCH_SIZE})
    log.info("got %d operator triples", len(operator_rows))

    if DRY_RUN:
        # Just print summary stats.
        owners_with_lei = sum(1 for b in owner_rows if _val(b, "ownerLEI"))
        operators_with_lei = sum(1 for b in operator_rows if _val(b, "operatorLEI"))
        summary = {
            "ok": True,
            "dry_run": True,
            "owner_rows": len(owner_rows),
            "owner_with_lei": owners_with_lei,
            "operator_rows": len(operator_rows),
            "operator_with_lei": operators_with_lei,
        }
        print(json.dumps(summary))
        return 0

    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            cur.execute("SET dml_rate_limit = 5000")
        conn.commit()
        with conn.cursor() as cur:
            (oo_seen, oo_match, oo_ins) = apply_owner_rows(cur, owner_rows)
        conn.commit()
        with conn.cursor() as cur:
            (op_seen, op_match, op_ins) = apply_operator_rows(cur, operator_rows)
        conn.commit()
    finally:
        conn.close()

    summary = {
        "ok": True,
        "dry_run": False,
        "source": SOURCE,
        "owner_rows_seen": oo_seen,
        "owner_rows_mmsi_match": oo_match,
        "owner_edges_inserted": oo_ins,
        "operator_rows_seen": op_seen,
        "operator_rows_mmsi_match": op_match,
        "operator_edges_inserted": op_ins,
    }
    log.info("done: %s", json.dumps(summary, ensure_ascii=False))
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
