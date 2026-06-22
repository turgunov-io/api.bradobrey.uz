const { db } = require("../config/postgres");

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

const SELECT_WITH_MARKETPLACE = "id, code, service_ids, expires_at, is_used, metadata, marketplace_barbershop_id, created_at";
const SELECT_BASE = "id, code, service_ids, expires_at, is_used, metadata, created_at";

const selectCertificates = async (queryFactory) => {
  let { data, error } = await queryFactory(SELECT_WITH_MARKETPLACE);

  if (isMissingColumnError(error, "marketplace_barbershop_id")) {
    ({ data, error } = await queryFactory(SELECT_BASE));
  }

  if (isMissingColumnError(error, "created_at")) {
    const fallbackWithMarketplace = SELECT_WITH_MARKETPLACE.replace(", created_at", "");
    const fallbackBase = SELECT_BASE.replace(", created_at", "");
    ({ data, error } = await queryFactory(fallbackWithMarketplace));
    if (isMissingColumnError(error, "marketplace_barbershop_id")) {
      ({ data, error } = await queryFactory(fallbackBase));
    }
  }

  if (Array.isArray(data)) {
    data = data.map((item) => ({
      ...item,
      marketplace_barbershop_id: item.marketplace_barbershop_id || null,
    }));
  } else if (data) {
    data.marketplace_barbershop_id = data.marketplace_barbershop_id || null;
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
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Certificate not found" });

    return res.json({ certificate: data, item: data });
  }

  async active(req, res) {
    let { data, error } = await selectCertificates((select) => db
      .from("certificates")
      .select(select)
      .order("code", { ascending: true }));

    if (isMissingRelationError(error, "certificates")) {
      return missingCertificatesResponse(res);
    }

    if (error) {
      return res.status(500).json({ error: error.message });
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
    const { code, service_ids, expires_at, metadata, marketplace_barbershop_id } = req.body || {};

    if (!code || typeof code !== "string") {
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
      .eq("code", code)
      .maybeSingle();

    if (existsError) {
      if (isMissingRelationError(existsError, "certificates")) {
        return res.status(501).json({
          error: "Certificates table is not configured",
          hint: "Apply db/postgres/certificates.sql",
        });
      }
      return res.status(500).json({ error: existsError.message });
    }
    if (existing) {
      return res.status(409).json({ error: "Certificate code already exists" });
    }

    const payload = {
      code,
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
      return res.status(500).json({ error: insertError.message });
    }

    return res.status(201).json({ certificate: inserted });
  }

  async update(req, res) {
    const { id } = req.params || {};
    if (!id) return res.status(400).json({ error: "Certificate id is required" });

    const { code, service_ids, expires_at, metadata, marketplace_barbershop_id, is_used } = req.body || {};
    const update = {};

    if (code !== undefined) {
      if (!code || typeof code !== "string") return res.status(400).json({ error: "code cannot be empty" });
      update.code = code;
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
    if (is_used !== undefined) update.is_used = Boolean(is_used);

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
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Certificate not found" });

    return res.json({ certificate: data, item: data });
  }

  async remove(req, res) {
    const { id } = req.params || {};
    if (!id) return res.status(400).json({ error: "Certificate id is required" });

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
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Certificate not found" });

    return res.json({ deleted: true, id: data.id });
  }
}

module.exports = new Certificate();
