#!/usr/bin/env bash
# Build and deploy one staging release.
#
# Steps, in order, and each one is a gate:
#   1. preflight guard on the environment file (no dev auth, no provider keys, private DB)
#   2. build both images from the pinned lockfile
#   3. recreate the stack (never runs migrations — that is a separate, confirmed step)
#   4. wait for health, then run the smoke suite
#
#   infra/staging/scripts/deploy.sh --env-file /etc/ember/staging.env
#   infra/staging/scripts/deploy.sh --env-file /etc/ember/staging.env --skip-build
#
# The release tag is recorded in /etc/ember/release, and the tag it replaces is kept in
# /etc/ember/release.previous — so `rollback.sh --previous` works without any manual
# bookkeeping.

set -euo pipefail
SCRIPT_NAME="deploy"
# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

ENV_FILE=""
SKIP_BUILD="false"
for arg in "$@"; do
  case "$arg" in
    --env-file=*) ENV_FILE="${arg#--env-file=}" ;;
    --skip-build) SKIP_BUILD="true" ;;
    -h|--help)
      printf 'usage: %s --env-file=PATH [--skip-build]\n' "$0"
      exit 0
      ;;
    *) die "unknown argument: $arg" ;;
  esac
done

ENV_FILE="${ENV_FILE:-${EMBER_STAGING_ENV_FILE:-$DEFAULT_ENV_FILE}}"
require_command docker
require_private_file "$ENV_FILE" "environment file"
TUNNEL_MODE="false"
if is_tunnel_env "$ENV_FILE"; then
  TUNNEL_MODE="true"
  require_tunnel_token_file "$ENV_FILE"
fi

"${SCRIPT_DIR}/preflight.sh" "--env-file=${ENV_FILE}" --mode=staging

# Immutable release tag: commit + UTC date. Never `latest`, so a rollback always has a
# concrete target to return to.
if [[ -z "${EMBER_IMAGE_VERSION:-}" ]]; then
  commit="$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
  if [[ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]]; then
    commit="${commit}-dirty"
    log "WARNING: working tree is dirty; the image will not match any commit exactly"
  fi
  EMBER_IMAGE_VERSION="git-${commit}-$(date -u +%Y%m%d%H%M)"
  export EMBER_IMAGE_VERSION
fi

RELEASE_TAG="$(printf '%s' "$EMBER_IMAGE_VERSION" | tr -c 'A-Za-z0-9_.-' '-')"
export EMBER_API_IMAGE="${EMBER_API_IMAGE:-ember-api:${RELEASE_TAG}}"
export EMBER_WORKER_IMAGE="${EMBER_WORKER_IMAGE:-ember-worker:${RELEASE_TAG}}"

log "release ${RELEASE_TAG}"

if [[ "$SKIP_BUILD" != "true" ]]; then
  log "pulling pinned base images"
  compose "$ENV_FILE" pull postgres edge
  if [[ "$TUNNEL_MODE" == "true" ]]; then
    compose "$ENV_FILE" --profile tunnel pull cloudflared
  fi

  log "building images"
  compose "$ENV_FILE" build --pull api worker
fi

log "starting stack (migrations are NOT part of this step)"
compose "$ENV_FILE" up -d --remove-orphans --wait --wait-timeout 180

log "container state"
compose "$ENV_FILE" ps

if [[ "$TUNNEL_MODE" == "true" ]]; then
  start_tunnel_connector "$ENV_FILE"
  wait_for_tunnel_health "$ENV_FILE"
fi

log "smoke test"
"${SCRIPT_DIR}/smoke.sh" "--env-file=${ENV_FILE}"
verify_tunnel_origin "$ENV_FILE"

record_release_tag "$RELEASE_TAG"

log "deploy complete: ${RELEASE_TAG}"
