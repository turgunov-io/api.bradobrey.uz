// Kiosk device registration and socket-ticket authorization (audit C5).
//   (callers: models/kiosk.js register(), socketTicket(), listDevices(), removeDevice())
//
// Registration is open (no staff login on the kiosk) but can never take over a
// kiosk that already holds a device token: registering a (branch_id,
// device_name) that has one answers 409, and other branches' rows are never
// touched. A branch may have several kiosks. To re-pair a device (app data
// wiped, moved to another branch), staff delete it via removeKiosk() first;
// routers/kiosk.js rate-limits registration and staff-guards list/delete.
//
// Each registration returns a fresh random device token; only its SHA-256 is
// stored. Socket tickets then require that token. Rows from before device
// tokens (device_token_hash is null) keep the old branch_id + device_name
// check, and may register once to obtain a token.
//
// Enrollment (MULTI_TENANCY 0.2): when KIOSK_ENROLLMENT_CODE is set, register
// requires a matching body.enrollment_code (constant-time compare) or a staff
// actor, loaded from the DB (non-archived; role and allowed branches from the
// DB, not the JWT), whose scope covers the branch (dashboard registration). Unset keeps the
// open behaviour and logs a warning once.
//
// authenticateDevice() resolves the X-Kiosk-Token header for
// middleware/kioskAuth.js to { id, branchId }.
const crypto = require('crypto');

const { BRANCH_ROLES, NETWORK_ROLES } = require('../utils/employeeQualityAccess');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DEVICE_NAME_LENGTH = 200;
const DEVICE_TOKEN_BYTES = 32;
const MAX_DEVICE_TOKEN_LENGTH = 512;

const hashDeviceToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

const normalizeDeviceName = (value) => String(value ?? '').trim();

function tokenMatches(token, expectedHash) {
  if (!token) return false;
  const actual = Buffer.from(hashDeviceToken(token), 'hex');
  const expected = Buffer.from(String(expectedHash), 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Hashing both sides gives equal-length buffers, so the compare is constant-time
// regardless of the submitted code's length.
function secretMatches(submitted, configured) {
  if (typeof submitted !== 'string' || !submitted) return false;
  const actual = crypto.createHash('sha256').update(submitted).digest();
  const expected = crypto.createHash('sha256').update(String(configured)).digest();
  return crypto.timingSafeEqual(actual, expected);
}

const envEnrollmentCode = () => String(process.env.KIOSK_ENROLLMENT_CODE || '').trim();

// Verified JWT claims -> the staff actor as stored in the DB:
// { id, role, branchScope } (branchScope null = network role), or null when
// the subject is not an existing, non-archived employee. The token's own
// role/branch claims are never used.
async function loadDbActor(claims) {
  const userId = String(claims?.sub || claims?.id || '');
  if (!UUID_PATTERN.test(userId)) return null;
  const { loadEmployeeAccessState, isArchivedEmployee } = require('../middleware/employeeAccess');
  const state = await loadEmployeeAccessState(userId);
  if (!state?.user || isArchivedEmployee(state.barber)) return null;
  const role = String(state.user.role || '').trim().toLowerCase();
  const { resolveAllowedBranchIds } = require('../utils/adminAuth');
  const branchScope = await resolveAllowedBranchIds({ ...state.user, role });
  return { id: state.user.id, role, branchScope };
}

// Resolved lazily so the registry logic can be tested without a database.
const pool = () => require('../config/postgres').pool;

const pgKioskRepo = {
  async branchExists(branchId) {
    const result = await pool().query('select 1 from branches where id = $1 limit 1', [branchId]);
    return result.rowCount > 0;
  },

  // Returns null when the row already holds a token (the conditional upsert
  // keeps concurrent registrations from overwriting each other).
  async saveKiosk({ branchId, deviceName, tokenHash }) {
    const result = await pool().query(
      `insert into kiosks (branch_id, device_name, device_token_hash)
       values ($1, $2, $3)
       on conflict (branch_id, device_name)
       do update set device_token_hash = excluded.device_token_hash, updated_at = now()
       where kiosks.device_token_hash is null
       returning id, branch_id, device_name`,
      [branchId, deviceName, tokenHash],
    );
    return result.rows[0] || null;
  },

  async findKioskById(id) {
    const result = await pool().query('select id, branch_id from kiosks where id = $1 limit 1', [id]);
    return result.rows[0] || null;
  },

  async listKiosks({ branchId }) {
    const result = await pool().query(
      `select k.id, k.branch_id, b.name as branch_name, k.device_name,
              k.device_token_hash, k.created_at, k.updated_at
         from kiosks k
         left join branches b on b.id = k.branch_id
        where ($1::uuid is null or k.branch_id = $1)
        order by b.name nulls last, k.created_at desc`,
      [branchId || null],
    );
    return result.rows;
  },

  async deleteKiosk(id) {
    await pool().query('delete from kiosks where id = $1', [id]);
  },

  async findKioskByTokenHash(tokenHash) {
    const result = await pool().query(
      'select id, branch_id from kiosks where device_token_hash = $1 limit 1',
      [tokenHash],
    );
    return result.rows[0] || null;
  },

  async findKiosk({ branchId, deviceName }) {
    const result = await pool().query(
      `select id, branch_id, device_name, device_token_hash
         from kiosks
        where branch_id = $1 and device_name = $2
        limit 1`,
      [branchId, deviceName],
    );
    return result.rows[0] || null;
  },
};

function createKioskRegistry({
  repo = pgKioskRepo,
  enrollmentCode = envEnrollmentCode,
  loadActor = loadDbActor,
  warn = console.warn,
} = {}) {
  const fail = (status, error) => ({ status, body: { error } });
  let warnedOpenEnrollment = false;

  // Branch roles only see and manage their own branch; network roles see all.
  function scopedBranchId(actor, requestedBranchId) {
    const role = String(actor?.role || '').toLowerCase();
    if (NETWORK_ROLES.has(role)) return { branchId: requestedBranchId || null };
    const ownBranchId = BRANCH_ROLES.has(role) ? String(actor?.branch_id || '') : '';
    if (!ownBranchId) return { denied: true };
    if (requestedBranchId && String(requestedBranchId) !== ownBranchId) return { denied: true };
    return { branchId: ownBranchId };
  }

  // Staff in scope (dashboard) or the shared enrollment code may register.
  // The staff actor is loaded from the DB (role + allowed branches); the
  // JWT only identifies the subject.
  async function enrollmentAllowed({ branchId, enrollmentCode: submitted, actorClaims }) {
    const configured = enrollmentCode();
    if (!configured) {
      if (!warnedOpenEnrollment) {
        warnedOpenEnrollment = true;
        warn('[kiosk] KIOSK_ENROLLMENT_CODE is not set: POST /api/kiosk/register is open to any device');
      }
      return true;
    }
    if (secretMatches(submitted, configured)) return true;
    if (!actorClaims) return false;
    const actor = await loadActor(actorClaims);
    const role = String(actor?.role || '').toLowerCase();
    if (!NETWORK_ROLES.has(role) && !BRANCH_ROLES.has(role)) return false;
    if (actor.branchScope === null) return true;
    return (actor.branchScope || []).some((id) => String(id).toLowerCase() === String(branchId).toLowerCase());
  }

  async function register({ branchId, deviceName, enrollmentCode: submitted, actorClaims = null }) {
    const name = normalizeDeviceName(deviceName);
    if (!UUID_PATTERN.test(String(branchId || '')) || !name) {
      return fail(400, 'branch_id and device_name are required');
    }
    if (name.length > MAX_DEVICE_NAME_LENGTH) return fail(400, 'device_name is too long');
    if (!(await enrollmentAllowed({ branchId, enrollmentCode: submitted, actorClaims }))) {
      return {
        status: 403,
        body: { error: 'Kiosk enrollment code is invalid', code: 'KIOSK_ENROLLMENT_CODE_INVALID' },
      };
    }

    if (!(await repo.branchExists(branchId))) return fail(404, 'Branch not found');

    const deviceToken = crypto.randomBytes(DEVICE_TOKEN_BYTES).toString('base64url');
    const kiosk = await repo.saveKiosk({ branchId, deviceName: name, tokenHash: hashDeviceToken(deviceToken) });
    if (!kiosk) {
      return {
        status: 409,
        body: { error: 'Kiosk is already registered', code: 'KIOSK_ALREADY_REGISTERED' },
      };
    }

    return {
      status: 201,
      body: { branch_id: kiosk.branch_id, kiosk_id: kiosk.id, device_token: deviceToken },
    };
  }

  async function listKiosks({ actor, branchId }) {
    if (branchId && !UUID_PATTERN.test(String(branchId))) return fail(400, 'branch_id is invalid');
    const scope = scopedBranchId(actor, branchId);
    if (scope.denied) return fail(403, 'Branch is outside the authenticated user scope');

    const rows = await repo.listKiosks({ branchId: scope.branchId });
    const entry = rows.map(({ device_token_hash: tokenHash, ...row }) => ({ ...row, has_device_token: Boolean(tokenHash) }));
    return { status: 200, body: { entry } };
  }

  async function removeKiosk({ id, actor }) {
    if (!UUID_PATTERN.test(String(id || ''))) return fail(400, 'Kiosk id is invalid');
    const kiosk = await repo.findKioskById(id);
    if (!kiosk) return fail(404, 'Kiosk not found');
    if (scopedBranchId(actor, kiosk.branch_id).denied) {
      return fail(403, 'Branch is outside the authenticated user scope');
    }
    await repo.deleteKiosk(id);
    return { status: 204 };
  }

  async function authorizeTicket({ branchId, deviceName, deviceToken }) {
    const name = normalizeDeviceName(deviceName);
    if (!UUID_PATTERN.test(String(branchId || '')) || !name) {
      return fail(400, 'branch_id and device_name are required');
    }

    const kiosk = await repo.findKiosk({ branchId, deviceName: name });
    if (!kiosk) return fail(403, 'Kiosk is not registered for this branch');
    if (kiosk.device_token_hash && !tokenMatches(deviceToken, kiosk.device_token_hash)) {
      return fail(403, 'Kiosk device token is invalid');
    }

    return { status: 200, kiosk };
  }

  // Device token -> kiosk identity, or null when unknown/malformed.
  async function authenticateDevice(token) {
    if (typeof token !== 'string' || !token || token.length > MAX_DEVICE_TOKEN_LENGTH) return null;
    const kiosk = await repo.findKioskByTokenHash(hashDeviceToken(token));
    if (!kiosk?.id || !kiosk.branch_id) return null;
    return { id: kiosk.id, branchId: String(kiosk.branch_id) };
  }

  return { authenticateDevice, authorizeTicket, listKiosks, register, removeKiosk };
}

const kioskRegistry = createKioskRegistry();

module.exports = {
  createKioskRegistry,
  hashDeviceToken,
  kioskRegistry,
};
