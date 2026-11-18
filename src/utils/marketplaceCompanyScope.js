// Company scope for marketplace (ŞAF app) clients — MULTI_TENANCY Phase 1 B2.
//
// marketplace_clients are platform-global until Phase 5 (variant A/B/C is not
// decided), so they have no company_id. A company's admin sees a marketplace
// client only when that client has a footprint in the company:
//
//   1. a marketplace booking whose person has a queue entry of the company
//      (marketplace_booking_persons.queue_entry_id -> queue_entries.company_id);
//   2. a booking origin at the company's barbershop
//      (client_barbershop_origins.company_id);
//   3. a review left for the company (marketplace_reviews.company_id);
//   4. a legacy `clients` row of the company with the same phone digits —
//      that row carries the company's visits and cashback wallet.
//
// Everything else (other companies' clients, never-booked sign-ups) is hidden.

/**
 * SQL subquery returning the marketplace_client ids visible to one company.
 * Use as `mc.id in (${companyMarketplaceClientIdsSql('$3')})`.
 * @param {string} companyParam positional parameter holding the company id, e.g. '$3'
 * @returns {string}
 */
function companyMarketplaceClientIdsSql(companyParam) {
  if (!/^\$\d+$/.test(String(companyParam))) throw new Error('companyParam must be a positional parameter');
  const company = `${companyParam}::uuid`;
  return `
    select mb.marketplace_client_id
      from marketplace_bookings mb
      join marketplace_booking_persons mbp on mbp.booking_id = mb.id
      join queue_entries mq on mq.id = mbp.queue_entry_id
     where mq.company_id = ${company}
    union
    select o.marketplace_client_id
      from client_barbershop_origins o
     where o.company_id = ${company}
    union
    select rv.marketplace_client_id
      from marketplace_reviews rv
     where rv.company_id = ${company}
    union
    select pmc.id
      from marketplace_clients pmc
      join clients lc
        on lc.company_id = ${company}
       and nullif(regexp_replace(coalesce(lc.phone, ''), '[^0-9]', '', 'g'), '')
         = regexp_replace(coalesce(pmc.phone, ''), '[^0-9]', '', 'g')`;
}

/**
 * Company of a DB-loaded admin (createAdminAuth result), or null.
 * @param {{ companyId?: string|null, company_id?: string|null, tenant?: { companyId?: string|null } }|null} auth
 * @returns {string|null}
 */
function adminCompanyId(auth) {
  const id = auth?.companyId || auth?.company_id || auth?.tenant?.companyId;
  return id ? String(id) : null;
}

/**
 * Responds 403 and returns null when the admin has no company.
 * @returns {string|null}
 */
function requireAdminCompany(auth, res) {
  const companyId = adminCompanyId(auth);
  if (!companyId) {
    res.status(403).json({ code: 'COMPANY_REQUIRED', error: 'Company scope is required' });
    return null;
  }
  return companyId;
}

module.exports = {
  adminCompanyId,
  companyMarketplaceClientIdsSql,
  requireAdminCompany,
};
