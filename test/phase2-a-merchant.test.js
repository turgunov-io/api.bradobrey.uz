// MULTI_TENANCY Phase 2 (group A, H1 defence-in-depth): every merchant query
// that reaches branches through marketplace_barbershop_id also pins
// branches.company_id to the merchant's own company, so a stray cross-company
// link (corrupted marketplace_barbershop_id) never exposes or changes another
// company's branches, barbers or orders.
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.JWT_SECRET ||= 'phase2-a-merchant-secret';

const merchant = require('../src/models/merchant');
const { installPoolMock, makeRes } = require('./helpers/tenantMocks');

const COMPANY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const SHOP_B = 'b5b5b5b5-0000-4000-8000-0000000000b5';
const MERCHANT_B = '20000000-0000-4000-8000-00000000000b';
const BRANCH_B1 = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
const BARBER_ID = '30000000-0000-4000-8000-000000000003';

const headers = () => ({ authorization: `Bearer ${jwt.sign({ sub: MERCHANT_B, role: 'merchant' }, process.env.JWT_SECRET)}` });

function handler(sql) {
  if (/from users u\s+left join companies c/.test(sql)) {
    return { rows: [{ id: MERCHANT_B, login: 'm', role: 'merchant', branch_id: null, marketplace_barbershop_id: SHOP_B, company_id: COMPANY_B, company_status: 'active' }] };
  }
  if (/from marketplace_barbershops where id = \$1 and company_id = \$2/.test(sql)) return { rows: [{}] };
  if (/count\(/.test(sql)) return { rows: [{ count: 0, completed: 0, revenue: 0 }] };
  return { rows: [] };
}

// Statements that scope by the barbershop link on branches.
const branchScoped = (sql) => /(from|join|update) branches\b/.test(sql) && /marketplace_barbershop_id = \$\d/.test(sql);

test('merchant: branch-linked queries also pin branches.company_id to the merchant company', async () => {
  const mock = installPoolMock(handler);
  try {
    const calls = [
      ['dashboard', {}],
      ['activeOrders', {}],
      ['history', {}],
      ['listBranches', {}],
      ['updateBranch', { params: { id: BRANCH_B1 }, body: { name: 'X' } }],
      ['deleteBranch', { params: { id: BRANCH_B1 } }],
      ['listBarbers', {}],
      ['createBarber', { body: { name: 'Ali' } }],
      ['updateBarber', { params: { id: BARBER_ID }, body: { name: 'Vali' } }],
      ['deleteBarber', { params: { id: BARBER_ID } }],
    ];
    for (const [method, extra] of calls) {
      await merchant[method]({ headers: headers(), params: {}, query: {}, body: {}, ...extra }, makeRes());
    }
  } finally {
    mock.restore();
  }

  const scoped = mock.calls.filter((call) => branchScoped(call.sql));
  assert.ok(scoped.length >= 10, `expected branch-scoped statements, saw ${scoped.length}`);
  for (const call of scoped) {
    assert.match(call.sql, /\b(br|branches)?\.?company_id = \$\d/, `missing company pin:\n${call.sql}`);
    assert.ok((call.params || []).includes(COMPANY_B), `company param missing:\n${call.sql}`);
  }
});
