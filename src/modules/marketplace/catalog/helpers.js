const { DEFAULT_SERVICE_CATEGORY } = require('./constants');

const normalizeId = (value) => {
  const text = String(value || '').trim();
  return text || null;
};

const normalizeText = (value) => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
};

const normalizeCode = (value) => {
  const text = normalizeText(value);
  return text ? text.toUpperCase() : null;
};

const parseBoolean = (value, fallback = true) => {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(text)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(text)) return false;
  return fallback;
};

const isMissingRelationError = (error, relation) => {
  const message = String(error?.message || error?.details || '').toLowerCase();
  return Boolean(error) && message.includes(String(relation).toLowerCase()) && (
    message.includes('does not exist') ||
    message.includes('could not find') ||
    message.includes('schema cache')
  );
};

const isMissingColumnError = (error, column) => {
  const message = String(error?.message || error?.details || '').toLowerCase();
  return Boolean(error) && message.includes(String(column).toLowerCase()) && (
    message.includes('does not exist') ||
    message.includes('could not find') ||
    message.includes('schema cache')
  );
};

const groupServicesByCategory = (services = []) => {
  const grouped = new Map();

  for (const service of services || []) {
    const category = normalizeText(service?.category) || DEFAULT_SERVICE_CATEGORY;
    if (!grouped.has(category)) grouped.set(category, []);
    grouped.get(category).push(service);
  }

  return Array.from(grouped.entries()).map(([category, items]) => ({
    category,
    services: items,
  }));
};

const isRealMarketplaceBarbershop = (row) => !row?.metadata?.legacy_branch_id && row?.metadata?.fallback !== true;

module.exports = {
  normalizeId,
  normalizeText,
  normalizeCode,
  parseBoolean,
  isMissingRelationError,
  isMissingColumnError,
  groupServicesByCategory,
  isRealMarketplaceBarbershop,
};
