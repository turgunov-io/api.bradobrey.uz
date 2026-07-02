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

const periodRange = (period) => {
  const normalized = normalizePeriod(period) || currentPeriod();
  const [yearText, monthText] = normalized.split('-');
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;

  return {
    from: new Date(Date.UTC(year, monthIndex, 1)).toISOString(),
    period: normalized,
    to: new Date(Date.UTC(year, monthIndex + 1, 1)).toISOString(),
  };
};

const financeNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const isMissingWarehouseTable = (error) => {
  const code = String(error?.code || '').trim();
  const message = [error?.message, error?.details, error?.hint]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return code === '42P01'
    || (message.includes('warehouse_purchases') && (
      message.includes('does not exist')
      || message.includes('not found')
      || message.includes('schema cache')
    ));
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
  async overview(req, res) {
    const { period, from, to } = periodRange(req.query?.period);

    try {
      const turnoverResult = await db.query(
        `with completed_entries as (
           select q.id,
                  q.branch_id,
                  coalesce(
                    q.price_override,
                    sum(coalesce(s.base_price, 0)),
                    0
                  )::numeric as amount
           from queue_entries q
           left join lateral unnest(
             case
               when q.service_ids is not null and cardinality(q.service_ids) > 0 then q.service_ids
               when q.service_id is not null then array[q.service_id]
               else array[]::uuid[]
             end
           ) service_ref(service_id) on true
           left join services s on s.id = service_ref.service_id
           where q.status = 'completed'
             and q.finished_at >= $1
             and q.finished_at < $2
           group by q.id
         )
         select coalesce(sum(ce.amount), 0)::numeric as total,
                count(ce.id)::int as orders_count
         from completed_entries ce`,
        [from, to]
      );

      const branchesResult = await db.query(
        `with completed_entries as (
           select q.id,
                  q.branch_id,
                  coalesce(
                    q.price_override,
                    sum(coalesce(s.base_price, 0)),
                    0
                  )::numeric as amount
           from queue_entries q
           left join lateral unnest(
             case
               when q.service_ids is not null and cardinality(q.service_ids) > 0 then q.service_ids
               when q.service_id is not null then array[q.service_id]
               else array[]::uuid[]
             end
           ) service_ref(service_id) on true
           left join services s on s.id = service_ref.service_id
           where q.status = 'completed'
             and q.finished_at >= $1
             and q.finished_at < $2
           group by q.id
         )
         select b.id as branch_id,
                b.name as branch_name,
                coalesce(sum(ce.amount), 0)::numeric as turnover,
                count(ce.id)::int as orders_count
         from branches b
         left join completed_entries ce on ce.branch_id = b.id
         group by b.id, b.name
         order by b.name asc`,
        [from, to]
      );

      const salaryResult = await db.query(
        `select branch_id, payload
         from finance_snapshots
         where period = $1`,
        [period]
      );

      const salaryByBranch = new Map();
      const salaryFund = {
        advances: 0,
        employees_count: 0,
        penalty: 0,
        profit: 0,
        salary: 0,
      };

      for (const row of salaryResult.rows || []) {
        const employees = row?.payload?.employees && typeof row.payload.employees === 'object'
          ? row.payload.employees
          : {};
        const branchTotals = {
          advances: 0,
          employees_count: 0,
          penalty: 0,
          profit: 0,
          salary: 0,
        };

        for (const employee of Object.values(employees)) {
          branchTotals.employees_count += 1;
          branchTotals.advances += financeNumber(employee?.advances);
          branchTotals.penalty += financeNumber(employee?.penalty);
          branchTotals.profit += financeNumber(employee?.profit);
          branchTotals.salary += financeNumber(employee?.salary);
        }

        salaryFund.advances += branchTotals.advances;
        salaryFund.employees_count += branchTotals.employees_count;
        salaryFund.penalty += branchTotals.penalty;
        salaryFund.profit += branchTotals.profit;
        salaryFund.salary += branchTotals.salary;
        salaryByBranch.set(String(row.branch_id), branchTotals);
      }

      let purchases = {
        setup_required: false,
        total: 0,
        count: 0,
      };
      let purchasesByBranch = new Map();

      try {
        const purchasesResult = await db.query(
          `select branch_id,
                  coalesce(sum(total_amount), 0)::numeric as total,
                  count(*)::int as count
           from warehouse_purchases
           where status <> 'cancelled'
             and purchased_at >= $1
             and purchased_at < $2
           group by branch_id`,
          [from, to]
        );

        for (const row of purchasesResult.rows || []) {
          const item = {
            count: Number(row.count || 0),
            total: Number(row.total || 0),
          };
          purchases.total += item.total;
          purchases.count += item.count;
          purchasesByBranch.set(String(row.branch_id || ''), item);
        }
      } catch (error) {
        if (!isMissingWarehouseTable(error)) throw error;
        purchases = { ...purchases, setup_required: true };
      }

      const branches = (branchesResult.rows || []).map((row) => {
        const branchId = String(row.branch_id);
        return {
          branch_id: row.branch_id,
          branch_name: row.branch_name,
          orders_count: Number(row.orders_count || 0),
          purchases: purchasesByBranch.get(branchId) || { count: 0, total: 0 },
          salary_fund: salaryByBranch.get(branchId) || {
            advances: 0,
            employees_count: 0,
            penalty: 0,
            profit: 0,
            salary: 0,
          },
          turnover: Number(row.turnover || 0),
        };
      });

      return res.json({
        branches,
        overview: {
          purchases,
          salary_fund: salaryFund,
          turnover: {
            orders_count: Number(turnoverResult.rows[0]?.orders_count || 0),
            total: Number(turnoverResult.rows[0]?.total || 0),
          },
        },
        period,
        range: { from, to },
      });
    } catch (error) {
      if (isMissingFinanceTable(error)) return migrationHint(res, error);
      return res.status(500).json({ error: error.message });
    }
  }

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
