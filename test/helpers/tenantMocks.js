// Shared fakes for company-scoping tests (not a test file).
const { db, pool } = require('../../src/config/postgres');

const METHODS = ['select', 'eq', 'neq', 'in', 'is', 'or', 'order', 'limit', 'range', 'maybeSingle', 'single',
  'update', 'insert', 'upsert', 'delete', 'gt', 'gte', 'lt', 'lte', 'ilike', 'like'];

// Table-keyed fake of the query builder. `responses[table]` is a list of
// results (or functions of the recorded chain) consumed in call order.
function installDbMock(responses = {}) {
  const calls = [];
  const originalFrom = db.from;
  db.from = (table) => {
    const chain = [];
    const query = {
      then(resolve, reject) {
        const queue = responses[table] || [];
        let response = queue.length ? queue.shift() : { data: [], error: null };
        if (typeof response === 'function') response = response(chain);
        return Promise.resolve(response).then(resolve, reject);
      },
    };
    for (const method of METHODS) {
      query[method] = (...args) => { chain.push({ method, args }); calls.push({ table, method, args }); return query; };
    }
    return query;
  };
  return { calls, restore() { db.from = originalFrom; } };
}

function installPoolMock(handler) {
  const calls = [];
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  const run = async (sql, params) => {
    calls.push({ sql: String(sql), params });
    return (await handler(String(sql), params)) || { rows: [], rowCount: 0 };
  };
  pool.query = run;
  pool.connect = async () => ({ query: run, release() {} });
  return { calls, restore() { pool.query = originalQuery; pool.connect = originalConnect; } };
}

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const eqCalls = (calls, table, column) => calls
  .filter((call) => call.table === table && call.method === 'eq' && call.args[0] === column)
  .map((call) => call.args[1]);

const staffReq = (companyId, extra = {}) => ({
  headers: {},
  params: {},
  query: {},
  body: {},
  tenant: { companyId, isPlatformOwner: false },
  staffAccess: { actor: { id: 'u1', role: 'admin', company_id: companyId } },
  ...extra,
});

module.exports = { installDbMock, installPoolMock, makeRes, eqCalls, staffReq };
