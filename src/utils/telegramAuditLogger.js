const SENSITIVE_KEY = /(token|secret|password|otp|authorization|cookie|(^|_)body($|_))/i;

const maskIdentifier = (value) => {
  const normalized = String(value ?? '').trim();
  if (!normalized) return null;
  if (normalized.length <= 4) return '***';
  return `${normalized.slice(0, 2)}***${normalized.slice(-2)}`;
};

const sanitize = (value, key) => {
  if (key && SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitize(entryValue, entryKey),
      ]),
    );
  }
  if (typeof value === 'string' && value.length > 200) {
    return `${value.slice(0, 200)}...`;
  }
  return value;
};

const logTelegramEvent = (logger, event, details = {}, level = 'info') => {
  const target = logger && typeof logger[level] === 'function'
    ? logger[level].bind(logger)
    : console[level].bind(console);
  target(JSON.stringify(sanitize({
    service: 'telegram-auth',
    event,
    ...details,
  })));
};

module.exports = { logTelegramEvent, maskIdentifier };
