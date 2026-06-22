const { db } = require("../../config/postgres");
const {
    removeUploadedFile,
    uploadBufferImageWithFolder,
} = require("../../composable/uploadImage");

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.mkv'];

const checkType = (url) => {
    const normalized = (url || '').toLowerCase();
    if (!normalized) return null;
    if (IMAGE_EXTENSIONS.some((ext) => normalized.endsWith(ext))) return 'image';
    if (VIDEO_EXTENSIONS.some((ext) => normalized.endsWith(ext))) return 'video';
    return 'unknown';
};

const formatBanner = (item, index = 0) => ({
    id: item?.id ? item.id : index,
    locales: {
        title: {
            ...(item?.title_uz != null && { uz: item.title_uz }),
            ...(item?.title_ru != null && { ru: item.title_ru }),
            ...(item?.title_en != null && { en: item.title_en }),
        },
        description: {
            ...(item?.description_uz != null && { uz: item.description_uz }),
            ...(item?.description_ru != null && { ru: item.description_ru }),
            ...(item?.description_en != null && { en: item.description_en }),
        },
    },
    media: {
        type: checkType(item?.image_url),
        url: item?.image_url || null,
    },
    is_active: item?.is_active,
    sort_order: item?.sort_order ? item.sort_order : index,
});

class BannerMarketplace {
    async all(req, res) {
        const { data, error } = await db
            .from('banners')
            .select('*');

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        const entries = (data || []).map((item, index) => formatBanner(item, index));

        return res.status(200).json({ data: entries });
    }

    async getById(req, res) {
        const { id } = req.params;
        const { data, error } = await db
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

        const entry = formatBanner(data, 0);

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

        const { data: uploadData, error: uploadErr } = await uploadBufferImageWithFolder(
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

        const { data, error } = await db
            .from('banners')
            .insert(insertPayload)
            .select('*')
            .single();

        if (error) {
            if (uploadData?.path) {
                try {
                    const { error: removeError } = await removeUploadedFile(uploadData.path);
                    if (removeError) throw removeError;
                } catch (_removeErr) {
                    return res.status(500).json({ error: `Failed to clean up uploaded image after database error: ${_removeErr.message}` });
                }
            }
            return res.status(500).json({ error: error.message });
        }

        return res.status(201).json({ entry: formatBanner(data, 0) });
    }

    async update(req, res) {
        const { id } = req.params;
        if (!id) return res.status(400).json({ error: 'Banner id is required' });

        const {
            title_uz,
            title_ru,
            title_en,
            description_uz,
            description_ru,
            description_en,
            is_active,
            sort_order,
        } = req.body || {};

        const file = req.file;

        const { data: current, error: fetchError } = await db
            .from('banners')
            .select('*')
            .eq('id', id)
            .maybeSingle();

        if (fetchError) return res.status(500).json({ error: fetchError.message });
        if (!current) return res.status(404).json({ error: 'Banner not found' });

        let uploadedImage = null;
        if (file) {
            if (!file.buffer) {
                return res.status(400).json({ error: 'Uploaded file buffer is missing' });
            }

            const { data: uploadData, error: uploadErr } =
                await uploadBufferImageWithFolder(
                    file.buffer,
                    file.mimetype,
                    'banners',
                    'banner'
                );

            if (uploadErr || !uploadData?.publicUrl) {
                return res.status(500).json({ error: uploadErr?.message || 'Image upload failed' });
            }

            uploadedImage = uploadData;
        }

        const parseBoolean = (value, fallback) => {
            if (value === undefined) return fallback;
            if (typeof value === 'string') {
                const normalized = value.trim().toLowerCase();
                if (normalized === 'true') return true;
                if (normalized === 'false') return false;
            }
            return Boolean(value);
        };

        const parseSortOrder = (value, fallback) => {
            if (value === undefined || value === null || value === '') {
                return fallback ?? 0;
            }
            const numeric = Number(value);
            return Number.isFinite(numeric) ? numeric : null;
        };

        const nextSortOrder = parseSortOrder(sort_order, current.sort_order);
        if (nextSortOrder === null) {
            if (uploadedImage?.path) {
                await removeUploadedFile(uploadedImage.path).catch(() => { });
            }
            return res.status(400).json({ error: 'sort_order must be a number' });
        }

        const nextEntry = {
            title_uz: title_uz !== undefined ? (title_uz || null) : current.title_uz,
            title_ru: title_ru !== undefined ? (title_ru || null) : current.title_ru,
            title_en: title_en !== undefined ? (title_en || null) : current.title_en,
            description_uz: description_uz !== undefined ? (description_uz || null) : current.description_uz,
            description_ru: description_ru !== undefined ? (description_ru || null) : current.description_ru,
            description_en: description_en !== undefined ? (description_en || null) : current.description_en,
            is_active: parseBoolean(is_active, current.is_active),
            sort_order: nextSortOrder,
            image_url: uploadedImage?.publicUrl || current.image_url,
        };

        const hasTitle = [nextEntry.title_uz, nextEntry.title_ru, nextEntry.title_en]
            .some((value) => value !== null && value !== undefined && String(value).trim() !== '');
        const hasDescription = [nextEntry.description_uz, nextEntry.description_ru, nextEntry.description_en]
            .some((value) => value !== null && value !== undefined && String(value).trim() !== '');

        if (!hasTitle || !hasDescription) {
            if (uploadedImage?.path) {
                await removeUploadedFile(uploadedImage.path).catch(() => { });
            }
            return res.status(400).json({
                error: 'At least one title and one description must be provided',
            });
        }

        const { data, error } = await db
            .from('banners')
            .update(nextEntry)
            .eq('id', id)
            .select('*')
            .single();

        if (error) {
            if (uploadedImage?.path) {
                await removeUploadedFile(uploadedImage.path).catch(() => { });
            }
            return res.status(500).json({ error: error.message });
        }

        if (uploadedImage?.path) {
            const oldPath = extractStoragePath(current.image_url);
            if (oldPath) {
                await removeUploadedFile(oldPath).catch(() => { });
            }
        }

        return res.status(200).json({ entry: formatBanner(data, 0) });

        function extractStoragePath(publicUrl) {
            if (!publicUrl) return null;
            if (publicUrl.startsWith('/uploads/')) return publicUrl.slice('/uploads/'.length);
            try {
                const parsed = new URL(publicUrl);
                if (parsed.pathname.startsWith('/uploads/')) {
                    return decodeURIComponent(parsed.pathname.slice('/uploads/'.length));
                }
            } catch (_error) {
                // Not an absolute URL.
            }
            const match = publicUrl.match(/\/storage\/v1\/object\/public\/images\/(.+)$/);
            return match ? match[1] : null;
        }
    }

    async deactivate(req, res) {
        const { id } = req.params;
        const { is_active } = req.body;

        const { data, error } = await db
            .from('banners')
            .update({ is_active })
            .eq('id', id)
            .select('*')
            .single();

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        return res.status(200).json({ entry: formatBanner(data, 0) });
    }
}

module.exports = new BannerMarketplace();
