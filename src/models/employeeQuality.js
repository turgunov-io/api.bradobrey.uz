const { pool } = require('../config/postgres');
const {
  DEFAULT_RULES,
  EMPLOYEE_FAILURE_REASONS,
  FORMULA_VERSION,
  REVIEW_STATES,
  rankEmployees,
} = require('../services/employeeQuality');
const {
  authenticateStatistics,
  canReviewQuality,
} = require('../utils/employeeQualityAccess');

const TIMEZONE = 'Asia/Tashkent';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DRILLDOWN_CATEGORIES = new Set(['suspicious', 'employee_failure', 'unclassified']);

const isMissingQualitySchema = (error) => (
  String(error?.code || '') === '42P01'
  // A partially applied migration can create the quality tables while still
  // missing one of the additive columns used by the aggregate queries. Treat
  // PostgreSQL's undefined-column response as unavailable schema as well;
  // returning a generic 500 hides the actionable migration requirement.
  || String(error?.code || '') === '42703'
  || /queue_quality_(assessments|review_events)|responsible_employee_id/i.test(String(error?.message || ''))
);

const schemaMissing = (res) => res.status(501).json({
  error: 'Employee quality schema is not installed',
  hint: 'Apply db/postgres/employee_quality_ranking.sql.',
});

function appendParam(params, value) {
  params.push(value);
  return `$${params.length}`;
}

function scopePredicate(alias, access, params, { branchExpression = null, employeeExpression = null } = {}) {
  const branch = branchExpression || `${alias}.branch_id`;
  const employee = employeeExpression || `${alias}.barber_id`;
  const filters = [];
  if (access.scope.type === 'branch') filters.push(`${branch} = ${appendParam(params, access.scope.branchId)}::uuid`);
  if (access.scope.employeeId) filters.push(`${employee} = ${appendParam(params, access.scope.employeeId)}::uuid`);
  return filters.length ? filters.join(' and ') : 'true';
}

function parsePagination(query = {}, { defaultLimit = null } = {}) {
  const rawLimit = query.limit;
  let limit = rawLimit === undefined || rawLimit === null || String(rawLimit).trim() === ''
    ? defaultLimit
    : Number(rawLimit);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
    return { error: 'limit must be an integer from 1 to 200' };
  }
  const rawCursor = String(query.cursor || '').trim();
  if (rawCursor && !/^\d{1,9}$/.test(rawCursor)) {
    return { error: 'cursor is invalid' };
  }
  if (rawCursor && limit === null) limit = 200;
  return { cursor: rawCursor || null, limit, offset: rawCursor ? Number(rawCursor) : 0 };
}

function reviewReplayMatches(replay, { employeeId, reviewState, reviewComment, expectedVersion }) {
  return String(replay?.employee_id || '') === String(employeeId)
    && replay?.requested_review_state === reviewState
    && replay?.review_comment === reviewComment
    && Number(replay?.expected_version) === expectedVersion;
}

async function loadEmployeeRows(access) {
  const branchId = access.scope.type === 'branch' ? access.scope.branchId : null;
  const employeeId = access.scope.employeeId || null;
  const params = [access.range.startInclusive, access.range.endExclusive, branchId, employeeId];

  const result = await pool.query(
    `select
       b.id,
       b.name,
       case when $3::uuid is not null then $3::uuid else b.branch_id end as branch_id,
       coalesce(b.is_archived, false) as is_archived,
       count(a.queue_entry_id)::int as completed,
       count(a.queue_entry_id) filter (where a.classifiable)::int as classifiable_completed,
       count(a.queue_entry_id) filter (
         where a.classifiable and a.suspicious and a.review_state in ('unreviewed', 'confirmed')
       )::int as suspicious_count,
       count(a.queue_entry_id) filter (
         where a.assessment_source = 'live_snapshot' and a.data_confidence = 'authoritative'
       )::int as authoritative_completed,
       count(a.queue_entry_id) filter (
         where a.classifiable and a.assessment_source = 'live_snapshot'
       )::int as live_snapshot_count,
       count(a.queue_entry_id) filter (
         where a.classifiable and a.assessment_source = 'backfill_current_catalog'
       )::int
         as backfill_current_catalog_count,
       count(a.queue_entry_id) filter (where not a.classifiable)::int as unclassified_count,
       case
         when count(a.queue_entry_id) filter (where a.assessment_source = 'live_snapshot') > 0
          and count(a.queue_entry_id) filter (where a.assessment_source = 'backfill_current_catalog') > 0
           then 'mixed'
         when count(a.queue_entry_id) filter (where a.assessment_source = 'backfill_current_catalog') > 0
           then 'backfill_current_catalog'
         when count(a.queue_entry_id) filter (where a.assessment_source = 'live_snapshot') > 0
           then 'live_snapshot'
         else null
       end as assessment_source,
       case
         when count(a.queue_entry_id) filter (where a.data_confidence = 'authoritative') > 0
          and count(a.queue_entry_id) filter (where a.data_confidence = 'approximate') > 0
           then 'mixed'
         when count(a.queue_entry_id) filter (where a.data_confidence = 'approximate') > 0
           then 'approximate'
         when count(a.queue_entry_id) filter (where a.data_confidence = 'authoritative') > 0
           then 'authoritative'
         else 'insufficient'
       end as data_confidence,
       coalesce(sum(payment.total_amount), 0)::numeric as revenue
     from barbers b
     left join queue_quality_assessments a
       on a.employee_id = b.id
      and a.completed_at >= $1::timestamptz
      and a.completed_at < $2::timestamptz
      and a.rule_version = '${FORMULA_VERSION}'
      and a.employee_role in ('barber', 'super-barber')
      and ($3::uuid is null or a.branch_id = $3::uuid)
     left join queue_entries q on q.id = a.queue_entry_id
     left join lateral (
       select coalesce(sum(p.amount), 0)::numeric as total_amount
       from payments p
       where p.queue_entry_id = q.id
     ) payment on true
     left join users current_user_record on current_user_record.id = b.id
     where ($4::uuid is null or b.id = $4::uuid)
       and (
         current_user_record.role in ('barber', 'super-barber')
         or exists (
           select 1 from queue_quality_assessments historical_role
            where historical_role.employee_id = b.id
              and historical_role.employee_role in ('barber', 'super-barber')
              and historical_role.completed_at >= $1::timestamptz
              and historical_role.completed_at < $2::timestamptz
         )
       )
       and (
         $3::uuid is null
         or b.branch_id = $3::uuid
         or exists (
           select 1 from queue_quality_assessments historical
            where historical.employee_id = b.id
              and historical.branch_id = $3::uuid
              and historical.completed_at >= $1::timestamptz
              and historical.completed_at < $2::timestamptz
         )
         or exists (
           select 1 from queue_status_events event
            where coalesce(event.responsible_employee_id, event.barber_id) = b.id
              and event.branch_id = $3::uuid
              and event.occurred_at >= $1::timestamptz
              and event.occurred_at < $2::timestamptz
         )
       )
     group by b.id, b.name, b.branch_id, b.is_archived
     order by b.name, b.id`,
    params,
  );
  return result.rows || [];
}

async function loadFailureCounts(access) {
  const params = [];
  const scope = scopePredicate('e', access, params, {
    branchExpression: 'e.branch_id',
    employeeExpression: 'e.responsible_employee_id',
  });
  const start = appendParam(params, access.range.startInclusive);
  const end = appendParam(params, access.range.endExclusive);
  const reasons = appendParam(params, [...EMPLOYEE_FAILURE_REASONS]);
  const result = await pool.query(
    `select e.responsible_employee_id as employee_id, count(*)::int as employee_failure_count
       from queue_status_events e
      where e.occurred_at >= ${start}::timestamptz
        and e.occurred_at < ${end}::timestamptz
        and e.to_status in ('cancelled', 'rejected')
        and e.actor_type = 'employee'
        and e.responsible_employee_id is not null
        and e.reason_code = any(${reasons}::text[])
        and ${scope}
      group by e.responsible_employee_id`,
    params,
  );
  return new Map((result.rows || []).map((row) => [String(row.employee_id), Number(row.employee_failure_count || 0)]));
}

async function loadNeutralCounts(access) {
  const params = [];
  const scope = scopePredicate('e', access, params, {
    branchExpression: 'e.branch_id',
    employeeExpression: 'e.barber_id',
  });
  const start = appendParam(params, access.range.startInclusive);
  const end = appendParam(params, access.range.endExclusive);
  const reasons = appendParam(params, [...EMPLOYEE_FAILURE_REASONS]);
  const result = await pool.query(
    `select
       e.barber_id as employee_id,
       count(*) filter (where e.to_status = 'no_show')::int as no_show_count,
       count(*) filter (where e.to_status = 'not_in_time')::int as not_in_time_count,
       count(*) filter (
         where e.to_status = 'cancelled'
           and not (e.actor_type = 'employee'
             and e.responsible_employee_id is not null
             and e.reason_code = any(${reasons}::text[]))
       )::int as neutral_cancelled_count
      from queue_status_events e
     where e.occurred_at >= ${start}::timestamptz
       and e.occurred_at < ${end}::timestamptz
       and e.to_status in ('no_show', 'not_in_time', 'cancelled')
       and e.barber_id is not null
       and ${scope}
     group by e.barber_id`,
    params,
  );
  return new Map((result.rows || []).map((row) => [String(row.employee_id), row]));
}

async function loadDataQuality(access) {
  const branchId = access.scope.type === 'branch' ? access.scope.branchId : null;
  const employeeId = access.scope.employeeId || null;
  const params = [access.range.startInclusive, access.range.endExclusive, branchId, employeeId, [...EMPLOYEE_FAILURE_REASONS]];
  const result = await pool.query(
    `select
       (select count(*)::int from queue_quality_assessments a
         where a.completed_at >= $1::timestamptz and a.completed_at < $2::timestamptz
           and ($3::uuid is null or a.branch_id = $3::uuid)
           and ($4::uuid is null or a.employee_id = $4::uuid)
           and a.employee_id is null) as unassigned_orders,
       (select count(*)::int from queue_quality_assessments a
         where a.completed_at >= $1::timestamptz and a.completed_at < $2::timestamptz
           and ($3::uuid is null or a.branch_id = $3::uuid)
           and ($4::uuid is null or a.employee_id = $4::uuid)
           and not a.classifiable) as unclassifiable_completed,
       (select count(*)::int from queue_status_events e
         where e.occurred_at >= $1::timestamptz and e.occurred_at < $2::timestamptz
           and ($3::uuid is null or e.branch_id = $3::uuid)
           and ($4::uuid is null or coalesce(e.responsible_employee_id, e.barber_id) = $4::uuid)
            and e.to_status in ('cancelled', 'rejected')
            and e.actor_type = 'unknown'
            and (e.reason_code is null or e.reason_code = 'unknown')) as unattributed_terminal_outcomes`,
    params,
  );
  const row = result.rows[0] || {};
  return {
    unassigned_orders: Number(row.unassigned_orders || 0),
    unclassifiable_completed: Number(row.unclassifiable_completed || 0),
    unattributed_terminal_outcomes: Number(row.unattributed_terminal_outcomes || 0),
  };
}

async function assertEmployeeInScope(employeeId, access) {
  const params = [];
  let scope = 'true';
  if (access.scope.employeeId) {
    scope = `b.id = ${appendParam(params, access.scope.employeeId)}::uuid`;
  } else if (access.scope.type === 'branch') {
    const branch = appendParam(params, access.scope.branchId);
    const start = appendParam(params, access.range?.startInclusive || '1970-01-01T00:00:00Z');
    const end = appendParam(params, access.range?.endExclusive || '9999-12-31T00:00:00Z');
    scope = `(b.branch_id = ${branch}::uuid
      or exists (
        select 1 from queue_quality_assessments scoped_assessment
         where scoped_assessment.employee_id = b.id
           and scoped_assessment.branch_id = ${branch}::uuid
           and scoped_assessment.completed_at >= ${start}::timestamptz
           and scoped_assessment.completed_at < ${end}::timestamptz
      )
      or exists (
        select 1 from queue_status_events scoped_event
         where scoped_event.responsible_employee_id = b.id
           and scoped_event.branch_id = ${branch}::uuid
           and scoped_event.occurred_at >= ${start}::timestamptz
           and scoped_event.occurred_at < ${end}::timestamptz
      ))`;
  }
  params.push(employeeId);
  const result = await pool.query(
    `select b.id, b.name, b.branch_id from barbers b where b.id = $${params.length}::uuid and ${scope} limit 1`,
    params,
  );
  return result.rows[0] || null;
}

class EmployeeQuality {
  async aggregate(req, res) {
    try {
      const access = await authenticateStatistics(req, res);
      if (!access) return;
      const page = parsePagination(req.query || {});
      if (page.error) return res.status(400).json({ error: page.error });

      const [rows, failures, neutrals, dataQuality] = await Promise.all([
        loadEmployeeRows(access),
        loadFailureCounts(access),
        loadNeutralCounts(access),
        loadDataQuality(access),
      ]);

      const merged = rows.map((row) => {
        const neutral = neutrals.get(String(row.id)) || {};
        return {
          ...row,
          employee_failure_count: failures.get(String(row.id)) || 0,
          no_show_count: neutral.no_show_count || 0,
          not_in_time_count: neutral.not_in_time_count || 0,
          neutral_cancelled_count: neutral.neutral_cancelled_count || 0,
        };
      }).filter((row) => (
        !row.is_archived
        || [
          row.completed,
          row.employee_failure_count,
          row.no_show_count,
          row.not_in_time_count,
          row.neutral_cancelled_count,
        ].some((value) => Number(value || 0) > 0)
      ));

      const ranked = rankEmployees(merged);
      const employees = page.limit === null
        ? ranked
        : ranked.slice(page.offset, page.offset + page.limit);
      const nextOffset = page.limit !== null && page.offset + employees.length < ranked.length
        ? page.offset + employees.length
        : null;

      return res.json({
        formula_version: FORMULA_VERSION,
        timezone: TIMEZONE,
        range: { start_date: access.range.startDate, end_date: access.range.endDate },
        scope: {
          type: access.scope.type,
          branch_id: access.scope.type === 'branch' ? access.scope.branchId : null,
          employee_id: access.scope.employeeId || null,
          ...(access.scope.type === 'global' ? { tenant_model: 'single-network-database' } : {}),
        },
        rules: DEFAULT_RULES,
        employees,
        pagination: {
          cursor: page.cursor,
          limit: page.limit,
          next_cursor: nextOffset === null ? null : String(nextOffset),
          total: ranked.length,
        },
        data_quality: dataQuality,
      });
    } catch (error) {
      if (isMissingQualitySchema(error)) return schemaMissing(res);
      console.error('Employee quality aggregate failed:', error.message);
      return res.status(500).json({ error: 'Failed to load employee quality statistics' });
    }
  }

  async orders(req, res) {
    try {
      const access = await authenticateStatistics(req, res, { requireHistory: true });
      if (!access) return;
      const employeeId = String(req.params?.employeeId || '');
      const category = String(req.query?.category || '').trim();
      if (!UUID_PATTERN.test(employeeId)) return res.status(400).json({ error: 'employeeId must be a UUID' });
      if (!DRILLDOWN_CATEGORIES.has(category)) {
        return res.status(400).json({ error: 'category must be suspicious, employee_failure, or unclassified' });
      }
      const employee = await assertEmployeeInScope(employeeId, access);
      if (!employee) return res.status(404).json({ error: 'Employee not found in authorized scope' });

      const page = parsePagination(req.query || {}, { defaultLimit: 50 });
      if (page.error) return res.status(400).json({ error: page.error });
      const reviewState = String(req.query?.review_state || '').trim() || null;
      if (reviewState && (category !== 'suspicious' || !REVIEW_STATES.has(reviewState))) {
        return res.status(400).json({ error: 'review_state is valid only for suspicious evidence' });
      }
      const { limit, offset } = page;
      let result;
      const authorizedBranchId = access.scope.type === 'branch' ? access.scope.branchId : null;
      if (category === 'employee_failure') {
        result = await pool.query(
          `select e.queue_entry_id as order_id, e.branch_id, e.responsible_employee_id as employee_id,
                  e.to_status as status, e.reason_code, e.occurred_at,
                  null::timestamptz as completed_at, null::numeric as expected_minutes,
                  null::numeric as actual_minutes, null::text as rule_code,
                  null::text as rule_version, null::text as assessment_source,
                  null::text as data_confidence, null::text as review_state,
                  'employee_failure'::text as classification, count(*) over()::int as total_count
             from queue_status_events e
            where e.responsible_employee_id = $1::uuid
              and e.occurred_at >= $2::timestamptz and e.occurred_at < $3::timestamptz
              and e.to_status in ('cancelled', 'rejected')
              and e.actor_type = 'employee'
              and e.reason_code = any($4::text[])
              and ($5::uuid is null or e.branch_id = $5::uuid)
            order by e.occurred_at desc, e.id desc limit $6 offset $7`,
          [employeeId, access.range.startInclusive, access.range.endExclusive, [...EMPLOYEE_FAILURE_REASONS], authorizedBranchId, limit, offset],
        );
      } else {
        const categoryClause = category === 'suspicious'
          ? (reviewState ? 'a.suspicious' : "a.suspicious and a.review_state in ('unreviewed', 'confirmed')")
          : 'not a.classifiable';
        result = await pool.query(
          `select a.queue_entry_id as order_id, a.branch_id, a.employee_id, 'completed'::text as status,
                  a.completed_at, null::timestamptz as occurred_at,
                  a.expected_duration_minutes as expected_minutes,
                  a.actual_duration_minutes as actual_minutes,
                  a.unclassified_reason as reason_code,
                  a.suspicious, a.rule_code, a.rule_version, a.assessment_source,
                  a.data_confidence, a.review_state,
                  $5::text as requested_review_state,
                  '${category}'::text as classification, count(*) over()::int as total_count
             from queue_quality_assessments a
            where a.employee_id = $1::uuid
              and a.completed_at >= $2::timestamptz and a.completed_at < $3::timestamptz
              and ($4::uuid is null or a.branch_id = $4::uuid)
              and ${categoryClause}
              and ($5::text is null or a.review_state = $5::text)
            order by a.completed_at desc, a.queue_entry_id desc limit $6 offset $7`,
          [employeeId, access.range.startInclusive, access.range.endExclusive, authorizedBranchId, reviewState, limit, offset],
        );
      }

      const total = Number(result.rows?.[0]?.total_count || 0);
      const orders = (result.rows || []).map(({ total_count: _totalCount, requested_review_state: _reviewState, ...row }) => row);
      const nextOffset = offset + orders.length < total ? offset + orders.length : null;

      return res.json({
        formula_version: FORMULA_VERSION,
        timezone: TIMEZONE,
        range: { start_date: access.range.startDate, end_date: access.range.endDate },
        scope: {
          type: access.scope.type,
          branch_id: access.scope.type === 'branch' ? access.scope.branchId : null,
          employee_id: employeeId,
        },
        category,
        orders,
        pagination: {
          cursor: page.cursor,
          limit,
          next_cursor: nextOffset === null ? null : String(nextOffset),
          total,
        },
      });
    } catch (error) {
      if (isMissingQualitySchema(error)) return schemaMissing(res);
      console.error('Employee quality drill-down failed:', error.message);
      return res.status(500).json({ error: 'Failed to load employee quality evidence' });
    }
  }

  async review(req, res) {
    let client;
    try {
      const access = await authenticateStatistics(req, res, { requireHistory: true, requireRange: false });
      if (!access) return;
      if (!canReviewQuality(access)) return res.status(403).json({ error: 'Quality review requires branch or global manager access' });

      const employeeId = String(req.params?.employeeId || '');
      const orderId = String(req.params?.orderId || '');
      const reviewState = String(req.body?.review_state || '').trim();
      const reviewComment = String(req.body?.review_comment || '').trim();
      const idempotencyKey = String(req.body?.idempotency_key || '').trim();
      const expectedVersion = Number(req.body?.expected_version);
      if (!UUID_PATTERN.test(employeeId) || !UUID_PATTERN.test(orderId)) {
        return res.status(400).json({ error: 'employeeId and orderId must be UUIDs' });
      }
      if (!REVIEW_STATES.has(reviewState) || reviewState === 'unreviewed') {
        return res.status(400).json({ error: 'review_state must be confirmed or dismissed' });
      }
      if (!reviewComment || reviewComment.length > 1000) {
        return res.status(400).json({ error: 'review_comment is required and must not exceed 1000 characters' });
      }
      if (!/^[A-Za-z0-9._:-]{8,100}$/.test(idempotencyKey)) {
        return res.status(400).json({ error: 'idempotency_key must be 8-100 safe characters' });
      }
      if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
        return res.status(400).json({ error: 'expected_version must be a non-negative integer' });
      }
      if (String(access.user.id) === employeeId) {
        return res.status(403).json({ error: 'Employees cannot review their own quality assessment' });
      }
      const employee = await assertEmployeeInScope(employeeId, access);
      if (!employee) return res.status(404).json({ error: 'Employee not found in authorized scope' });

      client = await pool.connect();
      await client.query('begin');
      const locked = await client.query(
        `select id, queue_entry_id, employee_id, branch_id, suspicious, review_state, review_version
           from queue_quality_assessments
          where queue_entry_id = $1::uuid and employee_id = $2::uuid
          for update`,
        [orderId, employeeId],
      );
      const assessment = locked.rows[0];
      // Locking first serializes concurrent retries. A second request now sees
      // the event committed by the first request and returns the same result.
      const replay = await client.query(
        `select a.queue_entry_id as order_id, a.employee_id, a.branch_id, a.suspicious,
                a.review_state, a.reviewed_by, a.reviewed_at, a.review_version,
                 r.previous_state, r.review_state as requested_review_state, r.review_comment,
                r.expected_version, r.resulting_version
           from queue_quality_review_events r
           join queue_quality_assessments a on a.id = r.assessment_id
          where r.idempotency_key = $1 and r.reviewer_id = $2 and a.queue_entry_id = $3::uuid
          limit 1`,
        [idempotencyKey, access.user.id, orderId],
      );
      if (replay.rows[0]) {
        if (!reviewReplayMatches(replay.rows[0], {
          employeeId,
          expectedVersion,
          reviewComment,
          reviewState,
        })) {
          await client.query('rollback');
          return res.status(409).json({ error: 'Idempotency key was already used for a different review request' });
        }
        if (access.scope.type === 'branch' && String(replay.rows[0].branch_id) !== String(access.scope.branchId)) {
          await client.query('rollback');
          return res.status(403).json({ error: 'Assessment is outside the authenticated branch scope' });
        }
        await client.query('commit');
        return res.json({ assessment: replay.rows[0], idempotent: true });
      }
      if (!assessment || !assessment.suspicious) {
        await client.query('rollback');
        return res.status(404).json({ error: 'Suspicious assessment not found' });
      }
      if (assessment.review_state === reviewState) {
        await client.query('rollback');
        return res.status(409).json({ error: 'Assessment is already in the requested review state' });
      }
      if (access.scope.type === 'branch' && String(assessment.branch_id) !== String(access.scope.branchId)) {
        await client.query('rollback');
        return res.status(403).json({ error: 'Assessment is outside the authenticated branch scope' });
      }
      if (Number(assessment.review_version) !== expectedVersion) {
        await client.query('rollback');
        return res.status(409).json({
          error: 'Assessment review changed concurrently',
          current_version: Number(assessment.review_version),
        });
      }

      await client.query(
        `insert into queue_quality_review_events
          (assessment_id, queue_entry_id, previous_state, review_state, reviewer_id, review_comment,
           idempotency_key, expected_version, resulting_version, reviewer_scope_type, reviewer_branch_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          assessment.id,
          orderId,
          assessment.review_state,
          reviewState,
          access.user.id,
          reviewComment,
          idempotencyKey,
          expectedVersion,
          expectedVersion + 1,
          access.scope.type,
          access.scope.branchId || null,
        ],
      );
      const updated = await client.query(
        `update queue_quality_assessments
            set review_state = $1, reviewed_by = $2, reviewed_at = now(), review_comment = $3,
                review_version = review_version + 1, updated_at = now()
          where id = $4 and review_version = $5
          returning queue_entry_id as order_id, employee_id, branch_id, suspicious, review_state,
                    reviewed_by, reviewed_at, review_version`,
        [reviewState, access.user.id, reviewComment, assessment.id, expectedVersion],
      );
      if (!updated.rows[0]) throw new Error('Concurrent quality review update');
      await client.query('commit');
      return res.json({ assessment: updated.rows[0], idempotent: false });
    } catch (error) {
      if (client) await client.query('rollback').catch(() => {});
      if (isMissingQualitySchema(error)) return schemaMissing(res);
      if (String(error?.code || '') === '23505') {
        return res.status(409).json({ error: 'Review idempotency key was already used for another decision' });
      }
      console.error('Employee quality review failed:', error.message);
      return res.status(500).json({ error: 'Failed to review employee quality assessment' });
    } finally {
      client?.release();
    }
  }
}

module.exports = new EmployeeQuality();
module.exports._private = {
  appendParam,
  isMissingQualitySchema,
  parsePagination,
  reviewReplayMatches,
  scopePredicate,
};
