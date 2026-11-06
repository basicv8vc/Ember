#!/usr/bin/env bash
# Roll the staging stack back to a previously built release image.
#
# The schema is NOT rolled back: migrations are forward-only by design, and a down-migration
# written under pressure is how data is lost. The previous image must therefore still be
# compatible with the current schema — which is why every release is expected to ship
# additive migrations first and code that depends on them second.
#
#   infra/staging/scripts/rollback.sh --env-file /etc/ember/staging.env --to=git-c6c9c3d650f9-202611061030
#   infra/staging/scripts/rollback.sh --env-file /etc/ember/staging.env --previous
#
# `--previous` reads the tag recorded before the last deploy from /etc/ember/release.previous.

set -euo pipefail
SCRIPT_NAME="rollback"
# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

ENV_FILE=""
TARGET=""
PREVIOUS="false"
for arg in "$@"; do
  case "$arg" in
    --env-file=*) ENV_FILE="${arg#--env-file=}" ;;
    --to=*) TARGET="${arg#--to=}" ;;
    --previous) PREVIOUS="true" ;;
    -h|--help)
      printf 'usage: %s --env-file=PATH (--to=TAG | --previous)\n' "$0"
      exit 0
      ;;
    *) die "unknown argument: $arg" ;;
  esac
done

ENV_FILE="${ENV_FILE:-${EMBER_STAGING_ENV_FILE:-$DEFAULT_ENV_FILE}}"
require_command docker

if [[ "$PREVIOUS" == "true" ]]; then
  [[ -f /etc/ember/release.previous ]] || die "no previous release recorded in /etc/ember/release.previous"
  TARGET="$(tr -d '[:space:]' < /etc/ember/release.previous)"
fi

[[ -n "$TARGET" ]] || die "specify --to=<tag> or --previous"

export EMBER_IMAGE_VERSION="$TARGET"
export EMBER_API_IMAGE="ember-api:${TARGET}"
export EMBER_WORKER_IMAGE="ember-worker:${TARGET}"

for image in "$EMBER_API_IMAGE" "$EMBER_WORKER_IMAGE"; do
  docker image inspect "$image" >/dev/null 2>&1 \
    || die "image ${image} is not present on this host; rebuild it (git checkout of the release) before rolling back"
done

log "rolling back to ${TARGET}"
compose "$ENV_FILE" up -d --no-build --remove-orphans --wait --wait-timeout 180

"${SCRIPT_DIR}/smoke.sh" "--env-file=${ENV_FILE}"

log "rollback complete: ${TARGET}"
log "the database schema was not reverted; verify the release's migration compatibility before the next deploy"
