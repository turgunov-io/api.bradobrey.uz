// Phase 1 step B2a: promo codes and certificates are unique per company and
// every staff lookup/list/write is limited to the tenant company.
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.PGDATABASE ||= 'company-codes-scope-tests';
process.env.PGHOST ||= '127.0.0.1';
process.env.PGUSER ||= 'company-codes-scope-tests';
process.env.JWT_SECRET ||= 'company-codes-scope-secret';

const { installDbMock, makeRes, eqCalls, staffReq } = require('./helpers/tenantMocks');
const promo = require('../src/models/promocode');
const certificate = require('../src/models/certificate');

const COMPANY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const COMPANY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const ADMIN_B = '10000000-0000-4000-8000-00000000000b';
const SHOP_A = 'cccccccc-0000-4000-8000-00000000000a';

test('promo validate/use: company B cannot use company A code', async () => {
  for (const [action, body] of [['validate', { code: 'akode' }], ['use', { promo_code: 'akode' }]]) {
    const mock = installDbMock({ promo_codes: [{ data: null, error: null }] });
    try {
      const res = makeRes();
      await promo[action](staffReq(COMPANY_B, { body }), res);
      assert.equal(res.statusCode, 404, action);
      assert.deepEqual(eqCalls(mock.calls, 'promo_codes', 'company_id'), [COMPANY_B]);
      assert.equal(mock.calls.some((c) => c.table === 'promo_code_usage'), false);
    } finally { mock.restore(); }
  }
});

test('promo list is limited to the tenant company; no tenant -> 403', async () => {
  const mock = installDbMock({ promo_codes: [{ data: [], error: null }] });
  try {
    const res = makeRes();
    await promo.list(staffReq(COMPANY_B), res);
    assert.deepEqual(eqCalls(mock.calls, 'promo_codes', 'company_id'), [COMPANY_B]);
    const anonymous = makeRes();
    await promo.list({ headers: {}, query: {} }, anonymous);
    assert.equal(anonymous.statusCode, 403);
  } finally { mock.restore(); }
});

test('promo create stamps the tenant company and refuses another company barbershop', async () => {
  const body = { code: 'new', discount_type: 'fixed', discount_value: 10, is_unlimited: true, company_id: COMPANY_A };
  let mock = installDbMock({ promo_codes: [{ data: { id: 'p1', code: 'NEW' }, error: null }] });
  try {
    const res = makeRes();
    await promo.create(staffReq(COMPANY_B, { body }), res);
    assert.equal(res.statusCode, 201);
    const insert = mock.calls.find((c) => c.table === 'promo_codes' && c.method === 'insert');
    assert.equal(insert.args[0].company_id, COMPANY_B);
  } finally { mock.restore(); }

  mock = installDbMock({ marketplace_barbershops: [{ data: { id: SHOP_A, company_id: COMPANY_A }, error: null }] });
  try {
    const res = makeRes();
    await promo.create(staffReq(COMPANY_B, { body: { ...body, marketplace_barbershop_id: SHOP_A } }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(mock.calls.some((c) => c.table === 'promo_codes' && c.method === 'insert'), false);
  } finally { mock.restore(); }
});

test('promo stats/update/remove: company B cannot reach company A promo by id', async () => {
  for (const action of ['stats', 'update', 'remove']) {
    const mock = installDbMock({ promo_codes: [{ data: null, error: null }] });
    try {
      const res = makeRes();
      await promo[action](staffReq(COMPANY_B, { params: { id: 'promo-of-a' }, body: { code: 'x', discount_type: 'fixed', discount_value: 1, is_unlimited: true } }), res);
      assert.equal(res.statusCode, 404, action);
      assert.deepEqual(eqCalls(mock.calls, 'promo_codes', 'company_id'), [COMPANY_B], action);
    } finally { mock.restore(); }
  }
});

// ------------------------------------------------------------ certificates

const certReq = (extra = {}) => ({
  headers: { authorization: `Bearer ${jwt.sign({ sub: ADMIN_B, role: 'admin' }, process.env.JWT_SECRET)}` },
  params: {},
  query: {},
  body: {},
  ...extra,
});
const userB = { data: { id: ADMIN_B, role: 'admin', company_id: COMPANY_B }, error: null };

test('certificates: list, read, update and delete are limited to the caller company', async () => {
  let mock = installDbMock({ users: [userB], certificates: [{ data: [], error: null }] });
  try {
    const res = makeRes();
    await certificate.active(certReq(), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(eqCalls(mock.calls, 'certificates', 'company_id'), [COMPANY_B]);
  } finally { mock.restore(); }

  for (const action of ['getById', 'update', 'remove']) {
    mock = installDbMock({ users: [userB], certificates: [{ data: null, error: null }], queue_entries: [{ data: null, error: null }] });
    try {
      const res = makeRes();
      await certificate[action](certReq({ params: { id: 'cert-of-a' }, body: { metadata: {} } }), res);
      assert.equal(res.statusCode, 404, action);
      assert.deepEqual(eqCalls(mock.calls, 'certificates', 'company_id'), [COMPANY_B], action);
    } finally { mock.restore(); }
  }
});

test('certificates: same code may exist in another company; create stamps the caller company', async () => {
  const mock = installDbMock({
    users: [userB],
    certificates: [{ data: null, error: null }, { data: { id: 'c-new', code: 'GIFT1' }, error: null }],
  });
  try {
    const res = makeRes();
    await certificate.create(certReq({ body: { code: 'gift1', service_ids: ['s1'], company_id: COMPANY_A } }), res);
    assert.equal(res.statusCode, 201);
    assert.deepEqual(eqCalls(mock.calls, 'certificates', 'company_id'), [COMPANY_B]);
    const insert = mock.calls.find((c) => c.table === 'certificates' && c.method === 'insert');
    assert.equal(insert.args[0].company_id, COMPANY_B);
  } finally { mock.restore(); }
});

test('certificates: a token company that differs from the DB company is refused', async () => {
  const mock = installDbMock({ users: [userB] });
  try {
    const res = makeRes();
    await certificate.active(certReq({ tenant: { companyId: COMPANY_A } }), res);
    assert.equal(res.statusCode, 403);
  } finally { mock.restore(); }
});
