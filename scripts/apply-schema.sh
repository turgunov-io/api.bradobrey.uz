#!/usr/bin/env bash
#
# Apply all Postgres schema files idempotently to the production DB.
# Safe to re-run: every db/postgres/*.sql uses `create table if not exists`
# and `add column if not exists`, so existing tables are left untouched and
# only missing tables/columns are created.
#
# Usage (run on the server, from the repo root):
#   ./scripts/apply-schema.sh
#
# Requires DATABASE_URL in the environment or a local .env with it.

set -u

cd "$(dirname "$0")/.." || exit 1

# Load DATABASE_URL from .env if not already exported.
if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2-)"
  # strip surrounding quotes if present
  DATABASE_URL="${DATABASE_URL%\"}"; DATABASE_URL="${DATABASE_URL#\"}"
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set (export it or put it in .env)." >&2
  exit 1
fi

PSQL="psql $DATABASE_URL -v ON_ERROR_STOP=0 -q"

# Dependency-ordered: extensions and base tables first, then dependents.
FILES=(
  pgcrypto.sql
  users.sql
  user_permissions.sql
  branches.sql
  barbers.sql
  clients.sql
  client_ranks.sql
  service_categories.sql
  services.sql
  queue_entries.sql
  queue_entries_scheduling.sql
  queue_entries_mixed_payment_method.sql
  queue_entry_price_override.sql
  queue_entry_timestamps_tz.sql
  payments.sql
  certificates.sql
  promo_codes.sql
  cashback.sql
  media_assets.sql
  kiosk_ads.sql
  verifix.sql
  warehouse.sql
  finance_snapshots.sql
  marketplace_catalog.sql
  marketplace_clients.sql
  otp_codes.sql
  banners.sql
)

list_tables() {
  psql "$DATABASE_URL" -Atc \
    "select tablename from pg_tables where schemaname='public' order by 1;"
}

echo "=== Tables BEFORE ==="
BEFORE="$(list_tables)"
echo "$BEFORE"
echo

# Two passes so any inline-FK ordering gap in pass 1 self-heals in pass 2.
for pass in 1 2; do
  echo "=== Apply pass $pass ==="
  for f in "${FILES[@]}"; do
    if [ -f "db/postgres/$f" ]; then
      printf '  -> %s\n' "$f"
      $PSQL -f "db/postgres/$f" 2>&1 | sed 's/^/       /'
    else
      printf '  !! missing file: db/postgres/%s\n' "$f"
    fi
  done
  echo
done

echo "=== Tables AFTER ==="
AFTER="$(list_tables)"
echo "$AFTER"
echo

echo "=== Newly created tables ==="
comm -13 <(printf '%s\n' "$BEFORE") <(printf '%s\n' "$AFTER") | sed 's/^/  + /'
echo "(nothing above = you already had every table)"
