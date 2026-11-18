// Platform-owner company management (MULTI_TENANCY Phase 1 step B1, owner
// decision D4: the platform owner only manages companies — no statistics,
// no clients, no company data).
//
//   POST  /api/platform/login                 { login, password } -> platform_owner token
//   GET   /api/platform/companies             list companies
//   POST  /api/platform/companies             create { name, code, currency?, timezone?, logo_url?, primary_color? }
//   PATCH /api/platform/companies/:id         name, code, status, branding fields,
//                                             kiosk_enrollment_code (string = set/rotate, null = clear;
//                                             stored hashed, never returned — has_kiosk_enrollment_code only)
//   POST  /api/platform/companies/:id/admins  first company admin { login, password }
//
// Multi-company gate (security review H2/M1): creating a company, or
// re-activating a suspended non-default one, is 409 MULTI_COMPANY_PRECONDITIONS
// unless kiosk auth is enforced (KIOSK_AUTH_ENFORCE) and the DB runs with
// app.tenant_strict = 'on' (MULTI_TENANCY 9.9). The response lists `failed`.
//
// requirePlatformOwner loads the caller from the DB: role platform_owner and
// no company (users_company_membership_check). The token's role is ignored.
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { getBearerToken, verifyStaffToken } = require('../utils/authToken');
const { PLATFORM_OWNER_ROLE, normalizeCompanyCode } = require('../utils/tenant');
const { isKioskAuthEnforced } = require('../middleware/kioskAuth');
const { hashEnrollmentCode, validateEnrollmentCode } = require('../utils/kioskEnrollmentCode');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MAX_NAME_LENGTH = 120;
const MAX_URL_LENGTH = 2048;
const MAX_LOGIN_LENGTH = 64;
const MIN_ADMIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const BCRYPT_ROUNDS = 10; // same cost as employee creation (models/barbers.js)
const COMPANY_STATUSES = new Set(['active', 'suspended']);

const CREATE_FIELDS = new Set(['name', 'code', 'currency', 'timezone', 'logo_url', 'primary_color']);
const UPDATE_FIELDS = new Set([...CREATE_FIELDS, 'status', 'kiosk_enrollment_code']);
// Request field -> stored column, for fields that are not stored as sent.
const STORED_AS = { kiosk_enrollment_code: 'kiosk_enrollment_code_hash' };
const UPDATE_COLUMNS = new Set([...UPDATE_FIELDS].map((field) => STORED_AS[field] || field));

// The enrollment hash itself is never selected into a response.
const COMPANY_COLUMNS = 'id, name, code, status, currency, timezone, logo_url, primary_color, is_default, '
  + '(kiosk_enrollment_code_hash is not null) as has_kiosk_enrollment_code, created_at, updated_at';

const TENANT_STRICT_ON = 'on';
const MULTI_COMPANY_PRECONDITIONS = 'MULTI_COMPANY_PRECONDITIONS';

function isValidTimezone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch (_error) {
    return false;
  }
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch (_error) {
    return false;
  }
}

// Each validator returns [value] or [undefined, error].
const FIELD_VALIDATORS = {
  name(value) {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name || name.length > MAX_NAME_LENGTH) return [undefined, `name must be 1-${MAX_NAME_LENGTH} characters`];
    return [name];
  },
  code(value) {
    const code = normalizeCompanyCode(value);
    if (!code) return [undefined, 'code must be 2-32 letters, digits, "_" or "-", starting with a letter or digit'];
    return [code.toUpperCase()];
  },
  status(value) {
    return COMPANY_STATUSES.has(value) ? [value] : [undefined, 'status must be active or suspended'];
  },
  currency(value) {
    const currency = typeof value === 'string' ? value.trim().toUpperCase() : '';
    return CURRENCY_PATTERN.test(currency) ? [currency] : [undefined, 'currency must be a 3-letter ISO code'];
  },
  timezone(value) {
    const timezone = typeof value === 'string' ? value.trim() : '';
    return timezone && isValidTimezone(timezone) ? [timezone] : [undefined, 'timezone must be an IANA time zone'];
  },
  logo_url(value) {
    if (value === null) return [null];
    const url = typeof value === 'string' ? value.trim() : '';
    if (!url || url.length > MAX_URL_LENGTH || !isHttpUrl(url)) return [undefined, 'logo_url must be an http(s) URL or null'];
    return [url];
  },
  primary_color(value) {
    if (value === null) return [null];
    return typeof value === 'string' && COLOR_PATTERN.test(value) ? [value] : [undefined, 'primary_color must be #RRGGBB or null'];
  },
  // Normalized to the stored hash (null clears the company's code).
  kiosk_enrollment_code(value) {
    if (value === null) return [null];
    const [code, error] = validateEnrollmentCode(value);
    return error ? [undefined, error] : [hashEnrollmentCode(code)];
  },
};

/**
 * @param {Record<string, unknown>} body
 * @param {{ partial?: boolean }} [options] partial = PATCH (status allowed, nothing required)
 * @returns {{ fields: Record<string, unknown> } | { error: string }}
 */
function validateCompanyFields(body, { partial = false } = {}) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const allowed = partial ? UPDATE_FIELDS : CREATE_FIELDS;
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length) return { error: `Unsupported fields: ${unknown.join(', ')}` };

  const fields = {};
  for (const [key, value] of Object.entries(input)) {
    const [normalized, error] = FIELD_VALIDATORS[key](value);
    if (error) return { error };
    fields[STORED_AS[key] || key] = normalized;
  }
  if (!partial && (!fields.name || !fields.code)) return { error: 'name and code are required' };
  if (partial && Object.keys(fields).length === 0) return { error: 'No fields to update' };
  return { fields };
}

const pool = () => require('../config/postgres').pool;

const platformRepo = {
  async listCompanies() {
    const result = await pool().query(`select ${COMPANY_COLUMNS} from companies order by created_at asc, id asc`);
    return result.rows;
  },

  async findCompanyById(id) {
    const result = await pool().query(`select ${COMPANY_COLUMNS} from companies where id = $1 limit 1`, [id]);
    return result.rows[0] || null;
  },

  async createCompany(fields) {
    const columns = Object.keys(fields);
    const result = await pool().query(
      `insert into companies (${columns.join(', ')})
       values (${columns.map((_, index) => `$${index + 1}`).join(', ')})
       returning ${COMPANY_COLUMNS}`,
      columns.map((column) => fields[column]),
    );
    return result.rows[0];
  },

  // app.tenant_strict of this connection (alter database ... set applies to
  // new connections), or null when unset.
  async tenantStrictSetting() {
    const result = await pool().query("select current_setting('app.tenant_strict', true) as value");
    return result.rows[0]?.value ?? null;
  },

  // Columns come from the validated whitelist (UPDATE_COLUMNS), never the request.
  async updateCompany(id, fields) {
    const columns = Object.keys(fields).filter((column) => UPDATE_COLUMNS.has(column));
    const result = await pool().query(
      `update companies
          set ${columns.map((column, index) => `${column} = $${index + 2}`).join(', ')}
        where id = $1
        returning ${COMPANY_COLUMNS}`,
      [id, ...columns.map((column) => fields[column])],
    );
    return result.rows[0] || null;
  },

  async loginTakenInCompany(companyId, login) {
    const result = await pool().query('select 1 from users where company_id = $1 and login = $2 limit 1', [companyId, login]);
    return result.rowCount > 0;
  },

  async createCompanyAdmin({ companyId, login, passwordHash }) {
    const result = await pool().query(
      `insert into users (login, password_hash, role, company_id, branch_id)
       values ($1, $2, 'admin', $3, null)
       returning id, login, role, company_id`,
      [login, passwordHash, companyId],
    );
    return result.rows[0];
  },

  async findPlatformOwnerByLogin(login) {
    const result = await pool().query(
      `select id, login, role, company_id, password_hash
         from users
        where login = $1 and role = $2 and company_id is null
        limit 1`,
      [login, PLATFORM_OWNER_ROLE],
    );
    return result.rows[0] || null;
  },

  async findUserById(id) {
    const result = await pool().query('select id, role, company_id from users where id = $1 limit 1', [id]);
    return result.rows[0] || null;
  },
};

const isUniqueViolation = (error) => String(error?.code || '') === '23505';

/**
 * Preconditions for running more than one company (MULTI_TENANCY 9.9).
 * @param {{ env?: Record<string, string|undefined>, repo?: { tenantStrictSetting(): Promise<string|null> } }} [deps]
 * @returns {Promise<string[]>} failing preconditions; empty = allowed
 */
async function multiCompanyPreconditions({ env = process.env, repo = platformRepo } = {}) {
  const failed = [];
  if (!isKioskAuthEnforced(env)) failed.push('KIOSK_AUTH_ENFORCE');
  if ((await repo.tenantStrictSetting()) !== TENANT_STRICT_ON) failed.push('TENANT_STRICT');
  return failed;
}

// Never let the enrollment hash leave the API, whatever the repo returned.
const publicCompany = (row) => {
  if (!row) return row;
  const { kiosk_enrollment_code_hash: _hash, ...company } = row;
  return company;
};

function createPlatformOwnerGuard({ loadUser = (id) => platformRepo.findUserById(id), secret } = {}) {
  return async function requirePlatformOwner(req, res, next) {
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: 'Authorization token is required' });
    let payload;
    try {
      payload = verifyStaffToken(token, { secret });
    } catch (_error) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    const userId = String(payload?.sub || payload?.id || '');
    if (!UUID_PATTERN.test(userId)) return res.status(401).json({ error: 'Invalid token payload' });

    let user;
    try {
      user = await loadUser(userId);
    } catch (error) {
      console.error('[platform] authorization failed:', error?.code || error?.message);
      return res.status(500).json({ error: 'Failed to authorize request' });
    }
    if (!user) return res.status(401).json({ error: 'Session is no longer valid' });
    if (String(user.role || '').trim().toLowerCase() !== PLATFORM_OWNER_ROLE || user.company_id) {
      return res.status(403).json({ code: 'PLATFORM_OWNER_REQUIRED', error: 'Only the platform owner can manage companies' });
    }
    req.platformOwner = { id: user.id };
    req.tenant = { companyId: null, isPlatformOwner: true };
    return next();
  };
}

function createPlatformController({
  repo = platformRepo,
  hashPassword = (password) => bcrypt.hashSync(password, BCRYPT_ROUNDS),
  comparePassword = (password, hash) => bcrypt.compareSync(password, hash),
  signToken = (claims) => jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '12h' }),
  env = process.env,
} = {}) {
  const internalError = (res, action, error) => {
    console.error(`[platform] ${action} failed:`, error?.code || error?.message);
    return res.status(500).json({ error: `Failed to ${action}` });
  };

  // Responds 409 and returns true when a second active company is not allowed yet.
  async function refuseMultiCompany(res) {
    const failed = await multiCompanyPreconditions({ env, repo });
    if (!failed.length) return false;
    res.status(409).json({
      code: MULTI_COMPANY_PRECONDITIONS,
      error: 'Multi-company preconditions are not met (see MULTI_TENANCY.md 9.9)',
      failed,
    });
    return true;
  }

  async function login(req, res) {
    const login = typeof req.body?.login === 'string' ? req.body.login.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!login || !password) return res.status(400).json({ error: 'Invalid credentials' });
    try {
      const user = await repo.findPlatformOwnerByLogin(login);
      if (!user || !user.password_hash || !comparePassword(password, user.password_hash)) {
        return res.status(400).json({ error: 'Invalid credentials' });
      }
      const token = signToken({ sub: user.id, login: user.login, role: PLATFORM_OWNER_ROLE, companyId: null });
      return res.status(200).json({ token, user: { id: user.id, login: user.login, role: PLATFORM_OWNER_ROLE } });
    } catch (error) {
      return internalError(res, 'log in', error);
    }
  }

  async function listCompanies(_req, res) {
    try {
      return res.status(200).json({ companies: (await repo.listCompanies()).map(publicCompany) });
    } catch (error) {
      return internalError(res, 'load companies', error);
    }
  }

  async function createCompany(req, res) {
    const { fields, error } = validateCompanyFields(req.body);
    if (error) return res.status(400).json({ error });
    try {
      if (await refuseMultiCompany(res)) return res;
      return res.status(201).json({ company: publicCompany(await repo.createCompany(fields)) });
    } catch (dbError) {
      if (isUniqueViolation(dbError)) return res.status(409).json({ code: 'COMPANY_CODE_TAKEN', error: 'Company code is already taken' });
      return internalError(res, 'create company', dbError);
    }
  }

  async function updateCompany(req, res) {
    const id = String(req.params?.id || '');
    if (!UUID_PATTERN.test(id)) return res.status(404).json({ error: 'Company not found' });
    const { fields, error } = validateCompanyFields(req.body, { partial: true });
    if (error) return res.status(400).json({ error });
    try {
      const current = await repo.findCompanyById(id);
      if (!current) return res.status(404).json({ error: 'Company not found' });
      // The default company is the transitional fallback tenant (legacy kiosks,
      // barber app, dash): suspending it would lock out every legacy client.
      if (current.is_default && fields.status === 'suspended') {
        return res.status(409).json({ code: 'DEFAULT_COMPANY_SUSPEND_FORBIDDEN', error: 'The default company cannot be suspended' });
      }
      const reactivates = !current.is_default && current.status === 'suspended' && fields.status === 'active';
      if (reactivates && await refuseMultiCompany(res)) return res;
      const company = await repo.updateCompany(id, fields);
      if (!company) return res.status(404).json({ error: 'Company not found' });
      return res.status(200).json({ company: publicCompany(company) });
    } catch (dbError) {
      if (isUniqueViolation(dbError)) return res.status(409).json({ code: 'COMPANY_CODE_TAKEN', error: 'Company code is already taken' });
      return internalError(res, 'update company', dbError);
    }
  }

  async function createCompanyAdmin(req, res) {
    const id = String(req.params?.id || '');
    if (!UUID_PATTERN.test(id)) return res.status(404).json({ error: 'Company not found' });
    const login = typeof req.body?.login === 'string' ? req.body.login.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!login || login.length > MAX_LOGIN_LENGTH || /\s/.test(login)) {
      return res.status(400).json({ error: `login must be 1-${MAX_LOGIN_LENGTH} characters without spaces` });
    }
    if (password.length < MIN_ADMIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `password must be ${MIN_ADMIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters` });
    }
    try {
      const company = await repo.findCompanyById(id);
      if (!company) return res.status(404).json({ error: 'Company not found' });
      if (await repo.loginTakenInCompany(company.id, login)) {
        return res.status(409).json({ code: 'LOGIN_TAKEN', error: 'login already taken' });
      }
      const user = await repo.createCompanyAdmin({ companyId: company.id, login, passwordHash: hashPassword(password) });
      return res.status(201).json({ user: { id: user.id, login: user.login, role: user.role, company_id: user.company_id } });
    } catch (dbError) {
      // Logins are still globally unique until 007_drop_global_uniques is applied.
      if (isUniqueViolation(dbError)) return res.status(409).json({ code: 'LOGIN_TAKEN', error: 'login already taken' });
      return internalError(res, 'create company admin', dbError);
    }
  }

  return { createCompany, createCompanyAdmin, listCompanies, login, updateCompany };
}

module.exports = {
  createPlatformController,
  createPlatformOwnerGuard,
  multiCompanyPreconditions,
  platform: createPlatformController(),
  platformRepo,
  requirePlatformOwner: createPlatformOwnerGuard(),
  validateCompanyFields,
};
