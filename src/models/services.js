const { supabase } = require("../config/supabase");

class Services {
    async getAll(req, res) {
        const { data, error } = await supabase
            .from("services")
            .select("*")
            .order("created_at", { ascending: false });

        if (error) return res.status(500).json({ error: error.message });
        return res.json(data);
    }
}

module.exports = new Services();