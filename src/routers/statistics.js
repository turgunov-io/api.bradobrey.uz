const express = require('express');
const statistics = require('../models/statistics');

const router = express.Router();

router.get('/barbers/:barber', (req, res) => statistics.barber(req, res));
router.get('/branches/:branch', (req, res) => statistics.branch(req, res));
router.get('/', (req, res) => statistics.all(req, res));

module.exports = router;
