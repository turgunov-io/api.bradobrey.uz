const { db } = require("../config/postgres");

const SELECT_WITH_MARKETPLACE =
  "id, name, address, city, work_hours, timezone, is_active, marketplace_barbershop_id";
const SELECT_BASE = "id, name, address, city, work_hours, timezone, is_active";

const normalizeText = (value) => {
  if (value === undefined) return undefined;
  if (value === null) return null;

  const text = String(value).trim();
  return text || null;
};

const parseBoolean = (value, fallback = undefined) => {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;

  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
};

const parseWorkHours = (value) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "object") return value;

  const raw = String(value).trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (_err) {
    return "__invalid__";
  }
};

const isMissingColumnError = (error, column) => {
  const message = String(error?.message || error?.details || "").toLowerCase();
  return Boolean(error) && message.includes(column.toLowerCase()) && (
    message.includes("does not exist") ||
    message.includes("could not find") ||
    message.includes("schema cache")
  );
};

const withMarketplaceFallback = async (queryFactory) => {
  let { data, error, count } = await queryFactory(SELECT_WITH_MARKETPLACE);

  if (isMissingColumnError(error, "marketplace_barbershop_id")) {
    ({ data, error, count } = await queryFactory(SELECT_BASE));
    if (Array.isArray(data)) {
      data = data.map((item) => ({ ...item, marketplace_barbershop_id: null }));
    } else if (data) {
      data.marketplace_barbershop_id = null;
    }
  }

  return { data, error, count };
};

const normalizeBranchPayload = (body = {}, { partial = false } = {}) => {
  const payload = {};

  if (body.name !== undefined) {
    const name = normalizeText(body.name);
    if (!name) return { error: "name is required" };
    payload.name = name;
  } else if (!partial) {
    return { error: "name is required" };
  }

  for (const key of ["address", "city", "timezone", "marketplace_barbershop_id"]) {
    if (body[key] !== undefined) payload[key] = normalizeText(body[key]);
  }

  if (body.is_active !== undefined) {
    const isActive = parseBoolean(body.is_active, null);
    if (isActive === null) return { error: "is_active must be a boolean" };
    payload.is_active = isActive;
  } else if (!partial) {
    payload.is_active = true;
  }

  if (body.work_hours !== undefined) {
    const workHours = parseWorkHours(body.work_hours);
    if (workHours === "__invalid__") {
      return { error: "work_hours must be an object or valid JSON string" };
    }
    payload.work_hours = workHours;
  }

  return { payload };
};

const conflictResponse = (res, code, message) => res.status(409).json({
  code,
  data: { code },
  error: message,
});

class Branches {
  async list(req, res) {
    const { active } = req.query || {};

    const activeFilter = parseBoolean(active, undefined);
    if (active !== undefined && activeFilter === undefined) {
      return res.status(400).json({ error: "active must be a boolean" });
    }

    const { data, error, count } = await withMarketplaceFallback((select) => {
      let query = db.from("branches").select(select, { count: "exact" });
      if (activeFilter !== undefined) query = query.eq("is_active", activeFilter);
      return query.order("name", { ascending: true });
    });

    if (error) return res.status(500).json({ error: error.message });

    const items = data || [];
    return res.json({
      branches: items,
      count: count ?? items.length,
      data: items,
      items,
      total: count ?? items.length,
    });
  }

  async getById(req, res) {
    const { id } = req.params || {};
    if (!id) return res.status(400).json({ error: "Branch id is required" });

    const { data, error } = await withMarketplaceFallback((select) => db
      .from("branches")
      .select(select)
      .eq("id", id)
      .maybeSingle());

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Branch not found" });

    return res.json({ branch: data, entry: data, item: data });
  }

  async create(req, res) {
    const { payload, error: payloadError } = normalizeBranchPayload(req.body || {});
    if (payloadError) return res.status(400).json({ error: payloadError });

    let writePayload = { ...payload };
    let { data, error } = await db
      .from("branches")
      .insert(writePayload)
      .select(SELECT_WITH_MARKETPLACE)
      .maybeSingle();

    if (isMissingColumnError(error, "marketplace_barbershop_id")) {
      delete writePayload.marketplace_barbershop_id;
      ({ data, error } = await db
        .from("branches")
        .insert(writePayload)
        .select(SELECT_BASE)
        .maybeSingle());
      if (data) data.marketplace_barbershop_id = null;
    }

    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ branch: data, entry: data, item: data });
  }

  async update(req, res) {
    const { id } = req.params || {};
    if (!id) return res.status(400).json({ error: "Branch id is required" });

    const { payload, error: payloadError } = normalizeBranchPayload(req.body || {}, { partial: true });
    if (payloadError) return res.status(400).json({ error: payloadError });
    if (!Object.keys(payload).length) return res.status(400).json({ error: "No fields to update" });

    let writePayload = { ...payload };
    let { data, error } = await db
      .from("branches")
      .update(writePayload)
      .eq("id", id)
      .select(SELECT_WITH_MARKETPLACE)
      .maybeSingle();

    if (isMissingColumnError(error, "marketplace_barbershop_id")) {
      delete writePayload.marketplace_barbershop_id;
      if (Object.keys(writePayload).length) {
        ({ data, error } = await db
          .from("branches")
          .update(writePayload)
          .eq("id", id)
          .select(SELECT_BASE)
          .maybeSingle());
      } else {
        ({ data, error } = await db
          .from("branches")
          .select(SELECT_BASE)
          .eq("id", id)
          .maybeSingle());
      }
      if (data) data.marketplace_barbershop_id = null;
    }

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Branch not found" });

    return res.json({ branch: data, entry: data, item: data });
  }

  async setActive(req, res, isActive) {
    const { id } = req.params || {};
    if (!id) return res.status(400).json({ error: "Branch id is required" });

    const { data, error } = await withMarketplaceFallback((select) => db
      .from("branches")
      .update({ is_active: isActive })
      .eq("id", id)
      .select(select)
      .maybeSingle());

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Branch not found" });

    return res.json({ branch: data, entry: data, item: data });
  }

  async remove(req, res) {
    const { id } = req.params || {};
    if (!id) return res.status(400).json({ error: "Branch id is required" });

    const force = parseBoolean(req.query?.force, false) === true;

    const { data: existing, error: existingError } = await db
      .from("branches")
      .select("id")
      .eq("id", id)
      .maybeSingle();

    if (existingError) return res.status(500).json({ error: existingError.message });
    if (!existing) return res.status(404).json({ error: "Branch not found" });

    if (!force) {
      const [queueEntries, users, barbers] = await Promise.all([
        db.from("queue_entries").select("id", { count: "exact" }).eq("branch_id", id).limit(1),
        db.from("users").select("id", { count: "exact" }).eq("branch_id", id).limit(1),
        db.from("barbers").select("id", { count: "exact" }).eq("branch_id", id).limit(1),
      ]);

      if (queueEntries.error) return res.status(500).json({ error: queueEntries.error.message });
      if (users.error) return res.status(500).json({ error: users.error.message });
      if (barbers.error) return res.status(500).json({ error: barbers.error.message });

      if ((queueEntries.count || 0) > 0) {
        return conflictResponse(res, "BRANCH_DELETE_HAS_QUEUE_ENTRIES", "Branch has queue entries");
      }
      if ((users.count || 0) > 0) {
        return conflictResponse(res, "BRANCH_DELETE_HAS_USERS", "Branch has users");
      }
      if ((barbers.count || 0) > 0) {
        return conflictResponse(res, "BRANCH_DELETE_HAS_BARBERS", "Branch has barbers");
      }
    }

    if (force) {
      const updates = await Promise.all([
        db.from("queue_entries").update({ branch_id: null }).eq("branch_id", id),
        db.from("users").update({ branch_id: null }).eq("branch_id", id),
        db.from("barbers").update({ branch_id: null }).eq("branch_id", id),
      ]);

      const updateError = updates.find((result) => result.error)?.error;
      if (updateError) return res.status(500).json({ error: updateError.message });
    }

    const { data, error } = await db
      .from("branches")
      .delete()
      .eq("id", id)
      .select("id")
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Branch not found" });

    return res.json({ deleted: true, id: data.id });
  }
}

module.exports = new Branches();
