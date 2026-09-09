const express = require('express');
const penalties = require('../models/penalties');

const router = express.Router();

router.get('/', (req, res) => penalties.list(req, res));
router.post('/', (req, res) => penalties.create(req, res));

module.exports = router;
