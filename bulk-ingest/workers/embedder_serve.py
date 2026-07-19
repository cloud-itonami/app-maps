#!/usr/bin/env python3
"""Self-hosted text embedder for maps semantic search.

ADR-2605011500 §Phase-1.3 (no-CF-API path).

Loads BAAI/bge-base-en-v1.5 (768-dim, ~440 MB) once at startup via
sentence-transformers, exposes a tiny HTTP server with two endpoints:

  POST /embed
       body: {"texts": ["a", "b", ...]}                      (or {"text": "x"})
       resp: {"vectors": [[768 floats], ...], "model": "...", "dim": 768}

  GET  /health
       resp: {"ok": true, "ready": <bool>, "model": "...", "embedded_total": <int>}

CPU-only is fine — bge-base does ~50 ms / sentence on a single core, ~5 ms
amortised in a 32-batch. The pod sits behind a ClusterIP Service; the
backfill CronJob calls it via the in-cluster DNS name; the maps Worker
calls it via the new cf-tunnel `embedder.etzhayyim.com`.

ENV:
  EMBED_MODEL          — default 'BAAI/bge-base-en-v1.5' (768-dim)
                          alternatives: 'BAAI/bge-m3' (1024-dim, multilingual)
  EMBED_PORT           — default 8080
  EMBED_AUTH_TOKEN     — optional bearer; if set, /embed requires
                          Authorization: Bearer <token>. cf-tunnel routes
                          should set this so the tunnel itself is locked.
  EMBED_CACHE_DIR      — default /tmp/hf-cache (HF model cache)
  EMBED_MAX_BATCH      — default 64 (request batch hard cap)
  EMBED_MAX_TEXT_LEN   — default 1000 chars (truncate before encode)
"""
from __future__ import annotations

import json
import logging
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("embedder_serve")

EMBED_MODEL = os.environ.get("EMBED_MODEL", "BAAI/bge-base-en-v1.5")
EMBED_PORT = int(os.environ.get("EMBED_PORT", "8080"))
EMBED_AUTH_TOKEN = os.environ.get("EMBED_AUTH_TOKEN", "").strip()
EMBED_CACHE_DIR = os.environ.get("EMBED_CACHE_DIR", "/tmp/hf-cache")
EMBED_MAX_BATCH = int(os.environ.get("EMBED_MAX_BATCH", "64"))
EMBED_MAX_TEXT_LEN = int(os.environ.get("EMBED_MAX_TEXT_LEN", "1000"))

os.environ.setdefault("HF_HOME", EMBED_CACHE_DIR)
os.environ.setdefault("SENTENCE_TRANSFORMERS_HOME", EMBED_CACHE_DIR)
os.environ.setdefault("TRANSFORMERS_OFFLINE", "0")

_state = {
    "ready": False,
    "started_at": time.time(),
    "model": EMBED_MODEL,
    "dim": None,
    "embedded_total": 0,
    "errors": [],
}
_state_lock = Lock()
_model = None
_model_lock = Lock()


def _load_model() -> None:
    """Load sentence-transformers model (blocking, ~10-20s cold)."""
    global _model
    with _model_lock:
        if _model is not None:
            return
        log.info("loading model %s …", EMBED_MODEL)
        t0 = time.monotonic()
        from sentence_transformers import SentenceTransformer  # heavy import
        _model = SentenceTransformer(EMBED_MODEL, cache_folder=EMBED_CACHE_DIR)
        # bge-base-en-v1.5 → 768; bge-m3 → 1024
        dim = _model.get_sentence_embedding_dimension()
        with _state_lock:
            _state["ready"] = True
            _state["dim"] = int(dim)
        log.info("model loaded in %.1fs (dim=%d)", time.monotonic() - t0, dim)


def _encode(texts: list[str]) -> list[list[float]]:
    if _model is None:
        _load_model()
    assert _model is not None
    # bge-* models recommend `normalize_embeddings=True` for cosine sim.
    vecs = _model.encode(texts, normalize_embeddings=True, batch_size=32, show_progress_bar=False)
    out: list[list[float]] = []
    for v in vecs:
        out.append([float(x) for x in v.tolist()])
    return out


def _truncate(s: str) -> str:
    if not isinstance(s, str):
        return ""
    return s[:EMBED_MAX_TEXT_LEN]


def _auth_ok(handler: BaseHTTPRequestHandler) -> bool:
    if not EMBED_AUTH_TOKEN:
        return True
    h = handler.headers.get("Authorization", "")
    return h == f"Bearer {EMBED_AUTH_TOKEN}"


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, _format: str, *_args) -> None:
        return

    def _send_json(self, status: int, body: dict) -> None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            with _state_lock:
                snap = dict(_state)
                snap["errors"] = list(snap.get("errors", []))[-5:]
            self._send_json(200 if snap["ready"] else 503, snap)
            return
        self._send_json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/embed":
            self._send_json(404, {"error": "not found"})
            return
        if not _auth_ok(self):
            self._send_json(401, {"error": "unauthorized"})
            return
        try:
            length = int(self.headers.get("content-length") or "0")
            raw = self.rfile.read(length) if length > 0 else b"{}"
            payload = json.loads(raw.decode("utf-8"))
        except (ValueError, json.JSONDecodeError) as e:
            self._send_json(400, {"error": f"bad json: {e}"})
            return

        texts: list[str]
        if isinstance(payload.get("texts"), list):
            texts = [_truncate(t) for t in payload["texts"]]
        elif isinstance(payload.get("text"), str):
            texts = [_truncate(payload["text"])]
        else:
            self._send_json(400, {"error": "missing texts[] or text"})
            return

        if not texts:
            self._send_json(200, {"vectors": [], "model": EMBED_MODEL, "dim": _state.get("dim")})
            return
        if len(texts) > EMBED_MAX_BATCH:
            self._send_json(400, {"error": f"batch too large; max={EMBED_MAX_BATCH}"})
            return

        try:
            vectors = _encode(texts)
        except Exception as e:
            log.exception("encode failed")
            with _state_lock:
                _state["errors"].append(str(e))
            self._send_json(500, {"error": f"encode failed: {e}"})
            return

        with _state_lock:
            _state["embedded_total"] += len(vectors)
            dim = _state["dim"]

        self._send_json(200, {"vectors": vectors, "model": EMBED_MODEL, "dim": dim})


def main() -> int:
    log.info("embedder starting on 0.0.0.0:%d, model=%s", EMBED_PORT, EMBED_MODEL)
    # Warm up: load model on first request via lazy path. We could also
    # eager-load here so /health flips to ready before any request, at the
    # cost of a slower first start. Doing eager — readiness probe matters.
    try:
        _load_model()
    except Exception as e:
        log.exception("model load failed at startup; will retry on first request")
        with _state_lock:
            _state["errors"].append(f"startup load: {e}")

    httpd = ThreadingHTTPServer(("0.0.0.0", EMBED_PORT), _Handler)
    log.info("ready, serving …")
    httpd.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
