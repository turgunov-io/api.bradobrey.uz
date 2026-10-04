const FORMULA_VERSION = 'employee-quality-v1';
const RULE_CODE = 'duration-ratio';

const DEFAULT_RULES = Object.freeze({
  minimum_classifiable_completed: 10,
  minimum_classification_coverage: 0.9,
  suspicious_duration_ratio: 0.5,
});

const ACTIVE_REVIEW_STATES = new Set(['unreviewed', 'confirmed']);
const REVIEW_STATES = new Set(['unreviewed', 'confirmed', 'dismissed']);
const EMPLOYEE_FAILURE_REASONS = new Set([
  'employee_refused',
  'employee_unavailable',
  'employee_schedule_conflict',
  'employee_cancelled_after_start',
]);

const finiteNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const timestamp = (value) => {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
};

function classifyCompletedOrder({
  employeeId,
  expectedMinutes,
  finishedAt,
  startedAt,
} = {}, rules = DEFAULT_RULES) {
  const expected = finiteNumber(expectedMinutes, 0);
  const started = timestamp(startedAt);
  const finished = timestamp(finishedAt);
  let unclassifiedReason = null;

  if (!employeeId) unclassifiedReason = 'missing_employee';
  else if (!(expected > 0)) unclassifiedReason = 'missing_expected_duration';
  else if (started === null) unclassifiedReason = 'missing_started_at';
  else if (finished === null) unclassifiedReason = 'missing_finished_at';
  else if (finished < started) unclassifiedReason = 'finished_before_started';

  if (unclassifiedReason) {
    return {
      actual_minutes: null,
      classifiable: false,
      expected_minutes: expected > 0 ? expected : null,
      rule_code: RULE_CODE,
      rule_version: FORMULA_VERSION,
      suspicious: false,
      unclassified_reason: unclassifiedReason,
    };
  }

  const actualMinutes = (finished - started) / 60000;
  return {
    actual_minutes: actualMinutes,
    classifiable: true,
    expected_minutes: expected,
    rule_code: RULE_CODE,
    rule_version: FORMULA_VERSION,
    suspicious: actualMinutes < expected * rules.suspicious_duration_ratio,
    unclassified_reason: null,
  };
}

const normalizeCount = (value) => Math.max(0, Math.trunc(finiteNumber(value, 0)));

function normalizeEmployeeMetrics(row, rules = DEFAULT_RULES) {
  const completed = normalizeCount(row.completed);
  const classifiableCompleted = Math.min(completed, normalizeCount(row.classifiable_completed));
  const suspiciousCount = Math.min(classifiableCompleted, normalizeCount(row.suspicious_count));
  const trustedCompleted = Math.max(0, classifiableCompleted - suspiciousCount);
  const employeeFailureCount = normalizeCount(row.employee_failure_count);
  const coverage = completed ? classifiableCompleted / completed : 0;
  const authoritativeCompleted = Math.min(completed, normalizeCount(row.authoritative_completed));
  const liveSnapshotCount = Math.min(classifiableCompleted, normalizeCount(row.live_snapshot_count));
  const backfillCount = Math.min(classifiableCompleted, normalizeCount(row.backfill_current_catalog_count));
  const unclassifiedCount = completed - classifiableCompleted;
  const allEvidenceAuthoritative = completed > 0 && authoritativeCompleted === completed;
  const eligible = row.is_archived !== true
    && classifiableCompleted >= rules.minimum_classifiable_completed
    && coverage >= rules.minimum_classification_coverage
    && allEvidenceAuthoritative;

  let provisionalReason = null;
  if (row.is_archived === true) provisionalReason = 'employee_archived';
  else if (completed === 0) provisionalReason = 'no_completed_orders';
  else if (classifiableCompleted < rules.minimum_classifiable_completed) provisionalReason = 'insufficient_classifiable_completed';
  else if (coverage < rules.minimum_classification_coverage) provisionalReason = 'insufficient_classification_coverage';
  else if (!allEvidenceAuthoritative) {
    if (row.data_confidence === 'mixed') provisionalReason = 'mixed_data';
    else if (row.data_confidence === 'approximate') provisionalReason = 'approximate_data';
    else provisionalReason = 'no_authoritative_snapshot';
  }

  return {
    completed,
    classifiable_completed: classifiableCompleted,
    classification_coverage: coverage,
    assessment_source: allEvidenceAuthoritative ? 'live_snapshot' : (row.assessment_source || null),
    assessment_source_counts: {
      backfill_current_catalog: backfillCount,
      live_snapshot: liveSnapshotCount,
      unclassified: unclassifiedCount,
    },
    data_confidence: allEvidenceAuthoritative ? 'authoritative' : (row.data_confidence || 'insufficient'),
    trusted_completed: trustedCompleted,
    suspicious_count: suspiciousCount,
    suspicious_rate: classifiableCompleted ? suspiciousCount / classifiableCompleted : 0,
    employee_failure_count: employeeFailureCount,
    employee_failure_rate: trustedCompleted + employeeFailureCount
      ? employeeFailureCount / (trustedCompleted + employeeFailureCount)
      : 0,
    no_show_count: normalizeCount(row.no_show_count),
    not_in_time_count: normalizeCount(row.not_in_time_count),
    neutral_cancelled_count: normalizeCount(row.neutral_cancelled_count),
    revenue: Math.max(0, Math.round(finiteNumber(row.revenue, 0) * 100) / 100),
    eligible,
    provisional_reason: provisionalReason,
  };
}

const compareKeys = (left, right) => {
  const a = left.metrics;
  const b = right.metrics;
  if ((a.suspicious_count > 0) !== (b.suspicious_count > 0)) return a.suspicious_count > 0 ? 1 : -1;
  if (a.suspicious_count !== b.suspicious_count) return a.suspicious_count - b.suspicious_count;
  // Exact cross-products avoid floating-point ordering/tie ambiguity.
  const suspiciousRateDifference = BigInt(a.suspicious_count) * BigInt(b.classifiable_completed)
    - BigInt(b.suspicious_count) * BigInt(a.classifiable_completed);
  if (suspiciousRateDifference !== 0n) return suspiciousRateDifference < 0n ? -1 : 1;
  if (a.trusted_completed !== b.trusted_completed) return b.trusted_completed - a.trusted_completed;
  const aFailureDenominator = a.trusted_completed + a.employee_failure_count;
  const bFailureDenominator = b.trusted_completed + b.employee_failure_count;
  const failureRateDifference = BigInt(a.employee_failure_count) * BigInt(bFailureDenominator)
    - BigInt(b.employee_failure_count) * BigInt(aFailureDenominator);
  if (failureRateDifference !== 0n) return failureRateDifference < 0n ? -1 : 1;
  if (a.employee_failure_count !== b.employee_failure_count) {
    return a.employee_failure_count - b.employee_failure_count;
  }
  return 0;
};

const stableEmployeeCompare = (left, right) => {
  const byName = String(left.employee?.name || '').localeCompare(String(right.employee?.name || ''), 'ru');
  return byName || String(left.employee?.id || '').localeCompare(String(right.employee?.id || ''));
};

function rankEmployees(rows = [], rules = DEFAULT_RULES) {
  const normalized = rows.map((row) => {
    const metrics = normalizeEmployeeMetrics(row, rules);
    return {
      employee: {
        id: String(row.id),
        name: row.name || String(row.id),
        branch_id: row.branch_id || null,
      },
      eligible: metrics.eligible,
      provisional_reason: metrics.provisional_reason,
      rank: null,
      rank_reason: metrics.eligible
        ? `${metrics.suspicious_count} подозрительных из ${metrics.classifiable_completed}; ${metrics.trusted_completed} доверенных завершения`
        : null,
      metrics: Object.fromEntries(Object.entries(metrics).filter(([key]) => !['eligible', 'provisional_reason'].includes(key))),
    };
  });

  const eligible = normalized
    .filter((item) => item.eligible)
    .sort((left, right) => compareKeys(left, right) || stableEmployeeCompare(left, right));

  let previous = null;
  for (let index = 0; index < eligible.length; index += 1) {
    const current = eligible[index];
    current.rank = previous && compareKeys(previous, current) === 0
      ? previous.rank
      : index + 1;
    previous = current;
  }

  const provisional = normalized
    .filter((item) => !item.eligible)
    .sort(stableEmployeeCompare);
  return [...eligible, ...provisional];
}

module.exports = {
  ACTIVE_REVIEW_STATES,
  DEFAULT_RULES,
  EMPLOYEE_FAILURE_REASONS,
  FORMULA_VERSION,
  REVIEW_STATES,
  RULE_CODE,
  classifyCompletedOrder,
  normalizeEmployeeMetrics,
  rankEmployees,
};
