const { supabase } = require("../config/supabase");

class Services {
    async list(_req, res) {
        const { data, error } = await supabase
            .from("services")
            .select("*")
            .order("base_price", { ascending: true });

        if (error) return res.status(500).json({ error: error.message });
        return res.json({ data: data });
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
        const { name, duration_minutes, base_price = null, is_active = true } = req.body || {};

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

        const { data, error } = await supabase
            .from("services")
            .insert({
                name: String(name).trim(),
                duration_minutes: duration,
                base_price: price,
                is_active: Boolean(is_active),
            })
            .select("*")
            .maybeSingle();

        if (error) return res.status(500).json({ error: error.message });
        return res.status(201).json(data);
    }

    async update(req, res) {
        const { id } = req.params || {};
        if (!id) return res.status(400).json({ error: "Service id is required" });

        const { name, duration_minutes, base_price, is_active, image } = req.body || {};
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
