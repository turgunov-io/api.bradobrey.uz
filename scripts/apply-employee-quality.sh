#!/usr/bin/env bash
set -euo pipefail

# Apply only the Employee Quality v1 schema and its one-time permission
# backfill. The script is intentionally explicit because this changes the
# production PostgreSQL schema and creates immutable audit structures.
#
# Usage:
#   CONFIRM_PRODUCTION=YES bash ./scripts/apply-employee-quality.sh
#   CONFIRM_PRODUCTION=YES RESTART_PM2=1 PM2_APP_NAME=bradobrey bash ./scripts/apply-employee-quality.sh

cd "$(dirname "$0")/.."

if [[ "${CONFIRM_PRODUCTION:-}" != "YES" ]]; then
  echo "Refusing to modify the database without CONFIRM_PRODUCTION=YES." >&2
  echo "Run: CONFIRM_PRODUCTION=YES bash ./scripts/apply-employee-quality.sh" >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql is not installed or not available in PATH." >&2
  exit 1
fi

# Load only DATABASE_URL from the deployment-local environment when it was not
# explicitly exported by the process manager or shell. Do not source the full
# .env file: it may contain values that are not valid shell assignments.
if [[ -z "${DATABASE_URL:-}" && -f .env ]]; then
  DATABASE_URL=$(sed -n 's/^DATABASE_URL=//p' .env | head -n 1)
  DATABASE_URL=${DATABASE_URL%\"}
  DATABASE_URL=${DATABASE_URL#\"}
  export DATABASE_URL
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is not configured." >&2
  exit 1
fi

PSQL=(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -q)

echo "Checking PostgreSQL connectivity..."
"${PSQL[@]}" -c 'select 1;' >/dev/null

echo "Checking required base tables..."
required_tables=(queue_entries queue_status_events users user_permissions services)
for table in "${required_tables[@]}"; do
  exists=$("${PSQL[@]}" -Atc "select to_regclass('public.${table}') is not null;")
  if [[ "$exists" != "t" ]]; then
    echo "ERROR: required table public.${table} is missing." >&2
    exit 1
  fi
done

echo "Applying Employee Quality v1 schema..."
"${PSQL[@]}" -f db/postgres/employee_quality_ranking.sql

echo "Applying Employee Quality permission backfill..."
"${PSQL[@]}" -f db/postgres/employee_quality_permissions_backfill.sql

echo "Verifying Employee Quality schema..."
"${PSQL[@]}" -Atc "
  select case
    when to_regclass('public.queue_quality_assessments') is null
      then 'queue_quality_assessments is missing'
    when to_regclass('public.queue_quality_review_events') is null
      then 'queue_quality_review_events is missing'
    else 'employee-quality-schema-ok'
  end;
" | grep -Fx 'employee-quality-schema-ok' >/dev/null

"${PSQL[@]}" -Atc "
  select 'assessments=' || count(*) from queue_quality_assessments;
  select 'review_events=' || count(*) from queue_quality_review_events;
" 

echo "Employee Quality v1 schema and permission backfill applied successfully."

if [[ "${RESTART_PM2:-0}" == "1" ]]; then
  if ! command -v pm2 >/dev/null 2>&1; then
    echo "ERROR: RESTART_PM2=1 but pm2 is not installed or not available in PATH." >&2
    exit 1
  fi

  PM2_APP_NAME=${PM2_APP_NAME:-bradobrey-api}
  echo "Restarting PM2 app: ${PM2_APP_NAME}"
  pm2 restart "$PM2_APP_NAME" --update-env
fi
