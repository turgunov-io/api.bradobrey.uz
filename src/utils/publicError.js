const STATUS_CODES = new Map([
  [400, 'BAD_REQUEST'],
  [401, 'UNAUTHORIZED'],
  [403, 'FORBIDDEN'],
  [404, 'NOT_FOUND'],
  [409, 'CONFLICT'],
  [429, 'RATE_LIMITED'],
]);

const MESSAGE_CODES = [
  [/promo code not found/i, 'PROMO_NOT_FOUND'],
  [/promo code inactive/i, 'PROMO_INACTIVE'],
  [/promo code expired|limit reached/i, 'PROMO_EXPIRED'],
  [/certificate.*required/i, 'CERTIFICATE_REQUIRED'],
  [/certificate not found/i, 'CERTIFICATE_NOT_FOUND'],
  [/certificate.*already used/i, 'CERTIFICATE_ALREADY_USED'],
  [/certificate.*expired/i, 'CERTIFICATE_EXPIRED'],
  [/certificate.*not available/i, 'CERTIFICATE_UNAVAILABLE'],
  [/services.*not covered.*certificate/i, 'CERTIFICATE_SERVICES_UNAVAILABLE'],
  [/branch not found/i, 'BRANCH_NOT_FOUND'],
  [/barbershop not found/i, 'BARBERSHOP_NOT_FOUND'],
  [/invalid or expired otp/i, 'INVALID_OR_EXPIRED_OTP'],
  [/invalid credentials/i, 'INVALID_CREDENTIALS'],
  [/account is disabled/i, 'ACCOUNT_BLOCKED'],
  [/phone.*required/i, 'PHONE_REQUIRED'],
  [/^id is required$/i, 'ID_REQUIRED'],
  [/^barber_id is required$/i, 'BARBER_ID_REQUIRED'],
];

const isPublicCode = (value) => /^[A-Z][A-Z0-9_]{1,63}$/.test(String(value || ''));
const isTechnicalCode = (value) => /^(?:E(?:ACCES|ADDRINUSE|ADDRNOTAVAIL|CONNRESET|CONNREFUSED|HOSTUNREACH|NETUNREACH|PIPE|TIMEDOUT|AI_AGAIN|NOTFOUND)|ECONN|ENET|ETIMEDOUT|SQLSTATE)$/.test(value);

const codeFromError = (error, fallback) => {
  const explicit = String(error?.publicCode || '').trim().toUpperCase();
  if (isPublicCode(explicit)) return explicit;

  const rawCode = String(error?.code || '').trim().toUpperCase();
  if (isPublicCode(rawCode) && !isTechnicalCode(rawCode)) return rawCode;

  const message = String(error?.message || '').trim();
  const messageCode = MESSAGE_CODES.find(([pattern]) => pattern.test(message));
  if (messageCode) return messageCode[1];

  return fallback;
};

const publicError = (error, { status, fallback = 'INTERNAL_SERVER_ERROR' } = {}) => {
  const resolvedStatus = Number.isInteger(status)
    ? status
    : Number.isInteger(error?.statusCode)
      ? error.statusCode
      : Number.isInteger(error?.status)
        ? error.status
        : 500;
  const fallbackCode = resolvedStatus >= 500
    ? fallback
    : STATUS_CODES.get(resolvedStatus) || 'REQUEST_FAILED';
  return {
    status: resolvedStatus,
    code: codeFromError(error, fallbackCode),
  };
};

const sendPublicError = (res, error, options = {}) => {
  const result = publicError(error, options);
  return res.status(result.status).json({ error: result.code, code: result.code });
};

module.exports = { codeFromError, publicError, sendPublicError };
