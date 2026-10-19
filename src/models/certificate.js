const jwt = require('jsonwebtoken');
const { db } = require("../config/postgres");
const { withCertificateStatus } = require('../services/certificateLifecycle');

const GLOBAL_CERTIFICATE_ROLES = new Set(['admin_network', 'admin', 'super-manager']);
const CERTIFICATE_PERMISSION = 'certificates.manage';

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
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (_) {
    res.status(401).json({ error: 'UNAUTHORIZED', code: 'UNAUTHORIZED' });
    return null;
  }

  const userId = payload?.sub || payload?.id;
  const role = String(payload?.role || '').trim().toLowerCase();
  if (!userId || !role || !['admin_network', 'admin_branch', 'admin', 'manager', 'super-manager'].includes(role)) {
    res.status(403).json({ error: 'FORBIDDEN', code: 'FORBIDDEN' });
    return null;
  }

  const { data: user, error: userError } = await db
    .from('users')
    .select('id, role')
    .eq('id', userId)
    .maybeSingle();
  if (userError) return sendCertificateServerError(res, userError);
  if (!user) {
    res.status(401).json({ error: 'UNAUTHORIZED', code: 'UNAUTHORIZED' });
    return null;
  }

  if (GLOBAL_CERTIFICATE_ROLES.has(role)) return { userId, role };

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

  return { userId, role };
};

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
    if (!await requireCertificateAccess(req, res)) return;
    const { id } = req.params || {};
    if (!id) return res.status(400).json({ error: "Certificate id is required" });

    const { data, error } = await selectCertificates((select) => db
      .from("certificates")
      .select(select)
      .eq("id", id)
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
    if (!await requireCertificateAccess(req, res)) return;
    let { data, error } = await selectCertificates((select) => db
      .from("certificates")
      .select(select)
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
    if (!await requireCertificateAccess(req, res)) return;
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

    const { data: existing, error: existsError } = await db
      .from("certificates")
      .select("id")
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
      return sendCertificateServerError(res, insertError);
    }

    return res.status(201).json({ certificate: inserted });
  }

  async update(req, res) {
    if (!await requireCertificateAccess(req, res)) return;
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

    const { data, error } = await selectCertificates((select) => db
      .from("certificates")
      .update(update)
      .eq("id", id)
      .select(select)
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

  async remove(req, res) {
    if (!await requireCertificateAccess(req, res)) return;
    const { id } = req.params || {};
    if (!id) return res.status(400).json({ error: "Certificate id is required" });

    const { data: linkedEntry, error: linkError } = await db
      .from('queue_entries')
      .select('id')
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
