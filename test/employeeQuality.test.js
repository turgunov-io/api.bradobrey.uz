const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');

process.env.PGDATABASE ||= 'employee-quality-contract-tests';
process.env.PGHOST ||= '127.0.0.1';
process.env.PGUSER ||= 'employee-quality-contract-tests';

const {
  EMPLOYEE_FAILURE_REASONS,
  classifyCompletedOrder,
  normalizeEmployeeMetrics,
  rankEmployees,
} = require('../src/services/employeeQuality');
const {
  QUALITY_REVIEW_PERMISSION,
  authenticateStatistics,
  canReviewQuality,
  effectivePermissions,
  parseDateRange,
  resolveAuthorizedScope,
} = require('../src/utils/employeeQualityAccess');
const { db, pool } = require('../src/config/postgres');
const employeeQualityModel = require('../src/models/employeeQuality');
const notificationsModel = require('../src/models/notifications');

const baseRow = (overrides = {}) => ({
  id: overrides.id || '00000000-0000-4000-8000-000000000001',
  name: overrides.name || 'Employee',
  branch_id: '00000000-0000-4000-8000-000000000010',
  is_active: true,
  is_archived: false,
  completed: 10,
  classifiable_completed: 10,
  suspicious_count: 0,
  authoritative_completed: 10,
  live_snapshot_count: 10,
  backfill_current_catalog_count: 0,
  unclassified_count: 0,
  employee_failure_count: 0,
  revenue: 0,
  ...overrides,
});

test('classifier uses strict 50 percent boundary and rejects incomplete or reversed evidence', () => {
  const startedAt = '2026-10-04T10:00:00.000Z';
  assert.equal(classifyCompletedOrder({
    employeeId: 'employee', expectedMinutes: 60, startedAt, finishedAt: '2026-10-04T10:29:00.000Z',
  }).suspicious, true);
  assert.equal(classifyCompletedOrder({
    employeeId: 'employee', expectedMinutes: 60, startedAt, finishedAt: '2026-10-04T10:30:00.000Z',
  }).suspicious, false);
  assert.equal(classifyCompletedOrder({
    employeeId: 'employee', expectedMinutes: 60, startedAt: null, finishedAt: '2026-10-04T10:30:00.000Z',
  }).unclassified_reason, 'missing_started_at');
  assert.equal(classifyCompletedOrder({
    employeeId: 'employee', expectedMinutes: 60, startedAt, finishedAt: '2026-10-04T09:59:00.000Z',
  }).unclassified_reason, 'finished_before_started');
});

test('ranking is quality-first and revenue never changes rank', () => {
  const rows = [
    baseRow({ id: 'a', name: 'A', revenue: 1 }),
    baseRow({ id: 'b', name: 'B', completed: 20, classifiable_completed: 20,
      authoritative_completed: 20, live_snapshot_count: 20, suspicious_count: 1, revenue: 999999 }),
  ];
  const result = rankEmployees(rows);
  assert.equal(result[0].employee.id, 'a');
  assert.equal(result[0].rank, 1);
  assert.equal(result[1].rank, 2);

  rows[0].revenue = 999999999;
  rows[1].revenue = 0;
  assert.deepEqual(rankEmployees(rows).map((item) => item.employee.id), ['a', 'b']);
});

test('same suspicious count compares exact rates before trusted volume', () => {
  const result = rankEmployees([
    baseRow({ id: 'one-of-20', name: 'B', completed: 20, classifiable_completed: 20,
      authoritative_completed: 20, live_snapshot_count: 20, suspicious_count: 1 }),
    baseRow({ id: 'one-of-100', name: 'A', completed: 100, classifiable_completed: 100,
      authoritative_completed: 100, live_snapshot_count: 100, suspicious_count: 1 }),
  ]);
  assert.deepEqual(result.map((item) => item.employee.id), ['one-of-100', 'one-of-20']);
});

test('statistical ties share competition rank and neutral outcomes do not affect keys', () => {
  const result = rankEmployees([
    baseRow({ id: 'a', name: 'A', no_show_count: 100, neutral_cancelled_count: 100 }),
    baseRow({ id: 'b', name: 'B', not_in_time_count: 100 }),
    baseRow({ id: 'c', name: 'C', suspicious_count: 1 }),
  ]);
  assert.deepEqual(result.map((item) => item.rank), [1, 1, 3]);
});

test('eligibility requires sample, coverage, employment record, and authoritative live evidence', () => {
  assert.equal(normalizeEmployeeMetrics(baseRow({ completed: 9, classifiable_completed: 9,
    authoritative_completed: 9 })).provisional_reason, 'insufficient_classifiable_completed');
  assert.equal(normalizeEmployeeMetrics(baseRow({ completed: 10, classifiable_completed: 9,
    authoritative_completed: 10 })).provisional_reason, 'insufficient_classifiable_completed');
  assert.equal(normalizeEmployeeMetrics(baseRow({ completed: 20, classifiable_completed: 17,
    authoritative_completed: 20 })).provisional_reason, 'insufficient_classification_coverage');
  assert.equal(normalizeEmployeeMetrics(baseRow({ authoritative_completed: 9,
    live_snapshot_count: 9, backfill_current_catalog_count: 1, data_confidence: 'approximate' })).provisional_reason,
  'approximate_data');
  assert.equal(normalizeEmployeeMetrics(baseRow({ completed: 0, classifiable_completed: 0,
    authoritative_completed: 0, live_snapshot_count: 0 })).provisional_reason, 'no_completed_orders');
  const onBreak = normalizeEmployeeMetrics(baseRow({ is_active: false }));
  assert.equal(onBreak.eligible, true);
  assert.equal(onBreak.provisional_reason, null);
  assert.equal(normalizeEmployeeMetrics(baseRow({ is_archived: true })).provisional_reason, 'employee_archived');
});

test('admin roles receive the full preset when no per-user permissions are provisioned', () => {
  assert.equal(effectivePermissions('admin', []).has('statistics.read.global'), true);
  assert.equal(effectivePermissions('admin_network', []).has('history.read.branch'), true);
  assert.equal(effectivePermissions('admin', [{ permission: 'statistics.read.branch' }]).size, 1);

  assert.equal(effectivePermissions('manager', []).size, 0);
  const user = {
    id: '00000000-0000-4000-8000-000000000001',
    branch_id: '00000000-0000-4000-8000-00000000000a',
  };
  assert.equal(resolveAuthorizedScope({
    permissions: new Set(), query: { scope: 'global' }, role: 'admin_network', user,
  }).status, 403);
  assert.equal(resolveAuthorizedScope({
    permissions: new Set(['statistics.read.branch']),
    query: { scope: 'branch', branch_id: '00000000-0000-4000-8000-00000000000b' }, role: 'manager', user,
  }).status, 403);
  assert.equal(resolveAuthorizedScope({
    permissions: new Set(['statistics.read.self']),
    query: { scope: 'self', employee_id: 'someone-else' }, role: 'barber', user,
  }).employeeId, user.id);
});

test('quality review requires the dedicated permission and a manager scope', () => {
  const base = { role: 'manager', scope: { type: 'branch' }, permissions: new Set() };
  assert.equal(canReviewQuality(base), false);
  assert.equal(canReviewQuality({ ...base, permissions: new Set([QUALITY_REVIEW_PERMISSION]) }), true);
  assert.equal(canReviewQuality({
    role: 'barber', scope: { type: 'self' }, permissions: new Set([QUALITY_REVIEW_PERMISSION]),
  }), false);
});

test('statistics authentication denies anonymous/empty permissions and trusts DB branch over JWT claims', async () => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'employee-quality-auth-test';
  const originalQuery = pool.query;
  const branchA = '00000000-0000-4000-8000-00000000000a';
  const branchB = '00000000-0000-4000-8000-00000000000b';
  const userId = '00000000-0000-4000-8000-000000000001';
  const response = () => ({
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  });
  try {
    const anonymous = response();
    assert.equal(await authenticateStatistics({ headers: {}, query: {} }, anonymous), null);
    assert.equal(anonymous.statusCode, 401);

    let permissionRows = [];
    pool.query = async (sql) => {
      if (/from users/i.test(sql)) return { rows: [{ id: userId, role: 'manager', branch_id: branchA }] };
      if (/from user_permissions/i.test(sql)) return { rows: permissionRows };
      throw new Error(`Unexpected query: ${sql}`);
    };
    const token = jwt.sign({ sub: userId, role: 'manager', branch_id: branchB }, process.env.JWT_SECRET);
    const headers = { authorization: `Bearer ${token}` };

    const empty = response();
    assert.equal(await authenticateStatistics({ headers, query: { scope: 'branch', branch_id: branchA } }, empty), null);
    assert.equal(empty.statusCode, 403);

    permissionRows = [{ permission: 'statistics.read.branch' }];
    const forged = response();
    assert.equal(await authenticateStatistics({ headers, query: { scope: 'branch', branch_id: branchB } }, forged), null);
    assert.equal(forged.statusCode, 403);

    const allowed = response();
    const access = await authenticateStatistics({
      headers,
      query: { scope: 'branch', branch_id: branchA, start_date: '2026-10-01', end_date: '2026-10-04' },
    }, allowed);
    assert.equal(allowed.statusCode, 200);
    assert.equal(access.scope.branchId, branchA);
  } finally {
    pool.query = originalQuery;
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
});

test('calendar ranges are Tashkent half-open intervals with a 366-day ceiling', () => {
  assert.deepEqual(parseDateRange({ start_date: '2026-10-01', end_date: '2026-10-04' }), {
    startDate: '2026-10-01',
    startInclusive: '2026-10-01T00:00:00+05:00',
    endDate: '2026-10-04',
    endExclusive: '2026-10-05T00:00:00+05:00',
  });
  assert.match(parseDateRange({ start_date: '2026-10-05', end_date: '2026-10-04' }).error, /earlier/);
  assert.match(parseDateRange({ start_date: '2025-01-01', end_date: '2026-10-04' }).error, /366/);
});

test('employee quality pagination uses stable numeric cursors and bounded limits', () => {
  const { parsePagination } = employeeQualityModel._private;
  assert.deepEqual(parsePagination({}), { cursor: null, limit: null, offset: 0 });
  assert.deepEqual(parsePagination({ cursor: '200' }), { cursor: '200', limit: 200, offset: 200 });
  assert.deepEqual(parsePagination({ cursor: '50', limit: '25' }), { cursor: '50', limit: 25, offset: 50 });
  assert.match(parsePagination({ cursor: 'not-a-cursor' }).error, /cursor/);
  assert.match(parsePagination({ limit: 201 }).error, /limit/);
});

test('partial employee quality migrations fail closed as unavailable schema', () => {
  const { isMissingQualitySchema } = employeeQualityModel._private;
  assert.equal(isMissingQualitySchema({ code: '42P01', message: 'relation "queue_quality_assessments" does not exist' }), true);
  assert.equal(isMissingQualitySchema({ code: '42703', message: 'column e.actor_type does not exist' }), true);
  assert.equal(isMissingQualitySchema({ code: '42703', message: 'column b.name does not exist' }), true);
  assert.equal(isMissingQualitySchema({ code: '23505', message: 'duplicate key value violates unique constraint' }), false);
});

test('quality review idempotency binds the canonical comment as well as state and version', () => {
  const { reviewReplayMatches } = employeeQualityModel._private;
  const replay = {
    employee_id: 'employee-1',
    requested_review_state: 'confirmed',
    review_comment: 'Reviewed evidence',
    expected_version: 0,
  };
  const request = {
    employeeId: 'employee-1',
    reviewState: 'confirmed',
    reviewComment: 'Reviewed evidence',
    expectedVersion: 0,
  };
  assert.equal(reviewReplayMatches(replay, request), true);
  assert.equal(reviewReplayMatches(replay, { ...request, reviewComment: 'Changed explanation' }), false);
});

test('persisted notification assessment maps canonical duration columns', () => {
  const { normalizePersistedQualityAssessment } = notificationsModel._private;
  const normalized = normalizePersistedQualityAssessment({
    actual_duration_minutes: 12.5,
    expected_duration_minutes: 30,
    suspicious: true,
  });
  assert.equal(normalized.actual_minutes, 12.5);
  assert.equal(normalized.expected_minutes, 30);
  assert.equal(normalized.suspicious, true);
  assert.equal(Number.isFinite(normalized.actual_minutes), true);
});

test('suspicious notification renders persisted actual_duration_minutes instead of catalog recomputation', async () => {
  const originalFrom = db.from;
  const originalQuery = db.query;
  const responses = {
    queue_quality_assessments: [{
      data: {
        queue_entry_id: 'order-1',
        service_ids: ['service-1'],
        expected_duration_minutes: 30,
        actual_duration_minutes: 12.5,
        classifiable: true,
        suspicious: true,
        rule_version: 'employee-quality-v1',
        assessment_source: 'live_snapshot',
        data_confidence: 'authoritative',
        review_state: 'unreviewed',
      },
      error: null,
    }],
    services: [{ data: [{ id: 'service-1', name: 'Haircut', duration_minutes: 999 }], error: null }],
    barbers: [{ data: { name: 'Barber' }, error: null }],
    branches: [{ data: { name: 'Branch' }, error: null }],
    users: [{ data: [{ id: 'manager-1', role: 'manager', branch_id: 'branch-1' }], error: null }],
  };
  const inserts = [];
  const builder = (response) => ({
    select() { return this; },
    eq() { return this; },
    in() { return this; },
    maybeSingle() { return this; },
    then(resolve, reject) { return Promise.resolve(response).then(resolve, reject); },
  });
  db.from = (table) => builder(responses[table].shift());
  db.query = async (sql, params) => {
    inserts.push({ sql, params });
    return { rows: [] };
  };

  try {
    await notificationsModel.createSuspiciousOrderNotifications({
      id: 'order-1',
      status: 'completed',
      branch_id: 'branch-1',
      barber_id: 'barber-1',
      service_ids: ['service-1'],
      started_at: '2026-10-04T10:00:00Z',
      finished_at: '2026-10-04T10:01:00Z',
      client: { name: 'Client' },
    });
    assert.equal(inserts.length, 1);
    assert.match(inserts[0].params[3], /13 мин\. из 30 мин/);
    const data = JSON.parse(inserts[0].params[6]);
    assert.equal(data.actual_minutes, 12.5);
    assert.equal(data.expected_minutes, 30);
    assert.equal(data.quality_data_confidence, 'authoritative');
  } finally {
    db.from = originalFrom;
    db.query = originalQuery;
  }
});

test('migration contract uses exact v1 reasons, atomic snapshots, and approximate legacy evidence', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'postgres', 'employee_quality_ranking.sql'), 'utf8');
  for (const reason of EMPLOYEE_FAILURE_REASONS) assert.match(sql, new RegExp(reason));
  assert.deepEqual([...EMPLOYEE_FAILURE_REASONS].sort(), [
    'employee_cancelled_after_start',
    'employee_refused',
    'employee_schedule_conflict',
    'employee_unavailable',
  ]);
  assert.equal(EMPLOYEE_FAILURE_REASONS.has('employee_cancelled'), false);
  assert.match(sql, /after update of status on queue_entries[\s\S]*capture_queue_quality_assessment/i);
  assert.match(sql, /queue_quality_plan_snapshots/i);
  assert.match(sql, /'backfill_current_catalog'[\s\S]*'approximate'/i);
  const accessSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'employeeQualityAccess.js'), 'utf8');
  assert.match(accessSource, /statistics\.quality\.review/i);
  assert.doesNotMatch(sql, /coalesce\(q\.finished_at,\s*q\.created_at\)/i);
  assert.doesNotMatch(sql, /on delete\s+(cascade|set null)/i);
  assert.doesNotMatch(sql, /insert\s+into\s+user_permissions/i);
  assert.doesNotMatch(sql, /create\s+trigger\s+users_seed_employee_quality_permissions/i);
  assert.match(sql, /queue_quality_review_events_append_only/i);
  assert.match(sql, /queue_quality_plan_snapshots_append_only/i);
  assert.match(sql, /queue_quality_assessments_evidence_immutable/i);
  assert.match(sql, /new\.id is distinct from old\.id/i);
  assert.match(sql, /new\.created_at is distinct from old\.created_at/i);
  assert.match(sql, /quality review projection requires a matching constrained review event/i);
  assert.match(sql, /barbers_quality_audit_delete_guard/i);
  assert.match(sql, /queue_status_events_employee_occurred_idx/i);
  assert.match(sql, /queue_status_events_global_occurred_idx/i);
  assert.match(sql, /new\.status is distinct from 'completed'/i);
  assert.match(sql, /old\.status is not distinct from 'completed'/i);
  assert.match(sql, /where q\.status = 'completed'\s+and q\.finished_at is not null/i);
  assert.doesNotMatch(sql, /coalesce\(q\.finished_at,\s*terminal_event\.occurred_at\)/i);
  assert.match(sql, /payments_queue_entry_id_idx/i);
  const model = fs.readFileSync(path.join(__dirname, '..', 'src', 'models', 'employeeQuality.js'), 'utf8');
  assert.match(model, /a\.branch_id = \$4::uuid/);
  assert.match(model, /e\.branch_id = \$5::uuid/);
  assert.match(model, /employee_id: access\.scope\.employeeId \|\| null/);
  assert.match(model, /next_cursor:/);
  assert.match(model, /e\.actor_type = 'unknown'/);
  const statisticsModel = fs.readFileSync(path.join(__dirname, '..', 'src', 'models', 'statistics.js'), 'utf8');
  assert.match(statisticsModel, /from\('queue_quality_assessments'\)/);
  assert.match(statisticsModel, /runtime_fallback_current_catalog/);
  const notificationsModel = fs.readFileSync(path.join(__dirname, '..', 'src', 'models', 'notifications.js'), 'utf8');
  assert.match(notificationsModel, /from\('queue_quality_assessments'\)/);
  assert.match(notificationsModel, /runtime_fallback_current_catalog/);
});

test('login and session responses expose authoritative database permissions', () => {
  const barbersModel = fs.readFileSync(path.join(__dirname, '..', 'src', 'models', 'barbers.js'), 'utf8');
  assert.match(barbersModel, /const loginPermissions = \(await fetchPermissionsByUserIds\(\[userData\.id\]\)\)/);
  assert.match(barbersModel, /permissions: loginPermissions/);
  assert.match(barbersModel, /const adminPermissions = \(await fetchPermissionsByUserIds\(\[adminUser\.id\]\)\)/);
  assert.match(barbersModel, /permissions: adminPermissions/);
  assert.match(barbersModel, /return res\.json\(\{ user: \{ \.\.\.user, permissions \}, barber \}\)/);
});

test('existing employee quality permissions are provisioned once without defeating later revocation', () => {
  const sql = fs.readFileSync(path.join(
    __dirname,
    '..',
    'db',
    'postgres',
    'employee_quality_permissions_backfill.sql',
  ), 'utf8');
  const runner = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'apply-schema.sh'), 'utf8');

  assert.match(sql, /employee_quality_permissions_v1_backfill/);
  assert.match(sql, /if not exists[\s\S]*schema_data_migrations/i);
  assert.match(sql, /statistics\.read\.global/);
  assert.match(sql, /statistics\.read\.branch/);
  assert.match(sql, /statistics\.read\.self/);
  assert.match(sql, /history\.read\.branch/);
  assert.match(sql, /history\.read\.self/);
  assert.match(sql, /statistics\.quality\.review/);
  assert.match(sql, /on conflict \(user_id, permission\) do nothing/i);
  assert.doesNotMatch(sql, /create\s+trigger/i);
  assert.match(runner, /employee_quality_ranking\.sql[\s\S]*employee_quality_permissions_backfill\.sql/);
});
