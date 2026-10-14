const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { applyEmployeeLogoutTransaction } = require('../src/utils/employeePresenceTransaction');

const read = (path) => fs.readFileSync(path, 'utf8');

test('logout is JWT-scoped and clears both presence stores transactionally', () => {
  const source = read('src/models/barbers.js');
  const helper = read('src/utils/employeePresenceTransaction.js');
  const service = read('src/utils/employeeBranches.js');
  assert.match(source, /authenticateBarberWorkspace\(req, res, 'Only workspace employees can log out'\)/);
  assert.match(source, /logoutEmployeePresence\(barber_id\)/);
  assert.match(service, /async function logoutEmployeePresence\(employeeId\)/);
  assert.match(service, /applyEmployeeLogoutTransaction\(client, normalizedEmployeeId\)/);
  assert.match(helper, /await client\.query\('begin'\)/);
  assert.match(helper, /update employee_active_branches[\s\S]*set is_on_shift = false, updated_at = now\(\)/);
  assert.match(helper, /update barbers set is_on_shift = false/);
  assert.match(helper, /await client\.query\('commit'\)/);
  assert.match(helper, /await client\.query\('rollback'\)/);
  assert.match(source, /clearShiftTimer\(barber_id\)/);
});

test('kiosk visibility requires fresh on-shift presence', () => {
  const source = read('src/models/kiosk.js');
  assert.match(source, /updated_at/);
  assert.match(source, /\.gte\('updated_at', presenceCutoff\)/);
  assert.match(source, /isOnShift === true/);
  assert.match(source, /isMissingActivePresenceTable\(activeBarbersError\)/);
  assert.match(source, /error\?\.code === '42P01'/);
});

test('presence heartbeat endpoint is wired', () => {
  const router = read('src/routers/barbers.js');
  const model = read('src/models/barbers.js');
  assert.match(router, /router\.post\('\/presence', \(req, res\) => barbers\.presence\(req, res\)\)/);
  assert.match(model, /async presence\(req, res\)/);
  assert.match(model, /touchActiveEmployeeBranch/);
});

test('logout transaction clears active and legacy shift rows before commit', async () => {
  const statements = [];
  const client = {
    async query(sql) {
      const normalized = sql.trim().toLowerCase();
      statements.push(normalized);
      if (normalized.startsWith('select id, name')) {
        return { rows: [{ id: 'barber-1', branch_id: 'home-branch', is_on_shift: true }] };
      }
      if (normalized.includes('to_regclass')) {
        return { rows: [{ relation: 'employee_active_branches' }] };
      }
      if (normalized.startsWith('select branch_id')) {
        return { rows: [{ branch_id: 'active-branch' }] };
      }
      return { rows: [] };
    },
  };

  const result = await applyEmployeeLogoutTransaction(client, 'barber-1');

  assert.equal(result.barber.is_on_shift, false);
  assert.equal(result.activeBranchId, 'active-branch');
  const commitIndex = statements.indexOf('commit');
  assert.ok(commitIndex > statements.findIndex((sql) => sql.startsWith('update employee_active_branches')));
  assert.ok(commitIndex > statements.findIndex((sql) => sql.startsWith('update barbers')));
});

test('logout transaction rolls back both presence writes when either write fails', async () => {
  const statements = [];
  const client = {
    async query(sql) {
      const normalized = sql.trim().toLowerCase();
      statements.push(normalized);
      if (normalized.startsWith('select id, name')) {
        return { rows: [{ id: 'barber-1', branch_id: 'branch-1' }] };
      }
      if (normalized.includes('to_regclass')) {
        return { rows: [{ relation: 'employee_active_branches' }] };
      }
      if (normalized.startsWith('select branch_id')) {
        return { rows: [{ branch_id: 'branch-1' }] };
      }
      if (normalized.startsWith('update barbers')) throw new Error('write failed');
      return { rows: [] };
    },
  };

  await assert.rejects(
    applyEmployeeLogoutTransaction(client, 'barber-1'),
    /write failed/,
  );
  assert.equal(statements.at(-1), 'rollback');
  assert.equal(statements.includes('commit'), false);
});
