const { Pool, types } = require('pg');

types.setTypeParser(1082, (value) => value); // date
types.setTypeParser(1083, (value) => value); // time
types.setTypeParser(1114, (value) => value); // timestamp
types.setTypeParser(1184, (value) => value); // timestamptz
types.setTypeParser(1700, (value) => (value === null ? null : Number(value))); // numeric

const SSL_ENABLED_VALUES = new Set(['1', 'true', 'yes', 'require']);

const hasDiscretePostgresConfig = () => Boolean(
  (process.env.PGDATABASE || process.env.POSTGRES_DB) &&
  (process.env.PGHOST || process.env.POSTGRES_HOST) &&
  (process.env.PGUSER || process.env.POSTGRES_USER)
);

const isValidConnectionString = (value) => {
  if (!value) return false;

  try {
    const parsed = new URL(value);
    return ['postgres:', 'postgresql:'].includes(parsed.protocol);
  } catch (_err) {
    return false;
  }
};

const createPoolConfig = () => {
  const connectionString =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_CONNECTION_STRING;

  const sslValue = String(process.env.POSTGRES_SSL || process.env.PGSSLMODE || '').toLowerCase();
  const ssl = SSL_ENABLED_VALUES.has(sslValue)
    ? { rejectUnauthorized: String(process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED || 'true') !== 'false' }
    : undefined;

  // Keep pooled connections warm. Against a remote DB, letting sockets idle out
  // forces a fresh TCP + TLS handshake (several round-trips) on the next query,
  // which is the main source of latency when the API runs far from its database.
  const keepWarm = {
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    idleTimeoutMillis: Number(process.env.POSTGRES_IDLE_TIMEOUT_MS || 300000),
    max: Number(process.env.POSTGRES_POOL_MAX || 10),
  };

  if (connectionString && isValidConnectionString(connectionString)) {
    return {
      connectionString,
      ...keepWarm,
      ...(ssl ? { ssl } : {}),
    };
  }

  if (connectionString && !hasDiscretePostgresConfig()) {
    throw new Error(
      'Postgres DATABASE_URL is invalid: use a valid postgres:// URL or set PGHOST, PGPORT, PGDATABASE, PGUSER and PGPASSWORD'
    );
  }

  if (!process.env.PGDATABASE && !process.env.POSTGRES_DB) {
    throw new Error(
      'Postgres env vars missing: set DATABASE_URL or PGHOST, PGPORT, PGDATABASE, PGUSER and PGPASSWORD'
    );
  }

  return {
    database: process.env.PGDATABASE || process.env.POSTGRES_DB,
    host: process.env.PGHOST || process.env.POSTGRES_HOST || 'localhost',
    ...keepWarm,
    password: process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD,
    port: Number(process.env.PGPORT || process.env.POSTGRES_PORT || 5432),
    user: process.env.PGUSER || process.env.POSTGRES_USER,
    ...(ssl ? { ssl } : {}),
  };
};

const pool = new Pool(createPoolConfig());

const quoteIdentifier = (identifier) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier || '')) {
    throw new Error(`Invalid SQL identifier: ${identifier}`);
  }

  return `"${identifier}"`;
};

const splitTopLevel = (value) => {
  const parts = [];
  let current = '';
  let depth = 0;

  for (const char of String(value || '')) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;

    if (char === ',' && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
};

const parseSelect = (select = '*') => {
  const normalized = String(select || '*').replace(/\s+/g, ' ').trim();

  if (!normalized || normalized === '*') {
    return { baseColumns: [], includeAllBaseColumns: true, relations: [] };
  }

  const baseColumns = [];
  const relations = [];
  let includeAllBaseColumns = false;

  for (const part of splitTopLevel(normalized)) {
    if (part === '*') {
      includeAllBaseColumns = true;
      continue;
    }

    const relationMatch = part.match(/^([A-Za-z_][A-Za-z0-9_]*):([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)$/);

    if (relationMatch) {
      relations.push({
        alias: relationMatch[1],
        table: relationMatch[2],
        columns: splitTopLevel(relationMatch[3]),
      });
      continue;
    }

    baseColumns.push(part);
  }

  return { baseColumns, includeAllBaseColumns, relations };
};

const RELATIONS = {
  'barber_activity_events:barber': {
    type: 'belongsTo',
    table: 'barbers',
    localKey: 'barber_id',
    foreignKey: 'id',
  },
  'barber_activity_events:branch': {
    type: 'belongsTo',
    table: 'branches',
    localKey: 'branch_id',
    foreignKey: 'id',
  },
  'barber_work_schedules:barber': {
    type: 'belongsTo',
    table: 'barbers',
    localKey: 'barber_id',
    foreignKey: 'id',
  },
  'barber_work_schedules:branch': {
    type: 'belongsTo',
    table: 'branches',
    localKey: 'branch_id',
    foreignKey: 'id',
  },
  'queue_entries:barber': {
    type: 'belongsTo',
    table: 'barbers',
    localKey: 'barber_id',
    foreignKey: 'id',
  },
  'queue_entries:branch': {
    type: 'belongsTo',
    table: 'branches',
    localKey: 'branch_id',
    foreignKey: 'id',
  },
  'queue_entries:client': {
    type: 'belongsTo',
    table: 'clients',
    localKey: 'client_id',
    foreignKey: 'id',
  },
  'queue_entries:payments': {
    type: 'hasMany',
    table: 'payments',
    localKey: 'id',
    foreignKey: 'queue_entry_id',
  },
  'queue_entries:service': {
    type: 'belongsTo',
    table: 'services',
    localKey: 'service_id',
    foreignKey: 'id',
  },
};

const inferRelation = (sourceTable, relation) => {
  const configured = RELATIONS[`${sourceTable}:${relation.alias}`];
  if (configured) return configured;

  return {
    type: 'belongsTo',
    table: relation.table,
    localKey: `${relation.alias}_id`,
    foreignKey: 'id',
  };
};

const buildColumnList = (columns, alias) => {
  if (!columns.length || columns.includes('*')) return `${alias}.*`;

  return columns
    .map((column) => {
      const name = column.trim();
      return `${alias}.${quoteIdentifier(name)} AS ${quoteIdentifier(name)}`;
    })
    .join(', ');
};

const buildRelationExpression = (sourceTable, relation, index, sourceAlias = 't') => {
  const config = inferRelation(sourceTable, relation);
  const relationAlias = `r${index}`;
  const rowAlias = `rel${index}`;
  const columns = buildColumnList(relation.columns, relationAlias);
  const relationTable = quoteIdentifier(config.table);
  const aliasName = quoteIdentifier(relation.alias);

  if (config.type === 'hasMany') {
    return `COALESCE((SELECT json_agg(${rowAlias}) FROM (SELECT ${columns} FROM ${relationTable} AS ${relationAlias} WHERE ${relationAlias}.${quoteIdentifier(config.foreignKey)} = ${sourceAlias}.${quoteIdentifier(config.localKey)}) AS ${rowAlias}), '[]'::json) AS ${aliasName}`;
  }

  return `(SELECT row_to_json(${rowAlias}) FROM (SELECT ${columns} FROM ${relationTable} AS ${relationAlias} WHERE ${relationAlias}.${quoteIdentifier(config.foreignKey)} = ${sourceAlias}.${quoteIdentifier(config.localKey)} LIMIT 1) AS ${rowAlias}) AS ${aliasName}`;
};

const buildSelectList = (sourceTable, select, sourceAlias = 't') => {
  const parsed = parseSelect(select);
  const expressions = [];

  if (parsed.includeAllBaseColumns) {
    expressions.push(`${sourceAlias}.*`);
  } else {
    for (const column of parsed.baseColumns) {
      expressions.push(`${sourceAlias}.${quoteIdentifier(column)} AS ${quoteIdentifier(column)}`);
    }
  }

  parsed.relations.forEach((relation, index) => {
    expressions.push(buildRelationExpression(sourceTable, relation, index, sourceAlias));
  });

  return expressions.length ? expressions.join(', ') : `${sourceAlias}.*`;
};

const normalizeError = (error) => {
  if (!error) return null;

  return {
    code: error.code,
    details: error.detail,
    hint: error.hint,
    message: error.message || String(error),
  };
};

const normalizeLiteral = (value) => {
  if (value === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;

  return value;
};

class PostgresQueryBuilder {
  constructor(tableName) {
    this.tableName = tableName;
    this.operation = 'select';
    this.filters = [];
    this.orders = [];
    this.limitValue = null;
    this.offsetValue = null;
    this.payload = null;
    this.returnSelect = '*';
    this.returningRequested = false;
    this.selectOptions = {};
    this.singleMode = false;
    this.maybeSingleMode = false;
    this.upsertOptions = {};
  }

  select(columns = '*', options = {}) {
    if (this.operation && this.operation !== 'select') {
      this.returningRequested = true;
    }

    this.returnSelect = columns || '*';
    this.selectOptions = options || {};

    if (!this.operation || this.operation === 'select') {
      this.operation = 'select';
    }

    return this;
  }

  insert(payload) {
    this.operation = 'insert';
    this.payload = payload;
    return this;
  }

  update(payload) {
    this.operation = 'update';
    this.payload = payload || {};
    return this;
  }

  delete() {
    this.operation = 'delete';
    return this;
  }

  upsert(payload, options = {}) {
    this.operation = 'upsert';
    this.payload = payload;
    this.upsertOptions = options || {};
    return this;
  }

  eq(column, value) {
    this.filters.push({ column, operator: 'eq', value });
    return this;
  }

  neq(column, value) {
    this.filters.push({ column, operator: 'neq', value });
    return this;
  }

  gt(column, value) {
    this.filters.push({ column, operator: 'gt', value });
    return this;
  }

  gte(column, value) {
    this.filters.push({ column, operator: 'gte', value });
    return this;
  }

  lt(column, value) {
    this.filters.push({ column, operator: 'lt', value });
    return this;
  }

  lte(column, value) {
    this.filters.push({ column, operator: 'lte', value });
    return this;
  }

  in(column, value) {
    this.filters.push({ column, operator: 'in', value: Array.isArray(value) ? value : [] });
    return this;
  }

  is(column, value) {
    this.filters.push({ column, operator: 'is', value });
    return this;
  }

  ilike(column, value) {
    this.filters.push({ column, operator: 'ilike', value });
    return this;
  }

  like(column, value) {
    this.filters.push({ column, operator: 'like', value });
    return this;
  }

  or(expression) {
    this.filters.push({
      operator: 'or',
      filters: splitTopLevel(expression).map((part) => {
        const [column, op, ...rest] = String(part).split('.');
        return {
          column,
          operator: op,
          value: normalizeLiteral(rest.join('.')),
        };
      }),
    });
    return this;
  }

  order(column, options = {}) {
    this.orders.push({
      ascending: options.ascending !== false,
      column,
      nullsFirst: options.nullsFirst,
    });
    return this;
  }

  limit(value) {
    this.limitValue = Number(value);
    return this;
  }

  range(from, to) {
    const start = Number(from);
    const end = Number(to);
    this.offsetValue = Number.isFinite(start) ? start : 0;
    this.limitValue = Number.isFinite(end) && Number.isFinite(start)
      ? Math.max(0, end - start + 1)
      : null;
    return this;
  }

  single() {
    this.singleMode = true;
    return this;
  }

  maybeSingle() {
    this.maybeSingleMode = true;
    return this;
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }

  catch(reject) {
    return this.execute().catch(reject);
  }

  finally(callback) {
    return this.execute().finally(callback);
  }

  _addParam(params, value) {
    params.push(value);
    return `$${params.length}`;
  }

  _conditionSql(filter, params, sourceAlias = null) {
    if (filter.operator === 'or') {
      const parts = filter.filters.map((item) => this._conditionSql(item, params, sourceAlias));
      return `(${parts.join(' OR ')})`;
    }

    const column = `${sourceAlias ? `${sourceAlias}.` : ''}${quoteIdentifier(filter.column)}`;

    if (filter.operator === 'eq') {
      if (filter.value === null) return `${column} IS NULL`;
      return `${column} = ${this._addParam(params, filter.value)}`;
    }

    if (filter.operator === 'neq') {
      if (filter.value === null) return `${column} IS NOT NULL`;
      return `${column} <> ${this._addParam(params, filter.value)}`;
    }

    if (filter.operator === 'gt') return `${column} > ${this._addParam(params, filter.value)}`;
    if (filter.operator === 'gte') return `${column} >= ${this._addParam(params, filter.value)}`;
    if (filter.operator === 'lt') return `${column} < ${this._addParam(params, filter.value)}`;
    if (filter.operator === 'lte') return `${column} <= ${this._addParam(params, filter.value)}`;
    if (filter.operator === 'like') return `${column} LIKE ${this._addParam(params, filter.value)}`;
    if (filter.operator === 'ilike') return `${column} ILIKE ${this._addParam(params, filter.value)}`;

    if (filter.operator === 'is') {
      if (filter.value === null) return `${column} IS NULL`;
      if (filter.value === true) return `${column} IS TRUE`;
      if (filter.value === false) return `${column} IS FALSE`;
      return `${column} IS ${String(filter.value).toUpperCase()}`;
    }

    if (filter.operator === 'in') {
      if (!filter.value.length) return 'FALSE';
      const placeholders = filter.value.map((item) => this._addParam(params, item));
      return `${column} IN (${placeholders.join(', ')})`;
    }

    throw new Error(`Unsupported filter operator: ${filter.operator}`);
  }

  _whereSql(params, sourceAlias = null) {
    if (!this.filters.length) return '';

    const parts = this.filters.map((filter) => this._conditionSql(filter, params, sourceAlias));
    return `WHERE ${parts.join(' AND ')}`;
  }

  _orderSql(sourceAlias = 't') {
    if (!this.orders.length) return '';

    const parts = this.orders.map((item) => {
      const nulls = item.nullsFirst === undefined
        ? ''
        : item.nullsFirst
          ? ' NULLS FIRST'
          : ' NULLS LAST';

      return `${sourceAlias}.${quoteIdentifier(item.column)} ${item.ascending ? 'ASC' : 'DESC'}${nulls}`;
    });

    return `ORDER BY ${parts.join(', ')}`;
  }

  _limitSql(params) {
    const parts = [];

    if (Number.isFinite(this.limitValue)) {
      parts.push(`LIMIT ${this._addParam(params, this.limitValue)}`);
    }

    if (Number.isFinite(this.offsetValue)) {
      parts.push(`OFFSET ${this._addParam(params, this.offsetValue)}`);
    }

    return parts.join(' ');
  }

  _rowsFromPayload() {
    if (Array.isArray(this.payload)) return this.payload;
    if (this.payload && typeof this.payload === 'object') return [this.payload];
    return [];
  }

  _insertSql(params, { upsert = false } = {}) {
    const rows = this._rowsFromPayload();
    if (!rows.length) {
      throw new Error('Insert payload must be an object or a non-empty array');
    }

    const columns = Array.from(
      new Set(rows.flatMap((row) => Object.keys(row).filter((key) => row[key] !== undefined)))
    );

    if (!columns.length) {
      throw new Error('Insert payload does not contain any columns');
    }

    const valuesSql = rows.map((row) => {
      const values = columns.map((column) => (
        row[column] === undefined ? 'DEFAULT' : this._addParam(params, row[column])
      ));
      return `(${values.join(', ')})`;
    });

    let sql = `INSERT INTO ${quoteIdentifier(this.tableName)} (${columns.map(quoteIdentifier).join(', ')}) VALUES ${valuesSql.join(', ')}`;

    if (upsert) {
      const conflictColumns = String(this.upsertOptions.onConflict || 'id')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);

      if (!conflictColumns.length) {
        throw new Error('upsert requires onConflict columns');
      }

      const conflictSql = conflictColumns.map(quoteIdentifier).join(', ');
      const updateColumns = columns.filter((column) => !conflictColumns.includes(column));

      if (updateColumns.length) {
        sql += ` ON CONFLICT (${conflictSql}) DO UPDATE SET ${updateColumns
          .map((column) => `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`)
          .join(', ')}`;
      } else {
        sql += ` ON CONFLICT (${conflictSql}) DO NOTHING`;
      }
    }

    return sql;
  }

  _returningSelectSql(params, mutationSql, outerFilters = false) {
    const sourceAlias = 't';
    const selectList = buildSelectList(this.tableName, this.returnSelect, sourceAlias);
    const whereSql = outerFilters ? this._whereSql(params, sourceAlias) : '';
    const orderSql = this._orderSql(sourceAlias);
    const limitSql = this._limitSql(params);

    return `WITH changed AS (${mutationSql} RETURNING *) SELECT ${selectList} FROM changed AS ${sourceAlias} ${whereSql} ${orderSql} ${limitSql}`;
  }

  _buildSelectQuery() {
    const params = [];
    const sourceAlias = 't';
    const selectList = buildSelectList(this.tableName, this.returnSelect, sourceAlias);
    const whereSql = this._whereSql(params, sourceAlias);
    const orderSql = this._orderSql(sourceAlias);
    const limitSql = this._limitSql(params);
    const sql = `SELECT ${selectList} FROM ${quoteIdentifier(this.tableName)} AS ${sourceAlias} ${whereSql} ${orderSql} ${limitSql}`;

    return { params, sql };
  }

  _buildMutationQuery() {
    const params = [];
    const tableSql = quoteIdentifier(this.tableName);
    const hasReturning = this.returningRequested || this.singleMode || this.maybeSingleMode;

    if (this.operation === 'insert') {
      const insertSql = this._insertSql(params);
      return {
        params,
        sql: this._returningSelectSql(params, insertSql),
      };
    }

    if (this.operation === 'upsert') {
      const upsertSql = this._insertSql(params, { upsert: true });
      return {
        params,
        sql: this._returningSelectSql(params, upsertSql, true),
      };
    }

    if (this.operation === 'update') {
      const keys = Object.keys(this.payload || {}).filter((key) => this.payload[key] !== undefined);
      if (!keys.length) throw new Error('Update payload does not contain any columns');

      const setSql = keys
        .map((key) => `${quoteIdentifier(key)} = ${this._addParam(params, this.payload[key])}`)
        .join(', ');
      const whereSql = this._whereSql(params);
      const mutationSql = `UPDATE ${tableSql} SET ${setSql} ${whereSql}`;

      if (!hasReturning) return { params, sql: mutationSql };
      return { params, sql: this._returningSelectSql(params, mutationSql) };
    }

    if (this.operation === 'delete') {
      const whereSql = this._whereSql(params);
      const mutationSql = `DELETE FROM ${tableSql} ${whereSql}`;

      if (!hasReturning) return { params, sql: mutationSql };
      return { params, sql: this._returningSelectSql(params, mutationSql) };
    }

    throw new Error(`Unsupported operation: ${this.operation}`);
  }

  _countQuery() {
    const params = [];
    const whereSql = this._whereSql(params, 't');

    return {
      params,
      sql: `SELECT COUNT(*)::int AS count FROM ${quoteIdentifier(this.tableName)} AS t ${whereSql}`,
    };
  }

  _formatRows(rows) {
    if (this.singleMode || this.maybeSingleMode) {
      if (!rows.length) return { data: null, error: null };
      if (rows.length > 1) {
        return {
          data: null,
          error: {
            message: 'Expected a single row, but the query returned multiple rows',
          },
        };
      }

      return { data: rows[0], error: null };
    }

    return { data: rows, error: null };
  }

  async execute() {
    try {
      const isSelect = this.operation === 'select';
      const { sql, params } = isSelect ? this._buildSelectQuery() : this._buildMutationQuery();
      const countQuery = isSelect && this.selectOptions.count === 'exact'
        ? this._countQuery()
        : null;
      const [result, countResult] = await Promise.all([
        pool.query(sql, params),
        countQuery ? pool.query(countQuery.sql, countQuery.params) : Promise.resolve(null),
      ]);

      const formatted = this._formatRows(result.rows || []);
      return {
        count: countResult ? countResult.rows[0]?.count ?? 0 : null,
        data: formatted.data,
        error: formatted.error,
      };
    } catch (error) {
      return {
        count: null,
        data: this.singleMode || this.maybeSingleMode ? null : [],
        error: normalizeError(error),
      };
    }
  }
}

const db = {
  from(tableName) {
    return new PostgresQueryBuilder(tableName);
  },

  async query(sql, params = []) {
    return pool.query(sql, params);
  },
};

module.exports = {
  db,
  pool,
  postgres: db,
  query: (sql, params = []) => pool.query(sql, params),
};
