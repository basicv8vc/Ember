#!/usr/bin/env bash
# Start local staging services and the optional Cloudflare Tunnel connector.

set -euo pipefail
SCRIPT_NAME="tunnel-start"
# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

ENV_FILE=""
for arg in "$@"; do
  case "$arg" in
    --env-file=*) ENV_FILE="${arg#--env-file=}" ;;
    -h|--help)
      printf 'usage: %s --env-file=PATH\n' "$0"
      exit 0
      ;;
    *) die "unknown argument: $arg" ;;
  esac
done

ENV_FILE="${ENV_FILE:-${EMBER_STAGING_ENV_FILE:-$DEFAULT_ENV_FILE}}"
require_private_file "$ENV_FILE" "environment file"
require_command docker
is_tunnel_env "$ENV_FILE" || die "environment must set EMBER_CADDY_CONFIG=Caddyfile.tunnel"
require_tunnel_token_file "$ENV_FILE"

"${SCRIPT_DIR}/preflight.sh" "--env-file=${ENV_FILE}" --mode=staging
log "starting existing local staging images (this does not run migrations)"
compose "$ENV_FILE" up -d --no-build --wait --wait-timeout 180 postgres api worker edge
start_tunnel_connector "$ENV_FILE"
wait_for_tunnel_health "$ENV_FILE"
"${SCRIPT_DIR}/smoke.sh" "--env-file=${ENV_FILE}"
verify_tunnel_origin "$ENV_FILE"

log "tunnel staging is reachable at $(staging_base_url "$ENV_FILE")"
