const { supabase } = require("../config/supabase");

const isMissingColumnError = (error, column) => {
  const message = String(error?.message || error?.details || "").toLowerCase();
  return Boolean(error) && message.includes(column.toLowerCase()) && (
    message.includes("does not exist") ||
    message.includes("could not find") ||
    message.includes("schema cache")
  );
};

class Certificate {
  async active(req, res) {
    let { data, error } = await supabase
      .from("certificates")
      .select("id, code, service_ids, expires_at, is_used, metadata, marketplace_barbershop_id")
      .order("code", { ascending: true });

    if (isMissingColumnError(error, "marketplace_barbershop_id")) {
      ({ data, error } = await supabase
        .from("certificates")
        .select("id, code, service_ids, expires_at, is_used, metadata")
        .order("code", { ascending: true }));
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

    const { data: existing, error: existsError } = await supabase
      .from("certificates")
      .select("id")
      .eq("code", code)
      .maybeSingle();

    if (existsError) {
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

    let { data: inserted, error: insertError } = await supabase
      .from("certificates")
      .insert(payload)
      .select("id, code, service_ids, expires_at, is_used, metadata, marketplace_barbershop_id")
      .maybeSingle();

    if (isMissingColumnError(insertError, "marketplace_barbershop_id")) {
      delete payload.marketplace_barbershop_id;
      ({ data: inserted, error: insertError } = await supabase
        .from("certificates")
        .insert(payload)
        .select("id, code, service_ids, expires_at, is_used, metadata")
        .maybeSingle());
    }

    if (insertError) {
      return res.status(500).json({ error: insertError.message });
    }

    return res.status(201).json({ certificate: inserted });
  }
}

module.exports = new Certificate();
