#!/usr/bin/env bash
# Cloud staging full-lifecycle HTTP E2E — orchestration wrapper.
#
# Prepares a throwaway e2e environment from the template (or takes a prepared one), runs
# the fail-closed preflight in `e2e` mode, then drives the real stack through
# `cloud-e2e.mjs`: migrations, sign-in, conversation, message, Fake Model turn, persisted
# reply, iOS read path, Worker restart recovery, auth negatives and redaction checks.
#
#   infra/staging/scripts/cloud-e2e.sh
#   infra/staging/scripts/cloud-e2e.sh --env-file /tmp/prepared.env [--keep]
#
# The e2e profile is acceptance-only: NODE_ENV=test + EMBER_MODEL_EXECUTION=fake. It can
# never be a deployment — the preflight refuses staging markers in this mode and refuses
# `fake` in every other mode. Each run generates a unique compose project name and
# `ember-e2e-*` volume prefix (never taken from the env file), force-injects them into
# every compose call, and tears down only the resources that run created.
#
# Exit codes: 0 = all checks passed, 1 = a check failed, 2 = usage.

set -euo pipefail
SCRIPT_NAME="cloud-e2e"
# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

ENV_FILE=""
KEEP=""
for arg in "$@"; do
  case "$arg" in
    --env-file=*) ENV_FILE="${arg#--env-file=}" ;;
    --keep) KEEP="--keep" ;;
    -h|--help)
      printf 'usage: %s [--env-file=PATH] [--keep]\n' "$0"
      exit 0
      ;;
    *) die "unknown argument: $arg" ;;
  esac
done

require_command docker
require_command node

if [[ -z "$ENV_FILE" ]]; then
  ENV_FILE="/tmp/ember-staging-e2e.env"
  log "preparing throwaway e2e environment at ${ENV_FILE}"
  PASSWORD="$(openssl rand -hex 24)"
  SECRETS_DIR="/tmp/ember-staging-e2e-secrets"
  mkdir -p "$SECRETS_DIR"
  chmod 700 "$SECRETS_DIR"
  printf '%s' "$PASSWORD" > "$SECRETS_DIR/postgres_password"
  chmod 600 "$SECRETS_DIR/postgres_password"

  sed "s|REPLACE_WITH_LOCAL_THROWAWAY_PASSWORD|${PASSWORD}|" \
    "${STAGING_DIR}/env/local-e2e.env.example" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

log "preflight (e2e mode)"
"${SCRIPT_DIR}/preflight.sh" --env-file="$ENV_FILE" --mode=e2e

log "running full-lifecycle HTTP E2E"
node "${SCRIPT_DIR}/cloud-e2e.mjs" --env-file "$ENV_FILE" $KEEP
