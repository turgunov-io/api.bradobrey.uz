const express = require('express');
const multer = require('multer');
const services = require('../models/services');
const { staffAccess } = require('../middleware/staffAccess');
const { attachBranchScope: withBranchScope } = require('../utils/adminAuth');
const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// Reads: any signed-in account, limited to its branches plus shared services.
// Writes: services.manage, checked before multer, limited to its branches.
const canRead = [staffAccess.authenticated(), withBranchScope];
const canManage = [staffAccess.requireStaff({ anyOf: ['services.manage'] }), withBranchScope];

router.get('/', canRead, (req, res) => services.list(req, res));
router.patch('/reorder', canManage, (req, res) => services.reorder(req, res));
router.get('/:id', canRead, (req, res) => services.getById(req, res));
router.post('/', canManage, upload.single('file'), (req, res) => services.create(req, res));
router.patch('/:id', canManage, upload.single('file'), (req, res) => services.update(req, res));
router.delete('/', canManage, (req, res) => services.remove(req, res));
router.delete('/:id', canManage, (req, res) => services.remove(req, res));

module.exports = router;
