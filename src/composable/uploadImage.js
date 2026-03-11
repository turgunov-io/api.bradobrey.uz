const { supabase } = require("../config/supabase");
const { randomUUID } = require("crypto");

async function uploadBase64ToSupabase(imageBase64, contentTypeInput, barberId) {
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
    return uploadBufferToSupabase(buffer, contentType, barberId);
}

async function uploadBufferToSupabase(buffer, contentType, barberId) {
    return uploadBufferToSupabaseWithFolder(buffer, contentType, 'avatars', barberId);
}

async function uploadBufferToSupabaseWithFolder(buffer, contentType, folder = 'uploads', namePrefix = '') {
    const ext = (contentType && contentType.split('/')[1]) || 'png';
    const safePrefix = namePrefix ? `${namePrefix}-` : '';
    const fileName = `${safePrefix}${Date.now()}-${randomUUID()}.${ext}`;
    const path = `${folder}/${fileName}`;

    const { data, error } = await supabase.storage.from('images').upload(path, buffer, {
        contentType: contentType || 'image/png',
        upsert: false,
    });

    if (error) {
        return { error };
    }

    const { data: publicUrlData } = supabase.storage.from('images').getPublicUrl(path);

    return { data: { path, publicUrl: publicUrlData?.publicUrl || null } };
}

module.exports = { uploadBase64ToSupabase, uploadBufferToSupabase, uploadBufferToSupabaseWithFolder };
