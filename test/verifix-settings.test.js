const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const id = '00000000-0000-0000-0000-000000000001';
function setup({ role = 'admin_network', branches = 1, fail = false } = {}) {
  const calls = [];
  let rate = 0;
  const query = async (sql, params) => {
    sql = sql.trim(); calls.push({ sql, params });
    if (sql.startsWith('SELECT id FROM branches')) return { rowCount: branches };
    if (sql.startsWith('INSERT INTO barber_work_schedules')) {
      if (fail) throw new Error('write failed');
      return { rowCount: 7 * params[0].length };
    }
    if (sql.startsWith('INSERT INTO verifix_settings')) rate = params[0];
    return { rows: [{ penalty_per_minute: rate }] };
  };
  const context = { module: { exports: {} }, process: { env: {} }, require(name) {
    if (name === 'jsonwebtoken') return { verify: () => ({ role, branchId: id }) };
    if (name.includes('postgres')) return { db: { query }, pool: { connect: async () => ({ query, release() { calls.push({ sql: 'RELEASE' }); } }) } };
    throw new Error(name);
  }};
  vm.runInNewContext(fs.readFileSync('src/models/verifix.js', 'utf8'), context);
  const req = { headers: { authorization: 'Bearer test' }, method: 'PATCH', body: {} };
  const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  return { api: context.module.exports, calls, req, res };
}
const body = { branch_ids: [id], start_time: '10:00', end_time: '20:00', grace_minutes: 5 };
test('bulk schedule replaces general schedules and inserts all seven days atomically', async () => {
  const { api, calls, req, res } = setup();
  req.body = body;
  await api.bulkSchedules(req, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.updated, 7);
  assert.equal(calls[0].sql, 'BEGIN');
  assert.match(calls[2].sql, /barber_id IS NULL/);
  assert.match(calls[3].sql, /generate_series\(0, 6\)/);
  assert.equal(calls[4].sql, 'COMMIT');
  assert.equal(calls[5].sql, 'RELEASE');
});
test('bulk schedule rolls back if a branch disappeared or insert fails', async () => {
  for (const options of [{ branches: 0 }, { fail: true }]) {
    const { api, calls, req, res } = setup(options);
    req.body = body;
    await api.bulkSchedules(req, res);
    assert.ok(res.code >= 400);
    assert.equal(calls.at(-2).sql, 'ROLLBACK');
    assert.equal(calls.at(-1).sql, 'RELEASE');
    assert.ok(!calls.some(call => call.sql === 'COMMIT'));
  }
});
test('rejects invalid times, days and unauthorized bulk scope', async () => {
  for (const change of [{ start_time: '25:00' }, { end_time: '10:00' }, { grace_minutes: -1 }, { branch_ids: [] }]) {
    const { api, req, res, calls } = setup();
    req.body = { ...body, ...change };
    await api.bulkSchedules(req, res);
    assert.equal(res.code, 400);
    assert.equal(calls.length, 0);
  }
  const { api, req, res } = setup({ role: 'admin_branch' });
  req.body = { ...body, branch_ids: ['00000000-0000-0000-0000-000000000002'] };
  await api.bulkSchedules(req, res);
  assert.equal(res.code, 403);
});
test('persists an editable fixed rate including zero', async () => {
  const { api, req, res } = setup();
  for (const rate of [1500, 25.50, 0]) {
    req.body = { penalty_per_minute: rate };
    await api.penaltySettings(req, res);
    assert.equal(res.code, 200);
    assert.equal(res.body.penalty_per_minute, rate);
  }
});
test('rejects invalid rates and non-network edits', async () => {
  for (const rate of [-1, null, '100', 0.001]) {
    const { api, req, res, calls } = setup();
    req.body = { penalty_per_minute: rate };
    await api.penaltySettings(req, res);
    assert.equal(res.code, 400);
    assert.equal(calls.length, 0);
  }
  const { api, req, res } = setup({ role: 'admin_branch' });
  req.body = { penalty_per_minute: 100 };
  await api.penaltySettings(req, res);
  assert.equal(res.code, 403);
});
