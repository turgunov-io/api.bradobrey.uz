const express = require('express');
const certificate = require('../models/certificate');
const router = express.Router();

router.get('/active', async (req, res) => certificate.active(req, res));
router.post('/add', async (req, res) => certificate.create(req, res));
router.get('/:id', async (req, res) => certificate.getById(req, res));
router.patch('/:id', async (req, res) => certificate.update(req, res));
router.delete('/:id', async (req, res) => certificate.remove(req, res));

module.exports = router;
