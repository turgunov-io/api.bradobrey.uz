const { publicError } = require('../utils/publicError');

/**
 * Legacy marketplace handlers still write error responses directly. Normalize
 * those responses at the module boundary while the handlers are migrated to
 * sendPublicError one by one.
 */
const marketplacePublicErrors = (req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode < 400 || !body || Array.isArray(body) || typeof body !== 'object' || typeof body.error !== 'string') {
      return json(body);
    }

    const result = publicError(
      {
        publicCode: body.code,
        code: body.code,
        message: body.error,
      },
      { status: res.statusCode },
    );
    const sanitized = { ...body, error: result.code, code: result.code };

    if (res.statusCode >= 500) {
      delete sanitized.message;
      delete sanitized.reason;
    }

    return json(sanitized);
  };
  next();
};

module.exports = { marketplacePublicErrors };
