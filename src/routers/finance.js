const express = require('express');
const finance = require('../models/finance');

const router = express.Router();

router.get('/', (req, res) => finance.get(req, res));
router.post('/', (req, res) => finance.upsert(req, res));

module.exports = router;

