#!/usr/bin/env bash
# Apply the Ember schema migrations to staging — explicitly, never automatically.
#
# The task constraint is that a production migration is never triggered by a deploy. This
# script therefore has no default action: it requires --confirm, prints the target database
# first, and runs the same `runMigrations` code path that CI exercises (advisory lock,
# checksum verification, forward-only ordering).
#
#   infra/staging/scripts/migrate.sh --env-file /etc/ember/staging.env --confirm
#   infra/staging/scripts/migrate.sh --env-file /etc/ember/staging.env --confirm --verify-idempotent
#
# Forward-only: there is no down-migration. Rolling back a release does not roll back the
# schema (see docs/CLOUD-STAGING-DEPLOYMENT.md §7).

set -euo pipefail
SCRIPT_NAME="migrate"
# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

ENV_FILE=""
CONFIRMED="false"
VERIFY="false"
for arg in "$@"; do
  case "$arg" in
    --env-file=*) ENV_FILE="${arg#--env-file=}" ;;
    --confirm) CONFIRMED="true" ;;
    --verify-idempotent) VERIFY="true" ;;
    -h|--help)
      printf 'usage: %s --env-file=PATH --confirm [--verify-idempotent]\n' "$0"
      exit 0
      ;;
    *) die "unknown argument: $arg" ;;
  esac
done

ENV_FILE="${ENV_FILE:-${EMBER_STAGING_ENV_FILE:-$DEFAULT_ENV_FILE}}"
require_command docker

"${SCRIPT_DIR}/preflight.sh" "--env-file=${ENV_FILE}" --mode=staging

if [[ "$CONFIRMED" != "true" ]]; then
  cat >&2 <<'EOF'
Refusing to migrate without explicit confirmation.

Migrations are forward-only and run against a live database. Review the plan, then repeat
the command with --confirm.
EOF
  exit 2
fi

DATABASE_URL_VALUE="$(env_value "$ENV_FILE" DATABASE_URL)"
# Print the target without the credential: host/database only.
TARGET="$(printf '%s' "$DATABASE_URL_VALUE" | sed -E 's#^postgres(ql)?://[^@]*@##')"
log "migration target: ${TARGET}"

log "applying migrations (run 1)"
compose "$ENV_FILE" --profile tools run --rm migrate

if [[ "$VERIFY" == "true" ]]; then
  log "re-running migrations to prove idempotency (run 2)"
  compose "$ENV_FILE" --profile tools run --rm migrate
fi

applied="$(compose "$ENV_FILE" exec -T postgres psql -U "$(env_value "$ENV_FILE" EMBER_POSTGRES_USER)" \
  -d "$(env_value "$ENV_FILE" EMBER_POSTGRES_DB)" -t -A \
  -c 'SELECT count(*) FROM schema_migrations' | tr -d '[:space:]')"

log "schema_migrations rows: ${applied}"
[[ "$applied" =~ ^[0-9]+$ ]] || die "could not read schema_migrations"
[[ "$applied" -ge 1 ]] || die "no migrations recorded"

log "migrations complete"
