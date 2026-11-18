// Phase 1 step B2a: marketplace catalog and banners. Marketplace clients have
// no tenant: the company is the one of the branch being browsed/booked.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.PGDATABASE ||= 'company-marketplace-scope-tests';
process.env.PGHOST ||= '127.0.0.1';
process.env.PGUSER ||= 'company-marketplace-scope-tests';
process.env.JWT_SECRET ||= 'company-marketplace-scope-secret';

const { installDbMock, makeRes, eqCalls, staffReq } = require('./helpers/tenantMocks');
const catalog = require('../src/modules/marketplace/catalog/service');
const banner = require('../src/models/marketplace/banner');

const COMPANY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const COMPANY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const BRANCH_B1 = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
const SERVICE_A = '5a5a5a5a-0000-4000-8000-00000000000a';


const branchRows = () => [
  { data: { id: BRANCH_B1, name: 'B1', is_active: true, timezone: 'Asia/Tashkent' }, error: null },
  { data: { id: BRANCH_B1, company_id: COMPANY_B }, error: null },
];

test('catalog branch services: only the branch company services (own branch + shared)', async () => {
  const mock = installDbMock({ branches: branchRows(), services: [{ data: [], error: null }] });
  try {
    await catalog.listBranchServices(BRANCH_B1);
    assert.deepEqual(eqCalls(mock.calls, 'services', 'company_id'), [COMPANY_B]);
    const or = mock.calls.find((c) => c.table === 'services' && c.method === 'or');
    assert.equal(or.args[0], `branch_id.eq.${BRANCH_B1},branch_id.is.null`);
  } finally { mock.restore(); }
});

test('catalog quote: a company A service is invalid at a company B branch; promo looked up in B', async () => {
  const mock = installDbMock({
    branches: branchRows(),
    barbers: [{ data: { id: 'barber-1', branch_id: BRANCH_B1, is_active: true }, error: null }],
    users: [{ data: { id: 'barber-1', role: 'barber' }, error: null }],
    services: [{ data: [], error: null }],
  });
  try {
    await assert.rejects(
      catalog.quoteBooking({ branch_id: BRANCH_B1, barber_id: 'barber-1', service_ids: [SERVICE_A] }),
      (error) => error.statusCode === 400,
    );
    assert.deepEqual(eqCalls(mock.calls, 'services', 'company_id'), [COMPANY_B]);
  } finally { mock.restore(); }

  const mock2 = installDbMock({
    branches: branchRows(),
    barbers: [{ data: { id: 'barber-1', branch_id: BRANCH_B1, is_active: true }, error: null }],
    users: [{ data: { id: 'barber-1', role: 'barber' }, error: null }],
    services: [{ data: [{ id: 's-b', base_price: 100, is_active: true, branch_id: null }], error: null }],
    promo_codes: [{ data: null, error: null }],
  });
  try {
    await assert.rejects(
      catalog.quoteBooking({ branch_id: BRANCH_B1, barber_id: 'barber-1', service_ids: ['s-b'], promo_code: 'akode' }),
      (error) => error.statusCode === 404,
    );
    assert.deepEqual(eqCalls(mock2.calls, 'promo_codes', 'company_id'), [COMPANY_B]);
  } finally { mock2.restore(); }
});

test('banners: public list resolves company from ?branch_id; unknown company -> empty', async () => {
  let mock = installDbMock({
    branches: [{ data: { id: BRANCH_B1, company_id: COMPANY_B }, error: null }],
    banners: [{ data: [], error: null }],
  });
  try {
    const res = makeRes();
    await banner.all({ headers: {}, query: { branch_id: BRANCH_B1 } }, res);
    assert.deepEqual(eqCalls(mock.calls, 'banners', 'company_id'), [COMPANY_B]);
  } finally { mock.restore(); }

  mock = installDbMock({
    companies: [{ data: [{ id: COMPANY_A, is_default: true, status: 'active' }, { id: COMPANY_B, is_default: false, status: 'active' }], error: null }],
    banners: [{ data: [{ id: 'x' }], error: null }],
  });
  try {
    const res = makeRes();
    await banner.all({ headers: {}, query: {} }, res);
    assert.deepEqual(res.body.data, []);
    assert.equal(mock.calls.some((c) => c.table === 'banners'), false);
  } finally { mock.restore(); }
});

test('banners: staff of company B cannot update/deactivate company A banner', async () => {
  for (const action of ['update', 'deactivate']) {
    const mock = installDbMock({ banners: [{ data: null, error: null }] });
    try {
      const res = makeRes();
      await banner[action](staffReq(COMPANY_B, { params: { id: 'banner-of-a' }, body: {} }), res);
      assert.equal(res.statusCode, 404, action);
      assert.deepEqual(eqCalls(mock.calls, 'banners', 'company_id'), [COMPANY_B], action);
    } finally { mock.restore(); }
  }
});

// ---------------------------------------------------------------- branches

const branches = require('../src/models/branches');

test('branches: list/read/write are limited to the tenant company', async () => {
  let mock = installDbMock({ branches: [{ data: [], error: null, count: 0 }] });
  try {
    const res = makeRes();
    await branches.list(staffReq(COMPANY_B), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(eqCalls(mock.calls, 'branches', 'company_id'), [COMPANY_B]);
  } finally { mock.restore(); }

  for (const action of ['getById', 'update', 'remove']) {
    mock = installDbMock({ branches: [{ data: null, error: null }] });
    try {
      const res = makeRes();
      await branches[action](staffReq(COMPANY_B, { params: { id: 'branch-of-a' }, body: { name: 'X' } }), res);
      assert.equal(res.statusCode, 404, action);
      assert.deepEqual(eqCalls(mock.calls, 'branches', 'company_id'), [COMPANY_B], action);
    } finally { mock.restore(); }
  }
});

test('branches: create stamps the tenant company; foreign barbershop refused', async () => {
  let mock = installDbMock({ branches: [{ data: { id: 'new-b' }, error: null }] });
  try {
    const res = makeRes();
    await branches.create(staffReq(COMPANY_B, { body: { name: 'New', company_id: COMPANY_A } }), res);
    assert.equal(res.statusCode, 201);
    const insert = mock.calls.find((c) => c.table === 'branches' && c.method === 'insert');
    assert.equal(insert.args[0].company_id, COMPANY_B);
  } finally { mock.restore(); }

  mock = installDbMock({ marketplace_barbershops: [{ data: { id: 'shop-a', company_id: COMPANY_A }, error: null }] });
  try {
    const res = makeRes();
    await branches.create(staffReq(COMPANY_B, { body: { name: 'New', marketplace_barbershop_id: 'shop-a' } }), res);
    assert.equal(res.statusCode, 403);
  } finally { mock.restore(); }
});
