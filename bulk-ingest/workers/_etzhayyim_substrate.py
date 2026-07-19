"""Substrate abstraction for maps bulk-ingest workers.

Per Charter Rider §1 + ADR-2605172000 (kotoba state substrate), all
``com.etzhayyim.apps.maps.*`` writes must land on AT Protocol MST + IPFS +
Base L2 anchor (the etzhayyim primary substrate). The pre-migration
workers in this directory write directly to RisingWave via psycopg —
a centralized PostgreSQL surface explicitly prohibited by the
substrate boundary table in `/CLAUDE.md`.

This module provides a single seam (``open_substrate_writer``) that
each worker uses instead of ``psycopg2.connect()`` directly. The
returned writer dispatches based on ``ETZHAYYIM_SUBSTRATE_MODE``:

* ``mst`` (post-migration default once Council ratifies) — writes hit
  the PDS at ``com.etzhayyim.apps.maps.{label}.create`` XRPC; the PDS commit
  pipeline projects to MST + pins to IPFS + anchors to Base L2.
* ``rw`` (transitional, current default while the bulk feeds are
  still RW-resident) — writes go to ``vertex_spatial`` via psycopg
  exactly as before, with a deprecation warning logged on startup.

Workers that adopt this wrapper are forward-compatible: flipping
``ETZHAYYIM_SUBSTRATE_MODE=mst`` (Worker secret / pod env) cuts them
over to the substrate without touching the worker source. The legacy
``DATABASE_URL`` env stays valid in ``rw`` mode; in ``mst`` mode the
worker needs ``ETZHAYYIM_PDS_URL`` + ``ETZHAYYIM_PDS_HANDLE`` +
``ETZHAYYIM_PDS_APP_PASSWORD`` instead.

Per ADR-2605172000. See also `/CHARTER-RIDER.md` §1 (substrate
boundary), `/CLAUDE.md` § "Substrate boundary".
"""
from __future__ import annotations

import json
import logging
import os
import sys
from abc import ABC, abstractmethod
from contextlib import contextmanager
from typing import Any, Iterator, Sequence
from urllib import error as urlerror
from urllib import request as urlrequest


log = logging.getLogger("etzhayyim.substrate")


# ─── Public interface ──────────────────────────────────────────────


class SubstrateWriter(ABC):
    """Abstract write surface for the etzhayyim primary substrate."""

    @abstractmethod
    def upsert_vertex_spatial(
        self, rows: Sequence[dict[str, Any]], *, conflict_key: str = "vertex_id"
    ) -> int:
        """Upsert N rows into the spatial graph.

        Returns the number of rows that landed. Both backends are
        idempotent on ``conflict_key``.
        """

    @abstractmethod
    def upsert_table(
        self,
        table: str,
        rows: Sequence[dict[str, Any]],
        *,
        conflict_key: str | None = None,
    ) -> int:
        """Upsert N rows into an arbitrary table (auxiliary indexes)."""

    @abstractmethod
    def close(self) -> None:
        """Release the underlying connection or session."""


@contextmanager
def open_substrate_writer() -> Iterator[SubstrateWriter]:
    """Open a substrate writer per ``ETZHAYYIM_SUBSTRATE_MODE``.

    Usage::

        with open_substrate_writer() as writer:
            writer.upsert_vertex_spatial([...])
    """
    mode = (os.environ.get("ETZHAYYIM_SUBSTRATE_MODE") or "rw").lower()
    if mode == "mst":
        writer: SubstrateWriter = _MstSubstrateWriter()
    elif mode == "rw":
        writer = _RwSubstrateWriter()
    elif mode == "kotoba":
        writer = _KotobaSubstrateWriter()
    else:
        raise ValueError(
            f"ETZHAYYIM_SUBSTRATE_MODE={mode!r} is not recognised. "
            "Allowed: 'kotoba' (canonical Datom log, ADR-2606064500), "
            "'mst' (AT Protocol ingress), 'rw' (transitional RisingWave)."
        )
    try:
        yield writer
    finally:
        writer.close()


# ─── kotoba backend (canonical Datom log via kg.ingest_batch, ADR-2606064500) ───


class _KotobaSubstrateWriter(SubstrateWriter):
    """Writes land in the kotoba Datom log as ``:feature/*`` entities (ADR-2606064500 R2).

    Each ``vertex_spatial`` row is mapped (``_kotoba_feature.row_to_entity``) to a
    ``:feature/*`` entity — the 51 legacy labels collapse onto ``:feature/label``, the H3-cell
    spatial index (``:feature.cell/rN``) is stamped from the centroid — and POSTed to
    ``com.etzhayyim.apps.kotobase.kg.ingest_batch``.

    GATED (ADR-2606064500 G4/G7): the write is a member/operator-DID-signed CACAO batch — it
    requires ``KOTOBA_ENDPOINT`` + ``KOTOBA_AUTH`` (member bearer; the pod holds no platform
    key, no-server-key) AND ``MAPS_OPERATOR_GATE=1`` (operator attestation). Absent any of
    these, construction RAISES so a dumper flipped to ``kotoba`` mode without the gate fails
    loudly rather than silently dropping data.
    """

    def __init__(self) -> None:
        from _kotoba_feature import rows_to_batch  # local import keeps the seam self-contained
        self._rows_to_batch = rows_to_batch
        self.endpoint = (os.environ.get("KOTOBA_ENDPOINT") or "").rstrip("/")
        self.auth = os.environ.get("KOTOBA_AUTH") or ""
        gate = os.environ.get("MAPS_OPERATOR_GATE")
        if gate != "1":
            raise RuntimeError(
                "ETZHAYYIM_SUBSTRATE_MODE=kotoba is outward-gated (ADR-2606064500 G7): set "
                "MAPS_OPERATOR_GATE=1 with operator attestation to enable live ingest."
            )
        if not self.endpoint or not self.auth:
            raise RuntimeError(
                "ETZHAYYIM_SUBSTRATE_MODE=kotoba requires KOTOBA_ENDPOINT + KOTOBA_AUTH "
                "(member/operator DID bearer; the pod holds no server key — no-server-key)."
            )
        self.nsid = os.environ.get(
            "KOTOBA_INGEST_NSID", "com.etzhayyim.apps.kotobase.kg.ingest_batch"
        )
        # The H3-cell spatial index (:feature.cell/rN) is what makes a feature queryable by the
        # cell-based getChunk read (ADR-2606064500 §2). It is stamped only when `h3` is
        # importable in this pod. Without it, features still ingest but carry NO cell index →
        # they are invisible to getChunk until re-stamped. Warn loudly so the operator ships an
        # image with h3 (or accepts index-less ingest deliberately).
        try:
            import h3  # noqa: F401
            self._h3 = True
        except Exception:
            self._h3 = False
            log.warning(
                "etzhayyim.substrate: kotoba mode — `h3` NOT importable; features will ingest "
                "WITHOUT the :feature.cell/* spatial index and will NOT be queryable by the "
                "cell-based getChunk read until re-stamped. Ship the dumper image with `h3`."
            )
        log.warning(
            "etzhayyim.substrate: kotoba mode active (endpoint=<redacted>, h3=%s). Writes land "
            "in the canonical Datom log via %s (member-signed).", self._h3, self.nsid,
        )

    def _post(self, body: dict[str, Any]) -> None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        req = urlrequest.Request(
            f"{self.endpoint}/xrpc/{self.nsid}",
            data=data,
            headers={"content-type": "application/json",
                     "authorization": f"Bearer {self.auth}"},
            method="POST",
        )
        with urlrequest.urlopen(req, timeout=30) as resp:
            if resp.status >= 300:
                raise RuntimeError(f"kotoba ingest failed: HTTP {resp.status}")

    def upsert_vertex_spatial(
        self, rows: Sequence[dict[str, Any]], *, conflict_key: str = "vertex_id"
    ) -> int:
        if not rows:
            return 0
        batch = self._rows_to_batch(rows)
        if not batch["entities"]:
            return 0
        # chunk to keep request bodies bounded; :feature/id unique-identity gives idempotency
        # (upsert-by-assertion), so no DELETE+INSERT is needed.
        total = 0
        CHUNK = 500
        ents = batch["entities"]
        for i in range(0, len(ents), CHUNK):
            self._post({"entities": ents[i:i + CHUNK]})
            total += len(ents[i:i + CHUNK])
        return total

    def upsert_table(
        self,
        table: str,
        rows: Sequence[dict[str, Any]],
        *,
        conflict_key: str | None = None,
    ) -> int:
        # Mapped aux tables (GTFS vertex_maps_trip / vertex_maps_stop_time → :transit.*,
        # maps-transit-ontology) ingest like features. Un-mapped aux tables (gsplat registries,
        # GTFS-RT) have no kotoba schema yet — raise LOUDLY rather than silently drop, so a
        # dumper relying on one is not flipped to kotoba mode prematurely.
        from _kotoba_feature import aux_rows_to_batch
        if not rows:
            return 0
        batch = aux_rows_to_batch(table, rows)
        if batch is None:
            raise NotImplementedError(
                f"kotoba mode has no mapping for auxiliary table {table!r} yet (ADR-2606064500 "
                "R2 follow-up). Keep this dumper on rw/mst until its kotoba schema lands."
            )
        ents = batch["entities"]
        if not ents:
            return 0
        total = 0
        CHUNK = 500
        for i in range(0, len(ents), CHUNK):
            self._post({"entities": ents[i:i + CHUNK]})
            total += len(ents[i:i + CHUNK])
        return total

    def close(self) -> None:
        pass


# ─── MST backend (AT Protocol PDS → MST + IPFS + Base L2 anchor) ───


class _MstSubstrateWriter(SubstrateWriter):
    """Writes land via PDS XRPC; PDS commits to MST and pins to IPFS.

    NSID mapping: ``vertex_spatial`` rows are projected onto the
    ``com.etzhayyim.apps.maps.{label}.create`` lexicon (one record per row).
    The label is read from ``row['label']`` and lower-cased; e.g.
    ``Airport`` → ``com.etzhayyim.apps.maps.airport.create``.
    """

    def __init__(self) -> None:
        self.pds_url = os.environ.get("ETZHAYYIM_PDS_URL", "https://atproto.etzhayyim.com").rstrip("/")
        self.handle = os.environ.get("ETZHAYYIM_PDS_HANDLE")
        self.app_password = os.environ.get("ETZHAYYIM_PDS_APP_PASSWORD")
        if not self.handle or not self.app_password:
            raise RuntimeError(
                "ETZHAYYIM_SUBSTRATE_MODE=mst requires ETZHAYYIM_PDS_HANDLE + "
                "ETZHAYYIM_PDS_APP_PASSWORD to be configured."
            )
        self._session: dict[str, Any] | None = None
        self._refresh_session()

    def _refresh_session(self) -> None:
        payload = json.dumps({
            "identifier": self.handle,
            "password": self.app_password,
        }).encode("utf-8")
        req = urlrequest.Request(
            f"{self.pds_url}/xrpc/com.atproto.server.createSession",
            data=payload,
            headers={"content-type": "application/json"},
            method="POST",
        )
        with urlrequest.urlopen(req, timeout=15) as resp:
            self._session = json.loads(resp.read().decode("utf-8"))
        log.info("etzhayyim.substrate: PDS session opened did=%s", self._session.get("did"))

    def _post_record(self, collection: str, record: dict[str, Any]) -> None:
        assert self._session is not None
        body = json.dumps({
            "repo": self._session["did"],
            "collection": collection,
            "record": record,
        }).encode("utf-8")
        req = urlrequest.Request(
            f"{self.pds_url}/xrpc/com.atproto.repo.createRecord",
            data=body,
            headers={
                "content-type": "application/json",
                "authorization": f"Bearer {self._session['accessJwt']}",
            },
            method="POST",
        )
        try:
            with urlrequest.urlopen(req, timeout=30) as resp:
                resp.read()  # drain
        except urlerror.HTTPError as e:
            if e.code == 401:
                self._refresh_session()
                with urlrequest.urlopen(req, timeout=30) as resp:
                    resp.read()
            else:
                raise

    def upsert_vertex_spatial(
        self, rows: Sequence[dict[str, Any]], *, conflict_key: str = "vertex_id"
    ) -> int:
        n = 0
        for row in rows:
            label = str(row.get("label") or "").lower().strip()
            if not label:
                log.warning("etzhayyim.substrate: skip row without label vertex_id=%s", row.get("vertex_id"))
                continue
            collection = f"com.etzhayyim.apps.maps.{label}"
            self._post_record(collection, row)
            n += 1
        return n

    def upsert_table(
        self,
        table: str,
        rows: Sequence[dict[str, Any]],
        *,
        conflict_key: str | None = None,
    ) -> int:
        # Auxiliary tables (e.g. vertex_maps_trip, vertex_maps_stop_time)
        # land on the `com.etzhayyim.apps.maps.aux.{table}` lexicon namespace
        # until per-table lexicons are registered (P3 follow-up).
        collection = f"com.etzhayyim.apps.maps.aux.{table}"
        for row in rows:
            self._post_record(collection, row)
        return len(rows)

    def close(self) -> None:
        self._session = None


# ─── RW backend (transitional, current production path) ────────────


class _RwSubstrateWriter(SubstrateWriter):
    """psycopg2-based fallback for the transitional period.

    Behaviour is intentionally identical to the pre-migration code so
    that flipping a worker over to ``open_substrate_writer`` is a pure
    refactor (zero behavioural change in ``rw`` mode).
    """

    def __init__(self) -> None:
        try:
            import psycopg2  # noqa: WPS433 — local import keeps the substrate boundary intent visible
            import psycopg2.extras  # noqa: WPS433
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError(
                "ETZHAYYIM_SUBSTRATE_MODE=rw requires psycopg2 to be importable."
            ) from exc

        dsn = os.environ.get("DATABASE_URL")
        if not dsn:
            raise RuntimeError("DATABASE_URL must be set when ETZHAYYIM_SUBSTRATE_MODE=rw.")

        log.warning(
            "etzhayyim.substrate: rw mode active (DATABASE_URL=<redacted>). "
            "This is transitional per ADR-2605172000; flip "
            "ETZHAYYIM_SUBSTRATE_MODE=mst once Council ratifies."
        )
        self._psycopg2 = psycopg2
        self._extras = psycopg2.extras
        self._conn = psycopg2.connect(dsn)
        self._conn.autocommit = True

    def upsert_vertex_spatial(
        self, rows: Sequence[dict[str, Any]], *, conflict_key: str = "vertex_id"
    ) -> int:
        if not rows:
            return 0
        cols = list(rows[0].keys())
        col_sql = ", ".join(cols)
        placeholders = ", ".join(["%s"] * len(cols))
        update_clause = ", ".join(
            f"{c}=excluded.{c}" for c in cols if c != conflict_key
        )
        sql = (
            f"INSERT INTO vertex_spatial ({col_sql}) "
            f"VALUES ({placeholders}) "
            f"ON CONFLICT ({conflict_key}) DO UPDATE SET {update_clause}"
        )
        values = [tuple(row[c] for c in cols) for row in rows]
        with self._conn.cursor() as cur:
            self._extras.execute_batch(cur, sql, values, page_size=500)
        return len(rows)

    def upsert_table(
        self,
        table: str,
        rows: Sequence[dict[str, Any]],
        *,
        conflict_key: str | None = None,
    ) -> int:
        if not rows:
            return 0
        cols = list(rows[0].keys())
        col_sql = ", ".join(cols)
        placeholders = ", ".join(["%s"] * len(cols))
        sql_parts = [
            f"INSERT INTO {table} ({col_sql}) VALUES ({placeholders})",
        ]
        if conflict_key:
            update_clause = ", ".join(
                f"{c}=excluded.{c}" for c in cols if c != conflict_key
            )
            sql_parts.append(f"ON CONFLICT ({conflict_key}) DO UPDATE SET {update_clause}")
        sql = " ".join(sql_parts)
        values = [tuple(row[c] for c in cols) for row in rows]
        with self._conn.cursor() as cur:
            self._extras.execute_batch(cur, sql, values, page_size=500)
        return len(rows)

    def close(self) -> None:
        try:
            self._conn.close()
        except Exception:  # pragma: no cover
            pass
