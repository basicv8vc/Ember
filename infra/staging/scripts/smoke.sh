#!/usr/bin/env bash
# Post-deployment smoke test for the Ember staging API.
#
# It asserts the properties that must hold on every deploy, including the negative ones:
# the development sign-in path is gone, forged credentials are refused, and the edge
# presents a certificate a real device will accept.
#
#   infra/staging/scripts/smoke.sh --env-file /etc/ember/staging.env
#   infra/staging/scripts/smoke.sh --base-url http://127.0.0.1:8787
#   infra/staging/scripts/smoke.sh --cacert /tmp/ember-ca.crt   # internal CA (local verify)
#
# Exit code 0 only when every check passes.

set -euo pipefail
SCRIPT_NAME="smoke"
# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

ENV_FILE=""
BASE_URL=""
# Local verification terminates TLS with the internal CA, which the host does not trust.
# Staging never sets this: the public certificate must verify with the system trust store.
CACERT="${EMBER_SMOKE_CACERT:-}"
INSECURE="false"
for arg in "$@"; do
  case "$arg" in
    --env-file=*) ENV_FILE="${arg#--env-file=}" ;;
    --base-url=*) BASE_URL="${arg#--base-url=}" ;;
    --cacert=*) CACERT="${arg#--cacert=}" ;;
    --insecure) INSECURE="true" ;;
    -h|--help)
      printf 'usage: %s [--env-file=PATH] [--base-url=URL] [--cacert=PATH] [--insecure]\n' "$0"
      exit 0
      ;;
    *) die "unknown argument: $arg" ;;
  esac
done

if [[ -z "$ENV_FILE" ]]; then
  ENV_FILE="${EMBER_STAGING_ENV_FILE:-$DEFAULT_ENV_FILE}"
fi
[[ -f "$ENV_FILE" ]] || die "environment file not found: $ENV_FILE (pass --env-file)"

if [[ -z "$BASE_URL" ]]; then
  BASE_URL="$(staging_base_url "$ENV_FILE")"
fi

require_command curl

CURL_OPTS=(--silent --show-error --max-time 10 --proto '=https,http')
[[ -n "$CACERT" ]] && CURL_OPTS+=(--cacert "$CACERT")
[[ "$INSECURE" == "true" ]] && CURL_OPTS+=(--insecure)

PASS=0
FAIL=0

# check <name> <expected-status-regex> <curl-args...>
check() {
  local name="$1"
  local expected="$2"
  shift 2

  local body_file status
  body_file="$(mktemp)"
  status="$(curl "${CURL_OPTS[@]}" -o "$body_file" -w '%{http_code}' "$@" || true)"

  if [[ "$status" =~ ^($expected)$ ]]; then
    printf 'PASS  %-46s HTTP %s\n' "$name" "$status"
    PASS=$((PASS + 1))
  else
    printf 'FAIL  %-46s HTTP %s (expected %s)\n' "$name" "$status" "$expected"
    printf '      body: %s\n' "$(head -c 300 "$body_file" | tr -d '\n')"
    FAIL=$((FAIL + 1))
  fi
  rm -f "$body_file"
}

# expect_body <name> <substring> <curl-args...>
expect_body() {
  local name="$1"
  local needle="$2"
  shift 2

  local body
  body="$(curl "${CURL_OPTS[@]}" "$@" || true)"
  if [[ "$body" == *"$needle"* ]]; then
    printf 'PASS  %-46s contains %s\n' "$name" "$needle"
    PASS=$((PASS + 1))
  else
    printf 'FAIL  %-46s missing %s\n' "$name" "$needle"
    printf '      body: %s\n' "$(printf '%s' "$body" | head -c 300)"
    FAIL=$((FAIL + 1))
  fi
}

log "smoke target: ${BASE_URL}"

# ---- 1/2. Liveness and dependency readiness ---------------------------------------------
check 'liveness /healthz' '200' "${BASE_URL}/healthz"
expect_body 'liveness reports ok' '"status":"ok"' "${BASE_URL}/healthz"
check 'readiness /readyz (PostgreSQL 17)' '200' "${BASE_URL}/readyz"
expect_body 'readiness reports ready' '"status":"ready"' "${BASE_URL}/readyz"

# ---- 3. Development sign-in must not exist on staging -----------------------------------
check 'dev sign-in refused' '404' \
  -X POST "${BASE_URL}/v1/auth/session" \
  -H 'content-type: application/json' \
  -d '{"provider":"dev","identity_token":"preflight-dev-must-not-work","nonce":"preflight"}'

# ---- 4. Real Apple verification path is mounted and rejects a forged assertion ----------
check 'forged Apple assertion refused' '400|401|422' \
  -X POST "${BASE_URL}/v1/auth/session" \
  -H 'content-type: application/json' \
  -d '{"provider":"apple","identity_token":"not.a.real.jwt","nonce":"preflight-nonce"}'

# ---- 5/6. Protected surfaces reject missing and forged session credentials --------------
check '/v1/me without credentials' '401' "${BASE_URL}/v1/me"
check '/v1/me with forged session token' '401' \
  -H 'authorization: Bearer ems_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' \
  "${BASE_URL}/v1/me"

# ---- 7. Legacy development bearer tokens are not accepted ------------------------------
check 'legacy dev bearer refused (/v1/agents)' '401' \
  -H 'authorization: Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
  "${BASE_URL}/v1/agents"
check 'legacy dev bearer refused (/v1/tasks)' '401' \
  -H 'authorization: Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
  "${BASE_URL}/v1/tasks"

# ---- 8. Unknown routes fail closed with the shared error envelope -----------------------
check 'unknown route' '404' "${BASE_URL}/v1/does-not-exist"
expect_body 'unknown route uses ErrorResponse' '"error"' "${BASE_URL}/v1/does-not-exist"

# ---- 9. Edge does not advertise itself --------------------------------------------------
headers="$(curl "${CURL_OPTS[@]}" -D - -o /dev/null "${BASE_URL}/healthz" || true)"
server_header="$(printf '%s' "$headers" | awk 'tolower($0) ~ /^server:/ { gsub(/\r/, ""); sub(/^[^:]*:[[:space:]]*/, ""); print tolower($0); exit }')"
if is_tunnel_env "$ENV_FILE"; then
  if [[ -z "$server_header" || "$server_header" == "cloudflare" ]]; then
    printf 'PASS  %-46s no origin Server identity\n' 'edge hides origin identity'
    PASS=$((PASS + 1))
  else
    printf 'FAIL  %-46s unexpected Server header: %s\n' 'edge hides origin identity' "$server_header"
    FAIL=$((FAIL + 1))
  fi
elif [[ -n "$server_header" ]]; then
  printf 'FAIL  %-46s Server header present\n' 'edge hides server identity'
  FAIL=$((FAIL + 1))
else
  printf 'PASS  %-46s no Server header\n' 'edge hides server identity'
  PASS=$((PASS + 1))
fi

if [[ "$BASE_URL" == https://* ]]; then
  if printf '%s' "$headers" | grep -qi '^strict-transport-security:'; then
    printf 'PASS  %-46s HSTS present\n' 'edge sends HSTS'
    PASS=$((PASS + 1))
  else
    printf 'FAIL  %-46s HSTS missing\n' 'edge sends HSTS'
    FAIL=$((FAIL + 1))
  fi
fi

if is_tunnel_env "$ENV_FILE"; then
  hostname="$(env_value "$ENV_FILE" EMBER_STAGING_HOSTNAME)"
  check 'HTTP is redirected to HTTPS' '301|308' "http://${hostname}/healthz"
fi

printf '\n%s: %d passed, %d failed\n' "$SCRIPT_NAME" "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
