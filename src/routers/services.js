const express = require('express');
const services = require('../models/services');
const router = express.Router();

router.get('/', (req, res) => services.list(req, res));
router.get('/:id', (req, res) => services.getById(req, res));
router.post('/', (req, res) => services.create(req, res));
router.patch('/:id', (req, res) => services.update(req, res));
router.delete('/:id', (req, res) => services.remove(req, res));

module.exports = router;
