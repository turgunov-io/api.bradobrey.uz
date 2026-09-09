const { db } = require('../config/postgres');

const percent = (count, total) => (total ? Number(((count / total) * 100).toFixed(1)) : 0);

const toDateKey = (value) => {
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return 'unknown';
  return new Date(ts).toISOString().slice(0, 10);
};

const bump = (bucket, key) => {
  const finalKey = key ?? 'unknown';
  if (!bucket[finalKey]) bucket[finalKey] = 0;
  bucket[finalKey] += 1;
};

const MANAGER_ROLES = new Set(['manager', 'super-manager']);
const COMPLETED_STATUSES = new Set(['completed']);

const toAmount = (value) => {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
};

const normalizePaymentMethod = (value) => String(value || '').trim().toLowerCase();

const serviceIdsForEntry = (entry) => {
  if (Array.isArray(entry?.service_ids) && entry.service_ids.length) {
    return entry.service_ids.filter(Boolean);
  }

  return entry?.service_id ? [entry.service_id] : [];
};

const roundMoney = (value) => Math.round(toAmount(value) * 100) / 100;

class Statistics {
  async manager(req, res) {
    const access = req.employeeAccess;
    const role = String(access?.payload?.role || access?.user?.role || '').trim().toLowerCase();
    const branchId = access?.payload?.branchId
      || access?.payload?.branch_id
      || access?.user?.branch_id
      || null;

    if (!MANAGER_ROLES.has(role)) {
      return res.status(403).json({ error: 'Only managers can view branch management statistics' });
    }

    if (!branchId) {
      return res.status(400).json({ error: 'Manager branch is not assigned' });
    }

    const startDate = req.query?.start_date;
    const endDate = req.query?.end_date;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'start_date and end_date are required' });
    }

    try {
      const ordersResult = await db.query(
        `select
            q.id,
            q.branch_id,
            q.barber_id,
            q.client_id,
            q.status,
            q.payment_method,
            q.created_at,
            q.started_at,
            q.finished_at,
            q.service_id,
            q.service_ids,
            q.price_override,
            c.name as client_name,
            c.phone as client_phone,
            b.name as barber_name,
            br.name as branch_name
         from queue_entries q
         left join clients c on c.id = q.client_id
         left join barbers b on b.id = q.barber_id
         left join branches br on br.id = q.branch_id
         where q.branch_id = $1
           and q.created_at >= $2
           and q.created_at < $3
         order by q.created_at desc`,
        [branchId, startDate, endDate]
      );

      const orders = ordersResult.rows || [];
      const orderIds = orders.map((order) => order.id).filter(Boolean);
      const serviceIds = Array.from(new Set(orders.flatMap(serviceIdsForEntry)));

      const [paymentsResult, servicesResult] = await Promise.all([
        orderIds.length
          ? db.query(
            `select queue_entry_id, amount, method, created_at
             from payments
             where queue_entry_id = any($1::uuid[])
             order by created_at asc`,
            [orderIds]
          )
          : { rows: [] },
        serviceIds.length
          ? db.query('select id, base_price from services where id = any($1::uuid[])', [serviceIds])
          : { rows: [] },
      ]);

      const servicePrices = new Map((servicesResult.rows || []).map((service) => [
        String(service.id),
        toAmount(service.base_price),
      ]));
      const paymentsByOrder = new Map();

      for (const payment of paymentsResult.rows || []) {
        const current = paymentsByOrder.get(payment.queue_entry_id) || [];
        current.push({
          amount: toAmount(payment.amount),
          method: normalizePaymentMethod(payment.method),
          created_at: payment.created_at,
        });
        paymentsByOrder.set(payment.queue_entry_id, current);
      }

      const barberMap = new Map();
      let turnover = 0;
      let cash = 0;
      let card = 0;
      let certificate = 0;
      let completedOrders = 0;
      const clients = new Set();

      const preparedOrders = orders.map((order) => {
        const serviceAmount = serviceIdsForEntry(order).reduce(
          (sum, serviceId) => sum + (servicePrices.get(String(serviceId)) || 0),
          0
        );
        const fallbackAmount = toAmount(order.price_override) || serviceAmount;
        const payments = paymentsByOrder.get(order.id) || [];
        const paidAmount = payments.reduce((sum, payment) => sum + payment.amount, 0);
        const amount = roundMoney(paidAmount || fallbackAmount);
        const isCompleted = COMPLETED_STATUSES.has(String(order.status || '').toLowerCase());
        const method = normalizePaymentMethod(order.payment_method);
        const paymentTotals = { cash: 0, card: 0, certificate: 0 };

        if (payments.length) {
          for (const payment of payments) {
            if (payment.method === 'cash') paymentTotals.cash += payment.amount;
            if (payment.method === 'card') paymentTotals.card += payment.amount;
            if (payment.method === 'certificate') paymentTotals.certificate += payment.amount;
          }
        } else if (method === 'cash') {
          paymentTotals.cash = amount;
        } else if (method === 'card') {
          paymentTotals.card = amount;
        } else if (method === 'certificate') {
          paymentTotals.certificate = amount;
        }

        if (isCompleted) {
          completedOrders += 1;
          turnover += amount;
          cash += paymentTotals.cash;
          card += paymentTotals.card;
          certificate += paymentTotals.certificate;
          if (order.client_id) clients.add(String(order.client_id));

          const barberId = order.barber_id || 'unassigned';
          const current = barberMap.get(barberId) || {
            id: order.barber_id || null,
            name: order.barber_name || 'Барбер не назначен',
            orders: 0,
            turnover: 0,
            cash: 0,
            card: 0,
          };
          current.orders += 1;
          current.turnover += amount;
          current.cash += paymentTotals.cash;
          current.card += paymentTotals.card;
          barberMap.set(barberId, current);
        }

        const startedAt = order.started_at ? new Date(order.started_at).getTime() : NaN;
        const finishedAt = order.finished_at ? new Date(order.finished_at).getTime() : NaN;

        return {
          id: order.id,
          client: {
            id: order.client_id || null,
            name: order.client_name || null,
            phone: order.client_phone || null,
          },
          barber: {
            id: order.barber_id || null,
            name: order.barber_name || 'Барбер не назначен',
          },
          status: order.status || null,
          amount,
          payment_method: method || null,
          payments,
          created_at: order.created_at || null,
          started_at: order.started_at || null,
          finished_at: order.finished_at || null,
          duration_minutes: Number.isFinite(startedAt) && Number.isFinite(finishedAt)
            ? Math.max(0, Math.round((finishedAt - startedAt) / 60000))
            : null,
        };
      });

      return res.json({
        branch: { id: branchId, name: orders[0]?.branch_name || null },
        range: { start_date: startDate, end_date: endDate },
        totals: {
          turnover: roundMoney(turnover),
          cash: roundMoney(cash),
          card: roundMoney(card),
          certificate: roundMoney(certificate),
          orders: completedOrders,
          unique_clients: clients.size,
        },
        barbers: Array.from(barberMap.values())
          .map((item) => ({ ...item, turnover: roundMoney(item.turnover), cash: roundMoney(item.cash), card: roundMoney(item.card) }))
          .sort((left, right) => right.orders - left.orders),
        orders: preparedOrders,
      });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Failed to load manager statistics' });
    }
  }

  async all(req, res) {
    return this.handleScoped(req, res);
  }

  async branch(req, res) {
    const { branch } = req.params || {};
    if (!branch) {
      return res.status(400).json({ error: 'branch id is required in path param :branch' });
    }
    return this.handleScoped(req, res, { branchId: branch });
  }

  async barber(req, res) {
    const { barber } = req.params || {};
    if (!barber) {
      return res.status(400).json({ error: 'barber id is required in path param :barber' });
    }
    return this.handleScoped(req, res, { barberId: barber });
  }

  async handleScoped(req, res, scope = {}) {
    const { start_date, end_date } = req.query || {};

    if (!start_date || !end_date) {
      return res.status(400).json({ error: 'start_date and end_date are required' });
    }

    const { data, error } = await this.fetchEntries({ start_date, end_date, ...scope });
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const response = await this.buildResponse(data || [], { start_date, end_date, ...scope });
    return res.json(response);
  }

  async fetchEntries({ start_date, end_date, branchId, barberId }) {
    const query = db
      .from('queue_entries')
      .select('id, client_id, branch_id, barber_id, source, status, payment_method, created_at, finished_at');

    query.gte('created_at', start_date).lte('created_at', end_date);

    if (branchId) query.eq('branch_id', branchId);
    if (barberId) query.eq('barber_id', barberId);

    return query;
  }

  async buildResponse(rows, meta) {
    const buckets = {
      sources: {},
      payment_methods: {},
      branches: {},
      barbers: {},
      statuses: {},
      days: {},
    };

    const totals = {
      entries: rows.length,
      unique_clients: 0,
      completed: 0,
      cancelled: 0,
      in_progress: 0,
      waiting: 0,
    };

    const uniqueClients = new Set();

    rows.forEach((item) => {
      if (item?.client_id) uniqueClients.add(item.client_id);

      bump(buckets.sources, item?.source || 'unknown');
      bump(buckets.payment_methods, item?.payment_method || 'not_set');
      bump(buckets.branches, item?.branch_id || 'unassigned');
      bump(buckets.barbers, item?.barber_id || 'unassigned');
      bump(buckets.statuses, item?.status || 'unknown');

      if (item?.created_at) {
        bump(buckets.days, toDateKey(item.created_at));
      }

      if (item?.status === 'completed') totals.completed += 1;
      if (['cancelled', 'rejected', 'no_show', 'not_in_time'].includes(item?.status)) totals.cancelled += 1;
      if (item?.status === 'in_progress') totals.in_progress += 1;
      if (['waiting', 'called', 'swapped'].includes(item?.status)) totals.waiting += 1;
    });

    totals.unique_clients = uniqueClients.size;

    const totalEntries = totals.entries;

    const breakdowns = {
      sources: this.asArray(buckets.sources, totalEntries),
      payment_methods: this.asArray(buckets.payment_methods, totalEntries),
      statuses: this.asArray(buckets.statuses, totalEntries),
      timeline_daily: this.asArray(buckets.days, totalEntries, { sortByKey: true }),
      branches: await this.asArrayWithNames('branches', buckets.branches, totalEntries),
      barbers: await this.asArrayWithNames('barbers', buckets.barbers, totalEntries),
    };

    const effectiveDays = breakdowns.timeline_daily.filter((d) => d.key !== 'unknown').length;
    const averagePerDay = effectiveDays ? Number((totalEntries / effectiveDays).toFixed(2)) : 0;

    return {
      range: {
        start_date: meta.start_date,
        end_date: meta.end_date,
      },
      scope: {
        branch_id: meta.branchId || null,
        barber_id: meta.barberId || null,
      },
      totals: {
        ...totals,
        average_per_day: averagePerDay,
      },
      breakdowns,
      raw: {
        by_source: buckets.sources,
        by_payment_method: buckets.payment_methods,
        by_branch: buckets.branches,
        by_barber: buckets.barbers,
        by_status: buckets.statuses,
        by_day: buckets.days,
      },
    };
  }

  asArray(map = {}, total = 0, options = {}) {
    const { sortByKey = false } = options;
    const arr = Object.entries(map).map(([key, count]) => ({
      key,
      count,
      percent: percent(count, total),
    }));

    if (sortByKey) {
      return arr.sort((a, b) => (a.key > b.key ? 1 : -1));
    }

    return arr.sort((a, b) => b.count - a.count);
  }

  async asArrayWithNames(table, map = {}, total = 0) {
    const ids = Object.keys(map).filter((id) => id && !['unknown', 'unassigned'].includes(id));
    let lookup = {};

    if (ids.length) {
      const { data, error } = await db
        .from(table)
        .select('id, name')
        .in('id', ids);

      if (!error && Array.isArray(data)) {
        lookup = data.reduce((acc, row) => {
          acc[row.id] = row.name || row.id;
          return acc;
        }, {});
      } else if (error) {
        console.warn(`Could not fetch ${table} names: ${error.message}`);
      }
    }

    return Object.entries(map)
      .map(([key, count]) => {
        const label =
          lookup[key] ||
          (key === 'unassigned' ? 'Not assigned' : key === 'unknown' ? 'Unknown' : key);
        return {
          id: ['unknown', 'unassigned'].includes(key) ? null : key,
          label,
          count,
          percent: percent(count, total),
        };
      })
      .sort((a, b) => b.count - a.count);
  }
}

module.exports = new Statistics();
