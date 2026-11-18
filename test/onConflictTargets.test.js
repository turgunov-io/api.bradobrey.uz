// Every ON CONFLICT / upsert target in src/ and db/postgres must match a
// unique key (PK, UNIQUE constraint or unique index) that exists after
// apply-schema.sh + all db/migrations — in particular after 007 dropped the
// global uniques (login, clients.phone, promo/cert code, SKU, category name,
// referral_code, platform_settings.key). Static check of the SQL text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildCatalog, colKey, splitTopLevel, normalize, ROOT } = require('./helpers/uniqueIndexCatalog');

function walk(dir, ext, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, ext, out);
    else if (name.endsWith(ext)) out.push(full);
  }
  return out;
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

// { file, line, table, cols } for every conflict target.
function collectTargets() {
  const targets = [];
  const files = [
    ...walk(path.join(ROOT, 'src'), '.js'),
    ...walk(path.join(ROOT, 'db', 'postgres'), '.sql'),
    ...fs.readdirSync(path.join(ROOT, 'db', 'migrations'))
      .filter((name) => /^\d{3}_.+\.sql$/.test(name))
      .map((name) => path.join(ROOT, 'db', 'migrations', name)),
  ];
  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const text = file.endsWith('.sql') ? normalize(raw) : raw.toLowerCase().replace(/\bpublic\./g, '');
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');

    for (const match of text.matchAll(/on\s+conflict\s*\(/g)) {
      const open = match.index + match[0].length - 1;
      let depth = 0;
      let end = open;
      for (; end < text.length; end += 1) {
        if (text[end] === '(') depth += 1;
        if (text[end] === ')') { depth -= 1; if (depth === 0) break; }
      }
      const cols = splitTopLevel(text.slice(open + 1, end));
      const before = text.slice(0, match.index);
      const inserts = Array.from(before.matchAll(/insert\s+into\s+([a-z_][a-z0-9_]*)/g));
      const table = inserts.length ? inserts.at(-1)[1] : null;
      targets.push({ file: rel, line: lineOf(text, match.index), table, cols });
    }

    if (file.endsWith('.js')) {
      for (const match of text.matchAll(/onconflict:\s*['"]([^'"]+)['"]/g)) {
        const before = text.slice(0, match.index);
        const froms = Array.from(before.matchAll(/\.from\(\s*['"]([a-z_][a-z0-9_]*)['"]\s*\)/g));
        const table = froms.length ? froms.at(-1)[1] : null;
        targets.push({ file: rel, line: lineOf(text, match.index), table, cols: match[1].split(',').map((c) => c.trim()) });
      }
    }
  }
  return targets.filter((target) => !/^src\/config\/postgres\.js$/.test(target.file)); // the query builder itself
}

test('catalog sanity: 007 replaced the global uniques with company-scoped keys', () => {
  const catalog = buildCatalog();
  const has = (table, cols) => (catalog.get(table) || []).some((entry) => entry.cols === colKey(cols));
  assert.equal(has('clients', ['phone']), false, 'clients.phone global unique must be gone');
  assert.equal(has('clients', ['company_id', 'phone']), true);
  assert.equal(has('users', ['login']), true, 'partial users_platform_login_uidx (platform owners) remains');
  assert.equal(has('users', ['company_id', 'login']), true);
  assert.equal(has('promo_codes', ['code']), false);
  assert.equal(has('certificates', ['code']), false);
  assert.equal(has('referral_accounts', ['referral_code']), false);
  assert.equal(has('referral_accounts', ['company_id', 'referral_code']), true);
  assert.equal(has('platform_settings', ['key']), false);
  assert.equal(has('platform_settings', ['company_id', 'key']), true);
  assert.equal(has('kiosk_ad_settings', ['company_id']), true);
});

test('every ON CONFLICT / upsert target matches a unique key after all migrations', () => {
  const catalog = buildCatalog();
  const targets = collectTargets();
  assert.ok(targets.length > 40, `expected many targets, found ${targets.length}`);
  const problems = [];
  for (const target of targets) {
    if (!target.table) { problems.push(`${target.file}:${target.line} no insert/from table found`); continue; }
    const keys = catalog.get(target.table);
    if (!keys) { problems.push(`${target.file}:${target.line} unknown table ${target.table}`); continue; }
    if (!keys.some((entry) => entry.cols === colKey(target.cols))) {
      problems.push(`${target.file}:${target.line} ${target.table} (${target.cols.join(', ')}) has no unique key; have: ${keys.map((k) => `(${k.cols})`).join(' ')}`);
    }
  }
  assert.deepEqual(problems, []);
});
