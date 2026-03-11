const { supabase } = require('../config/supabase');

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

class Statistics {
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
    const query = supabase
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
      const { data, error } = await supabase
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
