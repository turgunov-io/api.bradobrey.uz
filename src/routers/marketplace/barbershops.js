const express = require('express');

const barbershops = require('../../models/marketplace/barbershops');

const router = express.Router();

// Public catalog (like Yandex.Eda restaurants list)
router.get('/', (req, res) => barbershops.list(req, res));
router.get('/:id/merchant', (req, res) => barbershops.listMerchants(req, res));
router.get('/:id', (req, res) => barbershops.getById(req, res));

// Admin/catalog management
router.post('/', (req, res) => barbershops.create(req, res));
router.post('/:id/merchant', (req, res) => barbershops.createMerchant(req, res));
router.delete('/:id/merchant', (req, res) => barbershops.deleteMerchant(req, res));
router.patch('/:id', (req, res) => barbershops.update(req, res));
router.post('/:id/activate', (req, res) => barbershops.activate(req, res));
router.post('/:id/deactivate', (req, res) => barbershops.deactivate(req, res));
router.delete('/:id', (req, res) => barbershops.remove(req, res));

module.exports = router;

