// MULTI_TENANCY Phase 2 (group A, H1): the marketplace-admin barbershops
// router is company-scoped. Two companies share one database; company B's
// network admin must never read or change company A's barbershop, branches
// or merchant accounts.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.JWT_SECRET ||= 'phase2-a-barbershops-secret';

const { installFakeDb } = require('./helpers/phase2aFakeDb');
const barbershops = require('../src/models/marketplace/barbershops');
const { makeRes, staffReq } = require('./helpers/tenantMocks');

const COMPANY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const COMPANY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const SHOP_A = 'a5a5a5a5-0000-4000-8000-0000000000a5';
const SHOP_B = 'b5b5b5b5-0000-4000-8000-0000000000b5';
const BRANCH_A1 = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const BRANCH_B1 = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
const MERCHANT_A = 'ma000000-0000-4000-8000-0000000000aa';

const seed = () => ({
  marketplace_barbershops: [
    { id: SHOP_A, name: 'Bradobrey', company_id: COMPANY_A, metadata: {}, is_active: true },
    { id: SHOP_B, name: 'President', company_id: COMPANY_B, metadata: {}, is_active: true },
  ],
  branches: [
    { id: BRANCH_A1, company_id: COMPANY_A, marketplace_barbershop_id: SHOP_A },
    { id: BRANCH_B1, company_id: COMPANY_B, marketplace_barbershop_id: SHOP_B },
  ],
  users: [
    { id: MERCHANT_A, login: 'merchant-a', role: 'merchant', company_id: COMPANY_A, marketplace_barbershop_id: SHOP_A },
  ],
});

async function call(method, req, fake) {
  const res = makeRes();
  try {
    await barbershops[method](req, res);
  } finally {
    if (fake) fake.restore();
  }
  return res;
}

const touchedA = (fake) => fake.writes.some((write) => (write.ids || []).some((id) => [SHOP_A, BRANCH_A1, MERCHANT_A].includes(id)));

test('barbershops: no tenant company -> 403 COMPANY_REQUIRED, nothing queried', async () => {
  const fake = installFakeDb(seed());
  const res = await call('list', { query: {}, params: {}, body: {} }, fake);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'COMPANY_REQUIRED');
});

test('barbershops: list and getById return only the caller company barbershop', async () => {
  let fake = installFakeDb(seed());
  const list = await call('list', staffReq(COMPANY_B), fake);
  assert.deepEqual(list.body.data.map((row) => row.id), [SHOP_B]);

  fake = installFakeDb(seed());
  const foreign = await call('getById', staffReq(COMPANY_B, { params: { id: SHOP_A } }), fake);
  assert.equal(foreign.statusCode, 404);

  fake = installFakeDb(seed());
  const own = await call('getById', staffReq(COMPANY_B, { params: { id: SHOP_B } }), fake);
  assert.equal(own.statusCode, 200);
  assert.equal(own.body.entry.id, SHOP_B);
});

test('barbershops: create is 409 when the company already has its barbershop (1:1)', async () => {
  const fake = installFakeDb(seed());
  const res = await call('create', staffReq(COMPANY_B, { body: { name: 'Second' } }), fake);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'COMPANY_BARBERSHOP_EXISTS');
  assert.ok(!fake.writes.some((write) => write.op === 'insert'));
});

test('barbershops: create sets company_id and links only own branches', async () => {
  const COMPANY_C = 'cccccccc-0000-4000-8000-00000000000c';
  const BRANCH_C1 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
  const data = seed();
  data.branches.push({ id: BRANCH_C1, company_id: COMPANY_C, marketplace_barbershop_id: null });

  let fake = installFakeDb(data);
  const foreign = await call('create', staffReq(COMPANY_C, { body: { name: 'New', branch_ids: [BRANCH_A1] } }), fake);
  assert.equal(foreign.statusCode, 400);
  assert.ok(!fake.writes.length, 'nothing written for a foreign branch');

  fake = installFakeDb(data);
  const tables = fake.tables;
  const created = await call('create', staffReq(COMPANY_C, { body: { name: 'New', branch_ids: [BRANCH_C1] } }), fake);
  assert.equal(created.statusCode, 201);
  const insert = fake.writes.find((write) => write.op === 'insert');
  assert.equal(insert.payload.company_id, COMPANY_C);
  assert.equal(tables().branches.find((row) => row.id === BRANCH_C1).marketplace_barbershop_id, created.body.entry.id);
  assert.equal(tables().branches.find((row) => row.id === BRANCH_A1).marketplace_barbershop_id, SHOP_A);
});

test('barbershops: update/activate/deactivate/remove of a foreign barbershop -> 404, nothing touched', async () => {
  for (const [method, body] of [
    ['update', { name: 'Hijack', branch_ids: [] }],
    ['activate', {}],
    ['deactivate', {}],
    ['remove', {}],
  ]) {
    const fake = installFakeDb(seed());
    const res = await call(method, staffReq(COMPANY_B, { params: { id: SHOP_A }, body }), fake);
    assert.equal(res.statusCode, 404, method);
    assert.ok(!touchedA(fake), `${method} must not touch company A rows`);
  }
});

test('barbershops: update syncBranches cannot steal or clear another company branch', async () => {
  const fake = installFakeDb(seed());
  const { tables } = fake;
  const res = await call('update', staffReq(COMPANY_B, { params: { id: SHOP_B }, body: { name: 'President', branch_ids: [BRANCH_A1, BRANCH_B1] } }), fake);
  assert.equal(res.statusCode, 400);
  assert.equal(tables().branches.find((row) => row.id === BRANCH_A1).marketplace_barbershop_id, SHOP_A);

  const fake2 = installFakeDb(seed());
  const ok = await call('update', staffReq(COMPANY_B, { params: { id: SHOP_B }, body: { name: 'President', branch_ids: [] } }), fake2);
  assert.equal(ok.statusCode, 200);
  assert.equal(fake2.tables().branches.find((row) => row.id === BRANCH_B1).marketplace_barbershop_id, null);
  assert.equal(fake2.tables().branches.find((row) => row.id === BRANCH_A1).marketplace_barbershop_id, SHOP_A);
});

test('barbershops: remove of own barbershop clears only own company rows', async () => {
  const data = seed();
  // A corrupted cross-company link must not be cleared by company B.
  data.users.push({ id: 'ub', role: 'merchant', company_id: COMPANY_A, marketplace_barbershop_id: SHOP_B });
  const fake = installFakeDb(data);
  const res = await call('remove', staffReq(COMPANY_B, { params: { id: SHOP_B } }), fake);
  assert.equal(res.statusCode, 200);
  assert.equal(fake.tables().users.find((row) => row.id === 'ub').marketplace_barbershop_id, SHOP_B);
  assert.equal(fake.tables().branches.find((row) => row.id === BRANCH_B1).marketplace_barbershop_id, null);
});

test('barbershops: merchants of a foreign barbershop cannot be listed, created or deleted', async () => {
  let fake = installFakeDb(seed());
  const list = await call('listMerchants', staffReq(COMPANY_B, { params: { id: SHOP_A } }), fake);
  assert.equal(list.statusCode, 404);

  fake = installFakeDb(seed());
  const created = await call('createMerchant', staffReq(COMPANY_B, { params: { id: SHOP_A }, body: { login: 'x', password: 'secret1' } }), fake);
  assert.equal(created.statusCode, 404);
  assert.ok(!fake.writes.length);

  fake = installFakeDb(seed());
  const deleted = await call('deleteMerchant', staffReq(COMPANY_B, { params: { id: SHOP_A }, body: { id: MERCHANT_A } }), fake);
  assert.equal(deleted.statusCode, 404);
  assert.ok(!touchedA(fake));
});

test('barbershops: createMerchant on own barbershop writes company_id explicitly', async () => {
  const fake = installFakeDb(seed());
  const res = await call('createMerchant', staffReq(COMPANY_B, { params: { id: SHOP_B }, body: { login: 'mb', password: 'secret1' } }), fake);
  assert.equal(res.statusCode, 201);
  const insert = fake.writes.find((write) => write.op === 'insert' && write.table === 'users');
  assert.equal(insert.payload.company_id, COMPANY_B);
  assert.equal(insert.payload.marketplace_barbershop_id, SHOP_B);
});
