const fs = require('fs/promises');
const path = require('path');

const uploadRoot = path.resolve(
  process.env.UPLOAD_DIR || path.join(process.cwd(), 'public', 'uploads')
);

const publicUploadPath = '/uploads';

const firstHeaderValue = (value) => String(value || '').split(',')[0].trim();

const normalizePublicBaseUrl = (req = null) => {
  const value =
    process.env.PUBLIC_BASE_URL ||
    process.env.API_PUBLIC_URL ||
    process.env.APP_PUBLIC_URL ||
    '';

  const envBaseUrl = String(value).replace(/\/+$/, '');
  if (envBaseUrl) return envBaseUrl;

  const host =
    firstHeaderValue(req?.headers?.['x-forwarded-host']) ||
    (typeof req?.get === 'function' ? req.get('host') : null) ||
    req?.headers?.host ||
    '';

  if (!host) return '';

  const protocol =
    firstHeaderValue(req?.headers?.['x-forwarded-proto']) ||
    req?.protocol ||
    (req?.secure ? 'https' : 'http');

  return `${protocol}://${host}`.replace(/\/+$/, '');
};

const toPublicUrl = (relativePath, req = null) => {
  const normalizedRelativePath = String(relativePath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  const normalizedPath = normalizedRelativePath.startsWith(`${publicUploadPath.slice(1)}/`)
    ? `/${normalizedRelativePath}`
    : `${publicUploadPath}/${normalizedRelativePath}`;
  const baseUrl = normalizePublicBaseUrl(req);

  return baseUrl ? `${baseUrl}${normalizedPath}` : normalizedPath;
};

const toAbsolutePublicUrl = (input, req = null) => {
  const raw = String(input || '').trim();
  if (!raw) return null;

  const baseUrl = normalizePublicBaseUrl(req);

  try {
    const parsed = new URL(raw);
    if (parsed.pathname === publicUploadPath || parsed.pathname.startsWith(`${publicUploadPath}/`)) {
      const pathWithSuffix = `${parsed.pathname}${parsed.search}${parsed.hash}`;
      return baseUrl ? `${baseUrl}${pathWithSuffix}` : raw;
    }
    return raw;
  } catch (_error) {
    // Not an absolute URL.
  }

  return toPublicUrl(raw, req);
};

const normalizeStoragePath = (input) => {
  const raw = String(input || '').trim();
  if (!raw) return null;

  const legacyHostedStorageMatch = raw.match(/\/storage\/v1\/object\/public\/images\/(.+)$/);
  if (legacyHostedStorageMatch) return legacyHostedStorageMatch[1];

  try {
    const parsed = new URL(raw);
    if (parsed.pathname.startsWith(`${publicUploadPath}/`)) {
      return decodeURIComponent(parsed.pathname.slice(publicUploadPath.length + 1));
    }
  } catch (_error) {
    // Not an absolute URL.
  }

  if (raw.startsWith(`${publicUploadPath}/`)) {
    return raw.slice(publicUploadPath.length + 1);
  }

  return raw.replace(/^\/+/, '');
};

const resolveUploadPath = (storagePath) => {
  const normalized = normalizeStoragePath(storagePath);
  if (!normalized) return null;

  const absolutePath = path.resolve(uploadRoot, normalized);
  const rootWithSeparator = `${uploadRoot}${path.sep}`;

  if (absolutePath !== uploadRoot && !absolutePath.startsWith(rootWithSeparator)) {
    throw new Error('Invalid upload path');
  }

  return { absolutePath, relativePath: normalized.replace(/\\/g, '/') };
};

const removeUploadedFile = async (storagePath) => {
  const resolved = resolveUploadPath(storagePath);
  if (!resolved) return { data: [], error: null };

  try {
    await fs.unlink(resolved.absolutePath);
    return { data: [{ name: resolved.relativePath }], error: null };
  } catch (error) {
    if (error.code === 'ENOENT') return { data: [], error: null };
    return { data: null, error };
  }
};

module.exports = {
  normalizeStoragePath,
  publicUploadPath,
  removeUploadedFile,
  resolveUploadPath,
  toAbsolutePublicUrl,
  toPublicUrl,
  uploadRoot,
};
