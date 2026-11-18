// MULTI_TENANCY B2 — services/prices never mix between companies (owner rule D1).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');

process.env.PGDATABASE ||= 'company-service-prices-tests';
process.env.PGHOST ||= '127.0.0.1';
process.env.PGUSER ||= 'company-service-prices-tests';
process.env.JWT_SECRET ||= 'company-service-prices-secret';

const { installDbMock, installPoolMock, makeRes } = require('./helpers/tenantMocks');
const scope = require('../src/utils/serviceScope');
const barbers = require('../src/models/barbers');

const COMPANY_A = '00000000-0000-0000-0000-0000000000aa';
const COMPANY_B = '00000000-0000-0000-0000-0000000000bb';
const BRANCH_A1 = 'a1000000-0000-0000-0000-000000000001';
const BRANCH_A2 = 'a2000000-0000-0000-0000-000000000002';
const BRANCH_B1 = 'b1000000-0000-0000-0000-000000000001';

// Same id space, two companies: A's shared haircut and B's shared haircut.
const SERVICES = [
  { id: 'svc-a-shared', company_id: COMPANY_A, branch_id: null, base_price: 100, duration_minutes: 30, name: 'A cut', is_active: true },
  { id: 'svc-a-branch2', company_id: COMPANY_A, branch_id: BRANCH_A2, base_price: 70, duration_minutes: 20, name: 'A2 beard', is_active: true },
  { id: 'svc-b-shared', company_id: COMPANY_B, branch_id: null, base_price: 999, duration_minutes: 90, name: 'B cut', is_active: true },
];
const BRANCH_COMPANY = { [BRANCH_A1]: COMPANY_A, [BRANCH_A2]: COMPANY_A, [BRANCH_B1]: COMPANY_B };

// services mock honouring .eq/.in('company_id') like Postgres would.
const servicesResponder = (chain) => {
  let rows = SERVICES;
  for (const { method, args } of chain) {
    if (method === 'eq') rows = rows.filter((row) => String(row[args[0]]) === String(args[1]));
    if (method === 'in') rows = rows.filter((row) => args[1].map(String).includes(String(row[args[0]])));
  }
  return { data: rows, error: null };
};
const branchResponder = (chain) => {
  const id = chain.find((c) => c.method === 'eq' && c.args[0] === 'id')?.args[1];
  return { data: BRANCH_COMPANY[id] ? { id, company_id: BRANCH_COMPANY[id] } : null, error: null };
};
const repeat = (fn, n = 20) => Array.from({ length: n }, () => fn);

test('isServiceUsable: own company shared/own-branch only', () => {
  const [aShared, aBranch2, bShared] = SERVICES;
  assert.equal(scope.isServiceUsable(aShared, { companyId: COMPANY_A, branchId: BRANCH_A1 }), true);
  assert.equal(scope.isServiceUsable(aBranch2, { companyId: COMPANY_A, branchId: BRANCH_A2 }), true);
  assert.equal(scope.isServiceUsable(aBranch2, { companyId: COMPANY_A, branchId: BRANCH_A1 }), false);
  assert.equal(scope.isServiceUsable(bShared, { companyId: COMPANY_A, branchId: BRANCH_A1 }), false);
  assert.equal(scope.isServiceUsable(aShared, { companyId: null, branchId: BRANCH_A1 }), false, 'unknown company fails closed');
});

test('serviceMatchesEntrySql requires same company and branch-or-shared', () => {
  assert.equal(scope.serviceMatchesEntrySql('s', 'q'),
    's.company_id = q.company_id and (s.branch_id is null or s.branch_id = q.branch_id)');
  assert.throws(() => scope.serviceMatchesEntrySql('s; drop', 'q'));
});

test('loadServicesForEntries prices each entry with its own company only', async () => {
  const mock = installDbMock({ services: repeat(servicesResponder), branches: repeat(branchResponder) });
  try {
    const entryA = { id: 'qa', branch_id: BRANCH_A1, service_ids: ['svc-a-shared', 'svc-b-shared', 'svc-a-branch2'] };
    const entryB = { id: 'qb', branch_id: BRANCH_B1, company_id: COMPANY_B, service_ids: ['svc-b-shared', 'svc-a-shared'] };
    const servicesFor = await scope.loadServicesForEntries([entryA, entryB], 'base_price');
    assert.deepEqual(servicesFor(entryA).map((s) => s.id), ['svc-a-shared']);
    assert.deepEqual(servicesFor(entryB).map((s) => s.id), ['svc-b-shared']);
    const serviceQueries = mock.calls.filter((c) => c.table === 'services' && c.args[0] === 'company_id');
    assert.ok(serviceQueries.length > 0, 'services query is filtered by company in SQL');
  } finally {
    mock.restore();
  }
});

test('loadServicesForEntries: entry with unknown company gets no prices', async () => {
  const mock = installDbMock({ services: repeat(servicesResponder), branches: repeat(branchResponder) });
  try {
    const orphan = { id: 'qx', branch_id: 'unknown-branch', service_ids: ['svc-a-shared'] };
    const servicesFor = await scope.loadServicesForEntries([orphan]);
    assert.deepEqual(servicesFor(orphan), []);
    assert.equal(mock.calls.some((c) => c.table === 'services'), false);
  } finally {
    mock.restore();
  }
});

test('loadBranchServices drops foreign-company and other-branch ids', async () => {
  const mock = installDbMock({ services: repeat(servicesResponder), branches: repeat(branchResponder) });
  try {
    const rows = await scope.loadBranchServices(['svc-b-shared', 'svc-a-shared', 'svc-a-branch2'], { branchId: BRANCH_A1 });
    assert.deepEqual(rows.map((s) => s.id), ['svc-a-shared']);
  } finally {
    mock.restore();
  }
});

// ---- barber app: attaching a service to a queue entry ----

const VALID_SESSION = {
  session_id: 'session-1',
  session_expires_at: new Date(Date.now() + 60_000).toISOString(),
  is_expired: false,
  role: 'barber',
  is_archived: false,
  branch_is_active: true,
  branch_access_revoked: false,
};
const barberReq = (body) => ({
  headers: { authorization: `Bearer ${jwt.sign({ sub: 'barber-1', role: 'barber', branchId: BRANCH_A1, jti: 'session-1' }, process.env.JWT_SECRET)}` },
  params: { id: 'queue-1' },
  query: {},
  body,
  app: { get: () => null },
});

test('updateQueue rejects another company\'s shared service (no cross-company price)', async () => {
  const entry = { id: 'queue-1', barber_id: 'barber-1', status: 'waiting', branch_id: BRANCH_A1, company_id: COMPANY_A, service_id: 'svc-a-shared', service_ids: ['svc-a-shared'] };
  const mock = installDbMock({ queue_entries: [{ data: entry, error: null }], services: repeat(servicesResponder), branches: repeat(branchResponder) });
  const pool = installPoolMock(async () => ({ rows: [VALID_SESSION] }));
  try {
    const res = makeRes();
    await barbers.updateQueue(barberReq({ service_ids: ['svc-b-shared'] }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(mock.calls.some((c) => c.table === 'queue_entries' && c.method === 'update'), false);
  } finally {
    mock.restore();
    pool.restore();
  }
});

test('updateQueue accepts its own company\'s shared service', async () => {
  const entry = { id: 'queue-1', barber_id: 'barber-1', status: 'waiting', branch_id: BRANCH_A1, company_id: COMPANY_A, service_id: 'svc-a-shared', service_ids: ['svc-a-shared'] };
  const updated = { ...entry, status: 'waiting' };
  const mock = installDbMock({ queue_entries: [{ data: entry, error: null }, { data: updated, error: null }], services: repeat(servicesResponder), branches: repeat(branchResponder) });
  const pool = installPoolMock(async () => ({ rows: [VALID_SESSION] }));
  try {
    const res = makeRes();
    await barbers.updateQueue(barberReq({ service_ids: ['svc-a-shared'] }), res);
    assert.notEqual(res.statusCode, 400, JSON.stringify(res.body));
    assert.equal(res.body?.entry?.total_price, 100);
  } finally {
    mock.restore();
    pool.restore();
  }
});

// ---- static guard: every service-by-id lookup in src/ is company scoped ----

test('no unscoped services lookups remain in src/', () => {
  const root = path.join(__dirname, '..', 'src');
  const files = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.js')) files.push(full);
    }
  };
  walk(root);
  const offenders = [];
  for (const file of files) {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    if (rel === 'utils/serviceScope.js') continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!/from\(\s*['"]services['"]\s*\)|\b(from|join)\s+services\b/i.test(line)) return;
      // The statement (this line + the next 6) must mention company scope.
      const window = lines.slice(index, index + 7).join('\n');
      if (/company_id|companyId|serviceMatchesEntrySql|marketplace_barbershop_id|SERVICE_SCOPE_OK/.test(window)) return;
      offenders.push(`${rel}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});
