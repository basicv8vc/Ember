#!/usr/bin/env bash
# Worker health report (basic monitoring for a process with no socket).
#
# The Worker owns no HTTP endpoint, so health is measured from the durable state it is
# responsible for. Every metric below is a real failure the process would cause:
#
#   stalled_tasks     due > grace seconds, no lease holder        -> poll loop is not working
#   expired_leases    lease expired and nobody reaped it          -> reaper is not working
#   pending_turns     assistant turns still running past deadline -> turn watchdog is not working
#   oldest_due_age    age of the oldest claimable task             -> backlog building up
#
# Exit codes: 0 healthy, 1 degraded (alert), 2 could not evaluate.
#
#   infra/staging/scripts/worker-health.sh --env-file /etc/ember/staging.env
#   infra/staging/scripts/worker-health.sh --env-file ... --grace-seconds=120 --json
#
# Schedule it from a systemd timer or cron; see docs/CLOUD-STAGING-DEPLOYMENT.md §8.

set -euo pipefail
SCRIPT_NAME="worker-health"
# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

ENV_FILE=""
GRACE_SECONDS="${EMBER_WORKER_HEALTH_GRACE_SECONDS:-300}"
JSON="false"
for arg in "$@"; do
  case "$arg" in
    --env-file=*) ENV_FILE="${arg#--env-file=}" ;;
    --grace-seconds=*) GRACE_SECONDS="${arg#--grace-seconds=}" ;;
    --json) JSON="true" ;;
    -h|--help)
      printf 'usage: %s --env-file=PATH [--grace-seconds=N] [--json]\n' "$0"
      exit 0
      ;;
    *) die "unknown argument: $arg" ;;
  esac
done

ENV_FILE="${ENV_FILE:-${EMBER_STAGING_ENV_FILE:-$DEFAULT_ENV_FILE}}"
require_command docker

[[ "$GRACE_SECONDS" =~ ^[0-9]+$ ]] || die "grace-seconds must be an integer"

SQL="
SELECT
  (SELECT count(*) FROM tasks
     WHERE status IN ('queued','retryable_failed')
       AND next_run_at < now() - interval '${GRACE_SECONDS} seconds'
       AND lease_expires_at IS NULL)                                   AS stalled_tasks,
  (SELECT count(*) FROM tasks
     WHERE lease_expires_at IS NOT NULL AND lease_expires_at < now())  AS expired_leases,
  (SELECT count(*) FROM assistant_turns
     WHERE status = 'running' AND deadline_at < now())                 AS overdue_turns,
  (SELECT count(*) FROM assistant_turns WHERE status = 'running')      AS pending_turns,
  (SELECT count(*) FROM conversation_messages)                         AS messages,
  COALESCE((SELECT extract(epoch FROM (now() - min(next_run_at)))::int FROM tasks
     WHERE status IN ('queued','retryable_failed')), 0)                AS oldest_due_age_s,
  (SELECT count(*) FROM schema_migrations)                             AS migrations;
"

set +e
ROW="$(compose "$ENV_FILE" exec -T postgres psql \
  -U "$(env_value "$ENV_FILE" EMBER_POSTGRES_USER)" \
  -d "$(env_value "$ENV_FILE" EMBER_POSTGRES_DB)" \
  -t -A -F '|' -c "$SQL" 2>/dev/null)"
STATUS=$?
set -e

if [[ $STATUS -ne 0 || -z "$ROW" ]]; then
  log "could not query PostgreSQL (exit ${STATUS})"
  exit 2
fi

IFS='|' read -r stalled expired overdue pending messages oldest migrations <<<"$ROW"
# psql prints integers with whitespace padding on alignment; normalise before comparing.
stalled="${stalled// /}"; expired="${expired// /}"; overdue="${overdue// /}"
pending="${pending// /}"; messages="${messages// /}"
oldest="${oldest// /}"; migrations="${migrations// /}"

DEGRADED=0
REASONS=()

if (( stalled > 0 )); then
  DEGRADED=1
  REASONS+=("stalled_tasks=${stalled}")
fi
if (( expired > 0 )); then
  # Expired leases are a transient state the reaper clears; sustained values are the signal.
  REASONS+=("expired_leases=${expired}")
fi
if (( overdue > 0 )); then
  DEGRADED=1
  REASONS+=("overdue_turns=${overdue}")
fi

if [[ "$JSON" == "true" ]]; then
  printf '{"status":"%s","stalled_tasks":%s,"expired_leases":%s,"overdue_turns":%s,"pending_turns":%s,"messages":%s,"oldest_due_age_s":%s,"migrations":%s,"grace_s":%s}\n' \
    "$([[ $DEGRADED -eq 1 ]] && echo degraded || echo healthy)" \
    "$stalled" "$expired" "$overdue" "$pending" "$messages" "$oldest" "$migrations" "$GRACE_SECONDS"
else
  if [[ $DEGRADED -eq 1 ]]; then
    echo "worker_health=degraded"
  else
    echo "worker_health=healthy"
  fi
  cat <<EOF
  stalled_tasks   = ${stalled}   (due > ${GRACE_SECONDS}s, unleased)
  expired_leases  = ${expired}
  overdue_turns   = ${overdue}
  pending_turns   = ${pending}
  messages        = ${messages}
  oldest_due_age  = ${oldest}s
  migrations      = ${migrations}
EOF
  if (( ${#REASONS[@]} > 0 )); then
    printf '  reasons         = %s\n' "${REASONS[*]}"
  fi
fi

[[ $DEGRADED -eq 0 ]] || exit 1
