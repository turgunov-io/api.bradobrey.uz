const { supabase } = require("../config/supabase");

class Certificate {
  async active(req, res) {
    const { data, error } = await supabase
      .from("certificates")
      .select("id, code, service_ids, expires_at, is_used, metadata")
      .order("code", { ascending: true });

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
    const { code, service_ids, expires_at, metadata } = req.body || {};

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

    const { data: inserted, error: insertError } = await supabase
      .from("certificates")
      .insert({
        code,
        service_ids,
        expires_at: expiresAtIso,
        metadata: metadata || null,
      })
      .select("id, code, service_ids, expires_at, is_used, metadata")
      .maybeSingle();

    if (insertError) {
      return res.status(500).json({ error: insertError.message });
    }

    return res.status(201).json({ certificate: inserted });
  }
}

module.exports = new Certificate();
