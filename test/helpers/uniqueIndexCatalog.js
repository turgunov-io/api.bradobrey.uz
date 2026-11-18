// Static catalog of unique keys (PK, UNIQUE constraints, unique indexes) as
// they exist after `apply-schema.sh` + every db/migrations/NNN_*.sql, built
// from the SQL text alone (no database). Used by onConflictTargets.test.js.
//
// It understands the DDL shapes used in this repo: create table bodies
// (column-level and table-level primary key / unique), create unique index,
// alter table add constraint ... (primary key|unique) [(cols)|using index],
// drop index / drop constraint, and the migration helpers
// pg_temp.mt_company_singleton(table) and
// pg_temp.mt_drop_single_column_unique(table, column).
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

const stripComments = (sql) => sql.replace(/--[^\n]*/g, '');
const normalize = (sql) => stripComments(sql).toLowerCase().replace(/"/g, '').replace(/\bpublic\./g, '');

// Splits "a, lower(b), c" at top-level commas.
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

// Text inside the parenthesis that opens at `openIndex`.
function balanced(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return { inner: text.slice(openIndex + 1, i), end: i };
    }
  }
  return null;
}

const colKey = (cols) => cols.map((c) => c.replace(/\s+/g, ' ').trim()).sort().join(',');

function applySchemaOrder() {
  const script = fs.readFileSync(path.join(ROOT, 'scripts', 'apply-schema.sh'), 'utf8');
  const listed = Array.from(script.matchAll(/^\s+([a-z0-9_]+\.sql)\s*$/gm)).map((m) => m[1]);
  // Base files applied by hand (notifications.sql, barber_location_control.sql, ...)
  // come after the scripted ones.
  const rest = fs.readdirSync(path.join(ROOT, 'db', 'postgres'))
    .filter((name) => name.endsWith('.sql') && !listed.includes(name))
    .sort();
  return [...listed, ...rest].map((file) => path.join(ROOT, 'db', 'postgres', file));
}

function migrationFiles() {
  const dir = path.join(ROOT, 'db', 'migrations');
  return fs.readdirSync(dir)
    .filter((name) => /^\d{3}_.+\.sql$/.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}

function buildCatalog(files = [...applySchemaOrder(), ...migrationFiles()]) {
  /** @type {Map<string, Array<{ name: string, cols: string, primary: boolean, single: string|null }>>} */
  const tables = new Map();
  const keysOf = (table) => {
    if (!tables.has(table)) tables.set(table, []);
    return tables.get(table);
  };
  const add = (table, name, cols, primary = false, isIndex = false) => {
    if (!table || /%/.test(table)) return;
    const list = keysOf(table);
    const key = colKey(cols);
    if (list.some((entry) => entry.name === name)) return; // "if not exists"
    list.push({ name, cols: key, primary, isIndex, single: cols.length === 1 ? cols[0] : null });
  };
  const dropByName = (name, table = null) => {
    for (const [tableName, list] of tables) {
      if (table && tableName !== table) continue;
      const index = list.findIndex((entry) => entry.name === name);
      if (index >= 0) list.splice(index, 1);
    }
  };
  const findByName = (name) => {
    for (const list of tables.values()) {
      const found = list.find((entry) => entry.name === name);
      if (found) return found;
    }
    return null;
  };

  for (const file of files) {
    const sql = normalize(fs.readFileSync(file, 'utf8'));
    const events = [];
    const push = (regex, kind) => {
      for (const match of sql.matchAll(regex)) events.push({ index: match.index, kind, match });
    };
    push(/create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)\s*\(/g, 'table');
    push(/create\s+unique\s+index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?([a-z_%][a-z0-9_%]*)\s+on\s+(?:only\s+)?([a-z_%][a-z0-9_%]*)(?:\s+using\s+\w+)?\s*\(/g, 'index');
    push(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([a-z_][a-z0-9_]*)\s+add\s+constraint\s+([a-z_][a-z0-9_]*)\s+(primary\s+key|unique)\s+using\s+index\s+([a-z_][a-z0-9_]*)/g, 'using');
    push(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([a-z_][a-z0-9_]*)\s+add\s+(?:constraint\s+([a-z_][a-z0-9_]*)\s+)?(primary\s+key|unique)\s*\(/g, 'addcons');
    push(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([a-z_][a-z0-9_]*)\s+drop\s+constraint\s+(?:if\s+exists\s+)?([a-z_][a-z0-9_]*)/g, 'dropcons');
    push(/drop\s+index\s+(?:concurrently\s+)?(?:if\s+exists\s+)?([a-z_][a-z0-9_]*)/g, 'dropindex');
    push(/mt_company_singleton\('([a-z_]+)'\)/g, 'singleton');
    push(/mt_drop_single_column_unique\('([a-z_]+)',\s*'([a-z_]+)'\)/g, 'dropsingle');
    events.sort((a, b) => a.index - b.index);

    for (const { kind, match } of events) {
      const openAt = match.index + match[0].length - 1;
      if (kind === 'table') {
        const table = match[1];
        const body = balanced(sql, openAt);
        if (!body) continue;
        for (const element of splitTopLevel(body.inner)) {
          const tablePk = element.match(/^(?:constraint\s+([a-z_][a-z0-9_]*)\s+)?primary\s+key\s*\(([^)]*)\)/);
          const tableUnique = element.match(/^(?:constraint\s+([a-z_][a-z0-9_]*)\s+)?unique\s*(?:nulls\s+not\s+distinct\s*)?\(([^)]*)\)/);
          if (tablePk) { add(table, tablePk[1] || `${table}_pkey`, splitTopLevel(tablePk[2]), true); continue; }
          if (tableUnique) {
            const cols = splitTopLevel(tableUnique[2]);
            add(table, tableUnique[1] || `${table}_${cols.join('_')}_key`, cols);
            continue;
          }
          const column = element.match(/^([a-z_][a-z0-9_]*)\s/);
          if (!column || /^(constraint|check|foreign|exclude)$/.test(column[1])) continue;
          const definition = element.replace(/references\s+[\s\S]*$/, '');
          if (/\bprimary\s+key\b/.test(definition)) add(table, `${table}_pkey`, [column[1]], true);
          if (/\bunique\b/.test(definition)) add(table, `${table}_${column[1]}_key`, [column[1]]);
        }
      } else if (kind === 'index') {
        const body = balanced(sql, openAt);
        if (body) add(match[2], match[1], splitTopLevel(body.inner), false, true);
      } else if (kind === 'using') {
        const index = findByName(match[4]);
        if (index) {
          dropByName(match[4]);
          add(match[1], match[2], index.cols.split(','), /primary/.test(match[3]));
        }
      } else if (kind === 'addcons') {
        const body = balanced(sql, openAt);
        if (!body) continue;
        const cols = splitTopLevel(body.inner);
        const primary = /primary/.test(match[3]);
        add(match[1], match[2] || (primary ? `${match[1]}_pkey` : `${match[1]}_${cols.join('_')}_key`), cols, primary);
      } else if (kind === 'dropcons') {
        dropByName(match[2], match[1]);
      } else if (kind === 'dropindex') {
        dropByName(match[1]);
      } else if (kind === 'singleton') {
        add(match[1], `${match[1]}_company_uidx`, ['company_id'], false, true);
      } else if (kind === 'dropsingle') {
        const list = keysOf(match[1]);
        for (let i = list.length - 1; i >= 0; i -= 1) {
          // The helper drops UNIQUE constraints (contype 'u'), not plain unique indexes.
          if (!list[i].primary && !list[i].isIndex && list[i].single === match[2]) list.splice(i, 1);
        }
      }
    }
  }
  return tables;
}

module.exports = { buildCatalog, colKey, splitTopLevel, normalize, ROOT };
