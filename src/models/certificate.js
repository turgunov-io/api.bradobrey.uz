const { verifyAny } = require('../utils/authToken');
const { db } = require("../config/postgres");
const { withCertificateStatus } = require('../services/certificateLifecycle');
const { sameId } = require('../utils/companyScope');

// Company scope (MULTI_TENANCY Phase 1 B2a): certificates are unique per
// (company_id, code); every query below is limited to the caller's company,
// loaded from users.company_id (never from the request).

const GLOBAL_CERTIFICATE_ROLES = new Set(['admin_network', 'admin', 'super-manager']);
const CERTIFICATE_PERMISSION = 'certificates.manage';
const CERTIFICATE_ROLES = new Set(['admin_network', 'admin_branch', 'admin', 'manager', 'super-manager']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sendCertificateServerError = (res, error) => {
  console.error('[certificate] request failed', { code: error?.code || 'UNKNOWN' });
  return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', code: 'INTERNAL_SERVER_ERROR' });
};

const requireCertificateAccess = async (req, res) => {
  const header = String(req.headers?.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: 'UNAUTHORIZED', code: 'UNAUTHORIZED' });
    return null;
  }

  let payload;
  try {
    payload = verifyAny(token);
  } catch (_) {
    res.status(401).json({ error: 'UNAUTHORIZED', code: 'UNAUTHORIZED' });
    return null;
  }

  const userId = payload?.sub || payload?.id;
  if (!userId || !UUID_PATTERN.test(String(userId))) {
    res.status(403).json({ error: 'FORBIDDEN', code: 'FORBIDDEN' });
    return null;
  }

  const { data: user, error: userError } = await db
    .from('users')
    .select('id, role, company_id')
    .eq('id', userId)
    .maybeSingle();
  if (userError) return sendCertificateServerError(res, userError);
  if (!user) {
    res.status(401).json({ error: 'UNAUTHORIZED', code: 'UNAUTHORIZED' });
    return null;
  }
  // Phase 2 M3: the stored role decides, never the token's role claim.
  const role = String(user.role || '').trim().toLowerCase();
  if (!CERTIFICATE_ROLES.has(role)) {
    res.status(403).json({ error: 'FORBIDDEN', code: 'FORBIDDEN' });
    return null;
  }
  const companyId = user.company_id ? String(user.company_id) : null;
  const tenantCompanyId = req.tenant?.companyId;
  if (!companyId || (tenantCompanyId && !sameId(tenantCompanyId, companyId))) {
    res.status(403).json({ error: 'Company context is required', code: 'COMPANY_REQUIRED' });
    return null;
  }

  // "Global" roles manage every certificate of their company.
  if (GLOBAL_CERTIFICATE_ROLES.has(role)) return { userId, role, companyId };

  const permissionResult = await db
    .from('user_permissions')
    .select('permission')
    .eq('user_id', userId)
    .eq('permission', CERTIFICATE_PERMISSION)
    .maybeSingle();
  if (permissionResult.error && !String(permissionResult.error.message || '').includes('user_permissions')) {
    return sendCertificateServerError(res, permissionResult.error);
  }
  if (!permissionResult.data) {
    res.status(403).json({ error: 'FORBIDDEN', code: 'FORBIDDEN' });
    return null;
  }

  return { userId, role, companyId };
};

const barbershopInCompany = async (barbershopId, companyId) => {
  if (!barbershopId) return true;
  const { data, error } = await db.from('marketplace_barbershops').select('id, company_id').eq('id', barbershopId).maybeSingle();
  if (error) throw error;
  return sameId(data?.company_id, companyId);
};
const BARBERSHOP_FORBIDDEN = { error: 'Barbershop belongs to another company', code: 'BARBERSHOP_COMPANY_MISMATCH' };

const isMissingColumnError = (error, column) => {
  const message = String(error?.message || error?.details || "").toLowerCase();
  return Boolean(error) && message.includes(column.toLowerCase()) && (
    message.includes("does not exist") ||
    message.includes("could not find") ||
    message.includes("schema cache")
  );
};

const isMissingRelationError = (error, relation) => {
  const message = String(error?.message || error?.details || "").toLowerCase();
  return Boolean(error) && message.includes(relation.toLowerCase()) && (
    message.includes("does not exist") ||
    message.includes("could not find") ||
    message.includes("schema cache")
  );
};

const LIFECYCLE_SELECT = "reserved_queue_entry_id, reserved_at, used_queue_entry_id, used_at";

const isMissingLifecycleColumnError = (error) => (
  isMissingColumnError(error, 'reserved_queue_entry_id')
  || isMissingColumnError(error, 'reserved_at')
  || isMissingColumnError(error, 'used_queue_entry_id')
  || isMissingColumnError(error, 'used_at')
);

const buildCertificateSelect = ({ lifecycle, marketplace, createdAt }) => {
  const fields = [
    'id',
    'code',
    'service_ids',
    'expires_at',
    'is_used',
    'metadata',
  ];
  if (marketplace) fields.push('marketplace_barbershop_id');
  if (lifecycle) fields.push(LIFECYCLE_SELECT);
  if (createdAt) fields.push('created_at');
  return fields.join(', ');
};

const selectCertificates = async (queryFactory) => {
  let options = { lifecycle: true, marketplace: true, createdAt: true };
  let result = { data: null, error: null };

  for (let attempt = 0; attempt < 4; attempt += 1) {
    result = await queryFactory(buildCertificateSelect(options));
    if (!result.error) break;

    if (options.lifecycle && isMissingLifecycleColumnError(result.error)) {
      options = { ...options, lifecycle: false };
      continue;
    }
    if (options.marketplace && isMissingColumnError(result.error, "marketplace_barbershop_id")) {
      options = { ...options, marketplace: false };
      continue;
    }
    if (options.createdAt && isMissingColumnError(result.error, "created_at")) {
      options = { ...options, createdAt: false };
      continue;
    }
    break;
  }

  let { data, error } = result;

  if (Array.isArray(data)) {
    data = data.map((item) => ({
      ...item,
      marketplace_barbershop_id: item.marketplace_barbershop_id || null,
      ...withCertificateStatus(item),
    }));
  } else if (data) {
    data.marketplace_barbershop_id = data.marketplace_barbershop_id || null;
    data = withCertificateStatus(data);
  }

  return { data, error };
};

const missingCertificatesResponse = (res) => res.json({
  certificates: [],
  count: 0,
  items: [],
  setup_required: true,
  hint: "Apply db/postgres/certificates.sql",
});

class Certificate {
  async getById(req, res) {
    const access = await requireCertificateAccess(req, res);
    if (!access) return;
    const { id } = req.params || {};
    if (!id) return res.status(400).json({ error: "Certificate id is required" });

    const { data, error } = await selectCertificates((select) => db
      .from("certificates")
      .select(select)
      .eq("id", id)
      .eq("company_id", access.companyId)
      .maybeSingle());

    if (isMissingRelationError(error, "certificates")) {
      return res.status(501).json({
        error: "Certificates table is not configured",
        hint: "Apply db/postgres/certificates.sql",
      });
    }
    if (error) return sendCertificateServerError(res, error);
    if (!data) return res.status(404).json({ error: "Certificate not found" });

    return res.json({ certificate: data, item: data });
  }

  async active(req, res) {
    const access = await requireCertificateAccess(req, res);
    if (!access) return;
    let { data, error } = await selectCertificates((select) => db
      .from("certificates")
      .select(select)
      .eq("company_id", access.companyId)
      .order("code", { ascending: true }));

    if (isMissingRelationError(error, "certificates")) {
      return missingCertificatesResponse(res);
    }

    if (error) {
      return sendCertificateServerError(res, error);
    }

    const now = new Date();
    const items = (data || []).filter((certificate) => {
      if (certificate?.is_used) {
        return false;
      }

      if (!certificate?.expires_at) {
        return true;
      }

      const expiresAt = new Date(certificate.expires_at);

      return !Number.isNaN(expiresAt.getTime()) && expiresAt >= now;
    });

    return res.json({
      certificates: items,
      count: items.length,
      items,
    });
  }

  async create(req, res) {
    const access = await requireCertificateAccess(req, res);
    if (!access) return;
    const { code, service_ids, expires_at, metadata, marketplace_barbershop_id } = req.body || {};

    const normalizedCode = typeof code === 'string' ? code.trim().toUpperCase() : '';
    if (!normalizedCode) {
      return res.status(400).json({ error: "code is required" });
    }

    if (!Array.isArray(service_ids) || service_ids.length === 0) {
      return res
        .status(400)
        .json({ error: "service_ids must be a non-empty array" });
    }

    let expiresAtIso = null;
    if (expires_at) {
      const d = new Date(expires_at);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ error: "expires_at must be a valid date/time" });
      }
      expiresAtIso = d.toISOString();
    }

    try {
      if (!(await barbershopInCompany(marketplace_barbershop_id || null, access.companyId))) {
        return res.status(403).json(BARBERSHOP_FORBIDDEN);
      }
    } catch (checkError) {
      return sendCertificateServerError(res, checkError);
    }

    const { data: existing, error: existsError } = await db
      .from("certificates")
      .select("id")
      .eq("company_id", access.companyId)
      .eq("code", normalizedCode)
      .maybeSingle();

    if (existsError) {
      if (isMissingRelationError(existsError, "certificates")) {
        return res.status(501).json({
          error: "Certificates table is not configured",
          hint: "Apply db/postgres/certificates.sql",
        });
      }
      return sendCertificateServerError(res, existsError);
    }
    if (existing) {
      return res.status(409).json({ error: "Certificate code already exists" });
    }

    const payload = {
      company_id: access.companyId,
      code: normalizedCode,
      service_ids,
      expires_at: expiresAtIso,
      metadata: metadata || null,
      marketplace_barbershop_id: marketplace_barbershop_id || null,
    };

    let { data: inserted, error: insertError } = await db
      .from("certificates")
      .insert(payload)
      .select("id, code, service_ids, expires_at, is_used, metadata, marketplace_barbershop_id, created_at")
      .maybeSingle();

    if (isMissingColumnError(insertError, "marketplace_barbershop_id")) {
      delete payload.marketplace_barbershop_id;
      ({ data: inserted, error: insertError } = await db
        .from("certificates")
        .insert(payload)
        .select("id, code, service_ids, expires_at, is_used, metadata, created_at")
        .maybeSingle());
    }

    if (isMissingColumnError(insertError, "created_at")) {
      ({ data: inserted, error: insertError } = await db
        .from("certificates")
        .insert(payload)
        .select("id, code, service_ids, expires_at, is_used, metadata")
        .maybeSingle());
    }

    if (isMissingRelationError(insertError, "certificates")) {
      return res.status(501).json({
        error: "Certificates table is not configured",
        hint: "Apply db/postgres/certificates.sql",
      });
    }

    if (insertError) {
      if (String(insertError.code) === '23505') return res.status(409).json({ error: "Certificate code already exists" });
      return sendCertificateServerError(res, insertError);
    }

    return res.status(201).json({ certificate: inserted });
  }

  async update(req, res) {
    const access = await requireCertificateAccess(req, res);
    if (!access) return;
    const { id } = req.params || {};
    if (!id) return res.status(400).json({ error: "Certificate id is required" });

    const { code, service_ids, expires_at, metadata, marketplace_barbershop_id, is_used } = req.body || {};
    const update = {};

    if (is_used !== undefined) {
      return res.status(400).json({
        error: "is_used is managed by queue completion",
        code: 'CERTIFICATE_LIFECYCLE_MANAGED',
      });
    }

    if (code !== undefined) {
      const normalizedCode = typeof code === 'string' ? code.trim().toUpperCase() : '';
      if (!normalizedCode) return res.status(400).json({ error: "code cannot be empty" });
      update.code = normalizedCode;
    }

    if (service_ids !== undefined) {
      if (!Array.isArray(service_ids) || service_ids.length === 0) {
        return res.status(400).json({ error: "service_ids must be a non-empty array" });
      }
      update.service_ids = service_ids;
    }

    if (expires_at !== undefined) {
      if (!expires_at) {
        update.expires_at = null;
      } else {
        const d = new Date(expires_at);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({ error: "expires_at must be a valid date/time" });
        }
        update.expires_at = d.toISOString();
      }
    }

    if (metadata !== undefined) update.metadata = metadata || null;
    if (marketplace_barbershop_id !== undefined) update.marketplace_barbershop_id = marketplace_barbershop_id || null;
    if (!Object.keys(update).length) return res.status(400).json({ error: "No fields to update" });
    try {
      if (!(await barbershopInCompany(update.marketplace_barbershop_id || null, access.companyId))) {
        return res.status(403).json(BARBERSHOP_FORBIDDEN);
      }
    } catch (checkError) {
      return sendCertificateServerError(res, checkError);
    }

    const { data, error } = await selectCertificates((select) => db
      .from("certificates")
      .update(update)
      .eq("id", id)
      .eq("company_id", access.companyId)
      .select(select)
      .maybeSingle());

    if (isMissingRelationError(error, "certificates")) {
      return res.status(501).json({
        error: "Certificates table is not configured",
        hint: "Apply db/postgres/certificates.sql",
      });
    }
    if (error && String(error.code) === '23505') return res.status(409).json({ error: "Certificate code already exists" });
    if (error) return sendCertificateServerError(res, error);
    if (!data) return res.status(404).json({ error: "Certificate not found" });

    return res.json({ certificate: data, item: data });
  }

  async remove(req, res) {
    const access = await requireCertificateAccess(req, res);
    if (!access) return;
    const { id } = req.params || {};
    if (!id) return res.status(400).json({ error: "Certificate id is required" });

    const { data: linkedEntry, error: linkError } = await db
      .from('queue_entries')
      .select('id')
      .eq('company_id', access.companyId)
      .eq('certificate_id', id)
      .limit(1)
      .maybeSingle();
    if (linkError && !String(linkError.message || '').includes("certificate_id")) {
      return sendCertificateServerError(res, linkError);
    }
    if (linkedEntry) {
      return res.status(409).json({ error: 'CERTIFICATE_IN_USE', code: 'CERTIFICATE_IN_USE' });
    }

    const { data, error } = await db
      .from("certificates")
      .delete()
      .eq("id", id)
      .eq("company_id", access.companyId)
      .select("id")
      .maybeSingle();

    if (isMissingRelationError(error, "certificates")) {
      return res.status(501).json({
        error: "Certificates table is not configured",
        hint: "Apply db/postgres/certificates.sql",
      });
    }
    if (error) return sendCertificateServerError(res, error);
    if (!data) return res.status(404).json({ error: "Certificate not found" });

    return res.json({ deleted: true, id: data.id });
  }
}

module.exports = new Certificate();
