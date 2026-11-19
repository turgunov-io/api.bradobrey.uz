// Who may manage the platform (companies, their first admin, kiosk enrollment
// codes, platform owners) — MULTI_TENANCY 11.5 / 12. Management only: this
// predicate never grants access to any company's tenant data.
//
// `user` must be loaded from the DB with the company flags:
//   { role, company_id, company_is_default, company_status }
const { PLATFORM_OWNER_ROLE } = require('./tenant');

// Default-company roles that manage the platform besides platform_owner.
const PLATFORM_MANAGER_COMPANY_ROLES = new Set(['admin_network', 'admin']);

const normalizeRole = (role) => String(role || '').trim().toLowerCase();

/** True for the platform owner itself (DB role, no company). */
function isPlatformOwnerUser(user) {
  return normalizeRole(user?.role) === PLATFORM_OWNER_ROLE && !user?.company_id;
}

/**
 * True when the DB-loaded caller may manage the platform: platform_owner
 * without company, or admin_network/admin of the active DEFAULT company.
 * @param {{ role?: string, company_id?: string|null, company_is_default?: boolean|null, company_status?: string|null } | null | undefined} user
 */
function canManagePlatform(user) {
  if (!user) return false;
  const role = normalizeRole(user.role);
  if (role === PLATFORM_OWNER_ROLE) return !user.company_id;
  return PLATFORM_MANAGER_COMPANY_ROLES.has(role)
    && Boolean(user.company_id)
    && user.company_is_default === true
    && user.company_status === 'active';
}

module.exports = { PLATFORM_MANAGER_COMPANY_ROLES, canManagePlatform, isPlatformOwnerUser };
