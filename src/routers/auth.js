const express = require('express');
const barbers = require('../models/barbers');

const router = express.Router();

router.post('/login', (req, res) => barbers.login(req, res));

module.exports = router;
