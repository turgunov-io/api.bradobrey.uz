// Public company-code entry for the kiosk and barber apps (MULTI_TENANCY
// Phase 1 step B1): POST /api/companies/resolve { code }.
//
// 200 { company: { id, name, code, logo_url, primary_color, currency },
//       branches: [{ id, name, address }] }   (active branches only)
// 404 { code: 'COMPANY_NOT_FOUND' } for unknown, suspended or malformed codes
//     — one answer, so the endpoint does not tell them apart.
// No auth; routers/companies.js rate-limits it per IP.
const { COMPANY_NOT_FOUND, companyRepo, normalizeCompanyCode } = require('../utils/tenant');

const toPublicCompany = (row) => ({
  id: row.id,
  name: row.name,
  code: row.code,
  logo_url: row.logo_url ?? null,
  primary_color: row.primary_color ?? null,
  currency: row.currency,
});

function createCompaniesController({ repo = companyRepo } = {}) {
  async function resolve(req, res) {
    const raw = req.body?.code;
    if (raw === undefined || raw === null || raw === '') {
      return res.status(400).json({ code: 'COMPANY_CODE_REQUIRED', error: 'code is required' });
    }
    const code = normalizeCompanyCode(raw);
    try {
      const company = code ? await repo.findActiveByCode(code) : null;
      if (!company) return res.status(404).json({ ...COMPANY_NOT_FOUND });
      const branches = await repo.listActiveBranches(company.id);
      return res.status(200).json({
        company: toPublicCompany(company),
        branches: branches.map(({ id, name, address }) => ({ id, name, address: address ?? null })),
      });
    } catch (error) {
      console.error('[companies] resolve failed:', error?.code || error?.message);
      return res.status(500).json({ error: 'Failed to resolve company' });
    }
  }

  return { resolve };
}

module.exports = {
  createCompaniesController,
  companies: createCompaniesController(),
  toPublicCompany,
};
