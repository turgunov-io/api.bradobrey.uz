// Phase 1 step B2a: kiosk routes are company-scoped (services, prices,
// clients, promo codes, certificates, config).
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.PGDATABASE ||= 'company-kiosk-scope-tests';
process.env.PGHOST ||= '127.0.0.1';
process.env.PGUSER ||= 'company-kiosk-scope-tests';
process.env.JWT_SECRET ||= 'company-kiosk-scope-secret';

const { installDbMock, makeRes, eqCalls } = require('./helpers/tenantMocks');
const kiosk = require('../src/models/kiosk');

const COMPANY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const COMPANY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const BRANCH_A1 = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const BRANCH_B1 = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
const SERVICE_A = '5a5a5a5a-0000-4000-8000-00000000000a';

const KIOSK_B = { id: 'k-b', branchId: BRANCH_B1, companyId: COMPANY_B };
const TWO_COMPANIES = { data: [
  { id: COMPANY_A, is_default: true, status: 'active' },
  { id: COMPANY_B, is_default: false, status: 'active' },
], error: null };


test('kiosk /services: a company B kiosk only gets company B services', async () => {
  const mock = installDbMock({ services: [{ data: [], error: null }] });
  try {
    const res = makeRes();
    await kiosk.services({ query: {}, headers: {}, kiosk: KIOSK_B, tenant: { companyId: COMPANY_B } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(eqCalls(mock.calls, 'services', 'company_id'), [COMPANY_B]);
  } finally { mock.restore(); }
});

test('kiosk /services: legacy ?branch_id derives the company from the branch, never from input', async () => {
  const mock = installDbMock({
    branches: [{ data: { id: BRANCH_A1, company_id: COMPANY_A }, error: null }],
    services: [{ data: [], error: null }],
  });
  try {
    const res = makeRes();
    await kiosk.services({ query: { branch_id: BRANCH_A1, company_id: COMPANY_B }, headers: {} }, res);
    assert.deepEqual(eqCalls(mock.calls, 'services', 'company_id'), [COMPANY_A]);
  } finally { mock.restore(); }
});

test('kiosk /services: no token, no branch, two companies -> empty list, no query', async () => {
  const mock = installDbMock({ companies: [TWO_COMPANIES], services: [{ data: [{ id: SERVICE_A }], error: null }] });
  try {
    const res = makeRes();
    await kiosk.services({ query: {}, headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.services, []);
    assert.equal(mock.calls.some((c) => c.table === 'services'), false);
  } finally { mock.restore(); }
});

test('kiosk /config: kiosk token -> only its company branches and ads', async () => {
  const mock = installDbMock({
    branches: [{ data: [{ id: BRANCH_B1, name: 'B1' }], error: null }],
    kiosk_ad_settings: [{ data: { regular_urls: ['b.mp4'], kids_urls: [] }, error: null }],
  });
  try {
    const res = makeRes();
    await kiosk.config({ headers: {}, query: {}, kiosk: KIOSK_B, tenant: { companyId: COMPANY_B } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(eqCalls(mock.calls, 'branches', 'company_id'), [COMPANY_B]);
    assert.deepEqual(eqCalls(mock.calls, 'kiosk_ad_settings', 'company_id'), [COMPANY_B]);
    assert.deepEqual(eqCalls(mock.calls, 'kiosk_ad_settings', 'id'), []);
    assert.deepEqual(res.body.ads.regular, ['b.mp4']);
  } finally { mock.restore(); }
});

test('kiosk /config: no token with two companies returns no branch list', async () => {
  const mock = installDbMock({ companies: [TWO_COMPANIES], branches: [{ data: [{ id: BRANCH_A1 }, { id: BRANCH_B1 }], error: null }] });
  try {
    const res = makeRes();
    await kiosk.config({ headers: {}, query: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.entry, []);
    assert.equal(mock.calls.some((c) => c.table === 'branches'), false);
  } finally { mock.restore(); }
});

test('kiosk /config: no token, single company keeps the legacy list of that company', async () => {
  const mock = installDbMock({
    companies: [{ data: [{ id: COMPANY_A, is_default: true, status: 'active' }], error: null }],
    branches: [{ data: [{ id: BRANCH_A1 }], error: null }],
  });
  try {
    const res = makeRes();
    await kiosk.config({ headers: {}, query: {} }, res);
    assert.deepEqual(res.body.entry, [{ id: BRANCH_A1 }]);
    assert.deepEqual(eqCalls(mock.calls, 'branches', 'company_id'), [COMPANY_A]);
  } finally { mock.restore(); }
});

const bookingMocks = ({ services = [], client = null, promo } = {}) => ({
  branches: [{ data: { id: BRANCH_B1, company_id: COMPANY_B, timezone: 'Asia/Tashkent', marketplace_barbershop_id: null }, error: null }],
  barbers: [{ data: { id: 'barber-1', branch_id: BRANCH_B1, is_on_shift: true, is_archived: false }, error: null }],
  users: [{ data: { id: 'barber-1', role: 'barber' }, error: null }],
  services: [{ data: services, error: null }],
  promo_codes: promo === undefined ? [] : [{ data: promo, error: null }],
  clients: [{ data: client, error: null }, { data: { id: 'new-client' }, error: null }],
  queue_entries: [{ data: null, error: { message: 'stop here' } }],
});

const bookBody = (extra = {}) => ({
  branch_id: BRANCH_B1,
  barber_id: 'barber-1',
  service_ids: [SERVICE_A],
  customer_name: 'Ali',
  phone_number: '+998991234567',
  ...extra,
});

const bookReq = (extra = {}) => ({ headers: {}, app: { get: () => null }, ...extra });

test('kiosk /book: a company A service id cannot be booked at a company B branch', async () => {
  // The company-filtered query returns nothing for the other company service.
  const mock = installDbMock(bookingMocks({ services: [] }));
  try {
    const res = makeRes();
    await kiosk.book(bookReq({ body: bookBody(), kiosk: KIOSK_B, tenant: { companyId: COMPANY_B } }), res);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(eqCalls(mock.calls, 'services', 'company_id'), [COMPANY_B]);
  } finally { mock.restore(); }
});

test('kiosk /book: client is looked up and created per (company, phone)', async () => {
  const mock = installDbMock(bookingMocks({ services: [{ id: SERVICE_A, is_active: true, base_price: 100, branch_id: null }] }));
  try {
    const res = makeRes();
    await kiosk.book(bookReq({ body: bookBody(), kiosk: KIOSK_B, tenant: { companyId: COMPANY_B } }), res);
    assert.deepEqual(eqCalls(mock.calls, 'clients', 'company_id'), [COMPANY_B]);
    assert.deepEqual(eqCalls(mock.calls, 'clients', 'phone'), ['+998991234567']);
    const insert = mock.calls.find((c) => c.table === 'clients' && c.method === 'insert');
    assert.equal(insert.args[0].company_id, COMPANY_B);
  } finally { mock.restore(); }
});

test('kiosk /book: promo codes are looked up within the branch company', async () => {
  const mock = installDbMock(bookingMocks({
    services: [{ id: SERVICE_A, is_active: true, base_price: 100, branch_id: null }],
    promo: null,
  }));
  try {
    const res = makeRes();
    await kiosk.book(bookReq({ body: bookBody({ promo_code: 'akode' }), kiosk: KIOSK_B, tenant: { companyId: COMPANY_B } }), res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(eqCalls(mock.calls, 'promo_codes', 'company_id'), [COMPANY_B]);
  } finally { mock.restore(); }
});

test('kiosk /book: staff of company A cannot book into a company B branch', async () => {
  const mock = installDbMock(bookingMocks({ services: [{ id: SERVICE_A, is_active: true, base_price: 100, branch_id: null }] }));
  try {
    const res = makeRes();
    await kiosk.book(bookReq({ body: bookBody(), tenant: { companyId: COMPANY_A } }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(mock.calls.some((c) => c.table === 'services'), false);
  } finally { mock.restore(); }
});

test('kiosk /certificate: lookup by (company, code)', async () => {
  const mock = installDbMock({ certificates: [{ data: null, error: null }] });
  try {
    const res = makeRes();
    await kiosk.certificate({ params: { id: 'abc' }, query: {}, headers: {}, kiosk: KIOSK_B, tenant: { companyId: COMPANY_B } }, res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(eqCalls(mock.calls, 'certificates', 'company_id'), [COMPANY_B]);
  } finally { mock.restore(); }
});
