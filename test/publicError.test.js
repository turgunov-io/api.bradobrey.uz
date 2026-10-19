const test = require('node:test');
const assert = require('node:assert/strict');

const { publicError } = require('../src/utils/publicError');

test('publicError never exposes internal database/provider messages', () => {
  assert.deepEqual(
    publicError({ status: 500, code: '42P01', message: 'relation secrets does not exist' }),
    { status: 500, code: 'INTERNAL_SERVER_ERROR' },
  );
  assert.deepEqual(
    publicError({ status: 400, message: 'Promo code not found' }),
    { status: 400, code: 'PROMO_NOT_FOUND' },
  );
  assert.deepEqual(
    publicError({ status: 403, code: 'BOOKING_RESTRICTED', message: 'internal detail' }),
    { status: 403, code: 'BOOKING_RESTRICTED' },
  );
  assert.deepEqual(
    publicError({ status: 500, code: 'ETIMEDOUT', message: 'connect ETIMEDOUT 10.0.0.1:5432' }),
    { status: 500, code: 'INTERNAL_SERVER_ERROR' },
  );
});
