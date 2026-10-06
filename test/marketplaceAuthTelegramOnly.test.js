const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('dotenv').config();

const MarketplaceAuth = require('../src/models/marketplace/auth');

const makeResponse = () => ({
  statusCode: null,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

test('legacy phone request cannot use a fallback OTP and requires Telegram', async () => {
  const response = makeResponse();

  await MarketplaceAuth.requestPhoneOtp({}, response);

  assert.equal(response.statusCode, 410);
  assert.equal(response.body.code, 'TELEGRAM_AUTH_REQUIRED');
});

test('legacy phone verification cannot accept a fallback OTP', async () => {
  const response = makeResponse();

  await MarketplaceAuth.verifyPhone({}, response);

  assert.equal(response.statusCode, 410);
  assert.equal(response.body.code, 'TELEGRAM_AUTH_REQUIRED');
});

test('marketplace auth source contains no universal 0000 fallback', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/models/marketplace/auth.js'),
    'utf8',
  );

  assert.doesNotMatch(source, /return\s+['"]0000['"]/);
  assert.doesNotMatch(source, /MARKETPLACE_FIXED_OTP/);
});
