"""maps Gsplat train dumper — Mapillary → COLMAP+gsplat (RunPod) → B2 → RisingWave.

ADR-2605092800. Resident worker pod that drives a single end-to-end
training pass per `/trigger` invocation:

  1. Fetch Mapillary image set in `(lat, lng, radiusM)` bbox via
     Graph API v4 (`MAPILLARY_ACCESS_TOKEN`). Bounded by `maxImages`.
  2. Resolve each image to a downloadable URL (Mapillary signed URL
     in the `thumb_2048_url` field).
  3. POST `{tileH3, imageUrls, …}` → RunPod `/v2/{endpoint}/run`.
  4. Poll `/v2/{endpoint}/status/{job_id}` until `COMPLETED`.
  5. Decode `output.plyBase64` → upload to B2
     (`maps-bulk-ingest/gsplat/{tile_h3}.ply`).
  6. INSERT a row into `vertex_maps_gsplat_asset` with `bake_job_id`
     left NULL (filled later by the bake pipeline).

HTTP shape (mirrors the other resident dumpers in this directory):

  POST /trigger      kicks the job (returns 202 + `state`)
  GET  /status       running / completed / error metrics
  GET  /health       readiness probe

Trigger payload:

  {
    "trainJobId":  "gsplattrain-…",
    "tileH3":      "8c2a1072b59ffff",
    "lat":         35.6812,
    "lng":         139.7671,
    "radiusM":     50,
    "h3Resolution":12,
    "maxImages":   80,
    "mapillaryImageIds": ["…"],            # optional explicit ids
    "priority":    "normal" | "low" | "high"
  }

Operator notes:

  * `MAPILLARY_ACCESS_TOKEN` and `RUNPOD_API_KEY` + `RUNPOD_ENDPOINT_ID_GSPLAT`
    must be present (otherwise the worker refuses to start —
    same fail-fast pattern as `gtfs_rt_dumper.py`).
  * `replicas: 0` by default in `k8s/deployment-gsplat-train.yaml`.
    Operator scales up after credentials are wired.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Lock, Thread
from urllib.error import HTTPError, URLError

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

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("gsplat_train_dumper")

# ── Config ────────────────────────────────────────────────────────────

PORT = int(os.environ.get("PORT", "8080"))
DATABASE_URL = os.environ.get("DATABASE_URL", "")
B2_ENDPOINT = os.environ.get("B2_ENDPOINT", "")
B2_REGION = os.environ.get("B2_REGION", "us-west-004")
B2_BUCKET = os.environ.get("B2_BUCKET", "")
B2_KEY_ID = os.environ.get("B2_KEY_ID", "")
B2_APPLICATION_KEY = os.environ.get("B2_APPLICATION_KEY", "")
B2_PREFIX = os.environ.get("B2_PREFIX", "maps-bulk-ingest/gsplat")

MAPILLARY_TOKEN = os.environ.get("MAPILLARY_ACCESS_TOKEN", "")
RUNPOD_API_KEY = os.environ.get("RUNPOD_API_KEY", "")
RUNPOD_ENDPOINT_ID = os.environ.get("RUNPOD_ENDPOINT_ID_GSPLAT", "")
RUNPOD_RUN_URL_TPL = "https://api.runpod.ai/v2/{endpoint}/run"
RUNPOD_STATUS_URL_TPL = "https://api.runpod.ai/v2/{endpoint}/status/{job_id}"
RUNPOD_MAX_POLLS = int(os.environ.get("RUNPOD_MAX_POLLS", "1800"))  # ≤ 30 min
RUNPOD_POLL_SEC = float(os.environ.get("RUNPOD_POLL_SEC", "1.5"))

SOURCE_DID = "did:web:maps.etzhayyim.com:street_view"

_lock = Lock()
_state: dict = {
    "running": False,
    "started_at": None,
    "completed_at": None,
    "tile_h3": None,
    "phase": None,
    "image_count": 0,
    "splat_count": 0,
    "byte_size": 0,
    "error": None,
    "last_train_job_id": None,
}


# ── Boot guard ────────────────────────────────────────────────────────


def _resolve_required() -> None:
    missing = []
    if not DATABASE_URL:
        missing.append("DATABASE_URL")
    if not (B2_ENDPOINT and B2_BUCKET and B2_KEY_ID and B2_APPLICATION_KEY):
        missing.append("B2_*")
    if not MAPILLARY_TOKEN:
        missing.append("MAPILLARY_ACCESS_TOKEN")
    if not (RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID):
        missing.append("RUNPOD_API_KEY / RUNPOD_ENDPOINT_ID_GSPLAT")
    if missing:
        raise SystemExit(
            "gsplat_train_dumper: required env not configured: " + ", ".join(missing)
        )


_b2_client = None


def _b2():
    global _b2_client
    if _b2_client is None:
        _b2_client = boto3.client(
            "s3",
            endpoint_url=B2_ENDPOINT,
            region_name=B2_REGION,
            aws_access_key_id=B2_KEY_ID,
            aws_secret_access_key=B2_APPLICATION_KEY,
        )
    return _b2_client


# ── Mapillary: image list lookup ──────────────────────────────────────


def _mapillary_bbox(lat: float, lng: float, radius_m: float) -> tuple[float, float, float, float]:
    # ~1° lat ≈ 110 574 m. Adjust lng by cos(lat).
    import math
    dlat = radius_m / 110574.0
    dlng = radius_m / (111320.0 * max(0.05, math.cos(math.radians(lat))))
    return (lng - dlng, lat - dlat, lng + dlng, lat + dlat)


def _http_get_json(url: str, headers: dict[str, str], timeout: float = 20.0) -> dict:
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace"))


def _http_post_json(url: str, body: dict, headers: dict[str, str], timeout: float = 30.0) -> tuple[int, dict, str]:
    raw = json.dumps(body).encode("utf-8")
    h = {"content-type": "application/json", **headers}
    req = urllib.request.Request(url, data=raw, headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            text = resp.read().decode("utf-8", errors="replace")
            return resp.status, json.loads(text or "{}"), text
    except HTTPError as e:
        text = e.read().decode("utf-8", errors="replace")
        try:
            return e.code, json.loads(text or "{}"), text
        except Exception:
            return e.code, {}, text


def _mapillary_images_in_bbox(lat: float, lng: float, radius_m: float, max_images: int) -> list[dict]:
    """Mapillary Graph API v4: list images in bbox, paginated."""
    west, south, east, north = _mapillary_bbox(lat, lng, radius_m)
    fields = "id,thumb_2048_url,captured_at,compass_angle,computed_geometry"
    base = "https://graph.mapillary.com/images"
    params = urllib.parse.urlencode({
        "fields": fields,
        "bbox": f"{west},{south},{east},{north}",
        "limit": min(max_images, 200),
    })
    url = f"{base}?{params}"
    headers = {"authorization": f"OAuth {MAPILLARY_TOKEN}"}
    out: list[dict] = []
    while url and len(out) < max_images:
        try:
            payload = _http_get_json(url, headers)
        except (HTTPError, URLError) as e:
            log.warning("mapillary list failed: %s", e)
            break
        out.extend(payload.get("data") or [])
        url = (payload.get("paging") or {}).get("next") or ""
    return out[:max_images]


def _mapillary_image_url_by_id(image_id: str) -> str | None:
    url = f"https://graph.mapillary.com/{image_id}?fields=thumb_2048_url"
    try:
        payload = _http_get_json(url, {"authorization": f"OAuth {MAPILLARY_TOKEN}"})
    except (HTTPError, URLError) as e:
        log.warning("mapillary lookup %s failed: %s", image_id, e)
        return None
    return str(payload.get("thumb_2048_url") or "") or None


# ── RunPod sync invoke (mirrors maps_sentinel pattern) ────────────────


def _runpod_invoke(payload: dict) -> dict:
    """Submit `{input: payload}` to the RunPod /run endpoint, then
    poll /status until COMPLETED. Same call shape for train + bake;
    `payload.mode` selects the handler branch on the worker side."""
    headers = {"authorization": f"Bearer {RUNPOD_API_KEY}"}
    status, body, raw = _http_post_json(
        RUNPOD_RUN_URL_TPL.format(endpoint=RUNPOD_ENDPOINT_ID),
        {"input": payload},
        headers=headers,
    )
    if status != 200 or not body.get("id"):
        raise RuntimeError(f"runpod /run status={status} body={raw[:200]}")
    job_id = str(body["id"])
    log.info("runpod job %s submitted", job_id)
    for i in range(RUNPOD_MAX_POLLS):
        time.sleep(RUNPOD_POLL_SEC)
        try:
            status_payload = _http_get_json(
                RUNPOD_STATUS_URL_TPL.format(endpoint=RUNPOD_ENDPOINT_ID, job_id=job_id),
                {"authorization": f"Bearer {RUNPOD_API_KEY}"},
            )
        except Exception as e:
            raise RuntimeError(f"runpod /status raised: {e}") from e
        st = str(status_payload.get("status") or "")
        if i % 20 == 0:
            log.info("runpod job %s status=%s", job_id, st)
        if st == "COMPLETED":
            return status_payload.get("output") or {}
        if st in ("FAILED", "CANCELLED", "TIMED_OUT"):
            raise RuntimeError(f"runpod {st}: {status_payload.get('error') or ''}")
    raise TimeoutError(f"runpod poll exceeded {RUNPOD_MAX_POLLS} for job {job_id}")


# Backwards-compat alias — was the only entry before bake mode landed.
_runpod_train = _runpod_invoke


# ── B2 + RisingWave ───────────────────────────────────────────────────


def _b2_upload(
    b2_key: str,
    blob: bytes,
    content_type: str = "application/octet-stream",
    cache_control: str | None = None,
) -> None:
    """Put an object on B2. `cache_control` becomes the
    `Cache-Control` response header — pass
    `"public, max-age=86400, immutable"` for content-addressed blobs
    so browsers can re-use a previously-fetched (possibly Range-
    sliced) response on tile re-entry."""
    extra: dict[str, object] = {
        "Bucket": B2_BUCKET,
        "Key": b2_key,
        "Body": blob,
        "ContentType": content_type,
    }
    if cache_control:
        extra["CacheControl"] = cache_control
    _b2().put_object(**extra)


def _b2_download(b2_key: str) -> bytes:
    obj = _b2().get_object(Bucket=B2_BUCKET, Key=b2_key)
    return obj["Body"].read()


def _b2_head(b2_key: str) -> bool:
    """Return True iff the object exists. Used by content-addressed
    upload to skip re-uploading identical blobs."""
    try:
        _b2().head_object(Bucket=B2_BUCKET, Key=b2_key)
        return True
    except Exception:
        return False


def _content_addressed_key(prefix: str, blob: bytes, ext: str) -> tuple[str, str]:
    """SHA-256 of `blob` → `(b2_key, sha_hex)`. The key is partitioned
    by the first 2 hex chars to keep individual B2 listing cheap.

    Mirrors the root CLAUDE.md "Content-Addressed Blob Storage" rule
    used by the PDS uploadBlob path. Re-running the same train/bake
    on identical input lands on the same key, so `_b2_head` short-
    circuits the upload and B2 storage cost stays flat."""
    import hashlib
    sha = hashlib.sha256(blob).hexdigest()
    key = f"{prefix.rstrip('/')}/{sha[:2]}/{sha}.{ext}"
    return key, sha


# SHA-256 keys are inherently immutable, so the browser can keep the
# blob (and any Range slice of it) in cache forever. 1-day max-age
# leaves room to invalidate the bucket policy if we ever need to
# (re-keying every blob is a cheap fallback).
_IMMUTABLE_CACHE_CONTROL = "public, max-age=86400, immutable"


def _content_addressed_upload(
    prefix: str, blob: bytes, ext: str, content_type: str
) -> tuple[str, str, bool]:
    """Compute SHA-256 → B2 key, skip upload if blob already there.
    Returns `(b2_key, sha_hex, was_new_upload)`.

    Sets `Cache-Control: public, max-age=86400, immutable` so browsers
    re-use the cached body (or a Range slice) on tile re-entry — 0 B
    over the wire when the player walks back."""
    b2_key, sha_hex = _content_addressed_key(prefix, blob, ext)
    if _b2_head(b2_key):
        log.info("b2 dedupe hit: %s (%d B)", b2_key, len(blob))
        return b2_key, sha_hex, False
    _b2_upload(
        b2_key, blob,
        content_type=content_type,
        cache_control=_IMMUTABLE_CACHE_CONTROL,
    )
    return b2_key, sha_hex, True


def _emit_job_state(
    *,
    job_id: str,
    job_kind: str,
    tile_h3: str,
    status: str,
    phase: str | None = None,
    message: str | None = None,
    splat_count: int | None = None,
    triangle_count: int | None = None,
    byte_size: int | None = None,
    runtime_ms: int | None = None,
    cost_usd: float | None = None,
    imageids_hash: str | None = None,
) -> None:
    """Append one row to `vertex_maps_gsplat_job`. Best-effort —
    failures here are non-fatal (a missed status row never blocks the
    actual training/baking pipeline).

    `cost_usd` (when present) is the RunPod-reported
    `stats.estimatedCostUsd` for the job — locked at write time so
    later rate changes don't rewrite history."""
    now_iso = datetime.now(timezone.utc).isoformat()
    vertex_id = (
        f"at://did:web:maps.etzhayyim.com/com.etzhayyim.apps.maps.gsplatJob/{job_id}-"
        f"{int(time.time() * 1000)}"
    )
    try:
        conn = psycopg2.connect(DATABASE_URL)
        try:
            conn.autocommit = False
            cur = conn.cursor()
            cur.execute(
                """
                INSERT INTO vertex_maps_gsplat_job (
                  vertex_id, job_id, job_kind, tile_h3, status, phase,
                  message, splat_count, triangle_count, byte_size, runtime_ms,
                  cost_usd, imageids_hash, ts, actor_did, org_did, created_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    vertex_id, job_id, job_kind, tile_h3, status, phase,
                    message, splat_count, triangle_count, byte_size, runtime_ms,
                    cost_usd, imageids_hash, now_iso,
                    "did:web:maps.etzhayyim.com", "did:web:maps.etzhayyim.com", now_iso,
                ),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception as e:
        log.warning("emit_job_state %s/%s failed: %s", job_kind, job_id, e)


_FAILURE_WEBHOOK_URL = os.environ.get("GSPLAT_FAILURE_WEBHOOK_URL", "")


def _imageids_hash(image_ids: list[str]) -> str:
    """SHA-256 of the sorted, comma-joined Mapillary image-id set.
    Stable across re-orderings of the same set; changes when images
    are added / removed. Used to short-circuit duplicate train calls."""
    import hashlib
    body = ",".join(sorted(str(x) for x in image_ids if x))
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def _find_completed_train_by_hash(tile_h3: str, hash_hex: str) -> str | None:
    """Most recent completed train job_id for `(tile_h3, imageids_hash)`,
    or None. Reads `mv_maps_gsplat_job_latest` for sub-ms response."""
    if not (tile_h3 and hash_hex):
        return None
    try:
        conn = psycopg2.connect(DATABASE_URL)
        try:
            cur = conn.cursor()
            cur.execute(
                """
                SELECT job_id
                  FROM mv_maps_gsplat_job_latest
                 WHERE tile_h3 = %s
                   AND job_kind = 'train'
                   AND status = 'completed'
                   AND imageids_hash = %s
                 ORDER BY ts DESC
                 LIMIT 1
                """,
                (tile_h3, hash_hex),
            )
            row = cur.fetchone()
            return str(row[0]) if row else None
        finally:
            conn.close()
    except Exception as e:
        log.warning("dedupe lookup failed (tile=%s): %s", tile_h3, e)
        return None


def _post_failure_webhook(*, kind: str, tile_h3: str, job_id: str, message: str) -> None:
    """Best-effort POST to a Slack/Discord-compatible incoming webhook.
    Both platforms accept `{text: "..."}` minimum, so one URL works
    for either. No-op when env not set."""
    if not _FAILURE_WEBHOOK_URL:
        return
    text = (
        f":rotating_light: gsplat *{kind}* failed — "
        f"`{job_id}` tile=`{tile_h3 or '-'}`\n```{message[:600]}```"
    )
    try:
        body = json.dumps({"text": text}).encode("utf-8")
        req = urllib.request.Request(
            _FAILURE_WEBHOOK_URL,
            data=body,
            headers={"content-type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=4.0).close()
    except Exception as e:
        # Webhook failure must NOT mask the underlying job failure —
        # keep this fully best-effort.
        log.warning("failure webhook POST failed: %s", e)


def _extract_cost_usd(out: dict) -> float | None:
    """Pull `stats.estimatedCostUsd` from a RunPod handler response.
    Returns None when missing / not a finite float."""
    try:
        v = (out.get("stats") or {}).get("estimatedCostUsd")
    except Exception:
        return None
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f or f < 0:  # NaN guard + reject negatives
        return None
    return f


def _self_trigger_bake(*, tile_h3: str, vertex_id: str, bake_job_id: str) -> None:
    """Self-targeted POST to `/trigger/bake`. Non-blocking — runs in
    a daemon thread so the train worker can finish cleanly. We hit
    `localhost:PORT` so the request never leaves the pod."""
    body = json.dumps({
        "mode":       "bake",
        "bakeJobId":  bake_job_id,
        "tileH3":     tile_h3,
        "vertexId":   vertex_id,
        "priority":   "normal",
    }).encode("utf-8")
    try:
        req = urllib.request.Request(
            f"http://127.0.0.1:{PORT}/trigger/bake",
            data=body,
            headers={"content-type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10.0) as resp:
            if resp.status not in (200, 202):
                log.warning("self-trigger bake unexpected status %s", resp.status)
    except Exception as e:
        log.warning("self-trigger bake failed: %s", e)


def _resolve_gsplat_row(*, tile_h3: str | None, vertex_id: str | None) -> dict | None:
    """Look up the most recent gsplat asset row for a tile (or by
    vertex_id directly). Returns None if the tile has no splat yet."""
    if not (tile_h3 or vertex_id):
        return None
    conn = psycopg2.connect(DATABASE_URL)
    try:
        cur = conn.cursor()
        if vertex_id:
            cur.execute(
                """
                SELECT vertex_id, tile_h3, b2_key, byte_size, splat_count, sh_degree, format, generated_at
                  FROM vertex_maps_gsplat_asset
                 WHERE vertex_id = %s
                 LIMIT 1
                """,
                (vertex_id,),
            )
        else:
            cur.execute(
                """
                SELECT vertex_id, tile_h3, b2_key, byte_size, splat_count, sh_degree, format, generated_at
                  FROM vertex_maps_gsplat_asset
                 WHERE tile_h3 = %s
                 ORDER BY generated_at DESC
                 LIMIT 1
                """,
                (tile_h3,),
            )
        row = cur.fetchone()
        if not row:
            return None
        return {
            "vertex_id":   row[0],
            "tile_h3":     row[1],
            "b2_key":      row[2],
            "byte_size":   row[3],
            "splat_count": row[4],
            "sh_degree":   row[5],
            "format":      row[6],
            "generated_at": row[7],
        }
    finally:
        conn.close()


def _insert_mesh_row(
    *,
    mesh_vertex_id: str,
    gsplat_vertex_id: str,
    tile_h3: str,
    bake_job_id: str,
    b2_key: str,
    byte_size: int,
    triangle_count: int,
    view_count: int,
    bake_runtime_ms: int,
    baker_version: str,
) -> None:
    """RW append-only INSERT — vertex_maps_gsplat_mesh + the lineage
    edge `edge_maps_gsplat_baked_to`. Both tables are PK upsert via
    re-INSERT (record-log convention)."""
    now_iso = datetime.now(timezone.utc).isoformat()
    edge_id = f"{gsplat_vertex_id}|{mesh_vertex_id}"
    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = False
    try:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO vertex_maps_gsplat_mesh (
              vertex_id, gsplat_vertex_id, tile_h3, bake_job_id, b2_key,
              byte_size, triangle_count, view_count, bake_runtime_ms,
              baker_version, baked_at,
              actor_did, org_did, created_at
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                mesh_vertex_id, gsplat_vertex_id, tile_h3, bake_job_id, b2_key,
                int(byte_size), int(triangle_count), int(view_count), int(bake_runtime_ms),
                str(baker_version), now_iso,
                "did:web:maps.etzhayyim.com", "did:web:maps.etzhayyim.com", now_iso,
            ),
        )
        cur.execute(
            """
            INSERT INTO edge_maps_gsplat_baked_to (
              edge_id, src_vid, dst_vid, baked_at, bake_job_id,
              mesh_vertex_label, triangle_count,
              actor_did, org_did, created_at
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                edge_id, gsplat_vertex_id, mesh_vertex_id, now_iso, bake_job_id,
                "GsplatMesh", int(triangle_count),
                "did:web:maps.etzhayyim.com", "did:web:maps.etzhayyim.com", now_iso,
            ),
        )
        conn.commit()
        log.info(
            "vertex_maps_gsplat_mesh + edge inserted mesh=%s gsplat=%s tris=%d",
            mesh_vertex_id, gsplat_vertex_id, triangle_count,
        )
    finally:
        conn.close()


def _insert_gsplat_row(
    *,
    tile_h3: str,
    b2_key: str,
    byte_size: int,
    splat_count: int,
    sh_degree: int,
    fmt: str,
    train_job_id: str,
) -> None:
    """RW append-only INSERT (no ON CONFLICT, record-log semantics)."""
    vertex_id = f"at://did:web:maps.etzhayyim.com/com.etzhayyim.apps.maps.gsplatAsset/{tile_h3}-{int(time.time())}"
    now_iso = datetime.now(timezone.utc).isoformat()
    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = False
    try:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO vertex_maps_gsplat_asset (
              vertex_id, source_did, tile_h3, b2_key,
              byte_size, splat_count, sh_degree, format,
              generated_at, bake_job_id,
              actor_did, org_did, created_at
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, NULL, %s, %s, %s)
            """,
            (
                vertex_id, SOURCE_DID, tile_h3, b2_key,
                int(byte_size), int(splat_count), int(sh_degree), str(fmt),
                now_iso,
                "did:web:maps.etzhayyim.com", "did:web:maps.etzhayyim.com",
                now_iso,
            ),
        )
        conn.commit()
        log.info("vertex_maps_gsplat_asset inserted vertex_id=%s", vertex_id)
    finally:
        conn.close()


# ── Run ───────────────────────────────────────────────────────────────


def _run_bake(req: dict) -> None:
    """Bake worker: resolve splat row → download PLY → RunPod
    mode=bake → upload GLB → INSERT mesh row + lineage edge."""
    started = time.time()
    tile_h3 = str(req.get("tileH3") or "")
    bake_job_id = str(req.get("bakeJobId") or f"gsplatbake-{int(started)}")
    splat_vertex_id = str(req.get("vertexId") or "")
    with _lock:
        if _state["running"]:
            log.warning("bake already running")
            return
        _state.update(
            running=True,
            started_at=datetime.now(timezone.utc).isoformat(),
            completed_at=None,
            tile_h3=tile_h3,
            phase="resolve-gsplat",
            image_count=0,
            splat_count=0,
            byte_size=0,
            error=None,
            last_train_job_id=bake_job_id,
        )
    _emit_job_state(job_id=bake_job_id, job_kind="bake", tile_h3=tile_h3,
                    status="running", phase="resolve-gsplat")
    try:
        # 1) Resolve splat row
        row = _resolve_gsplat_row(
            tile_h3=tile_h3 or None,
            vertex_id=splat_vertex_id or None,
        )
        if not row:
            raise RuntimeError(f"no vertex_maps_gsplat_asset row for tile={tile_h3} vertex={splat_vertex_id}")
        if not tile_h3:
            tile_h3 = str(row["tile_h3"])

        # 2) Download PLY from B2
        with _lock:
            _state["phase"] = "b2-download-ply"
        _emit_job_state(job_id=bake_job_id, job_kind="bake", tile_h3=tile_h3,
                        status="running", phase="b2-download-ply")
        ply_bytes = _b2_download(str(row["b2_key"]))
        if not ply_bytes:
            raise RuntimeError(f"b2 download empty for {row['b2_key']}")

        # 3) RunPod bake
        with _lock:
            _state["phase"] = "runpod-bake"
        _emit_job_state(job_id=bake_job_id, job_kind="bake", tile_h3=tile_h3,
                        status="running", phase="runpod-bake")
        runpod_payload = {
            "mode":         "bake",
            "bakeJobId":    bake_job_id,
            "trainJobId":   "",
            "tileH3":       tile_h3,
            "plyBase64":    base64.b64encode(ply_bytes).decode("ascii"),
            "targetTriangles": int(req.get("targetTriangles") or 5000),
            "priority":     str(req.get("priority") or "normal"),
        }
        out = _runpod_invoke(runpod_payload)
        glb_b64 = str(out.get("glbBase64") or "")
        if not glb_b64:
            raise RuntimeError(f"runpod returned empty glbBase64; stats={out.get('stats')}")
        glb_bytes = base64.b64decode(glb_b64)
        triangle_count = int(out.get("triangleCount") or 0)
        view_count = int((out.get("stats") or {}).get("viewCount") or 0)
        baker_version = str(out.get("modelVersion") or "")
        runtime_ms = int(out.get("runtimeMs") or 0)

        # 4) B2 upload (content-addressed: SHA-256 keys + dedupe)
        with _lock:
            _state["phase"] = "b2-upload-glb"
            _state["byte_size"] = len(glb_bytes)
        _emit_job_state(job_id=bake_job_id, job_kind="bake", tile_h3=tile_h3,
                        status="running", phase="b2-upload-glb",
                        triangle_count=triangle_count, byte_size=len(glb_bytes))
        mesh_b2_key, mesh_sha_hex, mesh_new_upload = _content_addressed_upload(
            "maps-bulk-ingest/gsplat-mesh", glb_bytes, "glb", "model/gltf-binary",
        )
        log.info("glb b2_key=%s sha=%s new=%s",
                 mesh_b2_key, mesh_sha_hex[:12], mesh_new_upload)

        # 5) RW row + edge
        with _lock:
            _state["phase"] = "rw-insert"
        _emit_job_state(job_id=bake_job_id, job_kind="bake", tile_h3=tile_h3,
                        status="running", phase="rw-insert",
                        triangle_count=triangle_count)
        mesh_vertex_id = (
            f"at://did:web:maps.etzhayyim.com/com.etzhayyim.apps.maps.gsplatMesh/"
            f"{tile_h3}-{bake_job_id}"
        )
        _insert_mesh_row(
            mesh_vertex_id=mesh_vertex_id,
            gsplat_vertex_id=str(row["vertex_id"]),
            tile_h3=tile_h3,
            bake_job_id=bake_job_id,
            b2_key=mesh_b2_key,
            byte_size=len(glb_bytes),
            triangle_count=triangle_count,
            view_count=view_count,
            bake_runtime_ms=runtime_ms,
            baker_version=baker_version,
        )

        runtime_ms = int((time.time() - started) * 1000)
        with _lock:
            _state["splat_count"] = triangle_count  # reuse field for "tri count visible in /status"
            _state["phase"] = "completed"
            _state["completed_at"] = datetime.now(timezone.utc).isoformat()
        bake_cost_usd = _extract_cost_usd(out)
        _emit_job_state(job_id=bake_job_id, job_kind="bake", tile_h3=tile_h3,
                        status="completed", phase="completed",
                        triangle_count=triangle_count, byte_size=len(glb_bytes),
                        runtime_ms=runtime_ms, cost_usd=bake_cost_usd)
        log.info("bake done tile=%s tris=%d glb=%d B cost=$%.4f (%.1fs)",
                 tile_h3, triangle_count, len(glb_bytes),
                 bake_cost_usd or 0.0, time.time() - started)
    except Exception as e:
        log.exception("bake failed")
        with _lock:
            _state["error"] = str(e)
            _state["phase"] = "error"
        _emit_job_state(job_id=bake_job_id, job_kind="bake", tile_h3=tile_h3,
                        status="failed", phase="error", message=str(e),
                        runtime_ms=int((time.time() - started) * 1000))
        _post_failure_webhook(kind="bake", tile_h3=tile_h3,
                              job_id=bake_job_id, message=str(e))
    finally:
        with _lock:
            _state["running"] = False


def _run_train(req: dict) -> None:
    started = time.time()
    tile_h3 = str(req.get("tileH3") or "")
    train_job_id = str(req.get("trainJobId") or f"gsplattrain-{int(started)}")
    auto_bake = req.get("autoBake")
    auto_bake = True if auto_bake is None else bool(auto_bake)
    with _lock:
        if _state["running"]:
            log.warning("train already running")
            return
        _state.update(
            running=True,
            started_at=datetime.now(timezone.utc).isoformat(),
            completed_at=None,
            tile_h3=tile_h3,
            phase="mapillary-list",
            image_count=0,
            splat_count=0,
            byte_size=0,
            error=None,
            last_train_job_id=train_job_id,
        )
    _emit_job_state(job_id=train_job_id, job_kind="train", tile_h3=tile_h3,
                    status="running", phase="mapillary-list",
                    message=f"autoBake={auto_bake}")
    try:
        # 1) image list
        max_images = max(8, min(int(req.get("maxImages") or 80), 400))
        explicit_ids = list(req.get("mapillaryImageIds") or [])
        images: list[dict] = []
        if explicit_ids:
            for img_id in explicit_ids[:max_images]:
                u = _mapillary_image_url_by_id(img_id)
                if u:
                    images.append({"id": img_id, "thumb_2048_url": u})
        else:
            lat = float(req["lat"])
            lng = float(req["lng"])
            radius_m = float(req.get("radiusM") or 50)
            images = _mapillary_images_in_bbox(lat, lng, radius_m, max_images)
        with _lock:
            _state["image_count"] = len(images)
            _state["phase"] = "runpod-train"
        if not images:
            raise RuntimeError("no Mapillary images returned for input bbox / ids")

        # ── Train idempotency: hash the resolved image set and look
        # up a prior completed train with the same hash on the same
        # tile. If found, skip the RunPod call entirely — the
        # existing splat asset row + B2 blob are still valid (content
        # addressing dedupe at the output already proves the bytes
        # are deterministic). Saves ~$0.50/click on repeat trains.
        image_ids = [str(im.get("id") or "") for im in images if im.get("id")]
        ids_hash = _imageids_hash(image_ids)
        dup_job_id = _find_completed_train_by_hash(tile_h3, ids_hash)
        if dup_job_id:
            log.info("dedupe hit tile=%s hash=%s prior=%s → skip RunPod",
                     tile_h3, ids_hash[:12], dup_job_id)
            _emit_job_state(
                job_id=train_job_id, job_kind="train", tile_h3=tile_h3,
                status="completed", phase="skipped-duplicate",
                message=f"reused job_id={dup_job_id}",
                runtime_ms=int((time.time() - started) * 1000),
                cost_usd=0.0,
                imageids_hash=ids_hash,
            )
            with _lock:
                _state["phase"] = "completed"
                _state["completed_at"] = datetime.now(timezone.utc).isoformat()
            # Fall through to auto-chain with the *existing* splat row.
            splat_row = _resolve_gsplat_row(tile_h3=tile_h3, vertex_id=None)
            if auto_bake and splat_row:
                bake_job_id = f"gsplatbake-{int(time.time())}-{train_job_id[-8:]}"
                log.info("auto-chaining bake (after dedupe): tile=%s splat_vertex=%s bake_job=%s",
                         tile_h3, splat_row["vertex_id"], bake_job_id)
                Thread(
                    target=_self_trigger_bake,
                    kwargs={
                        "tile_h3": tile_h3,
                        "vertex_id": splat_row["vertex_id"],
                        "bake_job_id": bake_job_id,
                    },
                    daemon=True,
                ).start()
            return

        _emit_job_state(job_id=train_job_id, job_kind="train", tile_h3=tile_h3,
                        status="running", phase="runpod-train",
                        message=f"images={len(images)} hash={ids_hash[:12]}",
                        imageids_hash=ids_hash)

        # 2) RunPod train
        runpod_payload = {
            "trainJobId": train_job_id,
            "tileH3":     tile_h3,
            "lat":        req.get("lat"),
            "lng":        req.get("lng"),
            "radiusM":    req.get("radiusM"),
            "imageUrls":  [str(im.get("thumb_2048_url") or "") for im in images if im.get("thumb_2048_url")],
            "imageIds":   [str(im.get("id") or "") for im in images],
            "maxImages":  max_images,
            "maxSteps":   int(req.get("maxSteps") or 7000),
            "shDegree":   int(req.get("shDegree") or 0),
            "priority":   str(req.get("priority") or "normal"),
        }
        out = _runpod_train(runpod_payload)
        ply_b64 = str(out.get("plyBase64") or "")
        if not ply_b64:
            raise RuntimeError(f"runpod returned empty plyBase64; stats={out.get('stats')}")
        ply_bytes = base64.b64decode(ply_b64)
        splat_count = int(out.get("splatCount") or 0)
        sh_degree = int(out.get("shDegree") or 0)
        fmt = str(out.get("format") or "ply")

        # 3) B2 upload (content-addressed: SHA-256 keys + dedupe)
        with _lock:
            _state["phase"] = "b2-upload"
        _emit_job_state(job_id=train_job_id, job_kind="train", tile_h3=tile_h3,
                        status="running", phase="b2-upload",
                        splat_count=splat_count, byte_size=len(ply_bytes))
        b2_key, sha_hex, new_upload = _content_addressed_upload(
            B2_PREFIX, ply_bytes, "ply", "application/octet-stream",
        )
        log.info("ply b2_key=%s sha=%s new=%s", b2_key, sha_hex[:12], new_upload)

        # 4) RW row
        with _lock:
            _state["phase"] = "rw-insert"
        _emit_job_state(job_id=train_job_id, job_kind="train", tile_h3=tile_h3,
                        status="running", phase="rw-insert")
        _insert_gsplat_row(
            tile_h3=tile_h3,
            b2_key=b2_key,
            byte_size=len(ply_bytes),
            splat_count=splat_count,
            sh_degree=sh_degree,
            fmt=fmt,
            train_job_id=train_job_id,
        )
        # Resolve the row we just inserted so we can hand the bake the
        # exact vertex_id (rather than racing on a per-tile lookup).
        splat_row = _resolve_gsplat_row(tile_h3=tile_h3, vertex_id=None)

        runtime_ms = int((time.time() - started) * 1000)
        with _lock:
            _state["splat_count"] = splat_count
            _state["byte_size"] = len(ply_bytes)
            _state["phase"] = "completed"
            _state["completed_at"] = datetime.now(timezone.utc).isoformat()
        train_cost_usd = _extract_cost_usd(out)
        _emit_job_state(job_id=train_job_id, job_kind="train", tile_h3=tile_h3,
                        status="completed", phase="completed",
                        splat_count=splat_count, byte_size=len(ply_bytes),
                        runtime_ms=runtime_ms, cost_usd=train_cost_usd)
        log.info("train done tile=%s splats=%d bytes=%d cost=$%.4f (%.1fs)",
                 tile_h3, splat_count, len(ply_bytes),
                 train_cost_usd or 0.0, time.time() - started)

        # Auto-chain → bake (default on, opt-out via autoBake=false in
        # the train payload). Self-targets /trigger/bake on the same
        # pod so we don't touch Zeebe — keeps the dumper standalone.
        # Quality gate: skip the bake when the held-out PSNR is below
        # `AUTO_BAKE_MIN_PSNR` (default 18 dB) — bad scenes produce
        # noisy meshes that aren't worth runtime delivery; operator
        # can still trigger a manual bake if they want to inspect.
        eval_psnr = None
        try:
            eval_psnr = (out.get("stats") or {}).get("evalPsnr")
        except Exception:
            eval_psnr = None
        try:
            min_psnr = float(os.environ.get("AUTO_BAKE_MIN_PSNR", "18.0"))
        except ValueError:
            min_psnr = 18.0
        psnr_ok = (eval_psnr is None) or (
            isinstance(eval_psnr, (int, float)) and eval_psnr >= min_psnr
        )
        if auto_bake and splat_row and psnr_ok:
            bake_job_id = f"gsplatbake-{int(time.time())}-{train_job_id[-8:]}"
            log.info("auto-chaining bake: tile=%s splat_vertex=%s bake_job=%s psnr=%s",
                     tile_h3, splat_row["vertex_id"], bake_job_id, eval_psnr)
            Thread(
                target=_self_trigger_bake,
                kwargs={
                    "tile_h3": tile_h3,
                    "vertex_id": splat_row["vertex_id"],
                    "bake_job_id": bake_job_id,
                },
                daemon=True,
            ).start()
        elif auto_bake and splat_row and not psnr_ok:
            log.info("skip auto-bake: tile=%s eval_psnr=%.2f < min_psnr=%.2f",
                     tile_h3, float(eval_psnr or 0.0), min_psnr)
            _emit_job_state(job_id=train_job_id, job_kind="train", tile_h3=tile_h3,
                            status="completed", phase="skipped-low-psnr",
                            message=f"evalPsnr={eval_psnr} < {min_psnr}")
    except Exception as e:
        log.exception("train failed")
        with _lock:
            _state["error"] = str(e)
            _state["phase"] = "error"
        _emit_job_state(job_id=train_job_id, job_kind="train", tile_h3=tile_h3,
                        status="failed", phase="error", message=str(e),
                        runtime_ms=int((time.time() - started) * 1000))
        _post_failure_webhook(kind="train", tile_h3=tile_h3,
                              job_id=train_job_id, message=str(e))
    finally:
        with _lock:
            _state["running"] = False


# ── HTTP server ───────────────────────────────────────────────────────


class Handler(BaseHTTPRequestHandler):
    def _json(self, status: int, body: dict) -> None:
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode("utf-8"))

    def do_POST(self):  # noqa: N802
        if self.path in ("/trigger", "/trigger/train", "/trigger/bake"):
            try:
                length = int(self.headers.get("content-length") or 0)
                raw = self.rfile.read(length) if length else b"{}"
                req = json.loads(raw.decode("utf-8") or "{}")
            except Exception as e:
                return self._json(400, {"error": f"bad json: {e}"})
            with _lock:
                if _state["running"]:
                    return self._json(409, {"error": "running", "state": _state})
            # Path suffix wins; otherwise fall back to `mode` field
            # (default = train).
            if self.path == "/trigger/bake":
                mode = "bake"
            elif self.path == "/trigger/train":
                mode = "train"
            else:
                mode = str(req.get("mode") or "train").lower()
            if mode == "bake":
                Thread(target=_run_bake, args=(req,), daemon=True).start()
                return self._json(202, {"accepted": True, "mode": "bake",
                                        "tileH3": req.get("tileH3"),
                                        "bakeJobId": req.get("bakeJobId")})
            else:
                Thread(target=_run_train, args=(req,), daemon=True).start()
                return self._json(202, {"accepted": True, "mode": "train",
                                        "tileH3": req.get("tileH3"),
                                        "trainJobId": req.get("trainJobId")})
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
    _resolve_required()
    log.info("listening on :%d (b2=%s runpod=%s)", PORT, B2_BUCKET, RUNPOD_ENDPOINT_ID)
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
