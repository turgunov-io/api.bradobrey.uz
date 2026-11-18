// PUT /api/kiosk/enrollment-code { enrollment_code } — a company's network
// admins rotate their own company's kiosk enrollment code (security review H1).
//
// The route is guarded by staffAccess.requireStaff (role, permissions and
// company loaded from the DB; suspended company -> 403). Here: network roles
// only, the company is always req.tenant.companyId (never the body). Only the
// SHA-256 hash is stored; the code is never echoed back. The platform owner
// sets/clears codes via PATCH /api/platform/companies/:id.
const { NETWORK_ROLES } = require('../utils/employeeQualityAccess');
const { companyRepo } = require('../utils/tenant');
const { hashEnrollmentCode, validateEnrollmentCode } = require('../utils/kioskEnrollmentCode');

function createKioskEnrollmentController({ repo = companyRepo } = {}) {
  async function rotate(req, res) {
    const role = String(req.staffAccess?.role || '').trim().toLowerCase();
    const companyId = req.tenant?.companyId ? String(req.tenant.companyId) : '';
    if (!NETWORK_ROLES.has(role) || !companyId) {
      return res.status(403).json({ code: 'FORBIDDEN', error: 'Only company network administrators can change the kiosk enrollment code' });
    }
    const [code, error] = validateEnrollmentCode(req.body?.enrollment_code);
    if (error) return res.status(400).json({ error });
    try {
      const updated = await repo.setKioskEnrollmentHash(companyId, hashEnrollmentCode(code));
      if (!updated) return res.status(404).json({ error: 'Company not found' });
      return res.status(200).json({ updated: true });
    } catch (dbError) {
      console.error('[kiosk] enrollment code rotation failed:', dbError?.code || dbError?.message);
      return res.status(500).json({ error: 'Failed to update the kiosk enrollment code' });
    }
  }

  return { rotate };
}

module.exports = {
  createKioskEnrollmentController,
  kioskEnrollment: createKioskEnrollmentController(),
};
