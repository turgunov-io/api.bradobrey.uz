const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { applyEmployeeLogoutTransaction } = require('../src/utils/employeePresenceTransaction');
const { evaluateEmployeeSession, getEmployeeSessionExpiry, getEmployeeTokenTtlSeconds } = require('../src/utils/employeeSession');
const { cleanupExpiredEmployeeSessions } = require('../src/jobs/employeeSessionCleanup');

const read = (path) => fs.readFileSync(path, 'utf8');

test('logout is JWT-scoped and clears both presence stores transactionally', () => {
  const source = read('src/models/barbers.js');
  const helper = read('src/utils/employeePresenceTransaction.js');
  const service = read('src/utils/employeeBranches.js');
  const logoutHandler = source.slice(source.indexOf('async logout(req, res)'), source.indexOf('async presence(req, res)'));
  assert.match(source, /authenticateBarberWorkspace\(req, res, 'Only workspace employees can log out', \{ allowRevoked: true \}\)/);
  assert.match(source, /allowRevoked: true/);
  assert.match(source, /idempotent: true/);
  assert.match(source, /logoutEmployeePresence\(barber_id\)/);
  assert.match(logoutHandler, /const barber_id = auth\.barberId/);
  assert.doesNotMatch(logoutHandler, /req\.body[\s\S]*barber_id/);
  assert.match(logoutHandler, /if \(!auth\.sessionValid\) return res\.json\(\{ barber: null, idempotent: true \}\)/);
  assert.match(service, /async function logoutEmployeePresence\(employeeId\)/);
  assert.match(service, /applyEmployeeLogoutTransaction\(client, normalizedEmployeeId\)/);
  assert.match(helper, /await client\.query\('begin'\)/);
  assert.match(helper, /update employee_active_branches[\s\S]*set is_on_shift = false[\s\S]*session_id = null[\s\S]*session_expires_at = null/);
  assert.match(helper, /update barbers set is_on_shift = false/);
  assert.match(helper, /await client\.query\('commit'\)/);
  assert.match(helper, /await client\.query\('rollback'\)/);
  assert.match(source, /clearShiftTimer\(barber_id\)/);
});

test('kiosk visibility requires a valid persisted session, not a recent heartbeat', () => {
  const source = read('src/models/kiosk.js');
  const projection = read('src/utils/kioskBarberPresence.js');
  assert.match(source, /session_expires_at/);
  assert.match(source, /\.gt\('session_expires_at'/);
  assert.doesNotMatch(source, /\.gte\('updated_at', presenceCutoff\)/);
  assert.match(source, /buildAuthenticatedBarberRoster/);
  assert.match(projection, /session_id/);
  assert.match(projection, /session_expires_at/);
  assert.match(projection, /is_on_shift: session\.is_on_shift === true/);
  assert.match(source, /from\('employee_branch_access'\)/);
  assert.match(source, /deniedEmployeeIds/);
  assert.match(source, /isMissingActivePresenceTable\(activeBarbersError\)/);
  assert.match(source, /EMPLOYEE_SESSION_SCHEMA_UNAVAILABLE/);
  assert.match(source, /error\?\.code === '42P01'/);
});

test('employee login creates a signed, expiring server session and protected routes validate it', () => {
  const source = read('src/models/barbers.js');
  const session = read('src/utils/employeeSession.js');
  const branches = read('src/utils/employeeBranches.js');
  const migration = read('db/postgres/employee_branches.sql');
  assert.match(source, /jti: sessionId/);
  assert.match(source, /sessionExpiresAt/);
  assert.match(session, /session\.session_id/);
  assert.match(session, /eab\.session_expires_at/);
  assert.match(session, /branch_access_revoked/);
  assert.match(branches, /session_id, session_expires_at/);
  assert.match(migration, /add column if not exists session_expires_at timestamptz/i);
  assert.match(read('src/server.js'), /validatePersistedEmployeeSession/);
  assert.match(read('src/server.js'), /startEmployeeSessionCleanup/);
});

test('persisted sessions survive off-shift state but expire, revoke, and branch-block independently', () => {
  const base = {
    session_id: 'session-1',
    session_expires_at: '2099-01-01T00:00:00.000Z',
    is_expired: false,
    role: 'barber',
    is_archived: false,
    branch_is_active: true,
    branch_access_revoked: false,
  };
  assert.deepEqual(evaluateEmployeeSession(base, { sessionId: 'session-1', role: 'barber' }), { valid: true });
  assert.equal(evaluateEmployeeSession({ ...base, is_expired: true }, { sessionId: 'session-1', role: 'barber' }).reason, 'expired');
  assert.equal(evaluateEmployeeSession(base, { sessionId: 'other-session', role: 'barber' }).reason, 'revoked');
  assert.equal(evaluateEmployeeSession({ ...base, is_archived: true }, { sessionId: 'session-1', role: 'barber' }).reason, 'account_blocked');
  assert.equal(evaluateEmployeeSession({ ...base, branch_access_revoked: true }, { sessionId: 'session-1', role: 'barber' }).reason, 'branch_access_revoked');
});

test('server employee sessions expire at Tashkent midnight and branch switches cannot extend them', () => {
  const now = new Date('2026-10-18T18:59:00.000Z'); // 23:59 in Asia/Tashkent
  const tokenExpiry = Math.floor(Date.parse('2026-10-19T06:59:00.000Z') / 1000);
  assert.equal(getEmployeeTokenTtlSeconds(new Date('2026-10-18T12:00:00.000Z'), '1h'), 3600);
  assert.equal(getEmployeeTokenTtlSeconds(now, '12h'), 60);
  assert.equal(
    getEmployeeSessionExpiry(tokenExpiry, now),
    '2026-10-18T19:00:00.000Z',
  );
  assert.equal(
    getEmployeeSessionExpiry(tokenExpiry, now, '2026-10-18T18:59:30.000Z'),
    '2026-10-18T18:59:30.000Z',
  );
});

test('expiry cleanup revokes persisted state atomically and emits a branch-scoped removal event', async () => {
  let queryText = '';
  const emitted = [];
  const rows = [{ employee_id: 'employee-1', branch_id: 'branch-1', reason: 'expired' }];
  const expired = await cleanupExpiredEmployeeSessions({
    database: {
      async query(sql) {
        queryText = sql;
        return { rows };
      },
    },
    io: {
      to(room) {
        return { emit(event, payload) { emitted.push({ room, event, payload }); } };
      },
    },
  });
  assert.equal(expired.length, 1);
  assert.match(queryText, /session_expires_at <= now\(\)/);
  assert.match(queryText, /update employee_active_branches[\s\S]*update barbers/);
  assert.deepEqual(emitted[0], {
    room: 'branch:branch-1',
    event: 'queue:update',
    payload: {
      type: 'barber_status',
      barberId: 'employee-1',
      branchId: 'branch-1',
      is_on_shift: false,
      session_expired: true,
      reason: 'expired',
    },
  });
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
