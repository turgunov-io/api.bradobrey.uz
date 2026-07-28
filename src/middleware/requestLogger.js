// Logs full request and response bodies to the console.
// Bodies are pretty-printed and truncated so base64 images (up to 25mb)
// don't flood the terminal.

const MAX_BODY_CHARS = 2000;

function safeStringify(value) {
  if (value === undefined) return undefined;
  try {
    const str =
      typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (str.length > MAX_BODY_CHARS) {
      return `${str.slice(0, MAX_BODY_CHARS)}... [truncated ${
        str.length - MAX_BODY_CHARS
      } chars]`;
    }
    return str;
  } catch (err) {
    return `[unserializable body: ${err.message}]`;
  }
}

function isEmpty(obj) {
  return !obj || (typeof obj === 'object' && Object.keys(obj).length === 0);
}

module.exports = function requestLogger(req, res, next) {
  const start = Date.now();
  const { method, originalUrl } = req;

  console.log(`\n➡️  ${method} ${originalUrl}`);
  if (!isEmpty(req.query)) {
    console.log('   query :', safeStringify(req.query));
  }
  if (!isEmpty(req.body)) {
    console.log('   body  :', safeStringify(req.body));
  }

  // Capture the response body by wrapping res.json and res.send.
  let responseBody;
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);

  res.json = (body) => {
    responseBody = body;
    return originalJson(body);
  };
  res.send = (body) => {
    if (responseBody === undefined) responseBody = body;
    return originalSend(body);
  };

  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(
      `⬅️  ${method} ${originalUrl} ${res.statusCode} (${ms}ms)`
    );
    if (responseBody !== undefined) {
      console.log('   response:', safeStringify(responseBody));
    }
  });

  next();
};
