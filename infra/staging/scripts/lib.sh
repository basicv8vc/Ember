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

# Where the release bookkeeping lives. Overridable so tests can point at a scratch
# directory; on a staging host it is /etc/ember.
release_dir() {
  printf '%s' "${EMBER_RELEASE_DIR:-/etc/ember}"
}

# record_release_tag TAG — make TAG the current release and keep the tag it replaced in
# release.previous, so `rollback.sh --previous` always has a target without manual
# bookkeeping. Called by deploy.sh and rollback.sh only after the run has fully
# succeeded: a failed deploy or rollback never disturbs the record.
record_release_tag() {
  local tag="$1"
  local dir previous=""
  [[ -n "$tag" ]] || die "record_release_tag: empty release tag"
  dir="$(release_dir)"
  mkdir -p "$dir" 2>/dev/null || true
  if [[ ! -w "$dir" ]]; then
    log "WARNING: ${dir} is not writable; release ${tag} was NOT recorded (rollback.sh --previous will have no target)"
    return 0
  fi
  if [[ -s "${dir}/release" ]]; then
    previous="$(tr -d '[:space:]' < "${dir}/release")"
    # Redeploying the same tag keeps the older previous: the version to roll back to
    # does not change just because the same release was rebuilt.
    if [[ -n "$previous" && "$previous" != "$tag" ]]; then
      printf '%s\n' "$previous" > "${dir}/release.previous"
      chmod 644 "${dir}/release.previous"
    fi
  fi
  printf '%s\n' "$tag" > "${dir}/release"
  chmod 644 "${dir}/release"
  log "recorded release ${tag} in ${dir}/release (previous: ${previous:-none})"
}

# read_previous_release — the tag `rollback.sh --previous` rolls back to: the release that
# was current before the last deploy or rollback changed it.
read_previous_release() {
  local file
  file="$(release_dir)/release.previous"
  [[ -s "$file" ]] || die "no previous release recorded in ${file}"
  tr -d '[:space:]' < "$file"
}

compose() {
  local env_file="$1"
  shift
  # The same file drives both sides: interpolation (`--env-file`) and the containers'
  # `env_file`, so a service can never start from a different snapshot than the one the
  # preflight guard approved.
  ( cd "$REPO_ROOT" && EMBER_STAGING_ENV_FILE="$env_file" docker compose --env-file "$env_file" -f "$COMPOSE_FILE" "$@" )
}
