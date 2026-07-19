#!/usr/bin/env bash
# Build, push, and deploy maps-bulk-ingest workers (1 image, N pods).
#
# Active dumpers (per k8s/deployment-*.yaml):
#   wikidata, wikipedia, osm-planet, geonames,
#   gtfs-jp        (bus + train route maps + timetable summary)
#   openflights    (空路 / scheduled flight legs, ODbL)
#   ferry-routes   (海路 / OSM route=ferry, ODbL)
#
# Usage:
#   ./deploy.sh build           # remote buildx build + push (1 image, N commands)
#   ./deploy.sh secrets         # create maps-bulk-ingest-credentials Secret
#   ./deploy.sh apply           # kubectl apply all deployments
#   ./deploy.sh trigger <src>   # POST /trigger to one of the dumpers (or "all")
#   ./deploy.sh status          # GET /status from all
#   ./deploy.sh logs <src>      # kubectl logs -f
#   ./deploy.sh teardown        # kubectl delete (keep PVC)
#
# Prereqs:
#   - macOS Keychain holds etzhayyim.r2 / etzhayyim.rw credentials (per CLAUDE.md)
#   - GHCR_TOKEN exported (or `gh auth token`) for image push
#   - kubectl context = vke-a61d513b-... (Vultr VKE)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="ghcr.io/etzhayyim/maps-bulk-ingest:1.2.0"
NAMESPACE="maps-bulk-ingest"

# Active dumpers — keep in sync with k8s/deployment-*.yaml.
ALL_DUMPERS=(wikidata wikipedia osm-planet geonames gtfs-jp gtfs-rt openflights ferry-routes)

cmd="${1:-help}"

case "$cmd" in
  build)
    cd "$SCRIPT_DIR"
    CACHE_REF="${BUILDKIT_CACHE_REF:-ghcr.io/etzhayyim/build-cache:maps-bulk-ingest}"
    : "${GHCR_USERNAME:=$(gh api user -q .login 2>/dev/null || echo "")}"
    : "${GHCR_TOKEN:=$(gh auth token 2>/dev/null || echo "")}"
    [ -z "$GHCR_TOKEN" ] && { echo "GHCR_TOKEN not set; gh auth login first"; exit 1; }
    echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USERNAME" --password-stdin
    docker buildx build --builder "${BUILDKIT_BUILDER:-etzhayyim-vke}" --platform=linux/amd64 \
      --cache-from "type=registry,ref=${CACHE_REF}" \
      --cache-to "type=registry,ref=${CACHE_REF},mode=max" \
      --push -t "$IMAGE" .
    echo "✓ pushed $IMAGE"
    ;;

  secrets)
    DATABASE_URL="$(security find-generic-password -s etzhayyim.rw -a ROOT_URL -w)"
    B2_ACCESS_KEY_ID="$(security find-generic-password -s etzhayyim.r2 -a ACCESS_KEY_ID -w)"
    B2_SECRET_ACCESS_KEY="$(security find-generic-password -s etzhayyim.r2 -a SECRET_ACCESS_KEY -w)"
    [ -z "$DATABASE_URL" ] && { echo "DATABASE_URL not in etzhayyim.rw keychain"; exit 1; }
    [ -z "$B2_ACCESS_KEY_ID" ] && { echo "B2 creds not in etzhayyim.r2 keychain"; exit 1; }
    kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
    kubectl -n "$NAMESPACE" create secret generic maps-bulk-ingest-credentials \
      --from-literal=DATABASE_URL="$DATABASE_URL" \
      --from-literal=B2_ACCESS_KEY_ID="$B2_ACCESS_KEY_ID" \
      --from-literal=B2_SECRET_ACCESS_KEY="$B2_SECRET_ACCESS_KEY" \
      --dry-run=client -o yaml | kubectl apply -f -
    echo "✓ secrets installed"
    ;;

  apply)
    for f in "$SCRIPT_DIR"/k8s/deployment*.yaml; do
      kubectl apply -f "$f"
    done
    for d in "${ALL_DUMPERS[@]}"; do
      kubectl -n "$NAMESPACE" rollout status "deploy/bulk-ingest-$d" --timeout=90s || true
    done
    echo "✓ all dumpers applied"
    ;;

  trigger)
    src="${2:-all}"
    if [ "$src" = "all" ]; then
      triggers=("${ALL_DUMPERS[@]}")
    else
      triggers=("$src")
    fi
    for s in "${triggers[@]}"; do
      svc="bulk-ingest-$s.$NAMESPACE.svc.cluster.local"
      echo "→ POST $svc/trigger"
      kubectl -n "$NAMESPACE" run "trigger-$s-$$" --rm -i --restart=Never --image=curlimages/curl:8.7.1 -- \
        sh -c "curl -fsS -X POST http://$svc:8080/trigger -H 'Content-Type: application/json' -d '{}'"
    done
    ;;

  status)
    for s in "${ALL_DUMPERS[@]}"; do
      svc="bulk-ingest-$s.$NAMESPACE.svc.cluster.local"
      echo "── $s ──"
      kubectl -n "$NAMESPACE" run "status-$s-$$" --rm -i --restart=Never --image=curlimages/curl:8.7.1 -- \
        sh -c "curl -fsS http://$svc:8080/status" 2>/dev/null | python3 -m json.tool 2>/dev/null || echo "  (unreachable)"
    done
    ;;

  logs)
    src="${2:-wikidata}"
    kubectl -n "$NAMESPACE" logs -f deploy/bulk-ingest-"$src"
    ;;

  teardown)
    kubectl -n "$NAMESPACE" delete deploy --all
    kubectl -n "$NAMESPACE" delete service --all
    echo "✓ deployments + services removed (PVC kept)"
    ;;

  help|*)
    sed -n '1,/^set -/p' "$0" | head -n -1
    ;;
esac
