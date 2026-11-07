#!/usr/bin/env bash
# Send a fake bearer canary through the public URL and ensure local service logs omit it.

set -euo pipefail
SCRIPT_NAME="secret-redaction"
# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

ENV_FILE=""
BASE_URL=""
for arg in "$@"; do
  case "$arg" in
    --env-file=*) ENV_FILE="${arg#--env-file=}" ;;
    --base-url=*) BASE_URL="${arg#--base-url=}" ;;
    -h|--help)
      printf 'usage: %s --env-file=PATH [--base-url=HTTPS_URL]\n' "$0"
      exit 0
      ;;
    *) die "unknown argument: $arg" ;;
  esac
done

ENV_FILE="${ENV_FILE:-${EMBER_STAGING_ENV_FILE:-$DEFAULT_ENV_FILE}}"
BASE_URL="${BASE_URL:-$(staging_base_url "$ENV_FILE")}"
require_private_file "$ENV_FILE" "environment file"
require_command curl
require_command docker

auth_canary="ember-auth-redaction-$(date -u +%Y%m%dT%H%M%S)-${RANDOM}"
body_canary="ember-body-redaction-$(date -u +%Y%m%dT%H%M%S)-${RANDOM}"
auth_status="$(curl --silent --show-error --max-time 10 -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer ${auth_canary}" "${BASE_URL}/v1/me" || true)"
[[ "$auth_status" == "401" ]] || die "redaction auth probe returned HTTP ${auth_status}, expected 401"
body_status="$(curl --silent --show-error --max-time 10 -o /dev/null -w '%{http_code}' \
  -H 'content-type: application/json' \
  -d "{\"provider\":\"apple\",\"identity_token\":\"${body_canary}\",\"nonce\":\"${body_canary}\"}" \
  "${BASE_URL}/v1/auth/session" || true)"
[[ "$body_status" =~ ^(400|401|422)$ ]] \
  || die "redaction body probe returned HTTP ${body_status}, expected 400, 401, or 422"

logs="$(compose "$ENV_FILE" --profile tunnel logs --no-color --since=5m api edge cloudflared 2>/dev/null || true)"
if printf '%s' "$logs" | grep -Fq -- "$auth_canary" || \
  printf '%s' "$logs" | grep -Fq -- "$body_canary"; then
  unset auth_canary body_canary logs
  die "a fake authorization/body canary appeared in API, Caddy, or cloudflared logs"
fi

unset auth_canary body_canary logs
log "PASS fake authorization and Apple-token canaries absent from API, Caddy, and cloudflared logs"
