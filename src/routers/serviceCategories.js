const express = require('express');
const serviceCategories = require('../models/serviceCategories');

const { staffAccess } = require('../middleware/staffAccess');

const router = express.Router();

// Reads: any signed-in account. Writes: services.manage.
const canManage = staffAccess.requireStaff({ anyOf: ['services.manage'] });

router.get('/', staffAccess.authenticated(), (req, res) => serviceCategories.list(req, res));
router.post('/', canManage, (req, res) => serviceCategories.create(req, res));
router.patch('/:id', canManage, (req, res) => serviceCategories.update(req, res));
router.delete('/:id', canManage, (req, res) => serviceCategories.remove(req, res));

module.exports = router;

