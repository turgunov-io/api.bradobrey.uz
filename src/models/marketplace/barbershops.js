const bcrypto = require('bcryptjs');
const { db } = require('../../config/postgres');

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

const parseBranchIds = (value) => {
  if (value === undefined) return undefined;
  if (value === null) return [];
  if (!Array.isArray(value)) return '__invalid__';

  return Array.from(
    new Set(
      value
        .map((item) => String(item || '').trim())
        .filter(Boolean)
    )
  );
};

const syncBranches = async (barbershopId, branchIds) => {
  if (branchIds === undefined) return null;

  const { error: clearError } = await db
    .from('branches')
    .update({ marketplace_barbershop_id: null })
    .eq('marketplace_barbershop_id', barbershopId);

  if (clearError) throw clearError;

  if (!branchIds.length) return null;

  const { error: assignError } = await db
    .from('branches')
    .update({ marketplace_barbershop_id: barbershopId })
    .in('id', branchIds);

  if (assignError) throw assignError;
  return null;
};

const isRealMarketplaceBarbershop = (row) => !row?.metadata?.legacy_branch_id && row?.metadata?.fallback !== true;

const selectFields = 'id,name,description,logo_url,cover_url,address,city,work_hours,timezone,is_active,sort_order,metadata,created_at,updated_at';
const tableName = 'marketplace_barbershops';

const merchantItem = (row) => ({
  branch_id: row?.branch_id || null,
  id: row?.id,
  login: row?.login || null,
  marketplace_barbershop_id: row?.marketplace_barbershop_id || null,
  role: row?.role || null,
});

const isMissingColumnError = (error, column) => {
  const message = String(error?.message || error?.details || '').toLowerCase();
  return Boolean(error) && message.includes(column.toLowerCase()) && (
    message.includes('does not exist') ||
    message.includes('could not find') ||
    message.includes('schema cache')
  );
};

class MarketplaceBarbershops {
  async list(req, res) {
    try {
      const { active } = req.query || {};

      let query = db.from(tableName).select(selectFields);

      if (active !== undefined) {
        const activeFlag = parseBoolean(active, null);
        if (activeFlag === null) {
          return res.status(400).json({ error: 'active must be a boolean' });
        }
        query = query.eq('is_active', activeFlag);
      }

      const { data, error } = await query
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true });
      if (error) return res.status(500).json({ error: error.message });

      return res.json({ data: (data || []).filter(isRealMarketplaceBarbershop) });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }

  async getById(req, res) {
    try {
      const { id } = req.params || {};
      if (!id) return res.status(400).json({ error: 'id is required' });

      const { data, error } = await db
        .from(tableName)
        .select(selectFields)
        .eq('id', id)
        .maybeSingle();

      if (error) return res.status(500).json({ error: error.message });
      if (!data || !isRealMarketplaceBarbershop(data)) return res.status(404).json({ error: 'Barbershop not found' });

      return res.json({ entry: data });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }

  async create(req, res) {
    try {
      const {
        name,
        description,
        logo_url,
        cover_url,
        address,
        city,
        work_hours,
        timezone,
        is_active,
        sort_order,
        metadata,
        branch_ids,
      } = req.body || {};

      const normalizedName = normalizeText(name);
      if (!normalizedName) {
        return res.status(400).json({ error: 'name is required' });
      }

      const parsedWorkHours = parseWorkHours(work_hours);
      if (parsedWorkHours === '__invalid__') {
        return res.status(400).json({ error: 'work_hours must be an object or valid JSON string' });
      }

      const parsedBranchIds = parseBranchIds(branch_ids);
      if (parsedBranchIds === '__invalid__') {
        return res.status(400).json({ error: 'branch_ids must be an array' });
      }

      const payload = {
        name: normalizedName,
        description: normalizeText(description) ?? null,
        logo_url: normalizeText(logo_url) ?? null,
        cover_url: normalizeText(cover_url) ?? null,
        address: normalizeText(address) ?? null,
        city: normalizeText(city) ?? null,
        work_hours: parsedWorkHours ?? null,
        timezone: normalizeText(timezone) ?? null,
        is_active: parseBoolean(is_active, true),
        sort_order: Number.isFinite(Number(sort_order)) ? Number(sort_order) : 0,
        metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {},
      };

      const { data, error } = await db
        .from(tableName)
        .insert(payload)
        .select(selectFields)
        .maybeSingle();

      if (error) return res.status(500).json({ error: error.message });

      try {
        await syncBranches(data.id, parsedBranchIds);
      } catch (branchError) {
        return res.status(500).json({ error: branchError.message });
      }

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

      const {
        name,
        description,
        logo_url,
        cover_url,
        address,
        city,
        work_hours,
        timezone,
        is_active,
        sort_order,
        metadata,
        branch_ids,
      } = req.body || {};

      const update = {};

      if (name !== undefined) {
        const normalizedName = normalizeText(name);
        if (!normalizedName) return res.status(400).json({ error: 'name cannot be empty' });
        update.name = normalizedName;
      }

      if (description !== undefined) update.description = normalizeText(description);
      if (logo_url !== undefined) update.logo_url = normalizeText(logo_url);
      if (cover_url !== undefined) update.cover_url = normalizeText(cover_url);
      if (address !== undefined) update.address = normalizeText(address);
      if (city !== undefined) update.city = normalizeText(city);
      if (timezone !== undefined) update.timezone = normalizeText(timezone);
      if (sort_order !== undefined) {
        const parsedSortOrder = Number(sort_order);
        if (!Number.isFinite(parsedSortOrder)) {
          return res.status(400).json({ error: 'sort_order must be a number' });
        }
        update.sort_order = parsedSortOrder;
      }
      if (metadata !== undefined) {
        if (metadata !== null && (typeof metadata !== 'object' || Array.isArray(metadata))) {
          return res.status(400).json({ error: 'metadata must be an object' });
        }
        update.metadata = metadata || {};
      }

      const parsedBranchIds = parseBranchIds(branch_ids);
      if (parsedBranchIds === '__invalid__') {
        return res.status(400).json({ error: 'branch_ids must be an array' });
      }

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

      update.updated_at = new Date().toISOString();

      const { data, error } = await db
        .from(tableName)
        .update(update)
        .eq('id', id)
        .select(selectFields)
        .maybeSingle();

      if (error) return res.status(500).json({ error: error.message });
      if (!data) return res.status(404).json({ error: 'Barbershop not found' });

      try {
        await syncBranches(id, parsedBranchIds);
      } catch (branchError) {
        return res.status(500).json({ error: branchError.message });
      }

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

      const { data, error } = await db
        .from(tableName)
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

      const { data, error } = await db
        .from(tableName)
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

  async remove(req, res) {
    try {
      const { id } = req.params || {};
      if (!id) return res.status(400).json({ error: 'id is required' });

      const clearResults = await Promise.all([
        db.from('branches').update({ marketplace_barbershop_id: null }).eq('marketplace_barbershop_id', id),
        db.from('users').update({ marketplace_barbershop_id: null }).eq('marketplace_barbershop_id', id),
      ]);

      const clearError = clearResults.find((result) => result.error && !isMissingColumnError(result.error, 'marketplace_barbershop_id'))?.error;
      if (clearError) return res.status(500).json({ error: clearError.message });

      const { data, error } = await db
        .from(tableName)
        .delete()
        .eq('id', id)
        .select('id')
        .maybeSingle();

      if (error) return res.status(500).json({ error: error.message });
      if (!data) return res.status(404).json({ error: 'Barbershop not found' });

      return res.json({ deleted: true, id: data.id });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }

  async listMerchants(req, res) {
    try {
      const { id } = req.params || {};
      if (!id) return res.status(400).json({ error: 'id is required' });

      const { data: shop, error: shopError } = await db
        .from(tableName)
        .select('id')
        .eq('id', id)
        .maybeSingle();

      if (shopError) return res.status(500).json({ error: shopError.message });
      if (!shop) return res.status(404).json({ error: 'Barbershop not found' });

      const { data, error, count } = await db
        .from('users')
        .select('id, login, role, branch_id, marketplace_barbershop_id', { count: 'exact' })
        .eq('marketplace_barbershop_id', id)
        .eq('role', 'merchant')
        .order('login', { ascending: true });

      if (error) {
        if (isMissingColumnError(error, 'marketplace_barbershop_id')) {
          return res.status(501).json({
            error: 'users.marketplace_barbershop_id column is missing',
            hint: 'Apply db/postgres/users.sql on the backend database.',
          });
        }
        return res.status(500).json({ error: error.message });
      }

      const items = (data || []).map(merchantItem);
      return res.json({ items, total: count ?? items.length });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }

  async createMerchant(req, res) {
    try {
      const { id } = req.params || {};
      const { login, password } = req.body || {};

      if (!id) return res.status(400).json({ error: 'id is required' });
      const normalizedLogin = normalizeText(login);
      if (!normalizedLogin) return res.status(400).json({ error: 'login is required' });
      if (!password || String(password).length < 6) {
        return res.status(400).json({ error: 'password must be at least 6 characters' });
      }

      const { data: shop, error: shopError } = await db
        .from(tableName)
        .select('id')
        .eq('id', id)
        .maybeSingle();

      if (shopError) return res.status(500).json({ error: shopError.message });
      if (!shop) return res.status(404).json({ error: 'Barbershop not found' });

      const { data, error } = await db
        .from('users')
        .insert({
          login: normalizedLogin,
          marketplace_barbershop_id: id,
          password_hash: bcrypto.hashSync(String(password), 10),
          role: 'merchant',
        })
        .select('id, login, role, branch_id, marketplace_barbershop_id')
        .maybeSingle();

      if (error) {
        if (isMissingColumnError(error, 'marketplace_barbershop_id')) {
          return res.status(501).json({
            error: 'users.marketplace_barbershop_id column is missing',
            hint: 'Apply db/postgres/users.sql on the backend database.',
          });
        }

        const status = error.code === '23505' ? 409 : 500;
        return res.status(status).json({ error: error.code === '23505' ? 'login already taken' : error.message });
      }

      return res.status(201).json({ item: merchantItem(data) });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }

  async deleteMerchant(req, res) {
    try {
      const { id } = req.params || {};
      const merchantId = normalizeText(req.body?.id || req.query?.id);
      if (!id) return res.status(400).json({ error: 'id is required' });
      if (!merchantId) return res.status(400).json({ error: 'merchant id is required' });

      const { data, error } = await db
        .from('users')
        .delete()
        .eq('id', merchantId)
        .eq('marketplace_barbershop_id', id)
        .eq('role', 'merchant')
        .select('id, login, role, branch_id, marketplace_barbershop_id')
        .maybeSingle();

      if (error) {
        if (isMissingColumnError(error, 'marketplace_barbershop_id')) {
          return res.status(501).json({
            error: 'users.marketplace_barbershop_id column is missing',
            hint: 'Apply db/postgres/users.sql on the backend database.',
          });
        }
        return res.status(500).json({ error: error.message });
      }

      if (!data) return res.status(404).json({ error: 'Merchant account not found' });

      return res.json({ deleted: true, id: data.id, item: merchantItem(data) });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }
}

module.exports = new MarketplaceBarbershops();
