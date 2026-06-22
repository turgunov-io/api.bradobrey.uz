const { db } = require('../config/postgres');

const EMPTY_PAYLOAD = { employees: {} };

const currentPeriod = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

const normalizePeriod = (value) => {
  const period = String(value || '').trim();
  return /^\d{4}-\d{2}$/.test(period) ? period : null;
};

const normalizeId = (value) => {
  const text = String(value || '').trim();
  return text || null;
};

const isMissingFinanceTable = (error) => {
  const code = String(error?.code || '').trim();
  const message = [error?.message, error?.details, error?.hint]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return code === '42P01'
    || code === 'PGRST205'
    || (message.includes('finance_snapshots') && (
      message.includes('does not exist')
      || message.includes('not found')
      || message.includes('schema cache')
    ));
};

const migrationHint = (res, error) => res.status(501).json({
  error: 'finance_snapshots table is missing',
  hint: 'Apply db/postgres/finance_snapshots.sql on the backend database.',
  details: error?.message,
});

const snapshotResponse = ({ branchId = null, period, row = null }) => ({
  branch_id: row?.branch_id || branchId || null,
  payload: row?.payload || EMPTY_PAYLOAD,
  period,
  updated_at: row?.updated_at || null,
});

class Finance {
  async get(req, res) {
    const branchId = normalizeId(req.query?.branch_id || req.query?.object_id);
    const period = normalizePeriod(req.query?.period) || currentPeriod();

    if (!branchId) {
      return res.json(snapshotResponse({ period }));
    }

    const { data, error } = await db
      .from('finance_snapshots')
      .select('branch_id, period, payload, updated_at')
      .eq('branch_id', branchId)
      .eq('period', period)
      .maybeSingle();

    if (error) {
      if (isMissingFinanceTable(error)) return migrationHint(res, error);
      return res.status(500).json({ error: error.message });
    }

    return res.json(snapshotResponse({ branchId, period, row: data }));
  }

  async upsert(req, res) {
    const branchId = normalizeId(req.body?.branch_id || req.body?.object_id);
    const period = normalizePeriod(req.body?.period);
    const payload = req.body?.payload && typeof req.body.payload === 'object'
      ? req.body.payload
      : EMPTY_PAYLOAD;

    if (!branchId) return res.status(400).json({ error: 'branch_id is required' });
    if (!period) return res.status(400).json({ error: 'period must be YYYY-MM' });

    const { data, error } = await db
      .from('finance_snapshots')
      .upsert({
        branch_id: branchId,
        payload,
        period,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'branch_id,period' })
      .select('branch_id, period, payload, updated_at')
      .maybeSingle();

    if (error) {
      if (isMissingFinanceTable(error)) return migrationHint(res, error);
      return res.status(500).json({ error: error.message });
    }

    return res.json(snapshotResponse({ branchId, period, row: data }));
  }
}

module.exports = new Finance();

