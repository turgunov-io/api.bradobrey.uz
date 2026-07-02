const express = require('express');
const finance = require('../models/finance');

const router = express.Router();

router.get('/overview', (req, res) => finance.overview(req, res));
router.get('/', (req, res) => finance.get(req, res));
router.post('/', (req, res) => finance.upsert(req, res));

module.exports = router;
