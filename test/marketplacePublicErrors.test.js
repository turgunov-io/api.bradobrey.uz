const test = require('node:test');
const assert = require('node:assert/strict');

const { marketplacePublicErrors } = require('../src/middleware/marketplacePublicErrors');

const runMiddleware = (statusCode, body) => {
  let response;
  const res = {
    statusCode,
    json(value) {
      response = value;
      return value;
    },
  };
  marketplacePublicErrors({}, res, () => {});
  res.json(body);
  return response;
};

test('marketplace boundary hides technical 5xx messages from legacy handlers', () => {
  assert.deepEqual(
    runMiddleware(500, { error: 'relation private_table does not exist' }),
    { error: 'INTERNAL_SERVER_ERROR', code: 'INTERNAL_SERVER_ERROR' },
  );
});

test('marketplace boundary preserves stable business codes and response fields', () => {
  assert.deepEqual(
    runMiddleware(403, {
      error: 'BOOKING_RESTRICTED',
      code: 'BOOKING_RESTRICTED',
      blocked_until: '2026-10-20T12:00:00.000Z',
    }),
    {
      error: 'BOOKING_RESTRICTED',
      code: 'BOOKING_RESTRICTED',
      blocked_until: '2026-10-20T12:00:00.000Z',
    },
  );
});
