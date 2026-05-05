const express = require('express');

const marketplaceClients = require('../../models/marketplace/clients');

const router = express.Router();

// Admin-only
router.get('/', (req, res) => marketplaceClients.list(req, res));
router.get('/:id', (req, res) => marketplaceClients.getById(req, res));
router.post('/:id/activate', (req, res) => marketplaceClients.activate(req, res));
router.post('/:id/deactivate', (req, res) => marketplaceClients.deactivate(req, res));

module.exports = router;

