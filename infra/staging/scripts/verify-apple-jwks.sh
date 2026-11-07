#!/usr/bin/env bash
# Verify Apple JWKS is reachable from the running API container, not merely from the host.

set -euo pipefail
SCRIPT_NAME="apple-jwks"
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

compose "$ENV_FILE" exec -T api node --input-type=module -e '
const response = await fetch("https://appleid.apple.com/auth/keys", {
  signal: AbortSignal.timeout(10000),
});
if (!response.ok) {
  process.stderr.write(`apple_jwks_status=${response.status}\n`);
  process.exit(1);
}
const payload = await response.json();
if (!Array.isArray(payload.keys) || payload.keys.length === 0) {
  process.stderr.write("apple_jwks_status=invalid_payload\n");
  process.exit(1);
}
process.stdout.write(`apple_jwks_status=${response.status} key_count=${payload.keys.length}\n`);
'
