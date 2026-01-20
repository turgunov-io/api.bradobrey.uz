const initialsFromName = (name = '') => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  if (parts.length === 1) return `${parts[0][0] || ''}.`;
  return `${parts[0][0] || ''}.${parts[1][0] || ''}.`;
};

module.exports = { initialsFromName };
