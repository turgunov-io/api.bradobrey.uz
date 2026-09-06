const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const item = { id: '00000000-0000-0000-0000-000000000001', category: 'Hair', sort_order: 0 };
function setup(rowCount = 1, fail = false) {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql: sql.trim(), params });
      if (sql.includes('UPDATE')) {
        if (fail) throw new Error('database failure');
        return { rowCount };
      }
    },
    release() { calls.push({ sql: 'RELEASE' }); },
  };
  const context = { module: { exports: {} }, require(name) {
    if (name.includes('postgres')) return { db: {}, pool: { connect: async () => client } };
    return {};
  }};
  vm.runInNewContext(fs.readFileSync('src/models/services.js', 'utf8'), context);
  const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  return { service: context.module.exports, res, calls };
}
test('saves order and category in one transaction', async () => {
  const { service, res, calls } = setup();
  await service.reorder({ body: { items: [item] } }, res);
  assert.equal(res.code, 200);
  assert.equal(calls[0].sql, 'BEGIN');
  assert.deepEqual(JSON.parse(calls[1].params[0]), [item]);
  assert.equal(calls[2].sql, 'COMMIT');
  assert.equal(calls[3].sql, 'RELEASE');
});
test('rejects invalid and duplicate positions before accessing database', async () => {
  for (const items of [[], [item, item], [{ ...item, sort_order: -1 }], [{ ...item, sort_order: 0.5 }], [{ ...item, id: 'bad' }]]) {
    const { service, res, calls } = setup();
    await service.reorder({ body: { items } }, res);
    assert.equal(res.code, 400);
    assert.equal(calls.length, 0);
  }
});
test('rolls back the entire save when a service was deleted', async () => {
  const { service, res, calls } = setup(0);
  await service.reorder({ body: { items: [item] } }, res);
  assert.equal(res.code, 409);
  assert.equal(calls[2].sql, 'ROLLBACK');
  assert.equal(calls[3].sql, 'RELEASE');
});
test('rolls back and releases connection on a database error', async () => {
  const { service, res, calls } = setup(0, true);
  await service.reorder({ body: { items: [item] } }, res);
  assert.equal(res.code, 500);
  assert.equal(calls[2].sql, 'ROLLBACK');
  assert.equal(calls[3].sql, 'RELEASE');
});
