-- 008_company_kiosk_enrollment — per-company kiosk enrollment codes
-- (security review H1, MULTI_TENANCY 9.7 / 9.10).
--
-- POST /api/kiosk/register used one platform-wide KIOSK_ENROLLMENT_CODE, so
-- staff of company B who knew it could register a kiosk into company A. Each
-- company now has its own code; only its SHA-256 hex digest is stored (same
-- scheme as kiosks.device_token_hash) and it is never returned by the API.
-- NULL = no code: the default company keeps the env fallback while it is the
-- only company; otherwise kiosks of that company enroll via staff only.
--
-- Additive (old code never reads the column), but the new API code selects
-- it: apply before deploying that code.
--
-- Rollback: db/migrations/down/008_company_kiosk_enrollment.down.sql

alter table companies add column if not exists kiosk_enrollment_code_hash text;

alter table companies drop constraint if exists companies_kiosk_enrollment_code_hash_check;
alter table companies
  add constraint companies_kiosk_enrollment_code_hash_check
  check (kiosk_enrollment_code_hash ~ '^[0-9a-f]{64}$');

comment on column companies.kiosk_enrollment_code_hash is
  'SHA-256 hex of the company kiosk enrollment code (never returned by the API); NULL = not set';
