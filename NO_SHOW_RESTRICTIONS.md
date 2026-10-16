# Marketplace no-show restrictions

The additive migration `db/postgres/marketplace_tz_compliance.sql` creates the
`marketplace_no_show_violations` history table and the `no_show_restrictions`
platform setting. Apply the migration before enabling the policy in production.

The policy defaults to 24 hours after the first confirmed no-show, 72 hours
after the second, and 7 days after the third and later violations. Counts are
limited to the configured lookback window. The unique `queue_entry_id`
constraint makes processing a repeated status request idempotent.

Admin API:

- `GET /api/marketplace/admin/settings`
- `PATCH /api/marketplace/admin/settings/no_show_restrictions` with `{ value: ... }`

Customer API:

- `GET /api/marketplace/compliance/restriction`

Both single and group booking creation return HTTP 403 with
`code: BOOKING_RESTRICTED`, `blocked_until`, and `reason` while a restriction
is active. The customer session remains valid.
