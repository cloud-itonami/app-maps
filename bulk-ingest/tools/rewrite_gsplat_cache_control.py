#!/usr/bin/env python3
"""One-shot operator tool: re-key every existing gsplat blob in B2 with
the immutable Cache-Control header that newer uploads carry.

Existing blobs uploaded before D12 (2026-05-10) are missing
`Cache-Control: public, max-age=86400, immutable`, so browsers fall
back to a small heuristic TTL and re-validate on every visit. This
script issues a server-side `copy_object` to itself with
`MetadataDirective=REPLACE`, which is the S3-API way to rewrite a
single header without re-uploading the body.

Idempotent: safe to re-run. Prints `(skipped: already up-to-date)`
for objects whose Cache-Control already matches the target.

Run from inside the `bulk-ingest` k8s pod (same env vars as the
dumper) or from a developer laptop:

  cd 60-apps/etzhayyim-project-maps/bulk-ingest
  source ~/.etzhayyim/maps.env  # B2_ENDPOINT / B2_KEY_ID / B2_APPLICATION_KEY / B2_BUCKET
  python3 tools/rewrite_gsplat_cache_control.py
  # → updates ~thousands of objects, ~5/s with B2 default rate limit

ADR-2605092800 §D12.
"""

from __future__ import annotations

import os
import sys

import boto3
from botocore.exceptions import ClientError


_TARGET = "public, max-age=86400, immutable"
_PREFIXES = (
    "maps-bulk-ingest/gsplat",
    "maps-bulk-ingest/gsplat-mesh",
)


def _b2():
    endpoint = os.environ.get("B2_ENDPOINT", "")
    region = os.environ.get("B2_REGION", "us-west-004")
    if not (endpoint and os.environ.get("B2_KEY_ID") and os.environ.get("B2_APPLICATION_KEY")):
        sys.exit("set B2_ENDPOINT / B2_KEY_ID / B2_APPLICATION_KEY / B2_BUCKET")
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        region_name=region,
        aws_access_key_id=os.environ["B2_KEY_ID"],
        aws_secret_access_key=os.environ["B2_APPLICATION_KEY"],
    )


def _rewrite_one(client, bucket: str, key: str) -> tuple[bool, str]:
    """Returns `(changed, reason)`."""
    try:
        head = client.head_object(Bucket=bucket, Key=key)
    except ClientError as e:
        return False, f"head failed: {e}"
    current = (head.get("CacheControl") or "").strip()
    if current == _TARGET:
        return False, "already up-to-date"
    content_type = head.get("ContentType") or "application/octet-stream"
    try:
        client.copy_object(
            Bucket=bucket,
            Key=key,
            CopySource={"Bucket": bucket, "Key": key},
            CacheControl=_TARGET,
            ContentType=content_type,
            MetadataDirective="REPLACE",
        )
        return True, f"updated (was {current!r})"
    except ClientError as e:
        return False, f"copy failed: {e}"


def main() -> None:
    bucket = os.environ.get("B2_BUCKET")
    if not bucket:
        sys.exit("B2_BUCKET not set")
    client = _b2()
    paginator = client.get_paginator("list_objects_v2")
    total = changed = skipped = errors = 0
    for prefix in _PREFIXES:
        for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
            for obj in page.get("Contents", []) or []:
                key = obj["Key"]
                total += 1
                ok, reason = _rewrite_one(client, bucket, key)
                if ok:
                    changed += 1
                    print(f"changed {key} — {reason}")
                else:
                    if "already up-to-date" in reason:
                        skipped += 1
                    else:
                        errors += 1
                        print(f"  ERROR {key} — {reason}", file=sys.stderr)
    print(
        f"\ndone: total={total} changed={changed} "
        f"skipped={skipped} errors={errors}"
    )


if __name__ == "__main__":
    main()
