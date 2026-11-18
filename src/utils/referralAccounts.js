// Referral codes at sign-up — MULTI_TENANCY Phase 1 step B2.
//
// After migration 007 referral_accounts is unique on (company_id,
// referral_code) only. Sign-up has no company context, so a code must resolve
// to exactly ONE account (codes are generated unique across all companies —
// models/marketplace/compliance.js referral()). An ambiguous code is rejected
// as invalid instead of picking an arbitrary company's account. The referral
// then belongs to that account's company (its settings, its FK).

/**
 * @param {{ query: Function }} queryable pg pool or transaction client
 * @param {string} code referral code as entered
 * @param {string|null} newClientId the signing-up client (cannot refer itself)
 * @returns {Promise<{ marketplace_client_id: string, referral_code: string, company_id: string }|null>}
 */
async function findReferralAccountByCode(queryable, code, newClientId = null) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) return null;
  const result = await queryable.query(
    `select marketplace_client_id, referral_code, company_id
       from referral_accounts
      where referral_code = $1
        and ($2::uuid is null or marketplace_client_id <> $2::uuid)
      limit 2
      for update`,
    [normalized, newClientId],
  );
  const rows = result.rows || [];
  if (rows.length !== 1 || !rows[0].company_id) return null;
  return rows[0];
}

module.exports = { findReferralAccountByCode };
