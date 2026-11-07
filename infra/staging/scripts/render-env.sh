#!/usr/bin/env bash
# Render the staging environment file from AWS SSM Parameter Store.
#
# Why this exists: the deployment must never carry secrets in the repository, in a compose
# file, or in a shell history. The host stays a thin, replaceable image: it pulls its entire
# configuration from a parameter tree at boot, writes one 0600 file, and hands that file to
# both the preflight guard and Docker Compose.
#
# Layout (prefix defaults to /ember/staging):
#
#   /ember/staging/config/EMBER_STAGING_HOSTNAME      staging.ember.example.net
#   /ember/staging/config/EMBER_ACME_EMAIL            ops@example.com
#   /ember/staging/config/EMBER_APPLE_BUNDLE_ID       com.basicv8vc.ember
#   /ember/staging/secrets/POSTGRES_PASSWORD          SecureString, generated once
#
# Everything not present in SSM comes from the committed template
# (infra/staging/env/staging.env.example), so the safe defaults are reviewable in git and
# the host only overrides what is genuinely host-specific.
#
#   infra/staging/scripts/render-env.sh --output=/etc/ember/staging.env
#
# Requires: bash >= 4, awscli v2 with ssm:GetParametersByPath on the prefix, and an
# instance role (no static access keys on the host).

set -euo pipefail
SCRIPT_NAME="render-env"
# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

if (( BASH_VERSINFO[0] < 4 )); then
  die "bash >= 4 is required (this host has ${BASH_VERSION})"
fi

OUTPUT="/etc/ember/staging.env"
PREFIX="/ember/staging"
TEMPLATE="${STAGING_DIR}/env/staging.env.example"
PASSWORD_FILE="/etc/ember/secrets/postgres_password"

for arg in "$@"; do
  case "$arg" in
    --output=*) OUTPUT="${arg#--output=}" ;;
    --ssm-prefix=*) PREFIX="${arg#--ssm-prefix=}" ;;
    --template=*) TEMPLATE="${arg#--template=}" ;;
    --password-file=*) PASSWORD_FILE="${arg#--password-file=}" ;;
    -h|--help)
      printf 'usage: %s [--output=PATH] [--ssm-prefix=PATH] [--template=PATH] [--password-file=PATH]\n' "$0"
      exit 0
      ;;
    *) die "unknown argument: $arg" ;;
  esac
done

require_command aws
[[ -f "$TEMPLATE" ]] || die "template not found: ${TEMPLATE}"
require_command openssl

log "reading parameters under ${PREFIX}"

declare -A VALUES=()
declare -A SECRETS=()

while IFS=$'\t' read -r name value; do
  [[ -n "${name:-}" ]] || continue
  relative="${name#${PREFIX}/}"
  case "$relative" in
    config/*) VALUES["${relative#config/}"]="$value" ;;
    secrets/*) SECRETS["${relative#secrets/}"]="$value" ;;
    *) log "ignoring parameter outside config/ or secrets/: ${name}" ;;
  esac
done < <(aws ssm get-parameters-by-path \
  --path "$PREFIX" \
  --recursive \
  --with-decryption \
  --query 'Parameters[].[Name,Value]' \
  --output text)

# ---- database password -----------------------------------------------------------------
DB_PASSWORD="${SECRETS[POSTGRES_PASSWORD]:-}"
if [[ -z "$DB_PASSWORD" ]]; then
  log "POSTGRES_PASSWORD is absent from SSM; generating one and storing it as a SecureString"
  DB_PASSWORD="$(openssl rand -base64 32 | tr -d '=+/\n' | cut -c1-40)"
  aws ssm put-parameter \
    --name "${PREFIX}/secrets/POSTGRES_PASSWORD" \
    --type SecureString \
    --value "$DB_PASSWORD" \
    --description "Ember staging PostgreSQL application password" \
    >/dev/null
  SECRETS[POSTGRES_PASSWORD]="$DB_PASSWORD"
fi

if [[ ! "$DB_PASSWORD" =~ ^[A-Za-z0-9_-]{24,128}$ ]]; then
  die "POSTGRES_PASSWORD must be 24-128 URL-safe characters (A-Za-z0-9_-); rotate it in SSM"
fi

DB_NAME="${VALUES[EMBER_POSTGRES_DB]:-ember}"
DB_USER="${VALUES[EMBER_POSTGRES_USER]:-ember}"

# ---- render ----------------------------------------------------------------------------
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

rendered_keys=""
while IFS= read -r line; do
  if [[ "$line" =~ ^([A-Z][A-Z0-9_]*)= ]]; then
    key="${BASH_REMATCH[1]}"
    if [[ -n "${VALUES[$key]+set}" ]]; then
      printf '%s=%s\n' "$key" "${VALUES[$key]}"
      rendered_keys+=" ${key}"
      continue
    fi
    case "$key" in
      DATABASE_URL)
        # Built here so the URL and the Docker secret can never diverge.
        printf 'DATABASE_URL=postgres://%s:%s@postgres:5432/%s\n' "$DB_USER" "$DB_PASSWORD" "$DB_NAME"
        rendered_keys+=" DATABASE_URL"
        continue
        ;;
      EMBER_POSTGRES_PASSWORD_FILE)
        printf 'EMBER_POSTGRES_PASSWORD_FILE=%s\n' "$PASSWORD_FILE"
        continue
        ;;
    esac
  fi
  printf '%s\n' "$line"
done < "$TEMPLATE" > "$tmp"

# Write the two credential artifacts with restrictive modes, atomically.
install -d -m 0700 "$(dirname "$OUTPUT")" "$(dirname "$PASSWORD_FILE")"
install -m 0600 "$tmp" "$OUTPUT"
printf '%s' "$DB_PASSWORD" > "${PASSWORD_FILE}.tmp"
chmod 0600 "${PASSWORD_FILE}.tmp"
mv "${PASSWORD_FILE}.tmp" "$PASSWORD_FILE"

unset DB_PASSWORD VALUES SECRETS

log "wrote ${OUTPUT} (mode 0600) and ${PASSWORD_FILE} (mode 0600)"
log "SSM overrides applied:${rendered_keys:- none}"

# The guard runs on the freshly rendered file so a bad parameter is caught now, not after
# the containers restart.
"${SCRIPT_DIR}/preflight.sh" "--env-file=${OUTPUT}" --mode=staging
