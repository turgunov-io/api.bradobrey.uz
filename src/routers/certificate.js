const express = require('express');
const certificate = require('../models/certificate');
const router = express.Router();

router.post('/add', async (req, res) => certificate.create(req, res));

module.exports = router;