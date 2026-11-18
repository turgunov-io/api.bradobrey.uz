const { db } = require("../config/postgres");
const { uploadBufferImageWithFolder } = require("../composable/uploadImage");

const SELECT_WITH_MARKETPLACE =
  "id, name, address, city, work_hours, timezone, is_active, marketplace_barbershop_id";
const SELECT_BASE = "id, name, address, city, work_hours, timezone, is_active";
// photo_url comes from db/postgres/branches.sql; reads fall back while the
// column is not migrated yet so listing branches never breaks.
const SELECT_WITH_PHOTO = `${SELECT_WITH_MARKETPLACE}, photo_url`;

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
  let { data, error, count } = await queryFactory(SELECT_WITH_PHOTO);

  if (isMissingColumnError(error, "photo_url")) {
    ({ data, error, count } = await queryFactory(SELECT_WITH_MARKETPLACE));
  }

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

  // photo_url may only be cleared through the payload; new photos arrive as an uploaded file.
  if (body.photo_url !== undefined) {
    if (normalizeText(body.photo_url) !== null) return { error: "photo_url can only be cleared; upload a file to set it" };
    payload.photo_url = null;
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

const PHOTO_CONTENT_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

// Stores an uploaded branch photo (multipart field "photo") and saves its URL.
const attachUploadedPhoto = async (file, branchId) => {
  if (!file) return { photoUrl: undefined };
  if (!PHOTO_CONTENT_TYPES.has(String(file.mimetype || "").toLowerCase())) {
    return { error: { status: 400, message: "photo must be a JPEG, PNG or WebP image" } };
  }

  const { data: upload, error: uploadError } = await uploadBufferImageWithFolder(file.buffer, file.mimetype, "branches", branchId);
  if (uploadError) return { error: { status: 500, message: "Failed to store branch photo" } };

  const { error } = await db.from("branches").update({ photo_url: upload.publicUrl }).eq("id", branchId);
  if (error) {
    const message = isMissingColumnError(error, "photo_url")
      ? "Branch photos are not available: apply db/postgres/branches.sql"
      : error.message;
    return { error: { status: 500, message } };
  }

  return { photoUrl: upload.publicUrl };
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

    const { photoUrl, error: photoError } = await attachUploadedPhoto(req.file, data.id);
    if (photoError) return res.status(photoError.status).json({ error: photoError.message, branch: data });
    if (photoUrl) data.photo_url = photoUrl;

    return res.status(201).json({ branch: data, entry: data, item: data });
  }

  async update(req, res) {
    const { id } = req.params || {};
    if (!id) return res.status(400).json({ error: "Branch id is required" });

    const { payload, error: payloadError } = normalizeBranchPayload(req.body || {}, { partial: true });
    if (payloadError) return res.status(400).json({ error: payloadError });
    if (!Object.keys(payload).length && !req.file) return res.status(400).json({ error: "No fields to update" });

    let writePayload = { ...payload };
    // A photo-only PATCH has nothing else to write; read the branch instead.
    let { data, error } = Object.keys(writePayload).length
      ? await db
        .from("branches")
        .update(writePayload)
        .eq("id", id)
        .select(SELECT_WITH_MARKETPLACE)
        .maybeSingle()
      : await db
        .from("branches")
        .select(SELECT_WITH_MARKETPLACE)
        .eq("id", id)
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

    const { photoUrl, error: photoError } = await attachUploadedPhoto(req.file, data.id);
    if (photoError) return res.status(photoError.status).json({ error: photoError.message, branch: data });
    if (photoUrl) data.photo_url = photoUrl;

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
module.exports._internals = { normalizeBranchPayload, attachUploadedPhoto };
