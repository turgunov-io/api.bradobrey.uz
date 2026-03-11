const express = require('express');
const promo = require('../models/promocode');

const router = express.Router();

router.post('/validate', (req, res) => promo.validate(req, res));
router.post('/use', (req, res) => promo.use(req, res));

router.get('/dashboard', (req, res) => promo.list(req, res));
router.get('/dashboard/:id', (req, res) => promo.stats(req, res));
router.post('/dashboard/create', (req, res) => promo.create(req, res));

module.exports = router;
