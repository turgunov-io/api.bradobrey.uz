const express = require('express');
const certificate = require('../models/certificate');
const router = express.Router();

router.get('/active', async (req, res) => certificate.active(req, res));
router.post('/add', async (req, res) => certificate.create(req, res));

module.exports = router;
