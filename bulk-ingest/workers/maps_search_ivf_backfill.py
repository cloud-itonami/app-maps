#!/usr/bin/env python3
"""maps search IVF backfill — embed names + cluster + write centroids.

ADR-2605011500 §Phase-1.3 (addendum).

Pipeline:
  1. SELECT vessel + legal_entity + spatial(name) rows that don't yet have
     a row in vertex_vector_embedding_768 with space_id='maps_search_v1'.
  2. Embed each name via Cloudflare Workers AI HTTP API
     (@cf/baai/bge-base-en-v1.5, 768-dim) — batched ≤ 50 names/request.
  3. INSERT into vertex_vector_embedding_768.
  4. (After enough embeddings exist) re-train K=128 centroids via sklearn
     KMeans on the full set, INSERT into vertex_ivf_centroid (collection=
     'maps_search_v1'). Update each embedding's ivf_cluster_id.

Source priority (capped per run to keep batches manageable):
  - vertex_vessel.name (≤ 50K rows, growing daily)
  - vertex_spatial.name WHERE label IN whitelist (≤ 250K rows)
  - vertex_legal_entity.name (millions; opt-in via INCLUDE_LEGAL_ENTITY=1)

ENV:
  DATABASE_URL                   — required, RisingWave Postgres URL
  EMBEDDER_URL                  — default cluster-internal embedder Service
  EMBED_AUTH_TOKEN              — optional bearer token for embedder
  IVF_SPACE                      — default 'maps_search_v1'
  IVF_MODEL                      — default '@cf/baai/bge-base-en-v1.5'
  IVF_K                          — default 128 (target centroid count)
  IVF_BATCH                      — default 50 (names per CF AI call)
  IVF_MAX_PER_RUN                — default 5000 (rows per source)
  TRAIN_CENTROIDS                — '1' to run KMeans + write centroids
                                   (skip on incremental backfill runs)
  INCLUDE_LEGAL_ENTITY           — '1' to also embed legal_entity names
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import json
import logging
import os
import sys
import time
import urllib.error
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
log = logging.getLogger("maps_search_ivf_backfill")

DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
EMBEDDER_URL = os.environ.get(
    "EMBEDDER_URL",
    "http://bulk-ingest-embedder.maps-bulk-ingest.svc.cluster.local:8080",
).rstrip("/")
EMBED_AUTH_TOKEN = os.environ.get("EMBED_AUTH_TOKEN", "").strip()
IVF_SPACE = os.environ.get("IVF_SPACE", "maps_search_v1")
IVF_MODEL = os.environ.get("IVF_MODEL", "BAAI/bge-base-en-v1.5")
IVF_K = int(os.environ.get("IVF_K", "128"))
IVF_BATCH = int(os.environ.get("IVF_BATCH", "50"))
IVF_MAX_PER_RUN = int(os.environ.get("IVF_MAX_PER_RUN", "5000"))
TRAIN_CENTROIDS = os.environ.get("TRAIN_CENTROIDS", "0") == "1"
INCLUDE_LEGAL_ENTITY = os.environ.get("INCLUDE_LEGAL_ENTITY", "0") == "1"

# Limit total cardinality of embeddings touched per run so we never blow the
# Workers AI rate limit (free tier: ~50 req/s, ~10000 req/day).
SAFETY_DAILY_CAP = int(os.environ.get("IVF_DAILY_CAP", "30000"))


def _embed_batch(texts: list[str]) -> list[list[float]] | None:
    """Call the self-hosted embedder pod over HTTP. No external API."""
    url = f"{EMBEDDER_URL}/embed"
    body = json.dumps({"texts": texts}).encode("utf-8")
    headers = {"content-type": "application/json"}
    if EMBED_AUTH_TOKEN:
        headers["authorization"] = f"Bearer {EMBED_AUTH_TOKEN}"
    req = urllib.request.Request(url, data=body, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            payload = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8") if e.fp else ""
        log.warning("embedder HTTP %d: %s", e.code, body[:300])
        raise
    vectors = payload.get("vectors")
    if not isinstance(vectors, list):
        log.warning("embedder bad payload: %s", json.dumps(payload)[:200])
        return None
    return vectors


def _now_iso() -> str:
    return _dt.datetime.now(tz=_dt.timezone.utc).isoformat()


def _embedding_id(source_vid: str) -> str:
    h = hashlib.sha256(f"{IVF_SPACE}:{source_vid}".encode("utf-8")).hexdigest()[:16]
    return f"emb:{IVF_SPACE}:{h}"


_existing_cache: dict[str, set[str]] = {}


def _existing_for_space(cur) -> set[str]:
    """Pre-fetch all source_vertex_id for IVF_SPACE — small set (≤ 1M),
    cheap. Avoids RW correlated NOT EXISTS subqueries that time out at
    >120s on large source tables (vertex_spatial 4.6M, vertex_legal_entity
    millions). Cached per-process; one query for the whole run.
    """
    if IVF_SPACE in _existing_cache:
        return _existing_cache[IVF_SPACE]
    cur.execute(
        "SELECT source_vertex_id FROM vertex_vector_embedding_768 WHERE space_id = %s",
        (IVF_SPACE,),
    )
    out = set()
    for (vid,) in cur.fetchall():
        if vid:
            out.add(vid)
    _existing_cache[IVF_SPACE] = out
    log.info("loaded %d existing source_vertex_ids for space=%s", len(out), IVF_SPACE)
    return out


def _select_pending_rows(cur, source: str, limit: int) -> list[tuple[str, str]]:
    """Return [(source_vertex_id, name)] rows not yet embedded for IVF_SPACE.
    Uses the in-memory `existing` set instead of a NOT EXISTS subquery.
    """
    existing = _existing_for_space(cur)
    # Fetch a window larger than `limit` because some will already be in
    # `existing` and dropped. 4× factor empirically catches enough novel rows
    # in the high-overlap case while keeping the result-set bounded.
    fetch_n = limit * 4

    if source == "vessel":
        cur.execute(
            f"""
            SELECT 'mmsi:' || mmsi::varchar AS vid, name
            FROM vertex_vessel
            WHERE name IS NOT NULL AND name <> ''
            ORDER BY mmsi
            LIMIT {int(fetch_n)}
            OFFSET {int(len(existing))}
            """
        )
    elif source == "spatial":
        whitelist = (
            "Place", "Station", "Airport", "Port", "Hotel", "Restaurant", "Cafe",
            "School", "Hospital", "Park", "Building", "AdminArea", "Mountain",
            "River", "Lake", "Island", "Coastline",
        )
        cur.execute(
            f"""
            SELECT vertex_id AS vid, name
            FROM vertex_spatial
            WHERE label = ANY(%s)
              AND name IS NOT NULL AND name <> ''
            ORDER BY vertex_id
            LIMIT {int(fetch_n)}
            OFFSET {int(len(existing))}
            """,
            (list(whitelist),),
        )
    elif source == "legal_entity":
        cur.execute(
            f"""
            SELECT vertex_id AS vid, name
            FROM vertex_legal_entity
            WHERE name IS NOT NULL AND name <> ''
            ORDER BY vertex_id
            LIMIT {int(fetch_n)}
            OFFSET {int(len(existing))}
            """
        )
    else:
        return []
    rows: list[tuple[str, str]] = []
    for r in cur.fetchall():
        if not r[0] or not r[1]:
            continue
        if r[0] in existing:
            continue
        rows.append((r[0], r[1]))
        existing.add(r[0])  # mark so subsequent batches don't re-pick
        if len(rows) >= limit:
            break
    return rows


def _insert_embeddings(cur, source: str, rows: list[tuple[str, str]], vectors: list[list[float]]) -> int:
    if len(rows) != len(vectors):
        log.warning("len mismatch rows=%d vectors=%d", len(rows), len(vectors))
        return 0
    now = _now_iso()
    payload = []
    for (vid, name), vec in zip(rows, vectors):
        if not isinstance(vec, list) or len(vec) != 768:
            continue
        payload.append((
            _embedding_id(vid),
            f"at://maps_search/{source}/{vid}",
            None,                           # chunk_id
            vid,
            "anon",                         # tenant_id
            None,                           # shard_id
            "text",                         # modality
            IVF_MODEL,
            IVF_SPACE,
            "v1",
            None,                           # projection_id
            vec,
            (name or "")[:200],
            now,
            now,
            "did:web:maps.etzhayyim.com",
            "did:web:maps.etzhayyim.com",
        ))
    if not payload:
        return 0
    cur.executemany(
        """
        INSERT INTO vertex_vector_embedding_768
          (embedding_id, source_uri, chunk_id, source_vertex_id, tenant_id, shard_id,
           modality, model_id, space_id, model_version, projection_id, emb,
           text_preview, created_at, embedded_at, actor_did, org_did)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::real[], %s, %s, %s, %s, %s)
        """,
        payload,
    )
    return len(payload)


def _backfill_source(conn, source: str) -> dict:
    log.info("backfill source=%s …", source)
    total_in = 0
    total_inserted = 0
    while total_in < IVF_MAX_PER_RUN:
        with conn.cursor() as cur:
            rows = _select_pending_rows(cur, source, min(IVF_BATCH, IVF_MAX_PER_RUN - total_in))
        if not rows:
            break
        names = [r[1] for r in rows]
        try:
            vectors = _embed_batch(names)
        except urllib.error.HTTPError as e:
            log.warning("source=%s embed call failed http=%d: %s", source, e.code, e.reason)
            break
        if vectors is None:
            log.warning("source=%s CF AI returned no vectors", source)
            break
        with conn.cursor() as cur:
            cur.execute("SET dml_rate_limit = 5000")
            inserted = _insert_embeddings(cur, source, rows, vectors)
        conn.commit()
        total_in += len(rows)
        total_inserted += inserted
        log.info("source=%s batch +%d (total %d/%d)", source, inserted, total_in, IVF_MAX_PER_RUN)
        # rate-limit guard
        time.sleep(0.2)
    return {"source": source, "scanned": total_in, "inserted": total_inserted}


def _train_centroids(conn) -> dict:
    """Pull all embeddings for IVF_SPACE, run sklearn KMeans, write centroids
    + assign each embedding to its nearest cluster.
    """
    try:
        from sklearn.cluster import MiniBatchKMeans
        import numpy as np
    except ImportError:
        log.error("sklearn not installed — pip install scikit-learn numpy")
        return {"trained": False, "reason": "sklearn missing"}

    with conn.cursor() as cur:
        cur.execute(
            "SELECT embedding_id, emb FROM vertex_vector_embedding_768 WHERE space_id = %s",
            (IVF_SPACE,),
        )
        rows = cur.fetchall()
    log.info("train: %d embeddings", len(rows))
    if len(rows) < IVF_K:
        log.warning("not enough samples (%d) for K=%d", len(rows), IVF_K)
        return {"trained": False, "reason": "insufficient_samples", "samples": len(rows)}

    # RisingWave returns `real[]` as a textual array literal ("{0.1,0.2,…}"
    # or "[0.1,0.2,…]") via psycopg2's default adapter. Parse manually +
    # filter to exactly-768-dim float lists. np.array(..) would otherwise
    # fail with "inhomogeneous shape" on any malformed row.
    def _parse_emb(v):
        if isinstance(v, list):
            return v
        if not isinstance(v, str):
            return None
        s = v.strip()
        if s.startswith("[") and s.endswith("]"):
            inner = s[1:-1]
        elif s.startswith("{") and s.endswith("}"):
            inner = s[1:-1]
        else:
            return None
        if not inner:
            return None
        try:
            return [float(x) for x in inner.split(",")]
        except (TypeError, ValueError):
            return None

    cleaned: list[tuple[str, list[float]]] = []
    bad = 0
    for r in rows:
        parsed = _parse_emb(r[1])
        if parsed is not None and len(parsed) == 768:
            cleaned.append((r[0], parsed))
        else:
            bad += 1
    if bad:
        log.warning("dropped %d malformed embeddings (non-768-dim)", bad)
    log.info("kept %d valid embeddings for KMeans", len(cleaned))
    if len(cleaned) < IVF_K:
        return {"trained": False, "reason": "insufficient_samples_after_filter", "samples": len(cleaned)}
    ids = [r[0] for r in cleaned]
    X = np.array([r[1] for r in cleaned], dtype=np.float32)
    log.info("running MiniBatchKMeans n=%d k=%d dim=%d", X.shape[0], IVF_K, X.shape[1])
    km = MiniBatchKMeans(n_clusters=IVF_K, batch_size=1024, random_state=42, n_init=3)
    labels = km.fit_predict(X)
    centroids = km.cluster_centers_

    today = _dt.date.today().isoformat()
    now_iso = _now_iso()
    with conn.cursor() as cur:
        cur.execute("SET dml_rate_limit = 5000")
        # vertex_ivf_centroid is append-only; rely on PK upsert (deterministic
        # vertex_id per (space, cluster_id) overwrites previous centroid).
        cent_payload = []
        for k in range(IVF_K):
            cent_payload.append((
                f"at://maps_search/centroid/{IVF_SPACE}/c{k}",
                today,
                str(k),
                IVF_SPACE,
                centroids[k].tolist(),
                "did:web:maps.etzhayyim.com",
                "did:web:maps.etzhayyim.com",
            ))
        cur.executemany(
            """
            INSERT INTO vertex_ivf_centroid
              (vertex_id, created_date, rkey, collection, embedding, actor_did, org_did)
            VALUES (%s, %s, %s, %s, %s::real[], %s, %s)
            """,
            cent_payload,
        )
        # Cluster assignment lives in a side table (vertex_ivf_assignment) —
        # vertex_vector_embedding_768 is append-only so UPDATE is forbidden.
        # Side table has PK upsert; one row per (embedding_id, space).
        assign_payload = [
            (
                f"{IVF_SPACE}:{eid}",   # vertex_id PK
                eid,
                IVF_SPACE,
                str(int(lbl)),
                now_iso,
            )
            for eid, lbl in zip(ids, labels)
        ]
        # Chunk to keep batch size sane (executemany pipelines values).
        chunk = 1000
        for i in range(0, len(assign_payload), chunk):
            cur.executemany(
                """
                INSERT INTO vertex_ivf_assignment
                  (vertex_id, embedding_id, space_id, cluster_id, created_at)
                VALUES (%s, %s, %s, %s, %s)
                """,
                assign_payload[i:i + chunk],
            )
        conn.commit()
    return {"trained": True, "samples": int(X.shape[0]), "centroids": IVF_K}


def main() -> int:
    if not DATABASE_URL:
        log.error("DATABASE_URL is required")
        return 2
    if not EMBEDDER_URL:
        log.error("EMBEDDER_URL is required (default = cluster-internal Service)")
        return 2

    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = False

    try:
        summary: dict = {"ok": True, "space": IVF_SPACE, "model": IVF_MODEL, "sources": []}

        for src in ("vessel", "spatial"):
            summary["sources"].append(_backfill_source(conn, src))
        if INCLUDE_LEGAL_ENTITY:
            summary["sources"].append(_backfill_source(conn, "legal_entity"))

        if TRAIN_CENTROIDS:
            summary["train"] = _train_centroids(conn)

    finally:
        conn.close()

    log.info("done: %s", json.dumps(summary, ensure_ascii=False))
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
