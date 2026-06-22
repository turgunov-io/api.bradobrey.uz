const { db } = require("../config/postgres");
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
        const { active, grouped } = req.query || {};

        let query = db.from("services").select("*");

        if (active !== undefined) {
            const activeFlag = String(active).toLowerCase() === "true" || active === "1";
            query = query.eq("is_active", activeFlag);
        }

        const { data, error } = await query
            .order("category", { ascending: true, nullsFirst: false })
            .order("base_price", { ascending: true })
            .order("name", { ascending: true });

        if (error) return res.status(500).json({ error: error.message });

        const categories = groupServicesByCategory(data || []);

        if (grouped === "true" || grouped === "1") {
            return res.json({ categories });
        }

        return res.json({ categories });
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

        return res.json({ entry: data });
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
                image: uploadedImageUrl !== undefined ? uploadedImageUrl : normalizeText(image),
                is_active: parseBoolean(is_active, true),
                marketplace_barbershop_id: normalizeText(marketplace_barbershop_id),
                name: String(name).trim(),
            })
            .select("*")
            .maybeSingle();

        if (error) return res.status(500).json({ error: error.message });
        return res.status(201).json(data);
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
            update.image = uploadedImageUrl;
        } else if (image !== undefined) {
            update.image = normalizeText(image);
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

        return res.json(data);
    }

    async remove(req, res) {
        const { id } = req.params || {};
        if (!id) return res.status(400).json({ error: "Service id is required" });

        const { data, error } = await db
            .from("services")
            .delete()
            .eq("id", id)
            .select("id")
            .maybeSingle();

        if (error) return res.status(500).json({ error: error.message });
        if (!data) return res.status(404).json({ error: "Service not found" });

        return res.json({ deleted: true, id: data.id });
    }

    // backwards compatibility
    async getAll(req, res) {
        return this.list(req, res);
    }
}

module.exports = new Services();
