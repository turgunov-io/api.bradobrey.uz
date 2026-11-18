const express = require('express');

const barbershops = require('../../models/marketplace/barbershops');

const { pool } = require('../../config/postgres');
const { staffAccess } = require('../../middleware/staffAccess');

const router = express.Router();

// Dashboard-only (audit C3). The customer app reads the public catalog through
// /api/marketplace/catalog, not this router. Reads need a signed-in account;
// merchant logins and every change are for network administrators only.
const canRead = staffAccess.authenticated();
const canManage = staffAccess.requireSuperuser();

// Fields a merchant may change on its own barbershop (mirrors the dashboard's
// server/api/merchant/barbershop.patch.ts); branch links stay admin-only.
const OWNER_EDITABLE_FIELDS = [
  'address', 'city', 'cover_url', 'description', 'is_active', 'logo_url',
  'metadata', 'name', 'sort_order', 'timezone', 'work_hours',
];
const SUPERUSER_ROLES = new Set(['admin_network', 'admin']);

// Network administrators edit any barbershop; a merchant account only the one
// linked through users.marketplace_barbershop_id, limited to owner fields.
async function canEdit(req, res, next) {
  if (SUPERUSER_ROLES.has(req.staffAccess.role)) return next();
  try {
    const result = await pool.query(
      'select 1 from users where id = $1 and marketplace_barbershop_id::text = $2 limit 1',
      [req.staffAccess.actor.id, String(req.params.id || '')],
    );
    if (!result.rowCount) return res.status(403).json({ error: 'Not allowed to edit this barbershop' });
  } catch (error) {
    console.error('[barbershops] ownership check failed:', error?.code || error?.message);
    return res.status(500).json({ error: 'Failed to authorize request' });
  }
  const body = req.body || {};
  req.body = Object.fromEntries(OWNER_EDITABLE_FIELDS.filter((field) => field in body).map((field) => [field, body[field]]));
  return next();
}

router.get('/', canRead, (req, res) => barbershops.list(req, res));
router.get('/:id/merchant', canManage, (req, res) => barbershops.listMerchants(req, res));
router.get('/:id', canRead, (req, res) => barbershops.getById(req, res));

router.post('/', canManage, (req, res) => barbershops.create(req, res));
router.post('/:id/merchant', canManage, (req, res) => barbershops.createMerchant(req, res));
router.delete('/:id/merchant', canManage, (req, res) => barbershops.deleteMerchant(req, res));
router.patch('/:id', canRead, canEdit, (req, res) => barbershops.update(req, res));
router.post('/:id/activate', canManage, (req, res) => barbershops.activate(req, res));
router.post('/:id/deactivate', canManage, (req, res) => barbershops.deactivate(req, res));
router.delete('/:id', canManage, (req, res) => barbershops.remove(req, res));

module.exports = router;

