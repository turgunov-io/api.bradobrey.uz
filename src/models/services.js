const { db } = require("../config/postgres");
const { toAbsolutePublicUrl } = require("../config/uploads");
const { uploadBufferImageWithFolder } = require("../composable/uploadImage");

const DEFAULT_CATEGORY_LABEL = "Uncategorized";

const normalizeCategory = (category) => {
    if (category === undefined || category === null) return null;
    const trimmed = String(category).trim();
    return trimmed.length ? trimmed : null;
};

const normalizeText = (value) => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const trimmed = String(value).trim();
    return trimmed.length ? trimmed : null;
};

const normalizeImageUrl = (req, value) => {
    const normalized = normalizeText(value);
    return normalized ? toAbsolutePublicUrl(normalized, req) : normalized;
};

const serviceItem = (req, service) => {
    if (!service) return service;
    return {
        ...service,
        image: service.image ? toAbsolutePublicUrl(service.image, req) : null,
    };
};

const serviceItems = (req, services = []) => (services || []).map((service) => serviceItem(req, service));

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

const uploadServiceImage = async (req) => {
    if (!req.file) return undefined;

    const { data, error } = await uploadBufferImageWithFolder(
        req.file.buffer,
        req.file.mimetype || "image/png",
        "services",
        "service"
    );

    if (error) throw new Error(error.message || "Failed to upload service image");
    return data?.publicUrl || null;
};

const groupServicesByCategory = (services = []) => {
    const groups = new Map();

    for (const service of services) {
        const key = service && service.category
            ? String(service.category).trim()
            : "";
        const category = key || DEFAULT_CATEGORY_LABEL;

        if (!groups.has(category)) groups.set(category, []);
        groups.get(category).push(service);
    }

    return Array.from(groups.entries()).map(([category, services]) => ({
        category,
        services,
    }));
};

class Services {
    async list(req, res) {
        const { active, grouped, include_inactive } = req.query || {};

        let query = db.from("services").select("*");

        if (active !== undefined) {
            const activeFlag = String(active).toLowerCase() === "true" || active === "1";
            query = query.eq("is_active", activeFlag);
        } else if (!parseBoolean(include_inactive, false)) {
            query = query.eq("is_active", true);
        }

        const { data, error } = await query
            .order("category", { ascending: true, nullsFirst: false })
            .order("base_price", { ascending: true })
            .order("name", { ascending: true });

        if (error) return res.status(500).json({ error: error.message });

        const items = serviceItems(req, data || []);
        const categories = groupServicesByCategory(items);

        if (grouped === "true" || grouped === "1") {
            return res.json({ categories });
        }

        return res.json({ data: items, services: items, categories });
    }

    async getById(req, res) {
        const { id } = req.params || {};
        if (!id) return res.status(400).json({ error: "Service id is required" });

        const { data, error } = await db
            .from("services")
            .select("*")
            .eq("id", id)
            .maybeSingle();

        if (error) return res.status(500).json({ error: error.message });
        if (!data) return res.status(404).json({ error: "Service not found" });

        return res.json({ entry: serviceItem(req, data) });
    }

    async create(req, res) {
        const {
            base_price,
            branch_id,
            category,
            category_name,
            duration,
            duration_minutes,
            image,
            is_active = true,
            marketplace_barbershop_id,
            name,
            price,
        } = req.body || {};

        if (!name || !String(name).trim()) {
            return res.status(400).json({ error: "name is required" });
        }
        const durationValue = Number(duration_minutes ?? duration);
        if (!Number.isInteger(durationValue) || durationValue <= 0) {
            return res.status(400).json({ error: "duration_minutes must be a positive integer" });
        }
        const priceInput = req.body?.base_price ?? price;
        const priceValue = priceInput === null || priceInput === undefined || priceInput === ""
            ? null
            : Number(priceInput);
        if (priceValue !== null && (!Number.isFinite(priceValue) || priceValue < 0)) {
            return res.status(400).json({ error: "base_price must be a non-negative number" });
        }

        let uploadedImageUrl;
        try {
            uploadedImageUrl = await uploadServiceImage(req);
        } catch (uploadError) {
            return res.status(500).json({ error: uploadError.message });
        }

        const normalizedCategory = normalizeCategory(category ?? category_name);

        const { data, error } = await db
            .from("services")
            .insert({
                base_price: priceValue,
                branch_id: normalizeText(branch_id),
                category: normalizedCategory,
                duration_minutes: durationValue,
                image: uploadedImageUrl !== undefined
                    ? normalizeImageUrl(req, uploadedImageUrl)
                    : normalizeImageUrl(req, image),
                is_active: parseBoolean(is_active, true),
                marketplace_barbershop_id: normalizeText(marketplace_barbershop_id),
                name: String(name).trim(),
            })
            .select("*")
            .maybeSingle();

        if (error) return res.status(500).json({ error: error.message });
        return res.status(201).json(serviceItem(req, data));
    }

    async update(req, res) {
        const { id } = req.params || {};
        if (!id) return res.status(400).json({ error: "Service id is required" });

        const {
            base_price,
            branch_id,
            category,
            category_name,
            duration,
            duration_minutes,
            image,
            is_active,
            marketplace_barbershop_id,
            name,
            price,
        } = req.body || {};
        const update = {};

        if (name !== undefined) {
            if (!String(name).trim()) return res.status(400).json({ error: "name cannot be empty" });
            update.name = String(name).trim();
        }
        if (duration_minutes !== undefined || duration !== undefined) {
            const durationValue = Number(duration_minutes ?? duration);
            if (!Number.isInteger(durationValue) || durationValue <= 0) {
                return res.status(400).json({ error: "duration_minutes must be a positive integer" });
            }
            update.duration_minutes = durationValue;
        }
        if (base_price !== undefined || price !== undefined) {
            const priceInput = base_price ?? price;
            const priceValue = priceInput === null || priceInput === "" ? null : Number(priceInput);
            if (priceValue !== null && (!Number.isFinite(priceValue) || priceValue < 0)) {
                return res.status(400).json({ error: "base_price must be a non-negative number or null" });
            }
            update.base_price = priceValue;
        }

        if (is_active !== undefined) {
            const activeFlag = parseBoolean(is_active, null);
            if (activeFlag === null) return res.status(400).json({ error: "is_active must be a boolean" });
            update.is_active = activeFlag;
        }

        let uploadedImageUrl;
        try {
            uploadedImageUrl = await uploadServiceImage(req);
        } catch (uploadError) {
            return res.status(500).json({ error: uploadError.message });
        }

        if (uploadedImageUrl !== undefined) {
            update.image = normalizeImageUrl(req, uploadedImageUrl);
        } else if (image !== undefined) {
            update.image = normalizeImageUrl(req, image);
        }

        if (category !== undefined || category_name !== undefined) {
            update.category = normalizeCategory(category ?? category_name);
        }

        if (branch_id !== undefined) {
            update.branch_id = normalizeText(branch_id);
        }

        if (marketplace_barbershop_id !== undefined) {
            update.marketplace_barbershop_id = normalizeText(marketplace_barbershop_id);
        }

        if (Object.keys(update).length === 0) {
            return res.status(400).json({ error: "No fields to update" });
        }

        update.updated_at = new Date().toISOString();

        const { data, error } = await db
            .from("services")
            .update(update)
            .eq("id", id)
            .select("*")
            .maybeSingle();

        if (error) return res.status(500).json({ error: error.message });
        if (!data) return res.status(404).json({ error: "Service not found" });

        return res.json(serviceItem(req, data));
    }

    async remove(req, res) {
        const id = normalizeText(
            req.params?.id ?? req.body?.id ?? req.body?.service_id ?? req.query?.id ?? req.query?.service_id
        );
        if (!id) return res.status(400).json({ error: "Service id is required" });

        const { data, error } = await db
            .from("services")
            .delete()
            .eq("id", id)
            .select("id")
            .maybeSingle();

        if (error) {
            if (String(error.code) === "23503") {
                const { data: softDeleted, error: softDeleteError } = await db
                    .from("services")
                    .update({ is_active: false, updated_at: new Date().toISOString() })
                    .eq("id", id)
                    .select("id")
                    .maybeSingle();

                if (softDeleteError) return res.status(500).json({ error: softDeleteError.message });
                if (!softDeleted) return res.status(404).json({ error: "Service not found" });

                return res.json({ deleted: true, id: softDeleted.id, soft_deleted: true });
            }

            return res.status(500).json({ error: error.message });
        }
        if (!data) return res.status(404).json({ error: "Service not found" });

        return res.json({ deleted: true, id: data.id });
    }

    // backwards compatibility
    async getAll(req, res) {
        return this.list(req, res);
    }
}

module.exports = new Services();
