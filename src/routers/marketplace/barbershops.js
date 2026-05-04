const express = require('express');

const barbershops = require('../../models/marketplace/barbershops');

const router = express.Router();

// Public catalog (like Yandex.Eda restaurants list)
router.get('/', (req, res) => barbershops.list(req, res));
router.get('/:id', (req, res) => barbershops.getById(req, res));

// Admin/catalog management
router.post('/', (req, res) => barbershops.create(req, res));
router.patch('/:id', (req, res) => barbershops.update(req, res));
router.post('/:id/activate', (req, res) => barbershops.activate(req, res));
router.post('/:id/deactivate', (req, res) => barbershops.deactivate(req, res));

module.exports = router;

