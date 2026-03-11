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

        function checkType(url) {
            return 'image' ? url.includes('.jpg') || url.includes('.jpeg') || url.includes('.png') : null;
        }

        const entries = data.map((item, index) => {
            return {
                id: item.id ? item.id : index,
                locales: {
                    title: {
                        ...(item.title_uz != null && { uz: item.title_uz }),
                        ...(item.title_ru != null && { ru: item.title_ru }),
                        ...(item.title_en != null && { en: item.title_en }),
                    },
                    description: {
                        ...(item.description_uz != null && { uz: item.description_uz }),
                        ...(item.description_ru != null && { ru: item.description_ru }),
                        ...(item.description_en != null && { en: item.description_en }),
                    },
                },
                media: {
                    type: checkType(item.image_url),
                    url: item.image_url,
                },
                is_active: item.is_active,
                sort_order: item.sort_order ? item.sort_order : index,
            }
        })

        return res.status(200).json({ data: entries });
    }

    async getById(req, res) {
        const { id } = req.params;
        const { data, error } = await supabase
            .from('banners')
            .select('*')
            .eq('id', id)
            .single();

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        if (!data) {
            return res.status(404).json({ error: 'Banner not found' });
        }

        function checkType(url) {
            return 'image' ? url.includes('.jpg') || url.includes('.jpeg') || url.includes('.png') : null;
        }

        const entry = {
            id: data.id,
            locales: {
                title: {
                    ...(data.title_uz != null && { uz: data.title_uz }),
                    ...(data.title_ru != null && { ru: data.title_ru }),
                    ...(data.title_en != null && { en: data.title_en }),
                },
                description: {
                    ...(data.description_uz != null && { uz: data.description_uz }),
                    ...(data.description_ru != null && { ru: data.description_ru }),
                    ...(data.description_en != null && { en: data.description_en }),
                },
            },
            media: {
                type: checkType(data.image_url),
                url: data.image_url,
            },
            is_active: data.is_active,
            sort_order: data.sort_order,
        };

        return res.status(200).json({ entry });
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
            image_url: uploadData.publicUrl,
        };

        if (!title_uz && !title_ru && !title_en) return res.status(400).json({ error: "At least one title (title_uz, title_ru, title_en) is required" });
        if (!description_uz && !description_ru && !description_en) return res.status(400).json({ error: "At least one description (description_uz, description_ru, description_en) is required" });

        const { data, error } = await supabase
            .from('banners')
            .insert(insertPayload)
            .select('*')
            .single();

        if (error) {
            if (uploadData?.path) {
                try {
                    await supabase.storage.from('images').remove([uploadData.path]);
                } catch (_removeErr) {
                    return res.status(500).json({ error: `Failed to clean up uploaded image after database error: ${_removeErr.message}` });
                }
            }
            return res.status(500).json({ error: error.message });
        }

        return res.status(201).json({ entry: data });
    }
}

module.exports = new BannerMarketplace();
