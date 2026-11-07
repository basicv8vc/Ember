#!/usr/bin/env bash
# Stop and remove only the Cloudflare connector; preserve local services and their data.

set -euo pipefail
SCRIPT_NAME="tunnel-stop"
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

compose "$ENV_FILE" --profile tunnel rm --stop --force cloudflared
log "Cloudflare connector stopped and removed; local services and volumes remain running"
