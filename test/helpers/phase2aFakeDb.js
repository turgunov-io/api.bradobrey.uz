// In-memory fake of the db.from() query builder for Phase 2 group A tests
// (not a test file). eq/in/is filters are applied to seeded table rows;
// insert/update/delete are applied and recorded so tests can assert that
// another company's rows were not touched.
const { db } = require('../../src/config/postgres');

// options.failOn({ table, op, payload }) may return an error object: that
// statement then fails (nothing applied) the way the real builder reports it.
function installFakeDb(seed, { failOn } = {}) {
  const tables = JSON.parse(JSON.stringify(seed));
  const writes = [];
  const originalFrom = db.from;
  db.from = (table) => {
    const filters = [];
    let op = 'select';
    let payload = null;
    let single = false;
    let max = null;
    const query = {
      select() { return query; },
      order() { return query; },
      limit(n) { max = n; return query; },
      eq(column, value) { filters.push((row) => String(row[column] ?? '') === String(value ?? '')); return query; },
      is(column, value) { filters.push((row) => (row[column] ?? null) === value); return query; },
      in(column, values) { filters.push((row) => values.map(String).includes(String(row[column]))); return query; },
      gt(column, value) { filters.push((row) => row[column] > value); return query; },
      gte(column, value) { filters.push((row) => row[column] >= value); return query; },
      lt(column, value) { filters.push((row) => row[column] < value); return query; },
      lte(column, value) { filters.push((row) => row[column] <= value); return query; },
      neq(column, value) { filters.push((row) => String(row[column] ?? '') !== String(value ?? '')); return query; },
      or() { return query; },
      maybeSingle() { single = true; return query; },
      single() { single = true; return query; },
      update(value) { op = 'update'; payload = value; return query; },
      delete() { op = 'delete'; return query; },
      insert(value) { op = 'insert'; payload = value; return query; },
      then(resolve, reject) {
        const rows = tables[table] || (tables[table] = []);
        const failure = typeof failOn === 'function' ? failOn({ table, op, payload }) : null;
        if (failure) {
          return Promise.resolve({ data: single ? null : [], error: failure, count: null }).then(resolve, reject);
        }
        let result;
        if (op === 'insert') {
          const row = { id: `new-${rows.length + 1}`, ...payload };
          rows.push(row);
          writes.push({ table, op, payload });
          result = single ? row : [row];
        } else {
          let matched = rows.filter((row) => filters.every((filter) => filter(row)));
          if (op === 'update') {
            matched.forEach((row) => Object.assign(row, payload));
            writes.push({ table, op, payload, ids: matched.map((row) => row.id) });
          }
          if (op === 'delete') {
            tables[table] = rows.filter((row) => !matched.includes(row));
            writes.push({ table, op, ids: matched.map((row) => row.id) });
          }
          if (max !== null) matched = matched.slice(0, max);
          result = single ? (matched[0] || null) : matched;
        }
        return Promise.resolve({ data: result, error: null, count: Array.isArray(result) ? result.length : undefined })
          .then(resolve, reject);
      },
    };
    return query;
  };
  return { tables: () => tables, writes, restore() { db.from = originalFrom; } };
}

module.exports = { installFakeDb };
