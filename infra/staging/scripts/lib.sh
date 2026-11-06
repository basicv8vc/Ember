#!/usr/bin/env bash
# Shared helpers for the staging operator scripts.
#
# Every script sources this file. It never prints a secret: environment files are only ever
# read, and the only values echoed are non-sensitive identifiers.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAGING_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${STAGING_DIR}/../.." && pwd)"

DEFAULT_ENV_FILE="/etc/ember/staging.env"
COMPOSE_FILE="${STAGING_DIR}/compose.yaml"

# The pinned Node image is also the guard runtime: the staging host is expected to have
# Docker only, not a system Node installation.
GUARD_NODE_IMAGE="${EMBER_NODE_IMAGE:-node:24.22.1-bookworm-slim}"

log() {
  printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${SCRIPT_NAME:-staging}" "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

# Resolve the environment file path from --env-file / EMBER_STAGING_ENV_FILE / default.
env_file_path() {
  local candidate="${EMBER_STAGING_ENV_FILE:-$DEFAULT_ENV_FILE}"
  local arg
  for arg in "$@"; do
    case "$arg" in
      --env-file=*) candidate="${arg#--env-file=}" ;;
    esac
  done
  printf '%s' "$candidate"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

# Assert a file exists and is not readable by group/other.
#   On Linux: stat -c %a, on macOS: stat -f %Lp
require_private_file() {
  local file="$1"
  local label="$2"
  [[ -f "$file" ]] || die "${label} not found at ${file}"

  local mode
  if stat -c %a "$file" >/dev/null 2>&1; then
    mode="$(stat -c %a "$file")"
  else
    mode="$(stat -f %Lp "$file")"
  fi

  case "$mode" in
    600|400) ;;
    *) die "${label} ${file} must be mode 600 or 400 (found ${mode}); it carries credentials" ;;
  esac
}

# Read a single non-secret value out of the environment file without sourcing it.
env_value() {
  local file="$1"
  local key="$2"
  awk -v key="$key" '
    /^[[:space:]]*#/ { next }
    index($0, key "=") == 1 { sub("^[^=]*=", ""); print; exit }
  ' "$file"
}

compose() {
  local env_file="$1"
  shift
  # The same file drives both sides: interpolation (`--env-file`) and the containers'
  # `env_file`, so a service can never start from a different snapshot than the one the
  # preflight guard approved.
  ( cd "$REPO_ROOT" && EMBER_STAGING_ENV_FILE="$env_file" docker compose --env-file "$env_file" -f "$COMPOSE_FILE" "$@" )
}
