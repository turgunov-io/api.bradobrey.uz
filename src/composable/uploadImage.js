const { randomUUID } = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { removeUploadedFile, resolveUploadPath, toPublicUrl } = require("../config/uploads");

const EXTENSION_BY_CONTENT_TYPE = {
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
};

const sanitizePathSegment = (value, fallback) => {
    const cleaned = String(value || "")
        .replace(/\\/g, "/")
        .split("/")
        .filter(Boolean)
        .map((segment) => segment.replace(/[^A-Za-z0-9._-]/g, "-"))
        .filter(Boolean)
        .join("/");

    return cleaned || fallback;
};

async function uploadBase64Image(imageBase64, contentTypeInput, barberId) {
    let base64 = imageBase64;
    let contentType = contentTypeInput;
    const dataUrlMatch = /^data:(.+?);base64,(.+)$/.exec(imageBase64 || '');
    if (dataUrlMatch) {
        contentType = contentType || dataUrlMatch[1];
        base64 = dataUrlMatch[2];
    }

    if (!contentType) {
        contentType = 'image/png';
    }

    const buffer = Buffer.from(base64, 'base64');
    return uploadBufferImage(buffer, contentType, barberId);
}

async function uploadBufferImage(buffer, contentType, barberId) {
    return uploadBufferImageWithFolder(buffer, contentType, 'avatars', barberId);
}

async function uploadBufferImageWithFolder(buffer, contentType, folder = 'uploads', namePrefix = '') {
    const ext = EXTENSION_BY_CONTENT_TYPE[String(contentType || '').toLowerCase()] || 'png';
    const safeFolder = sanitizePathSegment(folder, 'uploads');
    const safePrefix = namePrefix ? `${sanitizePathSegment(namePrefix, 'file')}-` : '';
    const fileName = `${safePrefix}${Date.now()}-${randomUUID()}.${ext}`;
    const storagePath = `${safeFolder}/${fileName}`;
    const resolved = resolveUploadPath(storagePath);

    try {
        await fs.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
        await fs.writeFile(resolved.absolutePath, buffer);
    } catch (error) {
        return { data: null, error };
    }

    return {
        data: {
            path: resolved.relativePath,
            publicUrl: toPublicUrl(resolved.relativePath),
        },
        error: null,
    };
}

module.exports = {
    removeUploadedFile,
    uploadBase64Image,
    uploadBufferImage,
    uploadBufferImageWithFolder,
};
