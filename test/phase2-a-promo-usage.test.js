// MULTI_TENANCY Phase 2 (group A, M1): promo_code_usage.order_id has no FK.
// POST /api/promo/use must only accept an order (queue entry) of the caller's
// company, and every reader that maps an order to its promo must ignore usage
// rows / promo codes of another company.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.JWT_SECRET ||= 'phase2-a-promo-secret';

const { installFakeDb } = require('./helpers/phase2aFakeDb');
const promocode = require('../src/models/promocode');
const cashback = require('../src/composable/cashback');
const { enrichQueueEntriesWithBenefits } = require('../src/composable/enrichQueueBenefits');
const { makeRes, staffReq } = require('./helpers/tenantMocks');

const COMPANY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const COMPANY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const ORDER_A = 'a0000000-0000-4000-8000-0000000000a0';
const ORDER_B = 'b0000000-0000-4000-8000-0000000000b0';
const PROMO_A = 'pa000000-0000-4000-8000-0000000000aa';
const PROMO_B = 'pb000000-0000-4000-8000-0000000000bb';

const seed = () => ({
  promo_codes: [
    { id: PROMO_A, company_id: COMPANY_A, code: 'SALE', discount_type: 'percentage', discount_value: 50, status: 'active', is_unlimited: true },
    { id: PROMO_B, company_id: COMPANY_B, code: 'SALE', discount_type: 'percentage', discount_value: 10, status: 'active', is_unlimited: true },
  ],
  queue_entries: [
    { id: ORDER_A, company_id: COMPANY_A },
    { id: ORDER_B, company_id: COMPANY_B },
  ],
  promo_code_usage: [],
});

async function use(companyId, body, data = seed()) {
  const fake = installFakeDb(data);
  const res = makeRes();
  try {
    await promocode.use(staffReq(companyId, { body }), res);
  } finally {
    fake.restore();
  }
  return { res, fake };
}

test('promo use: an order of another company is rejected and nothing is recorded', async () => {
  const { res, fake } = await use(COMPANY_B, { promo_code: 'SALE', order_id: ORDER_A });
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, 'ORDER_NOT_FOUND');
  assert.ok(!fake.writes.length);
});

test('promo use: a malformed order_id is 400, not a DB error', async () => {
  const { res, fake } = await use(COMPANY_B, { promo_code: 'SALE', order_id: 'not-a-uuid' });
  assert.equal(res.statusCode, 400);
  assert.ok(!fake.writes.length);
});

test('promo use: own order is recorded with the company explicitly', async () => {
  const { res, fake } = await use(COMPANY_B, { promo_code: 'SALE', order_id: ORDER_B });
  assert.equal(res.statusCode, 200);
  const insert = fake.writes.find((write) => write.table === 'promo_code_usage');
  assert.equal(insert.payload.order_id, ORDER_B);
  assert.equal(insert.payload.company_id, COMPANY_B);
  assert.equal(insert.payload.promo_code_id, PROMO_B);
});

test('promo use: no order_id stays allowed (kiosk/staff manual use)', async () => {
  const { res } = await use(COMPANY_B, { promo_code: 'SALE' });
  assert.equal(res.statusCode, 200);
});

// A usage row of company A that (wrongly) points at company B's order.
const poisoned = () => ({
  ...seed(),
  promo_code_usage: [{ id: 'u1', company_id: COMPANY_A, promo_code_id: PROMO_A, order_id: ORDER_B, used_at: '2026-11-19T10:00:00Z' }],
});

test('cashback totals: a foreign company usage row does not discount the order', async () => {
  const fake = installFakeDb(poisoned());
  try {
    const totals = await cashback.computeCashbackTotalsForQueueEntry({ id: ORDER_B, company_id: COMPANY_B, price_override: 100 });
    assert.equal(totals.promo, null);
    assert.equal(totals.discountedTotal, 100);
  } finally {
    fake.restore();
  }
});

test('cashback totals: own company usage still applies', async () => {
  const data = seed();
  data.promo_code_usage.push({ id: 'u2', company_id: COMPANY_B, promo_code_id: PROMO_B, order_id: ORDER_B, used_at: '2026-11-19T10:00:00Z' });
  const fake = installFakeDb(data);
  try {
    const totals = await cashback.computeCashbackTotalsForQueueEntry({ id: ORDER_B, company_id: COMPANY_B, price_override: 100 });
    assert.equal(totals.promo?.id, PROMO_B);
    assert.equal(totals.discountedTotal, 90);
  } finally {
    fake.restore();
  }
});

test('enrich benefits: a foreign company promo is not shown on the order', async () => {
  const fake = installFakeDb(poisoned());
  try {
    const [withCompany] = await enrichQueueEntriesWithBenefits([{ id: ORDER_B, company_id: COMPANY_B }]);
    assert.equal(withCompany.used_promo, false);
    // Entries selected without company_id resolve it from queue_entries.
    const [withoutCompany] = await enrichQueueEntriesWithBenefits([{ id: ORDER_B }]);
    assert.equal(withoutCompany.used_promo, false);
  } finally {
    fake.restore();
  }
});

test('enrich benefits: own promo is shown', async () => {
  const data = seed();
  data.promo_code_usage.push({ id: 'u2', company_id: COMPANY_B, promo_code_id: PROMO_B, order_id: ORDER_B, used_at: '2026-11-19T10:00:00Z' });
  const fake = installFakeDb(data);
  try {
    const [entry] = await enrichQueueEntriesWithBenefits([{ id: ORDER_B }]);
    assert.equal(entry.used_promo, true);
    assert.equal(entry.promo_code, 'SALE');
    assert.equal(entry.promo_discount_value, 10);
  } finally {
    fake.restore();
  }
});

test('kiosk idempotent replay: promo usage and promo lookups are company-scoped', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/models/kiosk.js'), 'utf8');
  const usage = source.match(/\.from\('promo_code_usage'\)[\s\S]*?maybeSingle\(\)/g) || [];
  assert.ok(usage.length >= 1);
  for (const chain of usage) assert.match(chain, /\.eq\('company_id', companyId\)|company_id: companyId/);
  const promo = source.match(/\.from\('promo_codes'\)[\s\S]*?maybeSingle\(\)/g) || [];
  assert.ok(promo.length >= 1);
  for (const chain of promo) assert.match(chain, /\.eq\('company_id', companyId\)/);
});
