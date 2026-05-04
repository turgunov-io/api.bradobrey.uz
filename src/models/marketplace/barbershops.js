const { supabase } = require('../../config/supabase');

const normalizeText = (value) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = String(value).trim();
  return trimmed.length ? trimmed : null;
};

const parseBoolean = (value, fallback = undefined) => {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};

const parseWorkHours = (value) => {
  if (value === undefined) return undefined;
  if (value === null) return null;

  if (typeof value === 'object') return value;

  const raw = String(value).trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (_err) {
    return '__invalid__';
  }
};

const selectFields = 'id,name,address,city,work_hours,timezone,is_active';

class MarketplaceBarbershops {
  async list(req, res) {
    try {
      const { active } = req.query || {};

      let query = supabase.from('branches').select(selectFields);

      if (active !== undefined) {
        const activeFlag = parseBoolean(active, null);
        if (activeFlag === null) {
          return res.status(400).json({ error: 'active must be a boolean' });
        }
        query = query.eq('is_active', activeFlag);
      }

      const { data, error } = await query.order('name', { ascending: true });
      if (error) return res.status(500).json({ error: error.message });

      return res.json({ data: data || [] });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }

  async getById(req, res) {
    try {
      const { id } = req.params || {};
      if (!id) return res.status(400).json({ error: 'id is required' });

      const { data, error } = await supabase
        .from('branches')
        .select(selectFields)
        .eq('id', id)
        .maybeSingle();

      if (error) return res.status(500).json({ error: error.message });
      if (!data) return res.status(404).json({ error: 'Barbershop not found' });

      return res.json({ entry: data });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }

  async create(req, res) {
    try {
      const { name, address, city, work_hours, timezone, is_active } = req.body || {};

      const normalizedName = normalizeText(name);
      if (!normalizedName) {
        return res.status(400).json({ error: 'name is required' });
      }

      const parsedWorkHours = parseWorkHours(work_hours);
      if (parsedWorkHours === '__invalid__') {
        return res.status(400).json({ error: 'work_hours must be an object or valid JSON string' });
      }

      const payload = {
        name: normalizedName,
        address: normalizeText(address) ?? null,
        city: normalizeText(city) ?? null,
        work_hours: parsedWorkHours ?? null,
        timezone: normalizeText(timezone) ?? null,
        is_active: parseBoolean(is_active, true),
      };

      const { data, error } = await supabase
        .from('branches')
        .insert(payload)
        .select(selectFields)
        .maybeSingle();

      if (error) return res.status(500).json({ error: error.message });
      return res.status(201).json({ entry: data });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }

  async update(req, res) {
    try {
      const { id } = req.params || {};
      if (!id) return res.status(400).json({ error: 'id is required' });

      const { name, address, city, work_hours, timezone, is_active } = req.body || {};

      const update = {};

      if (name !== undefined) {
        const normalizedName = normalizeText(name);
        if (!normalizedName) return res.status(400).json({ error: 'name cannot be empty' });
        update.name = normalizedName;
      }

      if (address !== undefined) update.address = normalizeText(address);
      if (city !== undefined) update.city = normalizeText(city);
      if (timezone !== undefined) update.timezone = normalizeText(timezone);

      if (is_active !== undefined) {
        const parsedIsActive = parseBoolean(is_active, null);
        if (parsedIsActive === null) {
          return res.status(400).json({ error: 'is_active must be a boolean' });
        }
        update.is_active = parsedIsActive;
      }

      if (work_hours !== undefined) {
        const parsedWorkHours = parseWorkHours(work_hours);
        if (parsedWorkHours === '__invalid__') {
          return res.status(400).json({ error: 'work_hours must be an object or valid JSON string' });
        }
        update.work_hours = parsedWorkHours;
      }

      if (Object.keys(update).length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      const { data, error } = await supabase
        .from('branches')
        .update(update)
        .eq('id', id)
        .select(selectFields)
        .maybeSingle();

      if (error) return res.status(500).json({ error: error.message });
      if (!data) return res.status(404).json({ error: 'Barbershop not found' });

      return res.json({ entry: data });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }

  async activate(req, res) {
    try {
      const { id } = req.params || {};
      if (!id) return res.status(400).json({ error: 'id is required' });

      const { data, error } = await supabase
        .from('branches')
        .update({ is_active: true })
        .eq('id', id)
        .select(selectFields)
        .maybeSingle();

      if (error) return res.status(500).json({ error: error.message });
      if (!data) return res.status(404).json({ error: 'Barbershop not found' });

      return res.json({ entry: data });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }

  async deactivate(req, res) {
    try {
      const { id } = req.params || {};
      if (!id) return res.status(400).json({ error: 'id is required' });

      const { data, error } = await supabase
        .from('branches')
        .update({ is_active: false })
        .eq('id', id)
        .select(selectFields)
        .maybeSingle();

      if (error) return res.status(500).json({ error: error.message });
      if (!data) return res.status(404).json({ error: 'Barbershop not found' });

      return res.json({ entry: data });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }
}

module.exports = new MarketplaceBarbershops();

