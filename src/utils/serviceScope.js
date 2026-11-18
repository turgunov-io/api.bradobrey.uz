// Service (price / duration) scoping — MULTI_TENANCY Phase 1 step B2.
//
// Owner rule D1: services and prices never mix between companies. A service
// row may be used for a queue entry (price, duration, name) only when
//   service.company_id = the entry's company            (always)
//   service.branch_id IS NULL OR = the entry's branch   (shared within the company)
// The entry's company is queue_entries.company_id, else the company of its
// branch. Unknown company => no service applies (fail closed: price 0 /
// "invalid service"), never "any company's row with this id".

const { companyIdOfBranch } = require('./companyScope');

// Lazily resolved: config/postgres needs database env at require time.
const db = () => require('../config/postgres').db;

const idText = (value) => {
  const text = String(value ?? '').trim();
  return text ? text.toLowerCase() : null;
};

const serviceIdsForEntry = (entry) => {
  if (Array.isArray(entry?.service_ids) && entry.service_ids.length) return entry.service_ids.filter(Boolean);
  return entry?.service_id ? [entry.service_id] : [];
};

/**
 * True when the service belongs to `companyId` and to `branchId` or is shared
 * (branch_id NULL) within that company.
 */
function isServiceUsable(service, { companyId, branchId } = {}) {
  const company = idText(companyId);
  if (!service || !company || idText(service.company_id) !== company) return false;
  const serviceBranch = idText(service.branch_id);
  if (!serviceBranch) return true;
  return serviceBranch === idText(branchId);
}

/**
 * SQL predicate for a services alias joined to a queue_entries alias.
 * Use as `join services s on s.id = ref.id and ${serviceMatchesEntrySql('s', 'q')}`.
 */
function serviceMatchesEntrySql(serviceAlias, entryAlias) {
  const ok = /^[a-z_][a-z0-9_]*$/i;
  if (!ok.test(serviceAlias) || !ok.test(entryAlias)) throw new Error('invalid SQL alias');
  return `${serviceAlias}.company_id = ${entryAlias}.company_id`
    + ` and (${serviceAlias}.branch_id is null or ${serviceAlias}.branch_id = ${entryAlias}.branch_id)`;
}

/**
 * Company of every entry: entry.company_id, else its branch's company
 * (one lookup per distinct branch). Returns Map(entry -> companyId|null).
 */
async function resolveEntryCompanies(entries) {
  const byBranch = new Map();
  const result = new Map();
  for (const entry of entries) {
    if (idText(entry?.company_id)) {
      result.set(entry, String(entry.company_id));
      continue;
    }
    const branch = idText(entry?.branch_id);
    if (!branch) {
      result.set(entry, null);
      continue;
    }
    if (!byBranch.has(branch)) byBranch.set(branch, await companyIdOfBranch(entry.branch_id));
    result.set(entry, byBranch.get(branch));
  }
  return result;
}

/**
 * Loads the services referenced by `entries`, restricted to the entries'
 * companies, and returns a lookup of the usable services per entry.
 * @param {object[]} entries queue entries ({ branch_id, company_id?, service_id, service_ids })
 * @param {string} columns extra service columns (id, branch_id, company_id are always selected)
 * @returns {Promise<(entry: object) => object[]>}
 */
async function loadServicesForEntries(entries, columns = 'base_price, duration_minutes') {
  const items = (Array.isArray(entries) ? entries : []).filter(Boolean);
  const companies = await resolveEntryCompanies(items);
  const ids = Array.from(new Set(items.flatMap(serviceIdsForEntry).map(String)));
  const companyIds = Array.from(new Set(Array.from(companies.values()).filter(Boolean)));

  const byId = new Map();
  if (ids.length && companyIds.length) {
    let query = db().from('services').select(`id, branch_id, company_id, ${columns}`).in('id', ids);
    query = companyIds.length === 1 ? query.eq('company_id', companyIds[0]) : query.in('company_id', companyIds);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    for (const service of data || []) byId.set(idText(service.id), service);
  }

  return (entry) => {
    const scope = { companyId: companies.get(entry) ?? null, branchId: entry?.branch_id };
    return serviceIdsForEntry(entry)
      .map((id) => byId.get(idText(id)))
      .filter((service) => isServiceUsable(service, scope));
  };
}

/**
 * Services by id usable in one branch of one company, in the requested order.
 * Missing / foreign / other-branch ids are dropped.
 */
async function loadBranchServices(serviceIds, { branchId, companyId = null, columns = 'base_price, duration_minutes' } = {}) {
  const ids = Array.from(new Set((Array.isArray(serviceIds) ? serviceIds : []).map((v) => String(v ?? '').trim()).filter(Boolean)));
  if (!ids.length) return [];
  const company = idText(companyId) ? String(companyId) : await companyIdOfBranch(branchId);
  if (!company) return [];
  const { data, error } = await db().from('services')
    .select(`id, branch_id, company_id, ${columns}`)
    .eq('company_id', company)
    .in('id', ids);
  if (error) throw new Error(error.message);
  const byId = new Map((data || [])
    .filter((service) => isServiceUsable(service, { companyId: company, branchId }))
    .map((service) => [idText(service.id), service]));
  return ids.map((id) => byId.get(idText(id))).filter(Boolean);
}

module.exports = {
  isServiceUsable,
  loadBranchServices,
  loadServicesForEntries,
  resolveEntryCompanies,
  serviceIdsForEntry,
  serviceMatchesEntrySql,
};
