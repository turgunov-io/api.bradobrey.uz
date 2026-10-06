const express = require('express');
const barbers = require('../models/barbers');
const telegramAuth = require('./telegramAuth');

const router = express.Router();

router.post('/login', (req, res) => barbers.login(req, res));
router.use('/telegram', telegramAuth);

module.exports = router;
