const { db } = require('../config/postgres');
const { ADMIN_ROLES, createAdminAuth, createNetworkWriteAuth } = require('../utils/adminAuth');

// Role and archived status come from the database (MULTI_TENANCY 0.10).
// Any admin role may read the settings; the singleton is network-wide, so
// only network roles may change it (MULTI_TENANCY 0.6).
const KIOSK_ADS_FORBIDDEN = 'Only admins can manage kiosk ads settings';
const requireAdmin = createAdminAuth({ forbiddenMessage: KIOSK_ADS_FORBIDDEN, roles: ADMIN_ROLES });
const requireNetworkAdmin = createNetworkWriteAuth({
  forbiddenMessage: KIOSK_ADS_FORBIDDEN,
  networkMessage: 'Only network administrators can change kiosk ads settings',
});

const ALLOWED_YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

const normalizeYoutubeUrl = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const withScheme = raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch (_err) {
    return null;
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) return null;

  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_YOUTUBE_HOSTS.has(host)) return null;

  return parsed.toString();
};

const parseYoutubeUrlArray = (value, fieldName) => {
  if (value === undefined) return { provided: false };
  if (!Array.isArray(value)) return { error: `${fieldName} must be an array of YouTube URLs` };
  if (value.length > 50) return { error: `${fieldName} must contain at most 50 items` };

  const urls = [];
  for (let i = 0; i < value.length; i += 1) {
    const normalized = normalizeYoutubeUrl(value[i]);
    if (!normalized) return { error: `${fieldName}[${i}] must be a valid YouTube URL` };
    urls.push(normalized);
  }

  return { provided: true, urls };
};

class KioskAds {
  async getSettings(req, res) {
    const auth = await requireAdmin(req, res);
    if (!auth) return;

    const { data, error } = await db
      .from('kiosk_ad_settings')
      .select('id, regular_urls, kids_urls, updated_at')
      .eq('id', 1)
      .maybeSingle();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    if (data) return res.json({ settings: data });

    const { data: created, error: createError } = await db
      .from('kiosk_ad_settings')
      .insert({ id: 1 })
      .select('id, regular_urls, kids_urls, updated_at')
      .maybeSingle();

    if (createError) {
      return res.status(500).json({ error: createError.message });
    }

    return res.json({ settings: created });
  }

  async updateSettings(req, res) {
    const auth = await requireNetworkAdmin(req, res);
    if (!auth) return;

    const body = req.body || {};
    const regularInput = body.regular_urls ?? body.regular;
    const kidsInput = body.kids_urls ?? body.kids;

    const regularParsed = parseYoutubeUrlArray(regularInput, 'regular_urls');
    if (regularParsed.error) return res.status(400).json({ error: regularParsed.error });

    const kidsParsed = parseYoutubeUrlArray(kidsInput, 'kids_urls');
    if (kidsParsed.error) return res.status(400).json({ error: kidsParsed.error });

    if (!regularParsed.provided && !kidsParsed.provided) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    const payload = { id: 1 };
    if (regularParsed.provided) payload.regular_urls = regularParsed.urls;
    if (kidsParsed.provided) payload.kids_urls = kidsParsed.urls;

    const { data: updated, error: updateError } = await db
      .from('kiosk_ad_settings')
      .upsert(payload, { onConflict: 'id' })
      .select('id, regular_urls, kids_urls, updated_at')
      .eq('id', 1)
      .maybeSingle();

    if (updateError) {
      return res.status(500).json({ error: updateError.message });
    }

    return res.json({ settings: updated });
  }
}

module.exports = new KioskAds();

