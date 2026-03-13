const { supabase } = require("../config/supabase");

const DEFAULT_CATEGORY_LABEL = "Uncategorized";

const normalizeCategory = (category) => {
    if (category === undefined || category === null) return null;
    const trimmed = String(category).trim();
    return trimmed.length ? trimmed : null;
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

        let query = supabase.from("services").select("*");

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

        const { data, error } = await supabase
            .from("services")
            .select("*")
            .eq("id", id)
            .maybeSingle();

        if (error) return res.status(500).json({ error: error.message });
        if (!data) return res.status(404).json({ error: "Service not found" });

        return res.json({ entry: data });
    }

    async create(req, res) {
        const { name, duration_minutes, base_price = null, is_active = true, category } = req.body || {};

        if (!name || !String(name).trim()) {
            return res.status(400).json({ error: "name is required" });
        }
        const duration = Number(duration_minutes);
        if (!Number.isInteger(duration) || duration <= 0) {
            return res.status(400).json({ error: "duration_minutes must be a positive integer" });
        }
        const price = base_price === null || base_price === undefined ? null : Number(base_price);
        if (price !== null && (!Number.isFinite(price) || price < 0)) {
            return res.status(400).json({ error: "base_price must be a non-negative number" });
        }

        const normalizedCategory = normalizeCategory(category);

        const { data, error } = await supabase
            .from("services")
            .insert({
                name: String(name).trim(),
                duration_minutes: duration,
                base_price: price,
                is_active: Boolean(is_active),
                category: normalizedCategory,
            })
            .select("*")
            .maybeSingle();

        if (error) return res.status(500).json({ error: error.message });
        return res.status(201).json(data);
    }

    async update(req, res) {
        const { id } = req.params || {};
        if (!id) return res.status(400).json({ error: "Service id is required" });

        const { name, duration_minutes, base_price, is_active, image, category } = req.body || {};
        const update = {};

        if (name !== undefined) {
            if (!String(name).trim()) return res.status(400).json({ error: "name cannot be empty" });
            update.name = String(name).trim();
        }
        if (duration_minutes !== undefined) {
            const duration = Number(duration_minutes);
            if (!Number.isInteger(duration) || duration <= 0) {
                return res.status(400).json({ error: "duration_minutes must be a positive integer" });
            }
            update.duration_minutes = duration;
        }
        if (base_price !== undefined) {
            const price = base_price === null ? null : Number(base_price);
            if (price !== null && (!Number.isFinite(price) || price < 0)) {
                return res.status(400).json({ error: "base_price must be a non-negative number or null" });
            }
            update.base_price = price;
        }

        if (is_active !== undefined) {
            update.is_active = Boolean(is_active);
        }

        if (image !== undefined) {
            update.image = String(image);
        }

        if (category !== undefined) {
            update.category = normalizeCategory(category);
        }

        if (Object.keys(update).length === 0) {
            return res.status(400).json({ error: "No fields to update" });
        }

        const { data, error } = await supabase
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

        const { data, error } = await supabase
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
