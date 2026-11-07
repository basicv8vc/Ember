#!/usr/bin/env bash
# Fail-closed staging environment guard.
#
# Run this before every `deploy`, `update`, `migrate`, `rollback` or `up`. It refuses to
# continue when the environment file could enable a development authentication path, bill
# a model provider, reach a foreign database, or bypass TLS verification.
#
#   infra/staging/scripts/preflight.sh --env-file /etc/ember/staging.env
#   infra/staging/scripts/preflight.sh --env-file ./env/local-verify.env --mode=local
#   infra/staging/scripts/preflight.sh --env-file ./env/local-e2e.env --mode=e2e
#
# Exit codes: 0 = safe to deploy, 1 = violations, 2 = usage / unreadable input.

set -euo pipefail
SCRIPT_NAME="preflight"
# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

MODE="staging"
ENV_FILE=""
for arg in "$@"; do
  case "$arg" in
    --mode=local) MODE="local" ;;
    --mode=e2e) MODE="e2e" ;;
    --mode=staging) MODE="staging" ;;
    --env-file=*) ENV_FILE="${arg#--env-file=}" ;;
    -h|--help)
      printf 'usage: %s [--env-file=PATH] [--mode=staging|local|e2e]\n' "$0"
      exit 0
      ;;
    *) die "unknown argument: $arg" ;;
  esac
done
[[ -n "$ENV_FILE" ]] || ENV_FILE="${EMBER_STAGING_ENV_FILE:-$DEFAULT_ENV_FILE}"

require_private_file "$ENV_FILE" "environment file"

# The database password is mounted as a Docker secret, so it is a second credential file
# that must not be world-readable.
PASSWORD_FILE="$(env_value "$ENV_FILE" EMBER_POSTGRES_PASSWORD_FILE || true)"
if [[ -n "${PASSWORD_FILE}" && -f "${PASSWORD_FILE}" ]]; then
  require_private_file "$PASSWORD_FILE" "PostgreSQL password file"
fi

if [[ "$MODE" == "staging" && "$(env_value "$ENV_FILE" EMBER_CADDY_CONFIG || true)" == "Caddyfile.tunnel" ]]; then
  TUNNEL_TOKEN_FILE="$(env_value "$ENV_FILE" EMBER_CLOUDFLARE_TUNNEL_TOKEN_FILE || true)"
  [[ -n "$TUNNEL_TOKEN_FILE" ]] || die "EMBER_CLOUDFLARE_TUNNEL_TOKEN_FILE is required for the tunnel deployment"
  require_private_file "$TUNNEL_TOKEN_FILE" "Cloudflare Tunnel token"
fi

log "evaluating ${ENV_FILE} (mode=${MODE})"

# The staging host ships Docker, not Node. Prefer a local node if the operator has one
# (CI and developer machines), otherwise run the same guard inside the pinned image with
# networking disabled.
run_guard() {
  if command -v node >/dev/null 2>&1; then
    node "${SCRIPT_DIR}/preflight.mjs" "$@"
    return
  fi

  require_command docker
  docker run --rm --network none \
    --user "$(id -u):$(id -g)" \
    -v "${SCRIPT_DIR}:/guard:ro" \
    -v "${ENV_FILE}:/guard/env:ro" \
    --entrypoint node \
    "${GUARD_NODE_IMAGE}" \
    /guard/preflight.mjs /guard/env "--mode=${MODE}"
}

if ! run_guard "${ENV_FILE}" "--mode=${MODE}"; then
  log "preflight FAILED — refusing to continue"
  exit 1
fi

log "preflight passed"
