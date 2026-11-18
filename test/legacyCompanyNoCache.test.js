// Security review M2: "exactly one company" (legacy single-company mode) must
// never be served from a cache — right after a second company is created every
// legacy fallback has to stop.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.PGDATABASE ||= 'legacy-company-tests';
process.env.PGHOST ||= '127.0.0.1';
process.env.PGUSER ||= 'legacy-company-tests';

const { db } = require('../src/config/postgres');
const { legacyDefaultCompanyId } = require('../src/utils/companyScope');

const COMPANY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const COMPANY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';

test('legacyDefaultCompanyId re-reads companies on every call (no cache)', async () => {
  let rows = [{ id: COMPANY_A, is_default: true, status: 'active' }];
  let queries = 0;
  const originalFrom = db.from;
  db.from = (table) => {
    assert.equal(table, 'companies');
    queries += 1;
    const query = { select: () => query, then: (resolve) => Promise.resolve({ data: rows, error: null }).then(resolve) };
    return query;
  };
  try {
    assert.equal(await legacyDefaultCompanyId(), COMPANY_A);
    rows = [...rows, { id: COMPANY_B, is_default: false, status: 'active' }];
    assert.equal(await legacyDefaultCompanyId(), null, 'second company is seen immediately');
    assert.equal(queries, 2);
  } finally {
    db.from = originalFrom;
  }
});

// Rehearsal 2026-11-19: prod has a branchless barbershop that migration 001
// turns into a SUSPENDED company. It must not end single-company mode, or
// deployed kiosks / dash lose their branch list on deploy day.
test('legacyDefaultCompanyId ignores suspended companies', async () => {
  const rows = [
    { id: COMPANY_A, is_default: true, status: 'active' },
    { id: COMPANY_B, is_default: false, status: 'suspended' },
  ];
  const originalFrom = db.from;
  db.from = () => {
    const query = { select: () => query, then: (resolve) => Promise.resolve({ data: rows, error: null }).then(resolve) };
    return query;
  };
  try {
    assert.equal(await legacyDefaultCompanyId(), COMPANY_A);
    rows[1] = { ...rows[1], status: 'active' };
    assert.equal(await legacyDefaultCompanyId(), null, 'activating the second company ends legacy mode');
  } finally {
    db.from = originalFrom;
  }
});
