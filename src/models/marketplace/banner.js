const { supabase } = require("../../config/supabase");
const {
    uploadBufferToSupabaseWithFolder,
} = require("../../composable/uploadImage");

class BannerMarketplace {
    async all(req, res) {
        const { data, error } = await supabase
            .from('banners')
            .select('*')

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        return res.status(200).json({ data });
    }

    async create(req, res) {
        const {
            title_uz, title_ru, title_en,
            description_uz, description_ru, description_en,
            is_active, sort_order
        } = req.body || {};

        const file = req.file;
        if (!file || !file.buffer) {
            return res.status(400).json({ error: 'Image file (field "file") is required' });
        }

        const { data: uploadData, error: uploadErr } = await uploadBufferToSupabaseWithFolder(
            file.buffer,
            file.mimetype,
            'banners',
            'banner'
        );

        if (uploadErr || !uploadData?.publicUrl) {
            return res.status(500).json({ error: uploadErr?.message || 'Image upload failed' });
        }

        return res.json({ uploadData });

        const parsedIsActive =
            typeof is_active === 'string'
                ? is_active.toLowerCase() !== 'false'
                : is_active === undefined
                    ? true
                    : Boolean(is_active);

        const parsedSortOrder = Number.isFinite(Number(sort_order))
            ? Number(sort_order)
            : 0;

        const insertPayload = {
            image_url: uploadData.publicUrl,
            title_uz: title_uz || null,
            title_ru: title_ru || null,
            title_en: title_en || null,
            description_uz: description_uz || null,
            description_ru: description_ru || null,
            description_en: description_en || null,
            is_active: parsedIsActive,
            sort_order: parsedSortOrder,
        };

        const { data, error } = await supabase
            .from('app.banners')
            .insert(insertPayload)
            .select('*')
            .single();

        if (error) {
            if (uploadData?.path) {
                try {
                    await supabase.storage.from('images').remove([uploadData.path]);
                } catch (_removeErr) {
                }
            }
            return res.status(500).json({ error: error.message });
        }

        return res.status(201).json(data);
    }
}

module.exports = new BannerMarketplace();
