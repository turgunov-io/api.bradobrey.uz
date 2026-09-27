const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const referralService = fs.readFileSync(
  path.resolve(__dirname, '..', 'src', 'services', 'referralBonus.js'),
  'utf8',
);
const profile = fs.readFileSync(
  path.resolve(__dirname, '..', 'src', 'models', 'marketplace', 'profile.js'),
  'utf8',
);

test('referral settlement uses completed queue entries and money payments', () => {
  assert.match(referralService, /q\.status = 'completed'/);
  assert.match(referralService, /pay\.method in \('payme', 'click', 'cash', 'card'\)/);
  assert.match(referralService, /Math\.floor\(paidMoney \* Number\(row\.bonus_percent \|\| 1\) \/ 100\)/);
  assert.match(referralService, /where r\.expires_at > now\(\)/);
  assert.match(referralService, /on conflict \(referral_id, queue_entry_id\)/);
});

test('referral settlement writes to the shared cashback ledger', () => {
  assert.match(referralService, /source: 'referral_bonus'/);
  assert.match(referralService, /insert into cashback_transactions/);
  assert.match(referralService, /referral_bonus:\$\{referralTransactionId\}/);
  assert.match(referralService, /insert into cashback_wallets/);
});

test('cashback endpoint exposes referral transactions and repairs the shared balance', () => {
  assert.match(profile, /from cashback_transactions t/);
  assert.match(profile, /source = 'referral_bonus'/);
  assert.match(profile, /from cashback_transactions\s+where client_id = \$1/);
  assert.match(profile, /insert into cashback_wallets \(client_id, balance, updated_at\)/);
});
