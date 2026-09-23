const test = require('node:test');
const assert = require('node:assert/strict');

test('marketplace compliance module loads referral and review handlers', () => {
  process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
  const compliance = require('../src/models/marketplace/compliance');
  assert.equal(typeof compliance.referral, 'function');
  assert.equal(typeof compliance.createReview, 'function');
  assert.equal(typeof compliance.cancelBooking, 'function');
});
